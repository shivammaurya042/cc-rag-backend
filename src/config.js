import dotenv from 'dotenv';
dotenv.config();

export const config = {
    port: process.env.PORT || 3001,
    openaiApiKey: process.env.OPENAI_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    qdrantUrl: process.env.QDRANT_URL,
    qdrantApiKey: process.env.QDRANT_API_KEY,
    redis: {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || '15989', 10),
        username: process.env.REDIS_USERNAME || 'default',
        password: process.env.REDIS_PASSWORD
    },
    validCardsPath: process.env.VALID_CARDS_PATH || './validCards.json',
    sessionTtlSeconds: parseInt(process.env.SESSION_TTL_SECONDS || '3600', 10),

    // Model/Service Config
    embeddingModelName: 'text-embedding-3-small',
    agentModelName: 'gemini-2.0-flash', // dont change
    qdrantCollectionName: 'cards_store', // Ensure this matches ingestion
    maxConversationTokens: 4000, // Approx token limit for history passed to LLM
    llamaParse: {
        apiKey: process.env.LLAMA_CLOUD_API_KEY, // Required for LlamaParse
    },

    // LangSmith Observability
    langsmith: {
        tracing: process.env.LANGSMITH_TRACING === 'true', // Ensure boolean conversion
        apiKey: process.env.LANGSMITH_API_KEY,
        project: process.env.LANGSMITH_PROJECT || 'credit-card-rag-default', // Default project name if not set
        endpoint: process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com',
    },
};

// Basic validation
if (!config.openaiApiKey || !config.googleApiKey || !config.qdrantUrl || !config.redis.host || !config.redis.password) {
    console.error("FATAL ERROR: Missing essential environment variables!");
    process.exit(1);
}

// Validate essential API keys
if (!config.googleApiKey) {
    console.warn("Warning: GOOGLE_API_KEY is not set. Google LLM features (agent, metadata extraction) will fail.");
}

// Validate LangSmith API Key if tracing is enabled
if (config.langsmith.tracing && !config.langsmith.apiKey) {
    console.warn(
        "Warning: LANGSMITH_TRACING is true, but LANGSMITH_API_KEY is not set. Tracing will likely fail."
    );
}