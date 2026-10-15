import type { RequestHandler } from 'express';
import { ServiceUnavailableError } from '../../http/errors.js';
import { sendData } from '../../http/response.js';
import type { HealthService } from './health.service.js';

export interface HealthController {
  live: RequestHandler;
  ready: RequestHandler;
}

export function createHealthController(
  service: HealthService,
): HealthController {
  return {
    live: (_req, res) => {
      sendData(res, { status: 'ok' });
    },
    ready: async (_req, res) => {
      const report = await service.checkReadiness();
      if (!report.ready) {
        throw new ServiceUnavailableError();
      }
      sendData(res, { status: 'ok', checks: report.checks });
    },
  };
}
