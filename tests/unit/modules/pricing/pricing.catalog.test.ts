import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_PRICE_RULES,
  priceRuleSqlTuple,
} from '#src/modules/pricing/pricing.catalog.js';
import {
  ERRAND_TIERS,
  SPECIAL_PICKUP_TIERS,
  ZONE_TIERS,
  type PricingComponent,
} from '#src/modules/pricing/pricing.types.js';

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

  it('matches the approved naira amounts', () => {
    expect(rule('standard_zone', 'A')).toMatchObject({
      amountNaira: 800,
      quoteMode: 'automatic',
    });
    expect(rule('standard_zone', 'B')).toMatchObject({
      amountNaira: 1000,
      quoteMode: 'automatic',
    });
    expect(rule('standard_zone', 'C')).toMatchObject({
      amountNaira: 1300,
      quoteMode: 'automatic',
    });
    expect(rule('standard_zone', 'extended')).toMatchObject({
      amountNaira: null,
      quoteMode: 'manual',
    });
    expect(rule('standard_zone', 'outside_area')).toMatchObject({
      amountNaira: null,
      quoteMode: 'manual',
    });
    expect(rule('special_pickup', 'local')).toMatchObject({
      amountNaira: 500,
      quoteMode: 'automatic',
    });
    expect(rule('special_pickup', 'nearby')).toMatchObject({
      amountNaira: 700,
      quoteMode: 'automatic',
    });
    expect(rule('special_pickup', 'extended')).toMatchObject({
      amountNaira: null,
      quoteMode: 'manual',
    });
    expect(rule('errand', 'simple')).toMatchObject({
      amountNaira: 500,
      quoteMode: 'automatic',
    });
    expect(rule('errand', 'moderate')).toMatchObject({
      amountNaira: 700,
      quoteMode: 'automatic',
    });
    expect(rule('errand', 'complex')).toMatchObject({
      amountNaira: null,
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
  });
});
