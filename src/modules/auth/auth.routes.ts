import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { str } from '../../utils/request';
import { adminLogin, getMe, login, signup, updateProfile } from './auth.controller';

const router = Router();

const FIFTEEN_MINUTES = 15 * 60;

// Keyed by IP + email so one shared campus IP (NAT) does not lock out every student.
const loginLimit = rateLimit({
  name: 'login',
  limit: 10,
  windowSeconds: FIFTEEN_MINUTES,
  keyBy: (req) => `${req.ip}:${str(req.body?.email).toLowerCase()}`,
});
// Fails closed: if Redis is down, admin login is refused rather than left open to brute force.
const adminLoginLimit = rateLimit({ name: 'admin-login', limit: 5, windowSeconds: FIFTEEN_MINUTES, failOpen: false });
const signupLimit = rateLimit({ name: 'signup', limit: 20, windowSeconds: 60 * 60 });

router.post('/admin-login', adminLoginLimit, adminLogin);
router.post('/signup', signupLimit, signup);
router.post('/login', loginLimit, login);
router.get('/me', authenticate, getMe);
router.patch('/profile', authenticate, updateProfile);

export default router;
