import mongoose from 'mongoose';
import app from './app';
import { config } from './config';
import { closeRedis, connectRedis } from './config/redis';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const start = async () => {
  await mongoose.connect(config.mongodbUri);
  console.log('Connected to MongoDB');

  // A Redis outage must not stop the API: OTP verification and admin login fail
  // closed (503), user login/signup rate limits fail open, until Redis is back.
  await connectRedis();

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port} (${process.env.NODE_ENV || 'development'})`);
  });

  // Let in-flight requests finish before exiting (deploys, Ctrl+C).
  const shutdown = () => {
    console.log('Shutting down...');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    server.close(async () => {
      await Promise.all([mongoose.disconnect(), closeRedis()]);
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
