import { UserRole } from '../../types';
import { ApiError } from '../../utils/apiError';
import { extractDomain, isValidEmail, normalizeEmail } from '../../utils/emailValidation';
import { str } from '../../utils/request';
import { College, PUBLIC_COLLEGE } from '../colleges/college.model';
import { User, isUserVerified } from '../users/user.model';
import { consumeOtp, issueOtp } from './otp.service';

export interface VerifiedCollege {
  id: string;
  name: string;
}

const MAX_BATCH_YEARS = 8;

/** Stream + batch years that students give with their college email. Throws 400 when invalid. */
const parseStudentDetails = (body: Record<string, unknown>) => {
  const stream = str(body.stream);
  const batchStart = Number(body.batchStart);
  const batchEnd = Number(body.batchEnd);
  const isYear = (y: number) => Number.isInteger(y) && y >= 1950 && y <= 2100;

  if (!stream || stream.length > 100) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Please enter your stream (up to 100 characters).');
  }
  if (!isYear(batchStart) || !isYear(batchEnd) || batchEnd < batchStart || batchEnd - batchStart > MAX_BATCH_YEARS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Batch must be valid years, "to" not before "from", at most ${MAX_BATCH_YEARS} years.`);
  }
  return { stream, batchStart, batchEnd };
};

/**
 * Step 1: the user picks their college and gives an email on one of THAT college's domains
 * (students also give stream + batch). A hashed OTP is stored and the code emailed.
 * The college comes from the chosen id and is re-checked against the email - never trusted alone.
 */
export const requestOtp = async (userId: string, rawBody: unknown): Promise<void> => {
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (user.role === UserRole.COLLEGE_REP) {
    throw new ApiError(403, 'FORBIDDEN', 'College portal accounts cannot verify as students.');
  }
  if (isUserVerified(user)) {
    throw new ApiError(409, 'ALREADY_VERIFIED', 'Your college email is already verified.');
  }

  const collegeId = str(body.collegeId);
  if (!collegeId) throw new ApiError(400, 'VALIDATION_ERROR', 'Please choose your college.');
  const email = normalizeEmail(str(body.email));
  if (!isValidEmail(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');

  const college = await College.findOne({ _id: collegeId, ...PUBLIC_COLLEGE }).select('name domains').lean();
  if (!college) throw new ApiError(404, 'NOT_FOUND', 'College not found');
  if (!college.domains.includes(extractDomain(email))) {
    throw new ApiError(400, 'EMAIL_DOMAIN_MISMATCH', `This email domain does not belong to ${college.name}.`);
  }

  const details = user.role === UserRole.STUDENT ? parseStudentDetails(body) : {};
  await issueOtp('college', userId, email, {
    collegeName: college.name,
    context: { collegeId: college._id.toString(), ...details },
  });
};

/**
 * Step 2: compare the submitted OTP with the hash stored in Redis and, on
 * success, mark the user as verified.
 */
export const verifyOtp = async (
  userId: string,
  rawEmail: unknown,
  rawOtp: unknown
): Promise<VerifiedCollege> => {
  const email = normalizeEmail(typeof rawEmail === 'string' ? rawEmail : '');
  if (!isValidEmail(email)) {
    throw new ApiError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  }

  // Throws on a wrong/expired code; the OTP is consumed once it matches.
  const record = await consumeOtp('college', userId, email, rawOtp);

  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (isUserVerified(user)) {
    throw new ApiError(409, 'ALREADY_VERIFIED', 'Your college email is already verified.');
  }

  const college = await College.findOne({ _id: record.context?.collegeId, active: true }).select('name active');
  if (!college) {
    // College was disabled after the OTP was issued.
    throw new ApiError(400, 'UNSUPPORTED_COLLEGE_DOMAIN', 'This email domain is not supported for college verification.');
  }

  user.collegeVerification = {
    verified: true,
    collegeId: college._id,
    collegeEmail: email,
    method: 'email',
    verifiedAt: new Date(),
  };
  // Students: the stream and batch they gave when requesting the code.
  const { stream, batchStart, batchEnd } = record.context ?? {};
  if (user.role === UserRole.STUDENT && typeof stream === 'string') {
    user.stream = stream;
    user.batchStart = Number(batchStart);
    user.batchEnd = Number(batchEnd);
  }
  // Keep the legacy fields in sync so existing gates (posting, feeds) work.
  user.college = college._id;
  user.collegeEmail = email;
  user.collegeEmailVerified = true;
  await user.save();

  return { id: college._id.toString(), name: college.name };
};
