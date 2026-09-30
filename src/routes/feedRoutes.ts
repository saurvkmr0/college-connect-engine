import { Router } from 'express';
import {
  getGlobalFeed,
  getCollegeFeed,
  getTrendingTags,
  getExploreFeed,
} from '../controllers/feedController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/global', authenticate, getGlobalFeed);
router.get('/college', authenticate, getCollegeFeed);
router.get('/explore', authenticate, getExploreFeed);
router.get('/tags/trending', authenticate, getTrendingTags);

export default router;
