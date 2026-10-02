import mongoose, { Schema } from 'mongoose';
import { IComment } from '../../types';

const commentSchema = new Schema<IComment>(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    post: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    content: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

// Comments of a post, newest first.
commentSchema.index({ post: 1, createdAt: -1 });

export const Comment = mongoose.model<IComment>('Comment', commentSchema);
