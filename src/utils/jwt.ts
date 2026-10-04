import jwt from 'jsonwebtoken';
import { config } from '../config';
import { IUser } from '../types';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  /** The user's tokenVersion when the token was issued; a password reset bumps it. */
  tv?: number;
}

export const generateToken = (user: Pick<IUser, '_id' | 'email' | 'role' | 'tokenVersion'>): string => {
  const payload: JwtPayload = {
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    tv: user.tokenVersion ?? 0,
  };
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  } as jwt.SignOptions);
};

/** Pinning the algorithm stops `alg: none` / algorithm-confusion tokens. */
export const verifyToken = (token: string): JwtPayload =>
  jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
