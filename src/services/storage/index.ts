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
