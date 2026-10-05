import mongoose, { Schema } from 'mongoose';
import { ICollege, CollegeVerificationStatus } from '../../types';
import { normalizeDomain } from '../../utils/emailValidation';

/** College snippet embedded in users, posts and feeds. */
export const COLLEGE_SUMMARY_FIELDS = 'name code logo';
/** Fields an approved rep may edit from the portal. Name, code and domains stay admin-only. */
export const COLLEGE_PROFILE_FIELDS = ['description', 'country', 'state', 'city', 'address'] as const;
// Logo/banner are uploads: set via logoAssetId / bannerAssetId (applyCollegeImages).
/** What the public may see (search, profile, posts, follow, followed-college feed): approved and not disabled. */
export const PUBLIC_COLLEGE = { verificationStatus: CollegeVerificationStatus.APPROVED, active: true };

const collegeSchema = new Schema<ICollege>(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    address: { type: String, trim: true, maxlength: 300 },
    logo: { type: String, trim: true, maxlength: 500 },
    description: { type: String, trim: true, maxlength: 2000 },
    bannerImage: { type: String, trim: true, maxlength: 500 },
    admin: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    verificationStatus: {
      type: String,
      enum: Object.values(CollegeVerificationStatus),
      default: CollegeVerificationStatus.PENDING,
    },
    // --- College email verification fields ---
    domains: {
      type: [String],
      default: [],
      trim: true,
      lowercase: true,
      validate: {
        validator: (domains: string[]) =>
          domains.every((domain) => typeof domain === 'string' && domain.length > 0),
        message: 'Domains must be non-empty strings',
      },
    },
    country: { type: String, trim: true, maxlength: 100 },
    state: { type: String, trim: true, maxlength: 100 },
    city: { type: String, trim: true, maxlength: 100 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * Domains are always stored normalized: lowercase, trimmed, without `@`.
 * The service layer does the same thing before saving; this hook guarantees
 * the invariant even for direct model writes.
 */
collegeSchema.pre('validate', function (next) {
  if (Array.isArray(this.domains)) {
    this.domains = this.domains
      .map((domain) => normalizeDomain(domain))
      .filter((domain): domain is string => domain.length > 0);
  }
  next();
});

/**
 * One domain may belong to at most one college.
 * The partial filter keeps colleges without domains (and legacy documents)
 * out of the index so they do not collide on a null key.
 * Note: MongoDB de-duplicates keys within a single array, so duplicates
 * inside one document are handled by the service layer.
 */
collegeSchema.index(
  { domains: 1 },
  {
    unique: true,
    name: 'domains_unique',
    partialFilterExpression: { 'domains.0': { $type: 'string' } },
  }
);

export const College = mongoose.model<ICollege>('College', collegeSchema);
