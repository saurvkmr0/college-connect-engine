import mongoose, { Schema } from 'mongoose';
import { IPost, PostType } from '../types';

const postSchema = new Schema<IPost>(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    college: { type: Schema.Types.ObjectId, ref: 'College', required: true },
    type: {
      type: String,
      enum: Object.values(PostType),
      required: true,
    },
    content: { type: String, required: true, maxlength: 2000 },
    images: [{ type: String }],
    tags: [{ type: String, lowercase: true, trim: true }],
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    upvotes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    comments: [{ type: Schema.Types.ObjectId, ref: 'Comment' }],
  },
  { timestamps: true }
);

postSchema.index({ type: 1, createdAt: -1 });
postSchema.index({ college: 1, type: 1, createdAt: -1 });
postSchema.index({ tags: 1 });

export const Post = mongoose.model<IPost>('Post', postSchema);
