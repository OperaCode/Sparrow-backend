import type { Config } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { createAuthModule } from '../../modules/auth/auth.module.js';
import type { FirebaseIdTokenVerifier } from '../../modules/auth/firebase/firebase-verifier.js';
import { createPricingModules } from '../../modules/pricing/pricing.module.js';
import { createUsersModules } from '../../modules/users/users.module.js';
import type { V1Module } from './router.js';

/** Feature modules served under /api/v1. */
export function createV1Modules(deps: {
  prisma: PrismaClient;
  logger: Logger;
  config: Config;
  firebaseVerifier: FirebaseIdTokenVerifier;
}): readonly V1Module[] {
  return [
    createAuthModule(deps),
    ...createUsersModules(deps),
    ...createPricingModules(deps),
  ];
}
