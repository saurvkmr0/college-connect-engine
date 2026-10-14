import mongoose, { Schema, Types } from 'mongoose';

/** Chat collections. Rules live in chat.service.ts; who-may-do-what in chat.policy.ts. */

export type ConversationType = 'direct' | 'group';
export type GroupVisibility = 'open' | 'closed';
export type MemberRole = 'admin' | 'member';
export type SystemEvent = 'created' | 'joined' | 'left' | 'removed' | 'renamed' | 'promoted' | 'demoted' | 'pinned';

export interface IConversation {
  _id: Types.ObjectId;
  type: ConversationType;
  name?: string;
  college?: Types.ObjectId;
  visibility?: GroupVisibility;
  allowFaculty?: boolean;
  memberCount: number;
  /** Direct only: the two user ids sorted, "a:b". Unique, so a pair has one conversation. */
  directKey?: string;
  lastMessage?: { _id: Types.ObjectId; sender: Types.ObjectId; senderName: string; preview: string; type: string; createdAt: Date };
  /** Group photo: public object key (like avatars); the JSON replacer turns it into a URL. */
  photo?: string;
  /** Pinned messages, oldest first, at most 3 (shared by everyone in the chat). */
  pins?: { messageId: Types.ObjectId; pinnedBy: Types.ObjectId; pinnedAt: Date }[];
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IConversation>(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    name: { type: String, trim: true, maxlength: 80 },
    college: { type: Schema.Types.ObjectId, ref: 'College' },
    visibility: { type: String, enum: ['open', 'closed'] },
    allowFaculty: { type: Boolean },
    memberCount: { type: Number, default: 0 },
    directKey: { type: String },
    lastMessage: {
      _id: Schema.Types.ObjectId,
      sender: Schema.Types.ObjectId,
      senderName: String,
      preview: String,
      type: { type: String },
      createdAt: Date,
    },
    archivedAt: { type: Date },
    photo: { type: String },
    pins: { type: [{ _id: false, messageId: Schema.Types.ObjectId, pinnedBy: Schema.Types.ObjectId, pinnedAt: Date }], default: undefined },
  },
  { timestamps: true }
);
conversationSchema.index({ directKey: 1 }, { unique: true, partialFilterExpression: { directKey: { $type: 'string' } } });
// Open-group search within a college.
conversationSchema.index({ college: 1, visibility: 1, name: 1 });

export interface IConversationMember {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  role: MemberRole;
  joinedAt: Date;
  lastReadMessageId?: Types.ObjectId;
  unreadCount: number;
  /** Copied from the conversation on every message, so "my chats, newest first" is one index. */
  lastMessageAt: Date;
  /** "Clear chat": I only see messages newer than this one. */
  clearedBefore?: Types.ObjectId;
  /** "Delete chat" (DMs): off my list until the next message. */
  hidden?: boolean;
}

const memberSchema = new Schema<IConversationMember>({
  conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['admin', 'member'], default: 'member' },
  joinedAt: { type: Date, default: Date.now },
  lastReadMessageId: { type: Schema.Types.ObjectId },
  unreadCount: { type: Number, default: 0 },
  lastMessageAt: { type: Date, default: Date.now },
  clearedBefore: { type: Schema.Types.ObjectId },
  hidden: { type: Boolean },
});
memberSchema.index({ conversationId: 1, userId: 1 }, { unique: true });
memberSchema.index({ userId: 1, lastMessageAt: -1, _id: -1 });

export interface IMessage {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  clientMessageId?: string;
  type: 'text' | 'system';
  text: string;
  system?: { event: SystemEvent; actor?: Types.ObjectId; target?: Types.ObjectId; name?: string };
  /** Files in the private bucket (metadata only; links come from /chat/media/links). */
  attachments: { mediaId: string; kind: 'image' | 'video' | 'document'; contentType: string; size: number; name: string }[];
  /** A copy made by "Forward" (the original sender is not shown). */
  forwarded?: boolean;
  /** The message this one replies to (same conversation). Resolved to a quote when read. */
  replyTo?: Types.ObjectId;
  editedAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    clientMessageId: { type: String, maxlength: 64 },
    type: { type: String, enum: ['text', 'system'], default: 'text' },
    text: { type: String, default: '', maxlength: 4000 },
    system: {
      event: { type: String, enum: ['created', 'joined', 'left', 'removed', 'renamed', 'promoted', 'demoted', 'pinned'] },
      actor: Schema.Types.ObjectId,
      target: Schema.Types.ObjectId,
      name: String,
    },
    attachments: {
      type: [
        {
          _id: false,
          mediaId: { type: String, required: true },
          kind: { type: String, enum: ['image', 'video', 'document'], required: true },
          contentType: { type: String, required: true },
          size: { type: Number, required: true },
          name: { type: String, required: true },
        },
      ],
      default: [],
    },
    forwarded: { type: Boolean },
    replyTo: { type: Schema.Types.ObjectId },
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);
// History: newest first, cursor = _id.
messageSchema.index({ conversationId: 1, _id: -1 });
// Download-link checks: which messages use a file.
messageSchema.index({ 'attachments.mediaId': 1 });
// A retried send (same client id) maps to the original message.
messageSchema.index(
  { conversationId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } }
);

export interface IGroupRequest {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  kind: 'request' | 'invite';
  invitedBy?: Types.ObjectId;
  status: 'pending' | 'accepted' | 'declined' | 'approved' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
}

const groupRequestSchema = new Schema<IGroupRequest>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['request', 'invite'], required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'approved', 'rejected'], default: 'pending' },
  },
  { timestamps: true }
);
// One open invite/request per person per group.
groupRequestSchema.index({ conversationId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
groupRequestSchema.index({ userId: 1, status: 1 });

export interface IGroupInviteLink {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  tokenHash: string;
  createdBy: Types.ObjectId;
  expiresAt: Date;
}

const inviteLinkSchema = new Schema<IGroupInviteLink>({
  conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
  tokenHash: { type: String, required: true, unique: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
});
// MongoDB deletes expired links itself (the service also checks expiresAt, TTL runs once a minute).
inviteLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Conversation = mongoose.model<IConversation>('Conversation', conversationSchema);
export const ConversationMember = mongoose.model<IConversationMember>('ConversationMember', memberSchema, 'conversation_members');
export const Message = mongoose.model<IMessage>('Message', messageSchema);
export const GroupRequest = mongoose.model<IGroupRequest>('GroupRequest', groupRequestSchema, 'group_requests');
/** Private bookmarks ("star"): one row per user and message. */
export interface IChatStar {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  createdAt: Date;
}
const starSchema = new Schema<IChatStar>({
  userId: { type: Schema.Types.ObjectId, required: true },
  messageId: { type: Schema.Types.ObjectId, required: true },
  conversationId: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now },
});
starSchema.index({ userId: 1, messageId: 1 }, { unique: true });
starSchema.index({ userId: 1, conversationId: 1, _id: -1 });
starSchema.index({ messageId: 1 });
export const ChatStar = mongoose.model<IChatStar>('ChatStar', starSchema, 'chat_stars');

export const GroupInviteLink = mongoose.model<IGroupInviteLink>('GroupInviteLink', inviteLinkSchema, 'group_invite_links');
