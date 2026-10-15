import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessTokenVerifier } from '../../../src/modules/auth/access-token.service.js';
import { testConfig, TEST_JWT_SECRET } from '../../helpers/app.js';
import {
  createTestPrisma,
  testDatabaseUrl,
  truncateAllTables,
} from '../../helpers/database.js';

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

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('issue-dev-token script', () => {
  it.each(['production', 'test'])(
    'refuses to run when NODE_ENV is %s',
    async (nodeEnv) => {
      const result = runScript(
        ['--phone', '+2348040000001', '--role', 'admin'],
        { NODE_ENV: nodeEnv },
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

  it('rejects an invalid phone number with usage help', () => {
    const result = runScript(['--phone', '08012345678', '--role', 'admin'], {
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E.164');
    expect(result.stderr).toContain('Usage:');
  });

  it('creates a user and prints a verifiable token', async () => {
    const result = runScript(['--phone', '+2348040000002', '--role', 'admin'], {
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({
      where: { phone: '+2348040000002' },
    });
    expect(user.role).toBe('admin');
    const verifier = createAccessTokenVerifier(testConfig().auth);
    await expect(verifier.verify(result.stdout)).resolves.toEqual({
      userId: user.id,
    });
  });

  it('reuses an existing user and applies the requested role', async () => {
    const existing = await prisma.user.create({
      data: { phone: '+2348040000003', role: 'customer' },
    });

    const result = runScript(['--phone', '+2348040000003', '--role', 'rider'], {
      NODE_ENV: 'development',
    });

    expect(result.status).toBe(0);
    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: existing.id, role: 'rider' });
  });
});
