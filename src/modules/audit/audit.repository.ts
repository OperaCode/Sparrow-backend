import type { Prisma } from '../../generated/prisma/client.js';

export const AUDIT_ACTIONS = [
  'user.provision',
  'user.status.update',
  'user.role.update',
  'pricing.rule.update',
  'pricing.area.update',
  'order.manual_quote',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditTargetType = 'user' | 'price_rule' | 'service_area' | 'order';

/** Flat values only, so a nested token or receipt cannot land in the trail. */
export type AuditValue = string | number | boolean | null;

export type AuditMetadata = Readonly<Record<string, AuditValue>>;

export interface AuditEvent {
  actorId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  requestId: string;
  metadata: AuditMetadata;
}

/** The transaction that is also writing the privileged change. */
export type AuditDb = Prisma.TransactionClient;

export interface AuditRepository {
  record(db: AuditDb, event: AuditEvent): Promise<void>;
}

/**
 * The trail is written on the caller's transaction, so a privileged change
 * cannot commit without the event that describes it.
 */
export function createAuditRepository(): AuditRepository {
  return {
    async record(db, event) {
      await db.auditEvent.create({
        data: {
          actorId: event.actorId,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          requestId: event.requestId,
          metadata: event.metadata,
        },
      });
    },
  };
}
