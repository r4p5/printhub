// Downloads Cloudflare's tunnel client (Apache-2.0), which gives the shop PC a public HTTPS
// address without router or firewall changes. Set CLOUDFLARED_VERSION to pin a release.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.env.CLOUDFLARED_VERSION;
const url = version
  ? `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`
  : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const dir = fileURLToPath(new URL('../resources/', import.meta.url));
mkdirSync(dir, { recursive: true });

const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < 5_000_000 || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('Downloaded file is not a Windows executable');
writeFileSync(join(dir, 'cloudflared.exe'), buf);
console.log(`cloudflared ${version ?? 'latest'} -> resources/cloudflared.exe (${(buf.length / 1048576).toFixed(1)} MB)`);
