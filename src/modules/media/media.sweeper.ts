import { redisClient, redisCommand } from '../../config/redis';
import { getPrivateStorageService, getStorageService } from '../../services/storage';
import { ChatMedia } from '../chat/chat.media.model';
import { MediaAsset } from './media.model';
import { logMedia } from './media.service';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'lock:media-sweeper';
const LOCK_SECONDS = 10 * 60;
const BATCH = 200;

/**
 * Deletes uploads that were never attached (pending past their deadline) and objects whose
 * earlier delete failed (orphaned). A Redis lock makes sure only one instance sweeps at a time.
 * Returns how many assets were removed, or `skipped` when another run holds the lock.
 */
export const sweepMedia = async (): Promise<{ skipped: boolean; removed: number }> => {
  const locked = await redisCommand(() => redisClient.set(LOCK_KEY, '1', { NX: true, EX: LOCK_SECONDS }));
  if (!locked) return { skipped: true, removed: 0 };

  let removed = 0;
  try {
    const due = await MediaAsset.find({
      $or: [{ status: 'pending', expiresAt: { $lt: new Date() } }, { status: 'orphaned' }],
    })
      .select('objectKey')
      .limit(BATCH)
      .lean();

    for (const asset of due) {
      // Re-check and leave `pending` atomically: if the asset was attached meanwhile, skip it.
      const claimed = await MediaAsset.findOneAndUpdate(
        { _id: asset._id, $or: [{ status: 'pending', expiresAt: { $lt: new Date() } }, { status: 'orphaned' }] },
        { $set: { status: 'orphaned' }, $unset: { expiresAt: 1 } }
      ).lean();
      if (!claimed) continue;
      try {
        await getStorageService().deleteObject(claimed.objectKey);
        await MediaAsset.deleteOne({ _id: claimed._id, status: 'orphaned' });
        removed += 1;
      } catch (error) {
        // Stays `orphaned`; the next sweep retries.
        logMedia('sweep_delete_failed', { assetId: asset._id, error: error instanceof Error ? error.name : 'unknown' });
      }
    }
    removed += await sweepChatFiles();
    if (removed > 0) logMedia('sweep_done', { removed });
    return { skipped: false, removed };
  } finally {
    await redisCommand(() => redisClient.del(LOCK_KEY)).catch(() => undefined);
  }
};

/** Same rules for private chat files: expired pending uploads and failed deletes. */
const sweepChatFiles = async (): Promise<number> => {
  const due = { $or: [{ status: 'pending', expiresAt: { $lt: new Date() } }, { status: 'orphaned' }] };
  const files = await ChatMedia.find(due).select('_id').limit(BATCH).lean();
  let removed = 0;
  for (const f of files) {
    const claimed = await ChatMedia.findOneAndUpdate({ _id: f._id, ...due }, { $set: { status: 'orphaned' }, $unset: { expiresAt: 1 } }).lean();
    if (!claimed) continue;
    try {
      await getPrivateStorageService().deleteObject(claimed.objectKey);
      await ChatMedia.deleteOne({ _id: claimed._id, status: 'orphaned' });
      removed += 1;
    } catch (error) {
      logMedia('sweep_delete_failed', { mediaId: f._id, error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  return removed;
};

/** Starts the periodic sweep (no job scheduler in this app). Errors never crash the server. */
export const startMediaSweeper = (): void => {
  setInterval(() => {
    sweepMedia().catch((error) => logMedia('sweep_failed', { error: error instanceof Error ? error.name : 'unknown' }));
  }, SWEEP_INTERVAL_MS).unref();
};
