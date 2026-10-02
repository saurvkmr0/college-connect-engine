import { Router } from 'express';
import { authenticate, requireVerified } from '../../middleware/auth';
import {
  addComment,
  createPost,
  deletePost,
  getComments,
  getPost,
  toggleLike,
  toggleUpvote,
} from './post.controller';

const router = Router();

router.use(authenticate);

// Reading is open to every signed-in user (visibility rules apply);
// writing and interacting require a verified college email.
router.get('/:postId', getPost);
router.get('/:postId/comments', getComments);

router.post('/', requireVerified, createPost);
router.delete('/:postId', deletePost);
router.post('/:postId/like', requireVerified, toggleLike);
router.post('/:postId/upvote', requireVerified, toggleUpvote);
router.post('/:postId/comments', requireVerified, addComment);

export default router;
