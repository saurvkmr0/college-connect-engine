import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { UserRole } from '../../types';
import {
  addCollegeDomains,
  createCollegeAdmin,
  disableCollege,
  enableCollege,
  getCollegeById,
  getColleges,
  listCollegesAdmin,
  removeCollegeDomain,
  updateCollegeAdmin,
  updateCollegeDomains,
} from './college.controller';

const router = Router();
const adminOnly = [authenticate, requireRole(UserRole.ADMIN)];

// --- Admin college management (registered before /:collegeId routes) ---
router.post('/', adminOnly, createCollegeAdmin);
router.get('/admin/list', adminOnly, listCollegesAdmin);
router.patch('/:collegeId', adminOnly, updateCollegeAdmin);
router.post('/:collegeId/enable', adminOnly, enableCollege);
router.post('/:collegeId/disable', adminOnly, disableCollege);
router.put('/:collegeId/domains', adminOnly, updateCollegeDomains);
router.post('/:collegeId/domains', adminOnly, addCollegeDomains);
router.delete('/:collegeId/domains/:domain', adminOnly, removeCollegeDomain);

// --- Any signed-in user ---
router.get('/', authenticate, getColleges);
router.get('/:collegeId', authenticate, getCollegeById);

export default router;
