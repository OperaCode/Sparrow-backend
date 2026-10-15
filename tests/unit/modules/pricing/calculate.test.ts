import { describe, expect, it } from 'vitest';
import { APPROVED_PRICE_RULES } from '../../../../src/modules/pricing/pricing.catalog.js';
import {
  InvalidQuoteInputError,
  PricingConfigurationError,
  calculatePrice,
} from '../../../../src/modules/pricing/pricing.calculate.js';
import { amountDue } from '../../../../src/modules/pricing/pricing.money.js';
import type {
  ErrandTier,
  Place,
  PriceRuleRecord,
  QuoteInput,
} from '../../../../src/modules/pricing/pricing.types.js';

const rules = APPROVED_PRICE_RULES;

function quote(input: QuoteInput) {
  return calculatePrice(input, rules);
}

const standardPairs: readonly (readonly [Place, Place, number])[] = [
  ['igbesa', 'igbesa', 800],
  ['lusada', 'lusada', 800],
  ['ketu', 'ketu', 800],
  ['igbesa', 'lusada', 1000],
  ['lusada', 'igbesa', 1000],
  ['igbesa', 'ketu', 1300],
  ['ketu', 'igbesa', 1300],
  ['lusada', 'ketu', 1300],
  ['ketu', 'lusada', 1300],
];

const manualZones: readonly Place[] = ['extended', 'outside'];

const deliveryZones: readonly { destination: Place; amount: number | null }[] =
  [
    { destination: 'igbesa', amount: 800 },
    { destination: 'lusada', amount: 1000 },
    { destination: 'ketu', amount: 1300 },
    { destination: 'extended', amount: null },
    { destination: 'outside', amount: null },
  ];

const collections: readonly { collection: Place; amount: number | null }[] = [
  { collection: 'igbesa', amount: 500 },
  { collection: 'lusada', amount: 700 },
  { collection: 'ketu', amount: null },
  { collection: 'extended', amount: null },
  { collection: 'outside', amount: null },
];

const errandTiers: readonly { tier: ErrandTier; amount: number | null }[] = [
  { tier: 'simple', amount: 500 },
  { tier: 'moderate', amount: 700 },
  { tier: 'complex', amount: null },
];

describe('standard delivery pricing', () => {
  it.each(standardPairs)('%s → %s is ₦%i', (pickup, destination, total) => {
    const result = quote({ service: 'standard', pickup, destination });
    expect(result).toMatchObject({
      pricingStatus: 'auto',
      currency: 'NGN',
      totalNaira: total,
      components: [
        {
          component: 'standard_zone',
          amountNaira: total,
          quoteMode: 'automatic',
        },
      ],
    });
  });

  it.each(manualZones)('%s is a manual quote with no amount due', (place) => {
    const result = quote({
      service: 'standard',
      pickup: 'igbesa',
      destination: place,
    });
    expect(result.pricingStatus).toBe('pending_manual_quote');
    expect(result.totalNaira).toBeNull();
    expect(result.components[0]).toMatchObject({
      quoteMode: 'manual',
      amountNaira: null,
    });
  });
});

describe('special pickup pricing', () => {
  const cases = deliveryZones.flatMap((zone) =>
    collections.map((collection) => ({
      destination: zone.destination,
      zoneAmount: zone.amount,
      collection: collection.collection,
      feeAmount: collection.amount,
    })),
  );

  it.each(cases)(
    'igbesa → $destination plus collection $collection',
    ({ destination, collection, zoneAmount, feeAmount }) => {
      const result = quote({
        service: 'special_pickup',
        pickup: 'igbesa',
        destination,
        collection,
      });
      const total =
        zoneAmount === null || feeAmount === null
          ? null
          : zoneAmount + feeAmount;

      expect(result.totalNaira).toBe(total);
      expect(result.pricingStatus).toBe(
        total === null ? 'pending_manual_quote' : 'auto',
      );
      expect(result.components).toEqual([
        expect.objectContaining({
          component: 'standard_zone',
          amountNaira: zoneAmount,
        }),
        expect.objectContaining({
          component: 'special_pickup',
          amountNaira: feeAmount,
        }),
      ]);
    },
  );
});

describe('errand pricing', () => {
  it.each(errandTiers)('task $tier with no delivery', ({ tier, amount }) => {
    const result = quote({ service: 'errand', errandTier: tier });
    expect(result.totalNaira).toBe(amount);
    expect(result.components).toEqual([
      expect.objectContaining({
        component: 'errand',
        tier,
        amountNaira: amount,
      }),
    ]);
  });

  const withDelivery = errandTiers.flatMap((errand) =>
    deliveryZones.map((zone) => ({
      tier: errand.tier,
      taskAmount: errand.amount,
      destination: zone.destination,
      zoneAmount: zone.amount,
    })),
  );

  it.each(withDelivery)(
    'task $tier plus delivery to $destination',
    ({ tier, taskAmount, destination, zoneAmount }) => {
      const result = quote({
        service: 'errand',
        errandTier: tier,
        pickup: 'igbesa',
        destination,
      });
      const total =
        taskAmount === null || zoneAmount === null
          ? null
          : taskAmount + zoneAmount;

      expect(result.pricingStatus).toBe(
        total === null ? 'pending_manual_quote' : 'auto',
      );
      expect(result.totalNaira).toBe(total);
      expect(result.components).toEqual([
        expect.objectContaining({
          component: 'errand',
          amountNaira: taskAmount,
        }),
        expect.objectContaining({
          component: 'standard_zone',
          amountNaira: zoneAmount,
        }),
      ]);
    },
  );

  it('rejects an errand delivery that has only one end', () => {
    expect(() =>
      quote({
        service: 'errand',
        errandTier: 'simple',
        pickup: 'igbesa',
      }),
    ).toThrow(InvalidQuoteInputError);
  });
});

describe('price list authority', () => {
  it('uses the supplied list instead of a built-in amount', () => {
    const custom: PriceRuleRecord[] = rules.map((rule) =>
      rule.component === 'standard_zone' && rule.tier === 'A'
        ? { ...rule, amountNaira: 1234 }
        : rule,
    );

    expect(
      calculatePrice(
        { service: 'standard', pickup: 'ketu', destination: 'ketu' },
        custom,
      ).totalNaira,
    ).toBe(1234);
  });

  it('fails closed when the list has two amounts for one tier', () => {
    const zoneA = rules.find(
      (rule) => rule.component === 'standard_zone' && rule.tier === 'A',
    );
    if (zoneA === undefined) {
      throw new Error('Approved list is missing zone A');
    }

    expect(() =>
      calculatePrice({ service: 'errand', errandTier: 'simple' }, [
        ...rules,
        { ...zoneA, amountNaira: 1 },
      ]),
    ).toThrow(PricingConfigurationError);
  });

  it('fails closed when a tier is missing', () => {
    expect(() =>
      calculatePrice(
        { service: 'standard', pickup: 'igbesa', destination: 'igbesa' },
        [],
      ),
    ).toThrow(PricingConfigurationError);
  });

  it('fails closed when an automatic tier has no amount', () => {
    const broken = rules.map((rule) =>
      rule.component === 'standard_zone' && rule.tier === 'A'
        ? { ...rule, amountNaira: null }
        : rule,
    );
    expect(() =>
      calculatePrice(
        { service: 'standard', pickup: 'igbesa', destination: 'igbesa' },
        broken,
      ),
    ).toThrow(PricingConfigurationError);
  });

  it('fails closed when a manual tier still has an amount', () => {
    const broken = rules.map((rule) =>
      rule.component === 'errand' && rule.tier === 'complex'
        ? { ...rule, amountNaira: 1000 }
        : rule,
    );
    expect(() =>
      calculatePrice({ service: 'errand', errandTier: 'complex' }, broken),
    ).toThrow(PricingConfigurationError);
  });

  it('does not turn a negative or fractional rate into a charge', () => {
    for (const amountNaira of [-800, 800.5]) {
      const broken = rules.map((rule) =>
        rule.component === 'standard_zone' && rule.tier === 'A'
          ? { ...rule, amountNaira }
          : rule,
      );
      expect(() =>
        calculatePrice(
          { service: 'standard', pickup: 'igbesa', destination: 'igbesa' },
          broken,
        ),
      ).toThrow(PricingConfigurationError);
    }
  });

  it('does not add two amounts for the same leg', () => {
    expect(() =>
      amountDue([
        {
          component: 'standard_zone',
          tier: 'A',
          quoteMode: 'automatic',
          amountNaira: 800,
        },
        {
          component: 'standard_zone',
          tier: 'B',
          quoteMode: 'automatic',
          amountNaira: 1000,
        },
      ]),
    ).toThrow(PricingConfigurationError);
  });

  it('does not bill an automatic leg while another leg is still unquoted', () => {
    const result = quote({
      service: 'special_pickup',
      pickup: 'igbesa',
      destination: 'igbesa',
      collection: 'ketu',
    });

    expect(result.components[0]).toMatchObject({ amountNaira: 800 });
    expect(result.totalNaira).toBeNull();
  });
});
