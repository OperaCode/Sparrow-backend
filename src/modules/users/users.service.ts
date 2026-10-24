import {
  checkAccountStatus,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../http/errors.js';
import type { Logger } from '../../lib/logger.js';
import {
  ACCOUNT_STATUSES,
  type AccountStatus,
  type AuditActor,
} from '../../types/auth.js';
import type { UsersRepository } from './users.repository.js';
import type {
  NewAccount,
  ProfilePatch,
  ProvisionInput,
  ProvisionRole,
  UserProfile,
} from './users.types.js';
import {
  ACCOUNT_TYPES,
  COMMUNITIES,
  NAME_MAX_LENGTH,
  PHONE_PATTERN,
  PROVISION_ROLES,
} from './users.types.js';

export interface UsersService {
  /**
   * Persists the customer for a phone that has just been verified. The first
   * call creates the row. A later call returns it and leaves role and status
   * untouched. A suspended or deactivated phone is refused, not reopened.
   * Call this only after verification. It is not an HTTP route.
   */
  openVerifiedCustomer(phone: string): Promise<UserProfile>;
  getProfile(userId: string): Promise<UserProfile>;
  updateOwnProfile(userId: string, patch: ProfilePatch): Promise<UserProfile>;
  deactivateOwnAccount(userId: string): Promise<UserProfile>;
  provisionAccount(
    actor: AuditActor,
    input: ProvisionInput,
  ): Promise<UserProfile>;
  setAccountStatus(
    actor: AuditActor,
    targetId: string,
    status: AccountStatus,
  ): Promise<UserProfile>;
  setAccountRole(
    actor: AuditActor,
    targetId: string,
    role: ProvisionRole,
  ): Promise<UserProfile>;
}

interface UsersServiceOptions {
  repository: UsersRepository;
  logger: Logger;
}

function invalid(path: string, message: string): never {
  throw new ValidationError([{ path, message }]);
}

/** One membership check for community, account type, role, and status. */
function oneOf<T extends string>(
  value: string,
  options: readonly T[],
  path: string,
  message: string,
): T {
  const match = options.find((item) => item === value);
  if (match === undefined) invalid(path, message);
  return match;
}

function parsePhone(phone: string): string {
  if (!PHONE_PATTERN.test(phone))
    invalid('phone', 'Phone must be in E.164 form');
  return phone;
}

function parseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    invalid('name', 'Name must be 1 to 80 characters');
  }
  return trimmed;
}

function parsePatch(patch: ProfilePatch): ProfilePatch {
  const next: ProfilePatch = {};
  if (patch.name !== undefined) next.name = parseName(patch.name);
  if (patch.community !== undefined) {
    next.community = oneOf(
      patch.community,
      COMMUNITIES,
      'community',
      'Community must be igbesa, lusada, or ketu',
    );
  }
  if (patch.accountType !== undefined) {
    next.accountType = oneOf(
      patch.accountType,
      ACCOUNT_TYPES,
      'accountType',
      'Account type must be standard or business',
    );
  }
  if (
    next.name === undefined &&
    next.community === undefined &&
    next.accountType === undefined
  ) {
    invalid('body', 'At least one profile field is required');
  }
  return next;
}

export function createUsersService(options: UsersServiceOptions): UsersService {
  const { repository, logger } = options;

  /** A row that must exist. Writes use this, because the result may be inactive. */
  function found<T>(row: T | null, missing: Error): T {
    if (row === null) throw missing;
    return row;
  }

  /** A row that must exist and be active. Every read goes through this. */
  function ready(profile: UserProfile | null, missing: Error): UserProfile {
    const row = found(profile, missing);
    checkAccountStatus(row.status);
    return row;
  }

  async function loadActive(userId: string): Promise<UserProfile> {
    return ready(await repository.findById(userId), new UnauthorizedError());
  }

  async function requireActiveAdmin(actorId: string): Promise<void> {
    const actor = ready(
      await repository.findById(actorId),
      new ForbiddenError(),
    );
    if (actor.role !== 'admin') throw new ForbiddenError();
  }

  async function requireOtherAccount(
    actorId: string,
    targetId: string,
    action: string,
  ): Promise<void> {
    await requireActiveAdmin(actorId);
    if (actorId === targetId) {
      throw new ForbiddenError(`You cannot change your own ${action}`);
    }
  }

  async function loadVerifiedWinner(phone: string): Promise<UserProfile> {
    return ready(
      await repository.findByPhone(phone),
      new Error('Verified customer insert conflicted but no row exists'),
    );
  }

  return {
    async openVerifiedCustomer(phone) {
      const verifiedPhone = parsePhone(phone);
      const existing = await repository.findByPhone(verifiedPhone);
      if (existing !== null) return ready(existing, new UnauthorizedError());

      const created = await repository.insertCustomer(verifiedPhone);
      if (created === 'conflict') return loadVerifiedWinner(verifiedPhone);

      logger.info({ userId: created.id }, 'Opened customer profile');
      return created;
    },

    getProfile(userId) {
      return loadActive(userId);
    },

    async updateOwnProfile(userId, patch) {
      const next = parsePatch(patch);
      const profile = await loadActive(userId);
      return found(
        await repository.updateProfile(profile.id, next),
        new UnauthorizedError(),
      );
    },

    async deactivateOwnAccount(userId) {
      const profile = await loadActive(userId);
      if (profile.role === 'admin') {
        throw new ForbiddenError(
          'An admin account can only be deactivated by another admin',
        );
      }

      const updated = found(
        await repository.updateOwnStatus(profile.id, 'deactivated'),
        new UnauthorizedError(),
      );
      logger.info({ userId: profile.id }, 'Deactivated own account');
      return updated;
    },

    async provisionAccount(actor, input) {
      await requireActiveAdmin(actor.actorId);
      const account: NewAccount = {
        phone: parsePhone(input.phone),
        role: oneOf(
          input.role,
          PROVISION_ROLES,
          'role',
          'Role must be customer or admin',
        ),
        name: input.name === undefined ? null : parseName(input.name),
        community:
          input.community === undefined
            ? null
            : oneOf(
                input.community,
                COMMUNITIES,
                'community',
                'Community must be igbesa, lusada, or ketu',
              ),
        accountType:
          input.accountType === undefined
            ? 'standard'
            : oneOf(
                input.accountType,
                ACCOUNT_TYPES,
                'accountType',
                'Account type must be standard or business',
              ),
      };

      const created = await repository.insertProvisioned(account, actor);
      if (created === 'conflict') {
        throw new ConflictError('An account with this phone already exists');
      }
      logger.info(
        { actorId: actor.actorId, userId: created.id, role: created.role },
        'Provisioned account',
      );
      return created;
    },

    async setAccountStatus(actor, targetId, status) {
      await requireOtherAccount(actor.actorId, targetId, 'account status');
      const nextStatus = oneOf(
        status,
        ACCOUNT_STATUSES,
        'status',
        'Status must be active, suspended, or deactivated',
      );

      const updated = found(
        await repository.updateStatus(targetId, nextStatus, actor),
        new NotFoundError('Account not found'),
      );
      logger.info(
        { actorId: actor.actorId, userId: targetId, status: nextStatus },
        'Updated account status',
      );
      return updated;
    },

    async setAccountRole(actor, targetId, role) {
      await requireOtherAccount(actor.actorId, targetId, 'role');
      const nextRole = oneOf(
        role,
        PROVISION_ROLES,
        'role',
        'Role must be customer or admin',
      );

      const updated = found(
        await repository.updateRole(targetId, nextRole, actor),
        new NotFoundError('Account not found'),
      );
      logger.info(
        { actorId: actor.actorId, userId: targetId, role: nextRole },
        'Updated account role',
      );
      return updated;
    },
  };
}
