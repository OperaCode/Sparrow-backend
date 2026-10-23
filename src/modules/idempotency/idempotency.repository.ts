import { Prisma } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import type {
  IdempotencyBegin,
  IdempotencyClaim,
  IdempotencyStore,
} from "../../types/idempotency.js";

/** Longer than the 30s request timeout, so a live request is not reclaimed. */
const PROCESSING_LOCK_MS = 60_000;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function asJson(body: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
}

/**
 * The unique key is the lock. A completed row is replayed. A live processing
 * row refuses the duplicate. A lock older than the request timeout is taken
 * over, because the process that held it is gone.
 */
export function createIdempotencyRepository(
  prisma: PrismaClient,
): IdempotencyStore {
  return {
    async begin(claim: IdempotencyClaim): Promise<IdempotencyBegin> {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - PROCESSING_LOCK_MS);

      try {
        const created = await prisma.idempotencyRecord.create({
          data: {
            actorId: claim.actorId,
            scope: claim.scope,
            key: claim.key,
            requestHash: claim.requestHash,
            state: "processing",
            lockedAt: now,
          },
        });
        return { outcome: "started", id: created.id };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      return prisma.$transaction(async (tx) => {
        const existing = await tx.idempotencyRecord.findUnique({
          where: {
            actorId_scope_key: {
              actorId: claim.actorId,
              scope: claim.scope,
              key: claim.key,
            },
          },
        });
        // The insert that won the unique key may not be visible yet.
        if (existing === null) return { outcome: "in_progress" };
        if (existing.requestHash !== claim.requestHash) {
          return { outcome: "mismatch" };
        }
        if (existing.state === "completed") {
          if (existing.statusCode === null || existing.responseBody === null) {
            throw new Error(
              "Completed idempotency record is missing its response",
            );
          }
          return {
            outcome: "replay",
            statusCode: existing.statusCode,
            body: existing.responseBody,
          };
        }
        if (existing.lockedAt < staleBefore) {
          const reclaimed = await tx.idempotencyRecord.updateMany({
            where: {
              id: existing.id,
              state: "processing",
              lockedAt: { lt: staleBefore },
            },
            data: { lockedAt: now },
          });
          if (reclaimed.count === 1) {
            return { outcome: "started", id: existing.id };
          }
        }
        return { outcome: "in_progress" };
      });
    },

    async complete(id, statusCode, body) {
      if (
        !Number.isInteger(statusCode) ||
        statusCode < 100 ||
        statusCode >= 500
      ) {
        throw new Error(
          "Only a finished client response can be stored for replay",
        );
      }
      const updated = await prisma.idempotencyRecord.updateMany({
        where: { id, state: "processing" },
        data: {
          state: "completed",
          statusCode,
          responseBody: asJson(body),
          completedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new Error("Idempotency record was not awaiting completion");
      }
    },

    async abandon(id) {
      await prisma.idempotencyRecord.deleteMany({
        where: { id, state: "processing" },
      });
    },
  };
}
