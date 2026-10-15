import type { Logger } from '../../lib/logger.js';
import type { HealthRepository } from './health.repository.js';

export type DependencyState = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: { database: DependencyState };
}

export interface HealthService {
  checkReadiness(): Promise<ReadinessReport>;
}

interface HealthServiceOptions {
  repository: HealthRepository;
  logger: Logger;
  timeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2000;

class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Check timed out after ${timeoutMs}ms`);
    this.name = 'CheckTimeoutError';
  }
}

/**
 * A hung database must not hang the readiness probe, otherwise the platform's
 * health check times out instead of receiving a clear 503.
 */
async function withTimeout(
  check: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CheckTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthService(
  options: HealthServiceOptions,
): HealthService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  return {
    async checkReadiness() {
      try {
        await withTimeout(options.repository.pingDatabase(), timeoutMs);
        return { ready: true, checks: { database: 'up' } };
      } catch (error) {
        options.logger.warn({ err: error }, 'Readiness check failed: database');
        return { ready: false, checks: { database: 'down' } };
      }
    },
  };
}
