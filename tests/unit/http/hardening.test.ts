import { createServer } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  applyServerTimeouts,
  SERVER_TIMEOUTS,
} from '../../../src/http/server-timeouts.js';
import { buildTestApp, testConfig } from '../../helpers/app.js';

const ALLOWED_ORIGIN = 'http://localhost:8081';

function appWithOrigins(origins: string) {
  return buildTestApp({ config: testConfig({ CORS_ORIGINS: origins }) }).app;
}

describe('security headers', () => {
  it('sets helmet defaults on every response', async () => {
    const response = await request(appWithOrigins('')).get('/health/live');

    expect(response.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.get('Strict-Transport-Security')).toContain('max-age=');
    expect(response.get('Content-Security-Policy')).toContain(
      "default-src 'self'",
    );
    expect(response.get('X-Powered-By')).toBeUndefined();
  });
});

describe('CORS', () => {
  it('allows a configured origin and exposes the request id', async () => {
    const response = await request(appWithOrigins(ALLOWED_ORIGIN))
      .get('/health/live')
      .set('Origin', ALLOWED_ORIGIN);

    expect(response.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.get('Access-Control-Expose-Headers')).toContain(
      'X-Request-Id',
    );
    expect(response.get('Access-Control-Allow-Credentials')).toBeUndefined();
  });

  it('does not allow an unlisted origin', async () => {
    const response = await request(appWithOrigins(ALLOWED_ORIGIN))
      .get('/health/live')
      .set('Origin', 'https://evil.example');

    expect(response.get('Access-Control-Allow-Origin')).toBeUndefined();
  });

  it('allows no browser origin when none are configured', async () => {
    const response = await request(appWithOrigins(''))
      .get('/health/live')
      .set('Origin', ALLOWED_ORIGIN);

    expect(response.get('Access-Control-Allow-Origin')).toBeUndefined();
  });

  it('answers preflight requests for allowed origins', async () => {
    const response = await request(appWithOrigins(ALLOWED_ORIGIN))
      .options('/api/v1/anything')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type')
      .expect(204);

    expect(response.get('Access-Control-Allow-Headers')).toContain(
      'Authorization',
    );
    expect(response.get('Access-Control-Max-Age')).toBe('600');
  });
});

describe('server timeouts', () => {
  it('bounds header, request and keep-alive time', () => {
    const server = createServer();

    applyServerTimeouts(server);

    expect(server.headersTimeout).toBe(SERVER_TIMEOUTS.headersTimeoutMs);
    expect(server.requestTimeout).toBe(SERVER_TIMEOUTS.requestTimeoutMs);
    expect(server.keepAliveTimeout).toBe(SERVER_TIMEOUTS.keepAliveTimeoutMs);
    expect(server.keepAliveTimeout).toBeLessThan(server.headersTimeout);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
  });
});
