import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { config } from '../../config';
import { IUser, UserRole } from '../../types';
import { ApiError, asyncHandler, sendSuccess } from '../../utils/apiError';
import { isValidEmail, normalizeEmail } from '../../utils/emailValidation';
import { generateToken } from '../../utils/jwt';
import { str } from '../../utils/request';
import { constantTimeEqual } from '../../utils/secureCompare';
import { COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { User } from '../users/user.model';

const BCRYPT_ROUNDS = 12;
const PASSWORD_MIN = 8;
// bcrypt ignores everything after 72 bytes.
const PASSWORD_MAX = 72;

/** Roles a person may pick at signup. `admin` is deliberately not among them. */
const SIGNUP_ROLES: string[] = [UserRole.STUDENT, UserRole.FACULTY, UserRole.STAFF];

/** Compared against when the email is unknown, so response time does not reveal which emails exist. */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

const password = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The signed-in user's own profile, in one shape for signup, login and /me:
 * populated college, both `id` and `_id`, never the password.
 */
const getSelf = async (userId: Types.ObjectId | string) => {
  const user = await User.findById(userId)
    .select('-__v')
    .populate('college', COLLEGE_SUMMARY_FIELDS)
    .lean();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return { ...user, id: user._id };
};

const sendSession = async (res: Response, status: number, user: IUser) => {
  res.status(status).json({ token: generateToken(user), user: await getSelf(user._id) });
};

export const signup = asyncHandler(async (req, res) => {
  const name = str(req.body?.name);
  const email = normalizeEmail(str(req.body?.email));
  const plain = password(req.body?.password);

  if (!name || !email || !plain) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Name, email, and password are required');
  }
  if (!isValidEmail(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  if (plain.length < PASSWORD_MIN || plain.length > PASSWORD_MAX) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`
    );
  }

  // The admin email is reserved: registering it first would let someone take over the
  // admin account. Same message as a normal duplicate so the admin email is not revealed.
  if (email === config.admin.email || (await User.exists({ email }))) {
    throw new ApiError(409, 'CONFLICT', 'Email already registered');
  }

  // Never trust a client-supplied role: anything outside the list (including 'admin') becomes student.
  const requestedRole = str(req.body?.role).toLowerCase();
  const role = SIGNUP_ROLES.includes(requestedRole) ? (requestedRole as UserRole) : UserRole.STUDENT;

  const user = await User.create({
    name,
    email,
    password: await bcrypt.hash(plain, BCRYPT_ROUNDS),
    role,
  });

  await sendSession(res, 201, user);
});

export const login = asyncHandler(async (req, res) => {
  const email = normalizeEmail(str(req.body?.email));
  const plain = password(req.body?.password);
  if (!email || !plain) throw new ApiError(400, 'VALIDATION_ERROR', 'Email and password are required');

  const user = await User.findOne({ email }).select('+password');
  const matches = await bcrypt.compare(plain, user?.password ?? DUMMY_HASH);

  // One message for unknown email and wrong password, so accounts cannot be enumerated.
  if (!user || !matches) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');

  await sendSession(res, 200, user);
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
  const passwordMatches = constantTimeEqual(password(req.body?.password), adminPassword);
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
