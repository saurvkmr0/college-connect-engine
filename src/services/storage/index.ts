import { config } from '../../config';
import { R2StorageService } from './providers/r2.storage';
import { StorageConfigurationError, StorageService } from './storage.types';

export * from './storage.types';

let instance: StorageService | null = null;
let override: StorageService | null = null;

/** Swap the backend at runtime (tests use a fake). `null` restores the configured provider. */
export const setStorageService = (service: StorageService | null): void => {
  override = service;
};

let privateInstance: StorageService | null = null;
let privateOverride: StorageService | null = null;

export const setPrivateStorageService = (service: StorageService | null): void => {
  privateOverride = service;
};

/**
 * Private bucket (chat files): never public, read only through short-lived signed links.
 * Same provider and credentials as public media, different bucket (R2_PRIVATE_BUCKET_NAME).
 */
export const getPrivateStorageService = (): StorageService => {
  if (privateOverride) return privateOverride;
  if (!privateInstance) {
    if (config.storage.provider !== 'r2') throw new StorageConfigurationError(`Unknown STORAGE_PROVIDER "${config.storage.provider}"`);
    if (!config.storage.r2.privateBucket) throw new StorageConfigurationError('R2_PRIVATE_BUCKET_NAME is not configured');
    privateInstance = new R2StorageService({ ...config.storage.r2, bucket: config.storage.r2.privateBucket, publicBaseUrl: '' });
  }
  return privateInstance;
};

/** The public-media storage backend chosen by STORAGE_PROVIDER. */
export const getStorageService = (): StorageService => {
  if (override) return override;
  if (!instance) {
    switch (config.storage.provider) {
      case 'r2':
        instance = new R2StorageService({ ...config.storage.r2, publicBaseUrl: config.storage.publicBaseUrl });
        break;
      default:
        throw new StorageConfigurationError(`Unknown STORAGE_PROVIDER "${config.storage.provider}"`);
    }
  }
  return instance;
};
