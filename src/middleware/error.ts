import { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { StorageConfigurationError, StorageError } from '../services/storage';
import { ApiError } from '../utils/apiError';

export const notFound: RequestHandler = () => {
  throw new ApiError(404, 'NOT_FOUND', 'Route not found');
};

/** Maps known library errors to a client-safe ApiError; anything unknown is a 500. */
const toApiError = (err: unknown): ApiError => {
  if (err instanceof ApiError) return err;

  // Storage failures never reach the client as raw SDK errors (no bucket/account details).
  if (err instanceof StorageConfigurationError) {
    return new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Media uploads are not available right now.');
  }
  if (err instanceof StorageError) {
    return new ApiError(503, 'STORAGE_UNAVAILABLE', 'Media storage is temporarily unavailable. Please try again.');
  }

  // Malformed ids (e.g. /posts/abc) - treat as "not found" rather than crashing.
  if (err instanceof mongoose.Error.CastError) {
    return err.kind === 'ObjectId'
      ? new ApiError(404, 'NOT_FOUND', 'Resource not found')
      : new ApiError(400, 'VALIDATION_ERROR', `Invalid value for ${err.path}`);
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    return new ApiError(400, 'VALIDATION_ERROR', first?.message ?? 'Invalid input');
  }

  const e = err as { code?: number; status?: number; expose?: boolean };
  if (e?.code === 11000) return new ApiError(409, 'CONFLICT', 'This record already exists');
  // body-parser errors (malformed JSON, payload too large) carry a safe 4xx status.
  if (e?.expose && e.status && e.status < 500) {
    return new ApiError(e.status, 'VALIDATION_ERROR', 'Invalid request body');
  }

  return new ApiError(500, 'INTERNAL_ERROR', 'Internal server error');
};

/** Single place that turns any thrown error into `{ success: false, error: { code, message } }`. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const apiError = toApiError(err);
  if (err instanceof StorageError) {
    // Safe identifiers only - raw provider errors can carry bucket/account/host details.
    const cause = (err as { cause?: { name?: string } }).cause;
    console.error(JSON.stringify({ scope: 'storage', event: 'storage_error', method: req.method, path: req.route?.path ?? req.path, errorCode: apiError.code, error: err.name, cause: cause?.name }));
  } else if (apiError.status >= 500) {
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
  }
  res.status(apiError.status).json({
    success: false,
    error: { code: apiError.code, message: apiError.message },
  });
};
