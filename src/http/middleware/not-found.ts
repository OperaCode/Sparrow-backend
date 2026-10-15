import type { RequestHandler } from 'express';
import { NotFoundError } from '../errors.js';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('Route not found'));
};
