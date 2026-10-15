import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from '../config/env.js';

export type { Logger } from 'pino';

export const REDACTED = '[Redacted]';

const SENSITIVE_KEYS = [
  'authorization',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'otp',
  'pin',
];

/**
 * Pino redaction paths have no recursive wildcard, so sensitive keys are
 * covered at the top level and one level deep. Never log deeper objects that
 * may hold credentials; pick the fields to log explicitly instead.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
];

interface LoggerOptions {
  level: Config['logLevel'];
  nodeEnv: Config['nodeEnv'];
}

/**
 * Pretty printing is only enabled in development and only when no explicit
 * destination is given, so tests can capture raw JSON lines.
 */
export function createLogger(
  options: LoggerOptions,
  destination?: DestinationStream,
): Logger {
  const usePrettyTransport =
    options.nodeEnv === 'development' && destination === undefined;

  return pino(
    {
      level: options.level,
      base: { service: 'sparrow-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      ...(usePrettyTransport && {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
    },
    destination,
  );
}
