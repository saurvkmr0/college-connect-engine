import mongoose, { Schema, Types } from 'mongoose';

/**
 * A file in the private chat bucket. One stored object can be used by many messages (forwards);
 * `refCount` counts the non-deleted messages using it and decides when the object is deleted.
 */
export type ChatFileKind = 'image' | 'video' | 'document';

export interface IChatMedia {
  _id: string;
  owner: Types.ObjectId;
  objectKey: string;
  kind: ChatFileKind;
  contentType: string;
  size: number;
  name: string;
  /** pending: upload URL issued. attached: used by >= 1 message. orphaned: delete failed, sweeper retries. */
  status: 'pending' | 'attached' | 'orphaned';
  refCount: number;
  expiresAt?: Date;
  createdAt: Date;
}

const chatMediaSchema = new Schema<IChatMedia>(
  {
    _id: { type: String },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    objectKey: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['image', 'video', 'document'], required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    name: { type: String, required: true, maxlength: 120 },
    status: { type: String, enum: ['pending', 'attached', 'orphaned'], default: 'pending' },
    refCount: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);
// The sweeper: expired pending uploads and orphaned objects.
chatMediaSchema.index({ status: 1, expiresAt: 1 });

export const ChatMedia = mongoose.model<IChatMedia>('ChatMedia', chatMediaSchema, 'chat_media');
