import { Router, type RequestHandler } from 'express';
import type { requireRole } from '../../http/middleware/require-role.js';

export interface RouteGuards {
  authenticate: RequestHandler;
  requireRole: typeof requireRole;
}

/**
 * A feature module contributes one router under /api/v1/<path>. Guards are
 * passed in so modules never construct auth themselves.
 */
export interface V1Module {
  path: string;
  createRouter(guards: RouteGuards): Router;
}

/**
 * Entry point for every /api/v1 module router. Additive changes stay in v1;
 * a breaking change gets a v2 router mounted alongside this one.
 */
export function createV1Router(
  modules: readonly V1Module[],
  guards: RouteGuards,
): Router {
  const router = Router();
  for (const module of modules) {
    router.use(module.path, module.createRouter(guards));
  }
  return router;
}
