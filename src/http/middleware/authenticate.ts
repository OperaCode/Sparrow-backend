import type { RequestHandler } from 'express';
import type { AccountStatus, Role } from '../../types/auth.js';
import { ForbiddenError, UnauthorizedError } from '../errors.js';

export interface TokenVerifier {
  verify(token: string): Promise<{ userId: string }>;
}

export interface AuthSubjectLookup {
  findAuthSubjectById(
    id: string,
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
 * every request. The token only proves identity; it never carries authority,
 * so demotions and suspensions take effect immediately.
 */
export function createAuthenticate(
  deps: AuthenticateDependencies,
): RequestHandler {
  return async (req, _res, next) => {
    const token = extractBearerToken(req.get('Authorization'));
    const { userId } = await deps.verifier.verify(token);

    const subject = await deps.subjects.findAuthSubjectById(userId);
    if (subject === null) {
      throw new UnauthorizedError();
    }
    if (subject.status !== 'active') {
      throw new ForbiddenError(
        'This account is suspended',
        'ACCOUNT_SUSPENDED',
      );
    }

    req.auth = { userId: subject.id, role: subject.role };
    next();
  };
}
