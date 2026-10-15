import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LevelWithSilent } from 'pino';
import { pinoHttp, type HttpLogger } from 'pino-http';
import type { Logger } from '../../lib/logger.js';

const UNLOGGED_PATH_PREFIX = '/health';

interface SerializedRequest {
  id: unknown;
  method: string;
  url: string;
  remoteAddress?: string;
}

interface SerializedResponse {
  statusCode: number;
}

function levelFor(
  _req: IncomingMessage,
  res: ServerResponse,
  error?: Error,
): LevelWithSilent {
  if (error !== undefined || res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
}

/**
 * Logs one line per completed request. Headers, query strings and bodies are
 * deliberately left out: they are where tokens, phone numbers and OTPs live.
 * Must be mounted after requestId so pino-http reuses req.id.
 */
export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    quietReqLogger: true,
    customLogLevel: levelFor,
    autoLogging: {
      ignore: (req) => req.url?.startsWith(UNLOGGED_PATH_PREFIX) ?? false,
    },
    serializers: {
      req: (req: SerializedRequest) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
        remoteAddress: req.remoteAddress,
      }),
      res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
    },
  });
}
