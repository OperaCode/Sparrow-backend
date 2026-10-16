import type {
  DecodedIdToken,
  IdTokenDecoder,
} from '../../src/modules/auth/firebase/firebase-verifier.js';

export const FIREBASE_PROJECT_ID = 'sparrow-test-123';

export interface FakeSignIn {
  uid: string;
  phone?: string;
  /** Seconds since the epoch. Defaults to ten seconds ago. */
  authTime?: number;
  provider?: string;
}

/**
 * Stands in for the Admin SDK's verifyIdToken, so the real verifier and its
 * claim checks run without touching the network. Unknown tokens fail the way
 * the SDK fails a malformed token.
 */
export class FakeFirebaseAuth implements IdTokenDecoder {
  private readonly outcomes = new Map<string, DecodedIdToken | string>();
  readonly calls: string[] = [];

  signIn(idToken: string, signIn: FakeSignIn): void {
    const now = Math.floor(Date.now() / 1000);
    const authTime = signIn.authTime ?? now - 10;
    this.outcomes.set(idToken, {
      aud: FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      sub: signIn.uid,
      uid: signIn.uid,
      iat: now - 5,
      exp: now + 3600,
      auth_time: authTime,
      ...(signIn.phone !== undefined && { phone_number: signIn.phone }),
      firebase: {
        identities: {},
        sign_in_provider: signIn.provider ?? 'phone',
      },
    });
  }

  fail(idToken: string, code: string): void {
    this.outcomes.set(idToken, code);
  }

  verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    this.calls.push(idToken);
    const outcome = this.outcomes.get(idToken) ?? 'auth/argument-error';
    if (typeof outcome === 'string') {
      return Promise.reject(
        Object.assign(new Error('Firebase rejected the token'), {
          code: outcome,
        }),
      );
    }
    return Promise.resolve(outcome);
  }
}

/** A syntactically valid JWT, which is all the request schema checks. */
export function fakeIdToken(label: string): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', kid: 'fake' })}.${part({ label })}.c2lnbmF0dXJl`;
}
