import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DocumentKind, PrintOptions } from '@printhub/shared';
import type { InspectResult } from './render.ts';

const IDLE_MS = 30_000;

interface Pending {
  msg: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * Single lazily-started worker thread for all PDF work. One task runs at a time to cap
 * memory (pdf-lib holds whole documents in RAM); quick inspections jump ahead of renders so
 * customers' uploads stay snappy while a large job is being prepared. The thread exits after
 * a short idle period, returning its heap to the OS.
 */
export class PdfPool {
  private worker: Worker | null = null;
  private fast: Pending[] = [];
  private slow: Pending[] = [];
  private current: (Pending & { id: number }) | null = null;
  private seq = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  inspect(path: string, kind: DocumentKind) {
    return this.enqueue(this.fast, { op: 'inspect', path, kind }) as Promise<InspectResult>;
  }

  render(path: string, kind: DocumentKind, options: PrintOptions, out: string) {
    return this.enqueue(this.slow, { op: 'render', path, kind, options, out }) as Promise<number>;
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const w = this.worker;
    this.worker = null;
    await w?.terminate();
  }

  private enqueue(queue: Pending[], msg: Record<string, unknown>) {
    return new Promise((resolve, reject) => {
      queue.push({ msg, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.current) return;
    const next = this.fast.shift() ?? this.slow.shift();
    if (!next) {
      this.scheduleIdle();
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const w = this.ensureWorker();
    this.current = { ...next, id: ++this.seq };
    w.postMessage({ ...next.msg, id: this.current.id });
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const w = new Worker(workerUrl(), { resourceLimits: { maxOldGenerationSizeMb: 768 } });
    w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const cur = this.current;
      if (!cur || cur.id !== m.id) return;
      this.current = null;
      if (m.ok) cur.resolve(m.result);
      else cur.reject(new Error(m.error));
      this.pump();
    });
    const fail = (err: Error) => {
      if (this.worker !== w) return;
      this.worker = null;
      const cur = this.current;
      this.current = null;
      cur?.reject(err.message.includes('memory') ? new Error('TOO_LARGE') : err);
      this.pump();
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`PDF worker exited (${code})`)));
    w.unref();
    this.worker = w;
    return w;
  }

  private scheduleIdle() {
    if (!this.worker || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.current) void this.close();
    }, IDLE_MS);
    this.idleTimer.unref();
  }
}

function workerUrl(): URL {
  // Source runs as .ts; the bundled build emits pdf-worker.js next to the server bundle.
  const ts = new URL('./pdf-worker.ts', import.meta.url);
  if (existsSync(fileURLToPath(ts))) return ts;
  // Inside a packaged Electron app the worker is unpacked from the asar archive.
  const js = fileURLToPath(new URL('./pdf-worker.js', import.meta.url));
  return pathToFileURL(js.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'));
}
