import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUsersRepository } from '#src/modules/users/users.repository.js';
import { createTestPrisma, truncateAllTables } from '../../helpers/database.js';

const prisma = createTestPrisma();
const repository = createUsersRepository(prisma);

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const PHONE = '+2348031234567';
const CONCURRENT_SIGN_INS = 10;

describe('upsertCustomerByPhone', () => {
  it('creates a customer for a new phone and reports it as created', async () => {
    const user = await repository.upsertCustomerByPhone(PHONE);

    expect(user).toEqual({
      id: expect.any(String) as string,
      phone: PHONE,
      role: 'customer',
      status: 'active',
      created: true,
    });
    await expect(prisma.user.count()).resolves.toBe(1);
  });

  it('returns an existing user unchanged and reports it as not created', async () => {
    const existing = await prisma.user.create({
      data: { phone: PHONE, role: 'rider', status: 'suspended' },
    });

    const user = await repository.upsertCustomerByPhone(PHONE);

    expect(user).toEqual({
      id: existing.id,
      phone: PHONE,
      role: 'rider',
      status: 'suspended',
      created: false,
    });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(after.updatedAt).toEqual(existing.updatedAt);
  });

  it('creates exactly one user for concurrent sign-ins with the same phone', async () => {
    const users = await Promise.all(
      Array.from({ length: CONCURRENT_SIGN_INS }, () =>
        repository.upsertCustomerByPhone(PHONE),
      ),
    );

    await expect(prisma.user.count()).resolves.toBe(1);
    expect(users.filter((user) => user.created)).toHaveLength(1);
    expect(new Set(users.map((user) => user.id)).size).toBe(1);
  });
});
