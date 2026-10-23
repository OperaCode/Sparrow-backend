import { z } from 'zod';
import { ValidationError } from './errors.js';

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;

const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(PAGE_LIMIT_MAX)
  .default(PAGE_LIMIT_DEFAULT);

const pageCursorSchema = z.string().trim().min(1).max(256).optional();

/**
 * A list query is a cursor page plus the exact-match filters the resource
 * declares. `limit` and `cursor` always win over a filter of the same name.
 * Unknown query keys are rejected. Clients do not send `sort`, `page`, or
 * `offset`; order is newest `createdAt`, then `id`, descending.
 */
export function listQuerySchema<Filters extends z.ZodRawShape>(
  filters: Filters,
) {
  return z.strictObject({
    ...filters,
    limit: pageLimitSchema,
    cursor: pageCursorSchema,
  });
}

export interface PageCursor {
  createdAt: Date;
  id: string;
}

const cursorSchema = z.strictObject({
  v: z.literal(1),
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

const MAX_CURSOR_TEXT_LENGTH = 200;

function invalidCursor(): never {
  throw new ValidationError([
    { path: 'query.cursor', message: 'Cursor is invalid' },
  ]);
}

/** Opaque cursor. The client sends it back unchanged. */
export function encodePageCursor(cursor: PageCursor): string {
  const payload = JSON.stringify({
    v: 1,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function readPageCursor(token: string): PageCursor {
  let text: string;
  try {
    text = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    invalidCursor();
  }
  if (text.length === 0 || text.length > MAX_CURSOR_TEXT_LENGTH)
    invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalidCursor();
  }

  const result = cursorSchema.safeParse(parsed);
  if (!result.success) invalidCursor();
  const createdAt = new Date(result.data.createdAt);
  if (Number.isNaN(createdAt.getTime())) invalidCursor();
  return { createdAt, id: result.data.id };
}

export interface CreatedAtPage {
  limit: number;
  cursor: PageCursor | null;
}

/** Turns a parsed list query into the page a repository fetches. */
export function createdAtPage(query: {
  limit: number;
  cursor?: string;
}): CreatedAtPage {
  return {
    limit: query.limit,
    cursor: query.cursor === undefined ? null : readPageCursor(query.cursor),
  };
}

export interface PageSlice<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * `rows` must be ordered newest first and contain at most `limit + 1` rows.
 * The extra row is not returned; its presence is what sets `nextCursor`.
 */
export function slicePage<T extends PageCursor>(
  rows: readonly T[],
  limit: number,
): PageSlice<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Page limit must be a positive integer');
  }
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (!hasMore || last === undefined) {
    return { items, nextCursor: null };
  }
  return { items, nextCursor: encodePageCursor(last) };
}

/** List responses always include this, including `nextCursor: null`. */
export function pageMeta(
  limit: number,
  nextCursor: string | null,
): { limit: number; nextCursor: string | null } {
  return { limit, nextCursor };
}
