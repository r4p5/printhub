import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: ['es2020', 'chrome87', 'safari14'],
    rollupOptions: {
      input: { index: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin.html') },
    },
    // pdf.js is split out and only fetched when a PDF is actually added.
    chunkSizeWarningLimit: 1500,
  },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
