import mongoose, { Schema } from 'mongoose';
import { IComment } from '../../types';

const commentSchema = new Schema<IComment>(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    post: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    // Set on replies only: always the top-level comment, so threads stay one level deep.
    parent: { type: Schema.Types.ObjectId, ref: 'Comment' },
    content: { type: String, required: true, trim: true, maxlength: 1000 },
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    editedAt: { type: Date },
  },
  { timestamps: true }
);

// Comments of a post, newest first.
commentSchema.index({ post: 1, createdAt: -1 });
// A thread's replies (newest first) and reply counts.
commentSchema.index({ parent: 1, createdAt: -1 });

export const Comment = mongoose.model<IComment>('Comment', commentSchema);
