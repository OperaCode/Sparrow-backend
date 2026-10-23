import type { Config } from '../../config/env.js';
import { signAccessToken } from './access-token.service.js';
import {
  formatRefreshToken,
  generateRefreshSecret,
  type ParsedRefreshToken,
} from './refresh-token.js';
import type {
  SessionExpiry,
  SessionsRepository,
} from './sessions.repository.js';

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

export type RotateTokensResult =
  | { status: 'rotated'; tokens: IssuedTokens }
  | { status: 'suspended'; userId: string }
  | { status: 'reused'; userId: string }
  | { status: 'invalid' };

export interface SessionTokens {
  /** Returns null when this Firebase sign-in already opened a session. */
  open(input: OpenSessionInput): Promise<IssuedTokens | null>;
  rotate(token: ParsedRefreshToken): Promise<RotateTokensResult>;
}

interface SessionTokensDependencies {
  config: Pick<Config, 'auth' | 'session'>;
  sessions: SessionsRepository;
}

export function createSessionTokens(
  deps: SessionTokensDependencies,
): SessionTokens {
  const { auth, session } = deps.config;
  const refreshTtlSeconds = session.refreshTokenTtlDays * DAY_SECONDS;

  async function issue(
    created: SessionExpiry,
    refreshSecret: string,
    accessTokenTtlSeconds: number,
  ): Promise<IssuedTokens> {
    const access = await signAccessToken(
      auth,
      { userId: created.userId, sessionId: created.id },
      accessTokenTtlSeconds,
    );
    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: formatRefreshToken(created.id, refreshSecret),
      refreshTokenExpiresAt: created.refreshExpiresAt,
    };
  }

  return {
    async open(input) {
      const refresh = generateRefreshSecret();
      const created = await deps.sessions.create({
        userId: input.userId,
        firebaseUid: input.firebaseUid,
        firebaseAuthTime: input.firebaseAuthTime,
        refreshTokenHash: refresh.hash,
        refreshTtlSeconds,
        maxAgeSeconds: session.maxAgeDays * DAY_SECONDS,
      });
      if (created === null) return null;
      return issue(
        created,
        refresh.secret,
        input.accessTokenTtlSeconds ?? session.accessTokenTtlSeconds,
      );
    },

    /**
     * A suspended user's token is still consumed by the rotation, so the
     * session cannot be refreshed again after a reinstatement; the user signs
     * in with a new OTP instead.
     */
    async rotate(token) {
      const next = generateRefreshSecret();
      const result = await deps.sessions.rotate({
        sessionId: token.sessionId,
        presentedHash: token.hash,
        nextHash: next.hash,
        refreshTtlSeconds,
        reuseGraceSeconds: session.refreshReuseGraceSeconds,
      });
      if (result.status !== 'rotated') return result;
      if (result.session.userStatus !== 'active') {
        return { status: 'suspended', userId: result.session.userId };
      }
      return {
        status: 'rotated',
        tokens: await issue(
          result.session,
          next.secret,
          session.accessTokenTtlSeconds,
        ),
      };
    },
  };
}
