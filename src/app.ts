import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import collegeRoutes from './routes/collegeRoutes';
import collegeVerificationRoutes from './routes/collegeVerificationRoutes';
import postRoutes from './routes/postRoutes';
import feedRoutes from './routes/feedRoutes';

const app = express();

// Middleware
app.use(cors({
  origin: config.clientUrl,
  credentials: true,
}));
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/colleges', collegeRoutes);
app.use('/api/college-verification', collegeVerificationRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/feed', feedRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

export default app;
