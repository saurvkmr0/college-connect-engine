import { UserRole } from '../../types';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { extractDomain, isFreeEmailDomain } from '../../utils/emailValidation';
import { findByCredentials, hashPassword, parseNewAccount, sessionPayload } from '../auth/auth.service';
import { User } from '../users/user.model';
import { consumeOtp, issueOtp } from '../verification/otp.service';
import { applyForCollege, loadDashboard, updateManagedCollege } from './portal.service';

/* ------------------------------------------------------------------ */
/* Account: register, login, prove the email domain                      */
/* ------------------------------------------------------------------ */

export const register = asyncHandler(async (req, res) => {
  const account = await parseNewAccount(req.body);
  if (isFreeEmailDomain(extractDomain(account.email))) {
    throw new ApiError(
      400,
      'INVALID_EMAIL',
      'Use your official college email address - free email providers are not accepted.'
    );
  }

  const user = await User.create({
    ...account,
    password: await hashPassword(account.password),
    role: UserRole.COLLEGE_REP,
    emailVerified: false,
  });
  res.status(201).json(await sessionPayload(user));
});

export const login = asyncHandler(async (req, res) => {
  const user = await findByCredentials(req.body);
  if (user.role !== UserRole.COLLEGE_REP) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'This is not a college portal account.');
  }
  res.json(await sessionPayload(user));
});

/** Sends a code to the rep's own login email - proves they control that college domain. */
export const requestEmailOtp = asyncHandler(async (req, res) => {
  if (req.user!.emailVerified) throw new ApiError(409, 'ALREADY_VERIFIED', 'Your email is already verified.');
  await issueOtp('portal', req.user!.userId, req.user!.email);
  sendSuccess(res, 200, 'Verification code sent to your email.');
});

export const verifyEmailOtp = asyncHandler(async (req, res) => {
  if (req.user!.emailVerified) throw new ApiError(409, 'ALREADY_VERIFIED', 'Your email is already verified.');
  await consumeOtp('portal', req.user!.userId, req.user!.email, req.body?.otp);
  await User.updateOne({ _id: req.user!.userId }, { $set: { emailVerified: true } });
  sendSuccess(res, 200, 'Email verified.');
});

/* ------------------------------------------------------------------ */
/* Application + dashboard                                              */
/* ------------------------------------------------------------------ */

export const submitApplication = asyncHandler(async (req, res) => {
  sendSuccess(res, 201, 'Application submitted', await applyForCollege(req.user!, req.body));
});

export const getDashboard = asyncHandler(async (req, res) => {
  res.json(await loadDashboard(req.user!));
});

export const updateCollegeProfile = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'College updated', { college: await updateManagedCollege(req.user!, req.body) });
});

/* ------------------------------------------------------------------ */
/* Faculty requests (approved reps, own college only)                    */
/* ------------------------------------------------------------------ */

const STAFF_ROLES = [UserRole.FACULTY, UserRole.STAFF];

/** Pending faculty/staff of one college. Also scopes approve/reject, so other colleges get 404. */
const pendingFacultyOf = (collegeId: string) => ({
  college: collegeId,
  role: { $in: STAFF_ROLES },
  facultyStatus: 'pending',
});

export const listFacultyRequests = asyncHandler(async (req, res) => {
  const requests = await User.find(pendingFacultyOf(req.user!.managedCollegeId!))
    .select('name avatar role department collegeEmail createdAt')
    .sort({ createdAt: 1 })
    .lean();
  res.json({ requests });
});

/** Approve grants faculty powers; reject turns the account into a student. */
const decideFaculty = (approve: boolean) =>
  asyncHandler(async (req, res) => {
    const update = approve
      ? { $set: { facultyStatus: 'approved' } }
      : { $set: { role: UserRole.STUDENT }, $unset: { facultyStatus: 1 } };
    const result = await User.updateOne(
      { _id: req.params.userId, ...pendingFacultyOf(req.user!.managedCollegeId!) },
      update
    );
    if (result.matchedCount === 0) throw new ApiError(404, 'NOT_FOUND', 'Faculty request not found');
    sendSuccess(res, 200, approve ? 'Faculty approved' : 'Faculty request rejected');
  });

export const approveFaculty = decideFaculty(true);
export const rejectFaculty = decideFaculty(false);
