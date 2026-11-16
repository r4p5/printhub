import busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_FILE_BYTES, type DocumentKind } from '@printhub/shared';
import { HttpError } from './http.ts';

const MIN_FREE_BYTES = 500 * 1024 * 1024;
const HEAD_BYTES = 1024;

export function sniff(head: Buffer): DocumentKind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  // The PDF spec allows the header anywhere in the first 1024 bytes.
  if (head.subarray(0, HEAD_BYTES).includes('%PDF-')) return 'pdf';
  return null;
}

/** Holds back the first KB to identify the file type from its content, then streams through. */
class Sniffer extends Transform {
  kind: DocumentKind | null = null;
  private head: Buffer[] = [];
  private headLen = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    if (this.kind) return cb(null, chunk);
    this.head.push(chunk);
    this.headLen += chunk.length;
    if (this.headLen < HEAD_BYTES) return cb();
    this.decide(cb);
  }

  override _flush(cb: TransformCallback) {
    if (this.kind) return cb();
    this.decide(cb);
  }

  private decide(cb: TransformCallback) {
    const buf = Buffer.concat(this.head);
    this.head = [];
    this.kind = sniff(buf);
    if (!this.kind) return cb(new HttpError(415, 'Only PDF, JPG and PNG files are supported', 'UNSUPPORTED'));
    cb(null, buf);
  }
}

export function displayName(raw: string | undefined, kind: DocumentKind) {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  // Strip control and bidi-override characters; this name is only ever displayed.
  const clean = base.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, 120);
  return clean || `document.${kind}`;
}

/** Streams a single multipart file straight to disk; memory use is independent of file size. */
export async function receiveFile(req: IncomingMessage, dir: string, docId: string) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(415, 'Expected multipart/form-data');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_FILE_BYTES + 64 * 1024) throw new HttpError(413, `Files must be under ${MAX_FILE_BYTES / 1024 / 1024} MB`, 'TOO_LARGE');

  await mkdir(dir, { recursive: true });
  const fs = await statfs(dir);
  if (fs.bavail * fs.bsize < MIN_FREE_BYTES) throw new HttpError(507, 'The shop computer is low on disk space', 'DISK_FULL');

  const tmp = join(dir, `${docId}.part`);
  try {
    const result = await new Promise<{ kind: DocumentKind; name: string; size: number }>((resolve, reject) => {
      let bb: busboy.Busboy;
      try {
        bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 0, parts: 1 } });
      } catch {
        return reject(new HttpError(400, 'Malformed upload'));
      }
      let got = false;
      bb.on('file', (_field, stream, info) => {
        got = true;
        const sniffer = new Sniffer();
        let size = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => (size += c.length));
        stream.on('limit', () => (truncated = true));
        pipeline(stream, sniffer, createWriteStream(tmp))
          .then(() => {
            if (truncated) reject(new HttpError(413, `Files must be under ${MAX_FILE_BYTES / 1024 / 1024} MB`, 'TOO_LARGE'));
            else if (size === 0) reject(new HttpError(400, 'File is empty'));
            else resolve({ kind: sniffer.kind!, name: displayName(info.filename, sniffer.kind!), size });
          })
          .catch((e) => {
            stream.resume();
            reject(e instanceof HttpError ? e : new HttpError(400, 'Upload interrupted', 'INTERRUPTED'));
          });
      });
      bb.on('error', () => reject(new HttpError(400, 'Upload interrupted', 'INTERRUPTED')));
      bb.on('close', () => {
        if (!got) reject(new HttpError(400, 'No file received'));
      });
      req.on('aborted', () => reject(new HttpError(400, 'Upload interrupted', 'INTERRUPTED')));
      req.pipe(bb);
    });
    const final = join(dir, `${docId}.${result.kind}`);
    await rename(tmp, final);
    return { ...result, path: final };
  } catch (e) {
    await rm(tmp, { force: true });
    // Drain whatever the client is still sending so the connection can be reused/closed cleanly.
    req.resume();
    throw e;
  }
}
