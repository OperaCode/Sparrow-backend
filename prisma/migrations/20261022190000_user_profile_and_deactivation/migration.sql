-- Profile fields captured after the phone is verified. Name and community
-- stay null until onboarding. Account type defaults so a raw insert cannot
-- omit it. Deactivation is a distinct status from suspension.

CREATE TYPE "user_account_type" AS ENUM ('standard', 'business');

CREATE TYPE "user_community" AS ENUM ('igbesa', 'lusada', 'ketu');

ALTER TYPE "user_status" ADD VALUE 'deactivated';

ALTER TABLE "users"
  ADD COLUMN "name" VARCHAR(80),
  ADD COLUMN "community" "user_community",
  ADD COLUMN "account_type" "user_account_type" NOT NULL DEFAULT 'standard';

-- Stored names are trimmed. Prisma cannot express this CHECK.
ALTER TABLE "users"
  ADD CONSTRAINT "users_name_check" CHECK (
    "name" IS NULL
    OR (
      char_length("name") > 0
      AND "name" = btrim("name")
    )
  );
