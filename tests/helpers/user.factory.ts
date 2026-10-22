import type { Config } from '../../src/config/env.js';
import type { PrismaClient } from '../../src/lib/prisma.js';
import type { UsersService } from '../../src/modules/users/users.service.js';
import type { UserProfile } from '../../src/modules/users/users.types.js';
import type { Role } from '../../src/types/auth.js';
import { createTestAccount } from './account.js';

const PROFILE: UserProfile = {
  id: '3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11',
  phone: '+2348012345678',
  name: 'Ada',
  community: 'igbesa',
  accountType: 'standard',
  role: 'customer',
  status: 'active',
  createdAt: new Date('2026-10-22T12:00:00.000Z'),
  updatedAt: new Date('2026-10-22T12:00:00.000Z'),
};

/** Another account id for routes that must not target the signed-in user. */
export const OTHER_USER_ID = '8a1c0e2b-4d5f-4a67-8b90-1c2d3e4f5a6b';

export function userProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return { ...PROFILE, ...overrides };
}

function unused(): never {
  throw new Error('unexpected service call');
}

/** A users service whose methods fail if a controller calls them. */
export function usersService(
  overrides: Partial<UsersService> = {},
): UsersService {
  return {
    openVerifiedCustomer: unused,
    getProfile: unused,
    updateOwnProfile: unused,
    deactivateOwnAccount: unused,
    provisionAccount: unused,
    setAccountStatus: unused,
    setAccountRole: unused,
    ...overrides,
  };
}

type ServiceMethod = keyof UsersService;

/**
 * A users service that records every call to one method and returns what
 * `respond` produces. Any other method fails the test.
 */
export function recordingUsersService<K extends ServiceMethod>(
  method: K,
  respond: (
    ...args: Parameters<UsersService[K]>
  ) =>
    | Awaited<ReturnType<UsersService[K]>>
    | Promise<Awaited<ReturnType<UsersService[K]>>>,
): { service: UsersService; calls: Parameters<UsersService[K]>[] } {
  const calls: Parameters<UsersService[K]>[] = [];
  const recorded = ((...args: Parameters<UsersService[K]>) => {
    calls.push(args);
    return Promise.resolve(respond(...args));
  }) as UsersService[K];

  return {
    service: usersService({ [method]: recorded }),
    calls,
  };
}

/**
 * Signed-in rows and unused E.164 phones. Each phone is unique for this
 * factory, including across truncated tables.
 */
export function createAccountFactory(prisma: PrismaClient, config: Config) {
  let sequence = 0;

  function phone(): string {
    sequence += 1;
    return `+234805${String(sequence).padStart(7, '0')}`;
  }

  function account(options: { phone?: string; role?: Role } = {}) {
    return createTestAccount(
      prisma,
      options.phone ?? phone(),
      options.role ?? 'customer',
      config,
    );
  }

  return { phone, account };
}
