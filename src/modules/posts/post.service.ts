import { FilterQuery, PipelineStage, Types } from 'mongoose';
import { AuthUser, IPost, PostType } from '../../types';
import { ApiError } from '../../utils/apiError';
import { College, COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { AUTHOR_FIELDS, User } from '../users/user.model';
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

/** `'name avatar role'` -> `{ name: 1, avatar: 1, role: 1 }` for $lookup projections. */
const toProjection = (fields: string) => Object.fromEntries(fields.split(' ').map((f) => [f, 1]));

/**
 * Shared post-list pipeline (feeds + college profile): match -> rank -> paginate -> join author/college.
 * The joins only return public fields, so emails and verification data never leak.
 */
export const feedPipeline = (
  match: FilterQuery<IPost>,
  rank: PipelineStage[],
  skip: number,
  limit: number
): PipelineStage[] => [
  { $match: match },
  ...rank,
  { $skip: skip },
  { $limit: limit },
  {
    $lookup: {
      from: User.collection.name,
      localField: 'author',
      foreignField: '_id',
      pipeline: [{ $project: toProjection(AUTHOR_FIELDS) }],
      as: 'author',
    },
  },
  { $unwind: '$author' },
  {
    $lookup: {
      from: College.collection.name,
      localField: 'college',
      foreignField: '_id',
      pipeline: [{ $project: toProjection(COLLEGE_SUMMARY_FIELDS) }],
      as: 'college',
    },
  },
  { $unwind: '$college' },
];

/** Rank for lists that are purely chronological (college profile). */
export const NEWEST_FIRST: PipelineStage[] = [{ $sort: { createdAt: -1 } }];
