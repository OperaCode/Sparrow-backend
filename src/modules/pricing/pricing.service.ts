import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../http/errors.js';
import type { Logger } from '../../lib/logger.js';
import {
  InvalidQuoteInputError,
  PricingConfigurationError,
  calculatePrice,
} from './pricing.calculate.js';
import { isChargeableNaira } from './pricing.money.js';
import type { PricingRepository } from './pricing.repository.js';
import type {
  PriceQuote,
  PriceRuleRecord,
  PricedOrder,
  PricingComponent,
  QuoteInput,
  RuleUpdate,
} from './pricing.types.js';

export interface PricingService {
  quote(input: QuoteInput): Promise<PriceQuote>;
  createOrder(customerId: string, input: QuoteInput): Promise<PricedOrder>;
  updateRule(
    component: PricingComponent,
    tier: string,
    patch: RuleUpdate,
  ): Promise<PriceRuleRecord>;
  applyManualQuote(
    orderId: string,
    amountNaira: number,
    adminId: string,
  ): Promise<PricedOrder>;
}

interface PricingServiceOptions {
  repository: PricingRepository;
  logger: Logger;
}

/**
 * Turns a broken price list into a client-safe 503. The detail stays in the log.
 */
function unavailable(logger: Logger, error: PricingConfigurationError): never {
  logger.error({ err: error }, 'Pricing configuration is incomplete');
  throw new ServiceUnavailableError('Pricing is temporarily unavailable');
}

export function createPricingService(
  options: PricingServiceOptions,
): PricingService {
  const { repository, logger } = options;

  function price(
    input: QuoteInput,
    rules: readonly PriceRuleRecord[],
  ): PriceQuote {
    try {
      return calculatePrice(input, rules);
    } catch (error) {
      if (error instanceof PricingConfigurationError)
        unavailable(logger, error);
      if (error instanceof InvalidQuoteInputError) {
        throw new ValidationError([
          { path: 'body.destination', message: error.message },
        ]);
      }
      throw error;
    }
  }

  return {
    async quote(input) {
      return price(input, await repository.listRules());
    },

    createOrder(customerId, input) {
      return repository.createPricedOrder({
        customerId,
        input,
        quoteFromRules: (rules) => price(input, rules),
      });
    },

    async updateRule(component, tier, patch) {
      const amount = patch.amountNaira;
      const invalidAutomatic =
        patch.quoteMode === 'automatic' &&
        (amount === null || !isChargeableNaira(amount));
      const invalidManual =
        patch.quoteMode === 'manual' && patch.amountNaira !== null;
      if (invalidAutomatic || invalidManual) {
        throw new ValidationError([
          {
            path: 'body.amountNaira',
            message: 'Amount must be a positive whole number of naira',
          },
        ]);
      }
      const updated = await repository.updateRule(component, tier, patch);
      if (updated === null) throw new NotFoundError('Price rule not found');
      return updated;
    },

    /**
     * The agreed figure is the full amount due. It is not added to component
     * amounts, and it is not read back from the price list.
     */
    async applyManualQuote(orderId, amountNaira, adminId) {
      if (!isChargeableNaira(amountNaira)) {
        throw new ValidationError([
          {
            path: 'body.amountNaira',
            message: 'Amount must be a positive whole number of naira',
          },
        ]);
      }
      const result = await repository.applyManualQuote(
        orderId,
        amountNaira,
        adminId,
      );
      if (result === 'missing') throw new NotFoundError('Order not found');
      if (result === 'not_pending') {
        throw new ConflictError('Only a pending manual quote can be priced');
      }
      return result;
    },
  };
}
