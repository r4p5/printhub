import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Two builds from one source:
 *  - default (`vite build`): customer + admin pages, served by the shop PC (dist/)
 *  - pages (`vite build --mode pages`): customer page only, hosted on GitHub Pages (dist-pages/),
 *    which finds each shop's PC through the directory Worker.
 */
export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  const input: Record<string, string> = { index: resolve(import.meta.dirname, 'index.html') };
  if (!pages) input.admin = resolve(import.meta.dirname, 'admin.html');
  return {
    plugins: [react(), tailwindcss(), ...(pages ? [spaFallback()] : [])],
    build: {
      target: ['es2020', 'chrome87', 'safari14'],
      outDir: pages ? 'dist-pages' : 'dist',
      rollupOptions: { input },
      // pdf.js is split out and only fetched when a PDF is actually added.
      chunkSizeWarningLimit: 1500,
    },
    server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  };
});

/** GitHub Pages serves 404.html for unknown paths, so /<mobile> loads the app. */
function spaFallback(): Plugin {
  return {
    name: 'spa-fallback',
    closeBundle() {
      const out = resolve(import.meta.dirname, 'dist-pages');
      copyFileSync(resolve(out, 'index.html'), resolve(out, '404.html'));
      writeFileSync(resolve(out, '.nojekyll'), '');
    },
  };
}
