import type { RequestHandler } from 'express';
import type { Role } from '../../types/auth.js';
import { ForbiddenError } from '../errors.js';

/**
 * Coarse role gate. Resource ownership ("this delivery belongs to this
 * customer") is checked in services, not here.
 */
export function requireRole(...allowed: [Role, ...Role[]]): RequestHandler {
  const allowedRoles = new Set<Role>(allowed);

  return (req, _res, next) => {
    if (req.auth === undefined) {
      // A wiring mistake, not a client error: surfaces as a 500 so it is
      // caught in tests instead of silently allowing or denying access.
      throw new Error('requireRole must be mounted after authenticate');
    }
    if (!allowedRoles.has(req.auth.role)) {
      throw new ForbiddenError();
    }
    next();
  };
}
