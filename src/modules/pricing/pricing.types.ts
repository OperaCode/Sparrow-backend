export const CURRENCY = 'NGN' as const;
export type Currency = typeof CURRENCY;

/** Whole kobo (100 kobo = ₦1). The cap is ₦1,000,000. */
export const MAX_AMOUNT_KOBO = 100_000_000;

export const PLACES = [
  'igbesa',
  'lusada',
  'ketu',
  'extended',
  'outside',
] as const;
export type Place = (typeof PLACES)[number];

/** Areas the server can draw. Outside is whatever ground none of these cover. */
export const SERVICE_AREA_PLACES = [
  'igbesa',
  'lusada',
  'ketu',
  'extended',
] as const;
export type ServiceAreaPlace = (typeof SERVICE_AREA_PLACES)[number];

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export const ZONE_TIERS = ['A', 'B', 'C', 'extended', 'outside_area'] as const;
export type ZoneTier = (typeof ZONE_TIERS)[number];

export const SPECIAL_PICKUP_TIERS = [
  'local',
  'nearby',
  'extended',
  'outside_area',
] as const;
export type SpecialPickupTier = (typeof SPECIAL_PICKUP_TIERS)[number];

export const ERRAND_TIERS = ['simple', 'moderate', 'complex'] as const;
export type ErrandTier = (typeof ERRAND_TIERS)[number];

export const PRICING_COMPONENTS = [
  'standard_zone',
  'special_pickup',
  'errand',
] as const;
export type PricingComponent = (typeof PRICING_COMPONENTS)[number];

export const QUOTE_MODES = ['automatic', 'manual'] as const;
export type QuoteMode = (typeof QUOTE_MODES)[number];

export type OpenPricingStatus = 'auto' | 'pending_manual_quote';
export type PricingStatus = OpenPricingStatus | 'manual_quoted';

/** Resolved places. The calculator never sees a client community label. */
export type QuoteInput =
  | { service: 'standard'; pickup: Place; destination: Place }
  | {
      service: 'special_pickup';
      pickup: Place;
      destination: Place;
      collection: Place;
    }
  | {
      service: 'errand';
      errandTier: ErrandTier;
      pickup?: Place;
      destination?: Place;
    };

/** What a customer may send: coordinates, never a zone or a community name. */
export type QuoteRequest =
  | { service: 'standard'; pickup: Coordinate; destination: Coordinate }
  | {
      service: 'special_pickup';
      pickup: Coordinate;
      destination: Coordinate;
      collection: Coordinate;
    }
  | {
      service: 'errand';
      errandTier: ErrandTier;
      pickup?: Coordinate;
      destination?: Coordinate;
    };

export interface AreaBox {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export interface ServiceArea extends AreaBox {
  place: ServiceAreaPlace;
}

export interface PriceRuleRecord {
  component: PricingComponent;
  tier: string;
  quoteMode: QuoteMode;
  amountKobo: number | null;
  /** Lowest figure operations may enter for this leg. Null on automatic tiers. */
  minimumKobo: number | null;
}

export interface RuleUpdate {
  quoteMode: QuoteMode;
  amountKobo: number | null;
  minimumKobo: number | null;
}

export type PriceComponentQuote =
  | {
      component: 'standard_zone';
      tier: ZoneTier;
      quoteMode: QuoteMode;
      amountKobo: number | null;
    }
  | {
      component: 'special_pickup';
      tier: SpecialPickupTier;
      quoteMode: QuoteMode;
      amountKobo: number | null;
    }
  | {
      component: 'errand';
      tier: ErrandTier;
      quoteMode: QuoteMode;
      amountKobo: number | null;
    };

/** Preview or initial snapshot. totalKobo is the only amount due. */
export interface PriceQuote {
  pricingStatus: OpenPricingStatus;
  currency: Currency;
  components: PriceComponentQuote[];
  totalKobo: number | null;
  /** Floor for a later manual quote. Null when the price is already final. */
  minimumTotalKobo: number | null;
  pickupPlace: Place | null;
  destinationPlace: Place | null;
  collectionPlace: Place | null;
}

/** Persisted price snapshot. manual_quoted means operations set totalKobo. */
export interface PricedOrder {
  id: string;
  serviceType: QuoteInput['service'];
  pricingStatus: PricingStatus;
  currency: Currency;
  components: PriceComponentQuote[];
  totalKobo: number | null;
  minimumTotalKobo: number | null;
  pickupPlace: Place | null;
  destinationPlace: Place | null;
  collectionPlace: Place | null;
}
