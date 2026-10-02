import { Router } from 'express';
import { requestOtpController, verifyOtpController } from '../controllers/collegeVerification.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

// Both endpoints require an authenticated user; OTPs are tied to that user id.
router.post('/request-otp', authenticate, requestOtpController);
router.post('/verify-otp', authenticate, verifyOtpController);

export default router;
