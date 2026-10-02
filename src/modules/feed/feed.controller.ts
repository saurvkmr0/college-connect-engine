import { FilterQuery, PipelineStage, Types } from 'mongoose';
import { IPost, PostType } from '../../types';
import { asyncHandler } from '../../utils/apiError';
import { parsePagination, str } from '../../utils/request';
import { College, COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { Post } from '../posts/post.model';
import { Tag } from '../posts/tag.model';
import { AUTHOR_FIELDS, User } from '../users/user.model';

/** `'name avatar role'` -> `{ name: 1, avatar: 1, role: 1 }` for $lookup projections. */
const toProjection = (fields: string) => Object.fromEntries(fields.split(' ').map((f) => [f, 1]));

/**
 * Shared feed pipeline: match -> rank -> paginate -> join author/college.
 * The joins only return public fields, so emails and verification data never leak.
 */
const feedPipeline = (
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

// ponytail: score is computed per request over every matching post, so this sort
// cannot use an index. Store likeCount/upvoteCount/commentCount on the post (or a
// precomputed score) once a college has thousands of global posts.
const BY_ENGAGEMENT: PipelineStage[] = [
  {
    $addFields: {
      score: {
        $add: [
          { $multiply: [{ $size: '$upvotes' }, 3] },
          { $size: '$likes' },
          { $multiply: [{ $size: '$comments' }, 2] },
        ],
      },
    },
  },
  { $sort: { score: -1, createdAt: -1 } },
];

const BY_UPVOTES: PipelineStage[] = [
  { $addFields: { upvoteCount: { $size: '$upvotes' } } },
  { $sort: { upvoteCount: -1, createdAt: -1 } },
];

/**
 * Global feed, ranked by engagement:
 * - `?tag=` - every global post with that tag
 * - verified users - posts from people they follow + their own college
 * - unverified users - every global post (read-only until they verify)
 */
export const getGlobalFeed = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const tag = str(req.query.tag).toLowerCase();
  const { userId, collegeId } = req.user!;

  const match: FilterQuery<IPost> = { type: PostType.GLOBAL };
  if (tag) {
    match.tags = tag;
  } else if (collegeId) {
    const me = await User.findById(userId).select('following').lean();
    match.$or = [
      { author: { $in: me?.following ?? [] } },
      { college: new Types.ObjectId(collegeId) },
    ];
  }

  const posts = await Post.aggregate(feedPipeline(match, BY_ENGAGEMENT, skip, limit));
  res.json({ posts, page, limit });
});

/** Requires `requireVerified`, so req.user.collegeId is always set here. */
export const getCollegeFeed = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);

  const posts = await Post.find({ college: req.user!.collegeId, type: PostType.COLLEGE })
    .populate('author', AUTHOR_FIELDS)
    .populate('college', COLLEGE_SUMMARY_FIELDS)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({ posts, page, limit });
});

/** Every global post, most upvoted first. */
export const getExploreFeed = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const posts = await Post.aggregate(feedPipeline({ type: PostType.GLOBAL }, BY_UPVOTES, skip, limit));
  res.json({ posts, page, limit });
});

export const getTrendingTags = asyncHandler(async (_req, res) => {
  const tags = await Tag.find({ postCount: { $gt: 0 } }).sort({ postCount: -1 }).limit(20).lean();
  res.json({ tags });
});
