import { Document, Types } from 'mongoose';

export enum UserRole {
  STUDENT = 'student',
  FACULTY = 'faculty',
  STAFF = 'staff',
  ADMIN = 'admin',
  /** College representative - uses the college portal only, never the student app. */
  COLLEGE_REP = 'college_rep',
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

/** A rep's application state for the college they manage. */
export type ManagerStatus = 'pending' | 'approved' | 'rejected';
/** Faculty/staff approval by their college rep. Missing = approved (accounts that predate approval). */
export type FacultyStatus = 'pending' | 'approved' | 'rejected';

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
  /** bcrypt hash. `select: false` - load it explicitly with `.select('+password')`. */
  password: string;
  role: UserRole;
  college?: Types.ObjectId;
  collegeEmail?: string;
  collegeEmailVerified: boolean;
  collegeVerification: ICollegeVerification;
  avatar?: string;
  banner?: string;
  bio?: string;
  department?: string;
  graduationYear?: number;
  followers: Types.ObjectId[];
  following: Types.ObjectId[];
  followedColleges: Types.ObjectId[];
  /** Reps: login email proven by OTP. */
  emailVerified?: boolean;
  managedCollege?: Types.ObjectId;
  managerStatus?: ManagerStatus;
  managerRejectionReason?: string;
  facultyStatus?: FacultyStatus;
  /** Faculty: when they last asked their college for approval (signup or reapply). Orders the rep's queue. */
  facultyRequestedAt?: Date;
  /** Faculty: chosen at signup, e.g. 'Professor', 'HOD' or custom text. */
  designation?: string;
  /** Students: signup email proven by OTP. Missing = verified (accounts that predate it). */
  accountVerified?: boolean;
  /** Bumped by password reset; tokens carrying an older version are rejected. Missing = 0. */
  tokenVersion?: number;
  /** Students: set by college verification. */
  stream?: string;
  batchStart?: number;
  batchEnd?: number;
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
  bannerImage?: string;
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
  /** Legacy image links (posts created before uploads). */
  images: string[];
  /** Uploaded media - object keys, never URLs. */
  media: { objectKey: string; kind: 'image' | 'video' }[];
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

export interface ITag extends Document {
  _id: Types.ObjectId;
  name: string;
  postCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The signed-in user, attached to `req.user` by `authenticate`. Role and college come from the DB, not the token. */
export interface AuthUser {
  userId: string;
  email: string;
  role: UserRole;
  collegeId?: string;
  /** Has a college and a verified college email - required to post or interact. */
  verified: boolean;
  /** Verified faculty/staff/admin whose college approved them (not pending). */
  canUpvote: boolean;
  /** Reps: login email verified by OTP. */
  emailVerified: boolean;
  /** Reps: the college they applied for / manage. */
  managedCollegeId?: string;
  managerStatus?: ManagerStatus;
  /** False only for new students who have not confirmed their signup email yet. */
  accountVerified: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
