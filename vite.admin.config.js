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
  // Page data modules (one per page that had inline Firebase calls).
  ['src/pages/admin/adminPaymentsData.js', 'src/admin-app/replacements/adminPaymentsData.js',
    'AdminPayments: the Connect routes (read on mount, focus and return from Stripe) instead of onSnapshot + callables; no balance read'],
  ['src/pages/admin/adminSettingsData.js', 'src/admin-app/replacements/adminSettingsData.js',
    'AdminSettings: the seller\'s own legal text kept in the identity and edited on the page (D79), the legal readiness from GET /v1/admin/legal/status; no CMS page written'],
  ['src/utils/legalAcceptance.js', 'src/admin-app/replacements/legalAcceptance.js',
    'the legal-pages adoption by POST /v1/admin/legal/accept-pages with the texts as shown, not a Firestore evidence doc'],
  ['src/pages/admin/adminProductsData.js', 'src/admin-app/replacements/adminProductsData.js',
    'AdminProducts: the product list, the star, the order and "delete" (= archive) by the product routes; the form opens on GET /v1/admin/products/:id'],
  ['src/components/admin/productFormData.js', 'src/admin-app/replacements/productFormData.js',
    'ProductForm: the save by the product, variant, object and image routes; Inköp and the floor from GET /v1/admin/pod/quote (no podPricing.js, no client screening list)'],
  // The shells and acting-as (unit FB).
  ['src/components/layout/adminShellScope.js', 'src/admin-app/replacements/adminShellScope.js',
    'AppLayout: the launch-scope menu (B2C Kunder and Mina skatteuppgifter leave), and who may pick or switch a shop (several memberships, acting-as)'],
  ['src/wagons/WagonRegistry.js', 'src/admin-app/replacements/wagonRegistry.js',
    'no wagon discovery (D2): POD is a static menu entry, gated by features.pod'],
  ['src/wagons/dining-wagon/components/MentionNotifications.jsx', 'src/admin-app/replacements/MentionNotifications.jsx',
    'the dining wagon is deleted (D2); features.dining is always false here'],
  ['src/hooks/useDarkMode.js', 'src/admin-app/replacements/useDarkMode.js',
    'the dark-mode choice under this build\'s own key (the older key is read once)'],
  ['src/utils/credentialLanguageStorage.js', 'src/admin-app/replacements/credentialLanguageStorage.js',
    'the sign-in pages\' language choice under this build\'s own key (the older keys are read once)'],
  ['src/config/impersonation.js', 'src/admin-app/replacements/impersonation.js',
    'the acting-as grant of the tab\'s shop (GET /v1/me actingAs), not a client-written session'],
  ['src/config/impersonationAudit.js', 'src/admin-app/replacements/impersonationAudit.js',
    'opening and ending the grant (POST/DELETE /v1/platform/tenants/:id/acting-as); the server writes the audit'],
  ['src/components/auth/AdminShopIdIntake.jsx', 'src/admin-app/replacements/AdminShopIdIntake.jsx',
    '?shopId= and the console\'s ?impersonate= make that shop the tab\'s, then leave the address'],
  ['src/components/admin/shopPickerData.js', 'src/admin-app/replacements/shopPickerData.js',
    'ShopPicker: the shops of GET /v1/me (memberships, or open grants), not the shops collection'],
  ['src/components/admin/platformTermsData.js', 'src/admin-app/replacements/platformTermsData.js',
    'PlatformTermsGate and AdminPlatformTerms: GET /v1/admin/legal/status and /terms, POST /accept-terms; the text of the current version as archived'],
  ['src/components/platform/platformLayoutData.js', 'src/admin-app/replacements/platformLayoutData.js',
    'PlatformLayout: the launch-scope menu (3D-modeller, DAC7, Leads leave), the badge from GET /v1/platform/reports newCount, the acting-as notice'],
  // Unit FJ: the platform console's add-ons, users and reports.
  ['src/pages/platform/platformAddonsData.js', 'src/admin-app/replacements/platformAddonsData.js',
    'PlatformAddons: the shops of GET /v1/platform/tenants and their features by …/features; the columns of add-ons the Worker refuses (deleted CRM add-ons, affiliate, wholesale) leave'],
  ['src/pages/platform/platformUsersData.js', 'src/admin-app/replacements/platformUsersData.js',
    'PlatformUsers: the user directory; "Ta bort" is deactivate, with reactivate and invite; no creating a platform admin over HTTP (D51)'],
  ['src/pages/platform/platformReportsData.js', 'src/admin-app/replacements/platformReportsData.js',
    'PlatformReports: the reports and the screening queue by the platform routes; the server stamps the handler; the queue has no note and no shop links'],
  // Unit FD: the seller's orders and the dashboard.
  ['src/pages/admin/adminOrdersData.js', 'src/admin-app/replacements/adminOrdersData.js',
    'AdminOrders: search by the list route\'s q (an e-mail address or an order number prefix), the exports read each order\'s detail, a re-read on window focus; no source tabs (no trade channel)'],
  ['src/pages/admin/adminOrderDetailData.js', 'src/admin-app/replacements/adminOrderDetailData.js',
    'AdminOrderDetail: no buyer account to read (D81); the refund is POST …/refunds for the server\'s refundable amount with an Idempotency-Key'],
  ['src/pages/admin/adminDashboardData.js', 'src/admin-app/replacements/adminDashboardData.js',
    'AdminDashboard: the numbers from the order list (count, totalMinor, the newest five); no customer or affiliate stats'],
  ['src/components/AdminPresence.jsx', 'src/admin-app/replacements/AdminPresence.jsx',
    'presence is dropped (PLAN §2.9): nothing is rendered'],
  ['src/utils/orderUtils.js', 'src/admin-app/replacements/orderUtils.js',
    'an order of the API always has its lines; the original also parses an article-number pattern of the source system\'s first product line, which must not ship'],
  // Unit FG: the catalogue's content pages (collections, menu, pages, the storefront's look).
  ['src/pages/admin/adminCollectionsData.js', 'src/admin-app/replacements/adminCollectionsData.js',
    'AdminCollections: the list, the star, delete and the order (a PATCH of sortOrder per moved collection) by the collection routes'],
  ['src/pages/admin/adminCollectionEditData.js', 'src/admin-app/replacements/adminCollectionEditData.js',
    'AdminCollectionEdit: the save by the collection routes (a new one created unpublished, its members set, then published), the cover as a product_media object, the picker\'s products and tags from the product routes'],
  ['src/pages/admin/adminMenuData.js', 'src/admin-app/replacements/adminMenuData.js',
    'AdminMenu: the sources from the admin product, collection and page lists; the menu saved as storeIdentity.menu through saveShopConfig'],
  ['src/pages/admin/adminPagesData.js', 'src/admin-app/replacements/adminPagesData.js',
    'AdminPages: no listener: the pages are read when the page opens and after a delete (each page in full, for its translations and SEO columns)'],
  ['src/pages/admin/adminPageEditData.js', 'src/admin-app/replacements/adminPageEditData.js',
    'AdminPageEdit: the page routes (per-language maps; the Worker\'s refusals of a slug or of unsafe HTML said in the toast); no attachments (D94), no legal-edit stamp (the legal slugs are reserved)'],
  ['src/pages/admin/PageAttachments.jsx', 'src/admin-app/replacements/PageAttachments.jsx',
    'AdminPageEdit: no attachments (D94): FileUpload, FileManager and the Firebase upload code stay out of this build'],
  ['src/pages/admin/adminStorefrontData.js', 'src/admin-app/replacements/adminStorefrontData.js',
    'AdminStorefront: logo, hero and favicon as shop_branding objects named by id in the identity; the identity saved through saveShopConfig; categories from the product list'],
  ['src/utils/shopPayout.js', 'src/admin-app/replacements/shopPayout.js',
    'the payout is the server\'s (the seller sees ONE number); a browser computation fails loudly'],
  // Unit FH: the shop's own admins.
  ['src/pages/admin/adminUsersData.js', 'src/admin-app/replacements/adminUsersData.js',
    'AdminUsers: the shop\'s own admins by GET/POST /v1/admin/members (invite, revoke); no roles, no trade margin, no user create/edit pages'],
  // Unit FI: the platform console's shop pages (platform-only facts: commission, Connect).
  ['src/pages/platform/platformShopsData.js', 'src/admin-app/replacements/platformShopsData.js',
    'PlatformShops: GET /v1/platform/tenants to its end, activate/suspend; no per-shop counts (no route: the three columns leave); an unpublished shop\'s storefront opens its preview when a grant on it is open'],
  ['src/pages/platform/platformShopDetailData.js', 'src/admin-app/replacements/platformShopDetailData.js',
    'PlatformShopDetail: GET /v1/platform/tenants/:id + …/connect; publish/unpublish, activate/suspend, Connect enable/disable; no counts card, no migrators'],
  ['src/pages/platform/shopCellsData.js', 'src/admin-app/replacements/shopCellsData.js',
    'shopCells: the commission by PATCH /v1/platform/tenants/:id (the server\'s cap decides); the legal readiness from the detail\'s settings summary; no acceptance facts (no platform read)'],
  ['src/components/platform/provisionShopData.js', 'src/admin-app/replacements/provisionShopData.js',
    'ProvisionShopModal: POST /v1/platform/tenants (placeholder hostname), the preset\'s features, unpublish; no accent (no platform route writes the identity)'],
  ['src/components/platform/addShopUserData.js', 'src/admin-app/replacements/addShopUserData.js',
    'AddShopUserModal: create the tenant admin, grant, invite (a password-set link); never a password the operator knows; no name (no route stores one)'],
  ['src/components/platform/MigrateShopifyModal.jsx', 'src/admin-app/replacements/PlatformMigrateModal.jsx',
    'the migrators are PORT-LATER: their buttons are not shown on PlatformShopDetail, the modal renders nothing'],
  ['src/components/platform/MigrateWooModal.jsx', 'src/admin-app/replacements/PlatformMigrateModal.jsx',
    'the migrators are PORT-LATER: their buttons are not shown on PlatformShopDetail, the modal renders nothing'],
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
// top-level files, /images/…, /template-thumbs/… and /assets/…).
const PUBLIC_FILES = [
  'favicon.ico',
  'favicon-192.png',
  'favicon-512.png',
  'apple-touch-icon.png',
  'images/logo.svg',
  // The appearance page's template picker (src/config/templates.js names them).
  'template-thumbs/nord.png',
  'template-thumbs/sport.png',
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
