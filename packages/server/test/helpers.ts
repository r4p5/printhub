import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { startServer, type App } from '../src/app.ts';
import { MockDriver } from '../src/printing/mock.ts';

process.env.NODE_ENV = 'test';

export async function boot(dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'printhub-')), printMs = 150) {
  const driver = new MockDriver(join(dataDir, 'mock-output'), printMs);
  const app = await startServer({ dataDir, port: 0, host: '127.0.0.1', driverInstance: driver, skipDiscovery: true });
  return { app, driver, dataDir, ...client(app) };
}

export function client(app: App) {
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await fetch(app.url + path, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const admin = (method: string, path: string, body?: unknown) => call(method, path, body, { 'x-admin-token': app.adminToken });
  return { call, admin };
}

/** Configures a ready-to-use shop: details, payment, both mock printers enabled. */
export async function setupShop(app: App, admin: ReturnType<typeof client>['admin']) {
  await admin('PUT', '/api/shop/config', { shop: { shopName: 'Sri Sai Xerox', mobileNumber: '9066191970' } });
  await admin('PUT', '/api/admin/payment', { upiId: 'srisai@upi', merchantName: 'Sri Sai Xerox', instructions: '' });
  await admin('PUT', '/api/pricing', { bwPerSide: 200, colorPerSide: 1000, bwDuplexPerSide: 150, colorDuplexPerSide: null, minimumOrder: 500, maxCopies: 20 });
  const printers = (await admin('POST', '/api/printers/discover')).body as { id: string; caps: { color: boolean } }[];
  for (const p of printers) await admin('PUT', `/api/printers/${p.id}`, { enabled: true, role: p.caps.color ? 'color' : 'bw' });
  // Test hosts may lack a LAN interface, so mark setup complete directly.
  app.settings.set('general', { ...app.settings.get('general'), setupComplete: true, open: true });
  return printers;
}

export async function makePdf(sizes: [number, number][]) {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  return doc.save({ useObjectStreams: false });
}

export function makePng(w = 4, h = 2) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function form(bytes: Uint8Array, name: string, type = 'application/octet-stream') {
  const f = new FormData();
  f.append('file', new Blob([bytes], { type }), name);
  return f;
}

export async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
