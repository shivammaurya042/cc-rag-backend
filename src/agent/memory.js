import { getRedisClient } from '../redisClient.js';
import { config } from '../config.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const HISTORY_PREFIX = 'chat_history:';

/**
 * Retrieves chat history from Redis.
 * @param {string} sessionId The session ID.
 * @returns {Promise<Array<HumanMessage | AIMessage>>} Array of LangChain message objects.
 */
export async function getChatHistory(sessionId) {
    const client = await getRedisClient();
    const key = `${HISTORY_PREFIX}${sessionId}`;
    try {
        const data = await client.get(key);
        if (!data) {
            return []; // No history found
        }
        // Assuming history is stored as an array of { type: 'human'/'ai', content: '...' }
        const rawHistory = JSON.parse(data);
        // Convert to LangChain message objects
        return rawHistory.map(msg =>
            msg.type === 'human' ? new HumanMessage(msg.content) : new AIMessage(msg.content)
        );
    } catch (error) {
        console.error(`Error retrieving history for session ${sessionId}:`, error);
        return []; // Return empty history on error
    }
}

/**
 * Saves chat history to Redis with TTL.
 * @param {string} sessionId The session ID.
 * @param {Array<HumanMessage | AIMessage>} messages Array of LangChain message objects.
 */
export async function saveChatHistory(sessionId, messages) {
    const client = await getRedisClient();
    const key = `${HISTORY_PREFIX}${sessionId}`;
    try {
        // Convert LangChain messages back to simple objects for storage
        const storableHistory = messages.map(msg => ({
            type: msg instanceof HumanMessage ? 'human' : 'ai',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content), // Handle potential non-string content
        }));
        await client.set(key, JSON.stringify(storableHistory), {
            EX: config.sessionTtlSeconds, // Set TTL
        });
    } catch (error) {
        console.error(`Error saving history for session ${sessionId}:`, error);
        // Decide how to handle save errors (e.g., log, alert)
    }
}