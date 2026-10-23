import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createErrorHandler } from '#src/http/middleware/error-handler.js';
import { requestId } from '#src/http/middleware/request-id.js';
import { validate } from '#src/http/middleware/validate.js';
import { createLogger } from '#src/lib/logger.js';
import { errorOf } from '../../helpers/http.js';
import { createLogCapture } from '../../helpers/log-capture.js';

const paramsSchema = z.strictObject({ id: z.uuid() });
const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const bodySchema = z.strictObject({
  name: z.string().trim().min(1),
  role: z.enum(['customer', 'rider']),
});

function buildApp() {
  const logger = createLogger(
    { level: 'silent', nodeEnv: 'test' },
    createLogCapture().stream,
  );
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.post(
    '/items/:id',
    validate({ params: paramsSchema, query: querySchema, body: bodySchema }),
    (req, res) => {
      res.json({
        params: req.params,
        query: req.query,
        body: req.body as unknown,
      });
    },
  );
  app.use(createErrorHandler(logger));
  return app;
}

const VALID_ID = '3f0e0c9a-6b1e-4c43-9a51-2c4b0f6d8a11';

describe('validate middleware', () => {
  it('replaces params, query and body with parsed output', async () => {
    const response = await request(buildApp())
      .post(`/items/${VALID_ID}?limit=5`)
      .send({ name: '  Ada  ', role: 'rider' })
      .expect(200);

    expect(response.body).toEqual({
      params: { id: VALID_ID },
      query: { limit: 5 },
      body: { name: 'Ada', role: 'rider' },
    });
  });

  it('applies schema defaults', async () => {
    const response = await request(buildApp())
      .post(`/items/${VALID_ID}`)
      .send({ name: 'Ada', role: 'customer' })
      .expect(200);

    expect(response.body).toMatchObject({ query: { limit: 20 } });
  });

  it('collects issues from every location into one 400 response', async () => {
    const response = await request(buildApp())
      .post('/items/not-a-uuid?limit=500')
      .send({ role: 'admin' })
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    const paths = (errorOf(response).details ?? []).map(
      (detail) => detail.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        'params.id',
        'query.limit',
        'body.name',
        'body.role',
      ]),
    );
  });

  it('rejects unknown body fields such as a client-sent price', async () => {
    const response = await request(buildApp())
      .post(`/items/${VALID_ID}`)
      .send({ name: 'Ada', role: 'customer', price: 0 })
      .expect(400);

    expect(errorOf(response).details).toEqual([
      { path: 'body', message: expect.stringContaining('price') as unknown },
    ]);
  });

  it('returns the same details, sorted by path, for the same invalid payload', async () => {
    const send = () =>
      request(buildApp())
        .post('/items/not-a-uuid?limit=0')
        .send({ name: '', role: 'nope' });

    const first = await send().expect(400);
    const second = await send().expect(400);

    expect(errorOf(first).details).toEqual(errorOf(second).details);
    const paths = (errorOf(first).details ?? []).map((detail) => detail.path);
    expect(paths).toEqual(
      [...paths].sort((left, right) => left.localeCompare(right)),
    );
    expect(paths[0]).toBe('body.name');
  });

  it('rejects a missing body', async () => {
    const response = await request(buildApp())
      .post(`/items/${VALID_ID}`)
      .expect(400);

    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
  });
});
