import request, { type Response } from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/lib/logger.js';
import { createAuthModule } from '../../../src/modules/auth/auth.module.js';
import {
  createFirebaseVerifier,
  createUnconfiguredFirebaseVerifier,
} from '../../../src/modules/auth/firebase/firebase-verifier.js';
import { createUsersRepository } from '../../../src/modules/users/users.repository.js';
import {
  buildTestApp,
  protectedTestModule,
  testConfig,
} from '../../helpers/app.js';
import { createTestPrisma, truncateAllTables } from '../../helpers/database.js';
import { FakeFirebaseAuth, fakeIdToken } from '../../helpers/firebase.js';
import { errorOf } from '../../helpers/http.js';
import { createLogCapture } from '../../helpers/log-capture.js';

const prisma = createTestPrisma();

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const PHONE = '+2348031234567';
const UID = 'firebase-uid-1';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Tokens {
  tokenType: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

interface SignInBody {
  data: {
    user: { id: string; phone: string; role: string };
    isNewUser: boolean;
    tokens: Tokens;
  };
}

interface AuthAppOptions {
  env?: NodeJS.ProcessEnv;
  unconfigured?: boolean;
}

function authApp(options: AuthAppOptions = {}) {
  const config = testConfig(options.env);
  const firebase = new FakeFirebaseAuth();
  const moduleLogs = createLogCapture();
  const logger = createLogger(
    { level: 'info', nodeEnv: 'test' },
    moduleLogs.stream,
  );
  const firebaseVerifier =
    options.unconfigured === true
      ? createUnconfiguredFirebaseVerifier(logger)
      : createFirebaseVerifier({
          auth: firebase,
          maxAuthAgeSeconds: config.session.maxFirebaseAuthAgeSeconds,
          logger,
        });
  const { app, logs: appLogs } = buildTestApp({
    config,
    authSubjects: createUsersRepository(prisma),
    v1Modules: [
      createAuthModule({ prisma, logger, config, firebaseVerifier }),
      protectedTestModule,
    ],
  });
  return {
    app,
    firebase,
    allLogs: () => moduleLogs.raw() + appLogs.raw(),
    moduleLogs,
  };
}

type AuthApp = ReturnType<typeof authApp>;

function exchange(app: AuthApp['app'], idToken: string) {
  return request(app).post('/api/v1/auth/firebase').send({ idToken });
}

function refresh(app: AuthApp['app'], refreshToken: string) {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

function logout(app: AuthApp['app'], refreshToken: string) {
  return request(app).post('/api/v1/auth/logout').send({ refreshToken });
}

function callProtected(app: AuthApp['app'], accessToken: string) {
  return request(app)
    .get('/api/v1/test-protected/any')
    .set('Authorization', `Bearer ${accessToken}`);
}

function signInBody(response: Response): SignInBody['data'] {
  return (response.body as SignInBody).data;
}

function tokensOf(response: Response): Tokens {
  return (response.body as { data: { tokens: Tokens } }).data.tokens;
}

async function signIn(
  auth: AuthApp,
  label = 'sign-in',
): Promise<SignInBody['data']> {
  const idToken = fakeIdToken(label);
  auth.firebase.signIn(idToken, { uid: UID, phone: PHONE });
  const response = await exchange(auth.app, idToken).expect(200);
  return signInBody(response);
}

describe('POST /api/v1/auth/firebase', () => {
  it('creates a customer, opens a session and returns usable tokens', async () => {
    const auth = authApp();
    const idToken = fakeIdToken('new-user');
    auth.firebase.signIn(idToken, { uid: UID, phone: PHONE });

    const response = await exchange(auth.app, idToken).expect(200);

    const body = signInBody(response);
    expect(body.isNewUser).toBe(true);
    expect(body.user).toEqual({
      id: expect.any(String) as string,
      phone: PHONE,
      role: 'customer',
    });
    expect(body.tokens).toMatchObject({
      tokenType: 'Bearer',
      accessTokenExpiresAt: expect.stringMatching(ISO_DATE) as string,
      refreshTokenExpiresAt: expect.stringMatching(ISO_DATE) as string,
    });
    expect(response.get('Cache-Control')).toBe('no-store');
    expect(auth.firebase.calls).toEqual([idToken]);

    const session = await prisma.authSession.findFirstOrThrow();
    expect(session).toMatchObject({ userId: body.user.id, firebaseUid: UID });
    const me = await callProtected(auth.app, body.tokens.accessToken).expect(
      200,
    );
    expect(me.body).toEqual({
      data: { userId: body.user.id, role: 'customer' },
    });
  });

  it('signs an existing user in without changing their role', async () => {
    const existing = await prisma.user.create({
      data: { phone: PHONE, role: 'rider' },
    });
    const auth = authApp();

    const body = await signIn(auth);

    expect(body.isNewUser).toBe(false);
    expect(body.user).toEqual({ id: existing.id, phone: PHONE, role: 'rider' });
    await expect(prisma.user.count()).resolves.toBe(1);
  });

  it('opens only one session per Firebase sign-in', async () => {
    const auth = authApp();
    const idToken = fakeIdToken('replayed');
    auth.firebase.signIn(idToken, { uid: UID, phone: PHONE });
    await exchange(auth.app, idToken).expect(200);

    const replay = await exchange(auth.app, idToken).expect(401);

    expect(errorOf(replay).code).toBe('UNAUTHENTICATED');
    await expect(prisma.authSession.count()).resolves.toBe(1);
  });

  it.each([
    ['a role', { role: 'admin' }],
    ['a phone number', { phone: '+2348099999999' }],
  ])('rejects a body that also sends %s', async (_label, extra) => {
    const auth = authApp();
    const idToken = fakeIdToken('extra');
    auth.firebase.signIn(idToken, { uid: UID, phone: PHONE });

    const response = await request(auth.app)
      .post('/api/v1/auth/firebase')
      .send({ idToken, ...extra })
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    expect(auth.firebase.calls).toEqual([]);
    await expect(prisma.user.count()).resolves.toBe(0);
  });

  it.each<[string, unknown]>([
    ['a missing idToken', {}],
    ['a non-string idToken', { idToken: 42 }],
    ['a non-JWT idToken', { idToken: 'opaque' }],
    ['an idToken over 4096 characters', { idToken: `a.b.${'c'.repeat(4093)}` }],
  ])('returns 400 for %s without calling Firebase', async (_label, body) => {
    const auth = authApp();

    const response = await request(auth.app)
      .post('/api/v1/auth/firebase')
      .send(body as object)
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    expect(auth.firebase.calls).toEqual([]);
  });

  it.each([
    'auth/id-token-expired',
    'auth/id-token-revoked',
    'auth/user-disabled',
    'auth/argument-error',
  ])('returns a uniform 401 when Firebase reports %s', async (code) => {
    const auth = authApp();
    const idToken = fakeIdToken(code);
    auth.firebase.fail(idToken, code);

    const response = await exchange(auth.app, idToken).expect(401);

    expect(errorOf(response)).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
    expect(response.get('WWW-Authenticate')).toBe('Bearer');
    await expect(prisma.user.count()).resolves.toBe(0);
  });

  it.each([
    [
      'a sign-in older than the freshness window',
      {
        uid: UID,
        phone: PHONE,
        authTime: Math.floor(Date.now() / 1000) - 301,
      },
    ],
    ['a non-phone sign-in', { uid: UID, phone: PHONE, provider: 'password' }],
    ['a token without a phone number', { uid: UID }],
  ])('returns 401 for %s and creates nothing', async (_label, fake) => {
    const auth = authApp();
    const idToken = fakeIdToken('claims');
    auth.firebase.signIn(idToken, fake);

    await exchange(auth.app, idToken).expect(401);

    await expect(prisma.user.count()).resolves.toBe(0);
    await expect(prisma.authSession.count()).resolves.toBe(0);
  });

  it('returns 403 PHONE_NOT_SUPPORTED for a non-Nigerian number', async () => {
    const auth = authApp();
    const idToken = fakeIdToken('foreign');
    auth.firebase.signIn(idToken, { uid: UID, phone: '+14155550123' });

    const response = await exchange(auth.app, idToken).expect(403);

    expect(errorOf(response).code).toBe('PHONE_NOT_SUPPORTED');
    await expect(prisma.user.count()).resolves.toBe(0);
  });

  it('returns 403 ACCOUNT_SUSPENDED and opens no session for a suspended user', async () => {
    await prisma.user.create({ data: { phone: PHONE, status: 'suspended' } });
    const auth = authApp();
    const idToken = fakeIdToken('suspended');
    auth.firebase.signIn(idToken, { uid: UID, phone: PHONE });

    const response = await exchange(auth.app, idToken).expect(403);

    expect(errorOf(response).code).toBe('ACCOUNT_SUSPENDED');
    await expect(prisma.authSession.count()).resolves.toBe(0);
  });

  it('returns 503 when Firebase cannot be reached', async () => {
    const auth = authApp();
    const idToken = fakeIdToken('outage');
    auth.firebase.fail(idToken, 'app/network-error');

    const response = await exchange(auth.app, idToken).expect(503);

    expect(errorOf(response)).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Sign-in is temporarily unavailable',
    });
  });

  it('returns 503 and logs a configuration warning when Firebase is not configured', async () => {
    const auth = authApp({ unconfigured: true });

    const response = await exchange(auth.app, fakeIdToken('any')).expect(503);

    expect(errorOf(response).code).toBe('SERVICE_UNAVAILABLE');
    expect(auth.moduleLogs.raw()).toContain(
      'Firebase is not configured; set FIREBASE_SERVICE_ACCOUNT_BASE64',
    );
  });

  it('returns 429 with Retry-After once the exchange budget is spent', async () => {
    const auth = authApp({
      env: {
        AUTH_EXCHANGE_RATE_LIMIT_MAX: '2',
        AUTH_EXCHANGE_RATE_LIMIT_WINDOW_MS: '60000',
      },
    });

    await exchange(auth.app, fakeIdToken('one')).expect(401);
    await exchange(auth.app, fakeIdToken('two')).expect(401);
    const response = await exchange(auth.app, fakeIdToken('three')).expect(429);

    expect(errorOf(response).code).toBe('RATE_LIMITED');
    expect(Number(response.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(auth.firebase.calls).toHaveLength(2);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the pair and keeps the session usable', async () => {
    const auth = authApp();
    const { tokens } = await signIn(auth);

    const response = await refresh(auth.app, tokens.refreshToken).expect(200);

    const next = tokensOf(response);
    expect(response.get('Cache-Control')).toBe('no-store');
    expect(next.tokenType).toBe('Bearer');
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(next.refreshToken.split('.')[0]).toBe(
      tokens.refreshToken.split('.')[0],
    );
    await callProtected(auth.app, next.accessToken).expect(200);
    await refresh(auth.app, next.refreshToken).expect(200);
  });

  it('revokes the session when a superseded refresh token is replayed', async () => {
    const auth = authApp();
    const { tokens } = await signIn(auth);
    const next = tokensOf(
      await refresh(auth.app, tokens.refreshToken).expect(200),
    );

    const replay = await refresh(auth.app, tokens.refreshToken).expect(401);

    expect(errorOf(replay).code).toBe('UNAUTHENTICATED');
    await callProtected(auth.app, next.accessToken).expect(401);
    await refresh(auth.app, next.refreshToken).expect(401);
    const session = await prisma.authSession.findFirstOrThrow();
    expect(session.revokedReason).toBe('refresh_reuse');
    expect(auth.moduleLogs.lines).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'Refresh token reuse detected; session revoked',
        sessionId: session.id,
        userId: session.userId,
      }),
    );
  });

  it('returns 401 for a well-formed token that matches no session', async () => {
    const auth = authApp();

    const response = await refresh(
      auth.app,
      `3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11.${'a'.repeat(43)}`,
    ).expect(401);

    expect(errorOf(response).code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 once the session is past its idle expiry', async () => {
    const auth = authApp();
    const { tokens } = await signIn(auth);
    await prisma.authSession.updateMany({
      data: { refreshExpiresAt: new Date(Date.now() - 1000) },
    });

    await refresh(auth.app, tokens.refreshToken).expect(401);
  });

  it('returns 403 ACCOUNT_SUSPENDED for a suspended user', async () => {
    const auth = authApp();
    const { user, tokens } = await signIn(auth);
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'suspended' },
    });

    const response = await refresh(auth.app, tokens.refreshToken).expect(403);

    expect(errorOf(response).code).toBe('ACCOUNT_SUSPENDED');
    expect(response.body).not.toHaveProperty('data');
  });

  it.each<[string, unknown]>([
    ['a missing token', {}],
    ['a malformed token', { refreshToken: 'not-a-refresh-token' }],
    [
      'an extra field',
      {
        refreshToken: `3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11.${'a'.repeat(43)}`,
        userId: 'x',
      },
    ],
  ])('returns 400 for %s', async (_label, body) => {
    const auth = authApp();

    const response = await request(auth.app)
      .post('/api/v1/auth/refresh')
      .send(body as object)
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('not-a-refresh-token');
  });

  it('shares one rate limit budget with logout', async () => {
    const auth = authApp({
      env: {
        AUTH_REFRESH_RATE_LIMIT_MAX: '2',
        AUTH_REFRESH_RATE_LIMIT_WINDOW_MS: '60000',
      },
    });
    const unknown = `3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11.${'a'.repeat(43)}`;

    await refresh(auth.app, unknown).expect(401);
    await logout(auth.app, unknown).expect(204);
    const response = await refresh(auth.app, unknown).expect(429);

    expect(errorOf(response).code).toBe('RATE_LIMITED');
    expect(response.get('Retry-After')).toBeDefined();
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session so its access and refresh tokens stop working', async () => {
    const auth = authApp();
    const { tokens } = await signIn(auth);

    const response = await logout(auth.app, tokens.refreshToken).expect(204);

    expect(response.text).toBe('');
    await callProtected(auth.app, tokens.accessToken).expect(401);
    await refresh(auth.app, tokens.refreshToken).expect(401);
    const session = await prisma.authSession.findFirstOrThrow();
    expect(session.revokedReason).toBe('logout');
  });

  it('returns 204 for a token that matches no live session', async () => {
    const auth = authApp();
    const { tokens } = await signIn(auth);
    await logout(auth.app, tokens.refreshToken).expect(204);

    await logout(auth.app, tokens.refreshToken).expect(204);
    await logout(
      auth.app,
      `3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11.${'a'.repeat(43)}`,
    ).expect(204);
  });

  it('returns 400 only for a malformed body', async () => {
    const auth = authApp();

    const response = await request(auth.app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: 'nope' })
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
  });
});

describe('auth logging', () => {
  it('never logs ID tokens, access tokens, refresh tokens or phone numbers', async () => {
    const auth = authApp();
    const idToken = fakeIdToken('logging');
    auth.firebase.signIn(idToken, { uid: UID, phone: PHONE });
    const first = signInBody(await exchange(auth.app, idToken).expect(200));
    await exchange(auth.app, idToken).expect(401);
    const second = tokensOf(
      await refresh(auth.app, first.tokens.refreshToken).expect(200),
    );
    await refresh(auth.app, first.tokens.refreshToken).expect(401);
    await logout(auth.app, second.refreshToken).expect(204);
    const failing = fakeIdToken('failing');
    auth.firebase.fail(failing, 'auth/id-token-expired');
    await exchange(auth.app, failing).expect(401);

    const logs = auth.allLogs();
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      idToken,
      failing,
      first.tokens.accessToken,
      first.tokens.refreshToken,
      second.accessToken,
      second.refreshToken,
      first.tokens.refreshToken.split('.')[1] ?? '',
      second.refreshToken.split('.')[1] ?? '',
      PHONE,
    ]) {
      expect(secret).not.toBe('');
      expect(logs).not.toContain(secret);
    }
  });
});
