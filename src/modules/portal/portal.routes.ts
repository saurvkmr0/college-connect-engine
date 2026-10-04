import { RequestHandler, Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { loginLimit, signupLimit } from '../../middleware/rateLimit';
import { UserRole } from '../../types';
import { ApiError } from '../../utils/apiError';
import {
  approveFaculty,
  getDashboard,
  listFacultyRequests,
  rejectFaculty,
  login,
  register,
  requestEmailOtp,
  submitApplication,
  updateCollegeProfile,
  verifyEmailOtp,
} from './portal.controller';

const router = Router();

/** Rep whose application the admin approved - may manage their college. */
const requireApprovedRep: RequestHandler = (req, _res, next) => {
  if (req.user?.managerStatus !== 'approved' || !req.user.managedCollegeId) {
    throw new ApiError(403, 'FORBIDDEN', 'Your college application has not been approved yet.');
  }
  next();
};

// --- Public ---
router.post('/register', signupLimit, register);
router.post('/login', loginLimit, login);

// --- Signed-in reps only ---
router.use(authenticate, requireRole(UserRole.COLLEGE_REP));

router.post('/request-otp', requestEmailOtp);
router.post('/verify-otp', verifyEmailOtp);
router.post('/application', submitApplication);
router.get('/me', getDashboard);
router.patch('/college', requireApprovedRep, updateCollegeProfile);
router.get('/faculty-requests', requireApprovedRep, listFacultyRequests);
router.post('/faculty-requests/:userId/approve', requireApprovedRep, approveFaculty);
router.post('/faculty-requests/:userId/reject', requireApprovedRep, rejectFaculty);

export default router;
