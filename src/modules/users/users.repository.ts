import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { AccountStatus, AuditActor, Role } from '../../types/auth.js';
import {
  createAuditRepository,
  type AuditMetadata,
  type AuditRepository,
} from '../audit/audit.repository.js';
import type {
  NewAccount,
  ProfilePatch,
  ProvisionRole,
  UserProfile,
} from './users.types.js';

export interface AuthSubject {
  id: string;
  role: Role;
  status: AccountStatus;
}

export interface SignedInUser extends AuthSubject {
  phone: string;
  created: boolean;
}

export interface UsersRepository {
  findAuthSubject(
    userId: string,
    sessionId: string,
  ): Promise<AuthSubject | null>;
  upsertCustomerByPhone(phone: string): Promise<SignedInUser>;
  findById(id: string): Promise<UserProfile | null>;
  findByPhone(phone: string): Promise<UserProfile | null>;
  insertCustomer(phone: string): Promise<UserProfile | 'conflict'>;
  insertProvisioned(
    account: NewAccount,
    actor: AuditActor,
  ): Promise<UserProfile | 'conflict'>;
  updateProfile(id: string, patch: ProfilePatch): Promise<UserProfile | null>;
  /** Own-account status. Not an admin action, so it is not audited. */
  updateOwnStatus(
    id: string,
    status: AccountStatus,
  ): Promise<UserProfile | null>;
  updateStatus(
    id: string,
    status: AccountStatus,
    actor: AuditActor,
  ): Promise<UserProfile | null>;
  updateRole(
    id: string,
    role: ProvisionRole,
    actor: AuditActor,
  ): Promise<UserProfile | null>;
}

const profileSelect = {
  id: true,
  phone: true,
  name: true,
  community: true,
  accountType: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type SignedInRow = Omit<SignedInUser, 'created'>;

const signedInColumns = Prisma.sql`
  "id", "phone", "role"::text AS "role", "status"::text AS "status"
`;

const SIGN_IN_ATTEMPTS = 2;

function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export function createUsersRepository(prisma: PrismaClient): UsersRepository {
  const audit: AuditRepository = createAuditRepository();
  async function insert(
    data: Prisma.UserCreateInput,
  ): Promise<UserProfile | 'conflict'> {
    try {
      return await prisma.user.create({ data, select: profileSelect });
    } catch (error) {
      if (isUniqueViolation(error)) return 'conflict';
      throw error;
    }
  }

  async function update(
    id: string,
    data: Prisma.UserUpdateInput,
  ): Promise<UserProfile | null> {
    try {
      return await prisma.user.update({
        where: { id },
        data,
        select: profileSelect,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  async function commitChange(
    id: string,
    data: Prisma.UserUpdateInput,
    actor: AuditActor,
    action: 'user.status.update' | 'user.role.update',
    changes: (before: UserProfile, after: UserProfile) => AuditMetadata,
  ): Promise<UserProfile | null> {
    try {
      return await prisma.$transaction(async (tx) => {
        const before = await tx.user.findUnique({
          where: { id },
          select: profileSelect,
        });
        if (before === null) return null;
        const after = await tx.user.update({
          where: { id },
          data,
          select: profileSelect,
        });
        await audit.record(tx, {
          actorId: actor.actorId,
          requestId: actor.requestId,
          action,
          targetType: 'user',
          targetId: after.id,
          metadata: changes(before, after),
        });
        return after;
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  return {
    /**
     * One primary-key lookup on the session, joined to its user. A revoked or
     * fully expired session makes every access token issued for it invalid.
     * The idle refresh expiry is deliberately not checked: it governs refresh,
     * and access tokens are short-lived.
     */
    async findAuthSubject(userId, sessionId) {
      const rows = await prisma.$queryRaw<AuthSubject[]>`
        SELECT u."id", u."role"::text AS "role", u."status"::text AS "status"
        FROM "auth_sessions" s
        JOIN "users" u ON u."id" = s."user_id"
        WHERE s."id" = CAST(${sessionId} AS uuid)
          AND s."user_id" = CAST(${userId} AS uuid)
          AND s."revoked_at" IS NULL
          AND s."absolute_expires_at" > now()
      `;
      return rows[0] ?? null;
    },

    /**
     * Race-safe sign-up or sign-in. A new user is always a customer; an
     * existing user keeps their role and status and is not modified. The two
     * statements deliberately run outside a transaction: under READ COMMITTED
     * each takes a fresh snapshot, so the SELECT sees a row whose concurrent
     * insert made ours a no-op. It only finds nothing if that row was rolled
     * back or deleted in between, which a single retry resolves.
     */
    async upsertCustomerByPhone(phone) {
      for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
        const inserted = await prisma.$queryRaw<SignedInRow[]>`
          INSERT INTO "users" ("phone", "role")
          VALUES (${phone}, 'customer')
          ON CONFLICT ("phone") DO NOTHING
          RETURNING ${signedInColumns}
        `;
        if (inserted[0] !== undefined) return { ...inserted[0], created: true };

        const existing = await prisma.$queryRaw<SignedInRow[]>`
          SELECT ${signedInColumns} FROM "users" WHERE "phone" = ${phone}
        `;
        if (existing[0] !== undefined) {
          return { ...existing[0], created: false };
        }
      }
      throw new Error('User sign-in found no row after retry');
    },

    findById(id) {
      return prisma.user.findUnique({ where: { id }, select: profileSelect });
    },

    findByPhone(phone) {
      return prisma.user.findUnique({
        where: { phone },
        select: profileSelect,
      });
    },

    insertCustomer(phone) {
      return insert({ phone });
    },

    async insertProvisioned(account, actor) {
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.user.create({
            data: {
              phone: account.phone,
              role: account.role,
              name: account.name,
              community: account.community,
              accountType: account.accountType,
            },
            select: profileSelect,
          });
          await audit.record(tx, {
            actorId: actor.actorId,
            requestId: actor.requestId,
            action: 'user.provision',
            targetType: 'user',
            targetId: row.id,
            metadata: { role: row.role, accountType: row.accountType },
          });
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) return 'conflict';
        throw error;
      }
    },

    updateOwnStatus(id, status) {
      return update(id, { status });
    },

    updateProfile(id, patch) {
      const data: Prisma.UserUpdateInput = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.community !== undefined) data.community = patch.community;
      if (patch.accountType !== undefined) data.accountType = patch.accountType;
      return update(id, data);
    },

    updateStatus(id, status, actor) {
      return commitChange(
        id,
        { status },
        actor,
        'user.status.update',
        (before, after) => ({
          from: before.status,
          to: after.status,
        }),
      );
    },

    updateRole(id, role, actor) {
      return commitChange(
        id,
        { role },
        actor,
        'user.role.update',
        (before, after) => ({
          from: before.role,
          to: after.role,
        }),
      );
    },
  };
}
