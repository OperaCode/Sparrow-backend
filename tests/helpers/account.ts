import type { Config } from '#src/config/env.js';
import type { PrismaClient } from '#src/lib/prisma.js';
import type { Role } from '#src/types/auth.js';
import { tokenFor } from './app.js';

/**
 * A signed-in user for integration tests. The token is issued for this
 * database row, so role and status are whatever the row says on the request.
 */
export async function createTestAccount(
  prisma: PrismaClient,
  phone: string,
  role: Role = 'customer',
  config?: Config,
) {
  const user = await prisma.user.create({ data: { phone, role } });
  const token =
    config === undefined
      ? await tokenFor(user.id)
      : await tokenFor(user.id, config);
  return { user, token };
}
