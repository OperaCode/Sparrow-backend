-- CreateEnum
CREATE TYPE "pricing_component" AS ENUM ('standard_zone', 'special_pickup', 'errand');

-- CreateEnum
CREATE TYPE "quote_mode" AS ENUM ('automatic', 'manual');

-- CreateEnum
CREATE TYPE "pricing_status" AS ENUM ('auto', 'pending_manual_quote', 'manual_quoted');

-- CreateEnum
CREATE TYPE "service_type" AS ENUM ('standard', 'special_pickup', 'errand');

-- CreateEnum
CREATE TYPE "place" AS ENUM ('igbesa', 'lusada', 'ketu', 'extended', 'outside');

-- CreateEnum
CREATE TYPE "zone_tier" AS ENUM ('A', 'B', 'C', 'extended', 'outside_area');

-- CreateEnum
CREATE TYPE "special_pickup_tier" AS ENUM ('local', 'nearby', 'extended', 'outside_area');

-- CreateEnum
CREATE TYPE "errand_tier" AS ENUM ('simple', 'moderate', 'complex');

-- CreateTable
CREATE TABLE "price_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "component" "pricing_component" NOT NULL,
    "tier" VARCHAR(32) NOT NULL,
    "amount_naira" INTEGER,
    "quote_mode" "quote_mode" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "quoted_by_id" UUID,
    "service_type" "service_type" NOT NULL,
    "pickup_place" "place",
    "destination_place" "place",
    "collection_place" "place",
    "errand_tier" "errand_tier",
    "pricing_status" "pricing_status" NOT NULL,
    "zone_tier" "zone_tier",
    "zone_amount_naira" INTEGER,
    "special_pickup_tier" "special_pickup_tier",
    "special_pickup_amount_naira" INTEGER,
    "errand_amount_naira" INTEGER,
    "total_naira" INTEGER,
    "quoted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_rules_component_tier_key" ON "price_rules"("component", "tier");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quoted_by_id_fkey" FOREIGN KEY ("quoted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Automatic tiers must carry a positive amount. Manual tiers must not, so a
-- configured amount cannot be charged while the tier is still a quote.
ALTER TABLE "price_rules"
  ADD CONSTRAINT "price_rules_amount_mode_check" CHECK (
    (
      "quote_mode" = 'automatic'
      AND "amount_naira" IS NOT NULL
      AND "amount_naira" > 0
    )
    OR (
      "quote_mode" = 'manual'
      AND "amount_naira" IS NULL
    )
  );

ALTER TABLE "price_rules"
  ADD CONSTRAINT "price_rules_tier_check" CHECK (
    (
      "component" = 'standard_zone'
      AND "tier" IN ('A', 'B', 'C', 'extended', 'outside_area')
    )
    OR (
      "component" = 'special_pickup'
      AND "tier" IN ('local', 'nearby', 'extended', 'outside_area')
    )
    OR (
      "component" = 'errand'
      AND "tier" IN ('simple', 'moderate', 'complex')
    )
  );

-- total_naira is the amount due. It exists only once a price is known, and a
-- manual quote records who set it. Component amounts are a separate snapshot.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_status_check" CHECK (
    (
      "pricing_status" = 'auto'
      AND "total_naira" IS NOT NULL
      AND "quoted_by_id" IS NULL
      AND "quoted_at" IS NULL
    )
    OR (
      "pricing_status" = 'pending_manual_quote'
      AND "total_naira" IS NULL
      AND "quoted_by_id" IS NULL
      AND "quoted_at" IS NULL
    )
    OR (
      "pricing_status" = 'manual_quoted'
      AND "total_naira" IS NOT NULL
      AND "quoted_by_id" IS NOT NULL
      AND "quoted_at" IS NOT NULL
    )
  );

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_positive_check" CHECK (
    ("zone_amount_naira" IS NULL OR "zone_amount_naira" > 0)
    AND ("special_pickup_amount_naira" IS NULL OR "special_pickup_amount_naira" > 0)
    AND ("errand_amount_naira" IS NULL OR "errand_amount_naira" > 0)
    AND ("total_naira" IS NULL OR "total_naira" > 0)
  );

-- Approved V1 rates. Later changes are row updates, not app releases.
INSERT INTO "price_rules" ("component", "tier", "amount_naira", "quote_mode") VALUES
  ('standard_zone', 'A', 800, 'automatic'),
  ('standard_zone', 'B', 1000, 'automatic'),
  ('standard_zone', 'C', 1300, 'automatic'),
  ('standard_zone', 'extended', NULL, 'manual'),
  ('standard_zone', 'outside_area', NULL, 'manual'),
  ('special_pickup', 'local', 500, 'automatic'),
  ('special_pickup', 'nearby', 700, 'automatic'),
  ('special_pickup', 'extended', NULL, 'manual'),
  ('special_pickup', 'outside_area', NULL, 'manual'),
  ('errand', 'simple', 500, 'automatic'),
  ('errand', 'moderate', 700, 'automatic'),
  ('errand', 'complex', NULL, 'manual');
