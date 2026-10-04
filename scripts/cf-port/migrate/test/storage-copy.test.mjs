import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, PENDING_FILE, PRODUCTION_ACTING_AS_REASON, runStorageCopy } from '../storage-copy.mjs';
import { COPY_MANIFEST_FILE, objectKeyOf, readCopyManifest, sourceKeyOf } from '../lib/copy-manifest.mjs';
import { RefusedError, REPO_ROOT } from '../lib/api-session.mjs';
import { startFakeSource, startFakeStagingApi, writeTestBundle } from './fake-staging-api.mjs';
import { cliInProductionMode } from './cli-production.mjs';

const BUCKET_PATH = '/v0/b/test-bucket.firebasestorage.app/o';

function png(seed) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${seed}-`.repeat(20))]);
}
function jpeg(seed) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-${seed}-`.repeat(20))]);
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function scratch() {
  return mkdtempSync(path.join(tmpdir(), 'storage-copy-'));
}

/**
 * Two shops. shop-a: a product with its main image repeated in imageUrl and a
 * variant, a gallery image, one 404, one HTML page (not an image), one SVG
 * named as a product image (refused by the reserve), two addresses with the
 * same bytes (one object), a collection cover, an SVG logo and a root-path
 * favicon (not of the source's storage), a page with an image inside its
 * HTML. shop-b: one product image.
 */
async function world({ sourceOverrides = {}, apiOptions = {}, identityOfShopA = null, extraProducts = [] } = {}) {
  const files = {
    [`${BUCKET_PATH}/a-main.png`]: { body: png('main'), type: 'image/png' },
    [`${BUCKET_PATH}/a-gallery.jpg`]: { body: jpeg('gallery'), type: 'image/jpeg' },
    [`${BUCKET_PATH}/a-page.html`]: { body: '<html>not an image</html>', type: 'text/html' },
    [`${BUCKET_PATH}/a-vector.svg`]: { body: SVG, type: 'image/svg+xml' },
    [`${BUCKET_PATH}/a-twin-1.png`]: { body: png('twin'), type: 'image/png' },
    [`${BUCKET_PATH}/a-twin-2.png`]: { body: png('twin'), type: 'image/png' },
    [`${BUCKET_PATH}/a-cover.png`]: { body: png('cover'), type: 'image/png' },
    [`${BUCKET_PATH}/a-logo.svg`]: { body: SVG, type: 'image/svg+xml' },
    [`${BUCKET_PATH}/a-inline.png`]: { body: png('inline'), type: 'image/png' },
    [`${BUCKET_PATH}/b-main.png`]: { body: png('b'), type: 'image/png' },
    ...sourceOverrides,
  };
  const source = await startFakeSource(files);
  const at = (name, query = '?alt=media&token=t') => `${source.origin}${BUCKET_PATH}/${name}${query}`;
  const api = await startFakeStagingApi({ tenants: { 'shop-a': {}, 'shop-b': {} }, ...apiOptions });
  const dir = scratch();
  const bundle = path.join(dir, 'bundle');
  writeTestBundle(bundle, {
    collections: [{ data: { imageUrl: at('a-cover.png'), shopId: 'shop-a' }, id: 'c1' }],
    pages: [
      {
        data: { content: { 'sv-SE': `<p>Hej</p><img src="${at('a-inline.png', '?alt=media&amp;token=t')}">` }, shopId: 'shop-a' },
        id: 'p1',
      },
    ],
    products: [
      {
        data: {
          b2cImageGallery: [at('a-gallery.jpg'), at('a-missing.png')],
          b2cImageUrl: at('a-main.png'),
          imageUrl: at('a-main.png'),
          shopId: 'shop-a',
          variants: [{ image: at('a-main.png'), images: [at('a-page.html'), at('a-vector.svg')] }],
          variantGroups: [{ images: [at('a-twin-1.png'), at('a-twin-2.png')] }],
        },
        id: 'p-a',
      },
      { data: { b2cImageUrl: at('b-main.png'), shopId: 'shop-b' }, id: 'p-b' },
      ...extraProducts.map((make) => make(at)),
    ],
    shops: [
      { data: { storeIdentity: identityOfShopA ? identityOfShopA(at) : { faviconUrl: '/images/favicon.ico', logoUrl: at('a-logo.svg') } }, id: 'shop-a' },
      { data: { storeIdentity: {} }, id: 'shop-b' },
    ],
  });
  const lines = [];
  const sleeps = [];
  const deps = {
    apiOrigin: api.origin,
    credentials: { email: api.state.platformUser.email, password: api.state.platformUser.password },
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const args = { bundle, dryRun: false, env: 'staging', limit: null, out: path.join(dir, 'out'), shop: null };
  return {
    api,
    args,
    at,
    close: async () => {
      await api.close();
      await source.close();
      rmSync(dir, { force: true, recursive: true });
    },
    deps,
    dir,
    lines,
    sleeps,
    source,
  };
}

function entryFor(manifest, shopId, address) {
  return manifest.entries.find((entry) => entry.shopId === shopId && entry.sourceKey === sourceKeyOf(address));
}

test('parseArgs: required options, --limit shape, unknown arguments', () => {
  assert.throws(() => parseArgs(['--bundle', 'b', '--out', 'o']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--out', 'o']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--bundle', 'b']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--bundle', 'b', '--out', 'o', '--limit', '0']), RefusedError);
  assert.throws(() => parseArgs(['--env', 'staging', '--bundle', 'b', '--out', 'o', '--force']), RefusedError);
  assert.deepEqual(parseArgs(['--env', 'staging', '--bundle', 'b', '--out', 'o', '--shop', 's', '--limit', '3', '--dry-run']), {
    bundle: 'b',
    dryRun: true,
    env: 'staging',
    limit: 3,
    out: 'o',
    shop: 's',
  });
});

test('refuses an output directory inside the repository', async () => {
  const w = await world();
  try {
    await assert.rejects(runStorageCopy({ ...w.args, out: path.join(REPO_ROOT, 'tmp-copy-out') }, w.deps), RefusedError);
    assert.equal(w.api.state.log.length, 0);
  } finally {
    await w.close();
  }
});

test('--dry-run makes no request and writes nothing', async () => {
  const w = await world();
  try {
    const result = await runStorageCopy({ ...w.args, dryRun: true }, w.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(w.api.state.log.length, 0);
    assert.equal(w.source.hits.size, 0);
    assert.equal(existsSync(w.args.out), false);
    assert.deepEqual(result.counts['shop-a'].product_image, { files: 7, references: 9 });
    assert.deepEqual(result.counts['shop-a'].branding, { files: 1, references: 1 });
    assert.ok(w.lines.some((line) => line.includes('shop-a/branding 1')), 'the root-path favicon is counted as not of the source');
  } finally {
    await w.close();
  }
});

test('copies through reserve and upload under acting-as; refusals, missing and one object per identical file', async () => {
  const w = await world();
  try {
    const result = await runStorageCopy(w.args, w.deps);
    assert.equal(result.exitCode, 0);
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.equal(manifest.env, 'staging');
    assert.equal(manifest.apiOrigin, w.api.origin);
    assert.equal(manifest.entries.length, 11);

    const main = entryFor(manifest, 'shop-a', w.at('a-main.png'));
    assert.equal(main.status, 'copied');
    assert.equal(main.use, 'product_image');
    assert.equal(main.contentType, 'image/png');
    assert.equal(main.sha256, sha(png('main')));
    const stored = w.api.state.objects.get(main.objectId);
    assert.equal(stored.status, 'active');
    assert.equal(stored.kind, 'product_media');
    assert.equal(stored.objectKey, objectKeyOf(main));

    assert.equal(entryFor(manifest, 'shop-a', w.at('a-missing.png')).status, 'missing');
    assert.equal(entryFor(manifest, 'shop-a', w.at('a-missing.png')).reason, 'http_404');
    const html = entryFor(manifest, 'shop-a', w.at('a-page.html'));
    assert.deepEqual([html.status, html.reason, html.objectId], ['refused', 'not_an_image', null]);
    const vector = entryFor(manifest, 'shop-a', w.at('a-vector.svg'));
    assert.deepEqual([vector.status, vector.reason, vector.contentType], ['refused', 'http_400', 'image/svg+xml']);

    const twin1 = entryFor(manifest, 'shop-a', w.at('a-twin-1.png'));
    const twin2 = entryFor(manifest, 'shop-a', w.at('a-twin-2.png'));
    assert.equal(twin1.status, 'copied');
    assert.equal(twin2.status, 'copied');
    assert.equal(twin1.objectId, twin2.objectId, 'the same bytes in one shop are one object');

    const cover = entryFor(manifest, 'shop-a', w.at('a-cover.png'));
    assert.equal(cover.use, 'collection_cover');
    assert.equal(w.api.state.objects.get(cover.objectId).kind, 'product_media');
    const logo = entryFor(manifest, 'shop-a', w.at('a-logo.svg'));
    assert.deepEqual([logo.status, logo.use, logo.contentType], ['copied', 'branding', 'image/svg+xml']);
    assert.equal(w.api.state.objects.get(logo.objectId).kind, 'shop_branding');
    assert.equal(w.api.state.objects.get(logo.objectId).objectKey, objectKeyOf(logo));
    const inline = entryFor(manifest, 'shop-a', w.at('a-inline.png', '?alt=media&amp;token=t'));
    assert.deepEqual([inline.status, inline.use], ['copied', 'page_image']);
    assert.equal(entryFor(manifest, 'shop-b', w.at('b-main.png')).status, 'copied');

    // Every file of each shop was uploaded once, under that shop.
    for (const object of w.api.state.objects.values()) {
      if (object.status === 'active') assert.equal(object.uploads, 1);
    }
    const reserves = w.api.state.log.filter((entry) => entry.path === '/v1/admin/objects');
    assert.ok(reserves.every((entry) => entry.shop !== null && entry.origin === w.api.origin && entry.hasCookie));
    const grants = w.api.state.log.filter((entry) => entry.path.endsWith('/acting-as') && entry.method === 'POST');
    assert.ok(grants.every((entry) => entry.shop === null), 'acting-as is a platform request: no X-Shop-Id');
    assert.ok(w.api.state.audit.filter((a) => a.action === 'acting_as.granted').every((a) => /design review/.test(a.reason)));
    assert.equal(existsSync(path.join(w.args.out, PENDING_FILE)), false, 'no reservation is left open');

    // Nothing of an address in the manifest or the output.
    const text = readFileSync(path.join(w.args.out, COPY_MANIFEST_FILE), 'utf8');
    assert.ok(!text.includes('127.0.0.1:' + new URL(w.source.origin).port) && !text.includes('a-main'));
    assert.ok(!w.lines.join('\n').includes(new URL(w.source.origin).host));
    assert.ok(!w.lines.join('\n').includes(w.api.state.platformUser.password));
  } finally {
    await w.close();
  }
});

test('a file that is a product image and the shop\'s logo is copied twice: one object of each kind', async () => {
  const w = await world({ identityOfShopA: (at) => ({ logoUrl: at('a-main.png') }) });
  try {
    const result = await runStorageCopy(w.args, w.deps);
    assert.equal(result.exitCode, 0);
    const manifestPath = path.join(w.args.out, COPY_MANIFEST_FILE);
    const both = readCopyManifest(manifestPath).entries.filter((entry) => entry.shopId === 'shop-a' && entry.sourceKey === sourceKeyOf(w.at('a-main.png')));
    assert.deepEqual(both.map((entry) => [entry.use, entry.status]), [['product_image', 'copied'], ['branding', 'copied']]);
    assert.notEqual(both[0].objectId, both[1].objectId);
    assert.deepEqual(both.map((entry) => w.api.state.objects.get(entry.objectId).kind), ['product_media', 'shop_branding']);
    assert.deepEqual(both.map((entry) => w.api.state.objects.get(entry.objectId).objectKey), both.map(objectKeyOf));

    // A second run finds both copied and reserves nothing.
    const objects = w.api.state.objects.size;
    assert.equal((await runStorageCopy(w.args, w.deps)).exitCode, 0);
    assert.equal(w.api.state.objects.size, objects);
    assert.deepEqual(readCopyManifest(manifestPath).entries.filter((entry) => entry.sourceKey === both[0].sourceKey).map((entry) => entry.objectId), both.map((entry) => entry.objectId));
  } finally {
    await w.close();
  }
});

test('a second run skips what is copied and tries the rest again', async () => {
  const w = await world();
  try {
    await runStorageCopy(w.args, w.deps);
    const reservesBefore = w.api.state.log.filter((entry) => entry.path === '/v1/admin/objects').length;
    const hitsBefore = w.source.hits.get(`${BUCKET_PATH}/a-main.png`);
    const again = await runStorageCopy(w.args, w.deps);
    assert.equal(again.exitCode, 0);
    assert.equal(w.source.hits.get(`${BUCKET_PATH}/a-main.png`), hitsBefore, 'a copied file is not fetched again');
    const reservesAfter = w.api.state.log.filter((entry) => entry.path === '/v1/admin/objects').length;
    assert.equal(reservesAfter - reservesBefore, 1, 'only the refused SVG product image is reserved again');
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.equal(manifest.entries.length, 11);
  } finally {
    await w.close();
  }
});

test('a manifest from another bundle or API is refused', async () => {
  const w = await world();
  try {
    await runStorageCopy({ ...w.args, limit: 1 }, w.deps);
    const manifestFile = path.join(w.args.out, COPY_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, bundleManifestSha256: 'b'.repeat(64) }));
    await assert.rejects(runStorageCopy(w.args, w.deps), /another bundle/);
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, apiOrigin: 'https://other.example.test' }));
    await assert.rejects(runStorageCopy(w.args, w.deps), /another environment/);
  } finally {
    await w.close();
  }
});

test('--shop and --limit bound the run', async () => {
  const w = await world();
  try {
    await runStorageCopy({ ...w.args, limit: 2, shop: 'shop-a' }, w.deps);
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.equal(manifest.entries.length, 2);
    assert.ok(manifest.entries.every((entry) => entry.shopId === 'shop-a'));
  } finally {
    await w.close();
  }
});

test('transient faults: 429 waits for Retry-After, a 5xx is tried again, three source failures are failed', async () => {
  const flaky = (hit) => (hit <= 2 ? { status: 503 } : { body: png('main'), type: 'image/png' });
  const w = await world({
    apiOptions: {
      faults: [
        { method: 'POST', path: /^\/v1\/admin\/objects$/, retryAfter: 7, status: 429, times: 1 },
        { method: 'POST', path: /^\/v1\/admin\/objects$/, status: 500, times: 1 },
      ],
    },
    sourceOverrides: {
      [`${BUCKET_PATH}/a-main.png`]: flaky,
      [`${BUCKET_PATH}/b-main.png`]: { status: 500 },
    },
  });
  try {
    const result = await runStorageCopy(w.args, w.deps);
    assert.equal(result.exitCode, 1, 'a failed entry makes the run exit 1');
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.equal(entryFor(manifest, 'shop-a', w.at('a-main.png')).status, 'copied');
    const b = entryFor(manifest, 'shop-b', w.at('b-main.png'));
    assert.deepEqual([b.status, b.reason], ['failed', 'http_500']);
    assert.equal(w.source.hits.get(`${BUCKET_PATH}/b-main.png`), 3);
    assert.ok(w.sleeps.includes(7_000), 'the 429 waited Retry-After seconds');
  } finally {
    await w.close();
  }
});

test('a lost upload answer is settled by reading the object, not by a second upload', async () => {
  const w = await world({
    apiOptions: { faults: [{ afterEffect: true, method: 'PUT', path: /\/content$/, status: 502, times: 3 }] },
  });
  try {
    const result = await runStorageCopy({ ...w.args, limit: 1, shop: 'shop-b' }, w.deps);
    assert.equal(result.exitCode, 0);
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    const entry = entryFor(manifest, 'shop-b', w.at('b-main.png'));
    assert.equal(entry.status, 'copied');
    assert.equal(w.api.state.objects.get(entry.objectId).uploads, 1);
    assert.equal(w.api.state.objects.size, 1, 'one reservation');
  } finally {
    await w.close();
  }
});

test('a reservation of a stopped run is found again: no second object for the same file', async () => {
  const w = await world();
  try {
    // First run: reserve + upload happen, then the manifest write is "lost".
    await runStorageCopy({ ...w.args, limit: 1, shop: 'shop-b' }, w.deps);
    const manifestFile = path.join(w.args.out, COPY_MANIFEST_FILE);
    const manifest = readCopyManifest(manifestFile);
    const entry = manifest.entries[0];
    writeFileSync(
      path.join(w.args.out, PENDING_FILE),
      JSON.stringify({
        entries: {
          [`shop-b\n${entry.sourceKey}`]: {
            contentType: entry.contentType,
            objectId: entry.objectId,
            sha256: entry.sha256,
            sizeBytes: entry.sizeBytes,
          },
        },
      }),
    );
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, entries: [] }));
    const again = await runStorageCopy({ ...w.args, shop: 'shop-b' }, w.deps);
    assert.equal(again.exitCode, 0);
    assert.equal(w.api.state.objects.size, 1, 'no second reservation');
    assert.equal(readCopyManifest(manifestFile).entries[0].objectId, entry.objectId);
    assert.ok(w.lines.some((line) => line.includes('found again from an earlier run: 1')));
  } finally {
    await w.close();
  }
});

test('an acting-as grant that ends mid-run is minted again', async () => {
  const w = await world({ apiOptions: { revokeGrantsAfterAdminRequests: 3 } });
  try {
    const result = await runStorageCopy({ ...w.args, shop: 'shop-a' }, w.deps);
    assert.equal(result.exitCode, 0);
    const grants = w.api.state.log.filter((entry) => entry.path === '/v1/platform/tenants/shop-a/acting-as' && entry.method === 'POST');
    assert.equal(grants.length, 2);
  } finally {
    await w.close();
  }
});

test('a shop the API does not know fails its files with the acting-as status', async () => {
  const w = await world({ apiOptions: { tenants: { 'shop-a': {} } } });
  try {
    const result = await runStorageCopy({ ...w.args, shop: 'shop-b' }, w.deps);
    assert.equal(result.exitCode, 1);
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.deepEqual([manifest.entries[0].status, manifest.entries[0].reason], ['failed', 'acting_as_http_404']);
  } finally {
    await w.close();
  }
});

test('a file over the cap is refused without a reservation', async () => {
  const big = Buffer.concat([png('big'), Buffer.alloc(15 * 1024 * 1024)]);
  const w = await world({ sourceOverrides: { [`${BUCKET_PATH}/b-main.png`]: { body: big, type: 'image/png' } } });
  try {
    await runStorageCopy({ ...w.args, shop: 'shop-b' }, w.deps);
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.deepEqual([manifest.entries[0].status, manifest.entries[0].reason], ['refused', 'too_large']);
    assert.equal(w.api.state.objects.size, 0);
  } finally {
    await w.close();
  }
});

test('the Worker refusing the bytes is recorded with its reason', async () => {
  // Stated as PNG by the sniff, but the fake API proves the upload against the
  // declared hash: a source that changes its bytes between fetch and upload
  // cannot happen here, so the refusal is forced with an SVG that checkSvg refuses.
  const bad = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const w = await world({ sourceOverrides: { [`${BUCKET_PATH}/a-logo.svg`]: { body: bad, type: 'image/svg+xml' } } });
  try {
    await runStorageCopy({ ...w.args, shop: 'shop-a' }, w.deps);
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    const logo = entryFor(manifest, 'shop-a', w.at('a-logo.svg'));
    assert.equal(logo.status, 'refused');
    assert.match(logo.reason, /^svg_/);
  } finally {
    await w.close();
  }
});

// ── production (CP7-T1) ─────────────────────────────────────────────────────

const PRODUCTION_API = { environment: 'production', migration: '0052_import_run_kinds.sql' };

/** The world of the staging tests, its API the fake of a production API, the run in production mode. */
async function productionWorld(options = {}) {
  const w = await world({ ...options, apiOptions: { ...PRODUCTION_API, ...(options.apiOptions ?? {}) } });
  w.args = { ...w.args, confirm: 'production', env: 'production' };
  return w;
}

test('parseArgs: --confirm takes a value; without it the staging shape is unchanged', () => {
  assert.equal(parseArgs(['--env', 'production', '--confirm', 'production', '--bundle', 'b', '--out', 'o']).confirm, 'production');
  assert.equal('confirm' in parseArgs(['--env', 'staging', '--bundle', 'b', '--out', 'o']), false);
  assert.throws(() => parseArgs(['--env', 'production', '--confirm', '--bundle', 'b', '--out', 'o']), /--confirm needs a value/);
});

test('production: refused before any request without --confirm production; --confirm on staging is refused too', async () => {
  const w = await productionWorld();
  try {
    for (const confirm of [undefined, 'yes']) {
      await assert.rejects(runStorageCopy({ ...w.args, confirm }, w.deps), (error) => error instanceof RefusedError && /needs --confirm production/.test(error.message));
    }
    await assert.rejects(runStorageCopy({ ...w.args, confirm: 'production', env: 'staging' }, w.deps), /belongs to --env production only/);
    assert.equal(w.api.state.log.length, 0);
    assert.equal(w.source.hits.size, 0);
  } finally {
    await w.close();
  }
});

test('production: /health must say production and /ready be on 0052 or later', async () => {
  const staging = await productionWorld({ apiOptions: { environment: 'staging' } });
  const old = await productionWorld({ apiOptions: { migration: '0051_print_job_status.sql' } });
  try {
    await assert.rejects(runStorageCopy(staging.args, staging.deps), /\/health does not say production/);
    await assert.rejects(runStorageCopy(old.args, old.deps), /\/ready is not on migration 0052 or later/);
    for (const w of [staging, old]) {
      assert.equal(w.source.hits.size, 0);
      assert.equal(w.api.state.log.filter((entry) => entry.path === '/v1/admin/objects').length, 0);
    }
  } finally {
    await staging.close();
    await old.close();
  }
});

test('production: a shop that is not yet a tenant refuses the run before any file is fetched', async () => {
  const w = await productionWorld({ apiOptions: { tenants: { 'shop-a': {} } } });
  try {
    await assert.rejects(
      runStorageCopy(w.args, w.deps),
      (error) => error instanceof RefusedError && error.message === "the platform import is not applied: shop-b is not a tenant on the API (apply import.mjs's plan first; the copy acts as each shop)",
    );
    assert.equal(w.source.hits.size, 0);
    assert.equal(w.api.state.log.filter((entry) => entry.path === '/v1/admin/objects' || entry.path.endsWith('/acting-as')).length, 0);
    // --shop narrows the check to the shops of the run.
    const result = await runStorageCopy({ ...w.args, shop: 'shop-a' }, w.deps);
    assert.equal(result.exitCode, 0);
  } finally {
    await w.close();
  }
});

test('production: copies under the cutover reason, records production in the manifest, and never continues a staging manifest', async () => {
  const w = await productionWorld();
  try {
    const result = await runStorageCopy(w.args, w.deps);
    assert.equal(result.exitCode, 0, w.lines.join('\n'));
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.equal(manifest.env, 'production');
    assert.equal(manifest.apiOrigin, w.api.origin);
    assert.equal(entryFor(manifest, 'shop-a', w.at('a-main.png')).status, 'copied');
    const grants = w.api.state.audit.filter((a) => a.action === 'acting_as.granted');
    assert.ok(grants.length > 0 && grants.every((a) => a.reason === PRODUCTION_ACTING_AS_REASON));
    assert.ok(w.lines.includes('every shop of the run is a tenant on the API'));
    assert.ok(w.lines.includes('archived shops (D21, not imported), files not copied: none'));

    // The same --out under staging: refused, and the other way round.
    await assert.rejects(runStorageCopy({ ...w.args, confirm: undefined, env: 'staging' }, w.deps), /written for another environment or API/);
    const s = await world();
    try {
      await runStorageCopy({ ...s.args, limit: 1 }, s.deps);
      await assert.rejects(runStorageCopy({ ...s.args, confirm: 'production', env: 'production' }, s.deps), /written for another environment or API/);
    } finally {
      await s.close();
    }
  } finally {
    await w.close();
  }
});

test('production: the files of an archived shop (D21) are not copied; staging still copies them', async () => {
  const archived = (at) => ({ data: { b2cImageUrl: at('b-main.png', '?alt=media&token=r'), shopId: 'robowatz' }, id: 'p-r' });
  const w = await productionWorld({ apiOptions: { tenants: { robowatz: {}, 'shop-a': {}, 'shop-b': {} } }, extraProducts: [archived] });
  try {
    const result = await runStorageCopy(w.args, w.deps);
    assert.equal(result.exitCode, 0);
    const manifest = readCopyManifest(path.join(w.args.out, COPY_MANIFEST_FILE));
    assert.equal(manifest.entries.some((entry) => entry.shopId === 'robowatz'), false);
    assert.ok(w.lines.includes('archived shops (D21, not imported), files not copied: robowatz 1'));
    assert.equal(w.api.state.log.some((entry) => entry.path === '/v1/platform/tenants/robowatz'), false);
  } finally {
    await w.close();
  }
  const s = await world({ apiOptions: { tenants: { robowatz: {}, 'shop-a': {}, 'shop-b': {} } }, extraProducts: [archived] });
  try {
    await runStorageCopy({ ...s.args, shop: 'robowatz' }, s.deps);
    assert.equal(readCopyManifest(path.join(s.args.out, COPY_MANIFEST_FILE)).entries[0].shopId, 'robowatz');
  } finally {
    await s.close();
  }
});

test('production: the sign-in waits out a 429 (HANDOVER 2026-09-28)', async () => {
  const w = await productionWorld({
    apiOptions: { faults: [{ method: 'POST', path: /^\/api\/auth\/sign-in\/email$/, retryAfter: 30, status: 429, times: 2 }] },
  });
  try {
    const result = await runStorageCopy({ ...w.args, shop: 'shop-b' }, w.deps);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(w.sleeps.slice(0, 2), [30_000, 30_000]);
    assert.ok(w.lines.some((line) => line.includes('waits on 429: 2')));
  } finally {
    await w.close();
  }
});

test('the CLI in production mode refuses before any request, and never takes staging\'s credentials', cliInProductionMode(path.join(REPO_ROOT, 'scripts/cf-port/migrate/storage-copy.mjs'), 'STORAGE COPY'));
