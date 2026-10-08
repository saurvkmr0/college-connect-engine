import { Router } from 'express';
import { authenticate, requireVerified } from '../../middleware/auth';
import { commentLimit, reactionLimit } from '../../middleware/rateLimit';
import {
  addComment,
  createPost,
  deletePost,
  getComments,
  getPost,
  getLikers,
  getUpvoters,
  toggleLike,
  toggleUpvote,
  updatePost,
} from './post.controller';

const router = Router();

router.use(authenticate);

// Every signed-in user may read, like and comment (visibility rules still apply).
// Creating posts needs a verified college email; upvoting needs college-approved faculty/staff.
router.get('/:postId', getPost);
router.get('/:postId/comments', getComments);
router.get('/:postId/upvoters', getUpvoters);
router.get('/:postId/likers', getLikers);

router.post('/', requireVerified, createPost);
router.patch('/:postId', updatePost);
router.delete('/:postId', deletePost);
router.post('/:postId/like', reactionLimit, toggleLike);
router.post('/:postId/upvote', requireVerified, toggleUpvote);
router.post('/:postId/comments', commentLimit, addComment);

export default router;
