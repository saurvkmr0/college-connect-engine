import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/college-connect',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /**
   * Standalone admin panel credentials. There is no admin signup - the
   * admin signs in here and the values are matched directly from the env.
   */
  admin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
  },
  /**
   * Secret used to HMAC OTP codes before they are stored in Redis.
   * Falls back to the JWT secret so no extra configuration is required.
   */
  otpHashSecret: process.env.OTP_HASH_SECRET || process.env.JWT_SECRET || 'dev-secret-key',
  email: {
    /** Active email provider adapter: 'mailgun' | 'log' */
    provider: process.env.EMAIL_PROVIDER || 'mailgun',
    from: process.env.EMAIL_FROM || 'College Connect <noreply@collegeconnect.app>',
    mailgun: {
      apiKey: process.env.MAILGUN_API_KEY || '',
      domain: process.env.MAILGUN_DOMAIN || '',
      apiBase:
        process.env.MAILGUN_API_BASE ||
        (process.env.MAILGUN_REGION === 'EU'
          ? 'https://api.eu.mailgun.net'
          : 'https://api.mailgun.net'),
    },
  },
};
