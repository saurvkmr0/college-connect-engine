import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { config } from '../../config';
import { UserRole } from '../../types';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { normalizeEmail } from '../../utils/emailValidation';
import { generateToken } from '../../utils/jwt';
import { str } from '../../utils/request';
import { constantTimeEqual } from '../../utils/secureCompare';
import { User } from '../users/user.model';
import {
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
  });

  res.status(201).json(await sessionPayload(user));
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
const PROFILE_TEXT_FIELDS = ['name', 'bio', 'department', 'avatar'] as const;

export const updateProfile = asyncHandler(async (req, res) => {
  const updates: Record<string, unknown> = {};
  for (const field of PROFILE_TEXT_FIELDS) {
    if (typeof req.body?.[field] === 'string') updates[field] = req.body[field].trim();
  }
  if (req.body?.graduationYear !== undefined) updates.graduationYear = Number(req.body.graduationYear);

  // runValidators enforces the schema limits (required name, maxlength, year range) on updates too.
  await User.updateOne({ _id: req.user!.userId }, { $set: updates }, { runValidators: true });

  res.json({ user: await getSelf(req.user!.userId) });
});
