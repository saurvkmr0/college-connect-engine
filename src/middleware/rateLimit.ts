import { Request } from 'express';
import { incrementWindow } from '../config/redis';
import { ApiError, asyncHandler } from '../utils/apiError';

interface RateLimitOptions {
  /** Namespace for the Redis key, e.g. 'login'. */
  name: string;
  /** Max requests per window. */
  limit: number;
  windowSeconds: number;
  /** Who is being limited. Defaults to the client IP (set TRUST_PROXY behind a proxy). */
  keyBy?: (req: Request) => string;
  /**
   * When Redis is down: true lets requests through (keeps login working),
   * false rejects with 503 (for endpoints where brute force matters more than uptime).
   */
  failOpen?: boolean;
}

/** Fixed-window rate limiter backed by the shared Redis client, so limits hold across instances. */
export const rateLimit = ({
  name,
  limit,
  windowSeconds,
  keyBy = (req) => req.ip ?? 'unknown',
  failOpen = true,
}: RateLimitOptions) =>
  asyncHandler(async (req, _res, next) => {
    let count: number;
    try {
      count = await incrementWindow(`rate:${name}:${keyBy(req)}`, windowSeconds);
    } catch (error) {
      if (failOpen) return next();
      throw error;
    }

    if (count > limit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.');
    }
    next();
  });

const FIFTEEN_MINUTES = 15 * 60;

/** Login (student + portal). Keyed by IP + email so one campus NAT does not lock out every student. */
export const loginLimit = rateLimit({
  name: 'login',
  limit: 10,
  windowSeconds: FIFTEEN_MINUTES,
  keyBy: (req) => `${req.ip}:${String(req.body?.email ?? '').trim().toLowerCase()}`,
});

/** Forgot/reset password. Per IP + email; the OTP engine adds its own per-account cooldown and caps. */
export const resetLimit = rateLimit({
  name: 'reset',
  limit: 10,
  windowSeconds: FIFTEEN_MINUTES,
  keyBy: (req) => `${req.ip}:${String(req.body?.email ?? '').trim().toLowerCase()}`,
});

/** Account creation (student signup + portal register). */
export const signupLimit = rateLimit({ name: 'signup', limit: 20, windowSeconds: 60 * 60 });

/** Comments are open to unverified accounts, so cap them per user to keep spam out. */
export const commentLimit = rateLimit({
  name: 'comment',
  limit: 30,
  windowSeconds: 10 * 60,
  keyBy: (req) => req.user?.userId ?? req.ip ?? 'unknown',
});

/** Likes and follows are open to unverified (cheap) accounts - cap them per user so scripts cannot game rankings. */
export const reactionLimit = rateLimit({
  name: 'reaction',
  limit: 120,
  windowSeconds: 10 * 60,
  keyBy: (req) => req.user?.userId ?? req.ip ?? 'unknown',
});
