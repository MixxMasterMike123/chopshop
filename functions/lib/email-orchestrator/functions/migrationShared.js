"use strict";
// migrationShared — helpers shared by the catalog importers (migrateFromShopify,
// migrateFromWoo). Extracted so the MONEY-PATH invariants (slug/sku derivation,
// variant-row keys, image reupload, SSRF guard) live in ONE place and can't drift
// between the two migrators. Moved VERBATIM from migrateFromShopify.ts — do NOT
// "improve" the slug/uniquing/derivation logic (cart/repricing keys depend on it).
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeProgress = exports.makeReuploadImage = exports.isBlockedHost = exports.deriveVariantsFromGroups = exports.uniqueSku = exports.skuFromName = exports.slugify = void 0;
const crypto_1 = require("crypto");
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
    // IPv6 loopback/ULA; bare IPv4 in private/link-local/loopback ranges.
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'))
        return true;
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
    }
    return false;
};
exports.isBlockedHost = isBlockedHost;
// Reupload one source image into our Storage; returns a tokenized download URL
// (identical format to the web SDK's getDownloadURL, so the storefront reads it
// the same way). Raw bytes — no server-side canvas/compression; the source is
// already an optimised ~2000px JPEG, fine for a demo product image.
// Factory: takes the Storage bucket and returns the same closure the migrators use.
const makeReuploadImage = (bucket) => async (srcUrl, destPath) => {
    try {
        // Image src comes from the fetched JSON — re-check the host (SSRF).
        let imgHost = '';
        try {
            imgHost = new URL(srcUrl).host;
        }
        catch {
            return null;
        }
        if ((0, exports.isBlockedHost)(imgHost))
            return null;
        const r = await fetch(srcUrl);
        if (!r.ok)
            return null;
        const buf = Buffer.from(await r.arrayBuffer());
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