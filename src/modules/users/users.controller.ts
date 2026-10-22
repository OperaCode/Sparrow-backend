import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { UnauthorizedError } from '../../http/errors.js';
import { sendData } from '../../http/response.js';
import type { AuthContext } from '../../types/auth.js';
import type {
  roleBodySchema,
  statusBodySchema,
  userParamsSchema,
} from './users.schema.js';
import type { UsersService } from './users.service.js';
import type { ProfilePatch, ProvisionInput } from './users.types.js';

export interface UsersController {
  show: RequestHandler;
  update: RequestHandler;
  deactivate: RequestHandler;
  provision: RequestHandler;
  setStatus: RequestHandler;
  setRole: RequestHandler;
}

function requireAuth(req: Request): AuthContext {
  if (req.auth === undefined) throw new UnauthorizedError();
  return req.auth;
}

/** validate() has already replaced the body with the parsed schema output. */
function bodyOf(req: Request): unknown {
  return req.body;
}

export function createUsersController(service: UsersService): UsersController {
  return {
    show: async (req, res) => {
      const { userId } = requireAuth(req);
      sendData(res, await service.getProfile(userId));
    },

    update: async (req, res) => {
      const { userId } = requireAuth(req);
      const profile = await service.updateOwnProfile(
        userId,
        bodyOf(req) as ProfilePatch,
      );
      sendData(res, profile);
    },

    deactivate: async (req, res) => {
      const { userId } = requireAuth(req);
      sendData(res, await service.deactivateOwnAccount(userId));
    },

    provision: async (req, res) => {
      const { userId } = requireAuth(req);
      const profile = await service.provisionAccount(
        userId,
        bodyOf(req) as ProvisionInput,
      );
      sendData(res, profile, { status: 201 });
    },

    setStatus: async (req, res) => {
      const { userId } = requireAuth(req);
      const params = req.params as z.output<typeof userParamsSchema>;
      const body = bodyOf(req) as z.output<typeof statusBodySchema>;
      sendData(
        res,
        await service.setAccountStatus(userId, params.id, body.status),
      );
    },

    setRole: async (req, res) => {
      const { userId } = requireAuth(req);
      const params = req.params as z.output<typeof userParamsSchema>;
      const body = bodyOf(req) as z.output<typeof roleBodySchema>;
      sendData(res, await service.setAccountRole(userId, params.id, body.role));
    },
  };
}
