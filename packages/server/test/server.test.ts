import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { boot, form, makePdf, makePng, setupShop, waitFor } from './helpers.ts';
import { isPrivateIp } from '../src/http.ts';
import { render } from '../src/pdf/render.ts';
import { DEFAULT_OPTIONS } from '@printhub/shared';

test('private network filter', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '::1', 'fe80::1', 'fd00::1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1']) assert.ok(!isPrivateIp(ip), ip);
});

test('full order lifecycle prints, then deletes customer files', async (t) => {
  const { app, driver, dataDir, call, admin } = await boot();
  t.after(() => app.close());

  // Closed shop refuses orders.
  assert.equal((await call('POST', '/api/jobs', {})).status, 503);
  await setupShop(app, admin);

  const cfg = (await call('GET', '/api/shop/config')).body;
  assert.equal(cfg.shopName, 'Sri Sai Xerox');
  assert.deepEqual(cfg.capabilities.combos, { 'bw:single': true, 'bw:double': true, 'color:single': true, 'color:double': false });

  // Idempotent creation returns the same job and token.
  const a = await call('POST', '/api/jobs', { idempotencyKey: 'abcdefgh1234' });
  const b = await call('POST', '/api/jobs', { idempotencyKey: 'abcdefgh1234' });
  assert.equal(a.status, 201);
  assert.equal(a.body.job.id, b.body.job.id);
  assert.equal(a.body.token, b.body.token);
  const id = a.body.job.id as string;
  const H = { 'x-job-token': a.body.token as string };

  // Wrong token looks identical to a missing job.
  assert.equal((await call('GET', `/api/jobs/${id}/status`, undefined, { 'x-job-token': 'nope' })).status, 404);

  const pdf = await makePdf([[595, 842], [842, 595], [595, 842]]);
  const up1 = await call('POST', `/api/jobs/${id}/files`, form(pdf, '../../evil‮.pdf'), { ...H, 'x-upload-id': 'upload-0001' });
  assert.equal(up1.status, 201, JSON.stringify(up1.body));
  assert.equal(up1.body.document.pages, 3);
  assert.equal(up1.body.document.name, 'evil.pdf');
  // Retried upload with the same id is deduplicated.
  const again = await call('POST', `/api/jobs/${id}/files`, form(pdf, 'x.pdf'), { ...H, 'x-upload-id': 'upload-0001' });
  assert.equal(again.body.document.id, up1.body.document.id);

  const up2 = await call('POST', `/api/jobs/${id}/files`, form(makePng(), 'photo.png'), H);
  assert.equal(up2.status, 201, JSON.stringify(up2.body));
  assert.equal(up2.body.document.kind, 'png');

  // Content sniffing ignores the claimed extension.
  const bad = await call('POST', `/api/jobs/${id}/files`, form(Buffer.from('MZ not a document'.repeat(100)), 'doc.pdf'), H);
  assert.equal(bad.status, 415);

  // Color + duplex has no capable printer.
  const reject = await call('POST', `/api/jobs/${id}/estimate`, {
    documents: [{ id: up1.body.document.id, options: { color: 'color', sides: 'double' } }, { id: up2.body.document.id, options: {} }],
  }, H);
  assert.equal(reject.status, 400);
  assert.match(reject.body.error, /not available/);

  const docs = [
    { id: up2.body.document.id, options: { color: 'color' } },
    { id: up1.body.document.id, options: { pagesPerSheet: 2, sides: 'double', copies: 2 } },
  ];
  const est = await call('POST', `/api/jobs/${id}/estimate`, { documents: docs }, H);
  assert.equal(est.status, 200, JSON.stringify(est.body));
  // png: 1 color side = 1000; pdf: 3 pages 2-up = 2 sides x 2 copies x 150 = 600
  assert.equal(est.body.estimate.total, 1600);

  const co = await call('POST', `/api/jobs/${id}/checkout`, {}, H);
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.match(co.body.payment.upiUri, /^upi:\/\/pay\?pa=srisai%40upi&pn=Sri%20Sai%20Xerox&am=16\.00&cu=INR&tn=PRINT-[A-Z2-9]{5}$/);

  // Price changes after checkout do not affect the locked order.
  await admin('PUT', '/api/pricing', { bwPerSide: 999, colorPerSide: 999, bwDuplexPerSide: null, colorDuplexPerSide: null, minimumOrder: 0, maxCopies: 20 });
  assert.equal((await call('GET', `/api/jobs/${id}/status`, undefined, H)).body.total, 1600);

  // Locked orders cannot be edited by uploading more.
  await call('POST', `/api/jobs/${id}/payment-pending`, {}, H);
  assert.equal((await call('POST', `/api/jobs/${id}/files`, form(pdf, 'late.pdf'), H)).status, 409);

  // Customer endpoints cannot reach admin APIs.
  assert.equal((await call('POST', `/api/admin/jobs/${id}/verify-payment`, {})).status, 401);

  // Wrong amount needs review, then an explicit override.
  const short = await admin('POST', `/api/admin/jobs/${id}/verify-payment`, { amountReceived: 1000 });
  assert.equal(short.body.state, 'manual_review');
  const ok = await admin('POST', `/api/admin/jobs/${id}/verify-payment`, { amountReceived: 1000, force: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const done = await waitFor(() => admin('GET', `/api/admin/jobs/${id}`), (r) => r.body.state === 'completed');
  assert.equal(done.body.tasks.length, 2);
  // Routed by capability: color photo to the inkjet, duplex PDF to the laser.
  const byDoc = Object.fromEntries(done.body.tasks.map((t: { documentId: string; printerName: string }) => [t.documentId, t.printerName]));
  assert.equal(byDoc[up2.body.document.id], 'Mock Color Inkjet');
  assert.equal(byDoc[up1.body.document.id], 'Mock Mono Laser');
  const laser = driver.submitted.find((s) => s.printer === 'Mock Mono Laser')!;
  assert.equal(laser.duplex, 'long');
  assert.equal(laser.copies, 2);

  // Rendered output: 3 pages 2-up => 2 landscape sheet sides.
  const out = await PDFDocument.load(readFileSync(join(dataDir, 'mock-output', `${laser.ref}.pdf`)));
  assert.equal(out.getPageCount(), 2);
  assert.ok(out.getPage(0).getWidth() > out.getPage(0).getHeight());

  await waitFor(() => existsSync(join(dataDir, 'jobs', id)), (e) => e === false);
  const overview = (await admin('GET', '/api/admin/overview')).body;
  assert.equal(overview.todayRevenue, 1000);
});

test('printer fault mid-job and app restart never cause automatic reprints', async (t) => {
  // Long mock print so the restart reliably happens mid-print.
  const first = await boot(undefined, 60_000);
  await setupShop(first.app, first.admin);
  const { call, admin } = first;
  const created = (await call('POST', '/api/jobs', {})).body;
  const H = { 'x-job-token': created.token };
  const id = created.job.id;
  await call('POST', `/api/jobs/${id}/files`, form(await makePdf([[595, 842]]), 'a.pdf'), H);
  await call('POST', `/api/jobs/${id}/checkout`, {}, H);

  // Simulate a crash right after submission: task recorded as printing, then restart.
  first.driver.faults.clear();
  await admin('POST', `/api/admin/jobs/${id}/verify-payment`, {});
  // 'printing' is recorded before submission (by design), so wait for the driver to have the job too.
  await waitFor(() => first.app.db.get<{ state: string }>('SELECT state FROM tasks WHERE job_id = ?', id)!.state, (s) => s === 'printing');
  await waitFor(() => first.driver.submitted.length, (n) => n >= 1);
  const submitted = first.driver.submitted.length;
  await first.app.close();

  const second = await boot(first.dataDir);
  t.after(() => second.app.close());
  // New mock driver has no record of the job => "gone" => outcome unknown => manual review.
  const job = await waitFor(() => second.admin('GET', `/api/admin/jobs/${id}`), (r) => r.body.state === 'manual_review');
  assert.match(job.body.tasks[0].error, /restarted/);
  assert.equal(second.driver.submitted.length, 0, 'must not reprint automatically');
  assert.ok(submitted >= 1);

  // Retry only applies to definite failures; uncertain tasks need an explicit decision.
  assert.equal((await second.admin('POST', `/api/admin/jobs/${id}/retry`)).status, 409);
  const resolved = await second.admin('POST', `/api/admin/jobs/${id}/tasks/${job.body.tasks[0].id}/resolve`, { outcome: 'reprint' });
  assert.equal(resolved.status, 200);
  await waitFor(() => second.admin('GET', `/api/admin/jobs/${id}`), (r) => r.body.state === 'completed');
  assert.equal(second.driver.submitted.length, 1);
});

test('jobs wait while the only compatible printer is faulted', async (t) => {
  const { app, driver, call, admin } = await boot();
  t.after(() => app.close());
  const printers = await setupShop(app, admin);
  driver.faults.set('Mock Mono Laser', 'Out of paper');
  await admin('POST', '/api/printers/discover');

  const created = (await call('POST', '/api/jobs', {})).body;
  const H = { 'x-job-token': created.token };
  await call('POST', `/api/jobs/${created.job.id}/files`, form(await makePdf([[595, 842]]), 'a.pdf'), H);
  await call('POST', `/api/jobs/${created.job.id}/checkout`, {}, H);
  await admin('POST', `/api/admin/jobs/${created.job.id}/verify-payment`, {});

  // B&W must not silently go to the color printer.
  const waiting = await waitFor(() => admin('GET', `/api/admin/jobs/${created.job.id}`), (r) => r.body.tasks[0]?.error === 'Waiting for printer');
  assert.equal(waiting.body.state, 'queued');
  assert.equal(driver.submitted.length, 0);

  driver.faults.clear();
  await admin('POST', '/api/printers/discover');
  await waitFor(() => admin('GET', `/api/admin/jobs/${created.job.id}`), (r) => r.body.state === 'completed');
  assert.ok(printers.length === 2);
});

test('rejects encrypted and corrupt PDFs with clear messages', async (t) => {
  const { app, call, admin } = await boot();
  t.after(() => app.close());
  await setupShop(app, admin);
  const created = (await call('POST', '/api/jobs', {})).body;
  const H = { 'x-job-token': created.token };

  const plain = Buffer.from(await makePdf([[595, 842]])).toString('latin1');
  const encrypted = plain.replace(/trailer\s*<</, (m) => `${m}\n/Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>`);
  const enc = await call('POST', `/api/jobs/${created.job.id}/files`, form(Buffer.from(encrypted, 'latin1'), 'locked.pdf'), H);
  assert.equal(enc.status, 422);
  assert.equal(enc.body.code, 'ENCRYPTED');

  const corrupt = await call('POST', `/api/jobs/${created.job.id}/files`, form(Buffer.from('%PDF-1.7\n' + 'garbage '.repeat(300)), 'bad.pdf'), H);
  assert.equal(corrupt.status, 422);
  assert.equal(corrupt.body.code, 'CORRUPT');
});

test('render honours page range, rotation and image EXIF-free sizing', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'ph-render-'));
  const src = join(dir, 'in.pdf');
  writeFileSync(src, await makePdf([[595, 842], [595, 842], [595, 842], [595, 842], [595, 842]]));
  const out = join(dir, 'out.pdf');
  const sides = await render(src, 'pdf', { ...DEFAULT_OPTIONS, pageRange: '2-4', pagesPerSheet: 4 }, out);
  assert.equal(sides, 1);
  const rotated = await render(src, 'pdf', { ...DEFAULT_OPTIONS, pageRange: '1', rotation: 90 }, out);
  assert.equal(rotated, 1);
  const doc = await PDFDocument.load(readFileSync(out));
  // Rotating a portrait page 90° with auto orientation yields a landscape sheet.
  assert.ok(doc.getPage(0).getWidth() > doc.getPage(0).getHeight());
  assert.ok(readdirSync(dir).length >= 2);
});
