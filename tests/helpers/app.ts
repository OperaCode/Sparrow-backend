import { Router, type Express } from 'express';
import type { RouteGuards, V1Module } from '../../src/api/v1/router.js';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config/env.js';
import type { AuthSubjectLookup } from '../../src/http/middleware/authenticate.js';
import { sendData } from '../../src/http/response.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import { signAccessToken } from '../../src/modules/auth/access-token.service.js';
import type { HealthRepository } from '../../src/modules/health/health.repository.js';
import {
  createHealthService,
  type HealthService,
} from '../../src/modules/health/health.service.js';
import { createLogCapture, type LogCapture } from './log-capture.js';

export const TEST_JWT_SECRET = 'test-only-secret-never-used-outside-tests';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://unused:unused@localhost:5433/unused_test',
    JWT_ACCESS_SECRET: TEST_JWT_SECRET,
    ...overrides,
  });
}

export const healthyRepository: HealthRepository = {
  pingDatabase: () => Promise.resolve(),
};

export const noSubjects: AuthSubjectLookup = {
  findAuthSubjectById: () => Promise.resolve(null),
};

/**
 * Test-only module exercising the auth foundation through the real app,
 * since no production route is protected yet.
 */
export const protectedTestModule: V1Module = {
  path: '/test-protected',
  createRouter({ authenticate, requireRole }: RouteGuards) {
    const router = Router();
    router.get('/any', authenticate, (req, res) => {
      sendData(res, req.auth);
    });
    router.get('/admin', authenticate, requireRole('admin'), (req, res) => {
      sendData(res, req.auth);
    });
    router.get(
      '/staff',
      authenticate,
      requireRole('rider', 'admin'),
      (req, res) => {
        sendData(res, req.auth);
      },
    );
    router.get('/misconfigured', requireRole('admin'), (_req, res) => {
      sendData(res, null);
    });
    return router;
  },
};

interface TestAppOptions {
  config?: Config;
  healthRepository?: HealthRepository;
  healthService?: HealthService;
  authSubjects?: AuthSubjectLookup;
  v1Modules?: readonly V1Module[];
}

export interface TestApp {
  app: Express;
  config: Config;
  logs: LogCapture;
  logger: Logger;
}

export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const config = options.config ?? testConfig();
  const logs = createLogCapture();
  const logger = createLogger(
    { level: config.logLevel, nodeEnv: config.nodeEnv },
    logs.stream,
  );
  const healthService =
    options.healthService ??
    createHealthService({
      repository: options.healthRepository ?? healthyRepository,
      logger,
    });

  const app = createApp({
    config,
    logger,
    healthService,
    authSubjects: options.authSubjects ?? noSubjects,
    v1Modules: options.v1Modules ?? [],
  });
  return { app, config, logs, logger };
}

export function tokenFor(
  userId: string,
  config: Config = testConfig(),
  ttlSeconds = 300,
): Promise<string> {
  return signAccessToken(config.auth, userId, ttlSeconds);
}
