import { Router } from 'express';
import { authenticate, authenticateUnverified } from '../../middleware/auth';
import { loginLimit, rateLimit, resetLimit, signupLimit } from '../../middleware/rateLimit';
import {
  adminLogin,
  confirmAccount,
  forgotPassword,
  getMe,
  login,
  requestAccountCode,
  resetPassword,
  signup,
  updateProfile,
} from './auth.controller';

const router = Router();

// Fails closed: if Redis is down, admin login is refused rather than left open to brute force.
const adminLoginLimit = rateLimit({ name: 'admin-login', limit: 5, windowSeconds: 15 * 60, failOpen: false });

router.post('/admin-login', adminLoginLimit, adminLogin);
router.post('/signup', signupLimit, signup);
router.post('/login', loginLimit, login);
router.post('/forgot-password', resetLimit, forgotPassword);
router.post('/reset-password', resetLimit, resetPassword);
router.get('/me', authenticateUnverified, getMe);
router.post('/verify-account/request', authenticateUnverified, requestAccountCode);
router.post('/verify-account/confirm', authenticateUnverified, confirmAccount);
router.patch('/profile', authenticate, updateProfile);

export default router;
