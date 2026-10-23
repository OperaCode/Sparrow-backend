import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUsersRepository } from '#src/modules/users/users.repository.js';
import { createTestAccount } from '../../helpers/account.js';
import {
  buildTestApp,
  protectedTestModule,
  tokenFor,
} from '../../helpers/app.js';
import { createTestPrisma, truncateAllTables } from '../../helpers/database.js';
import { errorOf } from '../../helpers/http.js';

const prisma = createTestPrisma();
const { app } = buildTestApp({
  authSubjects: createUsersRepository(prisma),
  v1Modules: [protectedTestModule],
});

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('protected routes against PostgreSQL', () => {
  it('lets an admin through an admin-only route', async () => {
    const admin = await createTestAccount(prisma, '+2348030000001', 'admin');

    const response = await request(app)
      .get('/api/v1/test-protected/admin')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(response.body).toEqual({
      data: { userId: admin.user.id, role: 'admin' },
    });
  });

  it('blocks a customer from an admin-only route', async () => {
    const customer = await createTestAccount(prisma, '+2348030000002');

    const response = await request(app)
      .get('/api/v1/test-protected/admin')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);

    expect(errorOf(response).code).toBe('FORBIDDEN');
  });

  it('applies a demotion immediately to an already-issued token', async () => {
    const { user, token } = await createTestAccount(
      prisma,
      '+2348030000003',
      'admin',
    );
    await request(app)
      .get('/api/v1/test-protected/admin')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'customer' },
    });

    await request(app)
      .get('/api/v1/test-protected/admin')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('applies a deactivation immediately to an already-issued token', async () => {
    const { user, token } = await createTestAccount(prisma, '+2348030000006');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'deactivated' },
    });

    const response = await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(errorOf(response).code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('applies a suspension immediately to an already-issued token', async () => {
    const { user, token } = await createTestAccount(prisma, '+2348030000004');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'suspended' },
    });

    const response = await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(errorOf(response).code).toBe('ACCOUNT_SUSPENDED');
  });

  it.each<
    [string, { revokedAt: Date; revokedReason: 'logout' | 'refresh_reuse' }]
  >([
    ['logged out', { revokedAt: new Date(), revokedReason: 'logout' }],
    [
      'revoked for refresh reuse',
      { revokedAt: new Date(), revokedReason: 'refresh_reuse' },
    ],
  ])('rejects a token at once when its session is %s', async (_label, data) => {
    const { user, token } = await createTestAccount(prisma, '+2348030000006');
    await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await prisma.authSession.updateMany({ where: { userId: user.id }, data });

    const response = await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(errorOf(response).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token whose session is past its absolute expiry', async () => {
    const { user, token } = await createTestAccount(prisma, '+2348030000007');
    const past = new Date(Date.now() - 1000);
    await prisma.authSession.updateMany({
      where: { userId: user.id },
      data: { refreshExpiresAt: past, absoluteExpiresAt: past },
    });

    await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('accepts a token whose session is only past its idle refresh expiry', async () => {
    const { user, token } = await createTestAccount(prisma, '+2348030000008');
    await prisma.authSession.updateMany({
      where: { userId: user.id },
      data: { refreshExpiresAt: new Date(Date.now() - 1000) },
    });

    await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a token that names a session of another user', async () => {
    const victim = await createTestAccount(prisma, '+2348030000009');
    const attacker = await createTestAccount(prisma, '+2348030000010');
    const victimSession = await prisma.authSession.findFirstOrThrow({
      where: { userId: victim.user.id },
    });

    await request(app)
      .get('/api/v1/test-protected/any')
      .set(
        'Authorization',
        `Bearer ${await tokenFor(attacker.user.id, undefined, victimSession.id)}`,
      )
      .expect(401);
  });

  it('rejects a signed token whose session does not exist', async () => {
    const { user } = await createTestAccount(prisma, '+2348030000011');

    await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${await tokenFor(user.id)}`)
      .expect(401);
  });

  it('rejects the token of a deleted user', async () => {
    const { user, token } = await createTestAccount(prisma, '+2348030000005');
    await prisma.user.delete({ where: { id: user.id } });

    await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
