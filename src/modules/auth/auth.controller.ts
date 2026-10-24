import type { Request, RequestHandler, Response } from 'express';
import { sendData } from '../../http/response.js';
import type { FirebaseExchangeBody, RefreshTokenBody } from './auth.schema.js';
import type { AuthService } from './auth.service.js';

export interface AuthController {
  exchangeFirebaseToken: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
}

/** validate() has already replaced the body with the parsed schema output. */
function bodyOf(req: Request): unknown {
  return req.body;
}

/** Responses that carry tokens must never be stored by a cache. */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

export function createAuthController(service: AuthService): AuthController {
  return {
    exchangeFirebaseToken: async (req, res) => {
      const { idToken } = bodyOf(req) as FirebaseExchangeBody;
      const result = await service.exchangeFirebaseToken(idToken);
      noStore(res);
      sendData(res, result);
    },

    refresh: async (req, res) => {
      const { refreshToken } = bodyOf(req) as RefreshTokenBody;
      const tokens = await service.refresh(refreshToken);
      noStore(res);
      sendData(res, { tokens });
    },

    logout: async (req, res) => {
      const { refreshToken } = bodyOf(req) as RefreshTokenBody;
      await service.logout(refreshToken);
      res.status(204).end();
    },
  };
}
