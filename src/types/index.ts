import { Document, Types } from 'mongoose';

export enum UserRole {
  STUDENT = 'student',
  FACULTY = 'faculty',
  STAFF = 'staff',
  ADMIN = 'admin',
}

export enum PostType {
  COLLEGE = 'college',
  GLOBAL = 'global',
}

export enum CollegeVerificationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export type CollegeVerificationMethod = 'email';

export interface ICollegeVerification {
  verified: boolean;
  collegeId?: Types.ObjectId;
  collegeEmail?: string;
  method?: CollegeVerificationMethod;
  verifiedAt?: Date;
}

export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  college?: Types.ObjectId;
  collegeEmail?: string;
  collegeEmailVerified: boolean;
  collegeVerification: ICollegeVerification;
  avatar?: string;
  bio?: string;
  department?: string;
  graduationYear?: number;
  followers: Types.ObjectId[];
  following: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ICollege extends Document {
  _id: Types.ObjectId;
  name: string;
  code: string;
  address?: string;
  logo?: string;
  description?: string;
  admin: Types.ObjectId;
  verificationStatus: CollegeVerificationStatus;
  /** Email domains that map to this college, stored lowercase and without `@`. */
  domains: string[];
  country?: string;
  state?: string;
  city?: string;
  /** Only `active` colleges can be used for email verification. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPost extends Document {
  _id: Types.ObjectId;
  author: Types.ObjectId;
  college: Types.ObjectId;
  type: PostType;
  content: string;
  images: string[];
  tags: string[];
  likes: Types.ObjectId[];
  upvotes: Types.ObjectId[];
  comments: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IComment extends Document {
  _id: Types.ObjectId;
  author: Types.ObjectId;
  post: Types.ObjectId;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IFollow extends Document {
  _id: Types.ObjectId;
  follower: Types.ObjectId;
  following: Types.ObjectId;
  createdAt: Date;
}

export interface ITag extends Document {
  _id: Types.ObjectId;
  name: string;
  postCount: number;
  createdAt: Date;
  updatedAt: Date;
}
