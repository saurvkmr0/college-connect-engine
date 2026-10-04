import { Types } from 'mongoose';
import { PostType } from '../../types';
import { ApiError, asyncHandler } from '../../utils/apiError';
import { escapeRegex, parsePagination, str } from '../../utils/request';
import { COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { Post } from '../posts/post.model';
import { feedPipeline, NEWEST_FIRST } from '../posts/post.service';
import { AUTHOR_FIELDS, MEMBER_ROLES, PUBLIC_USER_FIELDS, User } from './user.model';

/** Public profile: public fields + follow counts, and whether the viewer follows them. */
export const getUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.userId, role: { $in: MEMBER_ROLES } })
    .select(`${PUBLIC_USER_FIELDS} followers following`)
    .populate('college', COLLEGE_SUMMARY_FIELDS)
    .lean();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  // Send counts, not the raw follower id lists.
  const { followers, following, ...profile } = user;
  const viewer = req.user!.userId;
  res.json({
    user: profile,
    isFollowing: followers.some((id) => id.toString() === viewer),
    followerCount: followers.length,
    followingCount: following.length,
  });
});

/** A user's global posts, newest first (college-only posts stay in their college feed). */
export const getUserPosts = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (!(await User.exists({ _id: userId, role: { $in: MEMBER_ROLES } }))) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  const { page, limit, skip } = parsePagination(req.query);
  const posts = await Post.aggregate(
    feedPipeline({ author: new Types.ObjectId(userId), type: PostType.GLOBAL }, NEWEST_FIRST, skip, limit)
  );
  res.json({ posts, page, limit });
});

/** Toggles follow/unfollow. Uses atomic updates so concurrent clicks cannot corrupt the lists. */
export const followUser = asyncHandler(async (req, res) => {
  const { userId: targetId } = req.params;
  const currentId = req.user!.userId;

  if (targetId === currentId) throw new ApiError(400, 'VALIDATION_ERROR', 'You cannot follow yourself');
  if (!(await User.exists({ _id: targetId, role: { $in: MEMBER_ROLES } }))) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  const target = new Types.ObjectId(targetId);
  const self = new Types.ObjectId(currentId);

  // The `$ne` guard makes this a no-op when already following - that is the signal to unfollow.
  const added = await User.updateOne(
    { _id: self, following: { $ne: target } },
    { $addToSet: { following: target } }
  );
  const isFollowing = added.modifiedCount === 1;

  if (isFollowing) {
    await User.updateOne({ _id: target }, { $addToSet: { followers: self } });
  } else {
    await Promise.all([
      User.updateOne({ _id: self }, { $pull: { following: target } }),
      User.updateOne({ _id: target }, { $pull: { followers: self } }),
    ]);
  }

  res.json({
    message: isFollowing ? 'Followed successfully' : 'Unfollowed successfully',
    isFollowing,
  });
});

/** Shared by followers/following: returns the populated list for one side of the relation. */
const listRelation = (field: 'followers' | 'following') =>
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.userId)
      .select(field)
      .populate(field, AUTHOR_FIELDS)
      .lean();
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

    res.json({ [field]: user[field] });
  });

export const getFollowers = listRelation('followers');
export const getFollowing = listRelation('following');

/** Name search only - searching by email would let anyone enumerate registered emails. */
export const searchUsers = asyncHandler(async (req, res) => {
  const query = str(req.query.query).slice(0, 50);
  if (!query) throw new ApiError(400, 'VALIDATION_ERROR', 'Search query is required');

  // ponytail: unanchored case-insensitive regex scans the collection; switch to a
  // text index / Atlas Search when the user count grows.
  const users = await User.find({ role: { $in: MEMBER_ROLES }, name: { $regex: escapeRegex(query), $options: 'i' } })
    .select(PUBLIC_USER_FIELDS)
    .limit(20)
    .lean();

  res.json({ users });
});
