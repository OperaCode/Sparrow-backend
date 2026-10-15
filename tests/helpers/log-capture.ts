import type { DestinationStream } from 'pino';

export interface LogCapture {
  stream: DestinationStream;
  lines: Record<string, unknown>[];
  raw: () => string;
}

export function createLogCapture(): LogCapture {
  const chunks: string[] = [];
  const lines: Record<string, unknown>[] = [];

  return {
    stream: {
      write(message: string) {
        chunks.push(message);
        lines.push(JSON.parse(message) as Record<string, unknown>);
      },
    },
    lines,
    raw: () => chunks.join(''),
  };
}
