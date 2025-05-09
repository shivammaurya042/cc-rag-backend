
import axios from 'axios';
import FormData from 'form-data';
import { marked } from 'marked';
import { OpenAI } from 'openai';
import { QdrantClient } from "@qdrant/js-client-rest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs'; // Keep fs for existsSync
import fsp from 'fs/promises'; // Use fs.promises for readFile
import path from 'path';
import { config } from './src/config.js';

// --- Load Environment Variables ---
dotenv.config();

// --- Configuration (from config.js or directly) ---
const LLAMA_CLOUD_API_KEY = process.env.LLAMA_CLOUD_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION_NAME = config.qdrantCollectionName;
const EMBEDDING_MODEL_NAME = config.embeddingModelName; // Ensure this is in config.js
const METADATA_EXTRACTION_MODEL_NAME = config.agentModelName; // Use agent model or specific one

const LLAMA_PARSE_BASE_URL = 'https://api.cloud.llamaindex.ai/api/parsing';
const POLLING_INTERVAL_MS = 5000;
const MAX_POLLING_ATTEMPTS = 12 * 6;
const NUM_CHUNKS_FOR_METADATA_CONTEXT = 5;

// Basic validation
if (!LLAMA_CLOUD_API_KEY || !OPENAI_API_KEY || !GOOGLE_API_KEY || !QDRANT_URL || !EMBEDDING_MODEL_NAME || !METADATA_EXTRACTION_MODEL_NAME) {
    console.error("Error: Missing essential environment variables or config values (API Keys, URLs, Model Names).");
    process.exit(1);
}

// --- Initialize Clients ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
});
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const metadataModel = genAI.getGenerativeModel({ model: METADATA_EXTRACTION_MODEL_NAME });

// --- Helper Functions ---

// LlamaParse Functions (startLlamaParseJob, pollJobStatus, getMarkdownResult)
// Keep these exactly as they were in the previous complete code version.
async function startLlamaParseJob(filePath) {
    console.log(`[LlamaParse] Starting job for: ${filePath}`);
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        contentType: 'application/pdf',
    });
    form.append('parse_mode', 'parse_page_with_llm');
    try {
        // Optionally add parser options if needed by LlamaParse API
        // form.append('parsingInstruction', 'Your instruction here');
        const response = await axios.post(`${LLAMA_PARSE_BASE_URL}/upload`, form, {
            headers: { ...form.getHeaders(), 'accept': 'application/json', 'Authorization': `Bearer ${LLAMA_CLOUD_API_KEY}` },
            timeout: 30000,
        });
        console.log('[LlamaParse] Job started successfully. Job ID:', response.data.id);
        return response.data.id;
    } catch (error) {
        console.error('[LlamaParse] Error starting job:', error.response?.data || error.message);
        throw new Error(`LlamaParse upload failed: ${error.message}`);
    }
}
async function pollJobStatus(jobId) {
    console.log(`[LlamaParse] Polling status for job ID: ${jobId}`);
    let attempts = 0;
    while (attempts < MAX_POLLING_ATTEMPTS) {
        try {
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
            const response = await axios.get(`${LLAMA_PARSE_BASE_URL}/job/${jobId}`, {
                headers: { 'accept': 'application/json', 'Authorization': `Bearer ${LLAMA_CLOUD_API_KEY}` },
                 timeout: 10000,
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
async function getMarkdownResult(jobId) {
    console.log(`[LlamaParse] Fetching Markdown result for job ID: ${jobId}`);
    try {
        const response = await axios.get(`${LLAMA_PARSE_BASE_URL}/job/${jobId}/result/markdown`, {
            headers: { 'accept': 'application/json', 'Authorization': `Bearer ${LLAMA_CLOUD_API_KEY}` },
            timeout: 60000,
        });
        if (response.data && typeof response.data.markdown === 'string') {
             console.log('[LlamaParse] Successfully fetched Markdown result (from JSON).');
             return response.data.markdown;
        } else if (typeof response.data === 'string' && response.data.length > 0) {
              console.log('[LlamaParse] Successfully fetched raw Markdown result.');
              return response.data;
        } else { throw new Error('Unexpected response format for Markdown result.'); }
    } catch (error) {
        console.error(`[LlamaParse] Error fetching Markdown result for job ${jobId}:`, error.response?.data || error.message);
        throw new Error(`LlamaParse result fetch failed: ${error.message}`);
    }
}

function chunkMarkdownByHierarchy(markdownContent) {
    console.log('[Chunking] Starting Markdown chunking by HIERARCHY...');

    // Clean up problematic markdown first
    const cleanedMarkdown = markdownContent
        .replace(/!\[.*?\]\(.*?\)/g, '') // Remove image tags
        .replace(/\[(.*?)\]\(.*?\)/g, '$1'); // Keep link text only

    const lexer = new marked.Lexer();
    const tokens = lexer.lex(cleanedMarkdown);

    const chunks = [];
    let currentMainHeader = ''; // Tracks the highest level heading (e.g., H1)
    let currentSubHeader = ''; // Tracks the heading for the current chunk (e.g., H2, H3)
    let currentHeaderLevel = 0; // Track the level of the currentSubHeader
    let currentSectionContent = []; // Store text pieces for the current chunk

    function finalizeChunk() {
        if (currentSectionContent.length > 0) {
            const combinedRawText = currentSectionContent.join('\n\n').trim();
            if (combinedRawText) {
                // Determine the correct main/sub header based on level
                let mainH = currentMainHeader;
                let subH = currentSubHeader;
                 if (currentHeaderLevel <= 1 && mainH === subH) { // If chunk is directly under H1 or before any H1
                    mainH = subH; // The main section *is* this H1
                    subH = 'Content'; // Use a generic sub-header name
                 } else if (currentHeaderLevel <= 1) {
                    mainH = currentSubHeader; // Handle case where H1 follows H2/H3 without resetting main
                    subH = 'Content';
                 }

                // Prepend hierarchical context for embedding
                const chunkTextWithContext = `Main Section: ${mainH}\nSub Section: ${subH}\n${combinedRawText}`;

                chunks.push({
                    text: chunkTextWithContext, // For embedding
                    rawText: combinedRawText, // For payload text field
                    type: 'section_content',
                    mainSectionHeader: mainH, // Metadata
                    subSectionHeader: subH   // Metadata
                });
            }
            currentSectionContent = []; // Reset for next chunk
        }
    }

    tokens.forEach(token => {
        switch (token.type) {
            case 'heading':
                // Finalize the previous chunk before starting a new one
                finalizeChunk();

                // Update headers based on level
                const newHeaderLevel = token.depth;
                const newHeaderText = token.text?.trim() || `Unnamed Section (H${newHeaderLevel})`;

                if (newHeaderLevel === 1) {
                    currentMainHeader = newHeaderText;
                    currentSubHeader = newHeaderText; // An H1 defines both main and current sub
                } else {
                    // If moving to H2/H3 from H1 or same/lower level, Main stays the same
                    // If moving to H2/H3 from a deeper level (H4->H2), Main might need reset (edge case, assuming simple structure for now)
                    currentSubHeader = newHeaderText; // H2/H3/etc. define the current sub-section
                     // Ensure main header reflects the parent H1 if we were previously deeper
                     if (newHeaderLevel > 1 && currentHeaderLevel <=1 && currentMainHeader !== currentSubHeader && currentSubHeader !== 'Introduction') {
                         // If previous was H1, Main is correct. If not, it's complex. Stick with last H1 for now.
                     } else if (newHeaderLevel <= currentHeaderLevel && newHeaderLevel > 1) {
                        // If moving H3->H2, main should still be the parent H1. (Handled by not changing main here)
                     }
                }
                 currentHeaderLevel = newHeaderLevel;

                break; // Don't add heading text directly to content

            // Handle content tokens (paragraph, list, table, etc.)
            // Add their processed text to currentSectionContent
            // (Use the improved text extraction logic from previous example)
            case 'paragraph':
                const extractParaText = (tokens) => tokens?.map(t => t.text || (t.tokens ? extractParaText(t.tokens) : '')).join('') || '';
                 let paraText = token.tokens ? extractParaText(token.tokens).trim() : (token.text?.trim() || '');
                 if (!paraText && token.text) paraText = token.text.trim();
                 if (paraText) currentSectionContent.push(paraText);
                break;
            case 'list':
                 let listText = '';
                 token.items?.forEach((item, index) => {
                     const extractItemText = (tokens) => tokens?.map(t => t.text || (t.tokens ? extractItemText(t.tokens) : '')).join(' ') || '';
                     const itemText = extractItemText(item.tokens).trim();
                     if (itemText) {
                         listText += `${token.ordered ? (token.start == null ? index + 1 : token.start + index) + '.' : '-'} ${itemText}\n`;
                     }
                 });
                 if (listText.trim()) currentSectionContent.push(listText.trim());
                break;
            case 'table':
                 let tableHeaderText = token.header?.map(h => h.text).join(' | ');
                 let tableBodyText = token.rows?.map(row => `Row: ${row?.map(cell => cell.text).join(' | ')}`).join('\n');
                 const tableFullText = `Table Header: ${tableHeaderText}\n${tableBodyText}`.trim();
                 if (tableFullText !== "Table Header:") currentSectionContent.push(tableFullText);
                break;
            case 'code':
                 if (token.text && token.text.trim()) currentSectionContent.push(`\`\`\`${token.lang || ''}\n${token.text.trim()}\n\`\`\``);
                 break;
            case 'html':
                 if (token.text && token.text.trim()) currentSectionContent.push(token.text.trim());
                 break;
            case 'text': // Catch loose text tokens
                 if (token.text && token.text.trim()) currentSectionContent.push(token.text.trim());
                 break;

            // Ignore space, hr
            case 'space':
            case 'hr':
                break;

            default:
                 // Catch any other raw text
                 if (token.raw && token.raw.trim() && !['heading', 'list', 'table', 'code', 'paragraph', 'text', 'html', 'space', 'hr'].includes(token.type)) {
                     currentSectionContent.push(token.raw.trim());
                 }
                 break;
        }
    });

    // Finalize the very last chunk after the loop
    finalizeChunk();

    console.log(`[Chunking] Created ${chunks.length} hierarchical chunks.`);

     // --- OPTIONAL: Split large chunks ---
    // Add logic here if chunks based on H2/H3 can still be too large.
    // Split combinedRawText intelligently, create multiple chunks with the SAME headers.

    return chunks;
}

// Metadata Extraction Function (Keep the version with defaults)
async function extractMetadataWithLLM(initialText) {
    console.log('[LLM Metadata] Attempting extraction...');
     if (!initialText || initialText.trim().length === 0) {
         console.warn('[LLM Metadata] Input text for metadata extraction is empty.');
         return { issuer: "Unknown Issuer", card_name: "Unknown Card", document_version: null }; // Return defaults if no text
     }

    const prompt = `
You are an expert assistant analyzing credit card documents (T&Cs, feature pages, etc.).
Analyze the following text, which represents the beginning of a document:
---
${initialText.substring(0, 4000)}
---
Extract the following information and provide it ONLY in JSON format with NO additional text, comments or markdown formatting:
1.  \`issuer\`: The name of the bank or financial institution issuing the card (e.g., "Chase", "American Express", "Axis Bank"). Default to "Unknown Issuer" if not found.
2.  \`card_name\`: The complete name of the credit card product along with issuer name (just dont mention 'bank') (e.g., "Chase Sapphire Preferred", "American Express Platinum Card", "Axis Atlas Credit Card"). Default to "Unknown Card" if not found.
3.  \`document_version\`: The effective date, revision date, or version identifier for these terms (e.g., "2024-07-26", "Q3 2024", "Effective April 2024", "Rev. 5/24"). Use \`null\` if not applicable or found.

JSON Output:`;

    try {
        const result = await metadataModel.generateContent(prompt);
        const response = result.response;
        const jsonResponseText = response.text()?.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');

        if (!jsonResponseText) {
             console.error('[LLM Metadata] Extraction failed: LLM returned empty response.');
             return { issuer: "Unknown Issuer", card_name: "Unknown Card", document_version: null };
        }
        console.log('[LLM Metadata] Raw Response:', jsonResponseText);
        const extractedData = JSON.parse(jsonResponseText);

        // const issuer = (extractedData?.issuer && typeof extractedData.issuer === 'string' && extractedData.issuer.trim())
        //                ? extractedData.issuer.trim() : "Unknown Issuer";
        // const cardName = (extractedData?.card_name && typeof extractedData.card_name === 'string' && extractedData.card_name.trim())
        //                  ? extractedData.card_name.trim() : "Unknown Card";
        const issuer = "SBI Bank";
        const cardName = "SBI SimplyCLICK Card";
        const docVersion = (extractedData?.document_version && typeof extractedData.document_version === 'string')
                         ? extractedData.document_version.trim() : null;

        const finalMetadata = { issuer, card_name: cardName, document_version: docVersion };
        console.log('[LLM Metadata] Extraction Result:', finalMetadata);
        return finalMetadata;

    } catch (error) {
        console.error('[LLM Metadata] Error during call or parsing:', error.message);
         if (error instanceof SyntaxError) {
            console.error('[LLM Metadata] LLM likely did not return valid JSON.');
        }
        // Return defaults on error to potentially allow processing if text itself is useful
        return { issuer: "Unknown Issuer", card_name: "Unknown Card", document_version: null };
    }
}

// Embedding Function (Keep as is)
async function getEmbeddings(texts) {
    console.log(`[Embeddings] Generating for ${texts.length} chunks using ${EMBEDDING_MODEL_NAME}...`);
    if (!texts || texts.length === 0) return [];
    try {
        const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL_NAME,
            input: texts,
        });
        console.log('[Embeddings] Generation successful.');
        return response.data.map(item => item.embedding);
    } catch (error) {
        console.error('[Embeddings] Error generating OpenAI embeddings:', error.response?.data || error.message);
        throw new Error(`Embedding generation failed: ${error.message}`);
    }
}

// Qdrant Upsert Function (Keep as is)
async function upsertToQdrant(points) {
    if (!points || points.length === 0) {
        console.log('[Qdrant] No points to upsert.'); return;
    }
    console.log(`[Qdrant] Upserting ${points.length} points to collection '${QDRANT_COLLECTION_NAME}'...`);
    try {
        const result = await qdrantClient.upsert(QDRANT_COLLECTION_NAME, { wait: true, points });
        console.log('[Qdrant] Upsert result status:', result.status);
         if (result.status !== 'completed') { console.warn('[Qdrant] Upsert operation did not complete successfully:', result); }
    } catch (error) {
        const qdrantError = error.response?.data?.status?.error || error.message;
        console.error('[Qdrant] Error upserting points:', qdrantError);
        throw new Error(`Qdrant upsert failed: ${qdrantError}`);
    }
}

// --- MODIFIED Main Processing Function ---

/**
 * Processes a single document (PDF, MD, TXT): Gets content -> Extracts Metadata -> Chunks -> Embeds -> Stores.
 * @param {string} filePath - Path to the input document file.
 * @returns {Promise<boolean>} - True if processing was successful, false otherwise.
 */
async function processDocument(filePath) {
    console.log(`\n--- Starting processing for: ${filePath} ---`);
    const documentId = path.basename(filePath);
    const fileExtension = path.extname(filePath).toLowerCase();

    let markdownResult = null;

    try {
        // === Step 1: Get Markdown Content ===
        if (fileExtension === '.pdf') {
            console.log(`[Content] Processing PDF via LlamaParse...`);
            const jobId = await startLlamaParseJob(filePath);
            const finalStatus = await pollJobStatus(jobId);
            if (finalStatus !== 'SUCCESS') {
                throw new Error(`LlamaParse job ${jobId} did not complete successfully.`);
            }
            markdownResult = await getMarkdownResult(jobId);
        } else if (['.md', '.txt'].includes(fileExtension)) {
            console.log(`[Content] Reading ${fileExtension} file directly...`);
            markdownResult = await fsp.readFile(filePath, 'utf-8'); // Use fs.promises
        } else {
            console.warn(`[Warning] Unsupported file type: ${fileExtension}. Skipping file.`);
            return false; // Skip unsupported file types
        }

        if (typeof markdownResult !== 'string' || markdownResult.trim().length === 0) {
            throw new Error('Failed to obtain valid content from the file.');
        }
        console.log(`[Content] Obtained content (length: ${markdownResult.length}).`);

        // === Step 2: Chunk the Content ===
        const allParsedChunks = chunkMarkdownByHierarchy(markdownResult);
        if (!allParsedChunks || allParsedChunks.length === 0) {
            // Allow proceeding even if chunking fails, metadata might still be useful? Or throw?
            // Let's throw for now, as no chunks means nothing to embed/store.
            throw new Error('Chunking resulted in no processable chunks.');
        }

        // === Step 3: Extract Metadata ===
        // Use first few chunks' CONTEXT-RICH text for metadata extraction
        const initialTextForContext = allParsedChunks
            .slice(0, NUM_CHUNKS_FOR_METADATA_CONTEXT)
            .map(chunk => chunk.text)
            .join('\n\n'); // Join text of first few chunks

        const sourceMetadata = await extractMetadataWithLLM(initialTextForContext);
        // Handle case where LLM fails but we might still want to ingest with defaults
        if (!sourceMetadata) {
             console.warn(`[Metadata] Could not extract metadata for ${documentId}, using defaults.`);
             // This case should ideally be handled inside extractMetadataWithLLM now
             // If it returns null here, it's likely a major error.
             throw new Error(`Critical failure extracting metadata for ${documentId}`);
        }
         // Check if essential info is missing even with defaults
         if (sourceMetadata.issuer === "Unknown Issuer" && sourceMetadata.card_name === "Unknown Card") {
              console.warn(`[Metadata] Essential metadata (issuer, card_name) could not be determined for ${documentId}. Skipping storage.`);
              return false; // Don't store if essential info is missing
         }
        console.log(`[Metadata] Using metadata for ${documentId}:`, sourceMetadata);

        // === Step 4 & 5: Prepare Chunks, Embed ===
        const pointsToUpsert = [];
        const textsToEmbed = []; // Contains text WITH prepended headers
        const chunkMetadataList = []; // Will contain main/sub headers

        for (const chunk of allParsedChunks) {
            // Use chunk.text (with prepended context) for embedding
            if (!chunk.text || chunk.text.trim().length === 0) continue;
    
            const chunkId = uuidv4();
            const metadata = {
                // Extracted & Normalized Metadata
                issuer: sourceMetadata.issuer.toLowerCase().trim(),
                card_name: sourceMetadata.card_name.toLowerCase().trim(),
                document_version: sourceMetadata.document_version ? sourceMetadata.document_version.trim() : null,
    
                // ---> Hierarchical Metadata <---
                main_section_header: (chunk.mainSectionHeader || 'Introduction').toLowerCase().trim(),
                sub_section_header: (chunk.subSectionHeader || 'Content').toLowerCase().trim(),
                // ---> End Hierarchical Metadata <---
    
                // Contextual Metadata
                document_id: documentId,
                text: chunk.text || chunk.rawText, // Store raw text in payload
                chunk_id: chunkId,
                chunk_type: chunk.type, // 'section_content' in this strategy
                // Remove the old single 'section_header' if desired, or keep it as the sub_section_header
                // section_header: (chunk.subSectionHeader || 'Content').toLowerCase().trim(), // Example if keeping old field name
            };
    
            textsToEmbed.push(chunk.text); // Embed text WITH hierarchical context
            chunkMetadataList.push(metadata);
        }

        // 5. Generate Embeddings (for context-rich texts)
    const embeddings = await getEmbeddings(textsToEmbed);

        // === Step 6: Combine Embeddings with Metadata/Payload ===
        if (embeddings.length !== allParsedChunks.length) {
            console.error(`[Error] Mismatch count: Embeddings (${embeddings.length}) vs Chunks (${allParsedChunks.length}).`);
            throw new Error('Internal error: Embedding count mismatch.');
        }

        for (let i = 0; i < embeddings.length; i++) {
            pointsToUpsert.push({
                id: chunkMetadataList[i].chunk_id,
                vector: embeddings[i],
                payload: chunkMetadataList[i], // Payload contains raw text and main/sub headers
            });
        }

        // === Step 7: Store in Qdrant ===
        await upsertToQdrant(pointsToUpsert);

        console.log(`--- Successfully processed and stored document: ${filePath} ---`);
        return true;

    } catch (error) {
        console.error(`\n--- Processing failed for document: ${filePath} ---`);
        console.error('Error:', error.message);
        // console.error(error.stack); // Uncomment for detailed stack trace
        return false;
    }
}

// --- Main Execution ---
async function main() {
    console.log("Starting ingestion process...");

    // --- Configure your document file paths here ---
    // const filesToProcess = [
    //     // './data/axis-bank-atlas-t&c-cc.pdf',
    //     './data/atlas-privileges.md' // Your Markdown/Text file
    //     // Add more file paths (.pdf, .md, .txt)
    // ];

    // Get all files from the data folder
    const dataFolderPath = './data';
    const filesToProcess = fs.readdirSync(dataFolderPath)
        .filter(file => ['.pdf', '.md', '.txt'].includes(path.extname(file).toLowerCase()))
        .map(file => path.join(dataFolderPath, file));

    console.log(`Found ${filesToProcess.length} files to process in the data folder.`);
    

    let successCount = 0;
    let failureCount = 0;

    // Check Qdrant Collection
    try {
        await qdrantClient.getCollection(QDRANT_COLLECTION_NAME);
        console.log(`[Qdrant] Collection '${QDRANT_COLLECTION_NAME}' confirmed.`);
    } catch (e) {
         if (e.message?.includes('Not found') || e.status === 404) {
            console.error(`[Qdrant] Error: Collection '${QDRANT_COLLECTION_NAME}' does not exist.`);
            // Optionally provide instructions to create it.
            process.exit(1);
         } else {
            console.warn(`[Qdrant] Warning checking collection '${QDRANT_COLLECTION_NAME}': ${e.message}.`);
         }
    }

    // Process each file
    for (const filePath of filesToProcess) {
        if (!fs.existsSync(filePath)) {
            console.error(`\n--- Skipping: File not found at ${filePath} ---`);
            failureCount++;
            continue;
        }
        const success = await processDocument(filePath);
        if (success) successCount++; else failureCount++;
    }

    // Summary
    console.log("\n--- Ingestion Process Summary ---");
    console.log(`Successfully processed: ${successCount} document(s)`);
    console.log(`Failed / Skipped:     ${failureCount} document(s)`);
    console.log("---------------------------------");
}

// --- Run ---
main().catch(err => {
    console.error("\n--- Unhandled Main Execution Error ---");
    console.error(err);
    process.exit(1);
});