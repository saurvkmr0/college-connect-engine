import { Request } from 'express';

/**
 * Reads a body/query value as a trimmed string. Anything else (objects, arrays,
 * numbers) becomes '' - this is what blocks `{ "email": { "$gt": "" } }` style
 * NoSQL operator injection. Use it for every user-supplied value that reaches a query.
 */
export const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Escapes user input before it is used inside a `$regex` (prevents ReDoS / regex injection). */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `?page=&limit=` clamped to sane bounds, so `limit=1000000` or `page=-1` cannot hurt the DB. */
export const parsePagination = (query: Request['query'], maxLimit = 50) => {
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(Number(query.limit)) || 20));
  return { page, limit, skip: (page - 1) * limit };
};
