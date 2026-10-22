import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { AccountStatus, Role } from '../../types/auth.js';
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

export interface UsersRepository {
  findAuthSubjectById(id: string): Promise<AuthSubject | null>;
  findById(id: string): Promise<UserProfile | null>;
  findByPhone(phone: string): Promise<UserProfile | null>;
  insertCustomer(phone: string): Promise<UserProfile | 'conflict'>;
  insertProvisioned(account: NewAccount): Promise<UserProfile | 'conflict'>;
  updateProfile(id: string, patch: ProfilePatch): Promise<UserProfile | null>;
  updateStatus(id: string, status: AccountStatus): Promise<UserProfile | null>;
  updateRole(id: string, role: ProvisionRole): Promise<UserProfile | null>;
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

  return {
    findAuthSubjectById(id) {
      return prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true, status: true },
      });
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

    insertProvisioned(account) {
      return insert({
        phone: account.phone,
        role: account.role,
        name: account.name,
        community: account.community,
        accountType: account.accountType,
      });
    },

    updateProfile(id, patch) {
      const data: Prisma.UserUpdateInput = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.community !== undefined) data.community = patch.community;
      if (patch.accountType !== undefined) data.accountType = patch.accountType;
      return update(id, data);
    },

    updateStatus(id, status) {
      return update(id, { status });
    },

    updateRole(id, role) {
      return update(id, { role });
    },
  };
}
