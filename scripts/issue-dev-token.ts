import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ConfigError, loadConfig, type Config } from '../src/config/env.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { signAccessToken } from '../src/modules/auth/access-token.service.js';
import { ROLES } from '../src/types/auth.js';

const USAGE =
  'Usage: npm run token:dev -- --phone +2348012345678 --role customer|rider|admin';

const DEV_TOKEN_TTL_SECONDS = 60 * 60;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const argsSchema = z.object({
  phone: z
    .string()
    .regex(
      /^\+[1-9][0-9]{7,14}$/,
      'phone must be in E.164 form, e.g. +2348012345678',
    ),
  role: z.enum(ROLES),
});

class RefusedError extends Error {}

function fail(message: string): never {
  throw new RefusedError(message);
}

/**
 * Two independent guards: the environment must say development, and the
 * database must be on this machine. Either alone is easy to get wrong.
 */
function assertLocalDevelopment(config: Config): void {
  if (config.nodeEnv !== 'development') {
    fail(
      `Refusing to run: NODE_ENV is "${config.nodeEnv}", expected "development".`,
    );
  }
  const host = new URL(config.databaseUrl).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    fail('Refusing to run: DATABASE_URL does not point at a local database.');
  }
}

function parseCliArgs(): z.infer<typeof argsSchema> {
  const { values } = parseArgs({
    options: { phone: { type: 'string' }, role: { type: 'string' } },
    strict: true,
  });
  const result = argsSchema.safeParse(values);
  if (!result.success) {
    fail(
      `${result.error.issues.map((issue) => issue.message).join('; ')}\n${USAGE}`,
    );
  }
  return result.data;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
  assertLocalDevelopment(config);
  const args = parseCliArgs();

  // Writes through Prisma directly on purpose: no user-creation path exists in
  // application code until the OTP issue adds one.
  const prisma = createPrismaClient(config.databaseUrl);
  try {
    const user = await prisma.user.upsert({
      where: { phone: args.phone },
      create: { phone: args.phone, role: args.role },
      update: { role: args.role },
      select: { id: true, role: true, status: true },
    });
    const token = await signAccessToken(
      config.auth,
      user.id,
      DEV_TOKEN_TTL_SECONDS,
    );

    process.stderr.write(
      `User ${user.id} (${args.phone}) role=${user.role} status=${user.status}; token valid for 1 hour.\n`,
    );
    if (user.status !== 'active') {
      process.stderr.write(
        'Warning: this user is suspended, so the token will be rejected.\n',
      );
    }
    // Only the token goes to stdout, so it can be captured by a shell.
    process.stdout.write(`${token}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof RefusedError ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
