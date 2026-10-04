import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { config } from '../../config';
import { IUser } from '../../types';
import { ApiError } from '../../utils/apiError';
import { isValidEmail, normalizeEmail } from '../../utils/emailValidation';
import { generateToken } from '../../utils/jwt';
import { str } from '../../utils/request';
import { COLLEGE_SUMMARY_FIELDS } from '../colleges/college.model';
import { User } from '../users/user.model';

/** Shared by student signup/login and the college portal. */

export const BCRYPT_ROUNDS = 12;
const PASSWORD_MIN = 8;
// bcrypt ignores everything after 72 bytes.
const PASSWORD_MAX = 72;

/** Compared against when the email is unknown, so response time does not reveal which emails exist. */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

export const readPassword = (value: unknown): string => (typeof value === 'string' ? value : '');
export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_ROUNDS);

/** Validates name/email/password for a new account. Throws 400 / 409. */
export const parseNewAccount = async (body: unknown) => {
  const source = (body ?? {}) as Record<string, unknown>;
  const name = str(source.name);
  const email = normalizeEmail(str(source.email));
  const password = readPassword(source.password);

  if (!name || !email || !password) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Name, email, and password are required');
  }
  if (!isValidEmail(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  }
  // The admin email is reserved: registering it first would let someone take over the
  // admin account. Same message as a normal duplicate so the admin email is not revealed.
  if (email === config.admin.email || (await User.exists({ email }))) {
    throw new ApiError(409, 'CONFLICT', 'Email already registered');
  }
  return { name, email, password };
};

/** Returns the user when email + password match. One 401 message for every failure. */
export const findByCredentials = async (body: unknown): Promise<IUser> => {
  const source = (body ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(str(source.email));
  const password = readPassword(source.password);
  if (!email || !password) throw new ApiError(400, 'VALIDATION_ERROR', 'Email and password are required');

  const user = await User.findOne({ email }).select('+password');
  const matches = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !matches) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  return user;
};

/**
 * The signed-in user's own profile, in one shape for signup, login and /me:
 * populated college, both `id` and `_id`, never the password.
 */
export const getSelf = async (userId: Types.ObjectId | string) => {
  const user = await User.findById(userId)
    .select('-__v')
    .populate('college', COLLEGE_SUMMARY_FIELDS)
    .lean();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return { ...user, id: user._id };
};

/** `{ token, user }` returned by every login/signup endpoint. */
export const sessionPayload = async (user: IUser) => ({
  token: generateToken(user),
  user: await getSelf(user._id),
});
