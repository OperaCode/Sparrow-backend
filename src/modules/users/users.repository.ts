import type { PrismaClient } from '../../lib/prisma.js';
import type { AccountStatus, Role } from '../../types/auth.js';

export interface AuthSubject {
  id: string;
  role: Role;
  status: AccountStatus;
}

export interface SignedInUser extends AuthSubject {
  phone: string;
  created: boolean;
}

export interface UsersRepository {
  findAuthSubject(
    userId: string,
    sessionId: string,
  ): Promise<AuthSubject | null>;
  upsertCustomerByPhone(phone: string): Promise<SignedInUser>;
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

    /**
     * Race-safe sign-up or sign-in in one statement. A new user is always a
     * customer; an existing user keeps their role and status. xmax is 0 only
     * for a freshly inserted row, which tells the two cases apart without a
     * second query.
     */
    async upsertCustomerByPhone(phone) {
      const rows = await prisma.$queryRaw<SignedInUser[]>`
        INSERT INTO "users" ("phone", "role")
        VALUES (${phone}, 'customer')
        ON CONFLICT ("phone") DO UPDATE SET "updated_at" = now()
        RETURNING
          "id",
          "phone",
          "role"::text AS "role",
          "status"::text AS "status",
          (xmax = 0) AS "created"
      `;
      const user = rows[0];
      if (user === undefined) {
        throw new Error('User upsert returned no row');
      }
      return user;
    },
  };
}
