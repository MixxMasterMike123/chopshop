"use strict";
// migrationShared — helpers shared by the catalog importers (migrateFromShopify,
// migrateFromWoo). Extracted so the MONEY-PATH invariants (slug/sku derivation,
// variant-row keys, image reupload, SSRF guard) live in ONE place and can't drift
// between the two migrators. Moved VERBATIM from migrateFromShopify.ts — do NOT
// "improve" the slug/uniquing/derivation logic (cart/repricing keys depend on it).
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeProgress = exports.makeReuploadImage = exports.safePublicFetch = exports.readBodyCapped = exports.assertPublicUrl = exports.isBlockedHost = exports.deriveVariantsFromGroups = exports.uniqueSku = exports.skuFromName = exports.slugify = void 0;
const crypto_1 = require("crypto");
const promises_1 = require("node:dns/promises");
const node_net_1 = require("node:net");
const firestore_1 = require("firebase-admin/firestore");
const database_1 = require("../../config/database");
// ── ported slug/sku helpers (verbatim from src/utils/productUrls.js) ─────────
const slugify = (str) => {
    if (!str)
        return '';
    return str
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[åä]/g, 'a')
        .replace(/ö/g, 'o')
        .replace(/&/g, '-and-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-');
};
exports.slugify = slugify;
const skuFromName = (name) => {
    const base = (0, exports.slugify)(name).replace(/_/g, '-').replace(/\-\-+/g, '-').replace(/^-|-$/g, '');
    return base || 'produkt';
};
exports.skuFromName = skuFromName;
const uniqueSku = (base, takenSkus) => {
    const root = (base || 'produkt').toLowerCase();
    if (!takenSkus.has(root))
        return base || 'produkt';
    for (let n = 2; n < 10000; n++) {
        const candidate = `${root}-${n}`;
        if (!takenSkus.has(candidate))
            return candidate;
    }
    return `${root}-${Date.now()}`;
};
exports.uniqueSku = uniqueSku;
function deriveVariantsFromGroups(groups, { productSku, productPrice }) {
    const takenRowSkus = new Set();
    const uniqueRowSku = (base) => {
        const root = base || 'variant';
        let candidate = root;
        for (let n = 2; takenRowSkus.has(candidate.toLowerCase()); n++)
            candidate = `${root}-${n}`;
        takenRowSkus.add(candidate.toLowerCase());
        return candidate;
    };
    const cleanGroups = [];
    const cleanVariants = [];
    for (const g of groups) {
        const label = g.label.trim();
        const images = g.images;
        const image = images[0] || '';
        const groupSku = uniqueRowSku((g.sku || '').toString().trim() || `${productSku}-${(0, exports.skuFromName)(label)}`);
        const explicitPrice = parseFloat(String(g.price)) > 0;
        const groupPrice = explicitPrice ? parseFloat(String(g.price)) : productPrice;
        const sizes = [...new Set(g.sizes.map((s) => s.trim().toUpperCase()).filter(Boolean))];
        cleanGroups.push({ label, sku: groupSku, price: explicitPrice ? groupPrice : null, image, images, sizes });
        if (sizes.length === 0) {
            cleanVariants.push({ sku: groupSku, label, price: groupPrice, image, images, group: label, size: null });
        }
        else {
            for (const size of sizes) {
                cleanVariants.push({
                    sku: uniqueRowSku(`${groupSku}-${(0, exports.skuFromName)(size)}`),
                    label: `${label} / ${size}`,
                    price: groupPrice, image, images, group: label, size,
                });
            }
        }
    }
    return { cleanGroups, cleanVariants };
}
exports.deriveVariantsFromGroups = deriveVariantsFromGroups;
// SSRF defense-in-depth: reject hosts that resolve to localhost / private / link-
// local ranges (incl. the cloud metadata endpoint 169.254.169.254) and internal
// TLDs. The callable is already platform/admin-gated, but this stops a typo'd or
// hostile internal target from being fetched. Applied to BOTH the catalog host
// and every image src before fetching.
const isBlockedHost = (host) => {
    const h = (host || '').toLowerCase().split(':')[0];
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local'))
        return true;
    // IPv6 LITERALS only (an address always contains ':' before the port-strip
    // above ran on a bracketless form — so detect via the raw host instead):
    // loopback/ULA/link-local. Guarded so DOMAIN NAMES starting with fc/fd
    // (fcbarcelona.com) are not misclassified.
    const raw = (host || '').toLowerCase();
    if (raw.includes(':') || /^[0-9a-f:]+$/.test(h)) {
        if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'))
            return true;
    }
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 10 || a === 127 || a === 0)
            return true;
        if (a === 169 && b === 254)
            return true; // link-local + metadata
        if (a === 172 && b >= 16 && b <= 31)
            return true;
        if (a === 192 && b === 168)
            return true;
        if (a === 100 && b >= 64 && b <= 127)
            return true; // CGNAT 100.64/10
        if (a >= 224)
            return true; // multicast + reserved
    }
    return false;
};
exports.isBlockedHost = isBlockedHost;
// P1-03 (2026-08-15 audit): literal-host checks alone are DNS-rebinding bait —
// an innocent-looking hostname can RESOLVE to a private/metadata address. This
// resolves every A/AAAA record and rejects if ANY lands in a blocked range.
// Verdicts are cached per process (a catalog import hits the same host
// hundreds of times). Residual TOCTOU window (fetch re-resolves after the
// check) is accepted — same documented trade-off as the website scraper —
// because the callables are admin-gated and rate-limited; full IP pinning
// needs a custom dispatcher and is not warranted here.
const hostVerdicts = new Map(); // hostname → resolved verdict
const VERDICT_TTL_MS = 10 * 60 * 1000; // re-resolve after 10 min (long-running instances)
async function assertPublicUrl(raw) {
    const u = new URL(raw); // throws on malformed
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('Only http/https URLs are allowed');
    }
    const host = u.hostname.toLowerCase();
    if ((0, exports.isBlockedHost)(host))
        throw new Error('URL points to a blocked host');
    if (!(0, node_net_1.isIP)(host)) {
        const cached = hostVerdicts.get(host);
        let safe = cached && Date.now() - cached.at < VERDICT_TTL_MS ? cached.safe : undefined;
        if (safe === undefined) {
            const addrs = await (0, promises_1.lookup)(host, { all: true, verbatim: true });
            safe = addrs.length > 0 && addrs.every((r) => !(0, exports.isBlockedHost)(r.address));
            hostVerdicts.set(host, { safe, at: Date.now() });
        }
        if (!safe)
            throw new Error('URL resolves to a private address');
    }
    return u;
}
exports.assertPublicUrl = assertPublicUrl;
// Read a response body with a HARD byte cap (verifier finding: content-length
// alone is bypassable with chunked encoding — a hostile host could stream
// unbounded bytes into arrayBuffer() and OOM the migration). Throws over cap.
async function readBodyCapped(res, maxBytes) {
    const reader = res.body?.getReader();
    if (!reader)
        return Buffer.from(await res.arrayBuffer()); // no stream → header cap already applied
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error('Response too large');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
exports.readBodyCapped = readBodyCapped;
// Fetch a caller-influenced URL with the resolved-host check applied to the
// initial URL AND every redirect hop (fetch's automatic redirect following
// would otherwise happily hop to an internal target). Optional content-length
// cap fails fast on absurd responses.
const MAX_REDIRECTS = 3;
async function safePublicFetch(rawUrl, init = {}, opts = {}) {
    let url = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrl(url);
        const res = await fetch(url, { ...init, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc)
                return res;
            url = new URL(loc, url).toString(); // relative redirects resolve against the hop
            continue;
        }
        const len = Number(res.headers.get('content-length') || 0);
        if (opts.maxBytes && len > opts.maxBytes)
            throw new Error('Response too large');
        return res;
    }
    throw new Error('Too many redirects');
}
exports.safePublicFetch = safePublicFetch;
// Reupload one source image into our Storage; returns a tokenized download URL
// (identical format to the web SDK's getDownloadURL, so the storefront reads it
// the same way). Raw bytes — no server-side canvas/compression; the source is
// already an optimised ~2000px JPEG, fine for a demo product image.
// Factory: takes the Storage bucket and returns the same closure the migrators use.
const makeReuploadImage = (bucket) => async (srcUrl, destPath) => {
    try {
        // Image src comes from the fetched JSON — resolved-host check + manual
        // redirects + size cap (P1-03). A blocked/oversized image just skips.
        const r = await safePublicFetch(srcUrl, {}, { maxBytes: 25 * 1024 * 1024 });
        if (!r.ok)
            return null;
        // Streamed read with a hard cap — chunked responses can't bypass it.
        const buf = await readBodyCapped(r, 25 * 1024 * 1024);
        const contentType = r.headers.get('content-type') || 'image/jpeg';
        const token = (0, crypto_1.randomUUID)();
        await bucket.file(destPath).save(buf, {
            metadata: { contentType, metadata: { firebaseStorageDownloadTokens: token } },
        });
        return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(destPath)}?alt=media&token=${token}`;
    }
    catch {
        return null;
    }
};
exports.makeReuploadImage = makeReuploadImage;
async function writeProgress(migrationId, patch) {
    if (!migrationId)
        return;
    try {
        await database_1.db.collection('migrations').doc(migrationId).set({ ...patch, updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
    }
    catch {
        /* progress is best-effort — never let a status write abort an import */
    }
}
exports.writeProgress = writeProgress;
//# sourceMappingURL=migrationShared.js.map