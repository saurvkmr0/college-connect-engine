import mongoose, { Schema } from 'mongoose';
import { ITag } from '../../types';

const tagSchema = new Schema<ITag>(
  {
    name: { type: String, required: true, unique: true, lowercase: true, trim: true },
    postCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Trending tags.
tagSchema.index({ postCount: -1 });

export const Tag = mongoose.model<ITag>('Tag', tagSchema);
