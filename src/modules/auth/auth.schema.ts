import { z } from 'zod';
import { REFRESH_TOKEN_PATTERN } from './refresh-token.js';

const MAX_ID_TOKEN_LENGTH = 4096;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Messages are fixed text so a rejected token is never echoed back. */
export const firebaseExchangeBodySchema = z.strictObject({
  idToken: z
    .string({ error: 'idToken is required' })
    .max(MAX_ID_TOKEN_LENGTH, 'idToken is too long')
    .regex(JWT_PATTERN, 'idToken is not a JWT'),
});

export const refreshTokenBodySchema = z.strictObject({
  refreshToken: z
    .string({ error: 'refreshToken is required' })
    .regex(REFRESH_TOKEN_PATTERN, 'refreshToken is malformed'),
});

export type FirebaseExchangeBody = z.output<typeof firebaseExchangeBodySchema>;
export type RefreshTokenBody = z.output<typeof refreshTokenBodySchema>;
