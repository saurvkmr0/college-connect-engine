import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { UPLOAD_LIMITS } from './media.constants';
import { discardUploadController, requestUploadUrl } from './media.controller';

const router = Router();

// Fail closed: if Redis is down, no upload URLs are issued (cost protection beats uptime here).
const perIp = rateLimit({ name: 'media-ip', limit: UPLOAD_LIMITS.perIpPerMinute, windowSeconds: 60, failOpen: false });
const perUser = rateLimit({
  name: 'media-user',
  limit: UPLOAD_LIMITS.perUserPerMinute,
  windowSeconds: 60,
  failOpen: false,
  keyBy: (req) => req.user!.userId,
});

router.use(authenticate);

router.post('/upload-url', perIp, perUser, requestUploadUrl);
router.delete('/:assetId', discardUploadController);

export default router;
