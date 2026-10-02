import { Router } from 'express';
import {
  adminLogin,
  signup,
  login,
  getMe,
  updateProfile,
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';

const router = Router();

// Standalone admin panel sign-in (env-gated, no signup).
router.post('/admin-login', adminLogin);

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', authenticate, getMe);
router.patch('/profile', authenticate, updateProfile);

export default router;
