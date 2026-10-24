import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '#src/lib/prisma.js';
import { createUsersRepository } from '#src/modules/users/users.repository.js';

const PHONE = '+2348031234567';
const ROW = {
  id: '6f1c2c1e-6a43-4f4e-9d5a-0d6f3a1b2c3d',
  phone: PHONE,
  role: 'customer',
  status: 'active',
};

/**
 * A real database cannot reliably produce a conflicting row that vanishes
 * before the follow-up SELECT, so the query results are scripted instead.
 */
function repositoryWithResults(...results: unknown[][]) {
  const queryRaw = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
  for (const result of results) queryRaw.mockResolvedValueOnce(result);
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
  return { repository: createUsersRepository(prisma), queryRaw };
}

describe('upsertCustomerByPhone retry', () => {
  it('retries once when the conflicting row is gone before the SELECT', async () => {
    const { repository, queryRaw } = repositoryWithResults([], [], [], [ROW]);

    await expect(repository.upsertCustomerByPhone(PHONE)).resolves.toEqual({
      ...ROW,
      created: false,
    });
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });

  it('reports a user created by the retried insert as new', async () => {
    const { repository, queryRaw } = repositoryWithResults([], [], [ROW]);

    await expect(repository.upsertCustomerByPhone(PHONE)).resolves.toEqual({
      ...ROW,
      created: true,
    });
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it('fails after the retry also finds no row', async () => {
    const { repository, queryRaw } = repositoryWithResults([], [], [], []);

    await expect(repository.upsertCustomerByPhone(PHONE)).rejects.toThrow(
      'User sign-in found no row after retry',
    );
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });
});
