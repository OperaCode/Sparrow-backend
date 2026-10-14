import { generateKeyPairSync } from 'node:crypto';

/** Generated per test run, so no real key material ever lives in the repo. */
export const {
  privateKey: TEST_PRIVATE_KEY_PEM,
  publicKey: TEST_PUBLIC_KEY_PEM,
} = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const TEST_SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'sparrow-test-123',
  private_key_id: 'abc123',
  private_key: TEST_PRIVATE_KEY_PEM,
  client_email:
    'firebase-adminsdk-x1y2z@sparrow-test-123.iam.gserviceaccount.com',
  client_id: '1234567890',
};

export function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** FIREBASE_SERVICE_ACCOUNT_BASE64 value, with fields overridden or removed. */
export function encodedServiceAccount(
  overrides: Record<string, unknown> = {},
): string {
  return base64(JSON.stringify({ ...TEST_SERVICE_ACCOUNT, ...overrides }));
}
