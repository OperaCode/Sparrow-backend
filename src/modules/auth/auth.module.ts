import { Router } from 'express';
import type { V1Module } from '../../api/v1/router.js';
import type { Config } from '../../config/env.js';
import { createRateLimiter } from '../../http/middleware/rate-limit.js';
import { validate } from '../../http/middleware/validate.js';
import type { Logger } from '../../lib/logger.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { createUsersRepository } from '../users/users.repository.js';
import { createAuthController } from './auth.controller.js';
import {
  firebaseExchangeBodySchema,
  refreshTokenBodySchema,
} from './auth.schema.js';
import { createAuthService } from './auth.service.js';
import type { FirebaseIdTokenVerifier } from './firebase/firebase-verifier.js';
import { createSessionTokens } from './session-tokens.js';
import { createSessionsRepository } from './sessions.repository.js';

export interface AuthModuleDependencies {
  prisma: PrismaClient;
  logger: Logger;
  config: Pick<Config, 'auth' | 'session' | 'authRateLimit'>;
  firebaseVerifier: FirebaseIdTokenVerifier;
}

/**
 * Public routes: they issue credentials, so none of them sit behind
 * authenticate. Each has its own per-IP limit on top of the global /api one;
 * refresh and logout share a budget.
 */
export function createAuthModule(deps: AuthModuleDependencies): V1Module {
  const sessions = createSessionsRepository(deps.prisma);
  const controller = createAuthController(
    createAuthService({
      firebase: deps.firebaseVerifier,
      users: createUsersRepository(deps.prisma),
      sessions,
      sessionTokens: createSessionTokens({ config: deps.config, sessions }),
      logger: deps.logger,
    }),
  );

  return {
    path: '/auth',
    createRouter() {
      const exchangeLimiter = createRateLimiter(
        deps.config.authRateLimit.exchange,
      );
      const refreshLimiter = createRateLimiter(
        deps.config.authRateLimit.refresh,
      );

      const router = Router();
      router.post(
        '/firebase',
        exchangeLimiter,
        validate({ body: firebaseExchangeBodySchema }),
        controller.exchangeFirebaseToken,
      );
      router.post(
        '/refresh',
        refreshLimiter,
        validate({ body: refreshTokenBodySchema }),
        controller.refresh,
      );
      router.post(
        '/logout',
        refreshLimiter,
        validate({ body: refreshTokenBodySchema }),
        controller.logout,
      );
      return router;
    },
  };
}
