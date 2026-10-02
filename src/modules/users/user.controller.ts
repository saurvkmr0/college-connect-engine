import { Types } from 'mongoose';
import { ApiError, asyncHandler } from '../../utils/apiError';
import { escapeRegex, str } from '../../utils/request';
import { COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { AUTHOR_FIELDS, PUBLIC_USER_FIELDS, User } from './user.model';

export const getUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId)
    .select(`${PUBLIC_USER_FIELDS} followers following`)
    .populate('college', COLLEGE_SUMMARY_FIELDS)
    .lean();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  res.json({ user });
});

/** Toggles follow/unfollow. Uses atomic updates so concurrent clicks cannot corrupt the lists. */
export const followUser = asyncHandler(async (req, res) => {
  const { userId: targetId } = req.params;
  const currentId = req.user!.userId;

  if (targetId === currentId) throw new ApiError(400, 'VALIDATION_ERROR', 'You cannot follow yourself');
  if (!(await User.exists({ _id: targetId }))) throw new ApiError(404, 'NOT_FOUND', 'User not found');

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
  const users = await User.find({ name: { $regex: escapeRegex(query), $options: 'i' } })
    .select(PUBLIC_USER_FIELDS)
    .limit(20)
    .lean();

  res.json({ users });
});
