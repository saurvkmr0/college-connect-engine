import mongoose, { Schema } from 'mongoose';
import { IUser, UserRole } from '../types';

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.STUDENT,
    },
    college: { type: Schema.Types.ObjectId, ref: 'College' },
    collegeEmail: { type: String, lowercase: true, trim: true },
    collegeEmailVerified: { type: Boolean, default: false },
    avatar: { type: String },
    bio: { type: String, maxlength: 500 },
    department: { type: String },
    graduationYear: { type: Number },
    followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', userSchema);
