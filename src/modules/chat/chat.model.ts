import mongoose, { Schema, Types } from 'mongoose';

/** Chat collections. Rules live in chat.service.ts; who-may-do-what in chat.policy.ts. */

export type ConversationType = 'direct' | 'group';
export type GroupVisibility = 'open' | 'closed';
export type MemberRole = 'admin' | 'member';
export type SystemEvent = 'created' | 'joined' | 'left' | 'removed' | 'renamed' | 'promoted' | 'demoted';

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
}

const memberSchema = new Schema<IConversationMember>({
  conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['admin', 'member'], default: 'member' },
  joinedAt: { type: Date, default: Date.now },
  lastReadMessageId: { type: Schema.Types.ObjectId },
  unreadCount: { type: Number, default: 0 },
  lastMessageAt: { type: Date, default: Date.now },
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
  /** Reserved for the attachments part; always [] for now. */
  attachments: unknown[];
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
      event: { type: String, enum: ['created', 'joined', 'left', 'removed', 'renamed', 'promoted', 'demoted'] },
      actor: Schema.Types.ObjectId,
      target: Schema.Types.ObjectId,
      name: String,
    },
    attachments: { type: [Schema.Types.Mixed], default: [] },
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);
// History: newest first, cursor = _id.
messageSchema.index({ conversationId: 1, _id: -1 });
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
export const GroupInviteLink = mongoose.model<IGroupInviteLink>('GroupInviteLink', inviteLinkSchema, 'group_invite_links');
