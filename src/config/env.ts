import { z } from 'zod';

const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

const MIN_JWT_SECRET_LENGTH = 32;

const originSchema = z
  .string()
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
    message: 'Expected a bare origin such as https://app.example.com',
  });

const corsOriginsSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(originSchema));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'Expected a postgresql:// connection URL'),
  JWT_ACCESS_SECRET: z.string().min(MIN_JWT_SECRET_LENGTH),
  JWT_ISSUER: z.string().min(1).default('sparrow-api'),
  JWT_AUDIENCE: z.string().min(1).default('sparrow-app'),
  CORS_ORIGINS: corsOriginsSchema,
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly auth: Readonly<{
    accessTokenSecret: string;
    issuer: string;
    audience: string;
  }>;
  readonly cors: Readonly<{ origins: readonly string[] }>;
  readonly http: Readonly<{ trustProxy: number }>;
  readonly rateLimit: Readonly<{ windowMs: number; max: number }>;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Issue messages reference variable names only. Values are never echoed, so a
 * misconfigured secret cannot end up in startup logs.
 */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `${path}: ${issue.message}`;
  });
}

type ParsedEnv = z.output<typeof envSchema>;

/**
 * Cross-field rules run only after the schema has passed, so they never see
 * partially parsed values.
 */
function productionIssues(env: ParsedEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];

  return env.CORS_ORIGINS.flatMap((origin, index) =>
    new URL(origin).protocol === 'https:'
      ? []
      : [
          `CORS_ORIGINS.${index}: Origins must use https when NODE_ENV is production`,
        ],
  );
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }

  const env = result.data;
  const issues = productionIssues(env);
  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    auth: Object.freeze({
      accessTokenSecret: env.JWT_ACCESS_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }),
    cors: Object.freeze({ origins: Object.freeze([...env.CORS_ORIGINS]) }),
    http: Object.freeze({ trustProxy: env.TRUST_PROXY }),
    rateLimit: Object.freeze({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
    }),
  });
}
