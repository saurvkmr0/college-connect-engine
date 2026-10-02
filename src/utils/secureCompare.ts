import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison so admin credentials cannot be probed
 * through response timing. Length differences are masked by doing a dummy
 * comparison before returning false.
 */
export const constantTimeEqual = (candidate: string, expected: string): boolean => {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    // Still perform a comparison so the work done is roughly identical.
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
};
