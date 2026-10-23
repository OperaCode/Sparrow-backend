export const CURRENCY = "NGN" as const;
export type Currency = typeof CURRENCY;

/** Whole naira. Large enough for an exceptional local quote, small enough to reject garbage. */
export const MAX_AMOUNT_NAIRA = 1_000_000;

export const PLACES = [
  "igbesa",
  "lusada",
  "ketu",
  "extended",
  "outside",
] as const;
export type Place = (typeof PLACES)[number];

export const ZONE_TIERS = ["A", "B", "C", "extended", "outside_area"] as const;
export type ZoneTier = (typeof ZONE_TIERS)[number];

export const SPECIAL_PICKUP_TIERS = [
  "local",
  "nearby",
  "extended",
  "outside_area",
] as const;
export type SpecialPickupTier = (typeof SPECIAL_PICKUP_TIERS)[number];

export const ERRAND_TIERS = ["simple", "moderate", "complex"] as const;
export type ErrandTier = (typeof ERRAND_TIERS)[number];

export const PRICING_COMPONENTS = [
  "standard_zone",
  "special_pickup",
  "errand",
] as const;
export type PricingComponent = (typeof PRICING_COMPONENTS)[number];

export const QUOTE_MODES = ["automatic", "manual"] as const;
export type QuoteMode = (typeof QUOTE_MODES)[number];

export type OpenPricingStatus = "auto" | "pending_manual_quote";
export type PricingStatus = OpenPricingStatus | "manual_quoted";

export type QuoteInput =
  | { service: "standard"; pickup: Place; destination: Place }
  | {
      service: "special_pickup";
      pickup: Place;
      destination: Place;
      collection: Place;
    }
  | {
      service: "errand";
      errandTier: ErrandTier;
      pickup?: Place;
      destination?: Place;
    };

export interface PriceRuleRecord {
  component: PricingComponent;
  tier: string;
  quoteMode: QuoteMode;
  amountNaira: number | null;
}

export interface RuleUpdate {
  quoteMode: QuoteMode;
  amountNaira: number | null;
}

export type PriceComponentQuote =
  | {
      component: "standard_zone";
      tier: ZoneTier;
      quoteMode: QuoteMode;
      amountNaira: number | null;
    }
  | {
      component: "special_pickup";
      tier: SpecialPickupTier;
      quoteMode: QuoteMode;
      amountNaira: number | null;
    }
  | {
      component: "errand";
      tier: ErrandTier;
      quoteMode: QuoteMode;
      amountNaira: number | null;
    };

/** Preview or initial snapshot. totalNaira is the only amount due. */
export interface PriceQuote {
  pricingStatus: OpenPricingStatus;
  currency: Currency;
  components: PriceComponentQuote[];
  totalNaira: number | null;
}

/** Persisted price snapshot. manual_quoted means operations set totalNaira. */
export interface PricedOrder {
  id: string;
  serviceType: QuoteInput["service"];
  pricingStatus: PricingStatus;
  currency: Currency;
  components: PriceComponentQuote[];
  totalNaira: number | null;
}
