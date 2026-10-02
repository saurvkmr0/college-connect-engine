import { Response } from 'express';

/**
 * Error codes returned by the college verification feature.
 * Response shape:
 *   { success: false, error: { code, message } }
 */
export type ApiErrorCode =
  | 'INVALID_EMAIL'
  | 'INVALID_DOMAIN'
  | 'UNSUPPORTED_COLLEGE_DOMAIN'
  | 'DOMAIN_ALREADY_ASSIGNED'
  | 'ALREADY_VERIFIED'
  | 'OTP_REQUEST_TOO_FREQUENT'
  | 'OTP_HOURLY_LIMIT_EXCEEDED'
  | 'OTP_NOT_FOUND'
  | 'OTP_EXPIRED'
  | 'INVALID_OTP'
  | 'EMAIL_MISMATCH'
  | 'MAX_ATTEMPTS_EXCEEDED'
  | 'EMAIL_SEND_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'AUTH_NOT_CONFIGURED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

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

export interface ApiErrorBody {
  success: false;
  error: { code: ApiErrorCode; message: string };
}

export const sendError = (
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string
): void => {
  const body: ApiErrorBody = { success: false, error: { code, message } };
  res.status(status).json(body);
};

export const sendSuccess = (
  res: Response,
  status: number,
  message: string,
  extra?: Record<string, unknown>
): void => {
  res.status(status).json({ success: true, message, ...extra });
};

/**
 * Single place that turns a thrown error into a consistent API response.
 * Known errors keep their status/code; everything else becomes a 500.
 */
export const handleControllerError = (res: Response, error: unknown, label: string): void => {
  if (error instanceof ApiError) {
    sendError(res, error.status, error.code, error.message);
    return;
  }
  console.error(`${label} error:`, error);
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
};
