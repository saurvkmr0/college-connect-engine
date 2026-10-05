import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { config } from '../../config';
import { UserRole } from '../../types';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { isValidEmail, normalizeEmail } from '../../utils/emailValidation';
import { generateToken } from '../../utils/jwt';
import { str } from '../../utils/request';
import { constantTimeEqual } from '../../utils/secureCompare';
import { MEMBER_ROLES, User } from '../users/user.model';
import { consumeOtp, issueOtp } from '../verification/otp.service';
import { claimAssets, isObjectKey, releaseObject, unclaimAssets } from '../media/media.service';
import {
  assertValidPassword,
  BCRYPT_ROUNDS,
  findByCredentials,
  getSelf,
  hashPassword,
  parseNewAccount,
  readPassword,
  sessionPayload,
} from './auth.service';

/** Roles a person may pick at signup. `admin` and `college_rep` are deliberately not among them. */
const SIGNUP_ROLES: string[] = [UserRole.STUDENT, UserRole.FACULTY, UserRole.STAFF];

export const signup = asyncHandler(async (req, res) => {
  const account = await parseNewAccount(req.body);

  // Never trust a client-supplied role: anything outside the list becomes student.
  const requestedRole = str(req.body?.role).toLowerCase();
  const role = SIGNUP_ROLES.includes(requestedRole) ? (requestedRole as UserRole) : UserRole.STUDENT;

  const user = await User.create({
    ...account,
    password: await hashPassword(account.password),
    role,
    // Faculty/staff powers (upvote) wait for their college's approval.
    ...(role !== UserRole.STUDENT && { facultyStatus: 'pending' }),
    // Students prove they own their signup email before using the app.
    ...(role === UserRole.STUDENT && { accountVerified: false }),
  });

  if (role === UserRole.STUDENT) {
    try {
      await issueOtp('account', user._id.toString(), user.email);
    } catch (error) {
      // No code reached the student, so the account must not exist yet: remove it and report
      // the error. The signup form stays open and the same email can simply be retried.
      await User.deleteOne({ _id: user._id });
      throw error;
    }
  }

  res.status(201).json(await sessionPayload(user));
});

/** Resend the signup code (unverified accounts only). */
export const requestAccountCode = asyncHandler(async (req, res) => {
  if (req.user!.accountVerified) throw new ApiError(409, 'ALREADY_VERIFIED', 'Your email is already verified.');
  await issueOtp('account', req.user!.userId, req.user!.email);
  sendSuccess(res, 200, 'Verification code sent to your email.');
});

/** Confirm the signup code; the account is unlocked. */
export const confirmAccount = asyncHandler(async (req, res) => {
  if (req.user!.accountVerified) throw new ApiError(409, 'ALREADY_VERIFIED', 'Your email is already verified.');
  await consumeOtp('account', req.user!.userId, req.user!.email, req.body?.otp);
  await User.updateOne({ _id: req.user!.userId }, { $set: { accountVerified: true } });
  res.json({ user: await getSelf(req.user!.userId) });
});

export const login = asyncHandler(async (req, res) => {
  const user = await findByCredentials(req.body);
  // Rep accounts live in the college portal only.
  if (user.role === UserRole.COLLEGE_REP) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'This is a college portal account. Sign in at the college portal.');
  }
  res.json(await sessionPayload(user));
});

/**
 * POST /api/auth/admin-login
 *
 * Standalone admin sign-in. Credentials are matched against ADMIN_EMAIL / ADMIN_PASSWORD;
 * there is no admin signup. A backing User with role `admin` is upserted so the normal
 * `authenticate` / `requireRole('admin')` middleware work unchanged.
 */
export const adminLogin = asyncHandler(async (req, res) => {
  const { email: adminEmail, password: adminPassword } = config.admin;
  if (!adminEmail || !adminPassword) {
    throw new ApiError(
      503,
      'AUTH_NOT_CONFIGURED',
      'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment.'
    );
  }

  // Evaluate both comparisons (no short-circuit) so timing reveals nothing.
  const emailMatches = constantTimeEqual(normalizeEmail(str(req.body?.email)), adminEmail);
  const passwordMatches = constantTimeEqual(readPassword(req.body?.password), adminPassword);
  if (!emailMatches || !passwordMatches) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid admin credentials.');
  }

  let user = await User.findOne({ email: adminEmail });
  if (!user || user.role !== UserRole.ADMIN) {
    // The stored hash is random: the env password is the only way in. If someone had
    // registered this email before, their password stops working when it is promoted.
    user = await User.findOneAndUpdate(
      { email: adminEmail },
      {
        $set: {
          role: UserRole.ADMIN,
          password: await bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS),
        },
        $setOnInsert: { name: 'Administrator' },
      },
      { upsert: true, new: true }
    );
  }
  const admin = user!;

  sendSuccess(res, 200, 'Signed in', {
    token: generateToken(admin),
    user: { id: admin._id, _id: admin._id, name: admin.name, email: admin.email, role: admin.role },
  });
});

export const getMe = asyncHandler(async (req, res) => {
  res.json({ user: await getSelf(req.user!.userId) });
});

/** Only these fields can be edited; anything else in the body is ignored. */
const PROFILE_TEXT_FIELDS = ['name', 'bio', 'department'] as const;
/** Images are uploaded first; the profile only accepts the resulting asset ids ('' clears). */
const PROFILE_IMAGES = {
  avatarAssetId: { field: 'avatar', resource: 'avatar' },
  bannerAssetId: { field: 'banner', resource: 'banner' },
} as const;

export const updateProfile = asyncHandler(async (req, res) => {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  for (const field of PROFILE_TEXT_FIELDS) {
    if (typeof req.body?.[field] === 'string') $set[field] = req.body[field].trim();
  }
  if (req.body?.graduationYear !== undefined) $set.graduationYear = Number(req.body.graduationYear);

  const before = await User.findById(req.user!.userId).select('avatar banner').lean();
  const replaced: string[] = [];
  const claimed: string[] = [];
  try {
    for (const [param, { field, resource }] of Object.entries(PROFILE_IMAGES)) {
      if (req.body?.[param] === undefined) continue;
      const assetId = str(req.body[param]);
      if (assetId) {
        const [media] = await claimAssets(req.user!, assetId, [resource]);
        $set[field] = media.objectKey;
        claimed.push(media.assetId);
      } else {
        $unset[field] = 1;
      }
      if (isObjectKey(before?.[field])) replaced.push(before![field]!);
    }
    // runValidators enforces the schema limits (required name, maxlength, year range) on updates too.
    await User.updateOne({ _id: req.user!.userId }, { $set, $unset }, { runValidators: true });
  } catch (error) {
    // e.g. avatar attached but banner failed: release everything so the same uploads can be retried.
    await unclaimAssets(claimed);
    throw error;
  }
  // Only after the DB points at the new image: delete the old object (failures retried by the sweeper).
  await Promise.all(replaced.map(releaseObject));

  res.json({ user: await getSelf(req.user!.userId) });
});

/* ------------------------------------------------------------------ */
/* Forgot password (member accounts)                                    */
/* ------------------------------------------------------------------ */

const FORGOT_MESSAGE = 'If an account exists for this email, we sent a code to reset the password.';
const invalidCode = () => new ApiError(400, 'INVALID_OTP', 'Invalid or expired code.');

const findMember = (email: string) =>
  User.findOne({ email, role: { $in: MEMBER_ROLES } }).select('_id').lean();

/** Always the same answer, so nobody can learn which emails are registered. */
export const forgotPassword = asyncHandler(async (req, res) => {
  const email = normalizeEmail(str(req.body?.email));
  if (!isValidEmail(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');

  const user = await findMember(email);
  // Cooldown/send errors are swallowed too - they would reveal that the account exists.
  // Not awaited: waiting for the mail send would make known emails measurably slower.
  if (user) void issueOtp('reset', user._id.toString(), email).catch(() => undefined);
  sendSuccess(res, 200, FORGOT_MESSAGE);
});

/**
 * Sets a new password with the emailed code. Unknown email, missing code and wrong code all
 * get the same error. Logs out every existing session and, since the email is now proven,
 * unlocks an unverified account.
 */
export const resetPassword = asyncHandler(async (req, res) => {
  const email = normalizeEmail(str(req.body?.email));
  const plain = readPassword(req.body?.password);
  assertValidPassword(plain);

  const user = email ? await findMember(email) : null;
  if (!user) throw invalidCode();
  try {
    await consumeOtp('reset', user._id.toString(), email, req.body?.otp);
  } catch (error) {
    // Wrong, expired AND too-many-attempts all look like an unknown email. Only an outage (503) passes.
    if (error instanceof ApiError && error.status !== 503) throw invalidCode();
    throw error;
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { password: await hashPassword(plain), accountVerified: true }, $inc: { tokenVersion: 1 } }
  );
  sendSuccess(res, 200, 'Password updated. Sign in with your new password.');
});
