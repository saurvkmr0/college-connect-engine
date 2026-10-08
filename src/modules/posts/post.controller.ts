import { ApiError, asyncHandler } from '../../utils/apiError';
import { parsePagination, str } from '../../utils/request';
import { COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { AUTHOR_FIELDS } from '../users/user.model';
import { Comment } from './comment.model';
import { MAX_POST_MEDIA } from '../media/media.constants';
import { claimAssets, releaseObject, unclaimAssets } from '../media/media.service';
import { Post } from './post.model';
import {
  adjustTagCounts,
  assertPostVisible,
  normalizeTags,
  togglePostReaction,
} from './post.service';

/** Requires `requireVerified`, so req.user.collegeId is always set here. */
export const createPost = asyncHandler(async (req, res) => {
  const content = str(req.body?.content);
  const type = str(req.body?.type);
  if (!type) throw new ApiError(400, 'VALIDATION_ERROR', 'Post type is required');

  const rawMedia = Array.isArray(req.body?.media) ? req.body.media : [];
  // The caption is optional, but a post needs something to show.
  if (!content && rawMedia.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Add a caption or at least one photo/video');
  }
  if (rawMedia.length > MAX_POST_MEDIA) {
    throw new ApiError(400, 'VALIDATION_ERROR', `At most ${MAX_POST_MEDIA} media items per post`);
  }
  const media = await claimAssets(req.user!, rawMedia, ['post']);

  // Schema validation rejects unknown types and over-long content with a 400.
  let post;
  try {
    post = await Post.create({
      author: req.user!.userId,
      college: req.user!.collegeId,
      type,
      content,
      media: media.map(({ objectKey, kind }) => ({ objectKey, kind })),
      tags: normalizeTags(req.body?.tags),
    });
  } catch (error) {
    await unclaimAssets(media.map((m) => m.assetId)); // the sweeper deletes them
    throw error;
  }
  await adjustTagCounts(post.tags, 1);
  await post.populate([
    { path: 'author', select: AUTHOR_FIELDS },
    { path: 'college', select: COLLEGE_SUMMARY_FIELDS },
  ]);

  res.status(201).json({ post });
});

export const getPost = asyncHandler(async (req, res) => {
  await assertPostVisible(req.params.postId, req.user!);

  const post = await Post.findById(req.params.postId)
    .populate('author', AUTHOR_FIELDS)
    .populate('college', COLLEGE_SUMMARY_FIELDS)
    .populate({ path: 'comments', populate: { path: 'author', select: AUTHOR_FIELDS } })
    .lean();
  if (!post) throw new ApiError(404, 'NOT_FOUND', 'Post not found');

  res.json({ post });
});

export const deletePost = asyncHandler(async (req, res) => {
  const post = await Post.findById(req.params.postId).select('author tags media');
  if (!post) throw new ApiError(404, 'NOT_FOUND', 'Post not found');
  if (post.author.toString() !== req.user!.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'You can only delete your own posts');
  }

  await Promise.all([
    post.deleteOne(),
    Comment.deleteMany({ post: post._id }),
    adjustTagCounts(post.tags, -1),
  ]);
  // The post is gone: delete its uploaded media (failures are retried by the sweeper).
  await Promise.all(post.media.map((m) => releaseObject(m.objectKey)));

  res.json({ message: 'Post deleted successfully' });
});

/** Who upvoted a post - visible to everyone who can see the post. */
/** Who reacted to a post - public to everyone who can see the post. Responds `{ [key]: users }`. */
const listReactors = (field: 'likes' | 'upvotes', key: 'likers' | 'upvoters') =>
  asyncHandler(async (req, res) => {
    await assertPostVisible(req.params.postId, req.user!);
    const post = await Post.findById(req.params.postId).select(field).populate(field, AUTHOR_FIELDS).lean();
    res.json({ [key]: post?.[field] ?? [] });
  });

export const getUpvoters = listReactors('upvotes', 'upvoters');
export const getLikers = listReactors('likes', 'likers');

export const toggleLike = asyncHandler(async (req, res) => {
  const { active, count } = await togglePostReaction(req.params.postId, 'likes', req.user!);
  res.json({ message: active ? 'Liked' : 'Unliked', likesCount: count, isLiked: active });
});

export const toggleUpvote = asyncHandler(async (req, res) => {
  if (!req.user!.canUpvote) {
    throw new ApiError(403, 'FORBIDDEN', 'Only faculty and staff approved by their college can upvote posts');
  }
  const { active, count } = await togglePostReaction(req.params.postId, 'upvotes', req.user!);
  res.json({ message: active ? 'Upvoted' : 'Upvote removed', upvotesCount: count, isUpvoted: active });
});

export const addComment = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const content = str(req.body?.content);
  if (!content) throw new ApiError(400, 'VALIDATION_ERROR', 'Comment content is required');

  await assertPostVisible(postId, req.user!);
  const comment = await Comment.create({ author: req.user!.userId, post: postId, content });
  await Post.updateOne({ _id: postId }, { $push: { comments: comment._id } });
  await comment.populate('author', AUTHOR_FIELDS);

  res.status(201).json({ comment });
});

export const getComments = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  await assertPostVisible(postId, req.user!);

  const { page, limit, skip } = parsePagination(req.query, 100);
  const comments = await Comment.find({ post: postId })
    .populate('author', AUTHOR_FIELDS)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({ comments, page, limit });
});
