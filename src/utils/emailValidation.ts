/**
 * Low-level email / domain helpers shared by the model, services and controllers.
 * Kept dependency-free so it can be imported from anywhere without cycles.
 */

// Practical RFC 5322 subset: local@domain.tld (no quoted/escaped local parts).
const EMAIL_REGEX =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

// host.tld with at least one dot, labels of alphanumerics and hyphens.
const DOMAIN_REGEX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Trim + lowercase, exactly as required for stored email addresses. */
export const normalizeEmail = (email: string): string =>
  (email || '').trim().toLowerCase();

/**
 * Normalize a domain for storage/lookup:
 * trimmed, lowercase, without a leading `@`.
 */
export const normalizeDomain = (domain: string): string =>
  (domain || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .trim();

export const isValidEmail = (email: string): boolean =>
  email.length <= 254 && EMAIL_REGEX.test(email);

export const isValidDomain = (domain: string): boolean => DOMAIN_REGEX.test(domain);

/** Extract the normalized domain from a normalized email, or '' when invalid. */
export const extractDomain = (email: string): string => {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  return normalizeDomain(email.slice(at + 1));
};

/**
 * Public mailbox providers. A college rep must use their institution's own domain:
 * approving a college that owns `gmail.com` would let anyone verify as its student.
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'zoho.com', 'gmx.com', 'yandex.com', 'mail.com',
]);

export const isFreeEmailDomain = (domain: string): boolean => FREE_EMAIL_DOMAINS.has(normalizeDomain(domain));
