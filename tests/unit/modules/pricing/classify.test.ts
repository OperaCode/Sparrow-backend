import { describe, expect, it } from 'vitest';
import {
  classifySpecialPickup,
  classifyZone,
} from '../../../../src/modules/pricing/pricing.classify.js';
import type {
  Place,
  SpecialPickupTier,
  ZoneTier,
} from '../../../../src/modules/pricing/pricing.types.js';

const zonePairs: readonly (readonly [Place, Place, ZoneTier])[] = [
  ['igbesa', 'igbesa', 'A'],
  ['lusada', 'lusada', 'A'],
  ['ketu', 'ketu', 'A'],
  ['igbesa', 'lusada', 'B'],
  ['lusada', 'igbesa', 'B'],
  ['igbesa', 'ketu', 'C'],
  ['ketu', 'igbesa', 'C'],
  ['lusada', 'ketu', 'C'],
  ['ketu', 'lusada', 'C'],
  ['extended', 'igbesa', 'extended'],
  ['lusada', 'extended', 'extended'],
  ['ketu', 'extended', 'extended'],
  ['extended', 'extended', 'extended'],
  ['outside', 'igbesa', 'outside_area'],
  ['igbesa', 'outside', 'outside_area'],
  ['lusada', 'outside', 'outside_area'],
  ['ketu', 'outside', 'outside_area'],
  ['outside', 'outside', 'outside_area'],
  ['outside', 'extended', 'outside_area'],
  ['extended', 'outside', 'outside_area'],
];

const specialPairs: readonly (readonly [Place, Place, SpecialPickupTier])[] = [
  ['igbesa', 'igbesa', 'local'],
  ['lusada', 'lusada', 'local'],
  ['ketu', 'ketu', 'local'],
  ['igbesa', 'lusada', 'nearby'],
  ['lusada', 'igbesa', 'nearby'],
  ['igbesa', 'ketu', 'extended'],
  ['ketu', 'igbesa', 'extended'],
  ['lusada', 'ketu', 'extended'],
  ['ketu', 'lusada', 'extended'],
  ['igbesa', 'extended', 'extended'],
  ['extended', 'lusada', 'extended'],
  ['igbesa', 'outside', 'outside_area'],
  ['outside', 'ketu', 'outside_area'],
  ['outside', 'extended', 'outside_area'],
];

describe('zone classification', () => {
  it.each(zonePairs)('%s → %s is zone %s', (pickup, destination, tier) => {
    expect(classifyZone(pickup, destination)).toBe(tier);
  });
});

describe('special pickup classification', () => {
  it.each(specialPairs)(
    'collection %s → %s is %s',
    (pickup, collection, tier) => {
      expect(classifySpecialPickup(pickup, collection)).toBe(tier);
    },
  );
});
