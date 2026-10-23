export interface IdempotencyClaim {
  actorId: string;
  scope: string;
  key: string;
  requestHash: string;
}

export type IdempotencyBegin =
  | { outcome: 'started'; id: string }
  | { outcome: 'replay'; statusCode: number; body: unknown }
  | { outcome: 'mismatch' }
  | { outcome: 'in_progress' };

/**
 * Claims a key before the handler runs, then stores the client response or
 * drops the claim if the handler never produced one.
 */
export interface IdempotencyStore {
  begin(claim: IdempotencyClaim): Promise<IdempotencyBegin>;
  complete(id: string, statusCode: number, body: unknown): Promise<void>;
  abandon(id: string): Promise<void>;
}
