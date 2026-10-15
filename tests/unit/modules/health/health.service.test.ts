import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../../src/lib/logger.js';
import { createHealthService } from '../../../../src/modules/health/health.service.js';
import { createLogCapture } from '../../../helpers/log-capture.js';

function serviceWith(pingDatabase: () => Promise<void>, timeoutMs = 50) {
  const logs = createLogCapture();
  const logger = createLogger({ level: 'info', nodeEnv: 'test' }, logs.stream);
  const service = createHealthService({
    repository: { pingDatabase },
    logger,
    timeoutMs,
  });
  return { service, logs };
}

describe('health service', () => {
  it('reports ready when the database responds', async () => {
    const { service, logs } = serviceWith(() => Promise.resolve());

    await expect(service.checkReadiness()).resolves.toEqual({
      ready: true,
      checks: { database: 'up' },
    });
    expect(logs.lines).toHaveLength(0);
  });

  it('reports not ready and logs when the database errors', async () => {
    const { service, logs } = serviceWith(() =>
      Promise.reject(new Error('connection refused')),
    );

    await expect(service.checkReadiness()).resolves.toEqual({
      ready: false,
      checks: { database: 'down' },
    });
    expect(logs.lines[0]).toMatchObject({
      level: 40,
      msg: 'Readiness check failed: database',
      err: { message: 'connection refused' },
    });
  });

  it('reports not ready when the database does not answer in time', async () => {
    const { service, logs } = serviceWith(
      () => new Promise<void>(() => undefined),
      20,
    );

    const started = Date.now();
    const report = await service.checkReadiness();

    expect(report).toEqual({ ready: false, checks: { database: 'down' } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logs.lines[0]).toMatchObject({
      err: { message: 'Check timed out after 20ms' },
    });
  });
});
