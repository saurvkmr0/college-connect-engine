import { Types } from 'mongoose';
import { AuthUser } from '../../types';
import { ApiError } from '../../utils/apiError';
import { escapeRegex, str } from '../../utils/request';
import { User } from '../users/user.model';
import { CHAT_LIMITS } from './chat.constants';
import { emitToUsers } from './chat.events';
import { Conversation, ConversationMember, IConversation, IMessage, Message, SystemEvent } from './chat.model';
import { assertCanDirectMessage, verifiedCollegeOf, verifiedMembersOf } from './chat.policy';

/**
 * Every chat rule. REST controllers and socket handlers both call these functions, so a rule is
 * implemented once. Identity always comes from the authenticated user, never from the payload.
 */

const SENDER_FIELDS = 'name avatar';
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Conversation not found');
/** Client strings (via str(), so `{ $ne: ... }` objects are rejected) or our own stored ObjectIds. */
export const oid = (id: unknown): Types.ObjectId | null => {
  if (id instanceof Types.ObjectId) return id;
  const s = str(id);
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
};

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

/** The caller's membership and the (live) conversation, or 404 - non-members learn nothing. */
export const requireMember = async (user: AuthUser, rawConversationId: unknown) => {
  const conversationId = oid(rawConversationId);
  if (!conversationId) throw notFound();
  const [member, conversation] = await Promise.all([
    ConversationMember.findOne({ conversationId, userId: user.userId }).lean(),
    Conversation.findById(conversationId).lean(),
  ]);
  if (!member || !conversation || conversation.archivedAt) throw notFound();
  return { member, conversation };
};

const memberIdsOf = (conversationId: Types.ObjectId) => ConversationMember.distinct('userId', { conversationId });

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

/** Message as clients see it: `senderId` plus a `sender` snippet (name/avatar). */
const toDto = (m: IMessage, sender?: { _id: unknown; name?: string; avatar?: string } | null) => ({
  ...m,
  sender: sender ?? null,
});

const withSenders = async (messages: IMessage[]) => {
  const ids = [...new Set(messages.map((m) => String(m.senderId)))];
  const users = await User.find({ _id: { $in: ids } }).select(SENDER_FIELDS).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return messages.map((m) => toDto(m, byId.get(String(m.senderId))));
};

/**
 * After a message is saved: unread +1 for everyone but the sender (system messages leave unread
 * alone), the chat list order, the preview, then one event to every member's devices.
 */
const publishNew = async (conversation: IConversation, message: IMessage, senderName: string) => {
  const conversationId = conversation._id;
  const at = message.createdAt;
  await Promise.all([
    ConversationMember.updateMany(
      { conversationId, userId: { $ne: message.senderId } },
      { $set: { lastMessageAt: at }, ...(message.type === 'text' && { $inc: { unreadCount: 1 } }) }
    ),
    ConversationMember.updateOne(
      { conversationId, userId: message.senderId },
      { $set: { lastMessageAt: at, lastReadMessageId: message._id, unreadCount: 0 } }
    ),
    Conversation.updateOne(
      { _id: conversationId },
      {
        $set: {
          lastMessage: {
            _id: message._id,
            sender: message.senderId,
            senderName,
            preview: message.text.slice(0, CHAT_LIMITS.previewChars),
            type: message.type,
            createdAt: at,
          },
        },
      }
    ),
  ]);
  const [dto] = await withSenders([message]);
  emitToUsers(await memberIdsOf(conversationId), 'message:new', {
    conversationId,
    message: dto,
    conversation: { _id: conversationId, type: conversation.type, name: conversation.name },
  });
  return dto;
};

const readText = (raw: unknown): string => {
  const text = str(raw);
  if (!text) throw new ApiError(400, 'VALIDATION_ERROR', 'Message text is required.');
  if (text.length > CHAT_LIMITS.messageMaxChars) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Messages can be at most ${CHAT_LIMITS.messageMaxChars} characters.`);
  }
  return text;
};

/**
 * Saves a text message (durable before the caller acks), then publishes it. A retry with the same
 * clientMessageId returns the original message and publishes nothing new.
 */
export const sendMessage = async (user: AuthUser, rawConversationId: unknown, body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const text = readText(input.text);
  const clientMessageId = str(input.clientMessageId);
  if (clientMessageId.length > 64) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid clientMessageId.');

  const { conversation } = await requireMember(user, rawConversationId);
  const key = { conversationId: conversation._id, senderId: new Types.ObjectId(user.userId), clientMessageId };
  const existing = async () => {
    const found = clientMessageId ? await Message.findOne(key).lean() : null;
    return found ? (await withSenders([found]))[0] : null;
  };

  const duplicate = await existing();
  if (duplicate) return duplicate;
  let message: IMessage;
  try {
    message = (await Message.create({ ...key, clientMessageId: clientMessageId || undefined, text })).toObject();
  } catch (error) {
    // Two retries raced: the unique index let one through; return that one.
    if ((error as { code?: number }).code === 11000) {
      const winner = await existing();
      if (winner) return winner;
    }
    throw error;
  }
  const me = await User.findById(user.userId).select('name').lean();
  return publishNew(conversation, message, me?.name ?? '');
};

/** System line (joined, left, renamed...) in a group, written by the actor. */
export const postSystemMessage = async (
  conversation: IConversation,
  actorId: string,
  system: { event: SystemEvent; target?: string; name?: string }
) => {
  const message = (
    await Message.create({
      conversationId: conversation._id,
      senderId: actorId,
      type: 'system',
      system: { ...system, actor: actorId },
    })
  ).toObject();
  const actor = await User.findById(actorId).select('name').lean();
  return publishNew(conversation, message, actor?.name ?? '');
};

/** History, newest first, 30 per page; `before` = the oldest message id the client has. */
export const listMessages = async (user: AuthUser, rawConversationId: unknown, rawBefore: unknown) => {
  const { conversation } = await requireMember(user, rawConversationId);
  const before = oid(rawBefore);
  const rows = await Message.find({ conversationId: conversation._id, ...(before && { _id: { $lt: before } }) })
    .sort({ _id: -1 })
    .limit(CHAT_LIMITS.pageSize + 1)
    .lean();
  return {
    messages: await withSenders(rows.slice(0, CHAT_LIMITS.pageSize)),
    hasMore: rows.length > CHAT_LIMITS.pageSize,
  };
};

/** Finds a message the caller can act on (they must still be a member of its conversation). */
const requireMessage = async (user: AuthUser, rawMessageId: unknown) => {
  const messageId = oid(rawMessageId);
  const message = messageId ? await Message.findById(messageId).lean() : null;
  if (!message) throw new ApiError(404, 'NOT_FOUND', 'Message not found');
  const access = await requireMember(user, message.conversationId);
  return { message, ...access };
};

/** Keeps the chat-list preview in step when the latest message changes. */
const refreshPreview = async (conversation: IConversation, message: IMessage) => {
  if (String(conversation.lastMessage?._id) !== String(message._id)) return;
  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { 'lastMessage.preview': message.deletedAt ? '' : message.text.slice(0, CHAT_LIMITS.previewChars) } }
  );
};

const publishUpdate = async (conversation: IConversation, message: IMessage) => {
  await refreshPreview(conversation, message);
  const [dto] = await withSenders([message]);
  emitToUsers(await memberIdsOf(conversation._id), 'message:updated', { conversationId: conversation._id, message: dto });
  return dto;
};

/** Own text message, within 15 minutes, not deleted. */
export const editMessage = async (user: AuthUser, rawMessageId: unknown, rawText: unknown) => {
  const text = readText(rawText);
  const { message, conversation } = await requireMessage(user, rawMessageId);
  if (String(message.senderId) !== user.userId || message.type !== 'text' || message.deletedAt) {
    throw new ApiError(403, 'FORBIDDEN', 'You can only edit your own messages.');
  }
  if (Date.now() - new Date(message.createdAt).getTime() > CHAT_LIMITS.editWindowMs) {
    throw new ApiError(403, 'FORBIDDEN', 'Messages can only be edited within 15 minutes.');
  }
  const updated = await Message.findByIdAndUpdate(message._id, { $set: { text, editedAt: new Date() } }, { new: true }).lean();
  return publishUpdate(conversation, updated!);
};

/** Own message, or any message for a group admin. The text is cleared; the row stays as "deleted". */
export const deleteMessage = async (user: AuthUser, rawMessageId: unknown) => {
  const { message, conversation, member } = await requireMessage(user, rawMessageId);
  const own = String(message.senderId) === user.userId;
  const groupAdmin = conversation.type === 'group' && member.role === 'admin';
  if (message.type !== 'text' || !(own || groupAdmin)) throw new ApiError(403, 'FORBIDDEN', 'You cannot delete this message.');
  if (message.deletedAt) return (await withSenders([message]))[0];
  const updated = await Message.findByIdAndUpdate(message._id, { $set: { text: '', deletedAt: new Date() } }, { new: true }).lean();
  return publishUpdate(conversation, updated!);
};

/**
 * Read up to (and including) `messageId`. Unread becomes the number of others' messages after it.
 * DMs tell the other side (✓✓); every member's own devices update their badge.
 */
export const markRead = async (user: AuthUser, rawConversationId: unknown, rawMessageId: unknown) => {
  const { conversation, member } = await requireMember(user, rawConversationId);
  const messageId = oid(rawMessageId);
  if (!messageId || !(await Message.exists({ _id: messageId, conversationId: conversation._id }))) {
    throw new ApiError(404, 'NOT_FOUND', 'Message not found');
  }
  // Never move the read cursor backwards.
  if (member.lastReadMessageId && String(member.lastReadMessageId) >= String(messageId)) return { unreadCount: member.unreadCount };
  const unreadCount = await Message.countDocuments({
    conversationId: conversation._id,
    _id: { $gt: messageId },
    senderId: { $ne: new Types.ObjectId(user.userId) },
    type: 'text',
  });
  await ConversationMember.updateOne({ _id: member._id }, { $set: { lastReadMessageId: messageId, unreadCount } });
  const audience = conversation.type === 'direct' ? await memberIdsOf(conversation._id) : [user.userId];
  emitToUsers(audience, 'conversation:read', { conversationId: conversation._id, userId: user.userId, messageId });
  return { unreadCount };
};

export const unreadTotal = async (user: AuthUser): Promise<number> => {
  const [row] = await ConversationMember.aggregate<{ total: number }>([
    { $match: { userId: new Types.ObjectId(user.userId), unreadCount: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$unreadCount' } } },
  ]);
  return row?.total ?? 0;
};

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

const PUBLIC_PERSON = { name: 1, avatar: 1, role: 1 };

/** Start (or get) the DM with another user. Atomic: concurrent calls end in one conversation. */
export const startDirect = async (user: AuthUser, rawUserId: unknown) => {
  const otherId = str(rawUserId);
  await assertCanDirectMessage(user, otherId);
  const directKey = [user.userId, otherId].sort().join(':');
  let conversation: IConversation | null;
  try {
    conversation = await Conversation.findOneAndUpdate(
      { directKey },
      { $setOnInsert: { type: 'direct', directKey, memberCount: 2 } },
      { upsert: true, new: true }
    ).lean();
  } catch (error) {
    // Two upserts raced on the unique key: the other one created it.
    if ((error as { code?: number }).code !== 11000) throw error;
    conversation = await Conversation.findOne({ directKey }).lean();
  }
  const now = new Date();
  await ConversationMember.bulkWrite(
    [user.userId, otherId].map((userId) => ({
      updateOne: {
        filter: { conversationId: conversation!._id, userId: new Types.ObjectId(userId) },
        update: { $setOnInsert: { role: 'member', joinedAt: now, lastMessageAt: now, unreadCount: 0 } },
        upsert: true,
      },
    })),
    { ordered: false }
  ).catch((error) => {
    if ((error as { code?: number }).code !== 11000) throw error;
  });
  return conversation!;
};

/**
 * My chats, newest activity first (30 per page, `before` = lastMessageAt of the last row).
 * One aggregation: no per-row queries. DMs appear once they have a message.
 */
export const listConversations = async (user: AuthUser, query: { cursor?: unknown; type?: unknown }) => {
  const me = new Types.ObjectId(user.userId);
  // Cursor "<lastMessageAt ISO>|<member row id>": ties on the timestamp are broken by id, so no row
  // is skipped or repeated at a page boundary.
  const [at, rowId] = str(query.cursor).split('|');
  const atDate = new Date(at ?? '');
  const after = !Number.isNaN(atDate.getTime()) && Types.ObjectId.isValid(rowId ?? '') ? { atDate, rowId: new Types.ObjectId(rowId) } : null;
  const type = str(query.type);
  const rows = await ConversationMember.aggregate([
    {
      $match: {
        userId: me,
        ...(after && { $or: [{ lastMessageAt: { $lt: after.atDate } }, { lastMessageAt: after.atDate, _id: { $lt: after.rowId } }] }),
      },
    },
    { $sort: { lastMessageAt: -1, _id: -1 } },
    { $lookup: { from: Conversation.collection.name, localField: 'conversationId', foreignField: '_id', as: 'c' } },
    { $unwind: '$c' },
    {
      $match: {
        'c.archivedAt': { $exists: false },
        ...(type === 'direct' || type === 'group' ? { 'c.type': type } : {}),
        $or: [{ 'c.type': 'group' }, { 'c.lastMessage': { $exists: true } }],
      },
    },
    { $limit: CHAT_LIMITS.pageSize + 1 },
    // DMs: the other person.
    {
      $lookup: {
        from: ConversationMember.collection.name,
        let: { cid: '$conversationId' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$conversationId', '$$cid'] }, { $ne: ['$userId', me] }] } } },
          { $limit: 1 },
          { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', pipeline: [{ $project: PUBLIC_PERSON }], as: 'u' } },
          { $unwind: '$u' },
          { $replaceWith: '$u' },
        ],
        as: 'other',
      },
    },
    {
      $project: {
        _id: '$c._id',
        type: '$c.type',
        name: '$c.name',
        visibility: '$c.visibility',
        memberCount: '$c.memberCount',
        lastMessage: '$c.lastMessage',
        lastMessageAt: 1,
        unreadCount: 1,
        role: 1,
        rowId: '$_id',
        other: { $cond: [{ $eq: ['$c.type', 'direct'] }, { $first: '$other' }, '$$REMOVE'] },
      },
    },
  ]);
  const page = rows.slice(0, CHAT_LIMITS.pageSize);
  const hasMore = rows.length > CHAT_LIMITS.pageSize;
  const last = page[page.length - 1];
  return {
    conversations: page.map(({ rowId: _, ...row }) => row),
    hasMore,
    nextCursor: hasMore && last ? `${new Date(last.lastMessageAt).toISOString()}|${last.rowId}` : null,
  };
};

/** Details: my role; DMs the other person; groups the members (max 100) with roles. */
export const getConversation = async (user: AuthUser, rawConversationId: unknown) => {
  const { conversation, member } = await requireMember(user, rawConversationId);
  const members = await ConversationMember.find({ conversationId: conversation._id }).select('userId role joinedAt lastReadMessageId').lean();
  const people = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select(PUBLIC_PERSON).lean();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const list = members
    .map((m) => ({ user: byId.get(String(m.userId)), role: m.role, joinedAt: m.joinedAt, lastReadMessageId: m.lastReadMessageId }))
    .filter((m) => m.user);
  return {
    conversation,
    role: member.role,
    members: list,
    other: conversation.type === 'direct' ? list.find((m) => String(m.user!._id) !== user.userId)?.user : undefined,
  };
};

/** People I may start a DM with (follow either way, or verified at my college), by name. */
export const searchEligible = async (user: AuthUser, rawQuery: unknown) => {
  const me = new Types.ObjectId(user.userId);
  const q = str(rawQuery).slice(0, 50);
  const myCollege = verifiedCollegeOf(user);
  // ponytail: unanchored name regex, like user search; move to a text index with the user count.
  return User.find({
    _id: { $ne: me },
    role: { $in: ['student', 'faculty', 'staff'] },
    accountVerified: { $ne: false },
    ...(q && { name: { $regex: escapeRegex(q), $options: 'i' } }),
    $or: [{ followers: me }, { following: me }, ...(myCollege ? [verifiedMembersOf(myCollege)] : [])],
  })
    .select(PUBLIC_PERSON)
    .sort({ name: 1 })
    .limit(20)
    .lean();
};
