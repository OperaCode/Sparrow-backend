import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUsersRepository } from '../../../src/modules/users/users.repository.js';
import { createTestAccount } from '../../helpers/account.js';
import { buildTestApp, protectedTestModule } from '../../helpers/app.js';
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

  it('rejects the token of a deleted user', async () => {
    const { user, token } = await createTestAccount(prisma, '+2348030000005');
    await prisma.user.delete({ where: { id: user.id } });

    await request(app)
      .get('/api/v1/test-protected/any')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
