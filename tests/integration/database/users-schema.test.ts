import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPrisma, truncateAllTables } from '../../helpers/database.js';

const prisma = createTestPrisma();

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('users table', () => {
  it('applies database defaults for id, role, status and timestamps', async () => {
    const user = await prisma.user.create({
      data: { phone: '+2348012345678' },
    });

    expect(user.id).toMatch(UUID);
    expect(user.role).toBe('customer');
    expect(user.status).toBe('active');
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('applies defaults to rows inserted without Prisma', async () => {
    await prisma.$executeRaw`INSERT INTO users (phone) VALUES ('+2348011111111')`;

    const user = await prisma.user.findUniqueOrThrow({
      where: { phone: '+2348011111111' },
    });
    expect(user).toMatchObject({ role: 'customer', status: 'active' });
  });

  it('enforces unique phone numbers', async () => {
    await prisma.user.create({ data: { phone: '+2348012345678' } });

    await expect(
      prisma.user.create({ data: { phone: '+2348012345678' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it.each([
    '08012345678',
    '2348012345678',
    '+0123456789',
    '+234 8012345678',
    '+12',
  ])('rejects non-E.164 phone %s', async (phone) => {
    await expect(prisma.user.create({ data: { phone } })).rejects.toThrow(
      /users_phone_e164_check/,
    );
  });

  it('accepts every role and status value', async () => {
    const rider = await prisma.user.create({
      data: { phone: '+2348020000001', role: 'rider', status: 'suspended' },
    });
    const admin = await prisma.user.create({
      data: { phone: '+2348020000002', role: 'admin' },
    });

    expect(rider).toMatchObject({ role: 'rider', status: 'suspended' });
    expect(admin.role).toBe('admin');
  });

  it('bumps updatedAt on update', async () => {
    const user = await prisma.user.create({
      data: { phone: '+2348012345678' },
    });
    // Timestamps have millisecond precision; avoid a same-millisecond update.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { status: 'suspended' },
    });

    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      user.updatedAt.getTime(),
    );
  });
});
