import type { Request, RequestHandler } from 'express';
import type { AccountStatus, AuditActor, Role } from '../../types/auth.js';
import { checkAccountStatus, UnauthorizedError } from '../errors.js';
import { getRequestId } from './request-id.js';

export interface TokenVerifier {
  verify(token: string): Promise<{ userId: string; sessionId: string }>;
}

export interface AuthSubjectLookup {
  /** Null unless the session is live and belongs to the user. */
  findAuthSubject(
    userId: string,
    sessionId: string,
  ): Promise<{ id: string; role: Role; status: AccountStatus } | null>;
}

interface AuthenticateDependencies {
  verifier: TokenVerifier;
  subjects: AuthSubjectLookup;
}

const BEARER_PATTERN =
  /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/i;

function extractBearerToken(header: string | undefined): string {
  const match = header === undefined ? null : BEARER_PATTERN.exec(header);
  if (match?.[1] === undefined) {
    throw new UnauthorizedError();
  }
  return match[1];
}

/**
 * Verifies the bearer token, then loads role and status from the database on
 * every request, through the token's session. The token only proves identity;
 * it never carries authority, so demotions, suspensions, deactivations, and
 * logouts take effect immediately.
 */
export function createAuthenticate(
  deps: AuthenticateDependencies,
): RequestHandler {
  return async (req, _res, next) => {
    const token = extractBearerToken(req.get('Authorization'));
    const { userId, sessionId } = await deps.verifier.verify(token);

    const subject = await deps.subjects.findAuthSubject(userId, sessionId);
    if (subject === null) {
      throw new UnauthorizedError();
    }
    checkAccountStatus(subject.status);

    req.auth = { userId: subject.id, role: subject.role };
    next();
  };
}

/** Identity plus the request id stored on a privileged audit row. */
export function auditActor(req: Request): AuditActor {
  if (req.auth === undefined) throw new UnauthorizedError();
  return { actorId: req.auth.userId, requestId: getRequestId(req) };
}
