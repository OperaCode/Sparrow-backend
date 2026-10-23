import type { Prisma } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import type {
  IdempotencyClaim,
  IdempotencyRecovery,
  IdempotencyStore,
} from "../../types/idempotency.js";

type IdempotencyDb = Prisma.TransactionClient | PrismaClient;

function asJson(body: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
}

/**
 * A committed row is replayed. A different body is a conflict. Anything else
 * is left untouched, so a retry cannot start a second order.
 */
export async function readIdempotentResult(
  db: IdempotencyDb,
  claim: IdempotencyClaim,
): Promise<IdempotencyRecovery> {
  const existing = await db.idempotencyRecord.findUnique({
    where: {
      actorId_scope_key: {
        actorId: claim.actorId,
        scope: claim.scope,
        key: claim.key,
      },
    },
  });
  if (existing === null) return { outcome: "fresh" };
  if (existing.requestHash !== claim.requestHash) {
    return { outcome: "mismatch" };
  }
  if (
    existing.state !== "completed" ||
    existing.statusCode === null ||
    existing.responseBody === null
  ) {
    return { outcome: "in_progress" };
  }
  return {
    outcome: "replay",
    statusCode: existing.statusCode,
    body: existing.responseBody,
  };
}

/**
 * Inserts the finished response. Call this inside the transaction that inserts
 * the order. A rollback removes both, so the key is not stored.
 */
export async function saveIdempotentResult(
  tx: Prisma.TransactionClient,
  claim: IdempotencyClaim,
  statusCode: number,
  body: unknown,
): Promise<void> {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode >= 500) {
    throw new Error("Only a finished client response can be stored for replay");
  }
  await tx.idempotencyRecord.create({
    data: {
      actorId: claim.actorId,
      scope: claim.scope,
      key: claim.key,
      requestHash: claim.requestHash,
      state: "completed",
      statusCode,
      responseBody: asJson(body),
      completedAt: new Date(),
    },
  });
}

export function createIdempotencyRepository(
  prisma: PrismaClient,
): IdempotencyStore {
  return {
    recover(claim) {
      return readIdempotentResult(prisma, claim);
    },
  };
}
