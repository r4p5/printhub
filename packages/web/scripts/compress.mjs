// Pre-compresses build output so the shop server never spends CPU compressing per request.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const EXT = /\.(js|mjs|css|html|svg|json|webmanifest)$/;
let saved = 0;

async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (EXT.test(e.name) && (await stat(p)).size > 1024) {
      const buf = await readFile(p);
      const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
      await writeFile(p + '.br', br);
      await writeFile(p + '.gz', gzipSync(buf, { level: 9 }));
      saved += buf.length - br.length;
    }
  }
}
await walk(dist);
console.log(`compressed: ${(saved / 1024).toFixed(0)} KB saved with brotli`);
