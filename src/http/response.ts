import type { Response } from 'express';
import type { ErrorCode, ErrorDetail } from './errors.js';

export interface SuccessBody<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: readonly ErrorDetail[];
    requestId: string;
  };
}

export function sendData(
  res: Response,
  data: unknown,
  options: { status?: number; meta?: Record<string, unknown> } = {},
): void {
  const body: SuccessBody<unknown> =
    options.meta === undefined ? { data } : { data, meta: options.meta };
  res.status(options.status ?? 200).json(body);
}
