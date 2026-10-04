import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { UserRole } from '../../types';
import {
  addCollegeDomains,
  createCollegeAdmin,
  disableCollege,
  enableCollege,
  followCollege,
  getCollegeById,
  getCollegePosts,
  getColleges,
  listCollegesAdmin,
  removeCollegeDomain,
  searchColleges,
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

// --- Any signed-in user (search before /:collegeId so it is not read as an id) ---
router.get('/', authenticate, getColleges);
router.get('/search', authenticate, searchColleges);
router.get('/:collegeId', authenticate, getCollegeById);
router.get('/:collegeId/posts', authenticate, getCollegePosts);
router.post('/:collegeId/follow', authenticate, followCollege);

export default router;
