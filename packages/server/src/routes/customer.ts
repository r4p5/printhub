import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateOrder, parseOptions, MAX_FILE_BYTES, MAX_FILES_PER_JOB, MAX_PAGES, OptionsError } from '@printhub/shared';
import type { App } from '../app.ts';
import { HttpError, RateLimiter, readJson, type Ctx, type Router } from '../http.ts';
import { ID_RE, newId, type JobRow } from '../jobs.ts';
import { receiveFile } from '../upload.ts';

const INSPECT_ERRORS: Record<string, [number, string, string]> = {
  ENCRYPTED: [422, 'This PDF is password protected. Please upload an unlocked copy.', 'ENCRYPTED'],
  CORRUPT: [422, 'This file is damaged or not a valid document.', 'CORRUPT'],
  TOO_MANY_PAGES: [422, `Documents can have at most ${MAX_PAGES} pages.`, 'TOO_MANY_PAGES'],
  TOO_LARGE: [422, 'This document is too complex to process.', 'TOO_LARGE'],
};

export function customerRoutes(r: Router, app: App) {
  const { jobs, settings, printers, pool, hub } = app;
  const createLimit = new RateLimiter(20, 60_000);
  const uploadLimit = new RateLimiter(60, 60_000);

  const auth = (ctx: Ctx): JobRow => jobs.authorize(ctx.params.id!, (ctx.req.headers['x-job-token'] as string | undefined) ?? ctx.query.get('token'));

  r.get('/api/shop/status', () => ({ ok: true, accepting: settings.acceptingJobs, configured: settings.get('shop') !== null }));

  r.get('/api/shop/config', () => {
    const shop = settings.get('shop');
    const pricing = settings.get('pricing');
    const pay = settings.get('payment');
    return {
      shopName: shop?.shopName ?? null,
      mobileNumber: shop?.mobileNumber ?? null,
      accepting: settings.acceptingJobs,
      pricing,
      capabilities: printers.capabilities(),
      merchantName: pay.merchantName || shop?.shopName || null,
      limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES_PER_JOB, maxCopies: pricing.maxCopies, maxPages: MAX_PAGES },
    };
  });

  r.get('/api/pricing', () => settings.get('pricing'));

  r.post('/api/pricing/estimate', async ({ req }) => {
    const body = await readJson<{ documents?: unknown }>(req);
    const list = Array.isArray(body.documents) ? body.documents.slice(0, MAX_FILES_PER_JOB) : [];
    const pricing = settings.get('pricing');
    try {
      return estimateOrder(
        list.map((d: { pages?: unknown; options?: unknown }) => {
          const pages = d?.pages;
          if (!Number.isInteger(pages) || (pages as number) < 1 || (pages as number) > MAX_PAGES * 10) throw new HttpError(400, 'Invalid page count');
          return { pages: pages as number, options: parseOptions(d.options, printers.capabilities(), pricing.maxCopies) };
        }),
        pricing,
      );
    } catch (e) {
      if (e instanceof OptionsError) throw new HttpError(400, e.message);
      throw e;
    }
  });

  r.post('/api/jobs', async (ctx) => {
    createLimit.check(ctx.ip);
    const body = await readJson<{ idempotencyKey?: unknown }>(ctx.req);
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
    const { job, token } = jobs.create(key);
    ctx.res.statusCode = 201;
    return { token, job: jobs.customerView(job) };
  });

  r.get('/api/jobs/:id/status', (ctx) => jobs.customerView(auth(ctx)));

  r.get('/api/jobs/:id/events', (ctx) => {
    const job = auth(ctx);
    if (!hub.subscribe(`job:${job.id}`, ctx.res)) throw new HttpError(503, 'Too many connections');
    jobs.publish(job.id);
  });

  r.post('/api/jobs/:id/files', async (ctx) => {
    uploadLimit.check(ctx.ip);
    const job = auth(ctx);
    jobs.assertEditable(job);
    // Client-chosen id makes retries idempotent: a re-sent file returns the existing document.
    const uploadId = ctx.req.headers['x-upload-id'];
    if (uploadId !== undefined && (typeof uploadId !== 'string' || !ID_RE.test(uploadId))) throw new HttpError(400, 'Invalid upload id');
    const docId = uploadId ? `d_${uploadId}` : newId('d_');
    const docs = jobs.documents(job.id);
    const existing = docs.find((d) => d.id === docId);
    if (existing) {
      ctx.req.resume();
      return { document: present(existing) };
    }
    if (docs.length >= MAX_FILES_PER_JOB) throw new HttpError(400, `At most ${MAX_FILES_PER_JOB} documents per order`);

    const file = await receiveFile(ctx.req, jobs.dir(job.id), docId);
    let pages: number;
    try {
      pages = (await pool.inspect(file.path, file.kind)).pages;
    } catch (e) {
      await rm(file.path, { force: true });
      const mapped = INSPECT_ERRORS[(e as Error).message];
      if (mapped) throw new HttpError(...mapped);
      throw e;
    }
    // Re-read: the job may have been checked out or cancelled while the file streamed in.
    const doc = jobs.addDocument(jobs.get(job.id), { id: docId, name: file.name, kind: file.kind, size: file.size, pages });
    ctx.res.statusCode = 201;
    return { document: present(doc) };
  });

  r.get('/api/jobs/:id/files/:docId', async (ctx) => {
    const job = auth(ctx);
    const doc = jobs.documents(job.id).find((d) => d.id === ctx.params.docId);
    if (!doc) throw new HttpError(404, 'Document not found');
    const path = join(jobs.dir(job.id), `${doc.id}.${doc.kind}`);
    const info = await stat(path).catch(() => null);
    if (!info) throw new HttpError(410, 'Document is no longer available');
    ctx.res.writeHead(200, {
      'content-type': doc.kind === 'pdf' ? 'application/pdf' : doc.kind === 'png' ? 'image/png' : 'image/jpeg',
      'content-length': info.size,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(path).pipe(ctx.res);
  });

  r.delete('/api/jobs/:id/files/:docId', async (ctx) => {
    await jobs.removeDocument(auth(ctx), ctx.params.docId!);
    return jobs.customerView(jobs.get(ctx.params.id!));
  });

  r.post('/api/jobs/:id/estimate', async (ctx) => {
    const job = auth(ctx);
    const body = await readJson<{ documents?: unknown }>(ctx.req);
    return { estimate: jobs.configure(job, body.documents) };
  });

  r.post('/api/jobs/:id/checkout', (ctx) => jobs.checkout(auth(ctx)));

  r.post('/api/jobs/:id/payment-pending', (ctx) => {
    const job = auth(ctx);
    jobs.markPaymentPending(job);
    return jobs.customerView(jobs.get(job.id));
  });

  r.post('/api/jobs/:id/cancel', async (ctx) => {
    await jobs.cancelByCustomer(auth(ctx));
    return jobs.customerView(jobs.get(ctx.params.id!));
  });
}

function present(d: { id: string; name: string; kind: string; size: number; pages: number; options: string }) {
  return { id: d.id, name: d.name, kind: d.kind, size: d.size, pages: d.pages, options: JSON.parse(d.options) };
}
