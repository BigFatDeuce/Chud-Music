import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    // index = app bridge; yt-guest = the YouTube player page's pipe (see main/yt-player.ts)
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts'), 'yt-guest': resolve(__dirname, 'src/preload/yt-guest.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [
      react(),
      // Dev server only: React Fast Refresh needs an inline preamble; production keeps the strict CSP.
      { name: 'dev-csp', apply: 'serve', transformIndexHtml: (html: string) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") },
    ],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
