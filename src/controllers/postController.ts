import { Response } from 'express';
import { Post } from '../models/Post';
import { Comment } from '../models/Comment';
import { Tag } from '../models/Tag';
import { User } from '../models/User';
import { AuthRequest } from '../middleware/auth';
import { PostType } from '../types';

export const createPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { content, images, tags, type } = req.body;
    const userId = req.user!.userId;

    if (!content || !type) {
      res.status(400).json({ message: 'Content and post type are required' });
      return;
    }

    const user = await User.findById(userId);
    if (!user || !user.college) {
      res.status(403).json({ message: 'You must be associated with a college to post' });
      return;
    }

    const post = new Post({
      author: userId,
      college: user.college,
      type,
      content,
      images: images || [],
      tags: tags || [],
      likes: [],
      upvotes: [],
      comments: [],
    });

    await post.save();

    // Update tag counts
    if (tags && tags.length > 0) {
      for (const tagName of tags) {
        await Tag.findOneAndUpdate(
          { name: tagName.toLowerCase() },
          { $inc: { postCount: 1 } },
          { upsert: true }
        );
      }
    }

    await post.populate('author', 'name avatar role');
    await post.populate('college', 'name code logo');

    res.status(201).json({ post });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { postId } = req.params;

    const post = await Post.findById(postId)
      .populate('author', 'name avatar role')
      .populate('college', 'name code logo')
      .populate('comments')
      .populate({
        path: 'comments',
        populate: { path: 'author', select: 'name avatar role' },
      });

    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    res.json({ post });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deletePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { postId } = req.params;
    const userId = req.user!.userId;

    const post = await Post.findById(postId);
    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    if (post.author.toString() !== userId) {
      res.status(403).json({ message: 'You can only delete your own posts' });
      return;
    }

    await Post.findByIdAndDelete(postId);
    await Comment.deleteMany({ post: postId });

    // Decrement tag counts
    if (post.tags && post.tags.length > 0) {
      for (const tagName of post.tags) {
        await Tag.findOneAndUpdate(
          { name: tagName },
          { $inc: { postCount: -1 } }
        );
      }
    }

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const toggleLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { postId } = req.params;
    const userId = req.user!.userId;

    const post = await Post.findById(postId);
    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const hasLiked = post.likes.some((id) => id.toString() === userId);

    if (hasLiked) {
      post.likes = post.likes.filter((id) => id.toString() !== userId);
    } else {
      post.likes.push(userId as any);
    }

    await post.save();

    res.json({
      message: hasLiked ? 'Unliked' : 'Liked',
      likesCount: post.likes.length,
      isLiked: !hasLiked,
    });
  } catch (error) {
    console.error('Toggle like error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const toggleUpvote = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { postId } = req.params;
    const userId = req.user!.userId;

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    // Only faculty/staff/admin can upvote
    if (!['faculty', 'staff', 'admin'].includes(user.role)) {
      res.status(403).json({ message: 'Only faculty and staff can upvote posts' });
      return;
    }

    const post = await Post.findById(postId);
    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const hasUpvoted = post.upvotes.some((id) => id.toString() === userId);

    if (hasUpvoted) {
      post.upvotes = post.upvotes.filter((id) => id.toString() !== userId);
    } else {
      post.upvotes.push(userId as any);
    }

    await post.save();

    res.json({
      message: hasUpvoted ? 'Upvote removed' : 'Upvoted',
      upvotesCount: post.upvotes.length,
      isUpvoted: !hasUpvoted,
    });
  } catch (error) {
    console.error('Toggle upvote error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const addComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { postId } = req.params;
    const { content } = req.body;
    const userId = req.user!.userId;

    if (!content) {
      res.status(400).json({ message: 'Comment content is required' });
      return;
    }

    const post = await Post.findById(postId);
    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const comment = new Comment({
      author: userId,
      post: postId,
      content,
    });

    await comment.save();

    post.comments.push(comment._id);
    await post.save();

    await comment.populate('author', 'name avatar role');

    res.status(201).json({ comment });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getComments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { postId } = req.params;

    const comments = await Comment.find({ post: postId })
      .populate('author', 'name avatar role')
      .sort({ createdAt: -1 });

    res.json({ comments });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
