import mongoose, { Schema } from 'mongoose';
import { IUser, UserRole } from '../../types';

/** Fields any signed-in user may see about another user. Never includes emails. */
export const PUBLIC_USER_FIELDS = 'name avatar role college bio department graduationYear createdAt';
/** The author snippet embedded in posts, comments and follower lists. */
export const AUTHOR_FIELDS = 'name avatar role';

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Hidden from every query unless explicitly requested with .select('+password').
    password: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.STUDENT,
    },
    college: { type: Schema.Types.ObjectId, ref: 'College' },
    collegeEmail: { type: String, lowercase: true, trim: true },
    collegeEmailVerified: { type: Boolean, default: false },
    // College email verification (OTP flow). Populated only after the OTP
    // has been verified - never set from client-supplied data.
    collegeVerification: {
      verified: { type: Boolean, default: false },
      collegeId: { type: Schema.Types.ObjectId, ref: 'College' },
      collegeEmail: { type: String, lowercase: true, trim: true },
      method: { type: String, enum: ['email'] },
      verifiedAt: { type: Date },
    },
    avatar: { type: String, trim: true, maxlength: 500 },
    bio: { type: String, trim: true, maxlength: 500 },
    department: { type: String, trim: true, maxlength: 100 },
    graduationYear: { type: Number, min: 1950, max: 2100 },
    // ponytail: embedded follow arrays are fine for now; move to a Follow collection
    // once users can have tens of thousands of followers (16MB document limit).
    followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

// College member counts (students vs faculty/staff).
userSchema.index({ college: 1, role: 1 });

export const User = mongoose.model<IUser>('User', userSchema);

/** True when the user passed college verification (new flow or legacy flag). */
export const isUserVerified = (
  user: Pick<IUser, 'collegeEmailVerified'> & { collegeVerification?: { verified?: boolean } }
): boolean => Boolean(user.collegeVerification?.verified || user.collegeEmailVerified);
