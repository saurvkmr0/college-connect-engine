import { Router } from 'express';
import { authenticate, requireVerified } from '../../middleware/auth';
import { getCollegeFeed, getExploreFeed, getGlobalFeed, getTrendingTags } from './feed.controller';

const router = Router();

router.use(authenticate);

router.get('/global', getGlobalFeed);
router.get('/college', requireVerified, getCollegeFeed);
router.get('/explore', getExploreFeed);
router.get('/tags/trending', getTrendingTags);

export default router;
