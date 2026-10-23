import { describe, expect, it } from 'vitest';
import {
  APPROVED_SERVICE_AREAS,
  OUTSIDE_CORRIDOR_POINT,
  samplePoint,
} from '../../../../src/modules/pricing/pricing.areas.js';
import { PricingConfigurationError } from '../../../../src/modules/pricing/pricing.money.js';
import { resolvePlace } from '../../../../src/modules/pricing/pricing.locate.js';
import { SERVICE_AREA_PLACES } from '../../../../src/modules/pricing/pricing.types.js';

describe('service area classification', () => {
  it.each(SERVICE_AREA_PLACES)(
    '%s sample point stays in that area',
    (place) => {
      expect(resolvePlace(samplePoint(place), APPROVED_SERVICE_AREAS)).toBe(
        place,
      );
    },
  );

  it('treats ground outside the axis as outside the service area', () => {
    expect(resolvePlace(OUTSIDE_CORRIDOR_POINT, APPROVED_SERVICE_AREAS)).toBe(
      'outside',
    );
  });

  it('keeps a town inside the Agbara envelope on the town fare', () => {
    expect(resolvePlace(samplePoint('igbesa'), APPROVED_SERVICE_AREAS)).toBe(
      'igbesa',
    );
  });

  it('fails closed when two towns cover the same ground', () => {
    const overlapping = APPROVED_SERVICE_AREAS.map((area) =>
      area.place === 'lusada' ? { ...area, ...sampleBoxOverIgbesa() } : area,
    );
    expect(() => resolvePlace(samplePoint('igbesa'), overlapping)).toThrow(
      PricingConfigurationError,
    );
  });
});

function sampleBoxOverIgbesa() {
  return {
    minLatitude: 6.515,
    maxLatitude: 6.555,
    minLongitude: 3.11,
    maxLongitude: 3.165,
  };
}
