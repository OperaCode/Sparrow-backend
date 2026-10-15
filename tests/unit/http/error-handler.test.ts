import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  type AppError,
} from '../../../src/http/errors.js';
import { createErrorHandler } from '../../../src/http/middleware/error-handler.js';
import { notFound } from '../../../src/http/middleware/not-found.js';
import {
  REQUEST_ID_HEADER,
  requestId,
} from '../../../src/http/middleware/request-id.js';
import { sendData } from '../../../src/http/response.js';
import { createLogger } from '../../../src/lib/logger.js';
import { errorOf } from '../../helpers/http.js';
import { createLogCapture } from '../../helpers/log-capture.js';

function buildApp(thrown?: unknown) {
  const capture = createLogCapture();
  const logger = createLogger(
    { level: 'info', nodeEnv: 'test' },
    capture.stream,
  );

  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));
  app.get('/data', (_req, res) => {
    sendData(res, { ok: true });
  });
  app.get('/data-with-meta', (_req, res) => {
    sendData(res, [1, 2], { status: 201, meta: { nextCursor: 'abc' } });
  });
  app.get('/throw', () => {
    throw thrown;
  });
  app.get('/reject', async () => {
    await Promise.resolve();
    throw thrown;
  });
  app.post('/echo', (req, res) => {
    sendData(res, req.body);
  });
  app.get('/partial', (_req, res) => {
    res.status(200).write('partial');
    throw new Error('after headers');
  });
  app.use(notFound);
  app.use(createErrorHandler(logger));

  return { app, capture };
}

describe('sendData', () => {
  it('wraps the payload in a data envelope', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/data').expect(200);

    expect(response.body).toEqual({ data: { ok: true } });
  });

  it('supports a custom status and meta', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/data-with-meta').expect(201);

    expect(response.body).toEqual({
      data: [1, 2],
      meta: { nextCursor: 'abc' },
    });
  });
});

describe('error handler', () => {
  it.each<[AppError, number, string]>([
    [
      new ValidationError([{ path: 'body.phone', message: 'Required' }]),
      400,
      'VALIDATION_ERROR',
    ],
    [new UnauthorizedError(), 401, 'UNAUTHENTICATED'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [
      new ForbiddenError('Account suspended', 'ACCOUNT_SUSPENDED'),
      403,
      'ACCOUNT_SUSPENDED',
    ],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
    [new RateLimitError(30), 429, 'RATE_LIMITED'],
    [new ServiceUnavailableError(), 503, 'SERVICE_UNAVAILABLE'],
  ])('maps %s to %i %s', async (error, status, code) => {
    const { app } = buildApp(error);

    const response = await request(app).get('/throw').expect(status);

    expect(response.body).toEqual({
      error: {
        code,
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
        requestId: response.get(REQUEST_ID_HEADER),
      },
    });
  });

  it('handles errors from rejected async handlers', async () => {
    const { app } = buildApp(new ConflictError());

    const response = await request(app).get('/reject').expect(409);

    expect(errorOf(response).code).toBe('CONFLICT');
  });

  it('sets WWW-Authenticate on 401 responses', async () => {
    const { app } = buildApp(new UnauthorizedError());

    const response = await request(app).get('/throw').expect(401);

    expect(response.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('sets Retry-After on 429 responses', async () => {
    const { app } = buildApp(new RateLimitError(42));

    const response = await request(app).get('/throw').expect(429);

    expect(response.get('Retry-After')).toBe('42');
  });

  it('hides unknown errors behind a generic 500 and logs them', async () => {
    const { app, capture } = buildApp(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );

    const response = await request(app).get('/throw').expect(500);

    const requestIdHeader = response.get(REQUEST_ID_HEADER);
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: requestIdHeader,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).toMatchObject({
      level: 50,
      reqId: requestIdHeader,
      msg: 'Unhandled error',
      err: { message: expect.stringContaining('ECONNREFUSED') as unknown },
    });
  });

  it('treats non-Error throwables as internal errors', async () => {
    const { app } = buildApp('a plain string');

    const response = await request(app).get('/throw').expect(500);

    expect(errorOf(response).code).toBe('INTERNAL_ERROR');
  });

  it('returns 400 INVALID_JSON for a malformed JSON body', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"phone": ')
      .expect(400);

    expect(errorOf(response)).toMatchObject({
      code: 'INVALID_JSON',
      message: 'Request body is not valid JSON',
    });
  });

  it('returns 413 PAYLOAD_TOO_LARGE for an oversized body', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post('/echo')
      .send({ filler: 'x'.repeat(2048) })
      .expect(413);

    expect(errorOf(response).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 400 BAD_REQUEST for other client-side parser errors', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{}')
      .expect(400);

    expect(errorOf(response).code).toBe('BAD_REQUEST');
  });

  it('returns 404 NOT_FOUND for unknown routes', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/nope').expect(404);

    expect(errorOf(response)).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  it('delegates to Express when headers were already sent', async () => {
    const { app, capture } = buildApp();

    await request(app)
      .get('/partial')
      .catch(() => undefined);

    expect(capture.lines).toHaveLength(0);
  });
});
