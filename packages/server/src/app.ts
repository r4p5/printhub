import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
import { Tunnel } from './tunnel.ts';

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
  /** Loopback-only listener that cloudflared forwards internet traffic to. */
  publicServer: Server;
  tunnel: Tunnel;
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

  const app = { version: VERSION, config, db, settings, printers, jobs, queue, pool, hub, driver, adminToken: settings.get('adminToken') } as App;

  // LAN listener: dashboard (loopback + token) and in-shop customers.
  const lanRouter = new Router();
  customerRoutes(lanRouter, app, { public: false });
  adminRoutes(lanRouter, app);
  // Internet listener: customer routes only. Admin routes are not merely guarded here, they don't exist.
  const publicRouter = new Router();
  customerRoutes(publicRouter, app, { public: true });

  const devCors = process.env.PRINTHUB_DEV_CORS === '1';

  const server = createServer(
    handler(lanRouter, (req) => {
      const ip = normalizeIp(req.socket.remoteAddress);
      // Only the local network may talk to the LAN listener.
      return isPrivateIp(ip) ? ip : null;
    }, devCors ? () => '*' : () => null),
  );

  const publicServer = createServer(
    handler(publicRouter, (req) => {
      // Bound to loopback, so the only peer is the local cloudflared. The visitor's address comes
      // from Cloudflare's header and is used solely for rate limiting.
      if (!isLoopback(normalizeIp(req.socket.remoteAddress))) return null;
      const cf = req.headers['cf-connecting-ip'];
      return typeof cf === 'string' && cf ? `cf:${cf}` : 'cf:unknown';
    }, (origin) => (origin && allowedOrigin(origin) ? origin : null)),
  );

  /** The hosted customer app (GitHub Pages) calls the shop from another origin. */
  function allowedOrigin(origin: string) {
    try {
      return new URL(settings.get('general').launcherBaseUrl).origin === origin;
    } catch {
      return false;
    }
  }

  function handler(router: Router, clientIp: (req: IncomingMessage) => string | null, corsOrigin: (origin: string | undefined) => string | null) {
    const isPublic = router === publicRouter;
    return async (req: IncomingMessage, res: ServerResponse) => {
      const ip = clientIp(req);
      if (ip === null) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      try {
        if (path.startsWith('/api/')) {
          const origin = corsOrigin(req.headers.origin);
          if (origin) {
            res.setHeader('access-control-allow-origin', origin);
            res.setHeader('vary', 'origin');
            if (req.method === 'OPTIONS') {
              res.writeHead(204, {
                'access-control-allow-headers': 'content-type, x-job-token, x-admin-token, x-upload-id',
                'access-control-allow-methods': 'GET, POST, PUT, DELETE',
                'access-control-max-age': '86400',
              });
              res.end();
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
        if (config.webDir && !isPublic) {
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
    };
  }

  for (const s of [server, publicServer]) {
    s.keepAliveTimeout = 5_000;
    s.headersTimeout = 15_000;
    s.requestTimeout = 10 * 60_000; // large uploads on slow connections
    s.maxConnections = 256;
  }

  await listen(server, config.port, config.host);
  // Loopback only: nothing on the network can reach the public listener except through cloudflared.
  await listen(publicServer, config.publicPort, '127.0.0.1');
  for (const [s, key] of [[server, 'port'], [publicServer, 'publicPort']] as const) {
    const addr = s.address();
    if (addr && typeof addr === 'object') config[key] = addr.port;
  }

  const tunnel = new Tunnel(settings, hub, config.cloudflaredPath, `http://127.0.0.1:${config.publicPort}`, config.directoryUrl);
  // Settings changes (open/close, online toggle) arrive as admin 'settings' events.
  hub.listen((channel, event) => channel === 'admin' && event === 'settings' && tunnel.sync());

  queue.recover();
  cleanup.start();
  tunnel.sync();
  if (!opts.skipDiscovery) {
    printers
      .discover()
      .then(() => queue.kick())
      .catch((e) => log.warn('initial printer discovery failed', { error: (e as Error).message }));
  }

  let closing: Promise<void> | null = null;
  Object.assign(app, {
    server,
    publicServer,
    tunnel,
    url: `http://127.0.0.1:${config.port}`,
    close: () =>
      (closing ??= (async () => {
        cleanup.stop();
        await tunnel.close();
        await queue.stop();
        await jobs.drain();
        hub.closeAll();
        for (const s of [server, publicServer]) {
          s.closeAllConnections();
          await new Promise<void>((r) => s.close(() => r()));
        }
        await pool.close();
        await driver.close();
        db.close();
        await log.close();
      })()),
  });
  log.info(`PrintHub ${VERSION} listening on ${config.host}:${config.port}, public 127.0.0.1:${config.publicPort} (driver: ${config.driver}, data: ${config.dataDir})`);
  return app;
}
function listen(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export { lanAddresses } from './network.ts';
