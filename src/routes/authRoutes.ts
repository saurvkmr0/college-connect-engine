import { Router } from 'express';
import {
  signup,
  login,
  getMe,
  verifyCollegeEmail,
  updateProfile,
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', authenticate, getMe);
router.post('/verify-college', authenticate, verifyCollegeEmail);
router.patch('/profile', authenticate, updateProfile);

export default router;
