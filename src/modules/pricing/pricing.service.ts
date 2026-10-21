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
import { resolveQuote } from './pricing.locate.js';
import { isChargeableKobo } from './pricing.money.js';
import type { PricingRepository } from './pricing.repository.js';
import type {
  AreaBox,
  PriceQuote,
  PriceRuleRecord,
  PricedOrder,
  PricingComponent,
  QuoteRequest,
  RuleUpdate,
  ServiceArea,
  ServiceAreaPlace,
} from './pricing.types.js';

export interface PricingService {
  quote(request: QuoteRequest): Promise<PriceQuote>;
  createOrder(customerId: string, request: QuoteRequest): Promise<PricedOrder>;
  updateRule(
    component: PricingComponent,
    tier: string,
    patch: RuleUpdate,
    actorId: string,
  ): Promise<PriceRuleRecord>;
  updateArea(place: ServiceAreaPlace, box: AreaBox): Promise<ServiceArea>;
  applyManualQuote(
    orderId: string,
    amountKobo: number,
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
    request: QuoteRequest,
    rules: readonly PriceRuleRecord[],
    areas: readonly ServiceArea[],
  ): PriceQuote {
    try {
      return calculatePrice(resolveQuote(request, areas), rules);
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

  function guardConfiguration<T>(work: () => Promise<T>): Promise<T> {
    return work().then(
      (value) => value,
      (error: unknown) => {
        if (error instanceof PricingConfigurationError)
          unavailable(logger, error);
        throw error;
      },
    );
  }

  return {
    quote(request) {
      return guardConfiguration(async () =>
        price(
          request,
          await repository.listRules(),
          await repository.listAreas(),
        ),
      );
    },

    createOrder(customerId, request) {
      return guardConfiguration(() =>
        repository.createPricedOrder({
          customerId,
          request,
          quoteFromRules: (rules, areas) => price(request, rules, areas),
        }),
      );
    },

    async updateRule(component, tier, patch, actorId) {
      if (patch.quoteMode === 'automatic') {
        if (patch.amountKobo === null || !isChargeableKobo(patch.amountKobo)) {
          throw new ValidationError([
            {
              path: 'body.amountKobo',
              message: 'Amount must be a positive whole number of kobo',
            },
          ]);
        }
        if (patch.minimumKobo !== null) {
          throw new ValidationError([
            {
              path: 'body.minimumKobo',
              message: 'An automatic price cannot carry a manual floor',
            },
          ]);
        }
      } else if (
        patch.amountKobo !== null ||
        patch.minimumKobo === null ||
        !isChargeableKobo(patch.minimumKobo)
      ) {
        throw new ValidationError([
          {
            path: 'body.minimumKobo',
            message: 'A manual tier requires a positive whole-kobo minimum',
          },
        ]);
      }
      const updated = await repository.updateRule(
        component,
        tier,
        patch,
        actorId,
      );
      if (updated === null) throw new NotFoundError('Price rule not found');
      return updated;
    },

    async updateArea(place, box) {
      const latitudes =
        box.minLatitude >= box.maxLatitude ||
        box.minLatitude < -90 ||
        box.maxLatitude > 90;
      const longitudes =
        box.minLongitude >= box.maxLongitude ||
        box.minLongitude < -180 ||
        box.maxLongitude > 180;
      if (
        latitudes ||
        longitudes ||
        !Number.isFinite(box.minLatitude) ||
        !Number.isFinite(box.maxLatitude) ||
        !Number.isFinite(box.minLongitude) ||
        !Number.isFinite(box.maxLongitude)
      ) {
        throw new ValidationError([
          {
            path: 'body',
            message: 'Area bounds must be a finite, non-empty box',
          },
        ]);
      }
      const updated = await repository.updateArea(place, box);
      if (updated === 'missing')
        throw new NotFoundError('Service area not found');
      if (updated === 'invalid') {
        throw new ValidationError([
          {
            path: 'body',
            message: 'Community areas must not cover the same ground',
          },
        ]);
      }
      return updated;
    },

    /**
     * The agreed figure is the full amount due. It is not added to component
     * amounts, and it is not read back from the price list.
     */
    async applyManualQuote(orderId, amountKobo, adminId) {
      if (!isChargeableKobo(amountKobo)) {
        throw new ValidationError([
          {
            path: 'body.amountKobo',
            message: 'Amount must be a positive whole number of kobo',
          },
        ]);
      }
      const result = await repository.applyManualQuote(
        orderId,
        amountKobo,
        adminId,
      );
      if (result === 'missing') throw new NotFoundError('Order not found');
      if (result === 'not_pending') {
        throw new ConflictError('Only a pending manual quote can be priced');
      }
      if ('belowMinimum' in result) {
        throw new ValidationError([
          {
            path: 'body.amountKobo',
            message: `Amount must be at least ${result.belowMinimum} kobo`,
          },
        ]);
      }
      return result;
    },
  };
}
