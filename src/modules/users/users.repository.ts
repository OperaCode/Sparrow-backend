import type { PrismaClient } from '../../lib/prisma.js';
import type { AccountStatus, Role } from '../../types/auth.js';

export interface AuthSubject {
  id: string;
  role: Role;
  status: AccountStatus;
}

export interface UsersRepository {
  findAuthSubject(
    userId: string,
    sessionId: string,
  ): Promise<AuthSubject | null>;
}

export function createUsersRepository(prisma: PrismaClient): UsersRepository {
  return {
    /**
     * One primary-key lookup on the session, joined to its user. A revoked or
     * fully expired session makes every access token issued for it invalid.
     * The idle refresh expiry is deliberately not checked: it governs refresh,
     * and access tokens are short-lived.
     */
    async findAuthSubject(userId, sessionId) {
      const rows = await prisma.$queryRaw<AuthSubject[]>`
        SELECT u."id", u."role"::text AS "role", u."status"::text AS "status"
        FROM "auth_sessions" s
        JOIN "users" u ON u."id" = s."user_id"
        WHERE s."id" = CAST(${sessionId} AS uuid)
          AND s."user_id" = CAST(${userId} AS uuid)
          AND s."revoked_at" IS NULL
          AND s."absolute_expires_at" > now()
      `;
      return rows[0] ?? null;
    },
  };
}
