import { DynamicTool } from "@langchain/core/tools";
import { OpenAIEmbeddings } from "@langchain/openai";
import { getQdrantClient } from "../qdrant.js";
import { loadValidCards } from "../utils/loadValidCards.js";
import { config } from "../config.js";

// Initialize clients needed by the tool (outside the function for efficiency)
const embeddings = new OpenAIEmbeddings({
    apiKey: config.openaiApiKey,
    model: config.embeddingModelName,
    dimensions: 1536,
});

const qdrantClient = getQdrantClient();

export async function createSearchTool() {
    const validCards = await loadValidCards(); // Load valid cards once

    const searchCreditCardTermsTool = new DynamicTool({
        name: "search_credit_card_info",
        description: `Searches the documents for a *single, specific* credit card (from the valid list: ${JSON.stringify(validCards)}) to find information relevant to the search query. Use this tool only after confirming the exact, valid card_name. Input must be a JSON object with keys "card_name" and "search_query". Returns relevant text snippets or an error message.`,
        func: async (input) => {
            console.log("[Tool] Received input:", input);
            let cardName, searchQuery;

            // Langchain sometimes passes a stringified JSON, sometimes an object. Handle both.
            try {
                 if (typeof input === 'string') {
                    const parsedInput = JSON.parse(input);
                    cardName = parsedInput.card_name;
                    searchQuery = parsedInput.search_query;
                 } else if (typeof input === 'object' && input !== null) {
                     cardName = input.card_name;
                     searchQuery = input.search_query;
                 }

                 if (!cardName || !searchQuery) {
                    return "Error: Tool input must be a JSON object containing both 'card_name' and 'search_query' keys.";
                 }
                 cardName = cardName.toLowerCase().trim();
                 searchQuery = searchQuery.toLowerCase().trim();

            } catch (e) {
                return "Error: Invalid input format. Input must be a JSON object string or object with 'card_name' and 'search_query'.";
            }

            // Create lowercase version of valid cards for case-insensitive comparison
            const validCardsLower = validCards.map(card => card.toLowerCase());
            
            // 1. Validate Card Name
            if (!validCardsLower.includes(cardName)) {
                console.log(`[Tool] Invalid card name received: ${cardName}`);
                return `Error: Card name '${cardName}' is not valid or not supported. Please choose from: ${validCards.join(', ')}.`;
            }
            console.log(`[Tool] Searching for query "${searchQuery}" in documents for card "${cardName}"`);

            try {
                console.log("[Tool] card name is:: ", cardName, "search query is:: ", searchQuery);
                // 2. Embed Search Query
                const queryEmbedding = await embeddings.embedQuery(searchQuery);

                // 3. Construct Filter
                const searchFilter = {
                    must: [{ key: 'card_name', match: { value: cardName } }]
                    // Add other filters like document_version here if needed
                };

                // 4. Query Qdrant
                const searchResult = await qdrantClient.search(config.qdrantCollectionName, {
                    vector: queryEmbedding,
                    filter: searchFilter,
                    limit: 15, // Keep k=5 as planned
                });
                console.log("[Tool] Qdrant search result is:: ", searchResult);

                console.log(`[Tool] Qdrant returned ${searchResult.length} results.`);

                // 5. Format Results
                if (searchResult.length === 0) {
                    return `No specific information found for '${searchQuery}' in the documents for '${cardName}'.`;
                }

                const contextSnippets = searchResult.map((point, index) => {
                    // Attempt to extract text, handle missing payload gracefully
                    const text = point.payload?.text || 'No text content found in payload.';
                    const section = point.payload?.section_header || 'Unknown Section';
                    const score = point.score.toFixed(4);
                    return `Result ${index + 1} (Score: ${score}, Section: ${section}):\n${text}`;
                });

                return `Found the following information for '${searchQuery}' regarding '${cardName}':\n\n` + contextSnippets.join('\n\n---\n\n');

            } catch (error) {
                console.error(`[Tool] Error during search for ${cardName}:`, error);
                let errorMessage = "An internal error occurred while searching the documents.";
                if (error.message?.includes('embedding')) {
                    errorMessage = "Error generating search query embedding.";
                } else if (error.message?.includes('Qdrant')) { // Basic check
                     errorMessage = "Error communicating with the document knowledge base.";
                }
                return errorMessage;
            }
        },
    });

    return [searchCreditCardTermsTool]; // Return as an array for the agent
}