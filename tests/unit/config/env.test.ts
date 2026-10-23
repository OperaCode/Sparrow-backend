import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/env.js';
import {
  base64,
  encodedServiceAccount as encodedAccount,
  TEST_PRIVATE_KEY_PEM as PRIVATE_KEY_PEM,
  TEST_PUBLIC_KEY_PEM as PUBLIC_KEY_PEM,
  TEST_SERVICE_ACCOUNT as SERVICE_ACCOUNT,
} from '../../helpers/firebase-service-account.js';

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
      session: {
        accessTokenTtlSeconds: 900,
        refreshTokenTtlDays: 30,
        maxAgeDays: 90,
        maxFirebaseAuthAgeSeconds: 300,
        refreshReuseGraceSeconds: 30,
      },
      authRateLimit: {
        exchange: { windowMs: 900_000, max: 30 },
        refresh: { windowMs: 900_000, max: 30 },
      },
      firebase: null,
    });
  });

  it('coerces the session and auth rate limit variables', () => {
    const config = loadConfig(
      validEnv({
        AUTH_ACCESS_TOKEN_TTL_SECONDS: '600',
        AUTH_REFRESH_TOKEN_TTL_DAYS: '14',
        AUTH_SESSION_MAX_AGE_DAYS: '60',
        AUTH_FIREBASE_MAX_AUTH_AGE_SECONDS: '120',
        AUTH_REFRESH_REUSE_GRACE_SECONDS: '0',
        AUTH_EXCHANGE_RATE_LIMIT_WINDOW_MS: '60000',
        AUTH_EXCHANGE_RATE_LIMIT_MAX: '5',
        AUTH_REFRESH_RATE_LIMIT_WINDOW_MS: '120000',
        AUTH_REFRESH_RATE_LIMIT_MAX: '10',
      }),
    );

    expect(config.session).toEqual({
      accessTokenTtlSeconds: 600,
      refreshTokenTtlDays: 14,
      maxAgeDays: 60,
      maxFirebaseAuthAgeSeconds: 120,
      refreshReuseGraceSeconds: 0,
    });
    expect(config.authRateLimit).toEqual({
      exchange: { windowMs: 60_000, max: 5 },
      refresh: { windowMs: 120_000, max: 10 },
    });
  });

  it('accepts a refresh token TTL equal to the session max age', () => {
    const config = loadConfig(
      validEnv({
        AUTH_REFRESH_TOKEN_TTL_DAYS: '45',
        AUTH_SESSION_MAX_AGE_DAYS: '45',
      }),
    );

    expect(config.session.refreshTokenTtlDays).toBe(45);
  });

  it('rejects a refresh token TTL longer than the session max age', () => {
    const error = captureConfigError(
      validEnv({
        AUTH_REFRESH_TOKEN_TTL_DAYS: '31',
        AUTH_SESSION_MAX_AGE_DAYS: '30',
      }),
    );

    expect(error.issues).toEqual([
      'AUTH_REFRESH_TOKEN_TTL_DAYS: Must not exceed AUTH_SESSION_MAX_AGE_DAYS',
    ]);
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
    expect(Object.isFrozen(config.session)).toBe(true);
    expect(Object.isFrozen(config.authRateLimit.exchange)).toBe(true);
    expect(Object.isFrozen(config.authRateLimit.refresh)).toBe(true);
  });

  describe('Firebase service account', () => {
    it('decodes a base64 service account key file', () => {
      const config = loadConfig(
        validEnv({ FIREBASE_SERVICE_ACCOUNT_BASE64: encodedAccount() }),
      );

      expect(config.firebase).toEqual({
        projectId: SERVICE_ACCOUNT.project_id,
        clientEmail: SERVICE_ACCOUNT.client_email,
        privateKey: PRIVATE_KEY_PEM,
      });
      expect(Object.isFrozen(config.firebase)).toBe(true);
    });

    it('ignores whitespace and line breaks in the base64 text', () => {
      const wrapped = encodedAccount().replace(/(.{76})/g, '$1\n');

      const config = loadConfig(
        validEnv({ FIREBASE_SERVICE_ACCOUNT_BASE64: ` ${wrapped}\n` }),
      );

      expect(config.firebase?.projectId).toBe(SERVICE_ACCOUNT.project_id);
    });

    it.each(['', '   '])(
      'treats %j as not configured outside production',
      (value) => {
        const config = loadConfig(
          validEnv({ FIREBASE_SERVICE_ACCOUNT_BASE64: value }),
        );

        expect(config.firebase).toBeNull();
      },
    );

    it.each([
      ['text that is not base64', 'not base64!'],
      ['base64 of text that is not JSON', base64('not json')],
      ['base64 of a JSON string', base64('"service_account"')],
      ['base64 of a JSON array', base64('[]')],
      ['the wrong key type', encodedAccount({ type: 'authorized_user' })],
      ['a missing project id', encodedAccount({ project_id: undefined })],
      ['an invalid project id', encodedAccount({ project_id: 'Sparrow_Prod' })],
      ['a missing client email', encodedAccount({ client_email: undefined })],
      [
        'a client email that is not a service account',
        encodedAccount({ client_email: 'someone@gmail.com' }),
      ],
      ['a missing private key', encodedAccount({ private_key: undefined })],
      [
        'a private key that is not PEM',
        encodedAccount({ private_key: 'not-a-key' }),
      ],
      [
        'a public key in place of the private key',
        encodedAccount({ private_key: PUBLIC_KEY_PEM }),
      ],
    ])('rejects %s', (_label, value) => {
      const error = captureConfigError(
        validEnv({ FIREBASE_SERVICE_ACCOUNT_BASE64: value }),
      );

      expect(error.issues.length).toBeGreaterThan(0);
      for (const issue of error.issues) {
        expect(issue).toMatch(/^FIREBASE_SERVICE_ACCOUNT_BASE64: /);
      }
    });

    it('never includes key material or decoded text in error messages', () => {
      const leakyKey = 'do-not-log-this-private-key';
      const leakyText = 'do-not-log-this-decoded-text';

      const badKey = captureConfigError(
        validEnv({
          FIREBASE_SERVICE_ACCOUNT_BASE64: encodedAccount({
            private_key: leakyKey,
          }),
        }),
      );
      const badJson = captureConfigError(
        validEnv({ FIREBASE_SERVICE_ACCOUNT_BASE64: base64(leakyText) }),
      );

      expect(badKey.message).not.toContain(leakyKey);
      expect(badJson.message).not.toContain(leakyText);
      expect(badKey.message).not.toContain('BEGIN PRIVATE KEY');
    });
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
    function productionEnv(overrides: NodeJS.ProcessEnv = {}) {
      return validEnv({
        NODE_ENV: 'production',
        FIREBASE_SERVICE_ACCOUNT_BASE64: encodedAccount(),
        ...overrides,
      });
    }

    it('accepts https origins', () => {
      const config = loadConfig(
        productionEnv({
          CORS_ORIGINS: 'https://app.sparrow.ng,https://admin.sparrow.ng',
        }),
      );

      expect(config.cors.origins).toEqual([
        'https://app.sparrow.ng',
        'https://admin.sparrow.ng',
      ]);
    });

    it('accepts an empty origin list', () => {
      const config = loadConfig(productionEnv());

      expect(config.cors.origins).toEqual([]);
    });

    it.each([undefined, ''])(
      'requires the Firebase service account when it is %j',
      (value) => {
        const error = captureConfigError(
          productionEnv({ FIREBASE_SERVICE_ACCOUNT_BASE64: value }),
        );

        expect(error.issues).toEqual([
          'FIREBASE_SERVICE_ACCOUNT_BASE64: Required when NODE_ENV is production',
        ]);
      },
    );

    it('rejects each non-https origin by index', () => {
      const error = captureConfigError(
        productionEnv({
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
    ['AUTH_ACCESS_TOKEN_TTL_SECONDS', '59'],
    ['AUTH_ACCESS_TOKEN_TTL_SECONDS', '3601'],
    ['AUTH_REFRESH_TOKEN_TTL_DAYS', '0'],
    ['AUTH_REFRESH_TOKEN_TTL_DAYS', '1.5'],
    ['AUTH_SESSION_MAX_AGE_DAYS', '366'],
    ['AUTH_FIREBASE_MAX_AUTH_AGE_SECONDS', '29'],
    ['AUTH_FIREBASE_MAX_AUTH_AGE_SECONDS', '3601'],
    ['AUTH_REFRESH_REUSE_GRACE_SECONDS', '-1'],
    ['AUTH_REFRESH_REUSE_GRACE_SECONDS', '301'],
    ['AUTH_REFRESH_REUSE_GRACE_SECONDS', '2.5'],
    ['AUTH_EXCHANGE_RATE_LIMIT_WINDOW_MS', '999'],
    ['AUTH_EXCHANGE_RATE_LIMIT_MAX', '0'],
    ['AUTH_REFRESH_RATE_LIMIT_WINDOW_MS', 'not-a-number'],
    ['AUTH_REFRESH_RATE_LIMIT_MAX', '-1'],
  ])('rejects invalid %s=%s', (key, value) => {
    const error = captureConfigError(validEnv({ [key]: value }));

    const issuePattern = new RegExp(`^${key}(\\.\\d+)?:`);
    expect(error.issues.some((issue) => issuePattern.test(issue))).toBe(true);
  });
});
