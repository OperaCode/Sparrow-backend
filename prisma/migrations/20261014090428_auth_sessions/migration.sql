-- CreateEnum
CREATE TYPE "session_revoked_reason" AS ENUM ('logout', 'refresh_reuse');

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "firebase_uid" VARCHAR(128) NOT NULL,
    "firebase_auth_time" TIMESTAMPTZ(3) NOT NULL,
    "refresh_token_hash" BYTEA NOT NULL,
    "refresh_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_refreshed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" "session_revoked_reason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_firebase_uid_firebase_auth_time_key" ON "auth_sessions"("firebase_uid", "firebase_auth_time");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Session invariants Prisma cannot express. The refresh token hash is a
-- SHA-256 digest, a revocation always records why, and rotation can never
-- push the refresh expiry past the session's absolute cap.
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_refresh_token_hash_length_check" CHECK (octet_length("refresh_token_hash") = 32),
  ADD CONSTRAINT "auth_sessions_revocation_check" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL)),
  ADD CONSTRAINT "auth_sessions_expiry_order_check" CHECK ("refresh_expires_at" <= "absolute_expires_at"),
  ADD CONSTRAINT "auth_sessions_firebase_uid_check" CHECK (length("firebase_uid") > 0);
