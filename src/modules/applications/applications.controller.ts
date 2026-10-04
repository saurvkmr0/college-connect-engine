import { Types, UpdateQuery } from 'mongoose';
import { CollegeVerificationStatus, ICollege, IUser, UserRole } from '../../types';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { str } from '../../utils/request';
import { College } from '../colleges/college.model';
import { User } from '../users/user.model';

const APPLICATION_COLLEGE_FIELDS =
  'name code domains country state city address description logo bannerImage verificationStatus';

/** A rep with a pending application, plus whether it is a new college or a claim. 404 otherwise. */
const findPendingApplication = async (repId: string) => {
  const rep = await User.findOne({ _id: repId, role: UserRole.COLLEGE_REP, managerStatus: 'pending' })
    .select('managedCollege')
    .lean();
  const college = rep?.managedCollege
    ? await College.findById(rep.managedCollege).select('verificationStatus').lean()
    : null;
  if (!rep || !college) throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  return { rep, college, isNew: college.verificationStatus === CollegeVerificationStatus.PENDING };
};

/**
 * Moves a rep out of `pending` - only if they are still pending for that college.
 * This conditional update is the lock: of two racing approve/reject calls, exactly one wins
 * and the other gets 404, so the rep and the college can never disagree.
 */
const decide = async (repId: Types.ObjectId, collegeId: Types.ObjectId, update: UpdateQuery<IUser>) => {
  const result = await User.updateOne({ _id: repId, managerStatus: 'pending', managedCollege: collegeId }, update);
  if (result.modifiedCount === 0) throw new ApiError(404, 'NOT_FOUND', 'Application not found');
};

/** Oldest first, so the queue is worked in order. */
export const listApplications = asyncHandler(async (_req, res) => {
  const reps = await User.find({ role: UserRole.COLLEGE_REP, managerStatus: 'pending' })
    .select('name email managedCollege updatedAt')
    .populate<{ managedCollege: ICollege | null }>('managedCollege', APPLICATION_COLLEGE_FIELDS)
    .sort({ updatedAt: 1 })
    .lean();

  const applications = reps.map(({ managedCollege: college, ...rep }) => ({
    rep: { _id: rep._id, name: rep.name, email: rep.email },
    college,
    type: college?.verificationStatus === CollegeVerificationStatus.PENDING ? 'new' : 'claim',
    submittedAt: rep.updatedAt,
  }));
  res.json({ applications });
});

/** New: the college goes live (approved + active). Claim: the rep is linked to the existing college. */
export const approveApplication = asyncHandler(async (req, res) => {
  const { rep, college, isNew } = await findPendingApplication(req.params.repId);
  // One rep per college: a claim cannot be approved once someone else manages it.
  if (!isNew && (await User.exists({ managedCollege: college._id, managerStatus: 'approved' }))) {
    throw new ApiError(409, 'CONFLICT', 'This college already has an approved representative.');
  }
  await decide(rep._id, college._id, { $set: { managerStatus: 'approved' } });
  if (isNew) {
    await College.updateOne(
      { _id: college._id, verificationStatus: CollegeVerificationStatus.PENDING },
      { $set: { verificationStatus: CollegeVerificationStatus.APPROVED, active: true } }
    );
  }
  sendSuccess(res, 200, 'Application approved');
});

/** New: the pending college is deleted (frees its domain). Both: the rep sees the reason and may re-apply. */
export const rejectApplication = asyncHandler(async (req, res) => {
  const reason = str(req.body?.reason).slice(0, 500);
  if (!reason) throw new ApiError(400, 'VALIDATION_ERROR', 'A rejection reason is required');

  const { rep, college, isNew } = await findPendingApplication(req.params.repId);
  await decide(rep._id, college._id, {
    $set: { managerStatus: 'rejected', managerRejectionReason: reason },
    $unset: { managedCollege: 1 },
  });
  // Only after the rep is no longer pending, so a racing approve cannot revive a deleted college.
  if (isNew) await College.deleteOne({ _id: college._id, verificationStatus: CollegeVerificationStatus.PENDING });
  sendSuccess(res, 200, 'Application rejected');
});
