import { RequestHandler } from 'express';
import { User, canUserUpvote, isUserVerified } from '../modules/users/user.model';
import { UserRole } from '../types';
import { ApiError, asyncHandler } from '../utils/apiError';
import { JwtPayload, verifyToken } from '../utils/jwt';

/**
 * Verifies the Bearer token and loads the user once per request.
 * `req.user.role` comes from the DB, so demoting a user takes effect immediately
 * instead of when their token expires. Tokens issued before a password reset are rejected.
 */
const authenticateWith = ({ allowUnverified }: { allowUnverified: boolean }) =>
  asyncHandler(async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHORIZED', 'No token provided');

    let payload: JwtPayload;
    try {
      payload = verifyToken(header.slice('Bearer '.length));
    } catch {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid token');
    }

    const user = await User.findById(payload.userId)
      .select(
        'email role college collegeEmailVerified collegeVerification.verified facultyStatus emailVerified managedCollege managerStatus accountVerified +tokenVersion'
      )
      .lean();
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'User not found');

    // A password reset logs out every device: tokens from an older version stop working.
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Session expired. Please sign in again.');
    }

    const accountVerified = user.accountVerified !== false;
    if (!accountVerified && !allowUnverified) {
      throw new ApiError(403, 'ACCOUNT_NOT_VERIFIED', 'Please verify your email address to continue.');
    }

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
      accountVerified,
    };
    next();
  });

/** Every signed-in route. Accounts that have not confirmed their signup email get 403. */
export const authenticate = authenticateWith({ allowUnverified: false });
/** Only for /auth/me and the verify-account endpoints, which unverified accounts must reach. */
export const authenticateUnverified = authenticateWith({ allowUnverified: true });

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
