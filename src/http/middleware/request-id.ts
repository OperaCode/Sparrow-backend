import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Trusts a caller-supplied id only when it is short and charset-restricted, so
 * it cannot be used to inject content into logs or response headers.
 */
export function resolveRequestId(incoming: string | undefined): string {
  return incoming !== undefined && SAFE_REQUEST_ID.test(incoming)
    ? incoming
    : randomUUID();
}

const UNASSIGNED_REQUEST_ID = 'unassigned';

/**
 * pino-http types req.id as string | number | object. This middleware always
 * assigns a string, so anything else means it was not mounted first.
 */
export function getRequestId(req: Request): string {
  return typeof req.id === 'string' ? req.id : UNASSIGNED_REQUEST_ID;
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = resolveRequestId(req.get(REQUEST_ID_HEADER));
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
