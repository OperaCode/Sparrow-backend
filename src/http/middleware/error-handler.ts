import type { ErrorRequestHandler, Response } from 'express';
import type { Logger } from '../../lib/logger.js';
import {
  AppError,
  BadRequestError,
  PayloadTooLargeError,
  RateLimitError,
  UnauthorizedError,
} from '../errors.js';
import type { ErrorBody } from '../response.js';
import { getRequestId } from './request-id.js';

interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    error instanceof Error &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

/**
 * Translates errors raised by Express' body parser into AppErrors. Their own
 * messages can echo parser internals, so they are replaced, not forwarded.
 */
function fromBodyParser(error: BodyParserError): AppError | undefined {
  if (error.type === 'entity.parse.failed') {
    return new BadRequestError(
      'Request body is not valid JSON',
      'INVALID_JSON',
    );
  }
  if (error.type === 'entity.too.large') {
    return new PayloadTooLargeError();
  }
  if (error.status >= 400 && error.status < 500) {
    return new BadRequestError();
  }
  return undefined;
}

function toAppError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  if (isBodyParserError(error)) return fromBodyParser(error);
  return undefined;
}

function setErrorHeaders(res: Response, error: AppError): void {
  if (error instanceof UnauthorizedError) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  if (error instanceof RateLimitError) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = toAppError(error);

    if (appError === undefined) {
      logger.error({ err: error, reqId: getRequestId(req) }, 'Unhandled error');
      const body: ErrorBody = {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          requestId: getRequestId(req),
        },
      };
      res.status(500).json(body);
      return;
    }

    setErrorHeaders(res, appError);
    const body: ErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details !== undefined && { details: appError.details }),
        requestId: getRequestId(req),
      },
    };
    res.status(appError.statusCode).json(body);
  };
}
