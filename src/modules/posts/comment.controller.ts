import mongoose, { PipelineStage, Types } from 'mongoose';
import { Request } from 'express';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { parsePagination, str } from '../../utils/request';
import { AUTHOR_FIELDS } from '../users/user.model';
import { Comment } from './comment.model';
import { Post } from './post.model';
import { assertPostVisible, lookupAuthor } from './post.service';

/** Comment text from the body: required, trimmed (the schema caps the length). */
const readContent = (body: unknown): string => {
  const content = str((body as { content?: unknown } | undefined)?.content);
  if (!content) throw new ApiError(400, 'VALIDATION_ERROR', 'Comment content is required');
  return content;
};

const COMMENTS_PER_PAGE = 25;
/** Replies embedded per comment, and per "View more replies" page. */
const REPLIES_PER_PAGE = 10;

/** Comments saved before likes existed have no `likes`; lean reads skip schema defaults. */
const withLikes = <T extends { likes?: unknown[] }>(c: T) => ({ ...c, likes: c.likes ?? [] });
const withLikesStage: PipelineStage.AddFields = { $addFields: { likes: { $ifNull: ['$likes', []] } } };

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

/**
 * One aggregation per page: 25 top-level comments (newest first), each with its first 10 replies
 * (oldest first), `replyCount`, and authors joined with public fields only.
 */
export const getComments = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  await assertPostVisible(postId, req.user!);

  const { page } = parsePagination(req.query);
  const rows = await Comment.aggregate([
    { $match: { post: new Types.ObjectId(postId), parent: null } },
    { $sort: { createdAt: -1 } },
    { $skip: (page - 1) * COMMENTS_PER_PAGE },
    { $limit: COMMENTS_PER_PAGE + 1 }, // one extra tells us whether another page exists
    ...lookupAuthor,
    withLikesStage,
    {
      $lookup: {
        from: Comment.collection.name,
        localField: '_id',
        foreignField: 'parent',
        pipeline: [{ $sort: { createdAt: 1 } }, { $limit: REPLIES_PER_PAGE }, ...lookupAuthor, withLikesStage],
        as: 'replies',
      },
    },
    {
      $lookup: {
        from: Comment.collection.name,
        localField: '_id',
        foreignField: 'parent',
        pipeline: [{ $count: 'n' }],
        as: 'replyStats',
      },
    },
    { $addFields: { replyCount: { $ifNull: [{ $first: '$replyStats.n' }, 0] } } },
    { $project: { replyStats: 0 } },
  ]);

  res.json({ comments: rows.slice(0, COMMENTS_PER_PAGE), page, hasMore: rows.length > COMMENTS_PER_PAGE });
});

/** "View more replies": a thread's replies, oldest first, 10 per page (page 1 = the embedded ones). */
export const getReplies = asyncHandler(async (req, res) => {
  const comment = await findComment(req);
  const { page, limit, skip } = parsePagination(req.query, REPLIES_PER_PAGE);
  const rows = await Comment.find({ parent: comment._id })
    .populate('author', AUTHOR_FIELDS)
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(limit + 1)
    .lean();
  res.json({ replies: rows.slice(0, limit).map(withLikes), page, hasMore: rows.length > limit });
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
