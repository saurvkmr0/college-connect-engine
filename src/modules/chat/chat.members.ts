import { Types } from 'mongoose';
import { redisClient } from '../../config/redis';
import { ConversationMember } from './chat.model';

/**
 * Short-lived member-id cache for high-frequency, low-stakes events (typing). Messages never use
 * it: sends always check membership in MongoDB. Invalidated on every membership change.
 */
const TTL_SECONDS = 30;
const key = (conversationId: string) => `chat:members:${conversationId}`;

export const cachedMemberIds = async (conversationId: string): Promise<string[]> => {
  if (redisClient.isReady) {
    const hit = await redisClient.get(key(conversationId)).catch(() => null);
    if (hit) return JSON.parse(hit) as string[];
  }
  const ids = (await ConversationMember.distinct('userId', { conversationId: new Types.ObjectId(conversationId) })).map(String);
  if (redisClient.isReady) await redisClient.set(key(conversationId), JSON.stringify(ids), { EX: TTL_SECONDS }).catch(() => undefined);
  return ids;
};

export const forgetMembers = async (conversationId: Types.ObjectId | string): Promise<void> => {
  if (redisClient.isReady) await redisClient.del(key(String(conversationId))).catch(() => undefined);
};
