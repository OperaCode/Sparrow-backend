import { describe, expect, it, vi } from 'vitest';
import {
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../../../../src/http/errors.js';
import { createLogger } from '../../../../../src/lib/logger.js';
import {
  createFirebaseAuth,
  createFirebaseVerifier,
  createUnconfiguredFirebaseVerifier,
  type DecodedIdToken,
  type IdTokenDecoder,
} from '../../../../../src/modules/auth/firebase/firebase-verifier.js';
import { TEST_SERVICE_ACCOUNT } from '../../../../helpers/firebase-service-account.js';
import { createLogCapture } from '../../../../helpers/log-capture.js';

const PROJECT_ID = 'sparrow-test-123';
const UID = 'firebase-uid-123';
const ID_TOKEN = 'header.payload.signature-that-must-not-be-logged';
const NOW_MS = Date.UTC(2026, 9, 16, 12, 0, 0);
const NOW_SECONDS = NOW_MS / 1000;
const MAX_AUTH_AGE_SECONDS = 300;

function decodedToken(overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return {
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: UID,
    uid: UID,
    iat: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 3570,
    auth_time: NOW_SECONDS - 30,
    phone_number: '+2348031234567',
    firebase: {
      identities: { phone: ['+2348031234567'] },
      sign_in_provider: 'phone',
    },
    ...overrides,
  };
}

function firebaseError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Firebase said ${ID_TOKEN}`), { code });
}

function setup(result: () => Promise<DecodedIdToken>) {
  const logs = createLogCapture();
  const logger = createLogger({ level: 'info', nodeEnv: 'test' }, logs.stream);
  const verifyIdToken = vi.fn<IdTokenDecoder['verifyIdToken']>(result);
  const verifier = createFirebaseVerifier({
    auth: { verifyIdToken },
    maxAuthAgeSeconds: MAX_AUTH_AGE_SECONDS,
    logger,
    now: () => NOW_MS,
  });
  return { verifier, verifyIdToken, logs };
}

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected verification to fail');
    },
    (error: unknown) => error,
  );
}

describe('Firebase ID token verifier', () => {
  it('returns the uid, E.164 phone and sign-in time of a phone token', async () => {
    const { verifier, verifyIdToken } = setup(() =>
      Promise.resolve(decodedToken()),
    );

    await expect(verifier.verify(ID_TOKEN)).resolves.toEqual({
      uid: UID,
      phone: '+2348031234567',
      authTime: new Date((NOW_SECONDS - 30) * 1000),
    });
    expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith(ID_TOKEN, true);
  });

  it('accepts a sign-in exactly at the maximum age', async () => {
    const { verifier } = setup(() =>
      Promise.resolve(
        decodedToken({ auth_time: NOW_SECONDS - MAX_AUTH_AGE_SECONDS }),
      ),
    );

    await expect(verifier.verify(ID_TOKEN)).resolves.toMatchObject({
      uid: UID,
    });
  });

  it.each([
    'auth/argument-error',
    'auth/id-token-expired',
    'auth/id-token-revoked',
    'auth/invalid-id-token',
    'auth/invalid-user-token',
    'auth/user-disabled',
    'auth/user-not-found',
  ])('maps %s to a generic 401 and logs only the code', async (code) => {
    const { verifier, logs } = setup(() => Promise.reject(firebaseError(code)));

    const error = await failure(verifier.verify(ID_TOKEN));

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({ message: 'Authentication required' });
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ firebaseCode: code, level: 30 }),
    );
    expect(logs.raw()).not.toContain(ID_TOKEN);
  });

  it.each<[string, () => Error]>([
    ['an internal error', () => firebaseError('auth/internal-error')],
    ['a network error', () => firebaseError('app/network-error')],
    ['a credential error', () => firebaseError('auth/invalid-credential')],
    ['an error without a code', () => new TypeError(ID_TOKEN)],
  ])('maps %s to 503 and never logs the token', async (_label, make) => {
    const { verifier, logs } = setup(() => Promise.reject(make()));

    const error = await failure(verifier.verify(ID_TOKEN));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({
      statusCode: 503,
      message: 'Sign-in is temporarily unavailable',
    });
    expect(logs.lines).toContainEqual(
      expect.objectContaining({
        msg: 'Firebase ID token check failed',
        level: 50,
      }),
    );
    expect(logs.raw()).not.toContain(ID_TOKEN);
  });

  it.each<[string, Partial<DecodedIdToken>, string]>([
    [
      'a password sign-in',
      {
        firebase: { identities: {}, sign_in_provider: 'password' },
      },
      'wrong_provider',
    ],
    [
      'an anonymous sign-in',
      {
        firebase: { identities: {}, sign_in_provider: 'anonymous' },
      },
      'wrong_provider',
    ],
    [
      'a custom token sign-in that carries a phone number',
      {
        firebase: { identities: {}, sign_in_provider: 'custom' },
      },
      'wrong_provider',
    ],
    [
      'a token without a phone number',
      { phone_number: undefined },
      'missing_phone',
    ],
    [
      'a sign-in older than the maximum age',
      { auth_time: NOW_SECONDS - MAX_AUTH_AGE_SECONDS - 1 },
      'stale_auth_time',
    ],
    [
      'a sign-in time far in the future',
      { auth_time: NOW_SECONDS + 61 },
      'invalid_auth_time',
    ],
    [
      'a non-integer sign-in time',
      { auth_time: NOW_SECONDS - 0.5 },
      'invalid_auth_time',
    ],
  ])('rejects %s with 401', async (_label, overrides, reason) => {
    const { verifier, logs } = setup(() =>
      Promise.resolve(decodedToken(overrides)),
    );

    const error = await failure(verifier.verify(ID_TOKEN));

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(logs.lines).toContainEqual(expect.objectContaining({ reason }));
  });

  it('tolerates a sign-in time slightly ahead of the server clock', async () => {
    const { verifier } = setup(() =>
      Promise.resolve(decodedToken({ auth_time: NOW_SECONDS + 60 })),
    );

    await expect(verifier.verify(ID_TOKEN)).resolves.toMatchObject({
      uid: UID,
    });
  });

  it.each([
    ['a foreign mobile number', '+14155550123'],
    ['a Nigerian landline', '+2341234567890'],
  ])('rejects %s with 403 PHONE_NOT_SUPPORTED', async (_label, phone) => {
    const { verifier } = setup(() =>
      Promise.resolve(decodedToken({ phone_number: phone })),
    );

    const error = await failure(verifier.verify(ID_TOKEN));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({
      statusCode: 403,
      code: 'PHONE_NOT_SUPPORTED',
    });
  });
});

describe('createFirebaseAuth', () => {
  // Rejected while decoding, before any certificate fetch, so no network.
  it('builds an Admin SDK client that rejects a malformed token', async () => {
    const logs = createLogCapture();
    const verifier = createFirebaseVerifier({
      auth: createFirebaseAuth(
        {
          projectId: TEST_SERVICE_ACCOUNT.project_id,
          clientEmail: TEST_SERVICE_ACCOUNT.client_email,
          privateKey: TEST_SERVICE_ACCOUNT.private_key,
        },
        {},
      ),
      maxAuthAgeSeconds: MAX_AUTH_AGE_SECONDS,
      logger: createLogger({ level: 'info', nodeEnv: 'test' }, logs.stream),
    });

    const error = await failure(verifier.verify('not-a-jwt'));

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ firebaseCode: 'auth/argument-error' }),
    );
  });

  it('refuses to start when the auth emulator variable is set', () => {
    expect(() =>
      createFirebaseAuth(
        {
          projectId: PROJECT_ID,
          clientEmail: `x@${PROJECT_ID}.iam.gserviceaccount.com`,
          privateKey: 'unused',
        },
        { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
      ),
    ).toThrow('FIREBASE_AUTH_EMULATOR_HOST is set');
  });
});

describe('unconfigured Firebase verifier', () => {
  it('fails every sign-in with 503 and warns how to configure it', async () => {
    const logs = createLogCapture();
    const verifier = createUnconfiguredFirebaseVerifier(
      createLogger({ level: 'info', nodeEnv: 'test' }, logs.stream),
    );

    const error = await failure(verifier.verify(ID_TOKEN));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(logs.lines).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'Firebase is not configured; set FIREBASE_SERVICE_ACCOUNT_BASE64',
      }),
    );
  });
});
