import { Types } from 'mongoose';
import { CollegeVerificationStatus, PostType } from '../../types';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { escapeRegex, parsePagination, str } from '../../utils/request';
import { Post } from '../posts/post.model';
import { feedPipeline, NEWEST_FIRST } from '../posts/post.service';
import { User } from '../users/user.model';
import { College, PUBLIC_COLLEGE } from './college.model';
import {
  addDomains,
  createCollege,
  getCollegeStats,
  parseCollegeInput,
  removeDomain,
  replaceDomains,
  setCollegeActive,
  updateCollege,
} from './college.service';

/* ------------------------------------------------------------------ */
/* Public (any signed-in user)                                          */
/* ------------------------------------------------------------------ */

/** Colleges students can verify with (college picker): approved + active, with their email domains. */
export const getColleges = asyncHandler(async (_req, res) => {
  // ponytail: whole list in one response - fine for hundreds of colleges; page it beyond that.
  const colleges = await College.find(PUBLIC_COLLEGE)
    .select('name code logo city state domains')
    .sort({ name: 1 })
    .lean();

  res.json({ colleges });
});

const assertPublicCollege = async (collegeId: string): Promise<void> => {
  if (!(await College.exists({ _id: collegeId, ...PUBLIC_COLLEGE }))) {
    throw new ApiError(404, 'NOT_FOUND', 'College not found');
  }
};

export const searchColleges = asyncHandler(async (req, res) => {
  const query = str(req.query.q).slice(0, 50);
  if (!query) {
    res.json({ colleges: [] });
    return;
  }
  // ponytail: unanchored regex scans colleges - fine for thousands; add a text index beyond that.
  const colleges = await College.find({ ...PUBLIC_COLLEGE, name: { $regex: escapeRegex(query), $options: 'i' } })
    .select('name code logo city state')
    .sort({ name: 1 })
    .limit(20)
    .lean();
  res.json({ colleges });
});

export const getCollegeById = asyncHandler(async (req, res) => {
  const college = await College.findOne({ _id: req.params.collegeId, ...PUBLIC_COLLEGE })
    .select('-admin -__v')
    .lean();
  if (!college) throw new ApiError(404, 'NOT_FOUND', 'College not found');

  const [stats, isFollowing] = await Promise.all([
    getCollegeStats(college._id),
    User.exists({ _id: req.user!.userId, followedColleges: college._id }),
  ]);
  res.json({ college, stats, isFollowing: Boolean(isFollowing) });
});

/** Global posts by members of the college (students and staff), newest first. */
export const getCollegePosts = asyncHandler(async (req, res) => {
  const { collegeId } = req.params;
  await assertPublicCollege(collegeId);

  const { page, limit, skip } = parsePagination(req.query);
  const posts = await Post.aggregate(
    feedPipeline({ college: new Types.ObjectId(collegeId), type: PostType.GLOBAL }, NEWEST_FIRST, skip, limit)
  );
  res.json({ posts, page, limit });
});

/**
 * Toggle. Any signed-in user may follow (no content is created). Atomic, like user follows.
 * Unfollowing always works - even after the college is disabled - only following needs a public college.
 */
export const followCollege = asyncHandler(async (req, res) => {
  const { collegeId } = req.params;
  if (!Types.ObjectId.isValid(collegeId)) throw new ApiError(404, 'NOT_FOUND', 'College not found');
  const id = new Types.ObjectId(collegeId);

  const removed = await User.updateOne(
    { _id: req.user!.userId, followedColleges: id },
    { $pull: { followedColleges: id } }
  );
  const isFollowing = removed.modifiedCount === 0;
  if (isFollowing) {
    await assertPublicCollege(collegeId);
    await User.updateOne({ _id: req.user!.userId }, { $addToSet: { followedColleges: id } });
  }

  res.json({ isFollowing, followerCount: await User.countDocuments({ followedColleges: id }) });
});

/* ------------------------------------------------------------------ */
/* Admin only - domains drive college email verification                */
/* ------------------------------------------------------------------ */

export const listCollegesAdmin = asyncHandler(async (req, res) => {
  // Pending portal applications are reviewed on the Applications page, not here.
  const filter: Record<string, unknown> = { verificationStatus: { $ne: CollegeVerificationStatus.PENDING } };
  if (req.query.active === 'true') filter.active = true;
  if (req.query.active === 'false') filter.active = false;

  const query = str(req.query.query);
  if (query) filter.name = { $regex: escapeRegex(query), $options: 'i' };

  const colleges = await College.find(filter).sort({ name: 1 }).lean();
  res.json({ success: true, colleges });
});

export const createCollegeAdmin = asyncHandler(async (req, res) => {
  const college = await createCollege(parseCollegeInput(req.body), req.user!.userId);
  sendSuccess(res, 201, 'College created', { college });
});

export const updateCollegeAdmin = asyncHandler(async (req, res) => {
  const college = await updateCollege(req.params.collegeId, parseCollegeInput(req.body));
  sendSuccess(res, 200, 'College updated', { college });
});

export const enableCollege = asyncHandler(async (req, res) => {
  const college = await setCollegeActive(req.params.collegeId, true);
  sendSuccess(res, 200, 'College enabled', { college });
});

export const disableCollege = asyncHandler(async (req, res) => {
  const college = await setCollegeActive(req.params.collegeId, false);
  sendSuccess(res, 200, 'College disabled', { college });
});

/** PUT - replaces the whole domain list. */
export const updateCollegeDomains = asyncHandler(async (req, res) => {
  const college = await replaceDomains(req.params.collegeId, req.body?.domains);
  sendSuccess(res, 200, 'Domains updated', { college });
});

/** POST - adds domains to the existing list. */
export const addCollegeDomains = asyncHandler(async (req, res) => {
  const college = await addDomains(req.params.collegeId, req.body?.domains);
  sendSuccess(res, 200, 'Domains added', { college });
});

/** DELETE - removes a single domain. */
export const removeCollegeDomain = asyncHandler(async (req, res) => {
  const college = await removeDomain(req.params.collegeId, req.params.domain);
  sendSuccess(res, 200, 'Domain removed', { college });
});
