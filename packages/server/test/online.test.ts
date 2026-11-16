import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, setupShop, waitFor } from './helpers.ts';

const publicUrl = (app: { config: { publicPort: number } }) => `http://127.0.0.1:${app.config.publicPort}`;

test('public listener exposes customer routes only, with CORS for the hosted app', async (t) => {
  const { app, admin } = await boot();
  t.after(() => app.close());
  await setupShop(app, admin);
  const base = publicUrl(app);
  const cf = { 'cf-connecting-ip': '203.0.113.9' };

  const cfg = await fetch(`${base}/api/shop/config`, { headers: { ...cf, origin: 'https://r4p5.github.io' } });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.headers.get('access-control-allow-origin'), 'https://r4p5.github.io');

  // Other origins get no CORS grant.
  const evil = await fetch(`${base}/api/shop/config`, { headers: { ...cf, origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const pre = await fetch(`${base}/api/jobs`, { method: 'OPTIONS', headers: { origin: 'https://r4p5.github.io' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /x-job-token/);

  // The dashboard does not exist on the internet side, even with the right token.
  for (const path of ['/api/admin/overview', '/api/admin/settings', '/api/printers']) {
    const r = await fetch(base + path, { headers: { ...cf, 'x-admin-token': app.adminToken } });
    assert.equal(r.status, 404, path);
  }
  assert.equal((await fetch(`${base}/admin`, { headers: cf })).status, 404);

  // Visitors are rate limited by their real address, not the tunnel's loopback address.
  let limited = 0;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { ...cf, 'content-type': 'application/json' }, body: '{}' });
    if (r.status === 429) limited++;
  }
  assert.equal(limited, 2);
  const other = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.7', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(other.status, 201);
});

// The fake cloudflared is a shebang script, which Windows cannot execute directly.
test('tunnel starts cloudflared, registers the address, and stops when the shop closes', { skip: process.platform === 'win32' }, async (t) => {
  // Fake directory
  const registrations: { auth: string; body: { mobile: string; url: string } }[] = [];
  const dir = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      registrations.push({ auth: String(req.headers.authorization), body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => dir.listen(0, '127.0.0.1', r));
  const dirPort = (dir.address() as { port: number }).port;
  t.after(() => dir.close());

  // Fake cloudflared: prints what the real one prints, then stays alive.
  const bin = join(mkdtempSync(join(tmpdir(), 'cfd-')), 'cloudflared');
  writeFileSync(bin, `#!${process.execPath}
process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n');
process.stderr.write('INF |  https://shiny-test-words.trycloudflare.com  |\\n');
setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0\\n'), 100);
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);

  const { app, admin } = await boot(undefined, 150, { cloudflaredPath: bin, directoryUrl: `http://127.0.0.1:${dirPort}` });
  t.after(() => app.close());
  await setupShop(app, admin);
  app.tunnel.sync();

  await waitFor(() => app.tunnel.get(), (s) => s.state === 'online');
  assert.equal(app.tunnel.get().url, 'https://shiny-test-words.trycloudflare.com');
  assert.equal(registrations[0]!.body.mobile, '9066191970');
  assert.equal(registrations[0]!.body.url, 'https://shiny-test-words.trycloudflare.com');
  assert.equal(registrations[0]!.auth, `Bearer ${app.settings.get('online').directorySecret}`);

  // The QR no longer depends on the PC's IP address.
  const overview = (await admin('GET', '/api/admin/overview')).body;
  assert.equal(overview.customerUrl, 'https://r4p5.github.io/9066191970');
  assert.equal(overview.online.tunnel.state, 'online');
  assert.equal(JSON.stringify(overview).includes(app.settings.get('online').directorySecret), false, 'secret never sent to UI');

  // Closing the shop stops the tunnel process.
  await admin('PUT', '/api/shop/config', { general: { open: false } });
  await waitFor(() => app.tunnel.get(), (s) => s.state === 'off');
});
