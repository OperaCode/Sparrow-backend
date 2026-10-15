import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '../../src/http/middleware/request-id.js';
import { buildTestApp } from '../helpers/app.js';
import { errorOf } from '../helpers/http.js';

describe('createApp', () => {
  describe('GET /health/live', () => {
    it('returns 200 without touching the database', async () => {
      let pinged = false;
      const { app } = buildTestApp({
        healthRepository: {
          pingDatabase: () => {
            pinged = true;
            return Promise.resolve();
          },
        },
      });

      const response = await request(app).get('/health/live').expect(200);

      expect(response.body).toEqual({ data: { status: 'ok' } });
      expect(response.get('Cache-Control')).toBe('no-store');
      expect(pinged).toBe(false);
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 with check results when dependencies are up', async () => {
      const { app } = buildTestApp();

      const response = await request(app).get('/health/ready').expect(200);

      expect(response.body).toEqual({
        data: { status: 'ok', checks: { database: 'up' } },
      });
      expect(response.get('Cache-Control')).toBe('no-store');
    });

    it('returns 503 without leaking the failure cause', async () => {
      const { app } = buildTestApp({
        healthRepository: {
          pingDatabase: () =>
            Promise.reject(new Error('password authentication failed')),
        },
      });

      const response = await request(app).get('/health/ready').expect(503);

      expect(errorOf(response)).toEqual({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable',
        requestId: response.get(REQUEST_ID_HEADER),
      });
      expect(JSON.stringify(response.body)).not.toContain('password');
    });
  });

  it('serves the versioned API under /api/v1', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/api/v1/unknown').expect(404);

    expect(errorOf(response).code).toBe('NOT_FOUND');
  });

  it('returns a JSON 404 for unversioned paths', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/users').expect(404);

    expect(errorOf(response).code).toBe('NOT_FOUND');
  });

  it('does not advertise the framework', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/health/live');

    expect(response.get('X-Powered-By')).toBeUndefined();
  });

  it('assigns a request id to every response', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/api/v1/unknown');

    expect(response.get(REQUEST_ID_HEADER)).toBeTruthy();
  });
});
