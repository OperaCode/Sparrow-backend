import { describe, expect, it } from 'vitest';
import { samplePoint } from '../../../../src/modules/pricing/pricing.areas.js';
import {
  manualQuoteBodySchema,
  quoteBodySchema,
  updateRuleBodySchema,
} from '../../../../src/modules/pricing/pricing.schema.js';

const local = {
  service: 'standard',
  pickup: samplePoint('igbesa'),
  destination: samplePoint('igbesa'),
};

describe('quote request schema', () => {
  it.each([
    'totalKobo',
    'price',
    'amountKobo',
    'customerId',
    'pricingStatus',
    'zoneTier',
    'zone',
  ])('rejects a client-supplied %s', (field) => {
    const parsed = quoteBodySchema.safeParse({ ...local, [field]: 1 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an errand delivery with only one end', () => {
    const parsed = quoteBodySchema.safeParse({
      service: 'errand',
      errandTier: 'simple',
      pickup: samplePoint('igbesa'),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a community name in place of a coordinate', () => {
    expect(
      quoteBodySchema.safeParse({
        service: 'standard',
        pickup: 'igbesa',
        destination: 'igbesa',
      }).success,
    ).toBe(false);
    expect(
      quoteBodySchema.safeParse({
        service: 'standard',
        pickup: { ...samplePoint('igbesa'), place: 'igbesa' },
        destination: samplePoint('ketu'),
      }).success,
    ).toBe(false);
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
        pickup: samplePoint('igbesa'),
        destination: samplePoint('lusada'),
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
        amountKobo: 150000,
      }).success,
    ).toBe(false);
  });

  it('requires a minimum when switching to manual', () => {
    expect(
      updateRuleBodySchema.safeParse({ quoteMode: 'manual' }).success,
    ).toBe(false);
  });

  it('clears the amount and keeps the floor when switching to manual', () => {
    const parsed = updateRuleBodySchema.safeParse({
      quoteMode: 'manual',
      minimumKobo: 150000,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        quoteMode: 'manual',
        amountKobo: null,
        minimumKobo: 150000,
      });
    }
  });

  it('rejects a floor on an automatic price', () => {
    expect(
      updateRuleBodySchema.safeParse({
        quoteMode: 'automatic',
        amountKobo: 90000,
        minimumKobo: 80000,
      }).success,
    ).toBe(false);
  });
});

describe('manual quote schema', () => {
  it.each([0, -1, 1.5, 100_000_001])('rejects %s', (amountKobo) => {
    expect(manualQuoteBodySchema.safeParse({ amountKobo }).success).toBe(false);
  });

  it('rejects a client attempt to name the component prices', () => {
    expect(
      manualQuoteBodySchema.safeParse({
        amountKobo: 180000,
        zoneAmountKobo: 1,
      }).success,
    ).toBe(false);
  });
});
