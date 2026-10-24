import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessTokenVerifier } from '#src/modules/auth/access-token.service.js';
import { parseRefreshToken } from '#src/modules/auth/refresh-token.js';
import { createUsersRepository } from '#src/modules/users/users.repository.js';
import { testConfig, TEST_JWT_SECRET } from '../../helpers/app.js';
import {
  createTestPrisma,
  testDatabaseUrl,
  truncateAllTables,
} from '../../helpers/database.js';
import { encodedServiceAccount } from '../../helpers/firebase-service-account.js';

const prisma = createTestPrisma();
const SCRIPT = path.resolve('scripts/issue-dev-token.ts');

function tsxCli(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('tsx/package.json');
  const { bin } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin: string;
  };
  return path.join(path.dirname(packageJsonPath), bin);
}

const TSX_CLI = tsxCli();

// Each test spawns tsx in a fresh process, which takes 3 to 4 seconds on
// Windows and leaves no headroom under the 5 second default.
const SCRIPT_TEST_TIMEOUT_MS = 20_000;

function runScript(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      JWT_ACCESS_SECRET: TEST_JWT_SECRET,
      DATABASE_URL: testDatabaseUrl(),
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
  };
}

interface PrintedTokens {
  tokenType: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

function printedTokens(stdout: string): PrintedTokens {
  expect(stdout.split('\n')).toHaveLength(1);
  return JSON.parse(stdout) as PrintedTokens;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('issue-dev-token script', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  it.each(['production', 'test'])(
    'refuses to run when NODE_ENV is %s',
    async (nodeEnv) => {
      const result = runScript(
        ['--phone', '+2348040000001', '--role', 'admin'],
        // A complete production config, so the script's own guard is what
        // refuses rather than config validation.
        {
          NODE_ENV: nodeEnv,
          FIREBASE_SERVICE_ACCOUNT_BASE64: encodedServiceAccount(),
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        `Refusing to run: NODE_ENV is "${nodeEnv}"`,
      );
      await expect(prisma.user.count()).resolves.toBe(0);
    },
  );

  it('refuses to run against a non-local database', () => {
    const result = runScript(['--phone', '+2348040000001', '--role', 'admin'], {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/sparrow',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not point at a local database');
  });

  it.each([
    ['a foreign number', '+14155550123'],
    ['a Nigerian landline', '012345678'],
  ])('rejects %s with usage help', async (_label, phone) => {
    const result = runScript(['--phone', phone, '--role', 'admin'], {
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Nigerian mobile number');
    expect(result.stderr).toContain('Usage:');
    await expect(prisma.user.count()).resolves.toBe(0);
  });

  it('creates a user and session and prints both tokens as one JSON line', async () => {
    const result = runScript(['--phone', '+2348040000002', '--role', 'admin'], {
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({
      where: { phone: '+2348040000002' },
    });
    expect(user).toMatchObject({
      role: 'admin',
      accountType: 'standard',
      name: null,
      community: null,
    });

    const tokens = printedTokens(result.stdout);
    expect(tokens.tokenType).toBe('Bearer');
    const verifier = createAccessTokenVerifier(testConfig().auth);
    const claims = await verifier.verify(tokens.accessToken);
    expect(claims.userId).toBe(user.id);

    const refresh = parseRefreshToken(tokens.refreshToken);
    expect(refresh?.sessionId).toBe(claims.sessionId);
    const session = await prisma.authSession.findUniqueOrThrow({
      where: { id: claims.sessionId },
    });
    expect(session).toMatchObject({
      userId: user.id,
      firebaseUid: `dev:${user.id}`,
      revokedAt: null,
    });
    expect(session.refreshTokenHash).toEqual(refresh?.hash);
    expect(new Date(tokens.refreshTokenExpiresAt)).toEqual(
      session.refreshExpiresAt,
    );
    await expect(
      createUsersRepository(prisma).findAuthSubject(user.id, session.id),
    ).resolves.toEqual({ id: user.id, role: 'admin', status: 'active' });
  });

  it('accepts a local-format number and stores it in E.164', async () => {
    const result = runScript(['--phone', '0804 000 0004', '--role', 'rider'], {
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(0);
    await expect(
      prisma.user.findUnique({ where: { phone: '+2348040000004' } }),
    ).resolves.toMatchObject({ role: 'rider' });
  });

  it('reuses an existing user and applies the requested role', async () => {
    const existing = await prisma.user.create({
      data: {
        phone: '+2348040000003',
        role: 'customer',
        name: 'Ada',
        community: 'ketu',
        accountType: 'business',
      },
    });

    const result = runScript(['--phone', '+2348040000003', '--role', 'rider'], {
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(0);
    expect(printedTokens(result.stdout).tokenType).toBe('Bearer');
    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: existing.id,
      role: 'rider',
      name: 'Ada',
      community: 'ketu',
      accountType: 'business',
    });
  });
});
