import mongoose, { Schema, Types } from 'mongoose';
import { MediaKind, MediaResourceType, MEDIA_RULES } from './media.constants';

export type MediaStatus = 'pending' | 'attached' | 'orphaned';

/**
 * One uploaded (or about-to-be-uploaded) object. The object key is the canonical reference;
 * public URLs are derived from it. Provider-independent: nothing here knows about R2.
 */
export interface IMediaAsset {
  /** assetId - the UUID that is also part of the object key. */
  _id: string;
  owner: Types.ObjectId;
  objectKey: string;
  resourceType: MediaResourceType;
  kind: MediaKind;
  contentType: string;
  /** Declared size; the signed URL only accepts exactly this many bytes. */
  size: number;
  collegeId?: Types.ObjectId;
  /** pending: URL issued, not used yet. attached: referenced by a profile/post/college. orphaned: delete failed, retry. */
  status: MediaStatus;
  /** Pending uploads are swept after this. */
  expiresAt?: Date;
  createdAt: Date;
}

const mediaAssetSchema = new Schema<IMediaAsset>(
  {
    _id: { type: String },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    objectKey: { type: String, required: true, unique: true },
    resourceType: { type: String, enum: Object.keys(MEDIA_RULES), required: true },
    kind: { type: String, enum: ['image', 'video'], required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    collegeId: { type: Schema.Types.ObjectId, ref: 'College' },
    status: { type: String, enum: ['pending', 'attached', 'orphaned'], default: 'pending' },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

// The sweeper's query: expired pending uploads and orphaned objects.
mediaAssetSchema.index({ status: 1, expiresAt: 1 });

export const MediaAsset = mongoose.model<IMediaAsset>('MediaAsset', mediaAssetSchema);
