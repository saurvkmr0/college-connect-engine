import { RequestHandler } from 'express';
import { User, canUserUpvote, isUserVerified } from '../modules/users/user.model';
import { UserRole } from '../types';
import { ApiError, asyncHandler } from '../utils/apiError';
import { JwtPayload, verifyToken } from '../utils/jwt';

/**
 * Verifies the Bearer token and loads the user once per request.
 * `req.user.role` comes from the DB, so demoting a user takes effect immediately
 * instead of when their token expires.
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHORIZED', 'No token provided');

  let payload: JwtPayload;
  try {
    payload = verifyToken(header.slice('Bearer '.length));
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid token');
  }

  const user = await User.findById(payload.userId)
    .select('email role college collegeEmailVerified collegeVerification.verified facultyStatus emailVerified managedCollege managerStatus')
    .lean();
  if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'User not found');

  const verified = Boolean(user.college) && isUserVerified(user);
  req.user = {
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    collegeId: user.college?.toString(),
    verified,
    canUpvote: verified && canUserUpvote(user),
    emailVerified: Boolean(user.emailVerified),
    managedCollegeId: user.managedCollege?.toString(),
    managerStatus: user.managerStatus,
  };
  next();
});

/** Use after `authenticate`. */
export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
    }
    next();
  };

/** Use after `authenticate`. Unverified users can read the global feed but cannot post or interact. */
export const requireVerified: RequestHandler = (req, _res, next) => {
  if (!req.user?.verified) {
    throw new ApiError(
      403,
      'VERIFICATION_REQUIRED',
      'College verification required. Please verify your college email.'
    );
  }
  next();
};
