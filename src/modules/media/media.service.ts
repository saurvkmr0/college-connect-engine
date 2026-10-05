import { randomUUID } from 'node:crypto';
import { incrementWindow } from '../../config/redis';
import { getStorageService } from '../../services/storage';
import { AuthUser, UserRole } from '../../types';
import { ApiError } from '../../utils/apiError';
import { str } from '../../utils/request';
import { College } from '../colleges/college.model';
import {
  MEDIA_RULES,
  MEDIA_TYPES,
  MediaResourceType,
  PENDING_TTL_MS,
  ResourceRule,
  UPLOAD_LIMITS,
  UPLOAD_URL_TTL_SECONDS,
} from './media.constants';
import { MediaAsset } from './media.model';

const DAY_SECONDS = 24 * 60 * 60;

/** Structured, safe log line: ids and codes only - never URLs, tokens or secrets. */
export const logMedia = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ scope: 'media', event, ...fields }));
};

/** The admin, or the approved rep of that college, may upload its logo/banner. */
const assertCanManageCollege = async (user: AuthUser, collegeId: string): Promise<void> => {
  if (!collegeId || !(await College.exists({ _id: collegeId }))) throw new ApiError(404, 'NOT_FOUND', 'College not found');
  const isAdmin = user.role === UserRole.ADMIN;
  const isItsRep = user.managerStatus === 'approved' && user.managedCollegeId === collegeId;
  if (!isAdmin && !isItsRep) throw new ApiError(403, 'FORBIDDEN', 'You cannot upload media for this college.');
};

/**
 * Validates an upload request and returns a short-lived presigned PUT URL for a
 * server-generated key. The client only describes the file; it never chooses the key,
 * bucket or namespace. The signature binds the exact Content-Type and size.
 */
export const createUpload = async (user: AuthUser, rawBody: unknown) => {
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;

  const resourceType = str(body.resourceType) as MediaResourceType;
  const rule: ResourceRule | undefined = MEDIA_RULES[resourceType];
  if (!rule) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported resource type.');

  const contentType = str(body.contentType).toLowerCase();
  const type = MEDIA_TYPES[contentType];
  const maxBytes = type && rule.maxBytes[type.kind];
  if (!type || !maxBytes) throw new ApiError(400, 'VALIDATION_ERROR', 'This file type is not allowed here.');

  // Extension: letters/digits only and consistent with the type; the key uses the canonical one.
  const extension = str(body.extension).toLowerCase().replace(/^\./, '');
  if (!type.extensions.includes(extension)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The file extension does not match the file type.');
  }

  const size = Number(body.fileSize);
  if (!Number.isInteger(size) || size <= 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid file size.');
  if (size > maxBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE', `File is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB).`);
  }

  let ownerId = user.userId;
  if (rule.scope === 'college') {
    ownerId = str(body.collegeId);
    await assertCanManageCollege(user, ownerId);
  }

  // Daily quotas (cost protection) - counted only for valid requests.
  if ((await incrementWindow(`rate:media-daily-count:${user.userId}`, DAY_SECONDS)) > UPLOAD_LIMITS.perUserPerDay) {
    logMedia('quota_exceeded', { userId: user.userId, quota: 'count' });
    throw new ApiError(429, 'RATE_LIMITED', 'Daily upload limit reached. Please try again tomorrow.');
  }
  if ((await incrementWindow(`rate:media-daily-bytes:${user.userId}`, DAY_SECONDS, size)) > UPLOAD_LIMITS.bytesPerUserPerDay) {
    logMedia('quota_exceeded', { userId: user.userId, quota: 'bytes' });
    throw new ApiError(429, 'RATE_LIMITED', 'Daily upload size limit reached. Please try again tomorrow.');
  }

  // Unique, unpredictable, immutable key: a new upload never overwrites an existing object.
  const assetId = randomUUID();
  const key = `${rule.folder(ownerId)}/${assetId}.${type.extensions[0]}`;

  const { url, expiresInSeconds } = await getStorageService().createUploadUrl({
    key,
    contentType,
    contentLength: size,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });

  await MediaAsset.create({
    _id: assetId,
    owner: user.userId,
    objectKey: key,
    resourceType,
    kind: type.kind,
    contentType,
    size,
    ...(rule.scope === 'college' && { collegeId: ownerId }),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });
  logMedia('upload_url_created', { userId: user.userId, assetId, resourceType, size });

  return { uploadUrl: url, assetId, key, expiresIn: expiresInSeconds };
};

/**
 * Deletes an object, never throwing: a failure marks the asset `orphaned` so the sweeper
 * retries. Used when media is replaced/removed and when uploads are discarded.
 */
export const releaseObject = async (key: string): Promise<void> => {
  try {
    await getStorageService().deleteObject(key);
    await MediaAsset.deleteOne({ objectKey: key });
  } catch (error) {
    await MediaAsset.updateOne({ objectKey: key }, { $set: { status: 'orphaned' } });
    logMedia('delete_failed', { objectKey: key, error: error instanceof Error ? error.name : 'unknown' });
  }
};

/** The owner discards an upload they no longer need (e.g. removed from the post composer). */
export const discardUpload = async (user: AuthUser, assetId: string): Promise<void> => {
  // Leave `pending` atomically first: from here no attach can succeed, so deleting is safe.
  const asset = await MediaAsset.findOneAndUpdate(
    { _id: str(assetId), owner: user.userId, status: 'pending' },
    { $set: { status: 'orphaned' }, $unset: { expiresAt: 1 } }
  ).lean();
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Upload not found');
  await releaseObject(asset.objectKey);
  logMedia('upload_discarded', { userId: user.userId, assetId: asset._id });
};

/** An asset once attached: what entities store (object key + kind), plus its id for rollback. */
export interface AttachedMedia {
  assetId: string;
  objectKey: string;
  kind: 'image' | 'video';
}

/** True for an object key we manage, false for legacy `https://` links (never deleted by us). */
export const isObjectKey = (ref?: string | null): ref is string => Boolean(ref) && !/^https?:\/\//i.test(ref as string);

/** Puts attached assets back to pending (the entity was not saved) so the sweeper cleans them up. */
export const unclaimAssets = async (assetIds: string[]): Promise<void> => {
  if (assetIds.length === 0) return;
  await MediaAsset.updateMany(
    { _id: { $in: assetIds }, status: 'attached' },
    { $set: { status: 'pending', expiresAt: new Date(Date.now() + PENDING_TTL_MS) } }
  );
};

/**
 * Attaches uploads to an entity. Each asset must be the caller's own pending upload, of an
 * allowed resource type, in the right namespace (`collegeId` for college media), and really
 * stored with the declared size and type - one HEAD per asset, only here, never on reads.
 * All-or-nothing: on any failure the assets claimed so far are released again.
 */
export const claimAssets = async (
  user: AuthUser,
  rawIds: unknown,
  allowed: MediaResourceType[],
  scope: { collegeId?: string } = {}
): Promise<AttachedMedia[]> => {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : [rawIds]).map(str).filter(Boolean))];
  const claimed: AttachedMedia[] = [];
  try {
    for (const id of ids) {
      const asset = await MediaAsset.findOne({
        _id: id,
        owner: user.userId,
        status: 'pending',
        // Past its deadline the sweeper may already be deleting it.
        expiresAt: { $gt: new Date() },
        ...(scope.collegeId ? { collegeId: scope.collegeId } : { collegeId: { $exists: false } }),
      }).lean();
      if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Upload not found');
      if (!allowed.includes(asset.resourceType)) throw new ApiError(400, 'VALIDATION_ERROR', 'This upload cannot be used here.');

      const head = await getStorageService().headObject(asset.objectKey);
      if (!head) throw new ApiError(400, 'MEDIA_NOT_UPLOADED', 'The file has not finished uploading. Please try again.');
      if (head.size !== asset.size || (head.contentType && head.contentType !== asset.contentType)) {
        logMedia('upload_mismatch', { userId: user.userId, assetId: asset._id, resourceType: asset.resourceType });
        throw new ApiError(400, 'MEDIA_NOT_UPLOADED', 'The uploaded file does not match. Please upload it again.');
      }

      // Conditional update: two requests cannot attach the same upload.
      const result = await MediaAsset.updateOne(
        { _id: id, status: 'pending', expiresAt: { $gt: new Date() } },
        { $set: { status: 'attached' }, $unset: { expiresAt: 1 } }
      );
      if (result.modifiedCount === 0) throw new ApiError(404, 'NOT_FOUND', 'Upload not found');
      claimed.push({ assetId: asset._id, objectKey: asset.objectKey, kind: asset.kind });
    }
    return claimed;
  } catch (error) {
    await unclaimAssets(claimed.map((m) => m.assetId));
    throw error;
  }
};
