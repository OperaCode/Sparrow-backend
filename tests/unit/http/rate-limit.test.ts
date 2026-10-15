import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createErrorHandler } from '../../../src/http/middleware/error-handler.js';
import { createRateLimiter } from '../../../src/http/middleware/rate-limit.js';
import { requestId } from '../../../src/http/middleware/request-id.js';
import { createLogger } from '../../../src/lib/logger.js';
import { buildTestApp, testConfig } from '../../helpers/app.js';
import { errorOf } from '../../helpers/http.js';
import { createLogCapture } from '../../helpers/log-capture.js';

function limitedApp(overrides: NodeJS.ProcessEnv = {}) {
  return buildTestApp({
    config: testConfig({
      RATE_LIMIT_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
      ...overrides,
    }),
  }).app;
}

describe('global API rate limit', () => {
  it('returns 429 RATE_LIMITED once the budget is spent', async () => {
    const app = limitedApp();

    await request(app).get('/api/v1/anything').expect(404);
    await request(app).get('/api/v1/anything').expect(404);
    const response = await request(app).get('/api/v1/anything').expect(429);

    expect(errorOf(response)).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many requests, please try again later',
    });
    const retryAfter = Number(response.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('sends standard RateLimit headers', async () => {
    const response = await request(limitedApp()).get('/api/v1/anything');

    expect(response.get('RateLimit-Policy')).toContain('q=2');
    expect(response.get('RateLimit')).toContain('r=1');
    expect(response.get('X-RateLimit-Limit')).toBeUndefined();
  });

  it('never limits health checks', async () => {
    const app = limitedApp();

    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/health/live').expect(200);
    }
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const app = limitedApp({ TRUST_PROXY: '0' });

    await request(app).get('/api/v1/x').set('X-Forwarded-For', '203.0.113.1');
    await request(app).get('/api/v1/x').set('X-Forwarded-For', '203.0.113.2');
    await request(app)
      .get('/api/v1/x')
      .set('X-Forwarded-For', '203.0.113.3')
      .expect(429);
  });

  it('limits each forwarded client separately behind a trusted proxy', async () => {
    const app = limitedApp({ TRUST_PROXY: '1' });

    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      await request(app)
        .get('/api/v1/x')
        .set('X-Forwarded-For', ip)
        .expect(404);
      await request(app)
        .get('/api/v1/x')
        .set('X-Forwarded-For', ip)
        .expect(404);
    }
    await request(app)
      .get('/api/v1/x')
      .set('X-Forwarded-For', '203.0.113.1')
      .expect(429);
  });
});

describe('createRateLimiter', () => {
  it('supports a custom key for sensitive routes', async () => {
    const logger = createLogger(
      { level: 'silent', nodeEnv: 'test' },
      createLogCapture().stream,
    );
    const app = express();
    app.use(requestId);
    app.post(
      '/otp',
      createRateLimiter({
        windowMs: 60_000,
        max: 1,
        keyGenerator: (req) => req.get('X-Phone') ?? 'none',
      }),
      (_req, res) => {
        res.status(204).end();
      },
    );
    app.use(createErrorHandler(logger));

    await request(app)
      .post('/otp')
      .set('X-Phone', '+2348000000001')
      .expect(204);
    await request(app)
      .post('/otp')
      .set('X-Phone', '+2348000000001')
      .expect(429);
    await request(app)
      .post('/otp')
      .set('X-Phone', '+2348000000002')
      .expect(204);
  });
});
