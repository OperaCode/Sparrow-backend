import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { createV1Router, type V1Module } from './api/v1/router.js';
import type { Config } from './config/env.js';
import {
  createAuthenticate,
  type AuthSubjectLookup,
} from './http/middleware/authenticate.js';
import { createErrorHandler } from './http/middleware/error-handler.js';
import { createHttpLogger } from './http/middleware/http-logger.js';
import { notFound } from './http/middleware/not-found.js';
import { createRateLimiter } from './http/middleware/rate-limit.js';
import { REQUEST_ID_HEADER, requestId } from './http/middleware/request-id.js';
import { requireRole } from './http/middleware/require-role.js';
import type { Logger } from './lib/logger.js';
import { createAccessTokenVerifier } from './modules/auth/access-token.service.js';
import { createHealthController } from './modules/health/health.controller.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import type { HealthService } from './modules/health/health.service.js';

export interface AppDependencies {
  config: Config;
  logger: Logger;
  healthService: HealthService;
  authSubjects: AuthSubjectLookup;
  v1Modules: readonly V1Module[];
}

const JSON_BODY_LIMIT = '100kb';
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Browser access is limited to the configured origins. Native mobile clients
 * send no Origin header and are unaffected. No cookies are used, so
 * credentials stay disabled.
 */
function createCors(origins: readonly string[]): RequestHandler {
  return cors({
    origin: origins.length > 0 ? [...origins] : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', REQUEST_ID_HEADER],
    exposedHeaders: [
      REQUEST_ID_HEADER,
      'RateLimit',
      'RateLimit-Policy',
      'Retry-After',
    ],
    credentials: false,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  });
}

/**
 * Builds the Express app from injected dependencies and never touches the
 * network or process state, so tests can construct it freely.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.http.trustProxy);

  app.use(requestId);
  app.use(createHttpLogger(deps.logger));
  app.use(helmet());
  app.use(createCors(deps.config.cors.origins));
  // Limit before parsing bodies so a flood is rejected as cheaply as possible.
  // /health is deliberately outside the limit for platform probes.
  app.use(
    '/api',
    createRateLimiter({
      windowMs: deps.config.rateLimit.windowMs,
      max: deps.config.rateLimit.max,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(
    '/health',
    createHealthRouter(createHealthController(deps.healthService)),
  );
  const authenticate = createAuthenticate({
    verifier: createAccessTokenVerifier(deps.config.auth),
    subjects: deps.authSubjects,
  });
  app.use(
    '/api/v1',
    createV1Router(deps.v1Modules, { authenticate, requireRole }),
  );

  app.use(notFound);
  app.use(createErrorHandler(deps.logger));

  return app;
}
