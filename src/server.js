import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { getAgentExecutor } from './agent/agent.js';
import { getChatHistory, saveChatHistory } from './agent/memory.js';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages'; // Import specific message types
import { getRedisClient } from './redisClient.js'; // Import redis client getter


const app = express();

// Middleware
app.use(cors()); // Allow requests from frontend (configure origin in production)
app.use(express.json()); // Parse JSON request bodies

// Simple health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Main chat endpoint
app.post('/chat', async (req, res) => {
    const { message, sessionId } = req.body;

    // Basic validation
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }

    console.log(`\n--- Received request for session: ${sessionId} ---`);
    console.log(`User message: ${message}`);

    try {
        // Retrieve history (as LangChain message objects)
        const chatHistory = await getChatHistory(sessionId);
        console.log(`Retrieved ${chatHistory.length} messages from history.`);

        // Get the agent executor
        const agentExecutorInstance = await getAgentExecutor();

        // Prepare agent input (ensure correct types)
        // The specific keys needed ("input", "chat_history") match the prompt placeholders
        const agentInput = {
            input: message,
            chat_history: chatHistory,
        };

        // Invoke the agent
        console.log("Invoking agent...");
        const agentResponse = await agentExecutorInstance.invoke(agentInput);
        console.log("Agent response object:", agentResponse); // Log the full response for debugging

        // Extract the final output string - varies slightly depending on agent type,
        // but 'output' is standard for AgentExecutor result.
        const agentOutput = agentResponse?.output || "Sorry, I encountered an issue and couldn't generate a response.";

        console.log(`Agent output: ${agentOutput}`);

        // Update history with the new turn
        const newHistory = [
            ...chatHistory,
            new HumanMessage(message), // User's input message
            new AIMessage(agentOutput)  // Agent's final output message
        ];

        // Save updated history back to Redis with TTL
        await saveChatHistory(sessionId, newHistory);
        console.log("Updated chat history saved.");

        // Send response back to client
        res.status(200).json({ response: agentOutput });

    } catch (error) {
        console.error(`Error processing chat request for session ${sessionId}:`, error);
        res.status(500).json({ error: 'An internal server error occurred. Please try again later.' });
    }
    console.log(`--- Finished processing request for session: ${sessionId} ---`);
});

// Start the server
async function startServer() {
    try {
        // Initialize agent executor on startup (optional, but warms it up)
        await getAgentExecutor();
        // Ensure Redis connection is established
        await getRedisClient();

        app.listen(config.port, () => {
            console.log(`Server listening on port ${config.port}`);
            console.log(`Qdrant URL: ${config.qdrantUrl}`);
            console.log(`Redis URL: ${config.redis.host}:${config.redis.port}`);
        });
    } catch (error) {
         console.error("Failed to start server:", error);
         process.exit(1);
    }
}

startServer();