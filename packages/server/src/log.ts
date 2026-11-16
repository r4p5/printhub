import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';

type Level = 'info' | 'warn' | 'error';
let stream: WriteStream | null = null;

/** Append-only daily log file; one line per entry, no buffering beyond the stream's own. */
export function initLog(logDir: string) {
  const day = new Date().toISOString().slice(0, 10);
  stream = createWriteStream(join(logDir, `printhub-${day}.log`), { flags: 'a' });
}

function write(level: Level, msg: string, meta?: unknown) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${meta === undefined ? '' : ' ' + safeJson(meta)}`;
  stream?.write(line + '\n');
  if (process.env.NODE_ENV !== 'test') (level === 'error' ? console.error : console.log)(line);
}

function safeJson(v: unknown) {
  if (v instanceof Error) return JSON.stringify({ error: v.message });
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  info: (m: string, meta?: unknown) => write('info', m, meta),
  warn: (m: string, meta?: unknown) => write('warn', m, meta),
  error: (m: string, meta?: unknown) => write('error', m, meta),
  close: () => new Promise<void>((r) => (stream ? stream.end(r) : r())),
};
