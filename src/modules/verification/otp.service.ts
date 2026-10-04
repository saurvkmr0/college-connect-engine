import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import { incrementWindow, redisClient, redisCommand } from '../../config/redis';
import { sendEmail } from '../../services/email/emailProvider';
import { buildOtpEmail } from '../../services/email/templates';
import { ApiError } from '../../utils/apiError';

/**
 * One OTP engine for every "prove you own this email" flow. Each purpose has its own Redis
 * keys, so a password-reset code can never verify an account or a college email.
 *
 * All limits are fixed by product requirements and deliberately NOT configurable via env.
 */
export type OtpPurpose = 'account' | 'reset' | 'college' | 'portal';

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300; // 5 minutes
export const RESEND_COOLDOWN_SECONDS = 60; // 1 request / minute
export const HOURLY_REQUEST_LIMIT = 5; // 5 requests / hour
export const HOURLY_WINDOW_SECONDS = 3600;
export const MAX_VERIFY_ATTEMPTS = 5; // 5 wrong codes per OTP

/** Email subject per purpose - the body is the same template for all of them. */
const SUBJECTS: Record<OtpPurpose, string> = {
  account: 'Verify your College Connect account',
  reset: 'Your College Connect password reset code',
  college: 'Your College Connect verification code',
  portal: 'Your College Connect portal verification code',
};

/** Redis keys - see README for the full list. */
const keys = (purpose: OtpPurpose, userId: string) => ({
  otp: `otp:${purpose}:code:${userId}`,
  resend: `otp:${purpose}:resend:${userId}`,
  hourly: `otp:${purpose}:hourly:${userId}`,
});

export interface OtpRecord {
  /** Normalized email the code was sent to. */
  email: string;
  /** HMAC of the OTP; the plaintext code is never stored. */
  otpHash: string;
  attempts: number;
  /** Server-decided data to apply once the code is confirmed (e.g. the chosen college). */
  context?: Record<string, unknown>;
}

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

const readRecord = async (purpose: OtpPurpose, userId: string): Promise<OtpRecord | null> => {
  const key = keys(purpose, userId).otp;
  const raw = await redisCommand(() => redisClient.get(key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OtpRecord;
    return parsed && typeof parsed.otpHash === 'string' && typeof parsed.email === 'string' ? parsed : null;
  } catch {
    // Corrupt record: treat it as absent so the user can request a new code.
    await redisCommand(() => redisClient.del(key));
    return null;
  }
};

const deleteRecord = async (purpose: OtpPurpose, userId: string): Promise<void> => {
  await redisCommand(() => redisClient.del(keys(purpose, userId).otp));
};

/**
 * Rate-limits, stores a hashed OTP (5 min TTL) and emails the code. A new code replaces
 * the previous one for that purpose. Never returns the OTP.
 */
export const issueOtp = async (
  purpose: OtpPurpose,
  userId: string,
  email: string,
  options: { collegeName?: string; context?: Record<string, unknown> } = {}
): Promise<void> => {
  const k = keys(purpose, userId);

  const cooldown = await redisCommand(() => redisClient.ttl(k.resend));
  if (cooldown > 0) {
    throw new ApiError(429, 'OTP_REQUEST_TOO_FREQUENT', 'Please wait a minute before requesting another code.');
  }
  if ((await incrementWindow(k.hourly, HOURLY_WINDOW_SECONDS)) > HOURLY_REQUEST_LIMIT) {
    throw new ApiError(429, 'OTP_HOURLY_LIMIT_EXCEEDED', 'Too many verification requests. Please try again later.');
  }

  const code = generateOtp();
  const record: OtpRecord = { email, otpHash: hashOtp(code), attempts: 0, context: options.context };
  await redisCommand(() => redisClient.set(k.otp, JSON.stringify(record), { EX: OTP_TTL_SECONDS }));
  await redisCommand(() => redisClient.set(k.resend, '1', { EX: RESEND_COOLDOWN_SECONDS }));

  try {
    const { text, html } = buildOtpEmail({
      code,
      collegeName: options.collegeName,
      expiresInMinutes: Math.round(OTP_TTL_SECONDS / 60),
    });
    await sendEmail({ to: email, subject: SUBJECTS[purpose], text, html });
  } catch {
    // The code never reached the user - invalidate it and lift the cooldown so "Resend" works now.
    await redisCommand(() => redisClient.del([k.otp, k.resend]));
    throw new ApiError(502, 'EMAIL_SEND_FAILED', 'We could not send the verification email. Please try again.');
  }
};

/**
 * Checks a submitted code. Wrong codes count towards MAX_VERIFY_ATTEMPTS without extending
 * the TTL (KEEPTTL). On success the code is consumed, the rate limits reset and the record
 * (with its context) is returned.
 */
export const consumeOtp = async (
  purpose: OtpPurpose,
  userId: string,
  email: string,
  rawOtp: unknown
): Promise<OtpRecord> => {
  const record = await readRecord(purpose, userId);
  if (!record) {
    // Missing and expired records share a code: Redis drops expired keys.
    throw new ApiError(400, 'OTP_EXPIRED', 'The verification code has expired. Please request a new code.');
  }
  // The code must be used with the email it was issued for.
  if (record.email !== email) {
    throw new ApiError(400, 'EMAIL_MISMATCH', 'The email does not match the pending verification request.');
  }
  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    await deleteRecord(purpose, userId);
    throw new ApiError(429, 'MAX_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Please request a new code.');
  }

  const submitted = typeof rawOtp === 'string' || typeof rawOtp === 'number' ? String(rawOtp).trim() : '';
  if (!submitted || !verifyOtpHash(submitted, record.otpHash)) {
    const attempts = record.attempts + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await deleteRecord(purpose, userId);
      throw new ApiError(429, 'MAX_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Please request a new code.');
    }
    const key = keys(purpose, userId).otp;
    await redisCommand(() => redisClient.set(key, JSON.stringify({ ...record, attempts }), { KEEPTTL: true }));
    throw new ApiError(400, 'INVALID_OTP', 'Invalid verification code.');
  }

  const k = keys(purpose, userId);
  await redisCommand(() => redisClient.del([k.otp, k.resend, k.hourly]));
  return record;
};
