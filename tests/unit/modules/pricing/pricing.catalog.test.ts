import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVED_SERVICE_AREAS } from '../../../../src/modules/pricing/pricing.areas.js';
import { APPROVED_PRICE_RULES } from '../../../../src/modules/pricing/pricing.catalog.js';
import {
  priceRuleSqlTuple,
  serviceAreaSqlTuple,
} from '../../../helpers/pricing.js';
import {
  ERRAND_TIERS,
  SPECIAL_PICKUP_TIERS,
  ZONE_TIERS,
  type PricingComponent,
} from '../../../../src/modules/pricing/pricing.types.js';

const approvedByTier = new Map(
  APPROVED_PRICE_RULES.map(
    (item) => [`${item.component}/${item.tier}`, item] as const,
  ),
);

function rule(component: PricingComponent, tier: string) {
  return approvedByTier.get(`${component}/${tier}`);
}

describe('approved V1 price list', () => {
  it('prices every standard, special pickup and errand tier once', () => {
    const expected = [
      ...ZONE_TIERS.map((tier) => `standard_zone/${tier}`),
      ...SPECIAL_PICKUP_TIERS.map((tier) => `special_pickup/${tier}`),
      ...ERRAND_TIERS.map((tier) => `errand/${tier}`),
    ];

    expect(approvedByTier.size).toBe(APPROVED_PRICE_RULES.length);
    expect([...approvedByTier.keys()].sort()).toEqual([...expected].sort());
  });

  it('matches the approved kobo amounts', () => {
    expect(rule('standard_zone', 'A')).toMatchObject({
      amountKobo: 80000,
      quoteMode: 'automatic',
    });
    expect(rule('standard_zone', 'B')).toMatchObject({
      amountKobo: 100000,
      quoteMode: 'automatic',
    });
    expect(rule('standard_zone', 'C')).toMatchObject({
      amountKobo: 130000,
      quoteMode: 'automatic',
    });
    expect(rule('standard_zone', 'extended')).toMatchObject({
      amountKobo: null,
      minimumKobo: 150000,
      quoteMode: 'manual',
    });
    expect(rule('standard_zone', 'outside_area')).toMatchObject({
      amountKobo: null,
      minimumKobo: 150000,
      quoteMode: 'manual',
    });
    expect(rule('special_pickup', 'local')).toMatchObject({
      amountKobo: 50000,
      quoteMode: 'automatic',
    });
    expect(rule('special_pickup', 'nearby')).toMatchObject({
      amountKobo: 70000,
      quoteMode: 'automatic',
    });
    expect(rule('special_pickup', 'extended')).toMatchObject({
      amountKobo: null,
      minimumKobo: 100000,
      quoteMode: 'manual',
    });
    expect(rule('special_pickup', 'outside_area')).toMatchObject({
      amountKobo: null,
      minimumKobo: 100000,
      quoteMode: 'manual',
    });
    expect(rule('errand', 'simple')).toMatchObject({
      amountKobo: 50000,
      quoteMode: 'automatic',
    });
    expect(rule('errand', 'moderate')).toMatchObject({
      amountKobo: 70000,
      quoteMode: 'automatic',
    });
    expect(rule('errand', 'complex')).toMatchObject({
      amountKobo: null,
      minimumKobo: 100000,
      quoteMode: 'manual',
    });
  });

  it('is inserted by a migration, so a fresh database has the rates', () => {
    const migrations = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readFileSync(
          path.join('prisma/migrations', entry.name, 'migration.sql'),
          'utf8',
        ),
      )
      .join('\n');

    for (const approved of APPROVED_PRICE_RULES) {
      expect(migrations).toContain(priceRuleSqlTuple(approved));
    }
    for (const area of APPROVED_SERVICE_AREAS) {
      expect(migrations).toContain(serviceAreaSqlTuple(area));
    }
  });
});
