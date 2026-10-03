// The Cloudflare admin's build (CP5 brief FA): the shop admin AND the platform
// console, one build, two trees (D102).
//   npx vite build --config vite.admin.config.js
// Entry index.admin.html → src/admin-app/main.jsx. Output
// cloudflare/admin/dist/, which the admin Worker serves (`dist` is
// git-ignored). It must hold no Firebase code:
//   node cloudflare/admin/check-admin-build.mjs
// The older build (vite.config.js, src/App.jsx) stays as it is: it is the
// rollback artifact.
//
// Dev: `npx vite --config vite.admin.config.js` serves the admin with the dev
// API (src/admin-app/dev/: invented shops and users, sign in as
// admin@example.com / dev-password-1, or platform@example.com /
// dev-password-2). Set ADMIN_API_ORIGIN (e.g. a staging admin Worker's origin)
// to send /_api/… there instead.

import { copyFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const OUT_DIR = 'cloudflare/admin/dist';
const HTML_ENTRY = 'index.admin.html';
const ROOT = dirname(fileURLToPath(import.meta.url));

// ── THE ALIAS LIST (CP5 brief FA; the pattern of vite.storefront.config.js) ─
// The pages and the components they share import the modules on the left.
// This build hands them the module on the right instead; the older build
// (vite.config.js) keeps the left one. So a shared page or component is not
// edited for the swap, and no Firebase code is reachable from the admin's
// entry (`node cloudflare/admin/check-admin-build.mjs`).
//
// Matched on the RESOLVED file, not on the text of the import: the pages
// reach one module as '../../contexts/X', '../contexts/X' or './X'. A
// replacement that wraps its original imports the original itself (the
// module on the right is never redirected from its own imports).
//
// Add a row: [the module imported, the module this build uses, why].
const ADMIN_ALIASES = [
  // The contexts → the admin's providers: the same hooks with the same values,
  // fed by the API.
  ['src/contexts/AuthContext.jsx', 'src/admin-app/providers/Session.jsx',
    'useAuth() from GET /v1/me and Better Auth (sign-in, sign-out, reset), not Firebase Auth'],
  ['src/contexts/ShopContext.jsx', 'src/admin-app/providers/ActiveShop.jsx',
    'useShopId(): the active shop the user may use per /v1/me (membership or acting-as), not the path or impersonation'],
  ['src/contexts/ShopFeaturesContext.jsx', 'src/admin-app/providers/ShopFeatures.jsx',
    'features from GET /v1/admin/shop; a key not named, or not ported (D81), reads off'],
  ['src/contexts/StoreSettingsContext.jsx', 'src/admin-app/providers/StoreSettings.jsx',
    'the store identity from GET /v1/admin/settings + the shop of GET /v1/admin/shop'],
  ['src/contexts/TranslationContext.jsx', 'src/storefront/providers/Translation.jsx',
    'translations from a static file per language (D16), not Firestore'],
  ['src/contexts/OrderContext.jsx', 'src/admin-app/providers/Orders.jsx',
    'the shell of useOrder() with its members; unit FD fills them from the order routes'],
  ['src/contexts/SimpleAuthContext.jsx', 'src/admin-app/replacements/SimpleAuthContext.jsx',
    'ForgotPasswordPage reads resetPassword here: the admin session\'s reset request; no customer accounts'],
  // Shared modules.
  ['src/utils/credentialTranslations.js', 'src/admin-app/replacements/credentialTranslations.js',
    'the sign-in pages\' texts from the static locale files, not Firestore'],
  ['src/config/activeShop.js', 'src/admin-app/replacements/activeShop.js',
    'the picker and the deep-link intake choose the tab\'s shop (sessionStorage); /v1/me decides whether it is usable'],
  ['src/config/shopConfig.js', 'src/admin-app/replacements/shopConfig.js',
    'loads from the admin settings and shop routes; the save refuses until FE/FG give it its semantics'],
  ['src/config/urls.js', 'src/admin-app/replacements/urls.js',
    'the admin\'s own origin and the storefront\'s, read by name; no Cloud Functions'],
  ['src/config/platform.js', 'src/storefront/replacements/platform.js',
    'the two platform values read by name (the original reads import.meta.env whole, which inlines every VITE_ variable)'],
];

function adminAliases(list) {
  const byFile = new Map(list.map(([from, to]) => [resolve(ROOT, from), resolve(ROOT, to)]));
  return {
    name: 'admin-aliases',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return resolved;
      const [file, query] = resolved.id.split('?');
      const target = byFile.get(file);
      if (!target || importer.split('?')[0] === target) return resolved;
      return query ? `${target}?${query}` : target;
    },
  };
}

// The files of public/ the admin's HTML and defaults name. Nothing else of
// public/ is shipped (the rest is storefront, POD tooling or earlier brand
// material). A later unit that needs one adds its row (the admin Worker serves
// top-level files, /images/… and /assets/…).
const PUBLIC_FILES = [
  'favicon.ico',
  'favicon-192.png',
  'favicon-512.png',
  'apple-touch-icon.png',
  'images/logo.svg',
];

function adminOutput() {
  return {
    name: 'admin-output',
    apply: 'build',
    // The admin Worker serves the application's HTML as /index.html.
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

function adminDevServer() {
  return {
    name: 'admin-dev-html',
    apply: 'serve',
    configureServer(server) {
      // Every navigation gets the admin's HTML, as the Worker serves it.
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

// The dev API (src/admin-app/dev/): answers /_api/… from invented fixtures
// while no real API is proxied. The dev server only (`apply: 'serve'`),
// imported when the server starts: never part of a build.
function adminDevApi() {
  return {
    name: 'admin-dev-api',
    apply: 'serve',
    async configureServer(server) {
      if (apiOrigin) return;
      const { createDevApi } = await import('./src/admin-app/dev/dev-api.mjs');
      server.middlewares.use(createDevApi());
    },
  };
}

const apiOrigin = process.env.ADMIN_API_ORIGIN;

// Through the proxy the API sees the admin Worker's host; the browser's
// Origin (the dev server's) is rewritten to it, or every state change would
// be refused as cross-origin.
const proxy = apiOrigin
  ? {
      '/_api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(server) {
          server.on('proxyReq', (proxyReq) => {
            if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', new URL(apiOrigin).origin);
          });
        },
      },
    }
  : undefined;

export default defineConfig({
  plugins: [
    adminAliases(ADMIN_ALIASES),
    react(),
    tailwindcss(),
    adminOutput(),
    adminDevServer(),
    adminDevApi(),
  ],
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
  },
  publicDir: false,
  server: proxy ? { proxy } : {},
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
