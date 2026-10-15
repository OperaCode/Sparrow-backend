import type { Place, SpecialPickupTier, ZoneTier } from './pricing.types.js';

/**
 * Same community is Zone A, including Ketu to Ketu. Igbesa and Lusada are
 * Zone B. Any other pair of communities touches Ketu and is Zone C.
 * Outside the corridor wins over an extended Agbara leg: that movement is
 * not on the standard price list.
 */
export function classifyZone(pickup: Place, destination: Place): ZoneTier {
  if (pickup === 'outside' || destination === 'outside') return 'outside_area';
  if (pickup === 'extended' || destination === 'extended') return 'extended';
  if (pickup === destination) return 'A';
  if (pickup === 'ketu' || destination === 'ketu') return 'C';
  return 'B';
}

/**
 * Special Pickup reuses the zone pair, mapped onto a collection fee.
 * Zone C is an extended collection (manual, ₦1,000+), not an automatic fee.
 * The pair is the customer's pickup community and the third-party collection.
 */
export function classifySpecialPickup(
  pickup: Place,
  collection: Place,
): SpecialPickupTier {
  const zone = classifyZone(pickup, collection);
  if (zone === 'A') return 'local';
  if (zone === 'B') return 'nearby';
  if (zone === 'outside_area') return 'outside_area';
  return 'extended';
}
