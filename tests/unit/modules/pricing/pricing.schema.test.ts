import { describe, expect, it } from 'vitest';
import {
  manualQuoteBodySchema,
  quoteBodySchema,
  updateRuleBodySchema,
} from '../../../../src/modules/pricing/pricing.schema.js';

const local = {
  service: 'standard',
  pickup: 'igbesa',
  destination: 'igbesa',
};

describe('quote request schema', () => {
  it.each([
    'totalNaira',
    'price',
    'amountNaira',
    'customerId',
    'pricingStatus',
  ])('rejects a client-supplied %s', (field) => {
    const parsed = quoteBodySchema.safeParse({ ...local, [field]: 1 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an errand delivery with only one end', () => {
    const parsed = quoteBodySchema.safeParse({
      service: 'errand',
      errandTier: 'simple',
      pickup: 'igbesa',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an errand with no delivery and one with both ends', () => {
    expect(
      quoteBodySchema.safeParse({ service: 'errand', errandTier: 'moderate' })
        .success,
    ).toBe(true);
    expect(
      quoteBodySchema.safeParse({
        service: 'errand',
        errandTier: 'simple',
        pickup: 'igbesa',
        destination: 'lusada',
      }).success,
    ).toBe(true);
  });
});

describe('price rule update schema', () => {
  it('requires an amount when the tier becomes automatic', () => {
    expect(
      updateRuleBodySchema.safeParse({ quoteMode: 'automatic' }).success,
    ).toBe(false);
  });

  it('rejects an amount on a manual tier', () => {
    expect(
      updateRuleBodySchema.safeParse({
        quoteMode: 'manual',
        amountNaira: 1500,
      }).success,
    ).toBe(false);
  });

  it('clears the amount when switching to manual', () => {
    const parsed = updateRuleBodySchema.safeParse({ quoteMode: 'manual' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ quoteMode: 'manual', amountNaira: null });
    }
  });
});

describe('manual quote schema', () => {
  it.each([0, -1, 1.5, 1_000_001])('rejects %s', (amountNaira) => {
    expect(manualQuoteBodySchema.safeParse({ amountNaira }).success).toBe(
      false,
    );
  });

  it('rejects a client attempt to name the component prices', () => {
    expect(
      manualQuoteBodySchema.safeParse({
        amountNaira: 1800,
        zoneAmountNaira: 1,
      }).success,
    ).toBe(false);
  });
});
