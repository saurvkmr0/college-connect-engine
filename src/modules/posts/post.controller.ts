import mongoose from 'mongoose';
import { ApiError, asyncHandler } from '../../utils/apiError';
import { str } from '../../utils/request';
import { COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { AUTHOR_FIELDS } from '../users/user.model';
import { Comment } from './comment.model';
import { MAX_POST_MEDIA } from '../media/media.constants';
import { claimAssets, releaseObject, unclaimAssets } from '../media/media.service';
import { toPublicUrl } from '../media/media.serializer';
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

/** Loads a post the caller may change (author only). */
const findOwnPost = async (postId: string, userId: string, action: string) => {
  const post = await Post.findById(postId);
  if (!post) throw new ApiError(404, 'NOT_FOUND', 'Post not found');
  if (post.author.toString() !== userId) throw new ApiError(403, 'FORBIDDEN', `You can only ${action} your own posts`);
  return post;
};

/**
 * Post, comments and tag counts go in ONE transaction (all or nothing; needs a replica set,
 * e.g. Atlas). Only then is the media deleted from storage - never before, so a failure can
 * never leave a live post with missing images. Failed storage deletes are retried by the sweeper.
 */
export const deletePost = asyncHandler(async (req, res) => {
  const post = await findOwnPost(req.params.postId, req.user!.userId, 'delete');

  await mongoose.connection.transaction(async (session) => {
    await Post.deleteOne({ _id: post._id }, { session });
    await Comment.deleteMany({ post: post._id }, { session });
    await adjustTagCounts(post.tags, -1, session);
  });
  await Promise.all(post.media.map((m) => releaseObject(m.objectKey)));

  res.json({ message: 'Post deleted successfully' });
});

/**
 * Edit caption, tags and media (type/audience stays). Omitted fields are unchanged.
 * Media: `keepMedia` = public URLs of current items to keep (omit to keep all), `media` = new
 * upload ids appended after them. Removed media is deleted from storage only after the save.
 */
export const updatePost = asyncHandler(async (req, res) => {
  const post = await findOwnPost(req.params.postId, req.user!.userId, 'edit');
  const body = req.body ?? {};

  const content = body.content === undefined ? post.content : str(body.content);
  const tags = body.tags === undefined ? post.tags : normalizeTags(body.tags);
  const keepUrls = Array.isArray(body.keepMedia) ? new Set(body.keepMedia.map(str)) : null;
  const kept = keepUrls ? post.media.filter((m) => keepUrls.has(toPublicUrl(m.objectKey))) : [...post.media];
  const rawNew = Array.isArray(body.media) ? body.media : [];

  if (!content && kept.length + rawNew.length + post.images.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Add a caption or at least one photo/video');
  }
  if (kept.length + rawNew.length > MAX_POST_MEDIA) {
    throw new ApiError(400, 'VALIDATION_ERROR', `At most ${MAX_POST_MEDIA} media items per post`);
  }
  const added = await claimAssets(req.user!, rawNew, ['post']);
  const removed = post.media.filter((m) => !kept.includes(m)).map((m) => m.objectKey);
  const oldTags = post.tags;

  post.set({
    content,
    tags,
    media: [...kept.map(({ objectKey, kind }) => ({ objectKey, kind })), ...added.map(({ objectKey, kind }) => ({ objectKey, kind }))],
    editedAt: new Date(),
  });
  try {
    await post.save(); // schema limits (caption length, item count) apply here too
  } catch (error) {
    await unclaimAssets(added.map((m) => m.assetId));
    throw error;
  }
  await Promise.all([
    adjustTagCounts(tags.filter((t) => !oldTags.includes(t)), 1),
    adjustTagCounts(oldTags.filter((t) => !tags.includes(t)), -1),
    ...removed.map(releaseObject),
  ]);

  await post.populate([
    { path: 'author', select: AUTHOR_FIELDS },
    { path: 'college', select: COLLEGE_SUMMARY_FIELDS },
  ]);
  res.json({ post });
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


