import { asyncHandler, sendSuccess } from '../../utils/apiError';
import { requestOtp, verifyOtp } from './verification.service';

/**
 * POST /api/college-verification/request-otp
 * Body: { email }
 * The college is derived from the email domain - `collegeId` in the body is ignored.
 */
export const requestOtpController = asyncHandler(async (req, res) => {
  await requestOtp(req.user!.userId, req.body?.email);
  sendSuccess(res, 200, 'Verification code sent to your college email.');
});

/**
 * POST /api/college-verification/verify-otp
 * Body: { email, otp }
 */
export const verifyOtpController = asyncHandler(async (req, res) => {
  const college = await verifyOtp(req.user!.userId, req.body?.email, req.body?.otp);
  sendSuccess(res, 200, 'College email verified successfully.', { college });
});
