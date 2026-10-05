import dotenv from 'dotenv';
import { normalizeEmail } from '../utils/emailValidation';

dotenv.config();

const isProd = process.env.NODE_ENV === 'production';

/** Reads an env var the server cannot run without. Fails at startup, not on first request. */
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
};

/** Required in production; falls back to a local default in development. */
const withDevDefault = (name: string, devDefault: string): string =>
  process.env[name] || (isProd ? required(name) : devDefault);

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters (generate one with: openssl rand -hex 32)');
}

const admin = {
  email: normalizeEmail(process.env.ADMIN_EMAIL || ''),
  password: process.env.ADMIN_PASSWORD || '',
};
if (admin.password && admin.password.length < 12) {
  console.warn('ADMIN_PASSWORD is shorter than 12 characters - use a long random password.');
}

export const config = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  mongodbUri: withDevDefault('MONGODB_URI', 'mongodb://localhost:27017/college-connect'),
  redisUrl: withDevDefault('REDIS_URL', 'redis://localhost:6379'),
  clientUrl: withDevDefault('CLIENT_URL', 'http://localhost:5173'),
  /**
   * Number of reverse proxies in front of the API (e.g. 1 on Render/Heroku/Nginx).
   * Needed so `req.ip` is the real client IP, which rate limiting keys on.
   */
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  /** Standalone admin panel login. There is no admin signup - these are matched directly. */
  admin,
  /** HMAC key for OTPs stored in Redis. Defaults to the JWT secret. */
  otpHashSecret: process.env.OTP_HASH_SECRET || jwtSecret,
  /** Public media (avatars, post media, college images). Optional: without it uploads return 503. */
  storage: {
    provider: process.env.STORAGE_PROVIDER || 'r2',
    /** Custom domain serving the public bucket, e.g. https://media.example.com (never r2.dev in production). */
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || '',
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      bucket: process.env.R2_BUCKET_NAME || '',
    },
  },
  email: {
    /** Active email adapter: 'mailgun' | 'log' ('log' is for development only). */
    provider: process.env.EMAIL_PROVIDER || 'mailgun',
    from: process.env.EMAIL_FROM || 'College Connect <noreply@collegeconnect.app>',
    mailgun: {
      apiKey: process.env.MAILGUN_API_KEY || '',
      domain: process.env.MAILGUN_DOMAIN || '',
      apiBase:
        process.env.MAILGUN_API_BASE ||
        (process.env.MAILGUN_REGION === 'EU' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'),
    },
  },
};
