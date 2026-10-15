import type { Request, RequestHandler } from 'express';
import {
  ipKeyGenerator,
  rateLimit,
  type RateLimitInfo,
} from 'express-rate-limit';
import { RateLimitError } from '../errors.js';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /**
   * Defaults to the client IP. Sensitive routes can key on something the
   * attacker cannot rotate as cheaply, such as a phone number or QR token,
   * usually combined with clientIpKey.
   */
  keyGenerator?: (req: Request) => string;
}

/**
 * Normalises IPv6 clients to their /56 subnet so one host cannot dodge the
 * limit by cycling addresses. req.ip already honours the trust proxy setting.
 */
export function clientIpKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? 'unknown');
}

function retryAfterSeconds(req: Request, windowMs: number): number {
  // express-rate-limit attaches its state to req.rateLimit without typing it.
  const resetTime = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit
    ?.resetTime;
  const remainingMs =
    resetTime === undefined ? windowMs : resetTime.getTime() - Date.now();
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * In-memory store: correct for a single instance only. Running more than one
 * instance needs a shared store (Redis) so limits are not multiplied.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: options.keyGenerator ?? clientIpKey,
    handler: (req, _res, next) => {
      next(new RateLimitError(retryAfterSeconds(req, options.windowMs)));
    },
  });
}
