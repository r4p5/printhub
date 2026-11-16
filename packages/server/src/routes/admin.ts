import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { HttpError, isLoopback, readJson, safeEqual, type Ctx, type Router } from '../http.ts';
import { newId } from '../jobs.ts';
import { lanAddresses } from '../network.ts';
import { validateGeneral, validatePayment, validatePricing, validateShop } from '../settings.ts';

/**
 * Shopkeeper APIs. Reachable only from this computer (the desktop app) and only with the
 * admin token, which also defeats DNS-rebinding and cross-site requests from local browsers.
 */
export function adminRoutes(r: Router, app: App) {
  const { jobs, settings, printers, queue, hub, driver, config } = app;

  const guard = (handler: (ctx: Ctx) => unknown) => (ctx: Ctx) => {
    const token = (ctx.req.headers['x-admin-token'] as string | undefined) ?? ctx.query.get('token') ?? '';
    if (!isLoopback(ctx.ip) || !safeEqual(token, settings.get('adminToken'))) throw new HttpError(401, 'Not authorized');
    return handler(ctx);
  };
  const body = (ctx: Ctx) => readJson(ctx.req);

  r.get('/api/admin/session', guard(() => ({ ok: true })));

  r.get('/api/admin/events', guard((ctx) => {
    if (!hub.subscribe('admin', ctx.res)) throw new HttpError(503, 'Too many connections');
  }));

  r.get('/api/admin/settings', guard(() => ({
    shop: settings.get('shop'),
    payment: settings.get('payment'),
    pricing: settings.get('pricing'),
    general: settings.get('general'),
  })));

  r.get('/api/admin/overview', guard(async () => {
    const shop = settings.get('shop');
    const general = settings.get('general');
    const addrs = lanAddresses();
    const host = addrs[0] ? `${addrs[0].address}:${config.port}` : null;
    const fs = await statfs(config.dataDir).catch(() => null);
    return {
      ...jobs.overview(),
      accepting: settings.acceptingJobs,
      setupComplete: general.setupComplete,
      open: general.open,
      printers: printers.all(),
      queues: queue.snapshot(),
      server: {
        version: app.version,
        port: config.port,
        addresses: addrs,
        dataDir: config.dataDir,
        diskFreeBytes: fs ? fs.bavail * fs.bsize : null,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      // The QR target: static launcher (stable shop URL) carrying this PC's LAN address.
      customerUrl: shop && host ? `${general.launcherBaseUrl}/${shop.mobileNumber}#h=${host}` : null,
      directUrl: shop && host ? `http://${host}/?shop=${shop.mobileNumber}` : null,
    };
  }));

  // --- shop / settings ---------------------------------------------------------------------

  r.put('/api/shop/config', guard(async (ctx) => {
    const b = await body(ctx);
    if (b.shop !== undefined) settings.set('shop', validateShop(b.shop as Record<string, unknown>));
    if (b.general !== undefined) {
      const next = validateGeneral(b.general as Record<string, unknown>, settings.get('general'));
      if (next.open && !next.setupComplete) throw new HttpError(409, 'Finish setup before opening the shop');
      settings.set('general', next);
    }
    hub.publish('admin', 'settings', {});
    return { shop: settings.get('shop'), general: settings.get('general') };
  }));

  r.put('/api/pricing', guard(async (ctx) => {
    // Existing orders keep the price snapshot taken at checkout.
    settings.set('pricing', validatePricing(await body(ctx)));
    return settings.get('pricing');
  }));

  r.get('/api/admin/payment', guard(() => settings.get('payment')));
  r.put('/api/admin/payment', guard(async (ctx) => {
    settings.set('payment', validatePayment(await body(ctx)));
    return settings.get('payment');
  }));

  r.post('/api/admin/setup/complete', guard(() => {
    const problems: string[] = [];
    if (!settings.get('shop')) problems.push('Shop name and mobile number are not set');
    if (!settings.get('payment').upiId) problems.push('UPI ID is not set');
    if (!printers.all().some((p) => p.enabled && p.present)) problems.push('Enable at least one printer');
    if (lanAddresses().length === 0) problems.push('This computer is not connected to a local network');
    if (problems.length) throw new HttpError(409, problems.join('; '), 'SETUP_INCOMPLETE');
    settings.set('general', { ...settings.get('general'), setupComplete: true, open: true });
    return settings.get('general');
  }));

  // --- printers -----------------------------------------------------------------------------

  r.get('/api/printers', guard(() => printers.all()));
  r.post('/api/printers/discover', guard(async () => {
    const list = await printers.discover();
    queue.kick();
    return list;
  }));
  r.put('/api/printers/:id', guard(async (ctx) => {
    const p = printers.update(ctx.params.id!, await body(ctx));
    queue.kick();
    return p;
  }));
  r.post('/api/printers/:id/test', guard(async (ctx) => {
    const p = printers.get(ctx.params.id!);
    if (!p) throw new HttpError(404, 'Printer not found');
    const ref = `PH-test-${newId('')}`;
    // Kept under jobs/_test so the cleanup sweep removes leftovers if the app exits before the timer.
    const dir = join(config.dataDir, 'jobs', '_test');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${ref}.pdf`);
    // Loaded on demand so pdf-lib stays out of the main process unless a test print is requested.
    const { testPage } = await import('../testpage.ts');
    await writeFile(file, await testPage(p.name, settings.get('shop')?.shopName ?? 'PrintHub'));
    await driver.submit({ file, printer: p.name, color: p.caps.color ? 'color' : 'bw', duplex: 'simplex', copies: 1, ref });
    // Give the spooler time to read the file before deleting it.
    setTimeout(() => void rm(file, { force: true }), 120_000).unref();
    return { ok: true };
  }));

  // --- jobs ---------------------------------------------------------------------------------

  r.get('/api/admin/jobs', guard((ctx) => {
    const states = ctx.query.get('state')?.split(',').filter(Boolean) ?? null;
    const limit = Math.min(Number(ctx.query.get('limit') ?? 100) || 100, 500);
    return jobs.list(states, limit);
  }));

  r.get('/api/admin/jobs/:id', guard((ctx) => jobs.adminView(jobs.get(ctx.params.id!))));

  r.post('/api/admin/jobs/:id/verify-payment', guard(async (ctx) => {
    const b = await body(ctx);
    const amount = b.amountReceived === undefined || b.amountReceived === null ? null : (b.amountReceived as number);
    const job = jobs.verifyPayment(ctx.params.id!, amount, b.force === true);
    queue.kick();
    return jobs.adminView(job);
  }));

  r.post('/api/admin/jobs/:id/cancel', guard(async (ctx) => {
    await jobs.cancel(ctx.params.id!, 'admin');
    return jobs.adminView(jobs.get(ctx.params.id!));
  }));

  r.post('/api/admin/jobs/:id/retry', guard((ctx) => {
    jobs.retry(ctx.params.id!);
    queue.kick();
    return jobs.adminView(jobs.get(ctx.params.id!));
  }));

  r.post('/api/admin/jobs/:id/tasks/:taskId/resolve', guard(async (ctx) => {
    const b = await body(ctx);
    jobs.resolve(ctx.params.id!, ctx.params.taskId!, b.outcome);
    queue.kick();
    return jobs.adminView(jobs.get(ctx.params.id!));
  }));
}
