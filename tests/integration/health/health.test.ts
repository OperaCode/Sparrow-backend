import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createHealthRepository } from '../../../src/modules/health/health.repository.js';
import { buildTestApp } from '../../helpers/app.js';
import { createTestPrisma } from '../../helpers/database.js';

const prisma = createTestPrisma();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('health endpoints against PostgreSQL', () => {
  it('reports the database as up', async () => {
    const { app } = buildTestApp({
      healthRepository: createHealthRepository(prisma),
    });

    const response = await request(app).get('/health/ready').expect(200);

    expect(response.body).toEqual({
      data: { status: 'ok', checks: { database: 'up' } },
    });
  });
});
