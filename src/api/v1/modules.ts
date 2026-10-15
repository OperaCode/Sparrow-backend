import type { Logger } from '../../lib/logger.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { createPricingModules } from '../../modules/pricing/pricing.module.js';
import type { V1Module } from './router.js';

/** Feature modules served under /api/v1. */
export function createV1Modules(deps: {
  prisma: PrismaClient;
  logger: Logger;
}): readonly V1Module[] {
  return createPricingModules(deps);
}
