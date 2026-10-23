import { Router } from 'express';
import type { V1Module } from '../../api/v1/router.js';
import { validate } from '../../http/middleware/validate.js';
import type { Logger } from '../../lib/logger.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { createPricingController } from './pricing.controller.js';
import { createPricingRepository } from './pricing.repository.js';
import {
  areaBodySchema,
  areaParamsSchema,
  manualQuoteBodySchema,
  orderParamsSchema,
  quoteBodySchema,
  ruleParamsSchema,
  updateRuleBodySchema,
} from './pricing.schema.js';
import { createPricingService } from './pricing.service.js';

export function createPricingModules(deps: {
  prisma: PrismaClient;
  logger: Logger;
}): readonly V1Module[] {
  const controller = createPricingController(
    createPricingService({
      repository: createPricingRepository(deps.prisma),
      logger: deps.logger,
    }),
  );

  const quotes: V1Module = {
    path: '/pricing',
    createRouter({ authenticate, requireRole }) {
      const router = Router();
      router.post(
        '/quotes',
        authenticate,
        validate({ body: quoteBodySchema }),
        controller.quote,
      );
      router.patch(
        '/areas/:place',
        authenticate,
        requireRole('admin'),
        validate({ params: areaParamsSchema, body: areaBodySchema }),
        controller.updateArea,
      );
      router.patch(
        '/rules/:component/:tier',
        authenticate,
        requireRole('admin'),
        validate({ params: ruleParamsSchema, body: updateRuleBodySchema }),
        controller.updateRule,
      );
      return router;
    },
  };

  const orders: V1Module = {
    path: '/orders',
    createRouter({ authenticate, requireRole }) {
      const router = Router();
      router.post(
        '/',
        authenticate,
        requireRole('customer'),
        validate({ body: quoteBodySchema }),
        controller.createOrder,
      );
      router.post(
        '/:id/manual-quote',
        authenticate,
        requireRole('admin'),
        validate({ params: orderParamsSchema, body: manualQuoteBodySchema }),
        controller.applyManualQuote,
      );
      return router;
    },
  };

  return [quotes, orders];
}
