import { createClient, RedisClientType } from 'redis';
import { config } from './index';
import { ApiError } from '../utils/apiError';

/** How long startup waits for Redis before continuing without it. */
const CONNECT_TIMEOUT_MS = 5000;
/** Per-command timeout so a hung Redis never hangs a request. */
const COMMAND_TIMEOUT_MS = 3000;

/**
 * The single Redis client for the process (OTP storage + rate limiting).
 * Do not create other connections - go through `redisCommand` instead.
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

const timeout = (ms: number, message: string) =>
  new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), ms).unref?.();
  });

/**
 * Connect to Redis, but never block startup for more than CONNECT_TIMEOUT_MS.
 * Returns true when Redis is usable.
 */
export const connectRedis = async (): Promise<boolean> => {
  if (redisClient.isReady) return true;
  if (connectAttempted) return redisClient.isReady;
  connectAttempted = true;

  const attempt = redisClient.connect();
  // The background retry loop may settle later; never leave it unhandled.
  attempt.catch(() => undefined);

  try {
    await Promise.race([attempt, timeout(CONNECT_TIMEOUT_MS, 'Redis connect timeout')]);
    return true;
  } catch (error) {
    console.warn(
      'Redis not reachable - OTP verification and admin login fail closed (HTTP 503) until it is available' +
        (error instanceof Error ? ` (${error.message})` : '')
    );
    return false;
  }
};

export const closeRedis = async (): Promise<void> => {
  try {
    if (redisClient.isReady) await redisClient.quit();
  } catch {
    redisClient.disconnect();
  }
};

/**
 * Runs a Redis command with a readiness check and a timeout.
 * Throws 503 SERVICE_UNAVAILABLE when Redis is unusable: callers fail closed
 * by default, or catch it to fail open.
 */
export const redisCommand = async <T>(fn: () => Promise<T>): Promise<T> => {
  const unavailable = () =>
    new ApiError(503, 'SERVICE_UNAVAILABLE', 'Service is temporarily unavailable. Please try again later.');

  if (!redisClient.isReady) throw unavailable();
  try {
    return await Promise.race([fn(), timeout(COMMAND_TIMEOUT_MS, 'Redis command timed out')]);
  } catch (error) {
    console.error('[redis] command failed:', error instanceof Error ? error.message : error);
    throw unavailable();
  }
};

/** Fixed-window counter: increments `key` and starts the window on the first hit. Returns the new count. */
export const incrementWindow = (key: string, windowSeconds: number): Promise<number> =>
  redisCommand(async () => {
    const count = await redisClient.incr(key);
    // First hit (or a lost expiry) starts the window.
    if (count === 1 || (await redisClient.ttl(key)) < 0) {
      await redisClient.expire(key, windowSeconds);
    }
    return count;
  });
