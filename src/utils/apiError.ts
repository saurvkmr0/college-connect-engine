import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Every error response has the shape `{ success: false, error: { code, message } }`.
 * Clients branch on `code`; `message` is safe to show to users.
 */
export type ApiErrorCode =
  | 'INVALID_EMAIL'
  | 'INVALID_DOMAIN'
  | 'UNSUPPORTED_COLLEGE_DOMAIN'
  | 'DOMAIN_ALREADY_ASSIGNED'
  | 'ALREADY_VERIFIED'
  | 'VERIFICATION_REQUIRED'
  | 'OTP_REQUEST_TOO_FREQUENT'
  | 'OTP_HOURLY_LIMIT_EXCEEDED'
  | 'OTP_EXPIRED'
  | 'INVALID_OTP'
  | 'EMAIL_MISMATCH'
  | 'MAX_ATTEMPTS_EXCEEDED'
  | 'EMAIL_SEND_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'AUTH_NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

/** Throw this anywhere; the error middleware turns it into the response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `{ success: true, message, ...extra }` - the success shape used by newer endpoints. */
export const sendSuccess = (
  res: Response,
  status: number,
  message: string,
  extra?: Record<string, unknown>
): void => {
  res.status(status).json({ success: true, message, ...extra });
};

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Express 4 ignores rejected promises; this forwards them to the error middleware. */
export const asyncHandler =
  (fn: AsyncRequestHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
