import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  formatRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
  parseRefreshToken,
} from '../../../../src/modules/auth/refresh-token.js';

const SESSION_ID = '3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11';

describe('refresh tokens', () => {
  it('generates a 43-character base64url secret and its SHA-256 hash', () => {
    const { secret, hash } = generateRefreshSecret();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(hash)).toEqual(
      createHash('sha256').update(secret).digest(),
    );
    expect(hash.byteLength).toBe(32);
  });

  it('never generates the same secret twice', () => {
    const secrets = new Set(
      Array.from({ length: 100 }, () => generateRefreshSecret().secret),
    );

    expect(secrets.size).toBe(100);
  });

  it('round-trips a formatted token to its session id and hash', () => {
    const { secret, hash } = generateRefreshSecret();

    expect(parseRefreshToken(formatRefreshToken(SESSION_ID, secret))).toEqual({
      sessionId: SESSION_ID,
      hash,
    });
  });

  it('hashes the secret only, not the session id', () => {
    const { secret } = generateRefreshSecret();

    expect(
      parseRefreshToken(formatRefreshToken(SESSION_ID, secret))?.hash,
    ).toEqual(hashRefreshSecret(secret));
  });

  const secret = 'a'.repeat(43);
  it.each([
    ['an empty string', ''],
    ['a secret only', secret],
    ['a non-uuid session id', `not-a-uuid.${secret}`],
    ['an uppercase session id', `${SESSION_ID.toUpperCase()}.${secret}`],
    ['a short secret', `${SESSION_ID}.${'a'.repeat(42)}`],
    ['a long secret', `${SESSION_ID}.${'a'.repeat(44)}`],
    ['a padded base64 secret', `${SESSION_ID}.${'a'.repeat(42)}=`],
    ['a non-base64url character', `${SESSION_ID}.${'a'.repeat(42)}+`],
    ['a second separator', `${SESSION_ID}.${secret}.x`],
    ['surrounding whitespace', ` ${SESSION_ID}.${secret}`],
    ['a trailing newline', `${SESSION_ID}.${secret}\n`],
  ])('rejects %s', (_label, token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });
});
