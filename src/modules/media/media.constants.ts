/**
 * Every upload rule in one place: which media types each resource accepts, size limits,
 * quotas and timings. Change limits here only.
 */
const MB = 1024 * 1024;

export type MediaKind = 'image' | 'video';

/** Allowed MIME types and their extensions (first = canonical, used in the object key). */
export const MEDIA_TYPES: Record<string, { kind: MediaKind; extensions: string[] }> = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'image/gif': { kind: 'image', extensions: ['gif'] },
  'video/mp4': { kind: 'video', extensions: ['mp4'] },
  'video/webm': { kind: 'video', extensions: ['webm'] },
};

export interface ResourceRule {
  /** Max bytes per allowed kind; a kind that is absent is not allowed. */
  maxBytes: Partial<Record<MediaKind, number>>;
  /** Whose namespace the key lives in. College media need the admin or that college's rep. */
  scope: 'user' | 'college';
  /** Folder under the owner, e.g. users/{id}/avatar. */
  folder: (ownerId: string) => string;
}

export const MEDIA_RULES = {
  avatar: { maxBytes: { image: 5 * MB }, scope: 'user', folder: (id) => `users/${id}/avatar` },
  banner: { maxBytes: { image: 10 * MB }, scope: 'user', folder: (id) => `users/${id}/banner` },
  post: { maxBytes: { image: 10 * MB, video: 50 * MB }, scope: 'user', folder: (id) => `posts/${id}` },
  college_logo: { maxBytes: { image: 5 * MB }, scope: 'college', folder: (id) => `colleges/${id}/logo` },
  college_banner: { maxBytes: { image: 10 * MB }, scope: 'college', folder: (id) => `colleges/${id}/banner` },
} satisfies Record<string, ResourceRule>;

export type MediaResourceType = keyof typeof MEDIA_RULES;

/** Presigned PUT lifetime. Short on purpose: the URL is a bearer credential. */
export const UPLOAD_URL_TTL_SECONDS = 600;
/** Uploads not attached to a profile/post/college within this window are deleted. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Abuse / cost protection (Redis, fail closed). */
export const UPLOAD_LIMITS = {
  perUserPerMinute: 10,
  perIpPerMinute: 30,
  perUserPerDay: 50,
  bytesPerUserPerDay: 500 * MB,
};

/** Max media items on one post (any mix of images and videos). */
export const MAX_POST_MEDIA = 4;
