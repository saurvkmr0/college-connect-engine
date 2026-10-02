import { sendEmail } from '../../services/email/emailProvider';
import { buildOtpEmail } from '../../services/email/templates';
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
} from './otp.service';

export interface VerifiedCollege {
  id: string;
  name: string;
}

/**
 * Step 1: validate the email, resolve the college from its domain, store a
 * hashed OTP in Redis (5 min TTL) and email the plaintext code.
 * Never returns the OTP.
 */
export const requestOtp = async (userId: string, rawEmail: unknown): Promise<void> => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

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

  // --- Rate limiting (server side, Redis) ---
  const cooldown = await getResendCooldown(userId);
  if (cooldown > 0) {
    throw new ApiError(
      429,
      'OTP_REQUEST_TOO_FREQUENT',
      'Please wait a minute before requesting another code.'
    );
  }

  const hourlyCount = await incrementHourlyRequests(userId);
  if (hourlyCount > HOURLY_REQUEST_LIMIT) {
    throw new ApiError(
      429,
      'OTP_HOURLY_LIMIT_EXCEEDED',
      'Too many verification requests. Please try again later.'
    );
  }

  const code = generateOtp();
  const otpHash = hashOtp(code);

  // Writing the record replaces any previous OTP for this user.
  await saveOtpRecord(userId, {
    email,
    collegeId: validation.college.id,
    otpHash,
    attempts: 0,
  });
  await startResendCooldown(userId);

  try {
    const { subject, text, html } = buildOtpEmail({
      code,
      collegeName: validation.college.name,
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

  const record = await getOtpRecord(userId);
  if (!record) {
    // Missing and expired records share a code: Redis drops expired keys.
    throw new ApiError(
      400,
      'OTP_EXPIRED',
      'The verification code has expired. Please request a new code.'
    );
  }

  // The code must be used with the email it was issued for.
  if (record.email !== email) {
    throw new ApiError(
      400,
      'EMAIL_MISMATCH',
      'The email does not match the pending verification request.'
    );
  }

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    await deleteOtpRecord(userId);
    throw new ApiError(
      429,
      'MAX_ATTEMPTS_EXCEEDED',
      'Too many incorrect attempts. Please request a new code.'
    );
  }

  const submitted = typeof rawOtp === 'string' || typeof rawOtp === 'number' ? String(rawOtp).trim() : '';
  const matches = submitted.length > 0 && verifyOtpHash(submitted, record.otpHash);

  if (!matches) {
    const attempts = record.attempts + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await deleteOtpRecord(userId);
      throw new ApiError(
        429,
        'MAX_ATTEMPTS_EXCEEDED',
        'Too many incorrect attempts. Please request a new code.'
      );
    }
    // KEEPTTL keeps the original 5 minute expiry intact.
    await saveOtpRecordKeepingTtl(userId, { ...record, attempts });
    throw new ApiError(400, 'INVALID_OTP', 'Invalid verification code.');
  }

  // --- OTP is correct: load everything before consuming it ---
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  if (isUserVerified(user)) {
    await deleteOtpRecord(userId);
    throw new ApiError(409, 'ALREADY_VERIFIED', 'Your college email is already verified.');
  }

  const college = await College.findOne({ _id: record.collegeId, active: true }).select('name active');
  if (!college) {
    // College was disabled after the OTP was issued.
    await deleteOtpRecord(userId);
    throw new ApiError(
      400,
      'UNSUPPORTED_COLLEGE_DOMAIN',
      'This email domain is not supported for college verification.'
    );
  }

  const verifiedAt = new Date();

  user.collegeVerification = {
    verified: true,
    collegeId: college._id,
    collegeEmail: email,
    method: 'email',
    verifiedAt,
  };
  // Keep the legacy fields in sync so existing gates (posting, feeds) work.
  user.college = college._id;
  user.collegeEmail = email;
  user.collegeEmailVerified = true;

  await user.save();

  // Success invalidates the OTP and resets the rate-limit counters.
  await deleteOtpRecord(userId);
  await clearVerificationRateLimits(userId);

  return { id: college._id.toString(), name: college.name };
};
