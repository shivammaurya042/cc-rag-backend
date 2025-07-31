import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { getAgentExecutor } from './agent/agent.js';
import { getChatHistory, saveChatHistory } from './agent/memory.js';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages'; // Import specific message types
import { getRedisClient } from './redisClient.js'; // Import redis client getter
import { traceable } from "langsmith/traceable";
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Limit each IP to 20 requests per windowMs
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    keyGenerator: (req, res) => { // Use IP address as the key
        return req.ip;
    }
});

const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigin = process.env.FRONTEND_DOMAIN_URL;
        // In production, only allow requests from the frontend domain.
        // In development, or for same-origin/server-to-server requests, allow.
        if (process.env.NODE_ENV !== 'production' || !origin || origin === allowedOrigin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
};

const app = express();

// Middleware
app.use('/chat', limiter); // Apply specifically to the chat endpoint
app.use(helmet());
app.use(cors(corsOptions)); // Allow requests from frontend (configure origin in production)
app.use(express.json()); // Parse JSON request bodies

// Simple health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Main chat endpoint
app.post('/chat', async (req, res, next) => {
    const { message, sessionId } = req.body;

    // Basic validation
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }
    // Basic Session ID check (example: assumes UUID format expected from frontend)
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!sessionId || typeof sessionId !== 'string' || !uuidRegex.test(sessionId)) {
         return res.status(400).json({ error: 'Invalid or missing session ID.' });
    }

    console.log(`\n--- Received request for session: ${sessionId} ---`);
    console.log(`User message: ${message}`);

    try {
        const cleanedMessage = message.trim();

        // Retrieve history (as LangChain message objects)
        const chatHistory = await getChatHistory(sessionId);
        console.log(`Retrieved ${chatHistory.length} messages from history.`);

        // Get the agent executor
        const agentExecutorInstance = await getAgentExecutor();

        // Prepare agent input (ensure correct types)
        // The specific keys needed ("input", "chat_history") match the prompt placeholders
        const agentInput = {
            input: cleanedMessage,
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
            new HumanMessage(cleanedMessage), // User's input message
            new AIMessage(agentOutput)  // Agent's final output message
        ];

        // Save updated history back to Redis with TTL
        await saveChatHistory(sessionId, newHistory);
        console.log("Updated chat history saved.");

        // Send response back to client
        res.status(200).json({ response: agentOutput });

    } catch (error) {
        console.error(`Error processing chat request for session ${sessionId}:`, error);
        next(error); // Pass error to the error handling middleware
    }
    console.log(`--- Finished processing request for session: ${sessionId} ---`);
});

// Start the server
const rag = traceable(async function startServer() {
    try {
        console.log("\n--- Starting Server ---", process.env.NODE_ENV);
        // Initialize agent executor on startup (optional, but warms it up)
        await getAgentExecutor();
        // Ensure Redis connection is established
        await getRedisClient();

        const port = process.env.PORT || config.port;
        app.listen(port, () => {
            console.log(`Server listening on port ${port}`);
            console.log(`Qdrant URL: ${config.qdrantUrl}`);
            console.log(`Redis URL: ${config.redis.host}:${config.redis.port}`);
        });
    } catch (error) {
         console.error("Failed to start server:", error);
         process.exit(1);
    }
});

// Error handling middleware - must be after all routes
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Oops! Something went wrong.' });
});

rag();