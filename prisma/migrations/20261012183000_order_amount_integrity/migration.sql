-- An automatic order must bill every leg that service requires, and the
-- stored total must be the sum of those legs. A null leg cannot be coerced
-- to zero to shrink the amount due.

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_auto_components_check" CHECK (
    "pricing_status" <> 'auto'
    OR (
      "total_naira" =
        COALESCE("zone_amount_naira", 0)
        + COALESCE("special_pickup_amount_naira", 0)
        + COALESCE("errand_amount_naira", 0)
      AND (
        (
          "service_type" = 'standard'
          AND "zone_amount_naira" IS NOT NULL
          AND "special_pickup_amount_naira" IS NULL
          AND "special_pickup_tier" IS NULL
          AND "errand_amount_naira" IS NULL
          AND "errand_tier" IS NULL
          AND "collection_place" IS NULL
        )
        OR (
          "service_type" = 'special_pickup'
          AND "zone_amount_naira" IS NOT NULL
          AND "special_pickup_amount_naira" IS NOT NULL
          AND "special_pickup_tier" IS NOT NULL
          AND "errand_amount_naira" IS NULL
          AND "errand_tier" IS NULL
          AND "collection_place" IS NOT NULL
        )
        OR (
          "service_type" = 'errand'
          AND "errand_amount_naira" IS NOT NULL
          AND "errand_tier" IS NOT NULL
          AND "special_pickup_amount_naira" IS NULL
          AND "special_pickup_tier" IS NULL
          AND "collection_place" IS NULL
          AND (
            (
              "zone_amount_naira" IS NULL
              AND "zone_tier" IS NULL
              AND "pickup_place" IS NULL
              AND "destination_place" IS NULL
            )
            OR (
              "zone_amount_naira" IS NOT NULL
              AND "zone_tier" IS NOT NULL
              AND "pickup_place" IS NOT NULL
              AND "destination_place" IS NOT NULL
            )
          )
        )
      )
    )
  );
