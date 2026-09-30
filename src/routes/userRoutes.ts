import { Router } from 'express';
import {
  getUserProfile,
  followUser,
  getFollowers,
  getFollowing,
  searchUsers,
} from '../controllers/userController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/search', authenticate, searchUsers);
router.get('/:userId', authenticate, getUserProfile);
router.post('/:userId/follow', authenticate, followUser);
router.get('/:userId/followers', authenticate, getFollowers);
router.get('/:userId/following', authenticate, getFollowing);

export default router;
