import type { PrismaClient } from '../../src/lib/prisma.js';
import { APPROVED_SERVICE_AREAS } from '../../src/modules/pricing/pricing.areas.js';
import { APPROVED_PRICE_RULES } from '../../src/modules/pricing/pricing.catalog.js';
import type {
  PriceRuleRecord,
  ServiceArea,
} from '../../src/modules/pricing/pricing.types.js';

/** One VALUES tuple, matching the pricing migration seed. */
export function priceRuleSqlTuple(rule: PriceRuleRecord): string {
  const amount = rule.amountKobo === null ? 'NULL' : String(rule.amountKobo);
  const minimum = rule.minimumKobo === null ? 'NULL' : String(rule.minimumKobo);
  return `('${rule.component}', '${rule.tier}', ${amount}, ${minimum}, '${rule.quoteMode}')`;
}

/** One VALUES tuple, matching the service-area seed. */
export function serviceAreaSqlTuple(area: ServiceArea): string {
  return `('${area.place}', ${area.minLatitude}, ${area.maxLatitude}, ${area.minLongitude}, ${area.maxLongitude})`;
}

export async function seedApprovedPrices(prisma: PrismaClient): Promise<void> {
  await prisma.priceRule.createMany({
    data: APPROVED_PRICE_RULES.map((rule) => ({ ...rule })),
  });
}

export async function seedApprovedAreas(prisma: PrismaClient): Promise<void> {
  await prisma.serviceArea.createMany({
    data: APPROVED_SERVICE_AREAS.map((area) => ({ ...area })),
  });
}
