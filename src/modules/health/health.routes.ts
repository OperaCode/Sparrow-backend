import { Router } from 'express';
import type { HealthController } from './health.controller.js';

/**
 * Mounted outside /api/v1: health checks are an operational contract with
 * the hosting platform, not part of the versioned client API.
 */
export function createHealthRouter(controller: HealthController): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/live', controller.live);
  router.get('/ready', controller.ready);

  return router;
}
