import type {
  Coordinate,
  ServiceArea,
  ServiceAreaPlace,
} from './pricing.types.js';

/**
 * Operational boxes for the Igbesa–Lusada–Ketu corridor and the Agbara axis.
 * Quotes read service_areas, not this list. The towns are Ketu-Adie near
 * Agbara, Lusada market, and Igbesa — not Lagos Ketu. Boxes do not share
 * ground. The extended box is the axis around them; a town inside it still
 * classifies as that town.
 */
export const APPROVED_SERVICE_AREAS: readonly ServiceArea[] = [
  {
    place: 'igbesa',
    minLatitude: 6.515,
    maxLatitude: 6.555,
    minLongitude: 3.11,
    maxLongitude: 3.165,
  },
  {
    place: 'lusada',
    minLatitude: 6.565,
    maxLatitude: 6.605,
    minLongitude: 3.06,
    maxLongitude: 3.109,
  },
  {
    place: 'ketu',
    minLatitude: 6.5,
    maxLatitude: 6.53,
    minLongitude: 3.05,
    maxLongitude: 3.095,
  },
  {
    place: 'extended',
    minLatitude: 6.48,
    maxLatitude: 6.62,
    minLongitude: 3.04,
    maxLongitude: 3.18,
  },
];

/** Points inside each approved box, including Agbara for the extended axis. */
const SAMPLE_POINTS: Record<ServiceAreaPlace, Coordinate> = {
  igbesa: { latitude: 6.535, longitude: 3.1375 },
  lusada: { latitude: 6.585, longitude: 3.0845 },
  ketu: { latitude: 6.515, longitude: 3.0725 },
  extended: { latitude: 6.50556, longitude: 3.10075 },
};

/** Lagos Ketu. It sits outside this corridor, so it is not Zone A, B, or C. */
export const OUTSIDE_CORRIDOR_POINT: Coordinate = {
  latitude: 6.595,
  longitude: 3.39,
};

export function samplePoint(place: ServiceAreaPlace): Coordinate {
  const point = SAMPLE_POINTS[place];
  return { latitude: point.latitude, longitude: point.longitude };
}
