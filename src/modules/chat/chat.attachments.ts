import { randomUUID } from 'node:crypto';
import { getPrivateStorageService } from '../../services/storage';
import { AuthUser } from '../../types';
import { ApiError } from '../../utils/apiError';
import { str } from '../../utils/request';
import { PENDING_TTL_MS, UPLOAD_URL_TTL_SECONDS } from '../media/media.constants';
import { assertUploadQuota, logMedia } from '../media/media.service';
import { ChatFileKind, ChatMedia, IChatMedia } from './chat.media.model';

/** Private chat files: upload links, claiming on send, reference counting, signed download links. */

const MB = 1024 * 1024;
export const CHAT_FILE_RULES = { image: 10 * MB, video: 50 * MB, document: 25 * MB } as const;
export const MAX_ATTACHMENTS = 10;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** Allowed MIME types -> kind and canonical extension (the key never uses the client's name). */
export const CHAT_FILE_TYPES: Record<string, { kind: ChatFileKind; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'application/pdf': { kind: 'document', ext: 'pdf' },
  'application/msword': { kind: 'document', ext: 'doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', ext: 'docx' },
  'application/vnd.ms-excel': { kind: 'document', ext: 'xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', ext: 'xlsx' },
  'application/vnd.ms-powerpoint': { kind: 'document', ext: 'ppt' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', ext: 'pptx' },
};

/** What a message stores (and clients see) per attachment - never the object key. */
export interface MessageAttachment {
  mediaId: string;
  kind: ChatFileKind;
  contentType: string;
  size: number;
  name: string;
}
export const toAttachment = (m: IChatMedia): MessageAttachment => ({
  mediaId: m._id,
  kind: m.kind,
  contentType: m.contentType,
  size: m.size,
  name: m.name,
});

/**
 * Display/download name: no path parts, control characters, or invisible/bidi characters (so
 * "invoice<RTLO>fdp.exe" cannot pose as a PDF), and it always ends in the real type's extension
 * ("invoice.exe" sent as a PDF downloads as "invoice.exe.pdf"). At most 120 characters.
 */
const sanitizeName = (raw: unknown, ext: string): string => {
  const base = str(raw).split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[\u0000-\u001f\u007f]|\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  if (!clean.toLowerCase().endsWith(`.${ext}`)) clean = `${clean || 'file'}.${ext}`;
  return clean.length > 120 ? `${clean.slice(0, 120 - ext.length - 1)}.${ext}` : clean;
};

/** Upload link for a file in a chat the caller belongs to (membership checked by the caller). */
export const createChatUpload = async (user: AuthUser, body: Record<string, unknown>) => {
  const contentType = str(body.contentType).toLowerCase();
  const type = CHAT_FILE_TYPES[contentType];
  if (!type) throw new ApiError(400, 'VALIDATION_ERROR', 'This file type cannot be sent. Use photos, videos, PDF, Word, Excel or PowerPoint.');
  const size = Number(body.fileSize);
  if (!Number.isInteger(size) || size <= 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid file size.');
  const max = CHAT_FILE_RULES[type.kind];
  if (size > max) throw new ApiError(413, 'FILE_TOO_LARGE', `File is too large (max ${max / MB} MB for ${type.kind}s).`);

  await assertUploadQuota(user.userId, size);
  const mediaId = randomUUID();
  const objectKey = `chat/${user.userId}/${mediaId}.${type.ext}`;
  const { url, expiresInSeconds } = await getPrivateStorageService().createUploadUrl({
    key: objectKey,
    contentType,
    contentLength: size,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });
  await ChatMedia.create({
    _id: mediaId,
    owner: user.userId,
    objectKey,
    kind: type.kind,
    contentType,
    size,
    name: sanitizeName(body.fileName, type.ext),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });
  logMedia('chat_upload_url_created', { userId: user.userId, mediaId, kind: type.kind, size });
  return { mediaId, uploadUrl: url, expiresInSeconds };
};

/** Deletes the object and record; a failure leaves it `orphaned` for the sweeper. */
const deleteFile = async (mediaId: string, objectKey: string) => {
  try {
    await getPrivateStorageService().deleteObject(objectKey);
    await ChatMedia.deleteOne({ _id: mediaId });
  } catch (error) {
    await ChatMedia.updateOne({ _id: mediaId }, { $set: { status: 'orphaned' } });
    logMedia('chat_delete_failed', { mediaId, error: error instanceof Error ? error.name : 'unknown' });
  }
};

export const discardChatUpload = async (user: AuthUser, rawId: unknown) => {
  const file = await ChatMedia.findOneAndUpdate(
    { _id: str(rawId), owner: user.userId, status: 'pending' },
    { $set: { status: 'orphaned' }, $unset: { expiresAt: 1 } }
  ).lean();
  if (!file) throw new ApiError(404, 'NOT_FOUND', 'Upload not found');
  await deleteFile(file._id, file.objectKey);
};

/**
 * Attaches the sender's own uploads to a new message: each must be pending, unexpired and really
 * stored with the declared size/type. Atomic per file (a file can only be claimed once) and
 * all-or-nothing (files claimed so far are released on any failure).
 */
export const claimChatMedia = async (user: AuthUser, rawIds: unknown): Promise<MessageAttachment[]> => {
  if (rawIds === undefined) return [];
  if (!Array.isArray(rawIds)) throw new ApiError(400, 'VALIDATION_ERROR', 'attachments must be a list.');
  const ids = [...new Set(rawIds.map((x) => str(x)).filter(Boolean))];
  if (ids.length > MAX_ATTACHMENTS) throw new ApiError(400, 'VALIDATION_ERROR', `At most ${MAX_ATTACHMENTS} files per message.`);
  const claimed: IChatMedia[] = [];
  try {
    for (const id of ids) {
      const file = await ChatMedia.findOne({ _id: id, owner: user.userId, status: 'pending', expiresAt: { $gt: new Date() } }).lean();
      if (!file) throw new ApiError(404, 'NOT_FOUND', 'File not found. Please upload it again.');
      const storage = getPrivateStorageService();
      const matches = (head: { size: number; contentType?: string } | null) =>
        Boolean(head && head.size === file.size && (!head.contentType || head.contentType === file.contentType));
      if (!matches(await storage.headObject(file.objectKey))) {
        throw new ApiError(400, 'MEDIA_NOT_UPLOADED', 'A file has not finished uploading. Please try again.');
      }
      // Move the bytes to a key the uploader never had an upload link for, so nobody can swap the
      // content of a sent (or forwarded) file by reusing their still-valid upload URL.
      const finalKey = `chat/${file.owner}/f-${randomUUID()}.${CHAT_FILE_TYPES[file.contentType].ext}`;
      await storage.copyObject(file.objectKey, finalKey);
      if (!matches(await storage.headObject(finalKey))) {
        await storage.deleteObject(finalKey).catch(() => undefined);
        throw new ApiError(400, 'MEDIA_NOT_UPLOADED', 'The uploaded file does not match. Please upload it again.');
      }
      const won = await ChatMedia.findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: { status: 'attached', refCount: 1, objectKey: finalKey }, $unset: { expiresAt: 1 } },
        { new: true }
      ).lean();
      if (!won) {
        await storage.deleteObject(finalKey).catch(() => undefined);
        throw new ApiError(404, 'NOT_FOUND', 'File not found. Please upload it again.');
      }
      await storage.deleteObject(file.objectKey).catch(() => undefined);
      claimed.push(won);
    }
    return claimed.map(toAttachment);
  } catch (error) {
    await unclaimChatMedia(claimed.map((m) => m._id));
    throw error;
  }
};

/** Puts files back to pending (the message was not saved) so they can be retried or swept. */
export const unclaimChatMedia = async (ids: string[]) => {
  if (!ids.length) return;
  await ChatMedia.updateMany(
    { _id: { $in: ids }, status: 'attached', refCount: 1 },
    { $set: { status: 'pending', refCount: 0, expiresAt: new Date(Date.now() + PENDING_TTL_MS) } }
  );
};

/**
 * Reserve `count` more references on each file before copies are written (forward). A file that is
 * already being deleted (refCount 0 / not attached) fails the whole reservation: everything taken
 * so far is given back and 404 is thrown, so no copy can point at a deleted file.
 */
export const reserveRefs = async (ids: string[], count: number) => {
  const taken: string[] = [];
  for (const id of ids) {
    const ok = await ChatMedia.updateOne({ _id: id, status: 'attached', refCount: { $gt: 0 } }, { $inc: { refCount: count } });
    if (!ok.modifiedCount) {
      await giveBackRefs(taken, count);
      throw new ApiError(404, 'NOT_FOUND', 'This file is no longer available.');
    }
    taken.push(id);
  }
};

/** Undo a reservation whose copies were not written (the counts stay above 0: they were > 0 before). */
export const giveBackRefs = async (ids: string[], count: number) => {
  if (ids.length) await ChatMedia.updateMany({ _id: { $in: ids } }, { $inc: { refCount: -count } });
};

/** A message using these files was deleted; the last reference deletes the object (exactly once). */
export const releaseRefs = async (ids: string[]) => {
  for (const id of ids) {
    const after = await ChatMedia.findOneAndUpdate(
      { _id: id, status: 'attached', refCount: { $gt: 0 } },
      { $inc: { refCount: -1 } },
      { new: true }
    ).lean();
    // Only the decrement that reached 0 moves on, and the status flip makes the delete one-shot.
    if (after?.refCount === 0) {
      const gone = await ChatMedia.findOneAndUpdate({ _id: id, status: 'attached', refCount: 0 }, { $set: { status: 'orphaned' } }).lean();
      if (gone) await deleteFile(gone._id, gone.objectKey);
    }
  }
};

/** Signed links for files the caller may see (ids already filtered by the caller). */
export const signLinks = async (ids: string[]) => {
  const files = await ChatMedia.find({ _id: { $in: ids }, status: 'attached' }).lean();
  const storage = getPrivateStorageService();
  const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString();
  const entries = await Promise.all(
    files.map(async (f) => [
      f._id,
      {
        url: await storage.createDownloadUrl({
          key: f.objectKey,
          expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
          filename: f.name,
          // Documents always download (Office macros never run in the app); media display inline.
          disposition: f.kind === 'document' ? 'attachment' : 'inline',
          contentType: f.contentType,
        }),
        expiresAt,
      },
    ])
  );
  return Object.fromEntries(entries) as Record<string, { url: string; expiresAt: string }>;
};

export const idsOf = (attachments: { mediaId: string }[] | undefined) => (attachments ?? []).map((a) => a.mediaId);
