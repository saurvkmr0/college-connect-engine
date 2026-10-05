import mongoose, { Schema } from 'mongoose';
import { IPost, PostType } from '../../types';
import { MAX_POST_MEDIA } from '../media/media.constants';

export const MAX_TAGS = 10;
export const MAX_IMAGES = 4;

const maxItems = (max: number, label: string) => ({
  validator: (items: unknown[]) => items.length <= max,
  message: `At most ${max} ${label} allowed`,
});

const postSchema = new Schema<IPost>(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    college: { type: Schema.Types.ObjectId, ref: 'College', required: true },
    type: {
      type: String,
      enum: Object.values(PostType),
      required: true,
    },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    images: { type: [{ type: String, trim: true, maxlength: 500 }], validate: maxItems(MAX_IMAGES, 'images') },
    // Uploaded media (object keys; URLs are derived on output). Up to 4, any mix of images/videos.
    media: {
      type: [
        {
          _id: false,
          objectKey: { type: String, required: true },
          kind: { type: String, enum: ['image', 'video'], required: true },
        },
      ],
      validate: maxItems(MAX_POST_MEDIA, 'media items'),
    },
    tags: {
      type: [{ type: String, lowercase: true, trim: true, maxlength: 30 }],
      validate: maxItems(MAX_TAGS, 'tags'),
    },
    // ponytail: embedded id arrays keep reads simple; switch to counters + a
    // Reaction collection when a post can collect tens of thousands of likes.
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    upvotes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    comments: [{ type: Schema.Types.ObjectId, ref: 'Comment' }],
  },
  { timestamps: true }
);

postSchema.index({ type: 1, createdAt: -1 }); // explore / unverified global feed
postSchema.index({ college: 1, type: 1, createdAt: -1 }); // college feed, own-college branch of global feed
postSchema.index({ author: 1, type: 1, createdAt: -1 }); // "people I follow" branch of global feed
postSchema.index({ tags: 1 }); // tag filter

export const Post = mongoose.model<IPost>('Post', postSchema);
