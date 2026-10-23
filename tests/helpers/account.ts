import { randomUUID } from 'node:crypto';
import type { Config } from '#src/config/env.js';
import type { PrismaClient } from '#src/lib/prisma.js';
import { createSessionTokens } from '#src/modules/auth/session-tokens.js';
import { createSessionsRepository } from '#src/modules/auth/sessions.repository.js';
import type { Role } from '#src/types/auth.js';
import { testConfig } from './app.js';

/**
 * A signed-in user for integration tests, with a real session row. Role and
 * status are whatever the user row says on each request.
 */
export async function createTestAccount(
  prisma: PrismaClient,
  phone: string,
  role: Role = 'customer',
  config: Config = testConfig(),
) {
  const user = await prisma.user.create({ data: { phone, role } });
  const tokens = await createSessionTokens({
    config,
    sessions: createSessionsRepository(prisma),
  }).open({
    userId: user.id,
    firebaseUid: `test:${user.id}`,
    firebaseAuthTime: new Date(),
  });
  if (tokens === null) throw new Error('Expected a new session');
  return { user, token: tokens.accessToken, tokens };
}

/** An access token whose session belongs to a user that already exists. */
export async function accessTokenFor(
  prisma: PrismaClient,
  userId: string,
  config: Config = testConfig(),
): Promise<string> {
  const tokens = await createSessionTokens({
    config,
    sessions: createSessionsRepository(prisma),
  }).open({
    userId,
    firebaseUid: `test:${userId}:${randomUUID()}`,
    firebaseAuthTime: new Date(),
  });
  if (tokens === null) throw new Error('Expected a new session');
  return tokens.accessToken;
}
