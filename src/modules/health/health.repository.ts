import type { PrismaClient } from '../../lib/prisma.js';

export interface HealthRepository {
  pingDatabase(): Promise<void>;
}

export function createHealthRepository(prisma: PrismaClient): HealthRepository {
  return {
    async pingDatabase() {
      await prisma.$queryRaw`SELECT 1`;
    },
  };
}
