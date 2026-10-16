import {
  decodeJwt,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type JWTPayload,
} from 'jose';
import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '../../../../src/http/errors.js';
import {
  ACCESS_TOKEN_TYPE,
  createAccessTokenVerifier,
  signAccessToken,
} from '../../../../src/modules/auth/access-token.service.js';
import { testConfig, TEST_JWT_SECRET } from '../../../helpers/app.js';

const config = testConfig();
const verifier = createAccessTokenVerifier(config.auth);
const USER_ID = '3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11';
const SESSION_ID = '9b2d4a63-1c7e-4f0a-8d35-6e1f2a3b4c5d';
const CLAIMS = { userId: USER_ID, sessionId: SESSION_ID };
const secret = new TextEncoder().encode(TEST_JWT_SECRET);
const nowSeconds = () => Math.floor(Date.now() / 1000);

interface Forge {
  alg?: string;
  typ?: string;
  key?: Uint8Array;
  payload?: JWTPayload;
}

function forge({
  alg = 'HS256',
  typ = ACCESS_TOKEN_TYPE,
  key = secret,
  payload = {},
}: Forge = {}): Promise<string> {
  return new SignJWT({
    sub: USER_ID,
    sid: SESSION_ID,
    iss: config.auth.issuer,
    aud: config.auth.audience,
    iat: nowSeconds(),
    exp: nowSeconds() + 300,
    ...payload,
  })
    .setProtectedHeader({ alg, typ })
    .sign(key);
}

describe('access token verifier', () => {
  it('accepts a token issued by signAccessToken', async () => {
    const { token } = await signAccessToken(config.auth, CLAIMS, 300);

    await expect(verifier.verify(token)).resolves.toEqual(CLAIMS);
  });

  it('reports the same expiry it signs into the token', async () => {
    const { token, expiresAt } = await signAccessToken(
      config.auth,
      CLAIMS,
      900,
    );

    const payload = decodeJwt(token);
    expect(payload.sid).toBe(SESSION_ID);
    expect(expiresAt.getTime()).toBe((payload.exp ?? 0) * 1000);
    expect(payload.exp).toBe((payload.iat ?? 0) + 900);
  });

  it('tolerates a few seconds of clock skew', async () => {
    const token = await forge({ payload: { exp: nowSeconds() - 2 } });

    await expect(verifier.verify(token)).resolves.toEqual(CLAIMS);
  });

  const rejected: [string, () => Promise<string>][] = [
    ['an expired token', () => forge({ payload: { exp: nowSeconds() - 60 } })],
    [
      'a token signed with another secret',
      () => forge({ key: new TextEncoder().encode('y'.repeat(32)) }),
    ],
    ['a different HMAC algorithm', () => forge({ alg: 'HS512' })],
    ['a non-access token type', () => forge({ typ: 'JWT' })],
    ['the wrong issuer', () => forge({ payload: { iss: 'someone-else' } })],
    ['the wrong audience', () => forge({ payload: { aud: 'another-app' } })],
    ['a missing subject', () => forge({ payload: { sub: undefined } })],
    ['a non-uuid subject', () => forge({ payload: { sub: 'admin' } })],
    ['a missing session id', () => forge({ payload: { sid: undefined } })],
    ['a non-uuid session id', () => forge({ payload: { sid: 'session-1' } })],
    ['a numeric session id', () => forge({ payload: { sid: 42 } })],
    ['a missing expiry', () => forge({ payload: { exp: undefined } })],
    ['a missing issued-at', () => forge({ payload: { iat: undefined } })],
    [
      'an unsigned alg=none token',
      () =>
        Promise.resolve(
          new UnsecuredJWT({ sub: USER_ID, sid: SESSION_ID })
            .setIssuer(config.auth.issuer)
            .setAudience(config.auth.audience)
            .setIssuedAt()
            .setExpirationTime('5m')
            .encode(),
        ),
    ],
    [
      'an RS256 token',
      async () => {
        const { privateKey } = await generateKeyPair('RS256');
        return new SignJWT({ sub: USER_ID, sid: SESSION_ID })
          .setProtectedHeader({ alg: 'RS256', typ: ACCESS_TOKEN_TYPE })
          .setIssuer(config.auth.issuer)
          .setAudience(config.auth.audience)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
      },
    ],
    ['a malformed string', () => Promise.resolve('not.a.jwt')],
  ];

  it.each(rejected)('rejects %s with a generic 401', async (_label, make) => {
    const token = await make();

    const error = await verifier
      .verify(token)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });
});
