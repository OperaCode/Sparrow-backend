-- Retry keys for order and payment submissions, and the audit trail for
-- privileged writes. Checks Prisma cannot express live in this migration.

CREATE TYPE "idempotency_state" AS ENUM ('processing', 'completed');

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "state" "idempotency_state" NOT NULL,
    "status_code" INTEGER,
    "response_body" JSONB,
    "locked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(64) NOT NULL,
    "target_id" VARCHAR(64) NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_actor_id_scope_key_key" ON "idempotency_records"("actor_id", "scope", "key");

CREATE INDEX "audit_events_actor_id_created_at_idx" ON "audit_events"("actor_id", "created_at");

CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events"("target_type", "target_id");

ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A completed row is replayable. A processing row has no response yet.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_state_check" CHECK (
    (
      "state" = 'processing'
      AND "status_code" IS NULL
      AND "response_body" IS NULL
      AND "completed_at" IS NULL
    )
    OR (
      "state" = 'completed'
      AND "status_code" BETWEEN 100 AND 499
      AND "response_body" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
  );

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_key_check" CHECK (
    char_length("key") BETWEEN 16 AND 128
    AND "key" ~ '^[A-Za-z0-9_-]+$'
  );

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_scope_check" CHECK (
    "scope" ~ '^[a-z0-9]+(\.[a-z0-9]+)+$'
  );

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_action_check" CHECK (
    "action" ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'
  );

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_target_check" CHECK (
    "target_type" ~ '^[a-z_]+$'
    AND "target_id" ~ '^[A-Za-z0-9:_-]{1,64}$'
  );

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_request_id_check" CHECK (
    "request_id" ~ '^[A-Za-z0-9-]{8,64}$'
  );

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_metadata_check" CHECK (
    jsonb_typeof("metadata") = 'object'
  );
