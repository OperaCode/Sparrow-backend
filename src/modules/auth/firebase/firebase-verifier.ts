import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import type { FirebaseServiceAccount } from '../../../config/firebase-service-account.js';
import {
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../../http/errors.js';
import type { Logger } from '../../../lib/logger.js';
import { normaliseNigerianMobile } from '../phone.js';

export type { DecodedIdToken };

/** A verified Firebase phone sign-in. */
export interface FirebasePhoneIdentity {
  uid: string;
  /** E.164 Nigerian mobile number. */
  phone: string;
  /** When the user completed the OTP, not when the ID token was minted. */
  authTime: Date;
}

export interface FirebaseIdTokenVerifier {
  verify(idToken: string): Promise<FirebasePhoneIdentity>;
}

/** The only Admin SDK call the verifier makes, so tests can pass a fake. */
export type IdTokenDecoder = Pick<Auth, 'verifyIdToken'>;

interface FirebaseVerifierOptions {
  auth: IdTokenDecoder;
  maxAuthAgeSeconds: number;
  logger: Logger;
  now?: () => number;
}

const FIREBASE_APP_NAME = 'sparrow-auth';
const EMULATOR_HOST_VARIABLE = 'FIREBASE_AUTH_EMULATOR_HOST';
const UNAVAILABLE_MESSAGE = 'Sign-in is temporarily unavailable';

/** Allows for clock skew between Firebase and this server. */
const FUTURE_AUTH_TIME_TOLERANCE_SECONDS = 60;

/**
 * Codes that mean the token itself is unacceptable. Anything else, including
 * network and internal errors, is treated as Firebase being unavailable.
 */
const REJECTED_TOKEN_CODES: ReadonlySet<string> = new Set([
  'auth/argument-error',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-id-token',
  'auth/invalid-user-token',
  'auth/user-disabled',
  'auth/user-not-found',
]);

type ClaimFailure =
  'wrong_provider' | 'missing_phone' | 'invalid_auth_time' | 'stale_auth_time';

function errorCodeOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

function checkAuthTime(
  authTime: unknown,
  nowSeconds: number,
  maxAgeSeconds: number,
): ClaimFailure | null {
  if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime)) {
    return 'invalid_auth_time';
  }
  if (authTime > nowSeconds + FUTURE_AUTH_TIME_TOLERANCE_SECONDS) {
    return 'invalid_auth_time';
  }
  return nowSeconds - authTime > maxAgeSeconds ? 'stale_auth_time' : null;
}

function claimFailure(
  token: DecodedIdToken,
  nowSeconds: number,
  maxAgeSeconds: number,
): ClaimFailure | null {
  if (token.firebase.sign_in_provider !== 'phone') return 'wrong_provider';
  if (typeof token.phone_number !== 'string') return 'missing_phone';
  return checkAuthTime(token.auth_time, nowSeconds, maxAgeSeconds);
}

/**
 * Verifies a Firebase ID token with the Admin SDK (signature, issuer,
 * audience, expiry, revocation and disabled users), then requires a fresh
 * phone sign-in with a Nigerian mobile number. Only error codes and claim
 * failure reasons are logged; the token never is.
 */
export function createFirebaseVerifier(
  options: FirebaseVerifierOptions,
): FirebaseIdTokenVerifier {
  const { auth, logger, maxAuthAgeSeconds } = options;
  const now = options.now ?? Date.now;

  async function decode(idToken: string): Promise<DecodedIdToken> {
    try {
      return await auth.verifyIdToken(idToken, true);
    } catch (error) {
      const code = errorCodeOf(error);
      if (REJECTED_TOKEN_CODES.has(code)) {
        logger.info({ firebaseCode: code }, 'Firebase ID token rejected');
        throw new UnauthorizedError();
      }
      logger.error({ firebaseCode: code }, 'Firebase ID token check failed');
      throw new ServiceUnavailableError(UNAVAILABLE_MESSAGE);
    }
  }

  return {
    async verify(idToken) {
      const token = await decode(idToken);

      const failure = claimFailure(
        token,
        Math.floor(now() / 1000),
        maxAuthAgeSeconds,
      );
      if (failure !== null) {
        logger.info({ reason: failure }, 'Firebase ID token rejected');
        throw new UnauthorizedError();
      }

      const phone = normaliseNigerianMobile(token.phone_number ?? '');
      if (phone === null) {
        throw new ForbiddenError(
          'Only Nigerian mobile numbers can sign in',
          'PHONE_NOT_SUPPORTED',
        );
      }

      return {
        uid: token.uid,
        phone,
        authTime: new Date(token.auth_time * 1000),
      };
    },
  };
}

/**
 * The Admin SDK skips signature checks when the emulator variable is set, so
 * its presence is a startup error rather than a silent bypass.
 */
export function createFirebaseAuth(
  account: FirebaseServiceAccount,
  env: NodeJS.ProcessEnv = process.env,
): IdTokenDecoder {
  if (env[EMULATOR_HOST_VARIABLE] !== undefined) {
    throw new Error(
      `${EMULATOR_HOST_VARIABLE} is set; refusing to verify ID tokens without signature checks`,
    );
  }
  const app = initializeApp(
    {
      credential: cert({
        projectId: account.projectId,
        clientEmail: account.clientEmail,
        privateKey: account.privateKey,
      }),
      projectId: account.projectId,
    },
    FIREBASE_APP_NAME,
  );
  return getAuth(app);
}

/**
 * Used when no service account is configured, which is only allowed outside
 * production. Sign-in fails with 503 instead of the server refusing to start.
 */
export function createUnconfiguredFirebaseVerifier(
  logger: Logger,
): FirebaseIdTokenVerifier {
  return {
    verify() {
      logger.warn(
        'Firebase is not configured; set FIREBASE_SERVICE_ACCOUNT_BASE64',
      );
      return Promise.reject(new ServiceUnavailableError(UNAVAILABLE_MESSAGE));
    },
  };
}
