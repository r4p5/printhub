import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { Cleanup } from './cleanup.ts';
import { dirs, ensureDirs, loadConfig, type ServerConfig } from './config.ts';
import { Db } from './db.ts';
import { EventHub } from './events.ts';
import { HttpError, Router, isLoopback, isPrivateIp, normalizeIp, sendJson } from './http.ts';
import { Jobs } from './jobs.ts';
import { initLog, log } from './log.ts';
import { PdfPool } from './pdf/pool.ts';
import { Printers } from './printers.ts';
import type { PrinterDriver } from './printing/driver.ts';
import { MockDriver } from './printing/mock.ts';
import { WindowsDriver } from './printing/windows.ts';
import { PrintQueue } from './queue.ts';
import { adminRoutes } from './routes/admin.ts';
import { customerRoutes } from './routes/customer.ts';
import { Settings } from './settings.ts';
import { serveStatic } from './static.ts';

export const VERSION = '0.1.0';

export interface App {
  version: string;
  config: ServerConfig;
  db: Db;
  settings: Settings;
  printers: Printers;
  jobs: Jobs;
  queue: PrintQueue;
  pool: PdfPool;
  hub: EventHub;
  driver: PrinterDriver;
  server: Server;
  /** Token for the desktop UI's admin API calls. */
  adminToken: string;
  url: string;
  close(): Promise<void>;
}

export interface StartOptions extends Partial<ServerConfig> {
  /** Inject a driver (tests). */
  driverInstance?: PrinterDriver;
  /** Skip printer discovery at startup (tests). */
  skipDiscovery?: boolean;
}

export async function startServer(opts: StartOptions = {}): Promise<App> {
  const config = loadConfig(opts);
  ensureDirs(config.dataDir);
  const d = dirs(config.dataDir);
  initLog(d.logs);

  const db = new Db(d.database);
  const settings = new Settings(db);
  const driver: PrinterDriver =
    opts.driverInstance ??
    (config.driver === 'windows' ? new WindowsDriver(config.sumatraPath ?? join(process.cwd(), 'SumatraPDF.exe')) : new MockDriver(d.mockOutput));
  const hub = new EventHub();
  const pool = new PdfPool();
  const printers = new Printers(db, driver);
  const jobs = new Jobs(db, settings, printers, hub, d.jobs, settings.get('adminToken'));
  const queue = new PrintQueue(db, jobs, printers, driver, pool, hub);
  const cleanup = new Cleanup(db, jobs, settings, d.jobs);

  const router = new Router();
  const app = { version: VERSION, config, db, settings, printers, jobs, queue, pool, hub, driver, adminToken: settings.get('adminToken') } as App;
  customerRoutes(router, app);
  adminRoutes(router, app);

  const devCors = process.env.PRINTHUB_DEV_CORS === '1';

  const server = createServer(async (req, res) => {
    const ip = normalizeIp(req.socket.remoteAddress);
    // Only the local network may talk to the shop computer.
    if (!isPrivateIp(ip)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        if (devCors) {
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader('access-control-allow-headers', 'content-type, x-job-token, x-admin-token, x-upload-id');
          res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
          if (req.method === 'OPTIONS') {
            res.writeHead(204).end();
            return;
          }
        }
        const m = router.match(req.method ?? 'GET', path);
        if (m === undefined) throw new HttpError(404, 'Not found');
        if (m === 'method') throw new HttpError(405, 'Method not allowed');
        const result = await m.handler({ req, res, params: m.params, query: url.searchParams, ip });
        if (!res.headersSent) sendJson(res, res.statusCode === 200 ? 200 : res.statusCode, result ?? { ok: true });
        return;
      }
      if (config.webDir) {
        const admin = path === '/admin' || path.startsWith('/admin/');
        if (admin && !isLoopback(ip)) throw new HttpError(403, 'Forbidden');
        if (await serveStatic(config.webDir, req, res, path, admin ? 'admin.html' : 'index.html')) return;
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, code: e.code });
      else {
        log.error(`${req.method} ${path} failed`, e);
        sendJson(res, 500, { error: 'Something went wrong on the shop computer' });
      }
    }
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 15_000;
  server.requestTimeout = 10 * 60_000; // large uploads on slow Wi-Fi
  server.maxConnections = 256;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') config.port = addr.port;

  queue.recover();
  cleanup.start();
  if (!opts.skipDiscovery) {
    printers
      .discover()
      .then(() => queue.kick())
      .catch((e) => log.warn('initial printer discovery failed', { error: (e as Error).message }));
  }

  let closing: Promise<void> | null = null;
  Object.assign(app, {
    server,
    url: `http://127.0.0.1:${config.port}`,
    close: () =>
      (closing ??= (async () => {
        cleanup.stop();
        await queue.stop();
        await jobs.drain();
        hub.closeAll();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await pool.close();
        await driver.close();
        db.close();
        await log.close();
      })()),
  });
  log.info(`PrintHub ${VERSION} listening on ${config.host}:${config.port} (driver: ${config.driver}, data: ${config.dataDir})`);
  return app;
}
export { lanAddresses } from './network.ts';
