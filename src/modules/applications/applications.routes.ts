import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { UserRole } from '../../types';
import { approveApplication, listApplications, rejectApplication } from './applications.controller';

const router = Router();

router.use(authenticate, requireRole(UserRole.ADMIN));

router.get('/', listApplications);
router.post('/:repId/approve', approveApplication);
router.post('/:repId/reject', rejectApplication);

export default router;
