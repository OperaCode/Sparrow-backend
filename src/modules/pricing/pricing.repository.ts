import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../lib/prisma.js';
import {
  PricingConfigurationError,
  amountDue,
  assertPositiveNaira,
} from './pricing.money.js';
import { APPROVED_PRICE_RULES } from './pricing.catalog.js';
import type {
  ErrandTier,
  Place,
  PriceComponentQuote,
  PriceQuote,
  PriceRuleRecord,
  PricedOrder,
  PricingComponent,
  PricingStatus,
  QuoteInput,
  RuleUpdate,
  SpecialPickupTier,
  ZoneTier,
} from './pricing.types.js';

type ServiceType = QuoteInput['service'];

interface SnapshotRow {
  id: string;
  serviceType: ServiceType;
  pricingStatus: PricingStatus;
  errandTier: ErrandTier | null;
  errandAmountNaira: number | null;
  zoneTier: ZoneTier | null;
  zoneAmountNaira: number | null;
  specialPickupTier: SpecialPickupTier | null;
  specialPickupAmountNaira: number | null;
  totalNaira: number | null;
}

export type ManualQuoteWriteResult = PricedOrder | 'missing' | 'not_pending';

export interface CreatePricedOrderArgs {
  customerId: string;
  input: QuoteInput;
  quoteFromRules: (rules: readonly PriceRuleRecord[]) => PriceQuote;
}

export interface PricingRepository {
  listRules(): Promise<PriceRuleRecord[]>;
  updateRule(
    component: PricingComponent,
    tier: string,
    patch: RuleUpdate,
  ): Promise<PriceRuleRecord | null>;
  createPricedOrder(args: CreatePricedOrderArgs): Promise<PricedOrder>;
  findOrder(id: string): Promise<PricedOrder | null>;
  applyManualQuote(
    id: string,
    amountNaira: number,
    quotedById: string,
  ): Promise<ManualQuoteWriteResult>;
}

function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  );
}

function toRule(row: {
  component: PriceRuleRecord['component'];
  tier: string;
  quoteMode: PriceRuleRecord['quoteMode'];
  amountNaira: number | null;
}): PriceRuleRecord {
  return {
    component: row.component,
    tier: row.tier,
    quoteMode: row.quoteMode,
    amountNaira: row.amountNaira,
  };
}

function toPricedOrder(row: SnapshotRow): PricedOrder {
  const components: PriceComponentQuote[] = [];
  if (row.errandTier !== null) {
    components.push({
      component: 'errand',
      tier: row.errandTier,
      quoteMode: row.errandAmountNaira === null ? 'manual' : 'automatic',
      amountNaira: row.errandAmountNaira,
    });
  }
  if (row.zoneTier !== null) {
    components.push({
      component: 'standard_zone',
      tier: row.zoneTier,
      quoteMode: row.zoneAmountNaira === null ? 'manual' : 'automatic',
      amountNaira: row.zoneAmountNaira,
    });
  }
  if (row.specialPickupTier !== null) {
    components.push({
      component: 'special_pickup',
      tier: row.specialPickupTier,
      quoteMode: row.specialPickupAmountNaira === null ? 'manual' : 'automatic',
      amountNaira: row.specialPickupAmountNaira,
    });
  }

  assertStoredTotal(row, components);

  return {
    id: row.id,
    serviceType: row.serviceType,
    pricingStatus: row.pricingStatus,
    currency: 'NGN',
    components,
    totalNaira: row.totalNaira,
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
    assertPositiveNaira(row.totalNaira, 'stored total');
    return;
  }
  if (row.totalNaira !== amountDue(components)) {
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
  errandAmountNaira: number | string | bigint | null;
  zoneTier: string | null;
  zoneAmountNaira: number | string | bigint | null;
  specialPickupTier: string | null;
  specialPickupAmountNaira: number | string | bigint | null;
  totalNaira: number | string | bigint | null;
}

function wholeNaira(value: number | string | bigint | null): number | null {
  if (value === null) return null;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new PricingConfigurationError(
      'Stored amount was not a whole number of naira',
    );
  }
  return amount;
}

/** The RETURNING row is the charge. A mismatch rolls the update back. */
function orderFromManualQuote(
  row: ManualQuoteRow,
  amountNaira: number,
): PricedOrder {
  const totalNaira = wholeNaira(row.totalNaira);
  if (totalNaira !== amountNaira) {
    throw new PricingConfigurationError(
      'Manual quote was not stored as entered',
    );
  }
  return toPricedOrder({
    id: row.id,
    serviceType: row.serviceType as ServiceType,
    pricingStatus: 'manual_quoted',
    errandTier: row.errandTier as ErrandTier | null,
    errandAmountNaira: wholeNaira(row.errandAmountNaira),
    zoneTier: row.zoneTier as ZoneTier | null,
    zoneAmountNaira: wholeNaira(row.zoneAmountNaira),
    specialPickupTier: row.specialPickupTier as SpecialPickupTier | null,
    specialPickupAmountNaira: wholeNaira(row.specialPickupAmountNaira),
    totalNaira,
  });
}

function placeOrNull(place: Place | undefined): Place | null {
  return place ?? null;
}

function orderCreateData(
  customerId: string,
  input: QuoteInput,
  quote: PriceQuote,
): Prisma.OrderCreateInput {
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
    serviceType: input.service,
    pickupPlace: placeOrNull('pickup' in input ? input.pickup : undefined),
    destinationPlace: placeOrNull(
      'destination' in input ? input.destination : undefined,
    ),
    collectionPlace:
      input.service === 'special_pickup' ? input.collection : null,
    errandTier: input.service === 'errand' ? input.errandTier : null,
    pricingStatus: quote.pricingStatus,
    zoneTier: zone?.tier ?? null,
    zoneAmountNaira: zone?.amountNaira ?? null,
    specialPickupTier: specialPickup?.tier ?? null,
    specialPickupAmountNaira: specialPickup?.amountNaira ?? null,
    errandAmountNaira: errand?.amountNaira ?? null,
    totalNaira: quote.totalNaira,
  };
}

export async function seedApprovedPrices(prisma: PrismaClient): Promise<void> {
  await prisma.priceRule.createMany({ data: [...APPROVED_PRICE_RULES] });
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

    async updateRule(component, tier, patch) {
      try {
        const row = await prisma.priceRule.update({
          where: { component_tier: { component, tier } },
          data: {
            quoteMode: patch.quoteMode,
            amountNaira: patch.amountNaira,
          },
        });
        return toRule(row);
      } catch (error) {
        if (isRecordNotFound(error)) return null;
        throw error;
      }
    },

    /**
     * Reads the price list and inserts the snapshot in one transaction, so
     * the stored total is the list at that moment and later edits miss it.
     */
    async createPricedOrder({ customerId, input, quoteFromRules }) {
      const row = await prisma.$transaction(async (tx) => {
        const rules = (await tx.priceRule.findMany()).map(toRule);
        const quote = quoteFromRules(rules);
        const due = amountDue(quote.components);
        if (quote.totalNaira !== due) {
          throw new PricingConfigurationError(
            'Refusing to store a quote whose total does not match its components',
          );
        }
        return tx.order.create({
          data: orderCreateData(customerId, input, quote),
        });
      });
      return toPricedOrder(row);
    },

    findOrder,

    /**
     * One conditional update returns the row that was written. A follow-up
     * read could observe a different total, or miss the row after the charge
     * was saved.
     */
    async applyManualQuote(id, amountNaira, quotedById) {
      assertPositiveNaira(amountNaira, 'manual quote');
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ManualQuoteRow[]>`
          UPDATE "orders"
          SET
            "pricing_status" = 'manual_quoted',
            "total_naira" = ${amountNaira},
            "quoted_by_id" = CAST(${quotedById} AS uuid),
            "quoted_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = CAST(${id} AS uuid)
            AND "pricing_status" = 'pending_manual_quote'
          RETURNING
            "id",
            "service_type" AS "serviceType",
            "pricing_status" AS "pricingStatus",
            "errand_tier" AS "errandTier",
            "errand_amount_naira" AS "errandAmountNaira",
            "zone_tier" AS "zoneTier",
            "zone_amount_naira" AS "zoneAmountNaira",
            "special_pickup_tier" AS "specialPickupTier",
            "special_pickup_amount_naira" AS "specialPickupAmountNaira",
            "total_naira" AS "totalNaira"
        `;
        const written = rows[0];
        if (written !== undefined) {
          return orderFromManualQuote(written, amountNaira);
        }

        const existing = await tx.order.findUnique({
          where: { id },
          select: { id: true },
        });
        return existing === null ? 'missing' : 'not_pending';
      });
    },
  };
}
