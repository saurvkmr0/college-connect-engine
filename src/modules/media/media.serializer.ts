import { getStorageService } from '../../services/storage';
import { isObjectKey, logMedia } from './media.service';

/** Response fields that hold a media reference (object key, or a legacy https link). */
const MEDIA_REF_FIELDS = new Set(['avatar', 'banner', 'logo', 'bannerImage']);

/** Object key -> public URL (no network). Legacy https links pass through unchanged. */
export const toPublicUrl = (ref: string): string => {
  if (!isObjectKey(ref)) return ref;
  try {
    return getStorageService().getPublicUrl(ref);
  } catch (error) {
    logMedia('public_url_failed', { error: error instanceof Error ? error.name : 'unknown' });
    return '';
  }
};

/**
 * Registered as Express's JSON replacer: the ONE place stored keys become public URLs, for
 * every response (lean queries, aggregations, populates). The database never stores URLs, so
 * changing CDN/provider needs no migration. Post media `{ objectKey, kind }` -> `{ url, kind }`.
 */
export function mediaJsonReplacer(key: string, value: unknown): unknown {
  if (typeof value === 'string' && MEDIA_REF_FIELDS.has(key)) return toPublicUrl(value);
  if (key === 'media' && Array.isArray(value)) {
    return value.map((item) =>
      item && typeof item === 'object' && 'objectKey' in item
        ? { url: toPublicUrl(String((item as { objectKey: string }).objectKey)), kind: (item as { kind?: string }).kind }
        : item
    );
  }
  return value;
}
