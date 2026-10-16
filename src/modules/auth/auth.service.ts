import { ForbiddenError, UnauthorizedError } from '../../http/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { Role } from '../../types/auth.js';
import type { UsersRepository } from '../users/users.repository.js';
import type { FirebaseIdTokenVerifier } from './firebase/firebase-verifier.js';
import { parseRefreshToken } from './refresh-token.js';
import type { IssuedTokens, SessionTokens } from './session-tokens.js';
import type { SessionsRepository } from './sessions.repository.js';

export interface SignInResult {
  user: { id: string; phone: string; role: Role };
  isNewUser: boolean;
  tokens: IssuedTokens;
}

export interface AuthService {
  exchangeFirebaseToken(idToken: string): Promise<SignInResult>;
  refresh(refreshToken: string): Promise<IssuedTokens>;
  logout(refreshToken: string): Promise<void>;
}

interface AuthServiceDependencies {
  firebase: FirebaseIdTokenVerifier;
  users: Pick<UsersRepository, 'upsertCustomerByPhone'>;
  sessions: Pick<SessionsRepository, 'revokeForLogout'>;
  sessionTokens: SessionTokens;
  logger: Logger;
}

function suspended(): ForbiddenError {
  return new ForbiddenError('This account is suspended', 'ACCOUNT_SUSPENDED');
}

export function createAuthService(deps: AuthServiceDependencies): AuthService {
  const { logger } = deps;

  return {
    async exchangeFirebaseToken(idToken) {
      const identity = await deps.firebase.verify(idToken);
      const user = await deps.users.upsertCustomerByPhone(identity.phone);
      if (user.status !== 'active') throw suspended();

      const tokens = await deps.sessionTokens.open({
        userId: user.id,
        firebaseUid: identity.uid,
        firebaseAuthTime: identity.authTime,
      });
      if (tokens === null) {
        // The same Firebase sign-in was already exchanged. Only the first
        // exchange gets a session, so a captured ID token cannot open another.
        logger.warn({ userId: user.id }, 'Firebase sign-in already exchanged');
        throw new UnauthorizedError();
      }

      return {
        user: { id: user.id, phone: user.phone, role: user.role },
        isNewUser: user.created,
        tokens,
      };
    },

    async refresh(refreshToken) {
      const parsed = parseRefreshToken(refreshToken);
      if (parsed === null) throw new UnauthorizedError();

      const result = await deps.sessionTokens.rotate(parsed);
      switch (result.status) {
        case 'rotated':
          return result.tokens;
        case 'suspended':
          throw suspended();
        case 'reused':
          logger.warn(
            { sessionId: parsed.sessionId, userId: result.userId },
            'Refresh token reuse detected; session revoked',
          );
          throw new UnauthorizedError();
        case 'invalid':
          throw new UnauthorizedError();
      }
    },

    /** Silent on a bad token, so the response cannot be used as an oracle. */
    async logout(refreshToken) {
      const parsed = parseRefreshToken(refreshToken);
      if (parsed === null) return;
      await deps.sessions.revokeForLogout(parsed.sessionId, parsed.hash);
    },
  };
}
