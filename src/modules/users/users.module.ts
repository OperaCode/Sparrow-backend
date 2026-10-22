import { Router } from 'express';
import type { V1Module } from '../../api/v1/router.js';
import { validate } from '../../http/middleware/validate.js';
import type { Logger } from '../../lib/logger.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { createUsersController } from './users.controller.js';
import { createUsersRepository } from './users.repository.js';
import {
  emptyBodySchema,
  profileBodySchema,
  provisionBodySchema,
  roleBodySchema,
  statusBodySchema,
  userParamsSchema,
} from './users.schema.js';
import { createUsersService } from './users.service.js';

export function createUsersModules(deps: {
  prisma: PrismaClient;
  logger: Logger;
}): readonly V1Module[] {
  const controller = createUsersController(
    createUsersService({
      repository: createUsersRepository(deps.prisma),
      logger: deps.logger,
    }),
  );

  const me: V1Module = {
    path: '/me',
    createRouter({ authenticate }) {
      const router = Router();
      router.get('/', authenticate, controller.show);
      router.patch(
        '/',
        authenticate,
        validate({ body: profileBodySchema }),
        controller.update,
      );
      router.post(
        '/deactivation',
        authenticate,
        validate({ body: emptyBodySchema }),
        controller.deactivate,
      );
      return router;
    },
  };

  const accounts: V1Module = {
    path: '/users',
    createRouter({ authenticate, requireRole }) {
      const router = Router();
      router.post(
        '/',
        authenticate,
        requireRole('admin'),
        validate({ body: provisionBodySchema }),
        controller.provision,
      );
      router.patch(
        '/:id/status',
        authenticate,
        requireRole('admin'),
        validate({ params: userParamsSchema, body: statusBodySchema }),
        controller.setStatus,
      );
      router.patch(
        '/:id/role',
        authenticate,
        requireRole('admin'),
        validate({ params: userParamsSchema, body: roleBodySchema }),
        controller.setRole,
      );
      return router;
    },
  };

  return [me, accounts];
}
