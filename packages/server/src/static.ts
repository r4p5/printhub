import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/**
 * Serves the built web app. Vite emits content-hashed files under /assets, so they are
 * cached forever; HTML is always revalidated. Pre-compressed .br/.gz siblings produced at
 * build time are preferred, so no CPU is spent compressing per request.
 */
export async function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse, pathname: string, fallback: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    return false;
  }
  let file = join(webDir, rel);
  if (!file.startsWith(webDir + sep) && file !== webDir) return false;

  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // Unknown asset paths 404; everything else is a client-side route.
    if (rel.startsWith('assets') || extname(rel)) return false;
    file = join(webDir, fallback);
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;
  }

  const ext = extname(file);
  const immutable = file.includes(`${sep}assets${sep}`);
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    vary: 'accept-encoding',
  };
  const accept = String(req.headers['accept-encoding'] ?? '');
  let body = file;
  let size = info.size;
  for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (!accept.includes(enc)) continue;
    const c = await stat(file + suffix).catch(() => null);
    if (c?.isFile()) {
      body = file + suffix;
      size = c.size;
      headers['content-encoding'] = enc;
      break;
    }
  }
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  headers.etag = etag;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['content-length'] = size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(body).pipe(res);
  return true;
}
