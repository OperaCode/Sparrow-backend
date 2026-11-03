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
    "amount_kobo" INTEGER,
    "minimum_kobo" INTEGER,
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
    "pickup_latitude" DOUBLE PRECISION,
    "pickup_longitude" DOUBLE PRECISION,
    "destination_latitude" DOUBLE PRECISION,
    "destination_longitude" DOUBLE PRECISION,
    "collection_latitude" DOUBLE PRECISION,
    "collection_longitude" DOUBLE PRECISION,
    "pricing_status" "pricing_status" NOT NULL,
    "zone_tier" "zone_tier",
    "zone_amount_kobo" INTEGER,
    "special_pickup_tier" "special_pickup_tier",
    "special_pickup_amount_kobo" INTEGER,
    "errand_amount_kobo" INTEGER,
    "total_kobo" INTEGER,
    "minimum_total_kobo" INTEGER,
    "quoted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_areas" (
    "place" "place" NOT NULL,
    "min_latitude" DOUBLE PRECISION NOT NULL,
    "max_latitude" DOUBLE PRECISION NOT NULL,
    "min_longitude" DOUBLE PRECISION NOT NULL,
    "max_longitude" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("place")
);

-- CreateTable
CREATE TABLE "price_rule_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule_id" UUID NOT NULL,
    "component" "pricing_component" NOT NULL,
    "tier" VARCHAR(32) NOT NULL,
    "actor_id" UUID NOT NULL,
    "old_quote_mode" "quote_mode" NOT NULL,
    "old_amount_kobo" INTEGER,
    "old_minimum_kobo" INTEGER,
    "new_quote_mode" "quote_mode" NOT NULL,
    "new_amount_kobo" INTEGER,
    "new_minimum_kobo" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_rule_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_rules_component_tier_key" ON "price_rules"("component", "tier");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- CreateIndex
CREATE INDEX "price_rule_changes_rule_id_idx" ON "price_rule_changes"("rule_id");

-- CreateIndex
CREATE INDEX "price_rule_changes_actor_id_idx" ON "price_rule_changes"("actor_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quoted_by_id_fkey" FOREIGN KEY ("quoted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rule_changes" ADD CONSTRAINT "price_rule_changes_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "price_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rule_changes" ADD CONSTRAINT "price_rule_changes_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Automatic tiers store a positive charge and no floor. Manual tiers store no
-- charge and a positive floor, so a configured amount cannot be billed while
-- the tier is still a quote.
ALTER TABLE "price_rules"
  ADD CONSTRAINT "price_rules_amount_mode_check" CHECK (
    (
      "quote_mode" = 'automatic'
      AND "amount_kobo" IS NOT NULL
      AND "amount_kobo" > 0
      AND "minimum_kobo" IS NULL
    )
    OR (
      "quote_mode" = 'manual'
      AND "amount_kobo" IS NULL
      AND "minimum_kobo" IS NOT NULL
      AND "minimum_kobo" > 0
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

-- total_kobo is the amount due. It exists only once a price is known, and a
-- manual quote records who set it. Component amounts are a separate snapshot.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_status_check" CHECK (
    (
      "pricing_status" = 'auto'
      AND "total_kobo" IS NOT NULL
      AND "quoted_by_id" IS NULL
      AND "quoted_at" IS NULL
    )
    OR (
      "pricing_status" = 'pending_manual_quote'
      AND "total_kobo" IS NULL
      AND "quoted_by_id" IS NULL
      AND "quoted_at" IS NULL
    )
    OR (
      "pricing_status" = 'manual_quoted'
      AND "total_kobo" IS NOT NULL
      AND "quoted_by_id" IS NOT NULL
      AND "quoted_at" IS NOT NULL
    )
  );

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_positive_check" CHECK (
    ("zone_amount_kobo" IS NULL OR "zone_amount_kobo" > 0)
    AND ("special_pickup_amount_kobo" IS NULL OR "special_pickup_amount_kobo" > 0)
    AND ("errand_amount_kobo" IS NULL OR "errand_amount_kobo" > 0)
    AND ("total_kobo" IS NULL OR "total_kobo" > 0)
    AND ("minimum_total_kobo" IS NULL OR "minimum_total_kobo" > 0)
  );

-- An automatic order must bill every leg that service requires, and the
-- stored total must be the sum of those legs. A null leg cannot be coerced
-- to zero to shrink the amount due.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_auto_components_check" CHECK (
    "pricing_status" <> 'auto'
    OR (
      "total_kobo" =
        COALESCE("zone_amount_kobo", 0)
        + COALESCE("special_pickup_amount_kobo", 0)
        + COALESCE("errand_amount_kobo", 0)
      AND (
        (
          "service_type" = 'standard'
          AND "zone_amount_kobo" IS NOT NULL
          AND "special_pickup_amount_kobo" IS NULL
          AND "special_pickup_tier" IS NULL
          AND "errand_amount_kobo" IS NULL
          AND "errand_tier" IS NULL
          AND "collection_place" IS NULL
        )
        OR (
          "service_type" = 'special_pickup'
          AND "zone_amount_kobo" IS NOT NULL
          AND "special_pickup_amount_kobo" IS NOT NULL
          AND "special_pickup_tier" IS NOT NULL
          AND "errand_amount_kobo" IS NULL
          AND "errand_tier" IS NULL
          AND "collection_place" IS NOT NULL
        )
        OR (
          "service_type" = 'errand'
          AND "errand_amount_kobo" IS NOT NULL
          AND "errand_tier" IS NOT NULL
          AND "special_pickup_amount_kobo" IS NULL
          AND "special_pickup_tier" IS NULL
          AND "collection_place" IS NULL
          AND (
            (
              "zone_amount_kobo" IS NULL
              AND "zone_tier" IS NULL
              AND "pickup_place" IS NULL
              AND "destination_place" IS NULL
            )
            OR (
              "zone_amount_kobo" IS NOT NULL
              AND "zone_tier" IS NOT NULL
              AND "pickup_place" IS NOT NULL
              AND "destination_place" IS NOT NULL
            )
          )
        )
      )
    )
  );

-- The floor is snapshotted with the order. A later edit of the live minimum
-- cannot make an old quote acceptable below the floor it was given.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_quote_floor_check" CHECK (
    (
      "pricing_status" = 'auto'
      AND "minimum_total_kobo" IS NULL
    )
    OR (
      "pricing_status" = 'pending_manual_quote'
      AND "minimum_total_kobo" IS NOT NULL
      AND "minimum_total_kobo" > 0
    )
    OR (
      "pricing_status" = 'manual_quoted'
      AND "minimum_total_kobo" IS NOT NULL
      AND "minimum_total_kobo" > 0
      AND "total_kobo" >= "minimum_total_kobo"
    )
  );

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_coordinate_pairs_check" CHECK (
    ("pickup_latitude" IS NULL) = ("pickup_longitude" IS NULL)
    AND ("destination_latitude" IS NULL) = ("destination_longitude" IS NULL)
    AND ("collection_latitude" IS NULL) = ("collection_longitude" IS NULL)
    AND (
      "pickup_latitude" IS NULL
      OR (
        "pickup_latitude" BETWEEN -90 AND 90
        AND "pickup_longitude" BETWEEN -180 AND 180
      )
    )
    AND (
      "destination_latitude" IS NULL
      OR (
        "destination_latitude" BETWEEN -90 AND 90
        AND "destination_longitude" BETWEEN -180 AND 180
      )
    )
    AND (
      "collection_latitude" IS NULL
      OR (
        "collection_latitude" BETWEEN -90 AND 90
        AND "collection_longitude" BETWEEN -180 AND 180
      )
    )
  );

ALTER TABLE "service_areas"
  ADD CONSTRAINT "service_areas_place_check" CHECK (
    "place" IN ('igbesa', 'lusada', 'ketu', 'extended')
  );

ALTER TABLE "service_areas"
  ADD CONSTRAINT "service_areas_box_check" CHECK (
    "min_latitude" < "max_latitude"
    AND "min_latitude" >= -90
    AND "max_latitude" <= 90
    AND "min_longitude" < "max_longitude"
    AND "min_longitude" >= -180
    AND "max_longitude" <= 180
  );

ALTER TABLE "price_rule_changes"
  ADD CONSTRAINT "price_rule_changes_old_mode_check" CHECK (
    (
      "old_quote_mode" = 'automatic'
      AND "old_amount_kobo" IS NOT NULL
      AND "old_amount_kobo" > 0
      AND "old_minimum_kobo" IS NULL
    )
    OR (
      "old_quote_mode" = 'manual'
      AND "old_amount_kobo" IS NULL
      AND "old_minimum_kobo" IS NOT NULL
      AND "old_minimum_kobo" > 0
    )
  );

ALTER TABLE "price_rule_changes"
  ADD CONSTRAINT "price_rule_changes_new_mode_check" CHECK (
    (
      "new_quote_mode" = 'automatic'
      AND "new_amount_kobo" IS NOT NULL
      AND "new_amount_kobo" > 0
      AND "new_minimum_kobo" IS NULL
    )
    OR (
      "new_quote_mode" = 'manual'
      AND "new_amount_kobo" IS NULL
      AND "new_minimum_kobo" IS NOT NULL
      AND "new_minimum_kobo" > 0
    )
  );

-- Approved V1 rates in kobo (100 kobo = ₦1). Later changes are row updates.
INSERT INTO "price_rules" ("component", "tier", "amount_kobo", "minimum_kobo", "quote_mode") VALUES
  ('standard_zone', 'A', 80000, NULL, 'automatic'),
  ('standard_zone', 'B', 100000, NULL, 'automatic'),
  ('standard_zone', 'C', 130000, NULL, 'automatic'),
  ('standard_zone', 'extended', NULL, 150000, 'manual'),
  ('standard_zone', 'outside_area', NULL, 150000, 'manual'),
  ('special_pickup', 'local', 50000, NULL, 'automatic'),
  ('special_pickup', 'nearby', 70000, NULL, 'automatic'),
  ('special_pickup', 'extended', NULL, 100000, 'manual'),
  ('special_pickup', 'outside_area', NULL, 100000, 'manual'),
  ('errand', 'simple', 50000, NULL, 'automatic'),
  ('errand', 'moderate', 70000, NULL, 'automatic'),
  ('errand', 'complex', NULL, 100000, 'manual');

INSERT INTO "service_areas" (
  "place",
  "min_latitude",
  "max_latitude",
  "min_longitude",
  "max_longitude"
) VALUES
  ('igbesa', 6.515, 6.555, 3.11, 3.165),
  ('lusada', 6.565, 6.605, 3.06, 3.109),
  ('ketu', 6.5, 6.53, 3.05, 3.095),
  ('extended', 6.48, 6.62, 3.04, 3.18);
