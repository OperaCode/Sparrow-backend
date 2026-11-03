import { InvalidQuoteInputError } from './pricing.calculate.js';
import { PricingConfigurationError } from './pricing.money.js';
import {
  SERVICE_AREA_PLACES,
  type Coordinate,
  type Place,
  type QuoteInput,
  type QuoteRequest,
  type ServiceArea,
  type ServiceAreaPlace,
} from './pricing.types.js';

const serviceAreaPlaces: ReadonlySet<string> = new Set(SERVICE_AREA_PLACES);

export function isServiceAreaPlace(place: string): place is ServiceAreaPlace {
  return serviceAreaPlaces.has(place);
}

function boxesOverlap(left: ServiceArea, right: ServiceArea): boolean {
  const latitudes =
    left.minLatitude <= right.maxLatitude &&
    right.minLatitude <= left.maxLatitude;
  const longitudes =
    left.minLongitude <= right.maxLongitude &&
    right.minLongitude <= left.maxLongitude;
  return latitudes && longitudes;
}

function assertBox(area: ServiceArea): void {
  const latitudes = [area.minLatitude, area.maxLatitude];
  const longitudes = [area.minLongitude, area.maxLongitude];
  const latitudesBroken = latitudes.some(
    (value) => !Number.isFinite(value) || value < -90 || value > 90,
  );
  const longitudesBroken = longitudes.some(
    (value) => !Number.isFinite(value) || value < -180 || value > 180,
  );
  if (
    latitudesBroken ||
    longitudesBroken ||
    area.minLatitude >= area.maxLatitude ||
    area.minLongitude >= area.maxLongitude
  ) {
    throw new PricingConfigurationError(
      `${area.place} is not a usable service area`,
    );
  }
}

/**
 * A broken map must not be used to pick a town. Missing ground, an inverted
 * box, or two towns covering the same point all fail closed.
 */
export function assertServiceAreaMap(areas: readonly ServiceArea[]): void {
  const byPlace = new Map(areas.map((area) => [area.place, area] as const));
  if (byPlace.size !== areas.length) {
    throw new PricingConfigurationError(
      'The service map lists one place twice',
    );
  }

  const resolved = SERVICE_AREA_PLACES.map((place) => {
    const area = byPlace.get(place);
    if (area === undefined) {
      throw new PricingConfigurationError(
        `The service map is missing ${place}`,
      );
    }
    assertBox(area);
    return area;
  });
  if (byPlace.size !== SERVICE_AREA_PLACES.length) {
    throw new PricingConfigurationError('The service map has an unknown area');
  }

  const communities = resolved.filter((area) => area.place !== 'extended');
  const overlap = pairs(communities).find(([left, right]) =>
    boxesOverlap(left, right),
  );
  if (overlap !== undefined) {
    throw new PricingConfigurationError(
      'Two community areas contain the same ground',
    );
  }
}

function pairs(
  areas: readonly ServiceArea[],
): readonly (readonly [ServiceArea, ServiceArea])[] {
  return areas.flatMap((left, index) =>
    areas.slice(index + 1).map((right) => [left, right] as const),
  );
}

function contains(area: ServiceArea, point: Coordinate): boolean {
  return (
    point.latitude >= area.minLatitude &&
    point.latitude <= area.maxLatitude &&
    point.longitude >= area.minLongitude &&
    point.longitude <= area.maxLongitude
  );
}

/**
 * Towns win over the Agbara envelope, so a point in Igbesa is never priced as
 * extended. Two towns containing one point is a broken map, not a cheaper fare.
 * Ground in neither is outside the service area.
 */
export function resolvePlace(
  point: Coordinate,
  areas: readonly ServiceArea[],
): Place {
  assertServiceAreaMap(areas);
  const communities = areas.filter(
    (area) => area.place !== 'extended' && contains(area, point),
  );
  if (communities.length > 1) {
    throw new PricingConfigurationError(
      'Two community areas contain the same ground',
    );
  }
  const community = communities[0];
  if (community !== undefined) return community.place;

  const extended = areas.find((area) => area.place === 'extended');
  if (extended !== undefined && contains(extended, point)) return 'extended';
  return 'outside';
}

/** Classifies every stop on the request. A client place name is not an input. */
export function resolveQuote(
  request: QuoteRequest,
  areas: readonly ServiceArea[],
): QuoteInput {
  switch (request.service) {
    case 'standard':
      return {
        service: 'standard',
        pickup: resolvePlace(request.pickup, areas),
        destination: resolvePlace(request.destination, areas),
      };
    case 'special_pickup':
      return {
        service: 'special_pickup',
        pickup: resolvePlace(request.pickup, areas),
        destination: resolvePlace(request.destination, areas),
        collection: resolvePlace(request.collection, areas),
      };
    case 'errand': {
      const pickup = request.pickup;
      const destination = request.destination;
      if ((pickup === undefined) !== (destination === undefined)) {
        throw new InvalidQuoteInputError(
          'Pickup and destination are both required when an errand includes delivery',
        );
      }
      if (pickup === undefined || destination === undefined) {
        return { service: 'errand', errandTier: request.errandTier };
      }
      return {
        service: 'errand',
        errandTier: request.errandTier,
        pickup: resolvePlace(pickup, areas),
        destination: resolvePlace(destination, areas),
      };
    }
  }
}
