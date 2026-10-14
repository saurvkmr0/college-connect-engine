import { Types } from 'mongoose';
import { AuthUser } from '../../types';
import { ApiError } from '../../utils/apiError';
import { str } from '../../utils/request';
import { CHAT_LIMITS } from './chat.constants';
import { emitToUsers } from './chat.events';
import { ChatStar, Conversation, ConversationMember, IMessage, Message } from './chat.model';
import { oid, postSystemMessage, requireMember, requireMessage, visibleTo, withSenders, withStars } from './chat.service';

/** Pins, stars, shared media/docs/links, and clear / delete chat. Membership is checked first, always. */

const MAX_PINS = 3;

const members = (conversationId: Types.ObjectId) => ConversationMember.distinct('userId', { conversationId });

/** Pin and star apply to live text messages (not system lines, not deleted). */
const requireLiveText = (message: IMessage) => {
  if (message.type !== 'text' || message.deletedAt) throw new ApiError(400, 'VALIDATION_ERROR', 'This message cannot be pinned or starred.');
};

/** DMs: either person. Groups: admins. A 4th pin pushes out the oldest. */
export const pinMessage = async (user: AuthUser, rawMessageId: unknown) => {
  const { message, conversation, member } = await requireMessage(user, rawMessageId);
  requireLiveText(message);
  if (conversation.type === 'group' && member.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only admins can pin messages.');
  const pin = { messageId: message._id, pinnedBy: new Types.ObjectId(user.userId), pinnedAt: new Date() };
  const { modifiedCount } = await Conversation.updateOne(
    { _id: conversation._id, 'pins.messageId': { $ne: message._id } },
    { $push: { pins: { $each: [pin], $slice: -MAX_PINS } } }
  );
  if (modifiedCount) {
    await postSystemMessage(conversation, user.userId, { event: 'pinned' });
    emitToUsers(await members(conversation._id), 'conversation:updated', { conversationId: conversation._id });
  }
  return { pinned: true };
};

export const unpinMessage = async (user: AuthUser, rawMessageId: unknown) => {
  const { message, conversation, member } = await requireMessage(user, rawMessageId);
  if (conversation.type === 'group' && member.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only admins can unpin messages.');
  const { modifiedCount } = await Conversation.updateOne({ _id: conversation._id }, { $pull: { pins: { messageId: message._id } } });
  if (modifiedCount) emitToUsers(await members(conversation._id), 'conversation:updated', { conversationId: conversation._id });
  return { pinned: false };
};

/** Private: only I see my stars. Starring twice is harmless. */
export const starMessage = async (user: AuthUser, rawMessageId: unknown) => {
  const { message } = await requireMessage(user, rawMessageId);
  requireLiveText(message);
  await ChatStar.updateOne(
    { userId: user.userId, messageId: message._id },
    { $setOnInsert: { conversationId: message.conversationId, createdAt: new Date() } },
    { upsert: true }
  ).catch((error) => {
    if ((error as { code?: number }).code !== 11000) throw error; // a double tap raced: already starred
  });
  return { starred: true };
};

export const unstarMessage = async (user: AuthUser, rawMessageId: unknown) => {
  const messageId = oid(rawMessageId);
  if (!messageId) throw new ApiError(404, 'NOT_FOUND', 'Message not found');
  await ChatStar.deleteOne({ userId: user.userId, messageId });
  return { starred: false };
};

/** My starred messages in one chat, most recently starred first; `before` = the last star's id. */
export const listStarred = async (user: AuthUser, rawConversationId: unknown, rawBefore: unknown) => {
  const { conversation } = await requireMember(user, rawConversationId);
  const before = oid(rawBefore);
  const stars = await ChatStar.find({ userId: user.userId, conversationId: conversation._id, ...(before && { _id: { $lt: before } }) })
    .sort({ _id: -1 })
    .limit(CHAT_LIMITS.pageSize + 1)
    .lean();
  const page = stars.slice(0, CHAT_LIMITS.pageSize);
  const rows = await Message.find({ _id: { $in: page.map((s) => s.messageId) }, deletedAt: { $exists: false } }).lean();
  const dtos = await withSenders(rows);
  const messages = page
    .map((s) => dtos.find((m) => String(m._id) === String(s.messageId)))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({ ...m, starred: true }));
  const hasMore = stars.length > CHAT_LIMITS.pageSize;
  return { messages, hasMore, nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
};

const SHARED: Record<string, object> = {
  media: { 'attachments.kind': { $in: ['image', 'video'] } },
  docs: { 'attachments.kind': 'document' },
  links: { text: { $regex: 'https?://' } },
};

/** Media / docs / links in a chat, newest first (30 per page), within what I can see. */
export const listShared = async (user: AuthUser, rawConversationId: unknown, rawKind: unknown, rawBefore: unknown) => {
  const filter = SHARED[str(rawKind)];
  if (!filter) throw new ApiError(400, 'VALIDATION_ERROR', 'kind must be media, docs or links.');
  const { conversation, member } = await requireMember(user, rawConversationId);
  // ponytail: scans this chat's messages for the kind; add a per-kind flag + index if chats get huge.
  const rows = await Message.find({
    conversationId: conversation._id,
    type: 'text',
    deletedAt: { $exists: false },
    ...visibleTo(member, oid(rawBefore)),
    ...filter,
  })
    .sort({ _id: -1 })
    .limit(CHAT_LIMITS.pageSize + 1)
    .lean();
  const page = rows.slice(0, CHAT_LIMITS.pageSize);
  return { messages: await withStars(user, await withSenders(page)), hasMore: rows.length > CHAT_LIMITS.pageSize };
};

/** "Clear chat": for me only. Unread goes to 0 and my stars in this chat are removed. */
export const clearConversation = async (user: AuthUser, rawConversationId: unknown, extra: { hidden?: true } = {}) => {
  const { conversation, member } = await requireMember(user, rawConversationId);
  const newest = await Message.findOne({ conversationId: conversation._id }).sort({ _id: -1 }).select('_id').lean();
  await Promise.all([
    ConversationMember.updateOne(
      { _id: member._id },
      { $set: { unreadCount: 0, ...(newest && { clearedBefore: newest._id, lastReadMessageId: newest._id }), ...extra } }
    ),
    ChatStar.deleteMany({ userId: user.userId, conversationId: conversation._id }),
  ]);
  // My other devices reload this chat and the badges.
  emitToUsers([user.userId], 'conversation:cleared', { conversationId: conversation._id, hidden: Boolean(extra.hidden) });
  return { cleared: true };
};

/** "Delete chat" (DMs only): cleared, and off my list until a new message or until I open it again. */
export const hideConversation = async (user: AuthUser, rawConversationId: unknown) => {
  const { conversation } = await requireMember(user, rawConversationId);
  if (conversation.type !== 'direct') throw new ApiError(400, 'VALIDATION_ERROR', 'Only direct chats can be deleted. Leave the group instead.');
  return clearConversation(user, conversation._id, { hidden: true });
};
