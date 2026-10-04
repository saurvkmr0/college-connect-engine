import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { reactionLimit } from '../../middleware/rateLimit';
import { followUser, getFollowers, getFollowing, getUserPosts, getUserProfile, searchUsers } from './user.controller';

const router = Router();

router.use(authenticate);

router.get('/search', searchUsers);
router.get('/:userId', getUserProfile);
router.get('/:userId/posts', getUserPosts);
router.post('/:userId/follow', reactionLimit, followUser);
router.get('/:userId/followers', getFollowers);
router.get('/:userId/following', getFollowing);

export default router;
