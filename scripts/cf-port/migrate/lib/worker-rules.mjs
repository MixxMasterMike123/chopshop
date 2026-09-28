/**
 * scripts/cf-port/migrate/lib/worker-rules.mjs — the Worker's own pure rules,
 * imported from cloudflare/src under plain Node (CP4_BRIEFS.md §S: "the
 * Worker's own pure rules imported from cloudflare/src where a rule must be
 * the same on both sides").
 *
 * The rule modules import one another without file extensions, so Node's
 * type stripping alone cannot load them (lib/copy-sources.mjs
 * `loadWorkerModule` takes only a module with no imports). Here esbuild, the
 * bundler the Worker's own toolchain installs under cloudflare/node_modules,
 * bundles the named exports into ONE module in memory (tree-shaken, nothing
 * written to disk), which is then imported from a data: URL. So the importer
 * runs the very functions the admin routes run: one copy of every rule.
 *
 * Only pure functions and constants are taken. Nothing here touches a
 * database, the network or a binding; a module that did so at load time would
 * fail here, loudly.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLOUDFLARE_DIR = path.join(REPO_ROOT, 'cloudflare');

/** module (relative to cloudflare/src) → the names taken from it. */
export const WORKER_RULE_EXPORTS = Object.freeze({
  'catalog/admin-catalog': ['parseCreateProductInput', 'productHandle', 'PRICE_MINOR_MAX'],
  'catalog/admin-product-reads': ['emptyToNull', 'MAX_ACTIVE_VARIANTS', 'MAX_PRODUCT_IMAGES', 'MAX_PRODUCT_TAGS', 'MAX_PRODUCT_VARIANTS'],
  'catalog/collections': ['isCollectionHandle', 'MAX_COLLECTION_PRODUCTS', 'parseCollectionInput', 'parseCollectionProductsInput'],
  'catalog/eligibility': ['ELIGIBLE_PRODUCTS_FROM', 'PUBLIC_ELIGIBILITY_PREDICATE'],
  'catalog/product-images': ['parseProductImagesInput'],
  'catalog/product-variants': ['parseCreateVariantInput'],
  'commerce/shipping': ['MAX_WEIGHT_GRAMS', 'normalizeShippingRates', 'SHIPPING_REGIONS', 'toShippingRatesWire'],
  'content/html-refusal': ['checkHtml'],
  'content/pages': ['parsePageInput', 'RESERVED_PAGE_SLUGS'],
  'platform/tenant-config': [
    'GALLERY_IMAGE_KEY',
    'isSourceStorageAddress',
    'parseStoreSettingsInput',
    'sanitizeStoreIdentity',
    'STORE_IDENTITY_IMAGE_KEYS',
    'storeIdentityImageRefs',
  ],
  'storage/public-objects': ['publicObjectBase', 'publicObjectUrl'],
  'storefront/addresses': ['productPath', 'slugify'],
});

function loadEsbuild() {
  const require = createRequire(path.join(CLOUDFLARE_DIR, 'package.json'));
  try {
    return require('esbuild');
  } catch {
    throw new Error('worker-rules: esbuild is not installed under cloudflare/node_modules (run npm ci in cloudflare/ first)');
  }
}

function entrySource() {
  return Object.entries(WORKER_RULE_EXPORTS)
    .map(([modulePath, names]) => `export { ${names.join(', ')} } from './src/${modulePath}';`)
    .join('\n');
}

/** The bundled JavaScript text (deterministic for one tree). Exported for the test. */
export function bundleWorkerRules() {
  const esbuild = loadEsbuild();
  const result = esbuild.buildSync({
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    platform: 'neutral',
    stdin: { contents: entrySource(), loader: 'ts', resolveDir: CLOUDFLARE_DIR },
    target: 'es2022',
    treeShaking: true,
    write: false,
  });
  return result.outputFiles[0].text;
}

let loaded = null;

/** The rules, loaded once per process. */
export function loadWorkerRules() {
  loaded ??= import(`data:text/javascript;base64,${Buffer.from(bundleWorkerRules(), 'utf8').toString('base64')}`);
  return loaded;
}
