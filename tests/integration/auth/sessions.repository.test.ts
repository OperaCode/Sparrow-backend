import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateRefreshSecret } from '../../../src/modules/auth/refresh-token.js';
import {
  createSessionsRepository,
  type CreateSessionInput,
} from '../../../src/modules/auth/sessions.repository.js';
import { createTestPrisma, truncateAllTables } from '../../helpers/database.js';

const prisma = createTestPrisma();
const repository = createSessionsRepository(prisma);

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;
const REFRESH_TTL_SECONDS = 30 * DAY_SECONDS;
const MAX_AGE_SECONDS = 90 * DAY_SECONDS;
const UNKNOWN_SESSION_ID = '3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11';

async function databaseNow(): Promise<number> {
  const rows = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  return rows[0]?.now.getTime() ?? Number.NaN;
}

/** Expiries are computed in SQL, so compare within a small window. */
function expectAbout(actual: Date, expectedMs: number): void {
  expect(Math.abs(actual.getTime() - expectedMs)).toBeLessThan(5_000);
}

async function createUser(): Promise<string> {
  const user = await prisma.user.create({ data: { phone: '+2348012345678' } });
  return user.id;
}

async function openSession(overrides: Partial<CreateSessionInput> = {}) {
  const userId = overrides.userId ?? (await createUser());
  const refresh = generateRefreshSecret();
  const session = await repository.create({
    userId,
    firebaseUid: 'firebase-uid-1',
    firebaseAuthTime: new Date('2026-10-16T12:00:00.000Z'),
    refreshTokenHash: refresh.hash,
    refreshTtlSeconds: REFRESH_TTL_SECONDS,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ...overrides,
  });
  if (session === null) throw new Error('Expected a new session');
  return { session, userId, hash: refresh.hash };
}

function storedSession(id: string) {
  return prisma.authSession.findUniqueOrThrow({ where: { id } });
}

async function setExpiries(
  id: string,
  refreshFromNowMs: number,
  absoluteFromNowMs: number,
): Promise<void> {
  const now = await databaseNow();
  await prisma.authSession.update({
    where: { id },
    data: {
      refreshExpiresAt: new Date(now + refreshFromNowMs),
      absoluteExpiresAt: new Date(now + absoluteFromNowMs),
    },
  });
}

describe('sessions repository: create', () => {
  it('stores the hash and sets idle and absolute expiry from now', async () => {
    const before = await databaseNow();
    const { session, userId, hash } = await openSession();

    const stored = await storedSession(session.id);
    expect(session.userId).toBe(userId);
    expect(stored.refreshTokenHash).toEqual(hash);
    expectAbout(session.refreshExpiresAt, before + REFRESH_TTL_SECONDS * 1000);
    expectAbout(session.absoluteExpiresAt, before + MAX_AGE_SECONDS * 1000);
    expect(stored.refreshExpiresAt).toEqual(session.refreshExpiresAt);
    expect(stored.absoluteExpiresAt).toEqual(session.absoluteExpiresAt);
  });

  it('caps the refresh expiry at the absolute expiry', async () => {
    const { session } = await openSession({
      refreshTtlSeconds: 10 * DAY_SECONDS,
      maxAgeSeconds: DAY_SECONDS,
    });

    expect(session.refreshExpiresAt).toEqual(session.absoluteExpiresAt);
  });

  it('opens at most one session per Firebase sign-in', async () => {
    const { userId } = await openSession();

    const second = await repository.create({
      userId,
      firebaseUid: 'firebase-uid-1',
      firebaseAuthTime: new Date('2026-10-16T12:00:00.000Z'),
      refreshTokenHash: generateRefreshSecret().hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
      maxAgeSeconds: MAX_AGE_SECONDS,
    });

    expect(second).toBeNull();
    await expect(prisma.authSession.count()).resolves.toBe(1);
  });
});

describe('sessions repository: rotate', () => {
  it('swaps the hash, slides the idle expiry and records the refresh', async () => {
    const { session, userId, hash } = await openSession();
    await setExpiries(session.id, DAY_MS, 60 * DAY_MS);
    const next = generateRefreshSecret();
    const before = await databaseNow();

    const result = await repository.rotate({
      sessionId: session.id,
      presentedHash: hash,
      nextHash: next.hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    });

    expect(result).toMatchObject({
      status: 'rotated',
      session: { id: session.id, userId },
    });
    const stored = await storedSession(session.id);
    expect(stored.refreshTokenHash).toEqual(next.hash);
    expect(stored.lastRefreshedAt).not.toBeNull();
    expectAbout(stored.refreshExpiresAt, before + REFRESH_TTL_SECONDS * 1000);
  });

  it('keeps the refresh expiry at the absolute cap near the end of a session', async () => {
    const { session, hash } = await openSession();
    await setExpiries(session.id, DAY_MS, DAY_MS);

    const result = await repository.rotate({
      sessionId: session.id,
      presentedHash: hash,
      nextHash: generateRefreshSecret().hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    });

    expect(result.status).toBe('rotated');
    const stored = await storedSession(session.id);
    expect(stored.refreshExpiresAt).toEqual(stored.absoluteExpiresAt);
  });

  it('revokes the session when a superseded token is replayed', async () => {
    const { session, userId, hash } = await openSession();
    const next = generateRefreshSecret();
    await repository.rotate({
      sessionId: session.id,
      presentedHash: hash,
      nextHash: next.hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    });

    const replay = await repository.rotate({
      sessionId: session.id,
      presentedHash: hash,
      nextHash: generateRefreshSecret().hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    });

    expect(replay).toEqual({ status: 'reused', userId });
    const stored = await storedSession(session.id);
    expect(stored.revokedReason).toBe('refresh_reuse');
    expect(stored.revokedAt).not.toBeNull();

    const current = await repository.rotate({
      sessionId: session.id,
      presentedHash: next.hash,
      nextHash: generateRefreshSecret().hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    });
    expect(current).toEqual({ status: 'invalid' });
  });

  it('lets exactly one of two concurrent rotations win', async () => {
    const { session, hash } = await openSession();
    const attempt = () =>
      repository.rotate({
        sessionId: session.id,
        presentedHash: hash,
        nextHash: generateRefreshSecret().hash,
        refreshTtlSeconds: REFRESH_TTL_SECONDS,
      });

    const results = await Promise.all([attempt(), attempt()]);

    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual(['reused', 'rotated']);
    const stored = await storedSession(session.id);
    expect(stored.revokedReason).toBe('refresh_reuse');
  });

  it.each<[string, number, number]>([
    ['past its idle expiry', -1_000, 60 * DAY_MS],
    ['past its absolute expiry', -2_000, -1_000],
  ])(
    'rejects a session %s without revoking it',
    async (_label, refreshMs, absoluteMs) => {
      const { session, hash } = await openSession();
      await setExpiries(session.id, refreshMs, absoluteMs);

      const result = await repository.rotate({
        sessionId: session.id,
        presentedHash: hash,
        nextHash: generateRefreshSecret().hash,
        refreshTtlSeconds: REFRESH_TTL_SECONDS,
      });

      expect(result).toEqual({ status: 'invalid' });
      const stored = await storedSession(session.id);
      expect(stored.refreshTokenHash).toEqual(hash);
      expect(stored.revokedAt).toBeNull();
    },
  );

  it('rejects a revoked session', async () => {
    const { session, hash } = await openSession();
    await repository.revokeForLogout(session.id, hash);

    const result = await repository.rotate({
      sessionId: session.id,
      presentedHash: hash,
      nextHash: generateRefreshSecret().hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    });

    expect(result).toEqual({ status: 'invalid' });
    const stored = await storedSession(session.id);
    expect(stored.revokedReason).toBe('logout');
  });

  it('rejects an unknown session id', async () => {
    const result = await repository.rotate({
      sessionId: UNKNOWN_SESSION_ID,
      presentedHash: generateRefreshSecret().hash,
      nextHash: generateRefreshSecret().hash,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    });

    expect(result).toEqual({ status: 'invalid' });
  });
});

describe('sessions repository: logout', () => {
  it('revokes the session that owns the token', async () => {
    const { session, hash } = await openSession();

    await expect(repository.revokeForLogout(session.id, hash)).resolves.toBe(
      true,
    );

    const stored = await storedSession(session.id);
    expect(stored.revokedReason).toBe('logout');
    expect(stored.revokedAt).not.toBeNull();
  });

  it('leaves the session alone when the hash does not match', async () => {
    const { session } = await openSession();

    await expect(
      repository.revokeForLogout(session.id, generateRefreshSecret().hash),
    ).resolves.toBe(false);

    const stored = await storedSession(session.id);
    expect(stored.revokedAt).toBeNull();
  });

  it('reports false for an already revoked session and keeps the first reason', async () => {
    const { session, hash } = await openSession();
    await repository.revokeForLogout(session.id, hash);
    const first = await storedSession(session.id);

    await expect(repository.revokeForLogout(session.id, hash)).resolves.toBe(
      false,
    );

    const stored = await storedSession(session.id);
    expect(stored.revokedAt).toEqual(first.revokedAt);
  });

  it('reports false for an unknown session id', async () => {
    await expect(
      repository.revokeForLogout(
        UNKNOWN_SESSION_ID,
        generateRefreshSecret().hash,
      ),
    ).resolves.toBe(false);
  });
});
