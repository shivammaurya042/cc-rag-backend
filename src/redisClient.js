import { createClient } from 'redis';
import { config } from './config.js';

let redisClient = null;

export async function getRedisClient() {
    if (redisClient && redisClient.isReady) {
        return redisClient;
    }
    try {
        redisClient = createClient({
            username: config.redis.username,
            password: config.redis.password,
            socket: {
                host: config.redis.host,
                port: config.redis.port
            }
        });
        redisClient.on('error', (err) => console.error('Redis Client Error', err));
        await redisClient.connect();
        console.log('Connected to Redis successfully.');
        return redisClient;
    } catch (err) {
        console.error('Failed to connect to Redis:', err);
        // Depending on requirements, maybe retry or exit
        throw new Error('Redis connection failed');
    }
}

// Optional: Close connection gracefully on shutdown
process.on('SIGINT', async () => {
    if (redisClient && redisClient.isReady) {
        await redisClient.quit();
    }
    process.exit(0);
});
process.on('SIGTERM', async () => {
     if (redisClient && redisClient.isReady) {
        await redisClient.quit();
    }
    process.exit(0);
});