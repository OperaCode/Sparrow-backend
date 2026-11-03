import { Prisma } from "../../generated/prisma/client.js";
import {
  slicePage,
  type CreatedAtPage,
  type PageSlice,
} from "../../http/pagination.js";
import type { PrismaClient } from "../../lib/prisma.js";
import type { AuditActor } from "../../types/auth.js";
import type { IdempotencyClaim } from "../../types/idempotency.js";
import { createAuditRepository } from "../audit/audit.repository.js";
import {
  readIdempotentResult,
  saveIdempotentResult,
} from "../idempotency/idempotency.repository.js";
import { assertServiceAreaMap, isServiceAreaPlace } from "./pricing.locate.js";
import {
  PricingConfigurationError,
  amountDue,
  assertPositiveKobo,
} from "./pricing.money.js";
import type {
  AreaBox,
  CollectionLeg,
  Coordinate,
  ErrandTier,
  OperationsOrder,
  OrderRequest,
  Place,
  PriceComponentQuote,
  PriceQuote,
  PriceRuleRecord,
  PricedOrder,
  PricingComponent,
  PricingStatus,
  RuleUpdate,
  ServiceArea,
  ServiceAreaPlace,
  SpecialPickupTier,
  ZoneTier,
} from "./pricing.types.js";

type ServiceType = OrderRequest["service"];

interface SnapshotRow {
  id: string;
  serviceType: ServiceType;
  pricingStatus: PricingStatus;
  errandTier: ErrandTier | null;
  errandAmountKobo: number | null;
  zoneTier: ZoneTier | null;
  zoneAmountKobo: number | null;
  specialPickupTier: SpecialPickupTier | null;
  specialPickupAmountKobo: number | null;
  totalKobo: number | null;
  minimumTotalKobo: number | null;
  pickupPlace: Place | null;
  destinationPlace: Place | null;
  collectionPlace: Place | null;
  collectionLatitude: number | null;
  collectionLongitude: number | null;
}

/** Address and contact for the third-party stop. Coordinates live on the order. */
interface StoredCollection {
  address: string;
  landmark: string | null;
  contactName: string;
  contactPhone: string;
}

export type ManualQuoteWriteResult =
  PricedOrder | "missing" | "not_pending" | { belowMinimum: number };

export type AreaWriteResult = ServiceArea | "missing" | "invalid";

export interface CreatePricedOrderArgs {
  customerId: string;
  request: OrderRequest;
  claim: IdempotencyClaim;
  quoteFromRules: (
    rules: readonly PriceRuleRecord[],
    areas: readonly ServiceArea[],
  ) => PriceQuote;
}

export type CreatePricedOrderResult =
  | { outcome: "created"; order: PricedOrder }
  | { outcome: "replay"; statusCode: number; body: unknown }
  | { outcome: "mismatch" }
  | { outcome: "in_progress" };

export interface PricingRepository {
  listRules(): Promise<PriceRuleRecord[]>;
  updateRule(
    component: PricingComponent,
    tier: string,
    patch: RuleUpdate,
    actor: AuditActor,
  ): Promise<PriceRuleRecord | null>;
  listAreas(): Promise<ServiceArea[]>;
  updateArea(
    place: ServiceAreaPlace,
    box: AreaBox,
    actor: AuditActor,
  ): Promise<AreaWriteResult>;
  createPricedOrder(
    args: CreatePricedOrderArgs,
  ): Promise<CreatePricedOrderResult>;
  listOrders(
    page: CreatedAtPage,
    serviceType?: ServiceType,
  ): Promise<PageSlice<OperationsOrder>>;
  getOrder(id: string): Promise<OperationsOrder | null>;
  applyManualQuote(
    id: string,
    amountKobo: number,
    actor: AuditActor,
  ): Promise<ManualQuoteWriteResult>;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function toRule(row: {
  component: PriceRuleRecord["component"];
  tier: string;
  quoteMode: PriceRuleRecord["quoteMode"];
  amountKobo: number | null;
  minimumKobo: number | null;
}): PriceRuleRecord {
  return {
    component: row.component,
    tier: row.tier,
    quoteMode: row.quoteMode,
    amountKobo: row.amountKobo,
    minimumKobo: row.minimumKobo,
  };
}

function toArea(row: {
  place: string;
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}): ServiceArea | null {
  if (!isServiceAreaPlace(row.place)) return null;
  return {
    place: row.place,
    minLatitude: row.minLatitude,
    maxLatitude: row.maxLatitude,
    minLongitude: row.minLongitude,
    maxLongitude: row.maxLongitude,
  };
}

function collectionLeg(
  row: SnapshotRow,
  collection: StoredCollection | null,
): CollectionLeg | null {
  if (row.serviceType !== "special_pickup") {
    if (collection !== null) {
      throw new PricingConfigurationError(
        "A collection is stored on a service that is not Special Pickup",
      );
    }
    return null;
  }
  if (
    collection === null ||
    row.collectionPlace === null ||
    row.collectionLatitude === null ||
    row.collectionLongitude === null
  ) {
    throw new PricingConfigurationError(
      "Special pickup is missing its collection",
    );
  }
  return {
    kind: "collection",
    address: collection.address,
    landmark: collection.landmark,
    contactName: collection.contactName,
    contactPhone: collection.contactPhone,
    latitude: row.collectionLatitude,
    longitude: row.collectionLongitude,
    place: row.collectionPlace,
  };
}

function toPricedOrder(
  row: SnapshotRow,
  collection: StoredCollection | null,
): PricedOrder {
  const components: PriceComponentQuote[] = [];
  if (row.errandTier !== null) {
    components.push({
      component: "errand",
      tier: row.errandTier,
      quoteMode: row.errandAmountKobo === null ? "manual" : "automatic",
      amountKobo: row.errandAmountKobo,
    });
  }
  if (row.zoneTier !== null) {
    components.push({
      component: "standard_zone",
      tier: row.zoneTier,
      quoteMode: row.zoneAmountKobo === null ? "manual" : "automatic",
      amountKobo: row.zoneAmountKobo,
    });
  }
  if (row.specialPickupTier !== null) {
    components.push({
      component: "special_pickup",
      tier: row.specialPickupTier,
      quoteMode: row.specialPickupAmountKobo === null ? "manual" : "automatic",
      amountKobo: row.specialPickupAmountKobo,
    });
  }

  assertStoredTotal(row, components);

  return {
    id: row.id,
    serviceType: row.serviceType,
    pricingStatus: row.pricingStatus,
    currency: "NGN",
    components,
    totalKobo: row.totalKobo,
    minimumTotalKobo: row.minimumTotalKobo,
    pickupPlace: row.pickupPlace,
    destinationPlace: row.destinationPlace,
    collectionPlace: row.collectionPlace,
    collection: collectionLeg(row, collection),
  };
}

function toOperationsOrder(
  row: SnapshotRow & { customerId: string; createdAt: Date },
  collection: StoredCollection | null,
): OperationsOrder {
  return {
    ...toPricedOrder(row, collection),
    customerId: row.customerId,
    createdAt: row.createdAt,
  };
}

/**
 * An automatic order's amount due is the sum of its legs. A pending quote has
 * no amount due. A manual quote's total is the figure operations entered, and
 * it must still be a real charge.
 */
function assertStoredTotal(
  row: SnapshotRow,
  components: readonly PriceComponentQuote[],
): void {
  if (row.pricingStatus === "manual_quoted") {
    const total = assertPositiveKobo(row.totalKobo, "stored total");
    const floor = assertPositiveKobo(row.minimumTotalKobo, "snapshotted floor");
    if (total < floor) {
      throw new PricingConfigurationError(
        "Stored total is below the snapshotted floor",
      );
    }
    return;
  }
  if (row.pricingStatus === "pending_manual_quote") {
    assertPositiveKobo(row.minimumTotalKobo, "snapshotted floor");
  } else if (row.minimumTotalKobo !== null) {
    throw new PricingConfigurationError("Automatic order has a manual floor");
  }
  if (row.totalKobo !== amountDue(components)) {
    throw new PricingConfigurationError(
      "Stored total does not match the snapshotted components",
    );
  }
}

interface ManualQuoteRow {
  id: string;
  serviceType: string;
  pricingStatus: string;
  errandTier: string | null;
  errandAmountKobo: number | string | bigint | null;
  zoneTier: string | null;
  zoneAmountKobo: number | string | bigint | null;
  specialPickupTier: string | null;
  specialPickupAmountKobo: number | string | bigint | null;
  totalKobo: number | string | bigint | null;
  minimumTotalKobo: number | string | bigint | null;
  pickupPlace: string | null;
  destinationPlace: string | null;
  collectionPlace: string | null;
  collectionLatitude: number | null;
  collectionLongitude: number | null;
}

function wholeKobo(value: number | string | bigint | null): number | null {
  if (value === null) return null;
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new PricingConfigurationError(
      "Stored amount was not a whole number of kobo",
    );
  }
  return amount;
}

/** The RETURNING row is the charge. A mismatch rolls the update back. */
function orderFromManualQuote(
  row: ManualQuoteRow,
  amountKobo: number,
  collection: StoredCollection | null,
): PricedOrder {
  const totalKobo = wholeKobo(row.totalKobo);
  if (totalKobo !== amountKobo) {
    throw new PricingConfigurationError(
      "Manual quote was not stored as entered",
    );
  }
  return toPricedOrder(
    {
      id: row.id,
      serviceType: row.serviceType as ServiceType,
      pricingStatus: "manual_quoted",
      errandTier: row.errandTier as ErrandTier | null,
      errandAmountKobo: wholeKobo(row.errandAmountKobo),
      zoneTier: row.zoneTier as ZoneTier | null,
      zoneAmountKobo: wholeKobo(row.zoneAmountKobo),
      specialPickupTier: row.specialPickupTier as SpecialPickupTier | null,
      specialPickupAmountKobo: wholeKobo(row.specialPickupAmountKobo),
      totalKobo,
      minimumTotalKobo: wholeKobo(row.minimumTotalKobo),
      pickupPlace: row.pickupPlace as Place | null,
      destinationPlace: row.destinationPlace as Place | null,
      collectionPlace: row.collectionPlace as Place | null,
      collectionLatitude: row.collectionLatitude,
      collectionLongitude: row.collectionLongitude,
    },
    collection,
  );
}

function coordinateOrNull(point: Coordinate | undefined): {
  latitude: number | null;
  longitude: number | null;
} {
  if (point === undefined) return { latitude: null, longitude: null };
  return { latitude: point.latitude, longitude: point.longitude };
}

function storedCollection(request: OrderRequest): StoredCollection | null {
  if (request.service !== "special_pickup") return null;
  return {
    address: request.collection.address,
    landmark: request.collection.landmark ?? null,
    contactName: request.collection.contactName,
    contactPhone: request.collection.contactPhone,
  };
}

function orderCreateData(
  customerId: string,
  request: OrderRequest,
  quote: PriceQuote,
): Prisma.OrderCreateInput {
  const pickup = coordinateOrNull(
    "pickup" in request ? request.pickup : undefined,
  );
  const destination = coordinateOrNull(
    "destination" in request ? request.destination : undefined,
  );
  const collection = coordinateOrNull(
    request.service === "special_pickup" ? request.collection : undefined,
  );
  const zone = quote.components.find(
    (component) => component.component === "standard_zone",
  );
  const specialPickup = quote.components.find(
    (component) => component.component === "special_pickup",
  );
  const errand = quote.components.find(
    (component) => component.component === "errand",
  );

  return {
    customer: { connect: { id: customerId } },
    serviceType: request.service,
    pickupPlace: quote.pickupPlace,
    destinationPlace: quote.destinationPlace,
    collectionPlace: quote.collectionPlace,
    pickupLatitude: pickup.latitude,
    pickupLongitude: pickup.longitude,
    destinationLatitude: destination.latitude,
    destinationLongitude: destination.longitude,
    collectionLatitude: collection.latitude,
    collectionLongitude: collection.longitude,
    errandTier: request.service === "errand" ? request.errandTier : null,
    pricingStatus: quote.pricingStatus,
    zoneTier: zone?.tier ?? null,
    zoneAmountKobo: zone?.amountKobo ?? null,
    specialPickupTier: specialPickup?.tier ?? null,
    specialPickupAmountKobo: specialPickup?.amountKobo ?? null,
    errandAmountKobo: errand?.amountKobo ?? null,
    totalKobo: quote.totalKobo,
    minimumTotalKobo: quote.minimumTotalKobo,
  };
}

export function createPricingRepository(
  prisma: PrismaClient,
): PricingRepository {
  const audit = createAuditRepository();

  function pageWhere(
    page: CreatedAtPage,
    serviceType: ServiceType | undefined,
  ): Prisma.OrderWhereInput {
    const cursor =
      page.cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: page.cursor.createdAt } },
              {
                createdAt: page.cursor.createdAt,
                id: { lt: page.cursor.id },
              },
            ],
          };
    return {
      ...(serviceType === undefined ? {} : { serviceType }),
      ...cursor,
    };
  }

  return {
    async listRules() {
      const rows = await prisma.priceRule.findMany();
      return rows.map(toRule);
    },

    async updateRule(component, tier, patch, actor) {
      return prisma.$transaction(async (tx) => {
        const existing = await tx.priceRule.findUnique({
          where: { component_tier: { component, tier } },
        });
        if (existing === null) return null;
        const row = await tx.priceRule.update({
          where: { id: existing.id },
          data: {
            quoteMode: patch.quoteMode,
            amountKobo: patch.amountKobo,
            minimumKobo: patch.minimumKobo,
          },
        });
        await tx.priceRuleChange.create({
          data: {
            ruleId: existing.id,
            component: existing.component,
            tier: existing.tier,
            actorId: actor.actorId,
            oldQuoteMode: existing.quoteMode,
            oldAmountKobo: existing.amountKobo,
            oldMinimumKobo: existing.minimumKobo,
            newQuoteMode: patch.quoteMode,
            newAmountKobo: patch.amountKobo,
            newMinimumKobo: patch.minimumKobo,
          },
        });
        await audit.record(tx, {
          actorId: actor.actorId,
          requestId: actor.requestId,
          action: "pricing.rule.update",
          targetType: "price_rule",
          targetId: `${component}:${tier}`,
          metadata: {
            fromQuoteMode: existing.quoteMode,
            toQuoteMode: row.quoteMode,
            fromAmountKobo: existing.amountKobo,
            toAmountKobo: row.amountKobo,
            fromMinimumKobo: existing.minimumKobo,
            toMinimumKobo: row.minimumKobo,
          },
        });
        return toRule(row);
      });
    },

    async listAreas() {
      const rows = await prisma.serviceArea.findMany();
      return rows.flatMap((row) => {
        const area = toArea(row);
        return area === null ? [] : [area];
      });
    },

    async updateArea(place, box, actor) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          {
            place: string;
            minLatitude: number;
            maxLatitude: number;
            minLongitude: number;
            maxLongitude: number;
          }[]
        >`
          SELECT
            "place"::text AS "place",
            "min_latitude" AS "minLatitude",
            "max_latitude" AS "maxLatitude",
            "min_longitude" AS "minLongitude",
            "max_longitude" AS "maxLongitude"
          FROM "service_areas"
          FOR UPDATE
        `;
        const areas = rows.flatMap((row) => {
          const area = toArea(row);
          return area === null ? [] : [area];
        });
        if (!areas.some((area) => area.place === place)) return "missing";
        const next = areas.map((area) =>
          area.place === place ? { place, ...box } : area,
        );
        try {
          assertServiceAreaMap(next);
        } catch (error) {
          if (error instanceof PricingConfigurationError) return "invalid";
          throw error;
        }
        const previous = areas.find((area) => area.place === place);
        const row = await tx.serviceArea.update({
          where: { place },
          data: box,
        });
        const updated = toArea(row);
        if (updated === null || previous === undefined) {
          throw new PricingConfigurationError(
            "Updated area is not on the service map",
          );
        }
        await audit.record(tx, {
          actorId: actor.actorId,
          requestId: actor.requestId,
          action: "pricing.area.update",
          targetType: "service_area",
          targetId: place,
          metadata: {
            fromMinLatitude: previous.minLatitude,
            toMinLatitude: updated.minLatitude,
            fromMaxLatitude: previous.maxLatitude,
            toMaxLatitude: updated.maxLatitude,
            fromMinLongitude: previous.minLongitude,
            toMinLongitude: updated.minLongitude,
            fromMaxLongitude: previous.maxLongitude,
            toMaxLongitude: updated.maxLongitude,
          },
        });
        return updated;
      });
    },

    /**
     * Reads the price list and inserts the snapshot in one transaction, so
     * the stored total is the list at that moment and later edits miss it.
     * The idempotency result and, for Special Pickup, the collection stop are
     * inserted in that same transaction. A rollback removes all of them. A
     * unique violation means this key already committed, so the stored result
     * is returned.
     */
    async createPricedOrder({ customerId, request, claim, quoteFromRules }) {
      try {
        const order = await prisma.$transaction(async (tx) => {
          const rules = (await tx.priceRule.findMany()).map(toRule);
          const areas = (await tx.serviceArea.findMany()).flatMap((area) => {
            const mapped = toArea(area);
            return mapped === null ? [] : [mapped];
          });
          const quote = quoteFromRules(rules, areas);
          if (quote.pricingStatus === "pending_manual_quote") {
            assertPositiveKobo(quote.minimumTotalKobo, "quote floor");
          } else if (quote.minimumTotalKobo !== null) {
            throw new PricingConfigurationError(
              "Automatic quote includes a manual floor",
            );
          }
          const due = amountDue(quote.components);
          if (quote.totalKobo !== due) {
            throw new PricingConfigurationError(
              "Refusing to store a quote whose total does not match its components",
            );
          }
          const contact = storedCollection(request);
          const row = await tx.order.create({
            data: orderCreateData(customerId, request, quote),
          });
          if (contact !== null) {
            await tx.orderCollection.create({
              data: { orderId: row.id, ...contact },
            });
          }
          const created = toPricedOrder(row, contact);
          await saveIdempotentResult(tx, claim, 201, { data: created });
          return created;
        });
        return { outcome: "created" as const, order };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const saved = await readIdempotentResult(prisma, claim);
        if (saved.outcome === "fresh") throw error;
        return saved;
      }
    },

    async listOrders(page, serviceType) {
      const rows = await prisma.order.findMany({
        where: pageWhere(page, serviceType),
        include: { collection: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: page.limit + 1,
      });
      return slicePage(
        rows.map((row) => toOperationsOrder(row, row.collection)),
        page.limit,
      );
    },

    async getOrder(id) {
      const row = await prisma.order.findUnique({
        where: { id },
        include: { collection: true },
      });
      if (row === null) return null;
      return toOperationsOrder(row, row.collection);
    },

    /**
     * One conditional update returns the row that was written. A follow-up
     * read could observe a different total, or miss the row after the charge
     * was saved.
     */
    async applyManualQuote(id, amountKobo, actor) {
      assertPositiveKobo(amountKobo, "manual quote");
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ManualQuoteRow[]>`
          UPDATE "orders"
          SET
            "pricing_status" = 'manual_quoted',
            "total_kobo" = ${amountKobo},
            "quoted_by_id" = CAST(${actor.actorId} AS uuid),
            "quoted_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = CAST(${id} AS uuid)
            AND "pricing_status" = 'pending_manual_quote'
            AND "minimum_total_kobo" IS NOT NULL
            AND "minimum_total_kobo" <= ${amountKobo}
          RETURNING
            "id",
            "service_type" AS "serviceType",
            "pricing_status" AS "pricingStatus",
            "errand_tier" AS "errandTier",
            "errand_amount_kobo" AS "errandAmountKobo",
            "zone_tier" AS "zoneTier",
            "zone_amount_kobo" AS "zoneAmountKobo",
            "special_pickup_tier" AS "specialPickupTier",
            "special_pickup_amount_kobo" AS "specialPickupAmountKobo",
            "total_kobo" AS "totalKobo",
            "minimum_total_kobo" AS "minimumTotalKobo",
            "pickup_place"::text AS "pickupPlace",
            "destination_place"::text AS "destinationPlace",
            "collection_place"::text AS "collectionPlace",
            "collection_latitude" AS "collectionLatitude",
            "collection_longitude" AS "collectionLongitude"
        `;
        const written = rows[0];
        if (written !== undefined) {
          const contact = await tx.orderCollection.findUnique({
            where: { orderId: id },
          });
          await audit.record(tx, {
            actorId: actor.actorId,
            requestId: actor.requestId,
            action: "order.manual_quote",
            targetType: "order",
            targetId: id,
            metadata: { amountKobo },
          });
          return orderFromManualQuote(written, amountKobo, contact);
        }

        const existing = await tx.order.findUnique({
          where: { id },
          select: {
            id: true,
            pricingStatus: true,
            minimumTotalKobo: true,
          },
        });
        if (existing === null) return "missing";
        if (
          existing.pricingStatus === "pending_manual_quote" &&
          existing.minimumTotalKobo !== null &&
          amountKobo < existing.minimumTotalKobo
        ) {
          return { belowMinimum: existing.minimumTotalKobo };
        }
        if (
          existing.pricingStatus === "pending_manual_quote" &&
          existing.minimumTotalKobo === null
        ) {
          throw new PricingConfigurationError(
            "Pending quote is missing its floor",
          );
        }
        return "not_pending";
      });
    },
  };
}
