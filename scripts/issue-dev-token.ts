import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ConfigError, loadConfig, type Config } from '../src/config/env.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { normaliseNigerianMobile } from '../src/modules/auth/phone.js';
import { createSessionTokens } from '../src/modules/auth/session-tokens.js';
import { createSessionsRepository } from '../src/modules/auth/sessions.repository.js';
import { ROLES } from '../src/types/auth.js';

const USAGE =
  'Usage: npm run token:dev -- --phone +2348012345678 --role customer|rider|admin';

const DEV_TOKEN_TTL_SECONDS = 60 * 60;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const argsSchema = z.object({
  phone: z.string().transform((value, ctx) => {
    const phone = normaliseNigerianMobile(value);
    if (phone === null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'phone must be a Nigerian mobile number, e.g. +2348012345678 or 08012345678',
      });
      return z.NEVER;
    }
    return phone;
  }),
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

function parseCliArgs(): z.output<typeof argsSchema> {
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

  // Writes the user through Prisma directly: application code never assigns
  // a role, and this script has to.
  const prisma = createPrismaClient(config.databaseUrl);
  try {
    const user = await prisma.user.upsert({
      where: { phone: args.phone },
      create: { phone: args.phone, role: args.role },
      update: { role: args.role },
      select: { id: true, role: true, status: true },
    });
    // No Firebase sign-in happened, so a synthetic uid and the issue time
    // stand in for the unique sign-in pair.
    const tokens = await createSessionTokens({
      config,
      sessions: createSessionsRepository(prisma),
    }).open({
      userId: user.id,
      firebaseUid: `dev:${user.id}`,
      firebaseAuthTime: new Date(),
      accessTokenTtlSeconds: DEV_TOKEN_TTL_SECONDS,
    });
    if (tokens === null) {
      fail('Could not open a session; run the script again.');
    }

    process.stderr.write(
      `User ${user.id} (${args.phone}) role=${user.role} status=${user.status}; access token valid for 1 hour, refresh token until ${tokens.refreshTokenExpiresAt.toISOString()}.\n`,
    );
    if (user.status !== 'active') {
      process.stderr.write(
        'Warning: this user is suspended, so the tokens will be rejected.\n',
      );
    }
    // Only the tokens go to stdout, as one JSON line a shell can capture.
    process.stdout.write(`${JSON.stringify(tokens)}\n`);
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
