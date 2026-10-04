import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { loginLimit, rateLimit, signupLimit } from '../../middleware/rateLimit';
import { adminLogin, getMe, login, signup, updateProfile } from './auth.controller';

const router = Router();

// Fails closed: if Redis is down, admin login is refused rather than left open to brute force.
const adminLoginLimit = rateLimit({ name: 'admin-login', limit: 5, windowSeconds: 15 * 60, failOpen: false });

router.post('/admin-login', adminLoginLimit, adminLogin);
router.post('/signup', signupLimit, signup);
router.post('/login', loginLimit, login);
router.get('/me', authenticate, getMe);
router.patch('/profile', authenticate, updateProfile);

export default router;
