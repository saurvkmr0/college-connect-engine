# College Connect - Backend

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your MongoDB Atlas URI and JWT secret
   ```

3. Run development server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Auth
- `POST /api/auth/signup` - Create account
- `POST /api/auth/login` - Sign in
- `GET /api/auth/me` - Get current user
- `POST /api/auth/verify-college` - Verify college email
- `PATCH /api/auth/profile` - Update profile

### Users
- `GET /api/users/search?query=` - Search users
- `GET /api/users/:userId` - Get user profile
- `POST /api/users/:userId/follow` - Follow/unfollow user
- `GET /api/users/:userId/followers` - Get followers
- `GET /api/users/:userId/following` - Get following

### Colleges
- `POST /api/colleges/request` - Request new college
- `GET /api/colleges` - List approved colleges
- `GET /api/colleges/:collegeId` - Get college details
- `POST /api/colleges/:collegeId/approve` - Approve college (admin)
- `POST /api/colleges/:collegeId/follow` - Follow college

### Posts
- `POST /api/posts` - Create post
- `GET /api/posts/:postId` - Get post
- `DELETE /api/posts/:postId` - Delete post
- `POST /api/posts/:postId/like` - Toggle like
- `POST /api/posts/:postId/upvote` - Toggle upvote (faculty/staff only)
- `POST /api/posts/:postId/comments` - Add comment
- `GET /api/posts/:postId/comments` - Get comments

### Feed
- `GET /api/feed/global` - Global feed
- `GET /api/feed/college` - College feed
- `GET /api/feed/explore` - Explore feed
- `GET /api/feed/tags/trending` - Trending tags
