export interface IdempotencyClaim {
  actorId: string;
  scope: string;
  key: string;
  requestHash: string;
}

export type IdempotencyRecovery =
  | { outcome: 'fresh' }
  | { outcome: 'replay'; statusCode: number; body: unknown }
  | { outcome: 'mismatch' }
  | { outcome: 'in_progress' };

/**
 * Reads a result that has already committed. It does not insert, replace, or
 * delete a key. The write belongs in the same transaction as the order.
 */
export interface IdempotencyStore {
  recover(claim: IdempotencyClaim): Promise<IdempotencyRecovery>;
}

declare global {
  namespace Express {
    interface Request {
      idempotency?: IdempotencyClaim;
    }
  }
}
