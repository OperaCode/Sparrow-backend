import type { Response } from 'supertest';
import type { ErrorBody } from '../../src/http/response.js';

/**
 * supertest types response.body as any. This gives tests a typed view of the
 * error envelope without per-assertion casts.
 */
export function errorOf(response: Response): ErrorBody['error'] {
  return (response.body as ErrorBody).error;
}
