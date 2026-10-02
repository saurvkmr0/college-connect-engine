import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { requestOtp, verifyOtp } from '../services/collegeVerification.service';
import { handleControllerError, sendSuccess } from '../utils/apiError';

/**
 * POST /api/college-verification/request-otp
 * Body: { email }
 * The college is derived from the email domain - `collegeId` in the body is ignored.
 */
export const requestOtpController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await requestOtp(req.user!.userId, req.body?.email);
    sendSuccess(res, 200, 'Verification code sent to your college email.');
  } catch (error) {
    handleControllerError(res, error, 'Request OTP');
  }
};

/**
 * POST /api/college-verification/verify-otp
 * Body: { email, otp }
 */
export const verifyOtpController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const college = await verifyOtp(req.user!.userId, req.body?.email, req.body?.otp);
    sendSuccess(res, 200, 'College email verified successfully.', { college });
  } catch (error) {
    handleControllerError(res, error, 'Verify OTP');
  }
};
