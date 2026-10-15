import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/env.js';

const SECRET = 'x'.repeat(32);

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5433/sparrow_test',
    JWT_ACCESS_SECRET: SECRET,
    ...overrides,
  };
}

function captureConfigError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('Expected loadConfig to throw ConfigError');
}

describe('loadConfig', () => {
  it('applies defaults when only required variables are set', () => {
    const config = loadConfig(validEnv());

    expect(config).toEqual({
      nodeEnv: 'test',
      port: 4000,
      logLevel: 'info',
      databaseUrl: 'postgresql://user:pass@localhost:5433/sparrow_test',
      auth: {
        accessTokenSecret: SECRET,
        issuer: 'sparrow-api',
        audience: 'sparrow-app',
      },
      cors: { origins: [] },
      http: { trustProxy: 0 },
      rateLimit: { windowMs: 60_000, max: 100 },
    });
  });

  it('coerces numeric variables and parses CORS origins', () => {
    const config = loadConfig(
      validEnv({
        PORT: '8080',
        TRUST_PROXY: '1',
        RATE_LIMIT_WINDOW_MS: '30000',
        RATE_LIMIT_MAX: '20',
        CORS_ORIGINS: ' http://localhost:8081 , https://app.sparrow.ng ,',
      }),
    );

    expect(config.port).toBe(8080);
    expect(config.http.trustProxy).toBe(1);
    expect(config.rateLimit).toEqual({ windowMs: 30_000, max: 20 });
    expect(config.cors.origins).toEqual([
      'http://localhost:8081',
      'https://app.sparrow.ng',
    ]);
  });

  it('returns a deeply frozen object', () => {
    const config = loadConfig(validEnv());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
    expect(Object.isFrozen(config.cors.origins)).toBe(true);
  });

  it('reports every missing required variable', () => {
    const error = captureConfigError({});

    const paths = error.issues.map((issue) => issue.split(':')[0]);
    expect(paths).toEqual(
      expect.arrayContaining(['NODE_ENV', 'DATABASE_URL', 'JWT_ACCESS_SECRET']),
    );
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    const error = captureConfigError(
      validEnv({ JWT_ACCESS_SECRET: 'short-secret' }),
    );

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(/^JWT_ACCESS_SECRET:/);
  });

  it('never includes variable values in error messages', () => {
    const leakySecret = 'do-not-log-this-value';
    const leakyUrl = 'mysql://root:hunter2@db/sparrow';
    const error = captureConfigError(
      validEnv({ JWT_ACCESS_SECRET: leakySecret, DATABASE_URL: leakyUrl }),
    );

    expect(error.message).not.toContain(leakySecret);
    expect(error.message).not.toContain('hunter2');
    expect(error.issues.join(' ')).not.toContain(leakySecret);
  });

  describe('in production', () => {
    it('accepts https origins', () => {
      const config = loadConfig(
        validEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://app.sparrow.ng,https://admin.sparrow.ng',
        }),
      );

      expect(config.cors.origins).toEqual([
        'https://app.sparrow.ng',
        'https://admin.sparrow.ng',
      ]);
    });

    it('accepts an empty origin list', () => {
      const config = loadConfig(validEnv({ NODE_ENV: 'production' }));

      expect(config.cors.origins).toEqual([]);
    });

    it('rejects each non-https origin by index', () => {
      const error = captureConfigError(
        validEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS:
            'https://app.sparrow.ng,http://admin.sparrow.ng,http://localhost:8081',
        }),
      );

      expect(error.issues).toEqual([
        'CORS_ORIGINS.1: Origins must use https when NODE_ENV is production',
        'CORS_ORIGINS.2: Origins must use https when NODE_ENV is production',
      ]);
    });

    it.each(['development', 'test'])(
      'allows http origins when NODE_ENV is %s',
      (nodeEnv) => {
        const config = loadConfig(
          validEnv({
            NODE_ENV: nodeEnv,
            CORS_ORIGINS: 'http://localhost:8081',
          }),
        );

        expect(config.cors.origins).toEqual(['http://localhost:8081']);
      },
    );
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['PORT', '0'],
    ['PORT', 'not-a-number'],
    ['LOG_LEVEL', 'verbose'],
    ['DATABASE_URL', 'mysql://localhost/sparrow'],
    ['TRUST_PROXY', '-1'],
    ['RATE_LIMIT_WINDOW_MS', '500'],
    ['RATE_LIMIT_MAX', '0'],
    ['CORS_ORIGINS', 'not-a-url'],
    ['CORS_ORIGINS', 'https://app.sparrow.ng/path'],
  ])('rejects invalid %s=%s', (key, value) => {
    const error = captureConfigError(validEnv({ [key]: value }));

    const issuePattern = new RegExp(`^${key}(\\.\\d+)?:`);
    expect(error.issues.some((issue) => issuePattern.test(issue))).toBe(true);
  });
});
