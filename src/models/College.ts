import mongoose, { Schema } from 'mongoose';
import { ICollege, CollegeVerificationStatus } from '../types';

const collegeSchema = new Schema<ICollege>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    address: { type: String },
    logo: { type: String },
    description: { type: String },
    admin: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    verificationStatus: {
      type: String,
      enum: Object.values(CollegeVerificationStatus),
      default: CollegeVerificationStatus.PENDING,
    },
  },
  { timestamps: true }
);

export const College = mongoose.model<ICollege>('College', collegeSchema);
