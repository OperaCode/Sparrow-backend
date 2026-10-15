import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError, type ErrorDetail } from '../errors.js';

type Location = 'params' | 'query' | 'body';

export type RequestSchemas = Partial<Record<Location, z.ZodType>>;

const LOCATIONS: readonly Location[] = ['params', 'query', 'body'];

function toDetails(location: Location, error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: [location, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/**
 * Validates and replaces req.params, req.query and req.body with the parsed
 * output, so handlers only ever see coerced, schema-shaped data. Use
 * z.strictObject for bodies so unknown fields are rejected, not ignored.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const parsed: Partial<Record<Location, unknown>> = {};

    for (const location of LOCATIONS) {
      const schema = schemas[location];
      if (schema === undefined) continue;

      const result = schema.safeParse(req[location]);
      if (result.success) {
        parsed[location] = result.data;
      } else {
        details.push(...toDetails(location, result.error));
      }
    }

    if (details.length > 0) {
      next(new ValidationError(details));
      return;
    }

    if ('params' in parsed) req.params = parsed.params as typeof req.params;
    if ('body' in parsed) req.body = parsed.body;
    if ('query' in parsed) {
      // Express 5 exposes req.query as a getter only, so it cannot be assigned.
      Object.defineProperty(req, 'query', {
        value: parsed.query,
        enumerable: true,
        configurable: true,
        writable: false,
      });
    }

    next();
  };
}
