import { classifySpecialPickup, classifyZone } from "./pricing.classify.js";
import {
  PricingConfigurationError,
  amountDue,
  assertPositiveNaira,
} from "./pricing.money.js";
import {
  CURRENCY,
  type ErrandTier,
  type Place,
  type PriceComponentQuote,
  type PriceQuote,
  type PriceRuleRecord,
  type PricingComponent,
  type QuoteInput,
  type QuoteMode,
  type SpecialPickupTier,
  type ZoneTier,
} from "./pricing.types.js";

export { PricingConfigurationError } from "./pricing.money.js";

/** The request names an errand delivery with only one end. */
export class InvalidQuoteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuoteInputError";
  }
}

type RuleIndex = ReadonlyMap<string, PriceRuleRecord>;

/** One entry per tier. A second amount for the same tier is a corrupt list. */
function indexRules(rules: readonly PriceRuleRecord[]): RuleIndex {
  const byTier = new Map(
    rules.map((rule) => [`${rule.component}/${rule.tier}`, rule] as const),
  );
  if (byTier.size !== rules.length) {
    throw new PricingConfigurationError(
      "The price list has two amounts for the same tier",
    );
  }
  return byTier;
}

function findRule(
  byTier: RuleIndex,
  component: PricingComponent,
  tier: string,
): PriceRuleRecord {
  const rule = byTier.get(`${component}/${tier}`);
  if (rule === undefined) {
    throw new PricingConfigurationError(
      `Expected one price rule for ${component}/${tier}`,
    );
  }
  return rule;
}

function money(
  component: PricingComponent,
  tier: string,
  byTier: RuleIndex,
): { quoteMode: QuoteMode; amountNaira: number | null } {
  const rule = findRule(byTier, component, tier);
  const manualWithAmount =
    rule.quoteMode === "manual" && rule.amountNaira !== null;
  const automaticWithoutAmount =
    rule.quoteMode === "automatic" && rule.amountNaira === null;
  if (manualWithAmount || automaticWithoutAmount) {
    throw new PricingConfigurationError(
      `${component}/${tier} breaks the automatic/manual amount rule`,
    );
  }
  if (rule.quoteMode === "manual") {
    return { quoteMode: "manual", amountNaira: null };
  }
  return {
    quoteMode: "automatic",
    amountNaira: assertPositiveNaira(rule.amountNaira, `${component}/${tier}`),
  };
}

function zoneQuote(tier: ZoneTier, byTier: RuleIndex): PriceComponentQuote {
  return {
    component: "standard_zone",
    tier,
    ...money("standard_zone", tier, byTier),
  };
}

function specialPickupQuote(
  tier: SpecialPickupTier,
  byTier: RuleIndex,
): PriceComponentQuote {
  return {
    component: "special_pickup",
    tier,
    ...money("special_pickup", tier, byTier),
  };
}

function errandQuote(tier: ErrandTier, byTier: RuleIndex): PriceComponentQuote {
  return { component: "errand", tier, ...money("errand", tier, byTier) };
}

function optionalZone(
  pickup: Place | undefined,
  destination: Place | undefined,
  byTier: RuleIndex,
): PriceComponentQuote | undefined {
  const missingPickup = pickup === undefined;
  const missingDestination = destination === undefined;
  if (missingPickup !== missingDestination) {
    throw new InvalidQuoteInputError(
      "Pickup and destination are both required when an errand includes delivery",
    );
  }
  if (pickup === undefined || destination === undefined) return undefined;
  return zoneQuote(classifyZone(pickup, destination), byTier);
}

function componentsFor(
  input: QuoteInput,
  byTier: RuleIndex,
): PriceComponentQuote[] {
  switch (input.service) {
    case "standard":
      return [zoneQuote(classifyZone(input.pickup, input.destination), byTier)];
    case "special_pickup":
      return [
        zoneQuote(classifyZone(input.pickup, input.destination), byTier),
        specialPickupQuote(
          classifySpecialPickup(input.pickup, input.collection),
          byTier,
        ),
      ];
    case "errand": {
      const zone = optionalZone(input.pickup, input.destination, byTier);
      const task = errandQuote(input.errandTier, byTier);
      return zone === undefined ? [task] : [task, zone];
    }
  }
}

function finish(components: PriceComponentQuote[]): PriceQuote {
  const totalNaira = amountDue(components);
  return {
    pricingStatus: totalNaira === null ? "pending_manual_quote" : "auto",
    currency: CURRENCY,
    components,
    totalNaira,
  };
}

/**
 * Prices a request from the supplied rules only. Client amounts are not an
 * input. The total is null while any leg is a manual quote, so an automatic
 * leg cannot be charged by itself.
 */
export function calculatePrice(
  input: QuoteInput,
  rules: readonly PriceRuleRecord[],
): PriceQuote {
  return finish(componentsFor(input, indexRules(rules)));
}
