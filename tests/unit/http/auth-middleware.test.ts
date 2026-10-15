import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthSubjectLookup } from '../../../src/http/middleware/authenticate.js';
import type { AccountStatus, Role } from '../../../src/types/auth.js';
import {
  buildTestApp,
  protectedTestModule,
  tokenFor,
} from '../../helpers/app.js';
import { errorOf } from '../../helpers/http.js';

const USER_ID = '3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11';

function subjects(
  role: Role | null,
  status: AccountStatus = 'active',
): AuthSubjectLookup {
  return {
    findAuthSubjectById: (id) =>
      Promise.resolve(role === null ? null : { id, role, status }),
  };
}

function appWith(role: Role | null, status?: AccountStatus) {
  return buildTestApp({
    authSubjects: subjects(role, status),
    v1Modules: [protectedTestModule],
  }).app;
}

describe('authenticate', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['an empty bearer token', 'Bearer '],
    ['a token with extra parts', 'Bearer a.b.c d'],
    ['a non-JWT token', 'Bearer opaque-token'],
  ])('returns 401 for %s', async (_label, header) => {
    const req = request(appWith('customer')).get('/api/v1/test-protected/any');
    if (header !== undefined) req.set('Authorization', header);

    const response = await req.expect(401);

    expect(errorOf(response)).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
    expect(response.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('returns 401 for a token that fails verification', async () => {
    const response = await request(appWith('customer'))
      .get('/api/v1/test-protected/any')
      .set('Authorization', 'Bearer aaa.bbb.ccc')
      .expect(401);

    expect(errorOf(response).code).toBe('UNAUTHENTICATED');
  });

  it('returns the same 401 when the user no longer exists', async () => {
    const response = await request(appWith(null))
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${await tokenFor(USER_ID)}`)
      .expect(401);

    expect(errorOf(response)).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('returns 403 ACCOUNT_SUSPENDED for a suspended user', async () => {
    const response = await request(appWith('admin', 'suspended'))
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${await tokenFor(USER_ID)}`)
      .expect(403);

    expect(errorOf(response).code).toBe('ACCOUNT_SUSPENDED');
  });

  it('accepts a lowercase bearer scheme', async () => {
    await request(appWith('customer'))
      .get('/api/v1/test-protected/any')
      .set('Authorization', `bearer ${await tokenFor(USER_ID)}`)
      .expect(200);
  });

  it('attaches the user id and database role to the request', async () => {
    const response = await request(appWith('rider'))
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${await tokenFor(USER_ID)}`)
      .expect(200);

    expect(response.body).toEqual({ data: { userId: USER_ID, role: 'rider' } });
  });
});

describe('requireRole', () => {
  it.each<[Role, string, number]>([
    ['customer', '/admin', 403],
    ['rider', '/admin', 403],
    ['admin', '/admin', 200],
    ['customer', '/staff', 403],
    ['rider', '/staff', 200],
    ['admin', '/staff', 200],
  ])('%s on %s returns %i', async (role, path, status) => {
    const response = await request(appWith(role))
      .get(`/api/v1/test-protected${path}`)
      .set('Authorization', `Bearer ${await tokenFor(USER_ID)}`)
      .expect(status);

    if (status === 403) {
      expect(errorOf(response).code).toBe('FORBIDDEN');
    }
  });

  it('fails closed with a 500 when mounted without authenticate', async () => {
    const { app, logs } = buildTestApp({
      authSubjects: subjects('admin'),
      v1Modules: [protectedTestModule],
    });

    const response = await request(app)
      .get('/api/v1/test-protected/misconfigured')
      .set('Authorization', `Bearer ${await tokenFor(USER_ID)}`)
      .expect(500);

    expect(errorOf(response).code).toBe('INTERNAL_ERROR');
    expect(logs.raw()).toContain(
      'requireRole must be mounted after authenticate',
    );
  });
});
