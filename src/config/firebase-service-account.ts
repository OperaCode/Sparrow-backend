import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

export interface FirebaseServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const WHITESPACE = /\s/g;

/** Google Cloud project id rules: 6 to 30 lowercase letters, digits or hyphens. */
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const CLIENT_EMAIL_PATTERN = /^[^\s@]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

function isPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).type === 'private';
  } catch {
    return false;
  }
}

const serviceAccountJsonSchema = z.looseObject({
  type: z.literal('service_account', {
    error: 'type must be "service_account"',
  }),
  project_id: z
    .string({ error: 'project_id is missing' })
    .regex(PROJECT_ID_PATTERN, 'project_id is not a valid project id'),
  client_email: z
    .string({ error: 'client_email is missing' })
    .regex(CLIENT_EMAIL_PATTERN, 'client_email is not a service account email'),
  private_key: z
    .string({ error: 'private_key is missing' })
    .refine(isPrivateKey, 'private_key is not a valid PEM private key'),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Decodes a base64-encoded service account key file. Every message is fixed
 * text: JSON.parse and zod defaults can quote the input, which here is a
 * private key.
 */
export function parseFirebaseServiceAccount(
  value: string,
  ctx: z.RefinementCtx,
): FirebaseServiceAccount {
  const encoded = value.replace(WHITESPACE, '');
  if (!BASE64_PATTERN.test(encoded)) {
    ctx.addIssue({ code: 'custom', message: 'Expected base64 text' });
    return z.NEVER;
  }

  const json = parseJson(Buffer.from(encoded, 'base64').toString('utf8'));
  if (typeof json !== 'object' || json === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected base64 of a service account JSON key file',
    });
    return z.NEVER;
  }

  const result = serviceAccountJsonSchema.safeParse(json);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message });
    }
    return z.NEVER;
  }

  return {
    projectId: result.data.project_id,
    clientEmail: result.data.client_email,
    privateKey: result.data.private_key,
  };
}
