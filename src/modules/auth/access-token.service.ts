import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import { UnauthorizedError } from '../../http/errors.js';

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

type AuthConfig = Config['auth'];

const ALGORITHM = 'HS256';

/**
 * RFC 9068 access token type. Checked in the protected header, so any other
 * kind of token signed with the same key is rejected.
 */
export const ACCESS_TOKEN_TYPE = 'at+jwt';

const CLOCK_TOLERANCE_SECONDS = 5;

const claimsSchema = z.object({ sub: z.uuid(), sid: z.uuid() });

function secretKey(config: AuthConfig): Uint8Array {
  return new TextEncoder().encode(config.accessTokenSecret);
}

export function createAccessTokenVerifier(
  config: AuthConfig,
): AccessTokenVerifier {
  const key = secretKey(config);

  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer: config.issuer,
          audience: config.audience,
          typ: ACCESS_TOKEN_TYPE,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ['sub', 'sid', 'exp', 'iat'],
        });
        const claims = claimsSchema.parse(payload);
        return { userId: claims.sub, sessionId: claims.sid };
      } catch {
        // Every failure looks the same to the caller so the response cannot
        // be used to probe which check failed.
        throw new UnauthorizedError();
      }
    },
  };
}

/**
 * Issues an access token bound to a session. The sid claim lets
 * authenticate reject the token as soon as its session is revoked.
 */
export async function signAccessToken(
  config: AuthConfig,
  claims: AccessTokenClaims,
  ttlSeconds: number,
): Promise<SignedAccessToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const token = await new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: ALGORITHM, typ: ACCESS_TOKEN_TYPE })
    .setSubject(claims.userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(secretKey(config));
  return { token, expiresAt: new Date(expiresAt * 1000) };
}
