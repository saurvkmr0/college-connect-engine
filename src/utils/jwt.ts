import jwt from 'jsonwebtoken';
import { config } from '../config';
import { IUser } from '../types';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

export const generateToken = (user: Pick<IUser, '_id' | 'email' | 'role'>): string => {
  const payload: JwtPayload = { userId: user._id.toString(), email: user.email, role: user.role };
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  } as jwt.SignOptions);
};

/** Pinning the algorithm stops `alg: none` / algorithm-confusion tokens. */
export const verifyToken = (token: string): JwtPayload =>
  jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
