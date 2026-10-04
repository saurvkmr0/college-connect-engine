import { Types } from 'mongoose';
import { AuthUser, CollegeVerificationStatus, ICollege } from '../../types';
import { ApiError } from '../../utils/apiError';
import { extractDomain } from '../../utils/emailValidation';
import { College, COLLEGE_PROFILE_FIELDS } from '../colleges/college.model';
import {
  CollegeInput,
  createCollege,
  getCollegeStats,
  parseCollegeInput,
  updateCollege,
} from '../colleges/college.service';
import { User } from '../users/user.model';

/** Taken = the college is itself a pending application, or already has a pending/approved rep. */
const isCollegeTaken = async (college: Pick<ICollege, '_id' | 'verificationStatus'>): Promise<boolean> =>
  college.verificationStatus === CollegeVerificationStatus.PENDING ||
  Boolean(await User.exists({ managedCollege: college._id, managerStatus: { $in: ['pending', 'approved'] } }));

/**
 * The rep applies for the college that owns their verified email domain:
 * a claim when that college exists, a new (pending, inactive) college otherwise.
 * The domain always comes from the verified email - never from the request body.
 */
export const applyForCollege = async (rep: AuthUser, body: unknown) => {
  if (!rep.emailVerified) throw new ApiError(403, 'FORBIDDEN', 'Verify your email before applying.');
  if (rep.managerStatus === 'pending' || rep.managerStatus === 'approved') {
    throw new ApiError(409, 'CONFLICT', 'You already have an application.');
  }

  const domain = extractDomain(rep.email);
  const existing = await College.findOne({ domains: domain }).select('verificationStatus').lean();

  let type: 'new' | 'claim';
  let collegeId: Types.ObjectId;
  if (existing) {
    if (await isCollegeTaken(existing)) {
      throw new ApiError(409, 'CONFLICT', 'This college already has a representative or a pending application.');
    }
    // Two different reps racing to claim one college can both go pending; approval then
    // allows only one (see approveApplication), so the invariant "one rep per college" holds.
    type = 'claim';
    collegeId = existing._id;
  } else {
    // Racing new applications for one domain hit the unique domains index -> 409.
    const college = await createCollege(
      { ...parseCollegeInput(body), domains: [domain], active: false },
      rep.userId,
      CollegeVerificationStatus.PENDING
    );
    type = 'new';
    collegeId = college._id;
  }

  // Conditional on "no open application", so a double-submit links only once.
  const linked = await User.updateOne(
    { _id: rep.userId, managerStatus: { $nin: ['pending', 'approved'] } },
    { $set: { managedCollege: collegeId, managerStatus: 'pending' }, $unset: { managerRejectionReason: 1 } }
  ).catch(async (error) => {
    if (type === 'new') await College.deleteOne({ _id: collegeId }); // never leave an orphan holding the domain
    throw error;
  });
  if (linked.modifiedCount === 0) {
    if (type === 'new') await College.deleteOne({ _id: collegeId });
    throw new ApiError(409, 'CONFLICT', 'You already have an application.');
  }
  return { type, collegeId: collegeId.toString() };
};

/** Everything the portal dashboard needs in one call. Stats only once approved. */
export const loadDashboard = async (rep: AuthUser) => {
  const user = await User.findById(rep.userId)
    .select('name email emailVerified managedCollege managerStatus managerRejectionReason')
    .lean();
  const college = user?.managedCollege ? await College.findById(user.managedCollege).select('-__v').lean() : null;
  const stats = user?.managerStatus === 'approved' && college ? await getCollegeStats(college._id) : null;
  return { rep: user, college, stats };
};

/** Approved reps edit profile fields only - name, code and domains stay admin-only. */
export const updateManagedCollege = async (rep: AuthUser, body: unknown) => {
  const input = parseCollegeInput(body);
  const allowed: CollegeInput = {};
  for (const field of COLLEGE_PROFILE_FIELDS) {
    if (input[field] !== undefined) allowed[field] = input[field];
  }
  return updateCollege(rep.managedCollegeId!, allowed);
};
