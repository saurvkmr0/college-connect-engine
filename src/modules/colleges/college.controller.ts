import { CollegeVerificationStatus, PostType, UserRole } from '../../types';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { escapeRegex, str } from '../../utils/request';
import { Post } from '../posts/post.model';
import { AUTHOR_FIELDS, User } from '../users/user.model';
import { College } from './college.model';
import {
  addDomains,
  createCollege,
  parseCollegeInput,
  removeDomain,
  replaceDomains,
  setCollegeActive,
  updateCollege,
} from './college.service';

/* ------------------------------------------------------------------ */
/* Public (any signed-in user)                                          */
/* ------------------------------------------------------------------ */

export const getColleges = asyncHandler(async (_req, res) => {
  const colleges = await College.find({ verificationStatus: CollegeVerificationStatus.APPROVED })
    .select('name code logo description')
    .sort({ name: 1 })
    .lean();

  res.json({ colleges });
});

export const getCollegeById = asyncHandler(async (req, res) => {
  const { collegeId } = req.params;

  // Independent queries - run them in parallel.
  const [college, posts, studentCount, facultyCount] = await Promise.all([
    College.findById(collegeId).populate('admin', 'name avatar').lean(),
    Post.find({ college: collegeId, type: PostType.GLOBAL })
      .populate('author', AUTHOR_FIELDS)
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    User.countDocuments({ college: collegeId, role: UserRole.STUDENT }),
    User.countDocuments({ college: collegeId, role: { $in: [UserRole.FACULTY, UserRole.STAFF] } }),
  ]);
  if (!college) throw new ApiError(404, 'NOT_FOUND', 'College not found');

  res.json({ college, stats: { studentCount, facultyCount }, posts });
});

/* ------------------------------------------------------------------ */
/* Admin only - domains drive college email verification                */
/* ------------------------------------------------------------------ */

export const listCollegesAdmin = asyncHandler(async (req, res) => {
  const filter: Record<string, unknown> = {};
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
