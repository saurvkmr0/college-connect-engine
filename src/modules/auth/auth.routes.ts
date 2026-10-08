import { Router } from 'express';
import { authenticate, authenticateUnverified } from '../../middleware/auth';
import { loginLimit, rateLimit, resetLimit, signupLimit } from '../../middleware/rateLimit';
import {
  adminLogin,
  confirmAccount,
  facultyReapply,
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

// A reapply re-notifies the college rep, so cap it per user.
const reapplyLimit = rateLimit({ name: 'faculty-reapply', limit: 3, windowSeconds: 24 * 60 * 60, keyBy: (req) => req.user!.userId });

router.post('/admin-login', adminLoginLimit, adminLogin);
router.post('/signup', signupLimit, signup);
router.post('/login', loginLimit, login);
router.post('/forgot-password', resetLimit, forgotPassword);
router.post('/reset-password', resetLimit, resetPassword);
router.get('/me', authenticateUnverified, getMe);
router.post('/verify-account/request', authenticateUnverified, requestAccountCode);
router.post('/verify-account/confirm', authenticateUnverified, confirmAccount);
router.patch('/profile', authenticate, updateProfile);
router.post('/faculty-reapply', authenticate, reapplyLimit, facultyReapply);

export default router;
