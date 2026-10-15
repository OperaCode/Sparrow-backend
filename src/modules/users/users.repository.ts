import type { PrismaClient } from '../../lib/prisma.js';
import type { AccountStatus, Role } from '../../types/auth.js';

export interface AuthSubject {
  id: string;
  role: Role;
  status: AccountStatus;
}

export interface UsersRepository {
  findAuthSubjectById(id: string): Promise<AuthSubject | null>;
}

export function createUsersRepository(prisma: PrismaClient): UsersRepository {
  return {
    findAuthSubjectById(id) {
      return prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true, status: true },
      });
    },
  };
}
