import { createHash, randomBytes } from 'node:crypto';

const SECRET_BYTES = 32;

/**
 * <session uuid>.<43 base64url characters>. Postgres renders uuids in
 * lowercase, so uppercase input is not a token this server issued.
 */
export const REFRESH_TOKEN_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export interface RefreshSecret {
  secret: string;
  hash: Uint8Array<ArrayBuffer>;
}

export interface ParsedRefreshToken {
  sessionId: string;
  hash: Uint8Array<ArrayBuffer>;
}

/**
 * The secret carries 256 bits of entropy, so a single fast hash is enough:
 * there is nothing to brute-force that a slow hash would protect.
 */
export function hashRefreshSecret(secret: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(secret, 'utf8').digest());
}

export function generateRefreshSecret(): RefreshSecret {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { secret, hash: hashRefreshSecret(secret) };
}

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(token: string): ParsedRefreshToken | null {
  const match = REFRESH_TOKEN_PATTERN.exec(token);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { sessionId: match[1], hash: hashRefreshSecret(match[2]) };
}
