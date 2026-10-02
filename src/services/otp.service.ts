import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { isRedisReady, redisClient } from '../config/redis';
import { ApiError } from '../utils/apiError';

/**
 * All OTP/rate-limit constants are fixed by product requirements and are
 * deliberately NOT configurable through the environment.
 */
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300; // 5 minutes
export const RESEND_COOLDOWN_SECONDS = 60; // 1 request / minute
export const HOURLY_REQUEST_LIMIT = 5; // 5 requests / hour
export const HOURLY_WINDOW_SECONDS = 3600;
export const MAX_VERIFY_ATTEMPTS = 5; // 5 wrong codes per OTP

const REDIS_TIMEOUT_MS = 3000;
const SERVICE_UNAVAILABLE = 'Verification service is temporarily unavailable. Please try again later.';

/** Redis keys - see README for the full list. */
export const otpKey = (userId: string) => `college-verification:otp:${userId}`;
export const resendKey = (userId: string) => `college-verification:resend:${userId}`;
export const hourlyKey = (userId: string) => `college-verification:hourly:${userId}`;

export interface OtpRecord {
  /** Normalized email the code was sent to. */
  email: string;
  /** College resolved from the email domain - never taken from the client. */
  collegeId: string;
  /** HMAC of the OTP; the plaintext code is never stored. */
  otpHash: string;
  attempts: number;
}

const serviceUnavailable = (): ApiError =>
  new ApiError(503, 'SERVICE_UNAVAILABLE', SERVICE_UNAVAILABLE);

const withTimeout = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Redis command timed out')), REDIS_TIMEOUT_MS).unref?.()
    ),
  ]);

/**
 * Runs a Redis command with availability checks, a timeout and consistent
 * 503 errors. Verification fails closed when Redis is unreachable, so rate
 * limits can never be bypassed.
 */
const redisCall = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (!isRedisReady()) throw serviceUnavailable();

  try {
    return await withTimeout(fn());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('[otp] redis error:', error instanceof Error ? error.message : error);
    throw serviceUnavailable();
  }
};

/* ------------------------------------------------------------------ */
/* OTP generation + hashing                                            */
/* ------------------------------------------------------------------ */

/** Cryptographically secure 6-digit code. `Math.random()` is never used. */
export const generateOtp = (): string =>
  randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');

/** HMAC-SHA256 so a leaked Redis dump cannot be reversed into a code. */
export const hashOtp = (otp: string): string =>
  createHmac('sha256', config.otpHashSecret).update(String(otp)).digest('hex');

/** Constant-time comparison of an OTP against its stored hash. */
export const verifyOtpHash = (otp: string, storedHash: string): boolean => {
  const candidate = Buffer.from(hashOtp(otp), 'utf8');
  const expected = Buffer.from(storedHash || '', 'utf8');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
};

/* ------------------------------------------------------------------ */
/* OTP record storage                                                  */
/* ------------------------------------------------------------------ */

/** Writes the record with a 5 minute TTL. Overwriting invalidates any previous OTP. */
export const saveOtpRecord = async (userId: string, record: OtpRecord): Promise<void> => {
  await redisCall(() =>
    redisClient.set(otpKey(userId), JSON.stringify(record), { EX: OTP_TTL_SECONDS })
  );
};

export const getOtpRecord = async (userId: string): Promise<OtpRecord | null> => {
  const raw = await redisCall(() => redisClient.get(otpKey(userId)));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as OtpRecord;
    if (!parsed || typeof parsed.otpHash !== 'string' || typeof parsed.email !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt record: treat it as absent so the user can request a new code.
    await deleteOtpRecord(userId);
    return null;
  }
};

/** Persists attempt counters WITHOUT extending the original 5 minute TTL. */
export const saveOtpRecordKeepingTtl = async (userId: string, record: OtpRecord): Promise<void> => {
  await redisCall(() =>
    redisClient.set(otpKey(userId), JSON.stringify(record), { KEEPTTL: true })
  );
};

export const deleteOtpRecord = async (userId: string): Promise<void> => {
  await redisCall(() => redisClient.del(otpKey(userId)));
};

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/** Seconds left before another OTP can be requested (0 when allowed). */
export const getResendCooldown = async (userId: string): Promise<number> => {
  const ttl = await redisCall(() => redisClient.ttl(resendKey(userId)));
  return ttl > 0 ? ttl : 0;
};

export const startResendCooldown = async (userId: string): Promise<void> => {
  await redisCall(() =>
    redisClient.set(resendKey(userId), '1', { EX: RESEND_COOLDOWN_SECONDS })
  );
};

/** Increments the hourly counter and returns the new value. */
export const incrementHourlyRequests = async (userId: string): Promise<number> => {
  return redisCall(async () => {
    const key = hourlyKey(userId);
    const count = await redisClient.incr(key);
    const ttl = await redisClient.ttl(key);
    // First hit (or a lost expiry) starts the 1 hour window.
    if (count === 1 || ttl < 0) {
      await redisClient.expire(key, HOURLY_WINDOW_SECONDS);
    }
    return count;
  });
};

/** Clears rate-limit state - used after a successful verification. */
export const clearVerificationRateLimits = async (userId: string): Promise<void> => {
  await redisCall(() => redisClient.del([resendKey(userId), hourlyKey(userId)]));
};
