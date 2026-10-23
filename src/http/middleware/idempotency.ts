import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { IdempotencyStore } from '../../types/idempotency.js';
import { ConflictError, ValidationError } from '../errors.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SCOPE_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/;

const KEY_MESSAGE =
  'Idempotency-Key must be 16 to 128 characters of letters, digits, "_" or "-"';

/**
 * Stable JSON so key order in the payload does not change the fingerprint.
 * Only JSON values are accepted; a Date or undefined means the handler saw
 * something the client did not send.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot fingerprint a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  throw new Error('Cannot fingerprint this request');
}

function fingerprint(body: unknown, params: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ body, params }))
    .digest('hex');
}

function readKey(header: string | undefined): string {
  if (header === undefined || !KEY_PATTERN.test(header)) {
    throw new ValidationError([
      { path: 'header.Idempotency-Key', message: KEY_MESSAGE },
    ]);
  }
  return header;
}

/**
 * Runs after authenticate and validate. A rejected payload never reaches
 * here, so correcting it can reuse the key. This guard only replays a result
 * that has already committed. The handler writes that result in the same
 * transaction as the order, and this guard never deletes a key.
 */
export function createIdempotency(
  store: IdempotencyStore,
): (scope: string) => RequestHandler {
  return (scope) => {
    if (!SCOPE_PATTERN.test(scope)) {
      throw new Error(`Invalid idempotency scope ${JSON.stringify(scope)}`);
    }

    return async (req, res, next) => {
      if (req.auth === undefined) {
        throw new Error('idempotency must be mounted after authenticate');
      }
      const claim = {
        actorId: req.auth.userId,
        scope,
        key: readKey(req.get(IDEMPOTENCY_KEY_HEADER)),
        requestHash: fingerprint(req.body, req.params),
      };
      const recovery = await store.recover(claim);

      if (recovery.outcome === 'replay') {
        res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
        res.status(recovery.statusCode).json(recovery.body);
        return;
      }
      if (recovery.outcome === 'mismatch') {
        throw new ConflictError(
          'This idempotency key was already used for a different request',
          'IDEMPOTENCY_CONFLICT',
        );
      }
      if (recovery.outcome === 'in_progress') {
        throw new ConflictError(
          'A request with this idempotency key is already in progress',
          'IDEMPOTENCY_IN_PROGRESS',
        );
      }

      req.idempotency = claim;
      next();
    };
  };
}
