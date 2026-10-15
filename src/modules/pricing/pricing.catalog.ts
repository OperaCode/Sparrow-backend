import type { PriceRuleRecord } from './pricing.types.js';

/**
 * Approved V1 rates inserted by the pricing migration. Live quotes read
 * price_rules, not this list, so operations can change a rate without an
 * app release. Keep the migration seed in step with these rows.
 */
export const APPROVED_PRICE_RULES: readonly PriceRuleRecord[] = [
  {
    component: 'standard_zone',
    tier: 'A',
    amountNaira: 800,
    quoteMode: 'automatic',
  },
  {
    component: 'standard_zone',
    tier: 'B',
    amountNaira: 1000,
    quoteMode: 'automatic',
  },
  {
    component: 'standard_zone',
    tier: 'C',
    amountNaira: 1300,
    quoteMode: 'automatic',
  },
  {
    component: 'standard_zone',
    tier: 'extended',
    amountNaira: null,
    quoteMode: 'manual',
  },
  {
    component: 'standard_zone',
    tier: 'outside_area',
    amountNaira: null,
    quoteMode: 'manual',
  },
  {
    component: 'special_pickup',
    tier: 'local',
    amountNaira: 500,
    quoteMode: 'automatic',
  },
  {
    component: 'special_pickup',
    tier: 'nearby',
    amountNaira: 700,
    quoteMode: 'automatic',
  },
  {
    component: 'special_pickup',
    tier: 'extended',
    amountNaira: null,
    quoteMode: 'manual',
  },
  {
    component: 'special_pickup',
    tier: 'outside_area',
    amountNaira: null,
    quoteMode: 'manual',
  },
  {
    component: 'errand',
    tier: 'simple',
    amountNaira: 500,
    quoteMode: 'automatic',
  },
  {
    component: 'errand',
    tier: 'moderate',
    amountNaira: 700,
    quoteMode: 'automatic',
  },
  {
    component: 'errand',
    tier: 'complex',
    amountNaira: null,
    quoteMode: 'manual',
  },
];

export function priceRuleSqlTuple(rule: PriceRuleRecord): string {
  const amount = rule.amountNaira === null ? 'NULL' : String(rule.amountNaira);
  return `('${rule.component}', '${rule.tier}', ${amount}, '${rule.quoteMode}')`;
}
