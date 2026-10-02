import mongoose from 'mongoose';
import app from './app';
import { config } from './config';
import { connectRedis } from './config/redis';

const startServer = async () => {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');

    // OTP storage and rate limiting live in Redis. A Redis outage must not
    // stop the API: verification endpoints simply fail closed (HTTP 503).
    await connectRedis();

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
};

startServer();
