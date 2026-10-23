import type { PriceRuleRecord } from './pricing.types.js';

/**
 * Approved V1 rates in kobo (100 kobo = ₦1). Live quotes read price_rules,
 * not this list, so operations can change a rate without an app release.
 * Manual tiers have no charge and a floor: extended delivery 150_000
 * (₦1,500), extended pickup and complex errands 100_000 (₦1,000). Outside
 * the service area has no published price; its floor is the extended floor,
 * so a quote cannot undercut that band. The pricing migration seed matches
 * these rows.
 */
export const APPROVED_PRICE_RULES: readonly PriceRuleRecord[] = [
  {
    component: 'standard_zone',
    tier: 'A',
    amountKobo: 80_000,
    minimumKobo: null,
    quoteMode: 'automatic',
  },
  {
    component: 'standard_zone',
    tier: 'B',
    amountKobo: 100_000,
    minimumKobo: null,
    quoteMode: 'automatic',
  },
  {
    component: 'standard_zone',
    tier: 'C',
    amountKobo: 130_000,
    minimumKobo: null,
    quoteMode: 'automatic',
  },
  {
    component: 'standard_zone',
    tier: 'extended',
    amountKobo: null,
    minimumKobo: 150_000,
    quoteMode: 'manual',
  },
  {
    component: 'standard_zone',
    tier: 'outside_area',
    amountKobo: null,
    minimumKobo: 150_000,
    quoteMode: 'manual',
  },
  {
    component: 'special_pickup',
    tier: 'local',
    amountKobo: 50_000,
    minimumKobo: null,
    quoteMode: 'automatic',
  },
  {
    component: 'special_pickup',
    tier: 'nearby',
    amountKobo: 70_000,
    minimumKobo: null,
    quoteMode: 'automatic',
  },
  {
    component: 'special_pickup',
    tier: 'extended',
    amountKobo: null,
    minimumKobo: 100_000,
    quoteMode: 'manual',
  },
  {
    component: 'special_pickup',
    tier: 'outside_area',
    amountKobo: null,
    minimumKobo: 100_000,
    quoteMode: 'manual',
  },
  {
    component: 'errand',
    tier: 'simple',
    amountKobo: 50_000,
    minimumKobo: null,
    quoteMode: 'automatic',
  },
  {
    component: 'errand',
    tier: 'moderate',
    amountKobo: 70_000,
    minimumKobo: null,
    quoteMode: 'automatic',
  },
  {
    component: 'errand',
    tier: 'complex',
    amountKobo: null,
    minimumKobo: 100_000,
    quoteMode: 'manual',
  },
];
