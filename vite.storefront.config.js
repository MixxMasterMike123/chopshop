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
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const OUT_DIR = 'cloudflare/web/dist';
const HTML_ENTRY = 'index.storefront.html';
const ROOT = dirname(fileURLToPath(import.meta.url));

// ── THE ALIAS LIST (CP4 brief F) ────────────────────────────────────────────
// The pages and the components they share import the modules on the left.
// This build hands them the module on the right instead; the older build
// (vite.config.js) keeps the left one. So a shared component is not edited
// for the swap, and no Firebase code is reachable from the storefront's
// entry (`node cloudflare/web/check-storefront-build.mjs`).
//
// Matched on the RESOLVED file, not on the text of the import: the pages
// reach one module as '../../contexts/X', '../contexts/X' or './X'. A
// replacement that wraps its original imports the original itself (the
// module on the right is never redirected from its own imports).
//
// Add a row: [the module imported, the module this build uses, why].
const STOREFRONT_ALIASES = [
  // The five contexts → the storefront's providers (brief E): the same hooks
  // with the same values, fed by the API.
  ['src/contexts/CartContext.jsx', 'src/storefront/providers/Cart.jsx',
    'the cart with a campaign code while the shop has the add-on (CP8-DC), never an affiliate one (D81); lines carry the API ids'],
  ['src/contexts/TranslationContext.jsx', 'src/storefront/providers/Translation.jsx',
    'translations from a static file per language (D16), not Firestore'],
  ['src/contexts/StoreSettingsContext.jsx', 'src/storefront/providers/StoreSettings.jsx',
    'the store identity from GET /v1/storefront'],
  ['src/contexts/ShopContext.jsx', 'src/storefront/providers/ShopRoot.jsx',
    'the shop from the root (D77), no impersonation'],
  ['src/contexts/ShopFeaturesContext.jsx', 'src/storefront/providers/ShopFeatures.jsx',
    'features from the storefront response; a feature not ported reads off (D81)'],
  // Contexts that pull Firebase in and that shared components read.
  ['src/contexts/LanguageCurrencyContext.jsx', 'src/storefront/replacements/LanguageCurrencyContext.jsx',
    'SmartPrice: sv-SE and kronor only (the provider reads the signed-in customer and the translation detection)'],
  ['src/contexts/SimpleAuthContext.jsx', 'src/storefront/replacements/SimpleAuthContext.jsx',
    'no customer accounts (D81): nobody is signed in (the provider is Firebase Auth)'],
  // Shared modules.
  ['src/utils/productUrls.js', 'src/storefront/replacements/productUrls.js',
    'addresses under the storefront root on the shared host and on a shop\'s own domain (brief F.5); the original reaches config/urls.js, which names the Firebase project'],
  ['src/utils/productPricing.js', 'src/storefront/replacements/productPricing.js',
    'a card is priced by the server\'s lowest price and "från" (a list answer carries no variant prices)'],
  ['src/utils/productImages.js', 'src/storefront/replacements/productImages.js',
    'the placeholder tile without the table of the earlier brand\'s product names drawn at load'],
  ['src/utils/productFeed.js', 'src/storefront/replacements/productFeed.js',
    'the product JSON-LD only (the feed builder reads Firestore)'],
  ['src/utils/fileUpload.js', 'src/storefront/replacements/fileUpload.js',
    'the two formatting helpers of the attachment list only (the upload uses Firebase Storage)'],
  ['src/utils/trustpilotAPI.js', 'src/storefront/replacements/trustpilotAPI.js',
    'reviews are not ported (D81): no reviews, the same on every host'],
  ['src/components/shop/ProductReviews.jsx', 'src/storefront/replacements/ProductReviews.jsx',
    'product reviews are not ported (D81); the component read Firestore'],
  ['src/config/platform.js', 'src/storefront/replacements/platform.js',
    'the two platform values read by name (the original reads import.meta.env whole, which inlines every VITE_ variable)'],
  ['src/pages/LandingPage.jsx', 'src/storefront/NotFound.jsx',
    'the platform\'s landing page is not a storefront page (brief E, deviation 5): an address that names no shop shows the not-found page'],
];

function storefrontAliases(list) {
  const byFile = new Map(list.map(([from, to]) => [resolve(ROOT, from), resolve(ROOT, to)]));
  return {
    name: 'storefront-aliases',
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

// The dev API (brief F, src/storefront/dev/): answers /_api/<shop>/v1/… from
// invented fixtures while no real API is proxied. The dev server only
// (`apply: 'serve'`), imported when the server starts: never part of a build.
// STOREFRONT_DEV_PAGE_SIZE=<n> makes every list answer at most n per page.
function storefrontDevApi() {
  return {
    name: 'storefront-dev-api',
    apply: 'serve',
    async configureServer(server) {
      if (apiOrigin) return;
      const { createDevApi } = await import('./src/storefront/dev/dev-api.mjs');
      const pageSize = Number(process.env.STOREFRONT_DEV_PAGE_SIZE) || 100;
      server.middlewares.use(createDevApi({ pageSize }));
    },
  };
}

const apiOrigin = process.env.STOREFRONT_API_ORIGIN;

export default defineConfig({
  plugins: [
    storefrontAliases(STOREFRONT_ALIASES),
    react(),
    tailwindcss(),
    storefrontOutput(),
    storefrontDevServer(),
    storefrontDevApi(),
  ],
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
