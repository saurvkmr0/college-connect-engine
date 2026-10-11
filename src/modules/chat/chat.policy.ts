import { Types } from 'mongoose';
import { AuthUser, UserRole } from '../../types';
import { ApiError } from '../../utils/apiError';
import { MEMBER_ROLES, User } from '../users/user.model';

/** Who may talk to whom. Every chat rule that depends on a user's standing lives here. */

/** The college a user is a verified member of (undefined when not verified). */
export const verifiedCollegeOf = (user: AuthUser): string | undefined => (user.verified ? user.collegeId : undefined);

/** Approved faculty/staff - "faculty" for open groups with allowFaculty. Pending faculty count as students. */
export const isFaculty = (user: AuthUser): boolean =>
  (user.role === UserRole.FACULTY || user.role === UserRole.STAFF) && user.canUpvote;

/** Confirmed member accounts (students, faculty, staff) - the only people chat ever deals with. */
const ACTIVE_MEMBER = { role: { $in: MEMBER_ROLES }, accountVerified: { $ne: false } };
/** Verified members of one college. */
export const verifiedMembersOf = (collegeId: string | Types.ObjectId) => ({
  ...ACTIVE_MEMBER,
  college: collegeId,
  $or: [{ 'collegeVerification.verified': true }, { collegeEmailVerified: true }],
});

/**
 * A may message B when either follows the other, or both are verified members of the same college.
 * Throws 404 for unknown/inactive users and 403 when not allowed.
 */
/** Who I may DM: people I follow, who follow me, or who are verified at my college. */
const messageableFilter = (me: AuthUser, otherId: string) => {
  const myCollege = verifiedCollegeOf(me);
  return {
    _id: otherId,
    ...ACTIVE_MEMBER,
    $or: [
      // I follow them, or they follow me (both directions are on their document).
      { followers: new Types.ObjectId(me.userId) },
      { following: new Types.ObjectId(me.userId) },
      ...(myCollege ? [verifiedMembersOf(myCollege)] : []),
    ],
  };
};

/** Non-throwing form, for showing a Message button. */
export const canDirectMessage = async (me: AuthUser, otherId: string): Promise<boolean> =>
  Types.ObjectId.isValid(otherId) && otherId !== me.userId && Boolean(await User.exists(messageableFilter(me, otherId)));

export const assertCanDirectMessage = async (me: AuthUser, otherId: string): Promise<void> => {
  if (!Types.ObjectId.isValid(otherId) || otherId === me.userId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose someone to message.');
  }
  if (!(await User.exists({ _id: otherId, ...ACTIVE_MEMBER }))) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (!(await User.exists(messageableFilter(me, otherId)))) {
    throw new ApiError(403, 'FORBIDDEN', 'You can message people you follow, who follow you, or who are verified at your college.');
  }
};

/** Group creation and membership need a verified college. */
export const assertVerifiedMember = (me: AuthUser): string => {
  const college = verifiedCollegeOf(me);
  if (!college) throw new ApiError(403, 'FORBIDDEN', 'Verify your college to use groups.');
  return college;
};
