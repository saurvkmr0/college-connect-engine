import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requestOtpController, verifyOtpController } from './verification.controller';

const router = Router();

// Both endpoints require an authenticated user; OTPs and rate limits are tied to that user id.
router.use(authenticate);

router.post('/request-otp', requestOtpController);
router.post('/verify-otp', verifyOtpController);

export default router;
