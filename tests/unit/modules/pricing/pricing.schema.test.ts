import { describe, expect, it } from 'vitest';
import { samplePoint } from '../../../../src/modules/pricing/pricing.areas.js';
import {
  createOrderBodySchema,
  manualQuoteBodySchema,
  quoteBodySchema,
  updateRuleBodySchema,
} from '#src/modules/pricing/pricing.schema.js';

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

const collectionStop = {
  ...samplePoint('lusada'),
  address: '  14 Market Road  ',
  contactName: '  Ada Okonkwo  ',
  contactPhone: '+2348011111111',
};

describe('special pickup order schema', () => {
  const special = {
    service: 'special_pickup',
    pickup: samplePoint('igbesa'),
    destination: samplePoint('igbesa'),
    collection: collectionStop,
  };

  it('requires a separate collection address and contact', () => {
    const parsed = createOrderBodySchema.safeParse(special);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      service: 'special_pickup',
      collection: {
        address: '14 Market Road',
        contactName: 'Ada Okonkwo',
        contactPhone: '+2348011111111',
      },
    });
  });

  it('rejects a coordinate with no contact', () => {
    expect(
      createOrderBodySchema.safeParse({
        ...special,
        collection: samplePoint('lusada'),
      }).success,
    ).toBe(false);
  });

  it('rejects a collection contact on a price preview', () => {
    expect(quoteBodySchema.safeParse(special).success).toBe(false);
    expect(
      quoteBodySchema.safeParse({
        ...special,
        collection: samplePoint('lusada'),
      }).success,
    ).toBe(true);
  });

  it('rejects a client fee on the collection', () => {
    expect(
      createOrderBodySchema.safeParse({
        ...special,
        collection: { ...collectionStop, amountKobo: 50000 },
      }).success,
    ).toBe(false);
  });

  it.each(['08012345678', '2348011111111', '+234'])(
    'rejects collection phone %s',
    (contactPhone) => {
      expect(
        createOrderBodySchema.safeParse({
          ...special,
          collection: { ...collectionStop, contactPhone },
        }).success,
      ).toBe(false);
    },
  );

  it('does not accept a collection on standard delivery or an errand', () => {
    expect(
      createOrderBodySchema.safeParse({ ...local, collection: collectionStop })
        .success,
    ).toBe(false);
    expect(
      createOrderBodySchema.safeParse({
        service: 'errand',
        errandTier: 'simple',
        collection: collectionStop,
      }).success,
    ).toBe(false);
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
