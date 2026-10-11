/**
 * Provider-independent storage contract. Controllers, services and models depend on this,
 * never on a cloud SDK, so the backend (R2, S3, Backblaze, GCS...) can be swapped by adding a
 * provider - nothing else changes. A future private bucket (chat files) is another instance
 * of the same contract plus a `createDownloadUrl` for signed GETs.
 */

export interface UploadUrlRequest {
  /** Server-generated object key - never taken from the client. */
  key: string;
  /** Signed into the URL: the upload must use exactly this Content-Type. */
  contentType: string;
  /** Signed into the URL: the upload must be exactly this many bytes. */
  contentLength: number;
  expiresInSeconds: number;
}

export interface UploadUrl {
  /** Bearer credential until it expires - never log or store it. */
  url: string;
  expiresInSeconds: number;
}

export interface DownloadUrlRequest {
  key: string;
  expiresInSeconds: number;
  /** Shown to the user when saving; sanitized by the provider. */
  filename: string;
  /** `attachment` forces a download (documents); `inline` lets images/videos display. */
  disposition: 'inline' | 'attachment';
  contentType: string;
}

/**
 * Content-Disposition with an ASCII fallback (quotes, backslashes and control characters removed)
 * plus an RFC 5987 UTF-8 name, so a filename can never inject headers or break the value.
 */
export const contentDisposition = (disposition: 'inline' | 'attachment', filename: string): string => {
  const ascii = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'file';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.replace(/[\r\n]/g, ''))}`;
};

export interface StoredObject {
  size: number;
  contentType?: string;
}

export interface StorageService {
  /** Short name for logs (e.g. 'r2'). */
  readonly name: string;
  createUploadUrl(request: UploadUrlRequest): Promise<UploadUrl>;
  /** Deterministic public URL for a key (no network call). */
  getPublicUrl(key: string): string;
  /** Object metadata, or null when it does not exist. */
  headObject(key: string): Promise<StoredObject | null>;
  /** Deleting a missing object is not an error. */
  deleteObject(key: string): Promise<void>;
  /** Server-side copy inside the bucket (no bytes through Node). */
  copyObject(fromKey: string, toKey: string): Promise<void>;
  /** Short-lived signed GET for a private object (never stored or logged). */
  createDownloadUrl(request: DownloadUrlRequest): Promise<string>;
}

/** Any storage backend failure. The message is for logs only - clients get a generic 503. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/** Storage is not configured (missing credentials, bucket or public URL). */
export class StorageConfigurationError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigurationError';
  }
}
