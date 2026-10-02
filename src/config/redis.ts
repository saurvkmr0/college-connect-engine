import { createClient, RedisClientType } from 'redis';
import { config } from './index';

/** How long startup waits for Redis before continuing without it. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Shared Redis client used for OTP storage and rate limiting.
 * A single client is created for the whole process - no other Redis
 * connections should be introduced elsewhere in the codebase.
 */
export const redisClient: RedisClientType = createClient({
  url: config.redisUrl,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
  },
});

let connectAttempted = false;

redisClient.on('error', () => {
  // Errors are reported by connectRedis(); keep the process quiet and alive.
  // The client keeps retrying in the background, so a later connection works.
});

redisClient.on('ready', () => {
  console.log('Connected to Redis');
});

/**
 * Connect to Redis, but never block startup for more than CONNECT_TIMEOUT_MS.
 * Returns true when Redis is usable. A Redis outage does not stop the API:
 * verification endpoints fail closed with 503 instead.
 */
export const connectRedis = async (): Promise<boolean> => {
  if (redisClient.isReady) return true;
  if (connectAttempted) return redisClient.isReady;
  connectAttempted = true;

  const attempt = redisClient.connect();
  // The background retry loop may settle later; never leave it unhandled.
  attempt.catch(() => undefined);

  try {
    await Promise.race([
      attempt,
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Redis connect timeout')), CONNECT_TIMEOUT_MS).unref?.()
      ),
    ]);
    return true;
  } catch (error) {
    console.warn(
      `Redis not reachable at ${config.redisUrl} - college verification will fail closed (HTTP 503) until Redis is available` +
        (error instanceof Error ? ` (${error.message})` : '')
    );
    return false;
  }
};

export const isRedisReady = (): boolean => redisClient.isReady;

export const closeRedis = async (): Promise<void> => {
  try {
    if (redisClient.isReady) await redisClient.quit();
  } catch {
    redisClient.disconnect();
  }
};
