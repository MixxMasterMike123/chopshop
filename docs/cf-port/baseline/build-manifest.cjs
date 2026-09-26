// Builds <outdir>/manifest.json from capture.jsonl (see capture-storefront.sh).
// usage: node build-manifest.cjs <capture.jsonl> <outdir> <base-url> [bundle-fallback]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [jsonl, outDir, base, bundleFallback] = process.argv.slice(2);
const rows = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(JSON.parse);
// Pre-existing noise on every page of the Firebase deploy: Cookiebot's unauthorised-domain
// warning and two 404s (one is Cookiebot's configuration.js).
const KNOWN = [/Cookiebot Manager to authorize the domain/, /Failed to load resource: the server responded with a status of 404/];

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(outDir, f))).digest('hex');
const dims = f => { const b = fs.readFileSync(path.join(outDir, f)); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; };

const pages = [...new Set(rows.map(r => r.page))];
const manifest = pages.map(page => {
  const rs = Object.fromEntries(rows.filter(r => r.page === page).map(r => [r.name, r]));
  const d = rs.desktop;
  const files = {}, sha256 = {}, dimensions = {};
  for (const n of ['mobile', 'tablet', 'desktop']) {
    const f = `${page}-${n}.png`;
    files[n] = f; sha256[n] = sha(f); dimensions[n] = dims(f);
  }
  const all = Object.values(rs);
  const errs = [...new Set(all.flatMap(r => r.consoleErrors))];
  const o = {
    page,
    url: base + d.path,
    finalUrl: d.meta.finalUrl,
    title: d.meta.title,
    h1: d.meta.h1,
    consoleErrors: d.consoleErrors,
    consoleErrorsAllKnownNoise: errs.every(e => KNOWN.some(k => k.test(e))),
    failedRequests: [...new Set(all.flatMap(r => r.failedRequests))],
    files, sha256, dimensions,
    capturedAt: d.capturedAt,
    bundle: all.map(r => r.meta.bundle).find(Boolean) || bundleFallback || 'unknown',
  };
  if (d.meta.h1All.length > 1) o.h1All = d.meta.h1All;
  const titles = Object.fromEntries(Object.entries(rs).map(([n, r]) => [n, r.meta.title]));
  if (new Set(Object.values(titles)).size > 1) o.titleByViewport = titles;
  const finals = Object.fromEntries(Object.entries(rs).map(([n, r]) => [n, r.meta.finalUrl]));
  if (new Set(Object.values(finals)).size > 1) o.finalUrlByViewport = finals;
  const overflow = Object.entries(rs).filter(([, r]) => r.meta.docWidth > r.meta.innerWidth)
    .map(([n, r]) => `${n}: document ${r.meta.docWidth}px wide in a ${r.meta.innerWidth}px viewport (horizontal overflow; capture is clipped to the viewport width)`);
  if (overflow.length) o.layoutWarnings = overflow;
  return o;
});

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json: ${manifest.length} pages`);
