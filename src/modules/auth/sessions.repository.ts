import type { PrismaClient } from '../../lib/prisma.js';
import type { AccountStatus } from '../../types/auth.js';

export interface CreateSessionInput {
  userId: string;
  firebaseUid: string;
  firebaseAuthTime: Date;
  refreshTokenHash: Uint8Array<ArrayBuffer>;
  refreshTtlSeconds: number;
  maxAgeSeconds: number;
}

export interface SessionExpiry {
  id: string;
  userId: string;
  refreshExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface RotateSessionInput {
  sessionId: string;
  presentedHash: Uint8Array<ArrayBuffer>;
  nextHash: Uint8Array<ArrayBuffer>;
  refreshTtlSeconds: number;
}

export interface RotatedSession extends SessionExpiry {
  userStatus: AccountStatus;
}

export type RotateSessionResult =
  | { status: 'rotated'; session: RotatedSession }
  | { status: 'reused'; userId: string }
  | { status: 'invalid' };

export interface SessionsRepository {
  /** Returns null when this Firebase sign-in already opened a session. */
  create(input: CreateSessionInput): Promise<SessionExpiry | null>;
  rotate(input: RotateSessionInput): Promise<RotateSessionResult>;
  /** Returns false when the token does not match a live session. */
  revokeForLogout(
    sessionId: string,
    hash: Uint8Array<ArrayBuffer>,
  ): Promise<boolean>;
}

/**
 * Timestamps come from the database clock, so every instance agrees on
 * expiry. Durations are whole seconds, cast so Postgres never guesses a type.
 */
export function createSessionsRepository(
  prisma: PrismaClient,
): SessionsRepository {
  return {
    async create(input) {
      // The refresh expiry is capped at the absolute expiry, as the
      // auth_sessions_expiry_order_check constraint requires.
      const rows = await prisma.$queryRaw<SessionExpiry[]>`
        INSERT INTO "auth_sessions" (
          "user_id",
          "firebase_uid",
          "firebase_auth_time",
          "refresh_token_hash",
          "refresh_expires_at",
          "absolute_expires_at"
        )
        VALUES (
          CAST(${input.userId} AS uuid),
          ${input.firebaseUid},
          ${input.firebaseAuthTime},
          ${input.refreshTokenHash},
          LEAST(
            now() + CAST(${input.refreshTtlSeconds} AS integer) * interval '1 second',
            now() + CAST(${input.maxAgeSeconds} AS integer) * interval '1 second'
          ),
          now() + CAST(${input.maxAgeSeconds} AS integer) * interval '1 second'
        )
        ON CONFLICT ("firebase_uid", "firebase_auth_time") DO NOTHING
        RETURNING
          "id",
          "user_id" AS "userId",
          "refresh_expires_at" AS "refreshExpiresAt",
          "absolute_expires_at" AS "absoluteExpiresAt"
      `;
      return rows[0] ?? null;
    },

    /**
     * One compare-and-swap on the current hash, so two requests presenting
     * the same token cannot both rotate it. The sliding expiry never passes
     * the absolute expiry. The owner's status comes back in the same round
     * trip so a suspended user can be refused.
     */
    async rotate(input) {
      const rotated = await prisma.$queryRaw<RotatedSession[]>`
        UPDATE "auth_sessions"
        SET
          "refresh_token_hash" = ${input.nextHash},
          "refresh_expires_at" = LEAST(
            now() + CAST(${input.refreshTtlSeconds} AS integer) * interval '1 second',
            "absolute_expires_at"
          ),
          "last_refreshed_at" = now()
        WHERE "id" = CAST(${input.sessionId} AS uuid)
          AND "refresh_token_hash" = ${input.presentedHash}
          AND "revoked_at" IS NULL
          AND "refresh_expires_at" > now()
          AND "absolute_expires_at" > now()
        RETURNING
          "id",
          "user_id" AS "userId",
          "refresh_expires_at" AS "refreshExpiresAt",
          "absolute_expires_at" AS "absoluteExpiresAt",
          (
            SELECT u."status"::text FROM "users" u
            WHERE u."id" = "auth_sessions"."user_id"
          ) AS "userStatus"
      `;
      const session = rotated[0];
      if (session !== undefined) return { status: 'rotated', session };

      // A live session whose hash differs means a superseded token was
      // replayed. Either the client or an attacker holds a stale copy, so
      // the whole session is revoked.
      const revoked = await prisma.$queryRaw<{ userId: string }[]>`
        UPDATE "auth_sessions"
        SET "revoked_at" = now(), "revoked_reason" = 'refresh_reuse'
        WHERE "id" = CAST(${input.sessionId} AS uuid)
          AND "revoked_at" IS NULL
          AND "refresh_token_hash" <> ${input.presentedHash}
        RETURNING "user_id" AS "userId"
      `;
      const reused = revoked[0];
      return reused === undefined
        ? { status: 'invalid' }
        : { status: 'reused', userId: reused.userId };
    },

    async revokeForLogout(sessionId, hash) {
      const count = await prisma.$executeRaw`
        UPDATE "auth_sessions"
        SET "revoked_at" = now(), "revoked_reason" = 'logout'
        WHERE "id" = CAST(${sessionId} AS uuid)
          AND "refresh_token_hash" = ${hash}
          AND "revoked_at" IS NULL
      `;
      return count > 0;
    },
  };
}
