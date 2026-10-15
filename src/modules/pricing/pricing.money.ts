import {
  MAX_AMOUNT_NAIRA,
  PRICING_COMPONENTS,
  type PriceComponentQuote,
} from './pricing.types.js';

/** The price list or a stored snapshot cannot be charged safely. */
export class PricingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigurationError';
  }
}

const MAX_TOTAL_NAIRA = MAX_AMOUNT_NAIRA * PRICING_COMPONENTS.length;

export function isChargeableNaira(amount: number): boolean {
  return (
    Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_AMOUNT_NAIRA
  );
}

/**
 * A missing, fractional, negative, or huge figure is never treated as zero.
 * Zero would drop a leg from the bill.
 */
export function assertPositiveNaira(
  amount: number | null,
  label: string,
): number {
  if (amount === null || !isChargeableNaira(amount)) {
    throw new PricingConfigurationError(
      `${label} is not a chargeable amount in naira`,
    );
  }
  return amount;
}

function legAmount(component: PriceComponentQuote): number | null {
  const amount = component.amountNaira;
  const manualWithAmount = component.quoteMode === 'manual' && amount !== null;
  const automaticWithoutAmount =
    component.quoteMode === 'automatic' && amount === null;
  if (manualWithAmount || automaticWithoutAmount) {
    throw new PricingConfigurationError(
      `${component.component} amount does not match its quote mode`,
    );
  }
  if (component.quoteMode === 'manual') return null;
  return assertPositiveNaira(amount, component.component);
}

/**
 * Amount due for a quote. One entry per leg, so two prices for the same leg
 * cannot both be added. A manual leg makes the whole total null so an
 * automatic sibling cannot be billed on its own.
 */
export function amountDue(
  components: readonly PriceComponentQuote[],
): number | null {
  if (components.length === 0) {
    throw new PricingConfigurationError('A quote needs at least one component');
  }

  const byLeg = new Map(
    components.map(
      (component) => [component.component, legAmount(component)] as const,
    ),
  );
  if (byLeg.size !== components.length) {
    throw new PricingConfigurationError(
      'A quote has two amounts for the same leg',
    );
  }

  const amounts = [...byLeg.values()];
  const charges = amounts.flatMap((amount) =>
    amount === null ? [] : [amount],
  );
  if (charges.length !== amounts.length) return null;

  const total = charges.reduce((sum, amount) => sum + amount, 0);
  if (total > MAX_TOTAL_NAIRA) {
    throw new PricingConfigurationError('Quote total exceeds the charge limit');
  }
  return total;
}
