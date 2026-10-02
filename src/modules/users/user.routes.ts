import { Router } from 'express';
import { authenticate, requireVerified } from '../../middleware/auth';
import { followUser, getFollowers, getFollowing, getUserProfile, searchUsers } from './user.controller';

const router = Router();

router.use(authenticate);

router.get('/search', searchUsers);
router.get('/:userId', getUserProfile);
router.post('/:userId/follow', requireVerified, followUser);
router.get('/:userId/followers', getFollowers);
router.get('/:userId/following', getFollowing);

export default router;
