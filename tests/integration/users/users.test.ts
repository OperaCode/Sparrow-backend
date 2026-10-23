import request, { type Response } from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '#src/lib/logger.js';
import { createPricingModules } from '#src/modules/pricing/pricing.module.js';
import { createUsersModules } from '#src/modules/users/users.module.js';
import { createUsersRepository } from '#src/modules/users/users.repository.js';
import { createUsersService } from '#src/modules/users/users.service.js';
import { buildTestApp, testConfig, tokenFor } from '../../helpers/app.js';
import { createTestPrisma, truncateAllTables } from '../../helpers/database.js';
import { errorOf } from '../../helpers/http.js';
import { createAccountFactory } from '../../helpers/user.factory.js';

const prisma = createTestPrisma();
const config = testConfig({ RATE_LIMIT_MAX: '1000' });
const logger = createLogger({ level: 'silent', nodeEnv: 'test' });
const service = createUsersService({
  repository: createUsersRepository(prisma),
  logger,
});
const { app } = buildTestApp({
  config,
  authSubjects: createUsersRepository(prisma),
  v1Modules: [
    ...createUsersModules({ prisma, logger }),
    ...createPricingModules({ prisma, logger }),
  ],
});

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const accounts = createAccountFactory(prisma, config);

interface ProfileBody {
  id: string;
  phone: string;
  name: string | null;
  community: string | null;
  accountType: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function dataOf(response: Response): ProfileBody {
  return (response.body as { data: ProfileBody }).data;
}

describe('verified customers', () => {
  it('persists one customer and restores that profile from the token', async () => {
    const phone = accounts.phone();
    const created = await service.openVerifiedCustomer(phone);
    const again = await service.openVerifiedCustomer(phone);

    expect(again.id).toBe(created.id);
    expect(created).toMatchObject({
      phone,
      role: 'customer',
      status: 'active',
      accountType: 'standard',
      name: null,
      community: null,
    });
    expect(await prisma.user.count()).toBe(1);

    const token = await tokenFor(created.id, config);
    const response = await request(app)
      .get('/api/v1/me')
      .query({ userId: '00000000-0000-4000-8000-000000000000' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = dataOf(response);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(body).toMatchObject({
      id: created.id,
      phone,
      role: 'customer',
      name: null,
    });
    expect(body.createdAt).toBe(stored.createdAt.toISOString());
    expect(Object.keys(body).sort()).toEqual([
      'accountType',
      'community',
      'createdAt',
      'id',
      'name',
      'phone',
      'role',
      'status',
      'updatedAt',
    ]);
  });

  it('stores one row when the first verification races', async () => {
    const phone = accounts.phone();
    const [first, second] = await Promise.all([
      service.openVerifiedCustomer(phone),
      service.openVerifiedCustomer(phone),
    ]);

    expect(first.id).toBe(second.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it.each(['suspended', 'deactivated'] as const)(
    'does not reopen a %s account',
    async (status) => {
      const phone = accounts.phone();
      const { user } = await accounts.account({ phone });
      await prisma.user.update({ where: { id: user.id }, data: { status } });

      await expect(service.openVerifiedCustomer(phone)).rejects.toMatchObject({
        statusCode: 403,
        code:
          status === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
      });
      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored.status).toBe(status);
      expect(await prisma.user.count()).toBe(1);
    },
  );

  it('does not demote an existing admin on a later verification', async () => {
    const phone = accounts.phone();
    const admin = await accounts.account({ phone, role: 'admin' });

    const restored = await service.openVerifiedCustomer(phone);

    expect(restored).toMatchObject({ id: admin.user.id, role: 'admin' });
  });
});

describe('profile restoration', () => {
  it('saves name, community, and account type for the token user', async () => {
    const created = await service.openVerifiedCustomer(accounts.phone());
    const token = await tokenFor(created.id, config);

    const updated = await request(app)
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ada', community: 'igbesa', accountType: 'business' })
      .expect(200);

    expect(dataOf(updated)).toMatchObject({
      id: created.id,
      name: 'Ada',
      community: 'igbesa',
      accountType: 'business',
      role: 'customer',
    });

    const restored = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(dataOf(restored)).toMatchObject({
      id: created.id,
      name: 'Ada',
      community: 'igbesa',
      accountType: 'business',
    });

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored).toMatchObject({
      name: 'Ada',
      community: 'igbesa',
      accountType: 'business',
      role: 'customer',
    });
  });

  it('rejects a client role and leaves the stored profile unchanged', async () => {
    const phone = accounts.phone();
    const created = await service.openVerifiedCustomer(phone);
    const token = await tokenFor(created.id, config);

    const response = await request(app)
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Ada',
        role: 'admin',
        status: 'active',
        phone: '+2348000000000',
      })
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored).toMatchObject({
      role: 'customer',
      name: null,
      phone,
      status: 'active',
    });
  });

  it('returns 401 for a profile read without a token', async () => {
    const response = await request(app).get('/api/v1/me').expect(401);
    expect(errorOf(response).code).toBe('UNAUTHENTICATED');
  });
});

describe('operations permissions', () => {
  it('returns 401 for operations routes without a token', async () => {
    const users = await request(app)
      .post('/api/v1/users')
      .send({ phone: accounts.phone(), role: 'admin' })
      .expect(401);
    const rules = await request(app)
      .patch('/api/v1/pricing/rules/standard_zone/A')
      .send({ quoteMode: 'manual' })
      .expect(401);

    expect(errorOf(users).code).toBe('UNAUTHENTICATED');
    expect(errorOf(rules).code).toBe('UNAUTHENTICATED');
    expect(await prisma.user.count()).toBe(0);
  });

  it('returns 403 when a customer calls an operations route', async () => {
    const customer = await accounts.account();
    const auth = { Authorization: `Bearer ${customer.token}` };

    const users = await request(app)
      .post('/api/v1/users')
      .set(auth)
      .send({ phone: accounts.phone(), role: 'admin' })
      .expect(403);
    const status = await request(app)
      .patch(`/api/v1/users/${customer.user.id}/status`)
      .set(auth)
      .send({ status: 'active' })
      .expect(403);
    const role = await request(app)
      .patch(`/api/v1/users/${customer.user.id}/role`)
      .set(auth)
      .send({ role: 'admin' })
      .expect(403);
    const rules = await request(app)
      .patch('/api/v1/pricing/rules/standard_zone/A')
      .set(auth)
      .send({ quoteMode: 'manual' })
      .expect(403);

    expect(errorOf(users).code).toBe('FORBIDDEN');
    expect(errorOf(status).code).toBe('FORBIDDEN');
    expect(errorOf(role).code).toBe('FORBIDDEN');
    expect(errorOf(rules).code).toBe('FORBIDDEN');
    expect(await prisma.user.count()).toBe(1);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: customer.user.id },
    });
    expect(stored).toMatchObject({ role: 'customer', status: 'active' });
  });

  it('does not list accounts', async () => {
    const admin = await accounts.account({ role: 'admin' });

    await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });

  it('provisions an admin without issuing a token', async () => {
    const admin = await accounts.account({ role: 'admin' });
    const phone = accounts.phone();

    const response = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        phone,
        role: 'admin',
        name: 'Ops',
        community: 'ketu',
      })
      .expect(201);

    const body = dataOf(response);
    expect(body).toMatchObject({
      phone,
      role: 'admin',
      name: 'Ops',
      community: 'ketu',
      accountType: 'standard',
      status: 'active',
    });
    expect(body).not.toHaveProperty('token');

    const token = await tokenFor(body.id, config);
    await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: accounts.phone(), role: 'customer' })
      .expect(201);
  });

  it('does not turn an existing phone into an admin', async () => {
    const admin = await accounts.account({ role: 'admin' });
    const customer = await accounts.account();

    const response = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ phone: customer.user.phone, role: 'admin' })
      .expect(409);

    expect(errorOf(response).code).toBe('CONFLICT');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: customer.user.id },
    });
    expect(stored.role).toBe('customer');
  });

  it('rejects a rider login and a phone that is not E.164', async () => {
    const admin = await accounts.account({ role: 'admin' });
    const riderPhone = accounts.phone();
    const auth = { Authorization: `Bearer ${admin.token}` };

    const rider = await request(app)
      .post('/api/v1/users')
      .set(auth)
      .send({ phone: riderPhone, role: 'rider' })
      .expect(400);
    const phone = await request(app)
      .post('/api/v1/users')
      .set(auth)
      .send({ phone: '08012345678', role: 'customer' })
      .expect(400);

    expect(errorOf(rider).code).toBe('VALIDATION_ERROR');
    expect(errorOf(phone).code).toBe('VALIDATION_ERROR');
    expect(
      await prisma.user.findUnique({ where: { phone: riderPhone } }),
    ).toBeNull();
  });

  it('applies a role change to an already-issued token', async () => {
    const admin = await accounts.account({ role: 'admin' });
    const customer = await accounts.account();
    const deniedPhone = accounts.phone();

    await request(app)
      .patch(`/api/v1/users/${customer.user.id}/role`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ role: 'admin' })
      .expect(200);

    await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ phone: accounts.phone(), role: 'customer' })
      .expect(201);

    await request(app)
      .patch(`/api/v1/users/${customer.user.id}/role`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ role: 'customer' })
      .expect(200);

    const denied = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ phone: deniedPhone, role: 'customer' })
      .expect(403);

    expect(errorOf(denied).code).toBe('FORBIDDEN');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: customer.user.id },
    });
    expect(stored.role).toBe('customer');
    expect(
      await prisma.user.findUnique({ where: { phone: deniedPhone } }),
    ).toBeNull();
  });

  it('refuses an admin changing their own role or status', async () => {
    const admin = await accounts.account({ role: 'admin' });
    const auth = { Authorization: `Bearer ${admin.token}` };

    const role = await request(app)
      .patch(`/api/v1/users/${admin.user.id}/role`)
      .set(auth)
      .send({ role: 'customer' })
      .expect(403);
    const status = await request(app)
      .patch(`/api/v1/users/${admin.user.id}/status`)
      .set(auth)
      .send({ status: 'deactivated' })
      .expect(403);

    expect(errorOf(role).code).toBe('FORBIDDEN');
    expect(errorOf(status).code).toBe('FORBIDDEN');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: admin.user.id },
    });
    expect(stored).toMatchObject({ role: 'admin', status: 'active' });
  });

  it.each(['suspended', 'deactivated'] as const)(
    'does not provision while the admin is %s',
    async (status) => {
      const admin = await accounts.account({ role: 'admin' });
      await prisma.user.update({
        where: { id: admin.user.id },
        data: { status },
      });

      const response = await request(app)
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ phone: accounts.phone(), role: 'customer' })
        .expect(403);

      expect(errorOf(response).code).toBe(
        status === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
      );
      expect(await prisma.user.count()).toBe(1);
    },
  );
});

describe('deactivation', () => {
  it('blocks the same token after the customer deactivates', async () => {
    const customer = await accounts.account();

    const response = await request(app)
      .post('/api/v1/me/deactivation')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({})
      .expect(200);
    expect(dataOf(response).status).toBe('deactivated');

    const again = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);
    expect(errorOf(again).code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('rejects a deactivation body that names an account', async () => {
    const customer = await accounts.account();

    const response = await request(app)
      .post('/api/v1/me/deactivation')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ userId: customer.user.id, status: 'active' })
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: customer.user.id },
    });
    expect(stored.status).toBe('active');
  });

  it('refuses to let an admin deactivate their own login', async () => {
    const admin = await accounts.account({ role: 'admin' });

    const response = await request(app)
      .post('/api/v1/me/deactivation')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(403);

    expect(errorOf(response).code).toBe('FORBIDDEN');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: admin.user.id },
    });
    expect(stored.status).toBe('active');
  });

  it('lets another admin deactivate and restore an account', async () => {
    const ops = await accounts.account({ role: 'admin' });
    const customer = await accounts.account();

    await request(app)
      .patch(`/api/v1/users/${customer.user.id}/status`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({ status: 'deactivated' })
      .expect(200);

    const blocked = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);
    expect(errorOf(blocked).code).toBe('ACCOUNT_DEACTIVATED');

    await request(app)
      .patch(`/api/v1/users/${customer.user.id}/status`)
      .set('Authorization', `Bearer ${ops.token}`)
      .send({ status: 'active' })
      .expect(200);

    await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
  });
});
