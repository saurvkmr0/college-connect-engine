import { Response } from 'express';
import { Post } from '../models/Post';
import { User } from '../models/User';
import { Tag } from '../models/Tag';
import { AuthRequest } from '../middleware/auth';
import { PostType } from '../types';

export const getGlobalFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 20, tag } = req.query;
    const userId = req.user!.userId;

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    // Build query
    const query: any = { type: PostType.GLOBAL };

    // Filter by tag if provided
    if (tag && typeof tag === 'string') {
      query.tags = tag.toLowerCase();
    }

    // Get posts from:
    // 1. Users the current user follows
    // 2. The user's own college
    // 3. Posts with matching tags
    const followingIds = (user.following as unknown[])
      .map((id) => (typeof id === 'string' && id.startsWith('college_') ? null : id))
      .filter(Boolean);

    const matchStage: any = {
      $match: {
        ...query,
        $or: [
          { author: { $in: followingIds } },
          { college: user.college },
        ],
      },
    };

    // If tag search, don't restrict to following/college
    if (tag && typeof tag === 'string') {
      matchStage.$match = { type: PostType.GLOBAL, tags: tag.toLowerCase() };
    }

    const posts = await Post.aggregate([
      matchStage,
      {
        $addFields: {
          score: {
            $add: [
              { $multiply: [{ $size: '$upvotes' }, 3] },
              { $multiply: [{ $size: '$likes' }, 1] },
              { $multiply: [{ $size: '$comments' }, 2] },
            ],
          },
        },
      },
      { $sort: { score: -1, createdAt: -1 } },
      { $skip: (Number(page) - 1) * Number(limit) },
      { $limit: Number(limit) },
      {
        $lookup: {
          from: 'users',
          localField: 'author',
          foreignField: '_id',
          as: 'author',
        },
      },
      { $unwind: '$author' },
      {
        $lookup: {
          from: 'colleges',
          localField: 'college',
          foreignField: '_id',
          as: 'college',
        },
      },
      { $unwind: '$college' },
      {
        $project: {
          'author.password': 0,
          'author.email': 0,
        },
      },
    ]);

    res.json({ posts, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get global feed error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getCollegeFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const userId = req.user!.userId;

    const user = await User.findById(userId);
    if (!user || !user.college) {
      res.status(403).json({ message: 'You must be associated with a college' });
      return;
    }

    const posts = await Post.find({
      college: user.college,
      type: PostType.COLLEGE,
    })
      .populate('author', 'name avatar role')
      .populate('college', 'name code logo')
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    res.json({ posts, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get college feed error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getTrendingTags = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tags = await Tag.find()
      .sort({ postCount: -1 })
      .limit(20);

    res.json({ tags });
  } catch (error) {
    console.error('Get trending tags error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getExploreFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 20 } = req.query;

    // Get all global posts sorted by upvotes/engagement
    const posts = await Post.find({ type: PostType.GLOBAL })
      .populate('author', 'name avatar role')
      .populate('college', 'name code logo')
      .sort({ upvotes: -1, createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    res.json({ posts, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get explore feed error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
