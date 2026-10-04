import { sendEmail } from '../../services/email/emailProvider';
import { buildOtpEmail } from '../../services/email/templates';
import { UserRole } from '../../types';
import { ApiError } from '../../utils/apiError';
import { isValidEmail, normalizeEmail } from '../../utils/emailValidation';
import { College } from '../colleges/college.model';
import { validateCollegeEmail } from '../colleges/college.service';
import { User, isUserVerified } from '../users/user.model';
import {
  deleteOtpRecord,
  generateOtp,
  getOtpRecord,
  hashOtp,
  HOURLY_REQUEST_LIMIT,
  incrementHourlyRequests,
  MAX_VERIFY_ATTEMPTS,
  OTP_TTL_SECONDS,
  saveOtpRecord,
  saveOtpRecordKeepingTtl,
  startResendCooldown,
  clearVerificationRateLimits,
  getResendCooldown,
  verifyOtpHash,
  OtpRecord,
} from './otp.service';

export interface VerifiedCollege {
  id: string;
  name: string;
}

/**
 * Rate-limits, stores a hashed OTP for `userId` (5 min TTL) and emails the code.
 * Shared by student college verification and rep email verification. Never returns the OTP.
 */
export const issueOtp = async (
  userId: string,
  email: string,
  collegeId: string,
  collegeName?: string
): Promise<void> => {
  const cooldown = await getResendCooldown(userId);
  if (cooldown > 0) {
    throw new ApiError(429, 'OTP_REQUEST_TOO_FREQUENT', 'Please wait a minute before requesting another code.');
  }
  const hourlyCount = await incrementHourlyRequests(userId);
  if (hourlyCount > HOURLY_REQUEST_LIMIT) {
    throw new ApiError(429, 'OTP_HOURLY_LIMIT_EXCEEDED', 'Too many verification requests. Please try again later.');
  }

  const code = generateOtp();
  // Writing the record replaces any previous OTP for this user.
  await saveOtpRecord(userId, { email, collegeId, otpHash: hashOtp(code), attempts: 0 });
  await startResendCooldown(userId);

  try {
    const { subject, text, html } = buildOtpEmail({
      code,
      collegeName,
      expiresInMinutes: Math.round(OTP_TTL_SECONDS / 60),
    });
    await sendEmail({ to: email, subject, text, html });
  } catch {
    // The code never reached the user - invalidate it rather than leave it live.
    await deleteOtpRecord(userId);
    throw new ApiError(502, 'EMAIL_SEND_FAILED', 'We could not send the verification email. Please try again.');
  }
};

/**
 * Checks a submitted code against the stored hash. On success the OTP is deleted and
 * the record returned; wrong codes count towards MAX_VERIFY_ATTEMPTS (KEEPTTL).
 */
export const consumeOtp = async (userId: string, email: string, rawOtp: unknown): Promise<OtpRecord> => {
  const record = await getOtpRecord(userId);
  if (!record) {
    // Missing and expired records share a code: Redis drops expired keys.
    throw new ApiError(400, 'OTP_EXPIRED', 'The verification code has expired. Please request a new code.');
  }
  // The code must be used with the email it was issued for.
  if (record.email !== email) {
    throw new ApiError(400, 'EMAIL_MISMATCH', 'The email does not match the pending verification request.');
  }
  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    await deleteOtpRecord(userId);
    throw new ApiError(429, 'MAX_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Please request a new code.');
  }

  const submitted = typeof rawOtp === 'string' || typeof rawOtp === 'number' ? String(rawOtp).trim() : '';
  if (!submitted || !verifyOtpHash(submitted, record.otpHash)) {
    const attempts = record.attempts + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await deleteOtpRecord(userId);
      throw new ApiError(429, 'MAX_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Please request a new code.');
    }
    await saveOtpRecordKeepingTtl(userId, { ...record, attempts });
    throw new ApiError(400, 'INVALID_OTP', 'Invalid verification code.');
  }

  await deleteOtpRecord(userId);
  return record;
};

/**
 * Step 1: validate the email, resolve the college from its domain, store a
 * hashed OTP in Redis (5 min TTL) and email the plaintext code.
 * Never returns the OTP.
 */
export const requestOtp = async (userId: string, rawEmail: unknown): Promise<void> => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (user.role === UserRole.COLLEGE_REP) {
    throw new ApiError(403, 'FORBIDDEN', 'College portal accounts cannot verify as students.');
  }

  if (isUserVerified(user)) {
    throw new ApiError(409, 'ALREADY_VERIFIED', 'Your college email is already verified.');
  }

  const email = normalizeEmail(typeof rawEmail === 'string' ? rawEmail : '');
  if (!isValidEmail(email)) {
    throw new ApiError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  }

  const validation = await validateCollegeEmail(email);
  if (!validation.valid) {
    if (validation.reason === 'INVALID_EMAIL') {
      throw new ApiError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
    }
    throw new ApiError(
      400,
      'UNSUPPORTED_COLLEGE_DOMAIN',
      'This email domain is not supported for college verification.'
    );
  }

  await issueOtp(userId, email, validation.college.id, validation.college.name);
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
  const record = await consumeOtp(userId, email, rawOtp);

  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  if (isUserVerified(user)) {
    throw new ApiError(409, 'ALREADY_VERIFIED', 'Your college email is already verified.');
  }

  const college = await College.findOne({ _id: record.collegeId, active: true }).select('name active');
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
  // Keep the legacy fields in sync so existing gates (posting, feeds) work.
  user.college = college._id;
  user.collegeEmail = email;
  user.collegeEmailVerified = true;
  await user.save();

  // Success resets the rate-limit counters.
  await clearVerificationRateLimits(userId);

  return { id: college._id.toString(), name: college.name };
};
