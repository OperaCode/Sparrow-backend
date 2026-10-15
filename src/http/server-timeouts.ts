import type { Server } from 'node:http';

export const SERVER_TIMEOUTS = {
  /** Time allowed to receive the full request headers. */
  headersTimeoutMs: 20_000,
  /** Time allowed to receive the entire request. Bounds slow-body attacks. */
  requestTimeoutMs: 30_000,
  /** Idle keep-alive time; must stay below headersTimeout. */
  keepAliveTimeoutMs: 5_000,
} as const;

export function applyServerTimeouts(server: Server): void {
  server.headersTimeout = SERVER_TIMEOUTS.headersTimeoutMs;
  server.requestTimeout = SERVER_TIMEOUTS.requestTimeoutMs;
  server.keepAliveTimeout = SERVER_TIMEOUTS.keepAliveTimeoutMs;
}
