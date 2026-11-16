// Bundles the Electron main process together with the server into a few files: faster
// startup (no module resolution across node_modules at launch) and a smaller install.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, minify: true, legalComments: 'none', logLevel: 'info' };
// pdf-lib ships CommonJS; ESM bundles need a real require for its internals.
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };

await Promise.all([
  // Splitting keeps pdf-lib (test page) in a lazily loaded chunk, out of startup parsing.
  build({ ...common, entryPoints: ['src/main.ts'], outdir: 'dist', splitting: true, chunkNames: 'chunk-[hash]', format: 'esm', external: ['electron'], banner }),
  build({ ...common, entryPoints: ['../server/src/pdf/pdf-worker.ts'], outfile: 'dist/pdf-worker.js', format: 'esm', banner }),
  build({ ...common, entryPoints: ['src/preload.cts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] }),
]);
