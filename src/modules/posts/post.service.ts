import { Types } from 'mongoose';
import { AuthUser, PostType } from '../../types';
import { ApiError } from '../../utils/apiError';
import { MAX_IMAGES, MAX_TAGS, Post } from './post.model';
import { Tag } from './tag.model';

/**
 * Visibility rule: global posts are visible to every signed-in user, college posts
 * only to members of that college. Returns 404 (not 403) so private posts are not revealed.
 */
export const assertPostVisible = async (postId: string, user: AuthUser): Promise<void> => {
  const post = await Post.findById(postId).select('type college').lean();
  const visible = post && (post.type === PostType.GLOBAL || post.college.toString() === user.collegeId);
  if (!visible) throw new ApiError(404, 'NOT_FOUND', 'Post not found');
};

/** Untrusted tag input -> lowercase, no '#', non-empty, unique, capped. Non-strings are dropped. */
export const normalizeTags = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const tags = raw
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().replace(/^#+/, '').toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)].slice(0, MAX_TAGS);
};

/** Untrusted image list -> string URLs only, capped. */
export const normalizeImages = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((url): url is string => typeof url === 'string' && url.trim() !== '').slice(0, MAX_IMAGES)
    : [];

/** Adjusts trending-tag counters in one round trip. New tags are created only when incrementing. */
export const adjustTagCounts = async (tags: string[], delta: 1 | -1): Promise<void> => {
  if (tags.length === 0) return;
  await Tag.bulkWrite(
    tags.map((name) => ({
      updateOne: { filter: { name }, update: { $inc: { postCount: delta } }, upsert: delta > 0 },
    }))
  );
};

/**
 * Atomically adds the user to a post's likes/upvotes, or removes them if already there.
 * Two concurrent clicks can no longer overwrite each other.
 */
export const togglePostReaction = async (
  postId: string,
  field: 'likes' | 'upvotes',
  user: AuthUser
): Promise<{ active: boolean; count: number }> => {
  await assertPostVisible(postId, user);
  const userId = new Types.ObjectId(user.userId);
  const options = { new: true, projection: { [field]: 1 } };

  // The `$ne` guard makes the add a no-op when the user already reacted - then remove instead.
  const added = await Post.findOneAndUpdate(
    { _id: postId, [field]: { $ne: userId } },
    { $addToSet: { [field]: userId } },
    options
  ).lean();
  const post =
    added ?? (await Post.findByIdAndUpdate(postId, { $pull: { [field]: userId } }, options).lean());

  return { active: Boolean(added), count: post?.[field].length ?? 0 };
};
