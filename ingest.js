import axios from 'axios';
import FormData from 'form-data';
import { marked } from 'marked';
import { OpenAI } from 'openai';
import { QdrantClient } from "@qdrant/js-client-rest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs'; // For reading the PDF file
import path from 'path'; // For handling file paths
import { config } from './src/config.js';

// --- Load Environment Variables ---
dotenv.config();

// --- Configuration ---
const LLAMA_CLOUD_API_KEY = process.env.LLAMA_CLOUD_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY; // May be undefined if not needed

const QDRANT_COLLECTION_NAME = config.qdrantCollectionName; // Your chosen collection name
const METADATA_EXTRACTION_MODEL = 'gemini-2.0-flash'; // LLM for extraction

const LLAMA_PARSE_BASE_URL = 'https://api.cloud.llamaindex.ai/api/parsing';
const POLLING_INTERVAL_MS = 5000; // Check LlamaParse status every 5 seconds
const MAX_POLLING_ATTEMPTS = 12 * 6; // Max ~6 minutes polling for LlamaParse

const NUM_CHUNKS_FOR_METADATA_CONTEXT = 5; // How many initial chunks to feed the LLM for metadata extraction

// Basic validation for essential keys
if (!LLAMA_CLOUD_API_KEY || !OPENAI_API_KEY || !GOOGLE_API_KEY || !QDRANT_URL) {
    console.error("Error: Missing essential environment variables (LLAMA_CLOUD_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, QDRANT_URL).");
    process.exit(1);
}


// --- Initialize Clients ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
});
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: METADATA_EXTRACTION_MODEL });

// --- Helper Functions ---

/**
 * Uploads a PDF file to LlamaParse and starts the parsing job.
 * @param {string} filePath - Path to the PDF file.
 * @returns {Promise<string>} - The job ID.
 */
async function startLlamaParseJob(filePath) {
    console.log(`[LlamaParse] Starting job for: ${filePath}`);
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        contentType: 'application/pdf',
    });

    try {
        form.append('parse_mode', 'parse_page_with_llm');
        const response = await axios.post(`${LLAMA_PARSE_BASE_URL}/upload`, form, {
            headers: {
                ...form.getHeaders(),
                'accept': 'application/json',
                'Authorization': `Bearer ${LLAMA_CLOUD_API_KEY}`,
            },
            // Add timeout to prevent hanging indefinitely
            timeout: 30000, // 30 seconds timeout for upload request
        });
        console.log('[LlamaParse] Job started successfully. Job ID:', response.data.id);
        return response.data.id;
    } catch (error) {
        console.error('[LlamaParse] Error starting job:', error.response?.data || error.message);
        throw new Error(`LlamaParse upload failed: ${error.message}`);
    }
}

/**
 * Polls the LlamaParse API for job status.
 * @param {string} jobId - The job ID to check.
 * @returns {Promise<string>} - The final status ('SUCCESS' or 'FAILURE').
 */
async function pollJobStatus(jobId) {
    console.log(`[LlamaParse] Polling status for job ID: ${jobId}`);
    let attempts = 0;
    while (attempts < MAX_POLLING_ATTEMPTS) {
        try {
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS)); // Wait first
            const response = await axios.get(`${LLAMA_PARSE_BASE_URL}/job/${jobId}`, {
                headers: {
                    'accept': 'application/json',
                    'Authorization': `Bearer ${LLAMA_CLOUD_API_KEY}`,
                },
                 timeout: 10000, // 10 seconds timeout for status check
            });
            const status = response.data.status;
            console.log(`[LlamaParse] Job ${jobId} status: ${status} (Attempt ${attempts + 1}/${MAX_POLLING_ATTEMPTS})`);

            if (status === 'SUCCESS') {
                return 'SUCCESS';
            } else if (status === 'FAILURE') {
                console.error(`[LlamaParse] Job ${jobId} failed.`);
                return 'FAILURE';
            }
            // If status is PENDING or other, continue polling
            attempts++;

        } catch (error) {
            console.error(`[LlamaParse] Error polling job status for ${jobId}:`, error.response?.data || error.message);
            // Decide if retry makes sense on error, maybe implement backoff
            // For now, simple retry after interval
            attempts++;
        }
    }
    console.error(`[LlamaParse] Max polling attempts reached for job ${jobId}. Assuming failure.`);
    return 'FAILURE'; // Timeout
}

/**
 * Retrieves the parsing result in Markdown format.
 * @param {string} jobId - The job ID.
 * @returns {Promise<string>} - The Markdown result.
 */
async function getMarkdownResult(jobId) {
    console.log(`[LlamaParse] Fetching Markdown result for job ID: ${jobId}`);
    try {
        const response = await axios.get(`${LLAMA_PARSE_BASE_URL}/job/${jobId}/result/markdown`, {
            headers: {
                'accept': 'application/json', // API might wrap markdown in JSON
                'Authorization': `Bearer ${LLAMA_CLOUD_API_KEY}`,
            },
            timeout: 60000, // Allow more time for potentially large results
        });

        // Check response structure: API might return { markdown: "..." } or raw text
        if (response.data && typeof response.data.markdown === 'string') {
             console.log('[LlamaParse] Successfully fetched Markdown result (from JSON).');
             return response.data.markdown;
        } else if (typeof response.data === 'string' && response.data.length > 0) {
              console.log('[LlamaParse] Successfully fetched raw Markdown result.');
              return response.data;
        } else {
            console.error('[LlamaParse] Unexpected response format for Markdown result:', response.data);
            throw new Error('Unexpected response format for Markdown result.');
        }

    } catch (error) {
        console.error(`[LlamaParse] Error fetching Markdown result for job ${jobId}:`, error.response?.data || error.message);
        throw new Error(`LlamaParse result fetch failed: ${error.message}`);
    }
}

/**
 * Chunks Markdown text based on structure (paragraphs, lists, tables).
 * @param {string} markdownContent - The Markdown string.
 * @returns {Array<{text: string, type: string, sectionHeader?: string}>} - Array of chunks.
 */
function chunkMarkdown(markdownContent) {
    console.log('[Chunking] Starting Markdown chunking with context prepending...');
    const tokens = marked.lexer(markdownContent);
    const chunks = [];
    let currentSectionHeader = 'Unknown Section'; // Track current heading

    tokens.forEach(token => {
        let rawChunkText = ''; // The original text without the header
        let chunkType = 'unknown';

        switch (token.type) {
            case 'heading':
                currentSectionHeader = token.text?.trim() || 'Unnamed Section';
                // Don't create a chunk for the heading itself
                break;
            case 'paragraph':
                rawChunkText = token.text?.trim();
                chunkType = 'paragraph';
                break;
            case 'list':
                 token.items?.forEach(item => {
                    const extractText = (tokens) => tokens?.map(t => t.text || (t.tokens ? extractText(t.tokens) : '')).join(' ') || '';
                    const itemText = extractText(item.tokens).trim();
                     if (itemText) {
                        // Prepend header to this list item
                        const chunkTextWithHeader = `Section: ${currentSectionHeader}\n${itemText}`;
                        chunks.push({
                            text: chunkTextWithHeader, // Text to be embedded
                            rawText: itemText,         // Original text (optional, might store in payload)
                            type: 'list_item',
                            sectionHeader: currentSectionHeader
                        });
                     }
                });
                break; // Skip adding the parent 'list' token
            case 'table':
                 let tableHeaderText = token.header?.map(h => h.text).join(' | ');
                 let tableBodyText = token.rows?.map(row => `Row: ${row?.map(cell => cell.text).join(' | ')}`).join('\n');
                 rawChunkText = `Table Header: ${tableHeaderText}\n${tableBodyText}`.trim();
                 chunkType = 'table';
                break;
            // ... (handle other cases like 'space', 'hr', 'text' as before, maybe prepend header too if they have text) ...
             case 'text':
             case 'code': // Example: also prepend context to code blocks if desired
             case 'html': // Example: also prepend context to raw html blocks
                 if (token.raw && token.raw.trim()) {
                    rawChunkText = token.raw.trim();
                    chunkType = token.type;
                 }
                 break;

        }

        // Add the chunk if text was extracted (excluding lists handled above)
        // Prepend the header here for types processed above
        if (rawChunkText && chunkType !== 'unknown' && token.type !== 'list') {
             const chunkTextWithHeader = `Section: ${currentSectionHeader}\n${rawChunkText}`;
             chunks.push({
                 text: chunkTextWithHeader, // Text to be embedded
                 rawText: rawChunkText,       // Original text (optional)
                 type: chunkType,
                 sectionHeader: currentSectionHeader
             });
        }
    });
    console.log(`[Chunking] Created ${chunks.length} chunks with prepended context.`);
    return chunks;
}


/**
 * Uses an LLM to extract metadata from the initial text of a document.
 * @param {string} initialText - Concatenated text from the first few chunks.
 * @returns {Promise<object|null>} - Extracted metadata { issuer, card_name, document_version } or null on failure.
 */
async function extractMetadataWithLLM(initialText) {
    console.log('[LLM Metadata] Attempting extraction...');
    if (!initialText || initialText.trim().length === 0) {
         console.warn('[LLM Metadata] Input text is empty. Skipping extraction.');
         return null;
    }

    const prompt = `
You are an expert assistant analyzing credit card Terms & Conditions documents.
Analyze the following text, which represents the beginning of a document:
---
${initialText.substring(0, 4000)}
---
Extract the following information and provide it ONLY in JSON format with NO additional text, comments or markdown formatting:
1.  \`issuer\`: The name of the bank or financial institution issuing the card (e.g., "Chase", "American Express", "Axis Bank").
2.  \`card_name\`: The specific name of the credit card product (e.g., "Sapphire Preferred", "Platinum Card", "Atlas Credit Card").
3.  \`document_version\`: The effective date, revision date, or version identifier for these terms (e.g., "2024-07-26", "Q3 2024", "Effective April 2024", "Rev. 5/24"). Prioritize dates labeled as 'effective' or 'revised'.

If any piece of information cannot be reliably determined from the provided text, use \`null\` as the value for that key in the JSON output.

JSON Output:`; // Removed the trailing newline as models sometimes add ```json

    try {
        const result = await model.generateContent(prompt);
        const response = result.response;
        const jsonResponseText = response.text()
            .trim() // Trim whitespace
            .replace(/^```json\s*/, '') // Remove leading ```json markdown
            .replace(/\s*```$/, ''); // Remove trailing ``` markdown

        console.log('[LLM Metadata] Raw Response:', jsonResponseText);

        const extractedData = JSON.parse(jsonResponseText);

        // Basic validation
        if (typeof extractedData === 'object' && extractedData !== null &&
            extractedData.hasOwnProperty('issuer') &&
            extractedData.hasOwnProperty('card_name') &&
            extractedData.hasOwnProperty('document_version'))
        {
            // Crucial check: Ensure essential fields are not null or empty strings
            if (extractedData.issuer && typeof extractedData.issuer === 'string' && extractedData.issuer.trim() &&
                extractedData.card_name && typeof extractedData.card_name === 'string' && extractedData.card_name.trim())
            {
                 console.log('[LLM Metadata] Extraction Successful:', extractedData);
                 // Return validated and potentially nullified version
                 return {
                    issuer: extractedData.issuer.trim(),
                    card_name: extractedData.card_name.trim(),
                    document_version: (extractedData.document_version && typeof extractedData.document_version === 'string') ? extractedData.document_version.trim() : null
                 };
            } else {
                console.error('[LLM Metadata] Extraction failed: Missing or empty essential issuer or card_name.');
                return null;
            }
        } else {
             console.error('[LLM Metadata] Extraction failed: Invalid JSON structure received.');
            return null;
        }

    } catch (error) {
        console.error('[LLM Metadata] Error during call or parsing:', error.message);
        if (error instanceof SyntaxError) { // More specific check for JSON parse errors
            console.error('[LLM Metadata] LLM likely did not return valid JSON.');
        }
        return null;
    }
}


/**
 * Generates embeddings for text chunks using OpenAI.
 * @param {Array<string>} texts - Array of text strings to embed.
 * @returns {Promise<Array<Array<number>>>} - Array of embedding vectors.
 */
async function getEmbeddings(texts) {
    console.log(`[Embeddings] Generating for ${texts.length} chunks using ${config.EMBEDDING_OPENAI_TEXT_3_SMALL}...`);
    if (!texts || texts.length === 0) {
        return [];
    }
    try {
        // OpenAI API handles batching, but large numbers might need manual chunking
        const response = await openai.embeddings.create({
            model: config.EMBEDDING_OPENAI_TEXT_3_SMALL,
            input: texts,
        });
        console.log('[Embeddings] Generation successful.');
        return response.data.map(item => item.embedding);
    } catch (error) {
        console.error('[Embeddings] Error generating OpenAI embeddings:', error.response?.data || error.message);
        throw new Error(`Embedding generation failed: ${error.message}`);
    }
}

/**
 * Upserts points (vectors + metadata) into Qdrant.
 * @param {Array<object>} points - Array of Qdrant point objects.
 */
async function upsertToQdrant(points) {
    if (!points || points.length === 0) {
        console.log('[Qdrant] No points to upsert.');
        return;
    }
    console.log(`[Qdrant] Upserting ${points.length} points to collection '${QDRANT_COLLECTION_NAME}'...`);
    try {
        // Qdrant client handles batching effectively
        const result = await qdrantClient.upsert(QDRANT_COLLECTION_NAME, {
            wait: true, // Wait for operation to complete for better certainty
            points: points,
        });
        console.log('[Qdrant] Upsert result status:', result.status);
         if (result.status !== 'completed') {
            console.warn('[Qdrant] Upsert operation did not complete successfully:', result);
         }
    } catch (error) {
        // Log specific Qdrant errors if available
        const qdrantError = error.response?.data?.status?.error || error.message;
        console.error('[Qdrant] Error upserting points:', qdrantError);
        throw new Error(`Qdrant upsert failed: ${qdrantError}`);
    }
}

// --- Main Processing Function ---

/**
 * Processes a single PDF document: Parse -> Extract Metadata (LLM) -> Chunk -> Embed -> Store.
 * @param {string} pdfFilePath - Path to the input PDF file.
 * @returns {Promise<boolean>} - True if processing was successful, false otherwise.
 */
async function processDocument(pdfFilePath) {
    console.log(`\n--- Starting processing for: ${pdfFilePath} ---`);
    const documentId = path.basename(pdfFilePath); // Use filename as a basic document ID

    try {
        // 1. Parse PDF using LlamaParse
        const jobId = await startLlamaParseJob(pdfFilePath);
        const finalStatus = await pollJobStatus(jobId);

        if (finalStatus !== 'SUCCESS') {
            throw new Error(`LlamaParse job ${jobId} did not complete successfully.`);
        }
        const markdownResult = await getMarkdownResult(jobId);

        // 2. Chunk the Full Markdown Content
        const allParsedChunks = chunkMarkdown(markdownResult);
        if (!allParsedChunks || allParsedChunks.length === 0) {
            throw new Error('Chunking resulted in no chunks.');
        }

        // 3. Extract Metadata using LLM from initial chunks
        const initialTextForContext = allParsedChunks
            .slice(0, NUM_CHUNKS_FOR_METADATA_CONTEXT)
            .map(chunk => chunk.text)
            .join('\n\n'); // Join text of first few chunks

        const sourceMetadata = await extractMetadataWithLLM(initialTextForContext);

        // VALIDATION: Check if metadata extraction was successful
        if (!sourceMetadata) {
             throw new Error(`Failed to extract required metadata (issuer, card_name) via LLM for ${documentId}. Skipping document.`);
        }
        console.log(`[Metadata] Using extracted metadata for ${documentId}:`, sourceMetadata);


        // 4. Prepare All Chunks for Embedding and Storage (using extracted metadata)
        const pointsToUpsert = [];
        const textsToEmbed = [];
        const chunkMetadataList = [];

        for (const chunk of allParsedChunks) {
            if (!chunk.text || chunk.text.trim().length === 0) continue; // Skip empty chunks

            const chunkId = uuidv4(); // Generate unique ID for each chunk
            const metadata = {
                // Extracted metadata (MUST be present due to check above)
                issuer: sourceMetadata.issuer.toLowerCase().trim(),
                card_name: sourceMetadata.card_name.toLowerCase().trim(),
                document_version: sourceMetadata.document_version, // Might be null
                // Contextual metadata
                document_id: documentId,
                page_number: chunk.page_number || null, // LlamaParse Markdown might not have page numbers easily
                text: chunk.text || chunk.rawText, // Store text if available, else fallback to rawTtext with header
                chunk_id: chunkId,
                chunk_type: chunk.type,
                section_header: chunk.sectionHeader.toLowerCase().trim() || 'Unknown Section',
            };

            textsToEmbed.push(chunk.text);
            chunkMetadataList.push(metadata);
        }

        // 5. Generate Embeddings
        const embeddings = await getEmbeddings(textsToEmbed);

        // 6. Combine Embeddings with Metadata
        if (embeddings.length !== chunkMetadataList.length) {
            // This should ideally not happen if logic is correct
            console.error(`[Error] Mismatch between embeddings (${embeddings.length}) and metadata (${chunkMetadataList.length}).`);
            throw new Error('Internal error: Mismatch between embeddings and metadata counts.');
        }

        for (let i = 0; i < embeddings.length; i++) {
            pointsToUpsert.push({
                id: chunkMetadataList[i].chunk_id,
                vector: embeddings[i],
                payload: chunkMetadataList[i], // This payload contains the raw text
            });
        }

        // 7. Store in Qdrant
        await upsertToQdrant(pointsToUpsert);

        console.log(`--- Successfully processed and stored document: ${documentId} ---`);
        return true; // Indicate success

    } catch (error) {
        console.error(`\n--- Processing failed for document: ${pdfFilePath} ---`);
        console.error('Error:', error.message);
        return false; // Indicate failure
    }
}


// --- Example Usage ---
async function main() {
    console.log("Starting ingestion process...");

    // --- !!! IMPORTANT: Configure your PDF file paths here !!! ---
    const pdfFilesToProcess = [
        './data/axis-bank-atlas-t&c-cc.pdf'
    ];

    let successCount = 0;
    let failureCount = 0;

    // Ensure Qdrant collection exists (optional basic check)
    try {
        await qdrantClient.getCollection(QDRANT_COLLECTION_NAME);
        console.log(`[Qdrant] Collection '${QDRANT_COLLECTION_NAME}' confirmed to exist.`);
    } catch (e) {
         // Check if error indicates collection not found (specific error codes depend on client/Qdrant version)
         if (e.message?.includes('Not found') || e.status === 404) {
            console.error(`[Qdrant] Error: Collection '${QDRANT_COLLECTION_NAME}' does not exist. Please create it first.`);
            console.error("You might need to create it with vector parameters: { size: 1536, distance: 'Cosine' }");
            process.exit(1);
         } else {
            console.warn(`[Qdrant] Could not verify collection '${QDRANT_COLLECTION_NAME}'. Error: ${e.message}. Proceeding anyway...`);
         }
    }


    for (const pdfPath of pdfFilesToProcess) {
        if (!fs.existsSync(pdfPath)) {
            console.error(`\n--- Skipping: PDF file not found at ${pdfPath} ---`);
            failureCount++;
            continue; // Skip to the next file
        }

        const success = await processDocument(pdfPath);
        if (success) {
            successCount++;
        } else {
            failureCount++;
        }
    }

    console.log("\n--- Ingestion Process Summary ---");
    console.log(`Successfully processed: ${successCount} document(s)`);
    console.log(`Failed to process: ${failureCount} document(s)`);
    console.log("---------------------------------");
}

// --- Run the Main Function ---
main().catch(err => {
    console.error("\n--- Unhandled Main Execution Error ---");
    console.error(err);
    process.exit(1); // Exit with error code
});