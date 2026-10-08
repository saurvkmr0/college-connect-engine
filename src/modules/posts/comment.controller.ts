import mongoose, { Types } from 'mongoose';
import { Request } from 'express';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { parsePagination, str } from '../../utils/request';
import { AUTHOR_FIELDS } from '../users/user.model';
import { Comment } from './comment.model';
import { Post } from './post.model';
import { assertPostVisible } from './post.service';

/** Comment text from the body: required, trimmed (the schema caps the length). */
const readContent = (body: unknown): string => {
  const content = str((body as { content?: unknown } | undefined)?.content);
  if (!content) throw new ApiError(400, 'VALIDATION_ERROR', 'Comment content is required');
  return content;
};

/** Comments saved before likes existed have no `likes`; lean reads skip schema defaults. */
const withLikes = <T extends { likes?: unknown[] }>(c: T) => ({ ...c, likes: c.likes ?? [] });

/** A comment of a post the caller can see; 404 when either is missing or the id is malformed. */
const findComment = async (req: Request) => {
  await assertPostVisible(req.params.postId, req.user!);
  const { commentId, postId } = req.params;
  const comment = Types.ObjectId.isValid(commentId) ? await Comment.findOne({ _id: commentId, post: postId }) : null;
  if (!comment) throw new ApiError(404, 'NOT_FOUND', 'Comment not found');
  return comment;
};

/** New comment, or a reply with `parentId` (a reply to a reply joins the same top-level thread). */
export const addComment = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const content = readContent(req.body);
  await assertPostVisible(postId, req.user!);

  let parent: Types.ObjectId | undefined;
  if (req.body?.parentId !== undefined) {
    const parentId = str(req.body.parentId);
    if (!Types.ObjectId.isValid(parentId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid parent comment');
    const target = await Comment.findOne({ _id: parentId, post: postId }).select('parent').lean();
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'Comment not found');
    parent = target.parent ?? target._id;
  }

  const comment = await Comment.create({ author: req.user!.userId, post: postId, parent, content });
  await Post.updateOne({ _id: postId }, { $push: { comments: comment._id } });
  await comment.populate('author', AUTHOR_FIELDS);
  res.status(201).json({ comment });
});

/** Top-level comments, newest first, each with its `replyCount`. */
export const getComments = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  await assertPostVisible(postId, req.user!);

  const { page, limit, skip } = parsePagination(req.query, 100);
  const comments = await Comment.find({ post: postId, parent: null })
    .populate('author', AUTHOR_FIELDS)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  const counts = await Comment.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { parent: { $in: comments.map((c) => c._id) } } },
    { $group: { _id: '$parent', n: { $sum: 1 } } },
  ]);
  const replyCount = new Map(counts.map((c) => [c._id.toString(), c.n]));

  res.json({ comments: comments.map((c) => ({ ...withLikes(c), replyCount: replyCount.get(c._id.toString()) ?? 0 })), page, limit });
});

/** A thread's replies, newest first. */
export const getReplies = asyncHandler(async (req, res) => {
  const comment = await findComment(req);
  // ponytail: newest 100 replies only; page them if threads get that long.
  const replies = await Comment.find({ parent: comment._id })
    .populate('author', AUTHOR_FIELDS)
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json({ replies: replies.map(withLikes) });
});

/** Only the comment's author can edit it. */
export const updateComment = asyncHandler(async (req, res) => {
  const comment = await findComment(req);
  if (comment.author.toString() !== req.user!.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'You can only edit your own comments');
  }
  comment.set({ content: readContent(req.body), editedAt: new Date() });
  await comment.save();
  await comment.populate('author', AUTHOR_FIELDS);
  res.json({ comment });
});

/**
 * The comment's author or the post's author may delete. A top-level comment takes its replies
 * with it; comments and the post's comment ids change in one transaction.
 */
export const deleteComment = asyncHandler(async (req, res) => {
  const comment = await findComment(req);
  const userId = req.user!.userId;
  if (comment.author.toString() !== userId) {
    const post = await Post.findById(comment.post).select('author').lean();
    if (post?.author.toString() !== userId) throw new ApiError(403, 'FORBIDDEN', 'You cannot delete this comment');
  }

  const ids = [comment._id];
  if (!comment.parent) ids.push(...(await Comment.find({ parent: comment._id }).distinct('_id')));
  await mongoose.connection.transaction(async (session) => {
    await Comment.deleteMany({ _id: { $in: ids } }, { session });
    await Post.updateOne({ _id: comment.post }, { $pull: { comments: { $in: ids } } }, { session });
  });
  sendSuccess(res, 200, 'Comment deleted', { deletedCount: ids.length });
});

/** Like/unlike toggle, atomic like post likes. */
export const toggleCommentLike = asyncHandler(async (req, res) => {
  const comment = await findComment(req);
  const userId = new Types.ObjectId(req.user!.userId);
  const options = { new: true, projection: { likes: 1 } };
  // The `$ne` guard makes the add a no-op when already liked - then remove instead.
  const added = await Comment.findOneAndUpdate({ _id: comment._id, likes: { $ne: userId } }, { $addToSet: { likes: userId } }, options).lean();
  const updated = added ?? (await Comment.findByIdAndUpdate(comment._id, { $pull: { likes: userId } }, options).lean());
  res.json({ isLiked: Boolean(added), likesCount: updated?.likes.length ?? 0 });
});
