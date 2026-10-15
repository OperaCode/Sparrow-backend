import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://sparrow:sparrow@localhost:5433/sparrow_test';

function resolveTestDatabaseUrl(): string {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/**
 * Tests truncate every table between cases, so refuse anything that is not
 * clearly a disposable test database.
 */
function assertDisposable(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${databaseName}": the database name must end in _test.`,
    );
  }
}

function resolvePrismaCli(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('prisma/package.json');
  const { bin } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin: { prisma: string };
  };
  return path.join(path.dirname(packageJsonPath), bin.prisma);
}

export default function setup(project: TestProject): void {
  const databaseUrl = resolveTestDatabaseUrl();
  assertDisposable(databaseUrl);

  // Applies pending migrations only; it never drops data or schema. Data is
  // isolated per test by truncation instead. Spawning node directly avoids
  // the npx/.cmd shim differences on Windows.
  execFileSync(process.execPath, [resolvePrismaCli(), 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  project.provide('databaseUrl', databaseUrl);
}
