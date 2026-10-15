import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import { UnauthorizedError } from '../../http/errors.js';

export interface AccessTokenClaims {
  userId: string;
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

const subjectSchema = z.uuid();

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
          requiredClaims: ['sub', 'exp', 'iat'],
        });
        return { userId: subjectSchema.parse(payload.sub) };
      } catch {
        // Every failure looks the same to the caller so the response cannot
        // be used to probe which check failed.
        throw new UnauthorizedError();
      }
    },
  };
}

/**
 * Issues an access token. Used by the development token script now and by
 * the OTP login flow later; no HTTP endpoint issues tokens yet.
 */
export async function signAccessToken(
  config: AuthConfig,
  userId: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT()
    .setProtectedHeader({ alg: ALGORITHM, typ: ACCESS_TOKEN_TYPE })
    .setSubject(userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(config));
}
