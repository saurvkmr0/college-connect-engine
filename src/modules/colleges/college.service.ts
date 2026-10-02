import { randomInt } from 'node:crypto';
import { Types } from 'mongoose';
import { ICollege, CollegeVerificationStatus } from '../../types';
import { ApiError } from '../../utils/apiError';
import {
  extractDomain,
  isValidDomain,
  isValidEmail,
  normalizeDomain,
  normalizeEmail,
} from '../../utils/emailValidation';
import { College } from './college.model';

/* ------------------------------------------------------------------ */
/* Email -> college validation (reusable)                              */
/* ------------------------------------------------------------------ */

export type CollegeEmailValidation =
  | { valid: true; college: { id: string; name: string }; domain: string }
  | { valid: false; reason: 'INVALID_EMAIL' | 'UNSUPPORTED_COLLEGE_DOMAIN' };

/**
 * Determines the college from the email domain alone.
 * The client never supplies a college id - it is always resolved here.
 */
export const validateCollegeEmail = async (email: string): Promise<CollegeEmailValidation> => {
  const normalized = normalizeEmail(email);

  if (!isValidEmail(normalized)) {
    return { valid: false, reason: 'INVALID_EMAIL' };
  }

  const domain = extractDomain(normalized);
  if (!domain || !isValidDomain(domain)) {
    return { valid: false, reason: 'INVALID_EMAIL' };
  }

  // Only active colleges may be used for verification.
  const college = await College.findOne({ domains: domain, active: true }).select('name active');
  if (!college) {
    return { valid: false, reason: 'UNSUPPORTED_COLLEGE_DOMAIN' };
  }

  return {
    valid: true,
    college: { id: college._id.toString(), name: college.name },
    domain,
  };
};

/* ------------------------------------------------------------------ */
/* Domain helpers                                                      */
/* ------------------------------------------------------------------ */

/** Trim/lowercase/strip `@`, drop empties, de-duplicate and validate. */
export const normalizeDomains = (domains: unknown): string[] => {
  if (!Array.isArray(domains)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Domains must be an array of strings');
  }

  const cleaned = domains
    .map((domain) => (typeof domain === 'string' ? normalizeDomain(domain) : ''))
    .filter((domain) => domain.length > 0);

  const unique = [...new Set(cleaned)];

  const invalid = unique.filter((domain) => !isValidDomain(domain));
  if (invalid.length > 0) {
    throw new ApiError(400, 'INVALID_DOMAIN', `Invalid domain(s): ${invalid.join(', ')}`);
  }

  return unique;
};

/** A domain may belong to at most one college. */
const assertDomainsAvailable = async (
  domains: string[],
  excludeCollegeId?: string
): Promise<void> => {
  if (domains.length === 0) return;

  const filter: Record<string, unknown> = { domains: { $in: domains } };
  if (excludeCollegeId) filter._id = { $ne: new Types.ObjectId(excludeCollegeId) };

  const existing = await College.findOne(filter).select('name code domains');
  if (existing) {
    const clash = existing.domains.find((domain) => domains.includes(domain));
    throw new ApiError(
      409,
      'DOMAIN_ALREADY_ASSIGNED',
      `Domain "${clash}" is already assigned to ${existing.name}`
    );
  }
};

/** Maps a MongoDB duplicate-key error (unique index race) to an ApiError. */
const rethrowDuplicateKey = (error: unknown, fallbackMessage: string): never => {
  const mongoError = error as { code?: number; keyPattern?: Record<string, unknown> };
  if (mongoError?.code === 11000) {
    if (mongoError.keyPattern?.domains) {
      throw new ApiError(409, 'DOMAIN_ALREADY_ASSIGNED', fallbackMessage);
    }
    throw new ApiError(409, 'CONFLICT', fallbackMessage);
  }
  throw error;
};

/** Short unique college code derived from the name (existing schema requires `code`). */
const generateCollegeCode = async (name: string): Promise<string> => {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 6) || 'COL';

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = attempt === 0 ? '' : randomInt(100, 1000).toString();
    const candidate = `${initials}${suffix}`;
    const exists = await College.exists({ code: candidate });
    if (!exists) return candidate;
  }

  return `${initials}${randomInt(100000, 999999)}`;
};

/* ------------------------------------------------------------------ */
/* College management (admin)                                          */
/* ------------------------------------------------------------------ */

export interface CollegeInput {
  name?: string;
  code?: string;
  domains?: string[];
  country?: string;
  state?: string;
  city?: string;
  address?: string;
  description?: string;
  logo?: string;
  active?: boolean;
}

const TEXT_FIELDS = ['name', 'code', 'country', 'state', 'city', 'address', 'description', 'logo'] as const;

/**
 * Builds a CollegeInput from an untrusted request body: only known fields, only
 * strings (booleans for `active`). Fields that are absent stay undefined, which
 * `updateCollege` reads as "leave unchanged".
 */
export const parseCollegeInput = (body: unknown): CollegeInput => {
  const source = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const input: CollegeInput = {};
  for (const field of TEXT_FIELDS) {
    if (typeof source[field] === 'string') input[field] = source[field] as string;
  }
  if (typeof source.active === 'boolean') input.active = source.active;
  if (source.domains !== undefined) input.domains = source.domains as string[];
  return input;
};

export const getCollegeOrThrow = async (collegeId: string): Promise<ICollege> => {
  if (!Types.ObjectId.isValid(collegeId)) {
    throw new ApiError(404, 'NOT_FOUND', 'College not found');
  }
  const college = await College.findById(collegeId);
  if (!college) throw new ApiError(404, 'NOT_FOUND', 'College not found');
  return college;
};

export const createCollege = async (
  input: CollegeInput,
  adminId: string
): Promise<ICollege> => {
  const name = (input.name || '').trim();
  if (!name) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'College name is required');
  }

  const domains = normalizeDomains(input.domains ?? []);
  await assertDomainsAvailable(domains);

  let code = (input.code || '').trim().toUpperCase();
  if (code) {
    const duplicate = await College.exists({ code });
    if (duplicate) {
      throw new ApiError(409, 'CONFLICT', `A college with code ${code} already exists`);
    }
  } else {
    code = await generateCollegeCode(name);
  }

  try {
    return await College.create({
      name,
      code,
      admin: new Types.ObjectId(adminId),
      domains,
      country: input.country?.trim(),
      state: input.state?.trim(),
      city: input.city?.trim(),
      address: input.address?.trim(),
      description: input.description?.trim(),
      logo: input.logo?.trim(),
      active: input.active ?? true,
      // Created by an admin, so it is considered approved.
      verificationStatus: CollegeVerificationStatus.APPROVED,
    });
  } catch (error) {
    return rethrowDuplicateKey(error, 'A college with this domain or code already exists');
  }
};

export const updateCollege = async (
  collegeId: string,
  input: CollegeInput
): Promise<ICollege> => {
  const college = await getCollegeOrThrow(collegeId);

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ApiError(400, 'VALIDATION_ERROR', 'College name cannot be empty');
    college.name = name;
  }
  if (input.code !== undefined) {
    const code = input.code.trim().toUpperCase();
    if (code && code !== college.code) {
      const duplicate = await College.exists({ code });
      if (duplicate) {
        throw new ApiError(409, 'CONFLICT', `A college with code ${code} already exists`);
      }
      college.code = code;
    }
  }
  if (input.country !== undefined) college.country = input.country.trim();
  if (input.state !== undefined) college.state = input.state.trim();
  if (input.city !== undefined) college.city = input.city.trim();
  if (input.address !== undefined) college.address = input.address.trim();
  if (input.description !== undefined) college.description = input.description.trim();
  if (input.logo !== undefined) college.logo = input.logo.trim();
  if (input.active !== undefined) college.active = Boolean(input.active);
  // Domains are managed through the dedicated domain endpoints only.

  try {
    await college.save();
    return college;
  } catch (error) {
    return rethrowDuplicateKey(error, 'A college with this code already exists');
  }
};

export const setCollegeActive = async (
  collegeId: string,
  active: boolean
): Promise<ICollege> => {
  const college = await getCollegeOrThrow(collegeId);
  college.active = active;
  await college.save();
  return college;
};

export const replaceDomains = async (
  collegeId: string,
  domains: unknown
): Promise<ICollege> => {
  const college = await getCollegeOrThrow(collegeId);
  const normalized = normalizeDomains(domains);
  await assertDomainsAvailable(normalized, collegeId);

  college.domains = normalized;
  try {
    await college.save();
    return college;
  } catch (error) {
    return rethrowDuplicateKey(error, 'One or more domains are already assigned to another college');
  }
};

export const addDomains = async (collegeId: string, domains: unknown): Promise<ICollege> => {
  const college = await getCollegeOrThrow(collegeId);
  const normalized = normalizeDomains(domains);
  const merged = [...new Set([...college.domains, ...normalized])];

  await assertDomainsAvailable(normalized, collegeId);

  college.domains = merged;
  try {
    await college.save();
    return college;
  } catch (error) {
    return rethrowDuplicateKey(error, 'One or more domains are already assigned to another college');
  }
};

export const removeDomain = async (collegeId: string, domain: string): Promise<ICollege> => {
  const college = await getCollegeOrThrow(collegeId);
  const normalized = normalizeDomain(domain);

  college.domains = college.domains.filter((existing) => existing !== normalized);
  await college.save();
  return college;
};
