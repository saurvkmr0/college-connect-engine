import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config';
import { errorHandler, notFound } from './middleware/error';
import applicationRoutes from './modules/applications/applications.routes';
import authRoutes from './modules/auth/auth.routes';
import collegeRoutes from './modules/colleges/college.routes';
import feedRoutes from './modules/feed/feed.routes';
import portalRoutes from './modules/portal/portal.routes';
import postRoutes from './modules/posts/post.routes';
import userRoutes from './modules/users/user.routes';
import verificationRoutes from './modules/verification/verification.routes';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
// Flat query strings only: `?tag[$ne]=x` stays a plain string key instead of becoming an object.
app.set('query parser', 'simple');

app.use(cors({ origin: config.clientUrl, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(morgan(config.isProd ? 'combined' : 'dev'));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// One line per feature module - add new modules here.
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/colleges', collegeRoutes);
app.use('/api/college-verification', verificationRoutes);
app.use('/api/college-portal', portalRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/admin/college-applications', applicationRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
