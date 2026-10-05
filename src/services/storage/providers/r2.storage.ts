import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageConfigurationError, StorageError, StorageService, StoredObject, UploadUrl, UploadUrlRequest } from '../storage.types';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** e.g. https://media.example.com - the custom domain serving this bucket. */
  publicBaseUrl: string;
}

/** Presigned URLs are bearer credentials: never sign anything long-lived. */
const MAX_UPLOAD_URL_SECONDS = 3600;

/**
 * Cloudflare R2 through its S3-compatible API. The only file in the app that knows about
 * R2, the S3 SDK, the account endpoint or the credentials.
 */
export class R2StorageService implements StorageService {
  readonly name = 'r2';
  private client: S3Client | null = null;

  constructor(private readonly cfg: R2Config) {}

  /** Created on first use, so the app can boot without storage configured. */
  private s3(): S3Client {
    const { accountId, accessKeyId, secretAccessKey, bucket } = this.cfg;
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new StorageConfigurationError('R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)');
    }
    this.client ??= new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      // One predictable endpoint (.../bucket/key); also safe for bucket names containing dots.
      forcePathStyle: true,
      // Newer SDKs add a CRC32 of the (empty) request body to presigned URLs by default, which
      // makes real browser uploads fail. Only send checksums when an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId, secretAccessKey },
    });
    return this.client;
  }

  async createUploadUrl({ key, contentType, contentLength, expiresInSeconds }: UploadUrlRequest): Promise<UploadUrl> {
    if (!(expiresInSeconds > 0 && expiresInSeconds <= MAX_UPLOAD_URL_SECONDS)) {
      throw new StorageError(`Refusing to sign an upload URL valid for ${expiresInSeconds}s`);
    }
    const command = new PutObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    try {
      const url = await getSignedUrl(this.s3(), command, {
        expiresIn: expiresInSeconds,
        // Bind type and size into the signature: a different header invalidates the URL.
        signableHeaders: new Set(['content-type', 'content-length']),
      });
      return { url, expiresInSeconds };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('R2 presign failed', { cause: error });
    }
  }

  getPublicUrl(key: string): string {
    const base = this.cfg.publicBaseUrl.replace(/\/+$/, '');
    if (!base) throw new StorageConfigurationError('R2_PUBLIC_BASE_URL is not configured');
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async headObject(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.s3().send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: head.ContentLength ?? 0, contentType: head.ContentType };
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      if (error instanceof StorageError) throw error;
      throw new StorageError('R2 head failed', { cause: error });
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.s3().send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('R2 delete failed', { cause: error });
    }
  }
}
