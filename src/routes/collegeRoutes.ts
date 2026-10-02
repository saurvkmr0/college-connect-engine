import { Router } from 'express';
import {
  createCollegeRequest,
  getColleges,
  getCollegeById,
  approveCollege,
  getPendingColleges,
  followCollege,
  createCollegeAdmin,
  updateCollegeAdmin,
  enableCollege,
  disableCollege,
  updateCollegeDomains,
  addCollegeDomains,
  removeCollegeDomain,
  listCollegesAdmin,
} from '../controllers/collegeController';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

// --- Admin college management (registered before /:collegeId routes) ---
router.post('/', authenticate, requireRole('admin'), createCollegeAdmin);
router.get('/admin/list', authenticate, requireRole('admin'), listCollegesAdmin);
router.patch('/:collegeId', authenticate, requireRole('admin'), updateCollegeAdmin);
router.post('/:collegeId/enable', authenticate, requireRole('admin'), enableCollege);
router.post('/:collegeId/disable', authenticate, requireRole('admin'), disableCollege);
router.put('/:collegeId/domains', authenticate, requireRole('admin'), updateCollegeDomains);
router.post('/:collegeId/domains', authenticate, requireRole('admin'), addCollegeDomains);
router.delete('/:collegeId/domains/:domain', authenticate, requireRole('admin'), removeCollegeDomain);

// --- Existing college routes ---
router.post('/request', authenticate, createCollegeRequest);
router.get('/', authenticate, getColleges);
router.get('/pending', authenticate, requireRole('admin'), getPendingColleges);
router.get('/:collegeId', authenticate, getCollegeById);
router.post('/:collegeId/approve', authenticate, requireRole('admin'), approveCollege);
router.post('/:collegeId/follow', authenticate, followCollege);

export default router;
