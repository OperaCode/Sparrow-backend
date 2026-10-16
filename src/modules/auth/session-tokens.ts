import type { Config } from '../../config/env.js';
import { signAccessToken } from './access-token.service.js';
import { formatRefreshToken, generateRefreshSecret } from './refresh-token.js';
import type { SessionsRepository } from './sessions.repository.js';

const DAY_SECONDS = 24 * 60 * 60;

export interface IssuedTokens {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface OpenSessionInput {
  userId: string;
  firebaseUid: string;
  firebaseAuthTime: Date;
  /** Defaults to AUTH_ACCESS_TOKEN_TTL_SECONDS. */
  accessTokenTtlSeconds?: number;
}

export interface SessionTokens {
  /** Returns null when this Firebase sign-in already opened a session. */
  open(input: OpenSessionInput): Promise<IssuedTokens | null>;
}

interface SessionTokensDependencies {
  config: Pick<Config, 'auth' | 'session'>;
  sessions: SessionsRepository;
}

export function createSessionTokens(
  deps: SessionTokensDependencies,
): SessionTokens {
  const { auth, session } = deps.config;

  return {
    async open(input) {
      const refresh = generateRefreshSecret();
      const created = await deps.sessions.create({
        userId: input.userId,
        firebaseUid: input.firebaseUid,
        firebaseAuthTime: input.firebaseAuthTime,
        refreshTokenHash: refresh.hash,
        refreshTtlSeconds: session.refreshTokenTtlDays * DAY_SECONDS,
        maxAgeSeconds: session.maxAgeDays * DAY_SECONDS,
      });
      if (created === null) return null;

      const access = await signAccessToken(
        auth,
        { userId: created.userId, sessionId: created.id },
        input.accessTokenTtlSeconds ?? session.accessTokenTtlSeconds,
      );
      return {
        tokenType: 'Bearer',
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: formatRefreshToken(created.id, refresh.secret),
        refreshTokenExpiresAt: created.refreshExpiresAt,
      };
    },
  };
}
