import { randomBytes } from 'node:crypto';
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
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA256_BYTES = 32;

function hash(length = SHA256_BYTES): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(length));
}

async function createUser(phone = '+2348012345678'): Promise<string> {
  const user = await prisma.user.create({ data: { phone } });
  return user.id;
}

function sessionData(userId: string) {
  const now = Date.now();
  return {
    userId,
    firebaseUid: 'firebase-uid-1',
    firebaseAuthTime: new Date(now),
    refreshTokenHash: hash(),
    refreshExpiresAt: new Date(now + 30 * DAY_MS),
    absoluteExpiresAt: new Date(now + 90 * DAY_MS),
  };
}

describe('auth_sessions table', () => {
  it('applies database defaults and leaves lifecycle fields empty', async () => {
    const userId = await createUser();

    const session = await prisma.authSession.create({
      data: sessionData(userId),
    });

    expect(session.id).toMatch(UUID);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session).toMatchObject({
      lastRefreshedAt: null,
      revokedAt: null,
      revokedReason: null,
    });
  });

  it('allows one session per Firebase sign-in', async () => {
    const userId = await createUser();
    const data = sessionData(userId);
    await prisma.authSession.create({ data });

    await expect(
      prisma.authSession.create({
        data: { ...data, refreshTokenHash: hash() },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows a new session for a later sign-in by the same Firebase user', async () => {
    const userId = await createUser();
    const first = sessionData(userId);
    await prisma.authSession.create({ data: first });

    await prisma.authSession.create({
      data: {
        ...first,
        firebaseAuthTime: new Date(first.firebaseAuthTime.getTime() + 1000),
        refreshTokenHash: hash(),
      },
    });

    await expect(prisma.authSession.count()).resolves.toBe(2);
  });

  it.each([0, 31, 33, 64])(
    'rejects a refresh token hash of %i bytes',
    async (length) => {
      const userId = await createUser();

      await expect(
        prisma.authSession.create({
          data: { ...sessionData(userId), refreshTokenHash: hash(length) },
        }),
      ).rejects.toThrow(/auth_sessions_refresh_token_hash_length_check/);
    },
  );

  it.each([
    ['a revocation time without a reason', { revokedAt: new Date() }],
    ['a revocation reason without a time', { revokedReason: 'logout' }],
  ] as const)('rejects %s', async (_label, revocation) => {
    const userId = await createUser();

    await expect(
      prisma.authSession.create({
        data: { ...sessionData(userId), ...revocation },
      }),
    ).rejects.toThrow(/auth_sessions_revocation_check/);
  });

  it.each(['logout', 'refresh_reuse'] as const)(
    'accepts a revocation with reason %s',
    async (revokedReason) => {
      const userId = await createUser();

      const session = await prisma.authSession.create({
        data: { ...sessionData(userId), revokedAt: new Date(), revokedReason },
      });

      expect(session.revokedReason).toBe(revokedReason);
    },
  );

  it('rejects a refresh expiry after the absolute expiry', async () => {
    const userId = await createUser();
    const data = sessionData(userId);

    await expect(
      prisma.authSession.create({
        data: {
          ...data,
          refreshExpiresAt: new Date(data.absoluteExpiresAt.getTime() + 1),
        },
      }),
    ).rejects.toThrow(/auth_sessions_expiry_order_check/);
  });

  it('accepts a refresh expiry equal to the absolute expiry', async () => {
    const userId = await createUser();
    const data = sessionData(userId);

    const session = await prisma.authSession.create({
      data: { ...data, refreshExpiresAt: data.absoluteExpiresAt },
    });

    expect(session.refreshExpiresAt).toEqual(session.absoluteExpiresAt);
  });

  it('rejects an empty Firebase uid', async () => {
    const userId = await createUser();

    await expect(
      prisma.authSession.create({
        data: { ...sessionData(userId), firebaseUid: '' },
      }),
    ).rejects.toThrow(/auth_sessions_firebase_uid_check/);
  });

  it('rejects a session for an unknown user', async () => {
    await expect(
      prisma.authSession.create({
        data: sessionData('00000000-0000-4000-8000-000000000000'),
      }),
    ).rejects.toThrow();
    await expect(prisma.authSession.count()).resolves.toBe(0);
  });

  it("deletes a user's sessions when the user is deleted", async () => {
    const userId = await createUser();
    const otherUserId = await createUser('+2348012345679');
    await prisma.authSession.create({ data: sessionData(userId) });
    await prisma.authSession.create({
      data: { ...sessionData(otherUserId), firebaseUid: 'firebase-uid-2' },
    });

    await prisma.user.delete({ where: { id: userId } });

    const remaining = await prisma.authSession.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.userId).toBe(otherUserId);
  });
});
