/**
 * PrintHub directory: maps a shop's mobile number to the public URL its PC is currently
 * reachable at. It stores one small record per shop and never sees documents or orders.
 *
 *   GET  /shop/:mobile   -> { url, updatedAt }       (public, used by the customer app)
 *   POST /register       { mobile, url } + Bearer     (called by the shop PC when its URL changes)
 *
 * The first PC to register a number owns it (its secret's hash is stored); later updates must
 * present the same secret. To move a shop to a new PC, delete its key with
 * `wrangler kv key delete --binding SHOPS <mobile> --remote`.
 */

interface Env {
  SHOPS: KVNamespace;
  /** Comma-separated host suffixes a shop may point to, e.g. ".trycloudflare.com,.printhub.eu.org" */
  ALLOWED_HOST_SUFFIXES: string;
  /** Origin of the hosted customer app, for CORS. */
  APP_ORIGIN: string;
}

interface ShopRecord {
  url: string;
  secretHash: string;
  updatedAt: number;
}

const MOBILE = /^[6-9]\d{9}$/;

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
}

/** Only https URLs on approved hosts, so a hijacked record can't send customers to an arbitrary site. */
function allowedUrl(raw: unknown, env: Env): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.port) return null;
  const host = u.hostname.toLowerCase();
  const ok = env.ALLOWED_HOST_SUFFIXES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((s) => host.endsWith(s));
  return ok ? `https://${host}` : null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = { 'access-control-allow-origin': env.APP_ORIGIN, vary: 'origin' };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' } });

    const lookup = /^\/shop\/(\d{10})$/.exec(url.pathname);
    if (req.method === 'GET' && lookup) {
      const mobile = lookup[1]!;
      if (!MOBILE.test(mobile)) return json({ error: 'Invalid shop number' }, 400, cors);
      const rec = await env.SHOPS.get<ShopRecord>(mobile, { type: 'json', cacheTtl: 30 });
      if (!rec) return json({ error: 'Shop not found' }, 404, { ...cors, 'cache-control': 'public, max-age=30' });
      // Short cache: a restarted shop PC gets a new address and should be found within seconds.
      return json({ url: rec.url, updatedAt: rec.updatedAt }, 200, { ...cors, 'cache-control': 'public, max-age=15' });
    }

    if (req.method === 'POST' && url.pathname === '/register') {
      const secret = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (secret.length < 32) return json({ error: 'Missing secret' }, 401);
      let body: { mobile?: unknown; url?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      if (typeof body.mobile !== 'string' || !MOBILE.test(body.mobile)) return json({ error: 'Invalid mobile number' }, 400);
      const target = allowedUrl(body.url, env);
      if (!target) return json({ error: 'URL not allowed' }, 400);
      const secretHash = await sha256(secret);
      const existing = await env.SHOPS.get<ShopRecord>(body.mobile, { type: 'json' });
      if (existing && existing.secretHash !== secretHash) return json({ error: 'Number registered to another installation' }, 403);
      // Skip identical writes: KV writes are rationed on the free plan.
      if (existing?.url === target) return json({ ok: true, unchanged: true }, 200);
      await env.SHOPS.put(body.mobile, JSON.stringify({ url: target, secretHash, updatedAt: Date.now() } satisfies ShopRecord));
      return json({ ok: true }, 200);
    }

    return json({ error: 'Not found' }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
