import { Router } from 'express';
import {
  createCollegeRequest,
  getColleges,
  getCollegeById,
  approveCollege,
  getPendingColleges,
  followCollege,
} from '../controllers/collegeController';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.post('/request', authenticate, createCollegeRequest);
router.get('/', authenticate, getColleges);
router.get('/pending', authenticate, requireRole('admin'), getPendingColleges);
router.get('/:collegeId', authenticate, getCollegeById);
router.post('/:collegeId/approve', authenticate, requireRole('admin'), approveCollege);
router.post('/:collegeId/follow', authenticate, followCollege);

export default router;
