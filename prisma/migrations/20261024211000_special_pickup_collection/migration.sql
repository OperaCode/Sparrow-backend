-- Special Pickup keeps its third-party collection apart from the delivery
-- pickup. Standard Delivery and Errand have no row in this table.

CREATE TABLE "order_collections" (
    "order_id" UUID NOT NULL,
    "address" VARCHAR(200) NOT NULL,
    "landmark" VARCHAR(120),
    "contact_name" VARCHAR(80) NOT NULL,
    "contact_phone" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_collections_pkey" PRIMARY KEY ("order_id")
);

CREATE INDEX "orders_created_at_id_idx" ON "orders"("created_at", "id");

CREATE INDEX "orders_service_type_created_at_id_idx" ON "orders"("service_type", "created_at", "id");

ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Trimmed operational text. A blank landmark is stored as NULL, not ''.
ALTER TABLE "order_collections"
  ADD CONSTRAINT "order_collections_address_check" CHECK (
    "address" = btrim("address")
    AND char_length("address") BETWEEN 1 AND 200
  );

ALTER TABLE "order_collections"
  ADD CONSTRAINT "order_collections_landmark_check" CHECK (
    "landmark" IS NULL
    OR (
      "landmark" = btrim("landmark")
      AND char_length("landmark") BETWEEN 1 AND 120
    )
  );

ALTER TABLE "order_collections"
  ADD CONSTRAINT "order_collections_contact_name_check" CHECK (
    "contact_name" = btrim("contact_name")
    AND char_length("contact_name") BETWEEN 1 AND 80
  );

ALTER TABLE "order_collections"
  ADD CONSTRAINT "order_collections_contact_phone_check" CHECK (
    "contact_phone" ~ '^\+[1-9][0-9]{7,14}$'
  );

-- One collection for Special Pickup, and none for Standard Delivery or Errand.
-- Deferred so the order and its collection can be inserted in one transaction.
CREATE OR REPLACE FUNCTION enforce_order_collection_cardinality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_order uuid;
  service "service_type";
  collections integer;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    target_order := COALESCE(NEW.id, OLD.id);
  ELSE
    target_order := COALESCE(NEW.order_id, OLD.order_id);
  END IF;

  SELECT "service_type" INTO service FROM "orders" WHERE "id" = target_order;
  IF service IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::integer INTO collections
  FROM "order_collections"
  WHERE "order_id" = target_order;

  IF service = 'special_pickup' AND collections <> 1 THEN
    RAISE EXCEPTION 'orders_collection_cardinality_check'
      USING ERRCODE = '23514';
  END IF;

  IF service <> 'special_pickup' AND collections <> 0 THEN
    RAISE EXCEPTION 'orders_collection_cardinality_check'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_collection_cardinality"
AFTER INSERT OR UPDATE OF "service_type" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_order_collection_cardinality();

CREATE CONSTRAINT TRIGGER "order_collections_cardinality"
AFTER INSERT OR UPDATE OR DELETE ON "order_collections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_order_collection_cardinality();
