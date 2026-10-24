import { randomUUID } from 'node:crypto';

/**
 * Built at runtime so no token-shaped literal is committed for secret
 * scanners to flag. A random uuid matches no session in a truncated database.
 */
export function unknownSessionId(): string {
  return randomUUID();
}

/** Well-formed, so it passes validation and is rejected by the lookup. */
export function unknownRefreshToken(): string {
  return `${unknownSessionId()}.${'a'.repeat(43)}`;
}
