import { Router } from 'express';
import {
  createPost,
  getPost,
  deletePost,
  toggleLike,
  toggleUpvote,
  addComment,
  getComments,
} from '../controllers/postController';
import { authenticate, requireCollegeVerification } from '../middleware/auth';

const router = Router();

router.post('/', authenticate, requireCollegeVerification, createPost);
router.get('/:postId', authenticate, getPost);
router.delete('/:postId', authenticate, deletePost);
router.post('/:postId/like', authenticate, toggleLike);
router.post('/:postId/upvote', authenticate, toggleUpvote);
router.post('/:postId/comments', authenticate, addComment);
router.get('/:postId/comments', authenticate, getComments);

export default router;
