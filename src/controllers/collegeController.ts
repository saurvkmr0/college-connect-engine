import { Response } from 'express';
import { College } from '../models/College';
import { User } from '../models/User';
import { Post } from '../models/Post';
import { AuthRequest } from '../middleware/auth';
import { CollegeVerificationStatus } from '../types';

export const createCollegeRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, code, address, description } = req.body;

    if (!name || !code) {
      res.status(400).json({ message: 'College name and code are required' });
      return;
    }

    const existingCollege = await College.findOne({ code: code.toUpperCase() });
    if (existingCollege) {
      res.status(409).json({ message: 'A college with this code already exists' });
      return;
    }

    const college = new College({
      name,
      code: code.toUpperCase(),
      address,
      description,
      admin: req.user!.userId,
      verificationStatus: CollegeVerificationStatus.PENDING,
    });

    await college.save();

    // Make the requester a faculty/staff member
    await User.findByIdAndUpdate(req.user!.userId, {
      role: 'faculty',
      college: college._id,
    });

    res.status(201).json({
      message: 'College request submitted for approval',
      college,
    });
  } catch (error) {
    console.error('Create college error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getColleges = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const colleges = await College.find({ verificationStatus: CollegeVerificationStatus.APPROVED })
      .select('name code logo description')
      .sort({ name: 1 });

    res.json({ colleges });
  } catch (error) {
    console.error('Get colleges error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getCollegeById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { collegeId } = req.params;

    const college = await College.findById(collegeId)
      .populate('admin', 'name email avatar');

    if (!college) {
      res.status(404).json({ message: 'College not found' });
      return;
    }

    const collegePosts = await Post.find({ college: collegeId, type: 'global' })
      .populate('author', 'name avatar role')
      .sort({ createdAt: -1 })
      .limit(20);

    const studentCount = await User.countDocuments({ college: collegeId, role: 'student' });
    const facultyCount = await User.countDocuments({ college: collegeId, role: { $in: ['faculty', 'staff'] } });

    res.json({
      college,
      stats: { studentCount, facultyCount },
      posts: collegePosts,
    });
  } catch (error) {
    console.error('Get college by id error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const approveCollege = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { collegeId } = req.params;

    const college = await College.findByIdAndUpdate(
      collegeId,
      { verificationStatus: CollegeVerificationStatus.APPROVED },
      { new: true }
    );

    if (!college) {
      res.status(404).json({ message: 'College not found' });
      return;
    }

    res.json({ message: 'College approved', college });
  } catch (error) {
    console.error('Approve college error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getPendingColleges = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const colleges = await College.find({ verificationStatus: CollegeVerificationStatus.PENDING })
      .populate('admin', 'name email')
      .sort({ createdAt: -1 });

    res.json({ colleges });
  } catch (error) {
    console.error('Get pending colleges error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const followCollege = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { collegeId } = req.params;
    const userId = req.user!.userId;

    const college = await College.findById(collegeId);
    if (!college) {
      res.status(404).json({ message: 'College not found' });
      return;
    }

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    // We'll store college follows in the user's following array with a prefix
    // For simplicity, using a separate field or checking college followers
    const isFollowing = user.following.some(
      (id) => id.toString() === `college_${collegeId}`
    );

    if (isFollowing) {
      user.following = user.following.filter(
        (id) => id.toString() !== `college_${collegeId}`
      );
    } else {
      user.following.push(`college_${collegeId}` as any);
    }

    await user.save();

    res.json({
      message: isFollowing ? 'Unfollowed college' : 'Following college',
      isFollowing: !isFollowing,
    });
  } catch (error) {
    console.error('Follow college error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
