import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createHttpLogger } from '../../../src/http/middleware/http-logger.js';
import {
  getRequestId,
  REQUEST_ID_HEADER,
  requestId,
  resolveRequestId,
} from '../../../src/http/middleware/request-id.js';
import { createLogger } from '../../../src/lib/logger.js';
import { createLogCapture } from '../../helpers/log-capture.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function buildApp() {
  const capture = createLogCapture();
  const logger = createLogger(
    { level: 'info', nodeEnv: 'test' },
    capture.stream,
  );

  const app = express();
  app.use(requestId);
  app.use(createHttpLogger(logger));
  app.get('/ok', (req, res) => {
    res.json({ id: req.id });
  });
  app.get('/missing', (_req, res) => {
    res.status(404).end();
  });
  app.get('/broken', (_req, res) => {
    res.status(500).end();
  });
  app.get('/health/live', (_req, res) => {
    res.status(200).end();
  });

  return { app, capture };
}

describe('getRequestId', () => {
  it('returns the string id assigned by the middleware', () => {
    expect(getRequestId({ id: 'trace-0001-abcd' } as Request)).toBe(
      'trace-0001-abcd',
    );
  });

  it('falls back when the id was assigned by something else', () => {
    expect(getRequestId({ id: 7 } as unknown as Request)).toBe('unassigned');
  });
});

describe('resolveRequestId', () => {
  it('generates a UUID when no id is supplied', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
  });

  it('keeps a well-formed incoming id', () => {
    expect(resolveRequestId('client-abc-12345')).toBe('client-abc-12345');
  });

  it.each([
    ['too short', 'abc1234'],
    ['too long', 'a'.repeat(65)],
    ['whitespace', 'abc 12345'],
    ['newline injection', 'abc12345\r\nX-Evil: 1'],
    ['json breaking', 'abc12345"}'],
  ])('replaces an id that is %s', (_label, incoming) => {
    const id = resolveRequestId(incoming);

    expect(id).not.toBe(incoming);
    expect(id).toMatch(UUID);
  });
});

describe('request id and HTTP logging middleware', () => {
  it('sets the request id on req and the response header', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/ok').expect(200);

    const header = response.get(REQUEST_ID_HEADER);
    expect(header).toMatch(UUID);
    expect(response.body).toEqual({ id: header });
  });

  it('echoes a valid incoming request id', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .get('/ok')
      .set(REQUEST_ID_HEADER, 'trace-0001-abcd')
      .expect(200);

    expect(response.get(REQUEST_ID_HEADER)).toBe('trace-0001-abcd');
  });

  it('logs one line per request with the request id and no sensitive data', async () => {
    const { app, capture } = buildApp();

    const response = await request(app)
      .get('/ok?phone=08012345678')
      .set('Authorization', 'Bearer secret-token')
      .set('Cookie', 'session=abc')
      .expect(200);

    await vi.waitFor(() => {
      expect(capture.lines).toHaveLength(1);
    });
    const line = capture.lines[0];
    expect(line).toMatchObject({
      level: 30,
      reqId: response.get(REQUEST_ID_HEADER),
      req: { method: 'GET', path: '/ok' },
      res: { statusCode: 200 },
    });
    expect(line).toHaveProperty('responseTime');

    const output = capture.raw();
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('session=abc');
    expect(output).not.toContain('08012345678');
  });

  it.each([
    ['/missing', 40],
    ['/broken', 50],
  ])('logs %s at level %i', async (path, level) => {
    const { app, capture } = buildApp();

    await request(app).get(path);

    await vi.waitFor(() => {
      expect(capture.lines).toHaveLength(1);
    });
    expect(capture.lines[0]?.level).toBe(level);
  });

  it('does not log health check traffic', async () => {
    const { app, capture } = buildApp();

    await request(app).get('/health/live').expect(200);
    await request(app).get('/ok').expect(200);

    await vi.waitFor(() => {
      expect(capture.lines).toHaveLength(1);
    });
    expect(capture.lines[0]).toMatchObject({ req: { path: '/ok' } });
  });
});
