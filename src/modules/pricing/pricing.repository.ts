import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { assertServiceAreaMap, isServiceAreaPlace } from './pricing.locate.js';
import {
  PricingConfigurationError,
  amountDue,
  assertPositiveKobo,
} from './pricing.money.js';
import type {
  AreaBox,
  Coordinate,
  ErrandTier,
  Place,
  PriceComponentQuote,
  PriceQuote,
  PriceRuleRecord,
  PricedOrder,
  PricingComponent,
  PricingStatus,
  QuoteRequest,
  RuleUpdate,
  ServiceArea,
  ServiceAreaPlace,
  SpecialPickupTier,
  ZoneTier,
} from './pricing.types.js';

type ServiceType = QuoteRequest['service'];

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
}

export type ManualQuoteWriteResult =
  PricedOrder | 'missing' | 'not_pending' | { belowMinimum: number };

export type AreaWriteResult = ServiceArea | 'missing' | 'invalid';

export interface CreatePricedOrderArgs {
  customerId: string;
  request: QuoteRequest;
  quoteFromRules: (
    rules: readonly PriceRuleRecord[],
    areas: readonly ServiceArea[],
  ) => PriceQuote;
}

export interface PricingRepository {
  listRules(): Promise<PriceRuleRecord[]>;
  updateRule(
    component: PricingComponent,
    tier: string,
    patch: RuleUpdate,
    actorId: string,
  ): Promise<PriceRuleRecord | null>;
  listAreas(): Promise<ServiceArea[]>;
  updateArea(place: ServiceAreaPlace, box: AreaBox): Promise<AreaWriteResult>;
  createPricedOrder(args: CreatePricedOrderArgs): Promise<PricedOrder>;
  findOrder(id: string): Promise<PricedOrder | null>;
  applyManualQuote(
    id: string,
    amountKobo: number,
    quotedById: string,
  ): Promise<ManualQuoteWriteResult>;
}

function toRule(row: {
  component: PriceRuleRecord['component'];
  tier: string;
  quoteMode: PriceRuleRecord['quoteMode'];
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

function toPricedOrder(row: SnapshotRow): PricedOrder {
  const components: PriceComponentQuote[] = [];
  if (row.errandTier !== null) {
    components.push({
      component: 'errand',
      tier: row.errandTier,
      quoteMode: row.errandAmountKobo === null ? 'manual' : 'automatic',
      amountKobo: row.errandAmountKobo,
    });
  }
  if (row.zoneTier !== null) {
    components.push({
      component: 'standard_zone',
      tier: row.zoneTier,
      quoteMode: row.zoneAmountKobo === null ? 'manual' : 'automatic',
      amountKobo: row.zoneAmountKobo,
    });
  }
  if (row.specialPickupTier !== null) {
    components.push({
      component: 'special_pickup',
      tier: row.specialPickupTier,
      quoteMode: row.specialPickupAmountKobo === null ? 'manual' : 'automatic',
      amountKobo: row.specialPickupAmountKobo,
    });
  }

  assertStoredTotal(row, components);

  return {
    id: row.id,
    serviceType: row.serviceType,
    pricingStatus: row.pricingStatus,
    currency: 'NGN',
    components,
    totalKobo: row.totalKobo,
    minimumTotalKobo: row.minimumTotalKobo,
    pickupPlace: row.pickupPlace,
    destinationPlace: row.destinationPlace,
    collectionPlace: row.collectionPlace,
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
  if (row.pricingStatus === 'manual_quoted') {
    const total = assertPositiveKobo(row.totalKobo, 'stored total');
    const floor = assertPositiveKobo(row.minimumTotalKobo, 'snapshotted floor');
    if (total < floor) {
      throw new PricingConfigurationError(
        'Stored total is below the snapshotted floor',
      );
    }
    return;
  }
  if (row.pricingStatus === 'pending_manual_quote') {
    assertPositiveKobo(row.minimumTotalKobo, 'snapshotted floor');
  } else if (row.minimumTotalKobo !== null) {
    throw new PricingConfigurationError('Automatic order has a manual floor');
  }
  if (row.totalKobo !== amountDue(components)) {
    throw new PricingConfigurationError(
      'Stored total does not match the snapshotted components',
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
}

function wholeKobo(value: number | string | bigint | null): number | null {
  if (value === null) return null;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new PricingConfigurationError(
      'Stored amount was not a whole number of kobo',
    );
  }
  return amount;
}

/** The RETURNING row is the charge. A mismatch rolls the update back. */
function orderFromManualQuote(
  row: ManualQuoteRow,
  amountKobo: number,
): PricedOrder {
  const totalKobo = wholeKobo(row.totalKobo);
  if (totalKobo !== amountKobo) {
    throw new PricingConfigurationError(
      'Manual quote was not stored as entered',
    );
  }
  return toPricedOrder({
    id: row.id,
    serviceType: row.serviceType as ServiceType,
    pricingStatus: 'manual_quoted',
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
  });
}

function coordinateOrNull(point: Coordinate | undefined): {
  latitude: number | null;
  longitude: number | null;
} {
  if (point === undefined) return { latitude: null, longitude: null };
  return { latitude: point.latitude, longitude: point.longitude };
}

function orderCreateData(
  customerId: string,
  request: QuoteRequest,
  quote: PriceQuote,
): Prisma.OrderCreateInput {
  const pickup = coordinateOrNull(
    'pickup' in request ? request.pickup : undefined,
  );
  const destination = coordinateOrNull(
    'destination' in request ? request.destination : undefined,
  );
  const collection = coordinateOrNull(
    request.service === 'special_pickup' ? request.collection : undefined,
  );
  const zone = quote.components.find(
    (component) => component.component === 'standard_zone',
  );
  const specialPickup = quote.components.find(
    (component) => component.component === 'special_pickup',
  );
  const errand = quote.components.find(
    (component) => component.component === 'errand',
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
    errandTier: request.service === 'errand' ? request.errandTier : null,
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
  async function findOrder(id: string): Promise<PricedOrder | null> {
    const row = await prisma.order.findUnique({ where: { id } });
    return row === null ? null : toPricedOrder(row);
  }

  return {
    async listRules() {
      const rows = await prisma.priceRule.findMany();
      return rows.map(toRule);
    },

    async updateRule(component, tier, patch, actorId) {
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
            actorId,
            oldQuoteMode: existing.quoteMode,
            oldAmountKobo: existing.amountKobo,
            oldMinimumKobo: existing.minimumKobo,
            newQuoteMode: patch.quoteMode,
            newAmountKobo: patch.amountKobo,
            newMinimumKobo: patch.minimumKobo,
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

    async updateArea(place, box) {
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
        if (!areas.some((area) => area.place === place)) return 'missing';
        const next = areas.map((area) =>
          area.place === place ? { place, ...box } : area,
        );
        try {
          assertServiceAreaMap(next);
        } catch (error) {
          if (error instanceof PricingConfigurationError) return 'invalid';
          throw error;
        }
        const row = await tx.serviceArea.update({
          where: { place },
          data: box,
        });
        const updated = toArea(row);
        if (updated === null) {
          throw new PricingConfigurationError(
            'Updated area is not on the service map',
          );
        }
        return updated;
      });
    },

    /**
     * Reads the price list and inserts the snapshot in one transaction, so
     * the stored total is the list at that moment and later edits miss it.
     * The response is built before commit: a throw after commit would leave
     * the order stored while the client saw a failure.
     */
    async createPricedOrder({ customerId, request, quoteFromRules }) {
      return prisma.$transaction(async (tx) => {
        const rules = (await tx.priceRule.findMany()).map(toRule);
        const areas = (await tx.serviceArea.findMany()).flatMap((area) => {
          const mapped = toArea(area);
          return mapped === null ? [] : [mapped];
        });
        const quote = quoteFromRules(rules, areas);
        if (quote.pricingStatus === 'pending_manual_quote') {
          assertPositiveKobo(quote.minimumTotalKobo, 'quote floor');
        } else if (quote.minimumTotalKobo !== null) {
          throw new PricingConfigurationError(
            'Automatic quote includes a manual floor',
          );
        }
        const due = amountDue(quote.components);
        if (quote.totalKobo !== due) {
          throw new PricingConfigurationError(
            'Refusing to store a quote whose total does not match its components',
          );
        }
        const row = await tx.order.create({
          data: orderCreateData(customerId, request, quote),
        });
        return toPricedOrder(row);
      });
    },

    findOrder,

    /**
     * One conditional update returns the row that was written. A follow-up
     * read could observe a different total, or miss the row after the charge
     * was saved.
     */
    async applyManualQuote(id, amountKobo, quotedById) {
      assertPositiveKobo(amountKobo, 'manual quote');
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ManualQuoteRow[]>`
          UPDATE "orders"
          SET
            "pricing_status" = 'manual_quoted',
            "total_kobo" = ${amountKobo},
            "quoted_by_id" = CAST(${quotedById} AS uuid),
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
            "collection_place"::text AS "collectionPlace"
        `;
        const written = rows[0];
        if (written !== undefined) {
          return orderFromManualQuote(written, amountKobo);
        }

        const existing = await tx.order.findUnique({
          where: { id },
          select: {
            id: true,
            pricingStatus: true,
            minimumTotalKobo: true,
          },
        });
        if (existing === null) return 'missing';
        if (
          existing.pricingStatus === 'pending_manual_quote' &&
          existing.minimumTotalKobo !== null &&
          amountKobo < existing.minimumTotalKobo
        ) {
          return { belowMinimum: existing.minimumTotalKobo };
        }
        if (
          existing.pricingStatus === 'pending_manual_quote' &&
          existing.minimumTotalKobo === null
        ) {
          throw new PricingConfigurationError(
            'Pending quote is missing its floor',
          );
        }
        return 'not_pending';
      });
    },
  };
}
