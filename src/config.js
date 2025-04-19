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
    qdrantCollectionName: 'cc_t_and_c', // Ensure this matches ingestion
    maxConversationTokens: 4000, // Approx token limit for history passed to LLM
};

// Basic validation
if (!config.openaiApiKey || !config.googleApiKey || !config.qdrantUrl || !config.redis.host || !config.redis.password) {
    console.error("FATAL ERROR: Missing essential environment variables!");
    process.exit(1);
}