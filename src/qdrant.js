import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from './config.js';

let qdrantClient;

/**
 * Returns a singleton instance of the Qdrant client.
 * @returns {QdrantClient}
 */
export const getQdrantClient = () => {
    if (!qdrantClient) {
        qdrantClient = new QdrantClient({
            url: config.qdrantUrl,
            apiKey: config.qdrantApiKey,
        });
    }
    return qdrantClient;
};

/**
 * Ensures the Qdrant collection exists, creating it if it doesn't.
 * @param {object} options - The options for creating the collection.
 * @param {string} options.collectionName - The name of the collection.
 * @param {number} options.vectorSize - The size of the vectors.
 * @param {string} options.distance - The distance metric to use.
 */
export const ensureCollection = async ({ collectionName, vectorSize, distance }) => {
    const client = getQdrantClient();
    try {
        await client.getCollection(collectionName);
        console.log(`[Qdrant] Collection '${collectionName}' already exists.`);
    } catch (e) {
        if (e.status === 404) {
            console.log(`[Qdrant] Collection '${collectionName}' not found. Creating...`);
            await client.createCollection(collectionName, {
                vectors: {
                    size: vectorSize,
                    distance: distance,
                },
            });
            console.log(`[Qdrant] Collection '${collectionName}' created successfully.`);
        } else {
            throw e;
        }
    }
};
