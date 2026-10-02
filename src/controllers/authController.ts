import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { User } from '../models/User';
import { generateToken } from '../utils/jwt';
import { UserRole } from '../types';
import { AuthRequest } from '../middleware/auth';
import { config } from '../config';
import { constantTimeEqual } from '../utils/secureCompare';
import { sendError, sendSuccess } from '../utils/apiError';

/** Roles a person may pick at signup. `admin` is deliberately not among them. */
const ALLOWED_SIGNUP_ROLES: string[] = [UserRole.STUDENT, UserRole.FACULTY, UserRole.STAFF];

export const signup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ message: 'Name, email, and password are required' });
      return;
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(409).json({ message: 'Email already registered' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Never trust a client-supplied role: anything outside the allowed list
    // (including 'admin') silently falls back to student. Admins are created
    // through the env-gated admin login, never through signup.
    const requestedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
    const safeRole = ALLOWED_SIGNUP_ROLES.includes(requestedRole)
      ? (requestedRole as UserRole)
      : UserRole.STUDENT;

    const user = new User({
      name,
      email,
      password: hashedPassword,
      role: safeRole,
    });

    await user.save();

    const token = generateToken(user);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        college: user.college,
        collegeEmailVerified: user.collegeEmailVerified,
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const user = await User.findOne({ email });
    if (!user) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        college: user.college,
        collegeEmailVerified: user.collegeEmailVerified,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * POST /api/auth/admin-login
 *
 * Standalone admin sign-in for the admin panel. Credentials are matched
 * directly against ADMIN_EMAIL / ADMIN_PASSWORD from the env - there is no
 * admin signup. A backing User record with role `admin` is created lazily so
 * the existing `authenticate` / `requireRole('admin')` middleware work unchanged.
 */
export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const configuredEmail = (config.admin.email || '').trim().toLowerCase();
    const configuredPassword = config.admin.password || '';

    if (!configuredEmail || !configuredPassword) {
      sendError(
        res,
        503,
        'AUTH_NOT_CONFIGURED',
        'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment.'
      );
      return;
    }

    const body = (req.body || {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const emailMatches = constantTimeEqual(email, configuredEmail);
    const passwordMatches = constantTimeEqual(password, configuredPassword);

    if (!emailMatches || !passwordMatches) {
      sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid admin credentials.');
      return;
    }

    let user = await User.findOne({ email: configuredEmail });

    if (!user) {
      // The env password is the only credential; the stored hash is a random
      // placeholder so the schema constraint is satisfied without weakening it.
      user = await User.create({
        name: 'Administrator',
        email: configuredEmail,
        password: await bcrypt.hash(randomBytes(32).toString('hex'), 12),
        role: UserRole.ADMIN,
      });
    } else if (user.role !== UserRole.ADMIN) {
      user.role = UserRole.ADMIN;
      await user.save();
    }

    const token = generateToken(user);

    sendSuccess(res, 200, 'Signed in', {
      token,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    sendError(res, 500, 'INTERNAL_ERROR', 'Server error');
  }
};

export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.userId)
      .populate('college', 'name code logo')
      .select('-password');

    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, bio, department, graduationYear, avatar } = req.body;

    const user = await User.findByIdAndUpdate(
      req.user!.userId,
      { name, bio, department, graduationYear, avatar },
      { new: true }
    ).select('-password');

    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
