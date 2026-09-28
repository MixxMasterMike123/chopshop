// The Cloudflare storefront's build (CP4 brief E):
//   npx vite build --config vite.storefront.config.js
// Entry index.storefront.html → src/storefront/main.jsx. Output
// cloudflare/web/dist/, which the web Worker serves (cloudflare/web/wrangler.jsonc
// → assets.directory; `dist` is git-ignored). It must hold no Firebase code:
//   node cloudflare/web/check-storefront-build.mjs
// The admin, platform and print surfaces keep vite.config.js and dist/.
//
// Dev: `npx vite --config vite.storefront.config.js` serves the storefront at
// /<shop>/…; set STOREFRONT_API_ORIGIN (e.g. the staging web Worker's origin)
// to send /_api/… there.

import { copyFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const OUT_DIR = 'cloudflare/web/dist';
const HTML_ENTRY = 'index.storefront.html';

// The files of public/ the storefront's HTML and defaults name. Nothing else of
// public/ is shipped: the rest is admin, POD tooling or earlier brand material.
const PUBLIC_FILES = [
  'favicon.ico',
  'favicon-192.png',
  'favicon-512.png',
  'apple-touch-icon.png',
  'manifest.json',
  'images/logo.svg',
];

function storefrontOutput() {
  return {
    name: 'storefront-output',
    apply: 'build',
    // The web Worker reads the application's HTML at /index.html.
    async writeBundle(options) {
      const out = options.dir;
      await rename(join(out, HTML_ENTRY), join(out, 'index.html'));
      for (const file of PUBLIC_FILES) {
        await mkdir(dirname(join(out, file)), { recursive: true });
        await copyFile(join('public', file), join(out, file));
      }
    },
  };
}

function storefrontDevServer() {
  return {
    name: 'storefront-dev-html',
    apply: 'serve',
    configureServer(server) {
      // Every navigation gets the storefront's HTML, as the Worker serves it.
      server.middlewares.use((req, _res, next) => {
        const accept = req.headers.accept || '';
        if (req.method === 'GET' && accept.includes('text/html') && !req.url.startsWith('/_api/')) {
          req.url = `/${HTML_ENTRY}`;
        }
        next();
      });
    },
  };
}

const apiOrigin = process.env.STOREFRONT_API_ORIGIN;

export default defineConfig({
  plugins: [react(), tailwindcss(), storefrontOutput(), storefrontDevServer()],
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
  },
  publicDir: false,
  server: apiOrigin
    ? { proxy: { '/_api': { target: apiOrigin, changeOrigin: true } } }
    : {},
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: false, drop_debugger: true },
    },
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: resolve(HTML_ENTRY),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
