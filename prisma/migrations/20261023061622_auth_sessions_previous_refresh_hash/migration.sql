-- AlterTable
ALTER TABLE "auth_sessions" ADD COLUMN     "previous_refresh_token_hash" BYTEA;

-- The superseded refresh token hash is a SHA-256 digest like the current
-- one. It is NULL until the first rotation, which the CHECK allows.
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_previous_refresh_token_hash_length_check" CHECK (octet_length("previous_refresh_token_hash") = 32);
