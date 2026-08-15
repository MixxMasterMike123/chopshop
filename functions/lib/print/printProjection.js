"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toPrintJob = exports.toQueueRow = exports.toPrintNotificationLines = exports.orderHasPodLine = exports.findUnresolvedPodLines = exports.artworkDeliverable = exports.resolveMapping = exports.resolveSlots = exports.loadShopMappings = exports.signedUrlFor = exports.mappingSlotLabel = exports.slotLabel = exports.slotOf = exports.DEFAULT_SLOT = void 0;
// printProjection.ts — builds the FIELD-MINIMISED production view of a POD order
// for the print shop. This is the data-minimisation boundary: the printer (an
// external sub-processor) gets ship-to + production fields ONLY — never customer
// email/phone, payment refs, totals, marketing flags, or internal notes.
//
// The order↔artwork join: order.items[].sku → podMappings (scoped to the order's
// shop) → podArtwork → a short-lived SIGNED download URL for the original.
const storage_1 = require("firebase-admin/storage");
const database_1 = require("../config/database");
const SIGNED_URL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SLOT_LABELS = {
    front: 'Bröst',
    back: 'Rygg',
    pocket: 'Ficka',
    left_sleeve: 'Vänster ärm',
    right_sleeve: 'Höger ärm',
    other: 'Övrig',
};
exports.DEFAULT_SLOT = 'front';
function slotOf(mapping) {
    const s = mapping?.placementSlot;
    return s === 'back' || s === 'pocket' || s === 'left_sleeve' || s === 'right_sleeve' || s === 'other' ? s : exports.DEFAULT_SLOT;
}
exports.slotOf = slotOf;
function slotLabel(slot) {
    return SLOT_LABELS[slot] || SLOT_LABELS[exports.DEFAULT_SLOT];
}
exports.slotLabel = slotLabel;
// Display label for a mapping's slot. The studio writes a garment-correct
// label on the mapping ("Framsida" on a keps — the shared vocabulary above is
// apparel-worded and says "Bröst"; Kent bug 2026-08-11). Older rows lack the
// field → shared label. Client-authored text that renders in the OPERATOR
// portal/email, so sanitize: strip control chars, cap length.
function mappingSlotLabel(mapping, slot) {
    const raw = typeof mapping?.slotLabel === 'string' ? mapping.slotLabel : '';
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);
    return clean || slotLabel(slot);
}
exports.mappingSlotLabel = mappingSlotLabel;
// Sanitize a client-influenced image URL before it may render in the PRINT
// OPERATOR's portal: https only (kills javascript:/data: stored XSS) and
// platform storage hosts only (kills off-platform tracking beacons). Product
// imagery on this platform lives in Firebase Storage; anything else → null and
// the portal simply shows no mockup thumbnail.
const ALLOWED_IMAGE_HOSTS = new Set(['firebasestorage.googleapis.com', 'storage.googleapis.com']);
function safeImageUrl(u) {
    if (typeof u !== 'string' || !u)
        return null;
    try {
        const p = new URL(u);
        return p.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.has(p.hostname) ? u : null;
    }
    catch {
        return null;
    }
}
// P1-18/P2-17 (2026-08-15 audit): a doc-stored fallback URL is admin-writable
// data — honoring it blindly let a hand-crafted doc hand the printer an
// arbitrary external link. A fallback now counts only when it is a https URL
// on OUR storage hosts whose object path matches the exact storagePath we
// meant to sign. Anything else → null (fail closed).
const SAFE_FALLBACK_HOSTS = new Set(['firebasestorage.googleapis.com', 'storage.googleapis.com']);
function safeFallbackUrl(url, storagePath) {
    if (typeof url !== 'string' || !url)
        return null;
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !SAFE_FALLBACK_HOSTS.has(u.hostname))
            return null;
        // BUCKET PINNING (verifier finding 2026-08-15): both hosts serve EVERY
        // project's buckets, so a path match alone lets a doc point at an
        // attacker-owned bucket that mirrors our folder layout. Require OUR
        // default bucket in the URL's bucket segment:
        //   firebasestorage: /v0/b/<bucket>/o/<ENCODED path> · GCS: /<bucket>/<path>
        const ourBucket = (0, storage_1.getStorage)().bucket().name;
        const segs = u.pathname.split('/').filter(Boolean);
        const urlBucket = u.hostname === 'firebasestorage.googleapis.com'
            ? (segs[0] === 'v0' && segs[1] === 'b' ? segs[2] : '')
            : segs[0];
        if (urlBucket !== ourBucket)
            return null;
        return decodeURIComponent(u.pathname).includes(storagePath) ? url : null;
    }
    catch {
        return null;
    }
}
// Mint a short-lived signed read URL for a Storage object. Falls back to the
// stored download URL if signing isn't available (the Functions service account
// needs roles/iam.serviceAccountTokenCreator to sign — a project-config item);
// the fallback is CONSTRAINED to our storage hosts + the same object path.
// `allowedPrefix` (when given) rejects a path outside the expected partition
// before any signing happens.
async function signedUrlFor(storagePath, fallbackUrl, allowedPrefix = '') {
    if (!storagePath)
        return null; // fail closed — never an arbitrary stored URL
    if (allowedPrefix && !storagePath.startsWith(allowedPrefix))
        return null;
    try {
        const [url] = await (0, storage_1.getStorage)()
            .bucket()
            .file(storagePath)
            .getSignedUrl({ action: 'read', expires: Date.now() + SIGNED_URL_TTL_MS });
        return url;
    }
    catch (e) {
        console.warn(`print: signed URL failed for ${storagePath} (need serviceAccountTokenCreator?), constrained fallback:`, e?.message);
        return safeFallbackUrl(fallbackUrl, storagePath);
    }
}
exports.signedUrlFor = signedUrlFor;
// Load a shop's POD mappings, grouped by mapping SKU (one read per shop, cached by
// caller). MULTI-PLACEMENT: a SKU can now carry SEVERAL mappings (one per slot:
// front/back/sleeve), so each map value is an ARRAY of mappings for that SKU — the
// old one-row-per-sku assumption is gone. Slot resolution happens in resolveSlots.
async function loadShopMappings(shopId) {
    const snap = await database_1.db.collection('podMappings').where('shopId', '==', shopId).get();
    const bySku = new Map();
    snap.docs.forEach((d) => {
        const m = d.data();
        if (!m.sku)
            return;
        const arr = bySku.get(m.sku) || [];
        arr.push({ id: d.id, ...m });
        bySku.set(m.sku, arr);
    });
    return bySku;
}
exports.loadShopMappings = loadShopMappings;
// Resolve the best mapping PER SLOT for an order-line SKU. For each slot, the same
// matching rule as before applies INDEPENDENTLY: an exact-SKU mapping for that slot
// wins; otherwise the LONGEST '-'-boundary-prefix mapping for that slot wins (a
// per-colorway `north-01-svart` beats the parent `north-01` for `north-01-svart-l`,
// but only within the SAME slot — a colorway front-mapping does NOT override the
// parent's back-mapping). Variant SKUs derive as `${parent}-${color}-${size}`.
// Docs missing placementSlot resolve as 'front' (backward compat).
//
// Returns a Map<slot, mapping> holding one winning mapping per slot that resolves
// (empty when the SKU has no mapping at all → a non-POD line).
function resolveSlots(sku, mappingsBySku) {
    const out = new Map();
    if (!sku)
        return out;
    // Per slot: track the current winner + the length of the key that matched it.
    // Exact match is modelled as an infinitely-long key so it always beats a prefix.
    const bestLen = {};
    for (const [key, mappings] of mappingsBySku) {
        let matchLen = -1;
        if (key === sku)
            matchLen = Number.MAX_SAFE_INTEGER; // exact wins over any prefix
        else if (sku.startsWith(key + '-'))
            matchLen = key.length;
        else
            continue;
        for (const mapping of mappings) {
            const slot = slotOf(mapping);
            const prev = bestLen[slot] ?? -1;
            // Ties (two docs same slot + same key length, e.g. duplicate exact rows) keep
            // the first seen — deterministic enough; the admin upsert prevents this.
            if (matchLen > prev) {
                out.set(slot, mapping);
                bestLen[slot] = matchLen;
            }
        }
    }
    return out;
}
exports.resolveSlots = resolveSlots;
// Back-compat helper: resolve the single best mapping for a SKU (any slot). Used by
// the any-slot POD checks (orderHasPodLine, setPrintJobStatus). Returns null if the
// SKU has no mapping in any slot; otherwise a representative winning mapping.
function resolveMapping(sku, mappingsBySku) {
    const slots = resolveSlots(sku, mappingsBySku);
    if (slots.size === 0)
        return null;
    // Prefer the front slot when present, else any resolved slot.
    return slots.get(exports.DEFAULT_SLOT) || slots.values().next().value;
}
exports.resolveMapping = resolveMapping;
// P1-13: is this artwork doc DELIVERABLE for the given shop? Mirrors toPrintJob's
// delivery decision exactly: the gate-verified print PNG must live inside THIS
// shop's server-owned print/ folder; a legacy doc (no status field) may fall
// back to its original. Kept as ONE predicate so the production view and the
// status-transition gate can never drift apart.
function artworkDeliverable(art, shopId) {
    const shopPrefix = `pod-artwork/${String(shopId || '')}/`;
    const isPrintFile = typeof art?.printStoragePath === 'string' && art.printStoragePath.startsWith(`${shopPrefix}print/`);
    if (isPrintFile)
        return { deliverable: true };
    if (art?.status !== undefined) {
        return { deliverable: false, reason: 'Tryckfil saknas — be butiken validera om originalet' };
    }
    // Legacy pre-gate doc (no status field): the raw original may substitute,
    // but ONLY when it lives inside THIS shop's partition (P1-18 fail-closed —
    // a hand-crafted path must not route foreign/cross-tenant bytes).
    const legacyOk = typeof art?.originalStoragePath === 'string' && art.originalStoragePath.startsWith(shopPrefix);
    return legacyOk
        ? { deliverable: true }
        : { deliverable: false, reason: 'Originalfilen ligger utanför butikens lagring' };
}
exports.artworkDeliverable = artworkDeliverable;
// P1-13: list every POD production line (item × resolved slot) whose artwork
// does NOT resolve to a deliverable artifact. An order may only be marked
// printed/shipped when this list is EMPTY — one resolvable line must not carry
// an order whose other line would silently ship without its print.
async function findUnresolvedPodLines(order, mappingsBySku, dbRef) {
    const items = Array.isArray(order.items) ? order.items : [];
    const artCache = new Map();
    const unresolved = [];
    for (const it of items) {
        if (!it || !it.sku)
            continue;
        const slots = resolveSlots(it.sku, mappingsBySku);
        for (const [slot, mapping] of slots) {
            const label = `${it.sku} (${slotLabel(slot)})`;
            if (!mapping.artworkId) {
                unresolved.push(`${label}: ingen artworkId i kopplingen`);
                continue;
            }
            if (!artCache.has(mapping.artworkId)) {
                const s = await dbRef.collection('podArtwork').doc(mapping.artworkId).get();
                artCache.set(mapping.artworkId, s.exists ? s.data() : null);
            }
            const art = artCache.get(mapping.artworkId);
            if (!art) {
                unresolved.push(`${label}: originalet är borttaget`);
                continue;
            }
            const d = artworkDeliverable(art, order.shopId);
            if (!d.deliverable)
                unresolved.push(`${label}: ${d.reason}`);
        }
    }
    return unresolved;
}
exports.findUnresolvedPodLines = findUnresolvedPodLines;
// Is this order a POD order for the given shop? (any line's sku resolves any slot)
function orderHasPodLine(order, mappingsBySku) {
    const items = Array.isArray(order.items) ? order.items : [];
    return items.some((it) => it && it.sku && resolveSlots(it.sku, mappingsBySku).size > 0);
}
exports.orderHasPodLine = orderHasPodLine;
// Build the PRODUCTION-SCOPED line list for the printer notification email —
// one entry per (order item × resolved slot), with the slot-aware placement label
// ("Bröst — Centrerat på bröstet"). No artwork lookup (the email links to the
// portal for files), no customer PII. Mirrors toPrintJob's slot iteration.
function toPrintNotificationLines(order, mappingsBySku) {
    const items = Array.isArray(order.items) ? order.items : [];
    const SLOT_ORDER = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve', 'other'];
    const out = [];
    for (const it of items) {
        if (!it || !it.sku)
            continue;
        const slots = resolveSlots(it.sku, mappingsBySku);
        if (slots.size === 0)
            continue;
        for (const slot of SLOT_ORDER.filter((s) => slots.has(s))) {
            const mapping = slots.get(slot);
            const detail = String(mapping.placement || '').trim();
            out.push({
                productName: typeof it.name === 'string' ? it.name : (it.name?.['sv-SE'] || it.sku),
                sku: it.sku,
                quantity: it.quantity || 0,
                placement: detail ? `${mappingSlotLabel(mapping, slot)} — ${detail}` : mappingSlotLabel(mapping, slot),
            });
        }
    }
    return out;
}
exports.toPrintNotificationLines = toPrintNotificationLines;
// Minimal LIST row — no address, no contact, no money.
function toQueueRow(orderId, order, shopName, mappingsBySku) {
    const items = Array.isArray(order.items) ? order.items : [];
    // MULTI-PLACEMENT: one production line per (item × resolved slot) — a shirt with a
    // front + back print counts as 2 lines. Sum resolved slots across items.
    let podLineCount = 0;
    for (const it of items) {
        if (it && it.sku)
            podLineCount += resolveSlots(it.sku, mappingsBySku).size;
    }
    const ship = order.shippingInfo || {};
    const isPickup = order.deliveryMethod === 'pickup';
    return {
        orderId,
        orderNumber: order.orderNumber || orderId,
        orderDate: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : (order.createdAt || null),
        shopId: order.shopId || null,
        shopName: shopName || order.shopId || '',
        status: order.status || '',
        podLineCount,
        deliveryMethod: isPickup ? 'pickup' : 'home',
        // Pickup rows show the pickup location, not a customer city.
        shipToCity: isPickup ? (order.pickupLocation?.name || '') : (ship.city || ''),
        shipToCountry: isPickup ? '' : (ship.country || ''),
    };
}
exports.toQueueRow = toQueueRow;
// Full per-order PRODUCTION view: ship-to + per POD line (resolved artwork +
// signed URL). Lines whose mapping/artwork can't resolve come back with
// artwork:{unresolved:true,reason} (visible problem, never a silently-missing line).
async function toPrintJob(orderId, order, shopName, mappingsBySku) {
    const items = Array.isArray(order.items) ? order.items : [];
    const ship = order.shippingInfo || {};
    // MULTI-PLACEMENT: emit ONE production line per (order item × resolved slot). A
    // shirt with a front + back artwork yields two lines, each with its own file and
    // a slot-aware placement label ("Bröst — Centrerat på bröstet": slot label +
    // free-text detail). Slots resolve independently (see resolveSlots).
    const lines = [];
    // Per-order cache for the product-image fallback (one read per productId max).
    const productImageCache = new Map();
    for (const it of items) {
        if (!it || !it.sku)
            continue;
        const slots = resolveSlots(it.sku, mappingsBySku);
        if (slots.size === 0)
            continue; // non-POD line — skip
        // MOCKUP for the printer's first-print eyeballing (docs/POD_PRINT_SPEC.md §6:
        // "bara motivet + mockupbilden"). The order item's image IS the bought
        // colourway's mockup/product photo (public product imagery — no PII).
        //
        // TRUST BOUNDARY: it.image is CLIENT-WRITTEN at checkout (cart → Stripe
        // metadata → order doc, verbatim) and this renders as <img src> + <a href>
        // in the PRINT OPERATOR's portal — a different, more privileged user. So it
        // is sanitized server-side (https + platform storage hosts only; kills
        // javascript:/data: XSS and off-platform beacons). Falls back to the
        // product doc's first image (server-derived, shop-checked).
        let mockupUrl = safeImageUrl(it.image);
        const productId = String(it.productId || it.id || '');
        if (!mockupUrl && productId) {
            if (!productImageCache.has(productId)) {
                try {
                    const p = await database_1.db.collection('products').doc(productId).get();
                    // Same-shop only — a foreign productId must not pull another shop's
                    // imagery into this shop's print job.
                    const d = p.exists && p.data()?.shopId === order.shopId ? p.data() : null;
                    productImageCache.set(productId, safeImageUrl((Array.isArray(d?.images) && d.images[0]) || d?.b2cImageUrl || d?.imageUrl || null));
                }
                catch {
                    productImageCache.set(productId, null);
                }
            }
            mockupUrl = productImageCache.get(productId) || null;
        }
        // Stable ordering of the per-item slot lines (front→back→sleeves→other).
        const SLOT_ORDER = ['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve', 'other'];
        const orderedSlots = SLOT_ORDER.filter((s) => slots.has(s));
        for (const slot of orderedSlots) {
            const mapping = slots.get(slot);
            const detail = String(mapping.placement || '').trim();
            // "Bröst — Centrerat på bröstet" (slot label + optional free-text detail).
            const placement = detail ? `${mappingSlotLabel(mapping, slot)} — ${detail}` : mappingSlotLabel(mapping, slot);
            const base = {
                productName: typeof it.name === 'string' ? it.name : (it.name?.['sv-SE'] || it.sku),
                sku: it.sku,
                variantLabel: it.label || null,
                quantity: it.quantity || 0,
                placementSlot: slot,
                slotLabel: mappingSlotLabel(mapping, slot),
                placement,
                profileId: mapping.profileId || null,
                // The bought colourway's product mockup (front view) — the printer's
                // visual reference. NOTE: for back/sleeve lines this still shows the
                // front mockup; the placement text is the per-slot instruction.
                mockupUrl,
            };
            if (!mapping.artworkId) {
                lines.push({ ...base, purpose: mapping.profileId || null, artwork: { unresolved: true, reason: 'Ingen artworkId i kopplingen' } });
                continue;
            }
            const artSnap = await database_1.db.collection('podArtwork').doc(mapping.artworkId).get();
            if (!artSnap.exists) {
                lines.push({ ...base, purpose: mapping.profileId || null, artwork: { unresolved: true, reason: 'Originalet är borttaget' } });
                continue;
            }
            const art = artSnap.data();
            // DELIVERY = the gate-verified print PNG (docs/POD_PRINT_SPEC.md: always
            // transparent PNG, RGB, ≥300 DPI). The print/ storage path is SERVER-OWNED
            // (storage.rules denies client create/update/delete), and we only honour a
            // path inside THIS shop's print/ folder — so a hand-crafted doc can never
            // route ungated or cross-tenant bytes to the printer. The decision lives
            // in artworkDeliverable() — SHARED with the setPrintJobStatus gate (P1-13).
            const shopPrintPrefix = `pod-artwork/${String(order.shopId || '')}/print/`;
            const isPrintFile = typeof art.printStoragePath === 'string' && art.printStoragePath.startsWith(shopPrintPrefix);
            const delivery = artworkDeliverable(art, order.shopId);
            if (!delivery.deliverable) {
                lines.push({ ...base, purpose: art.purpose || mapping.profileId || null, artwork: { unresolved: true, reason: delivery.reason } });
                continue;
            }
            // allowedPrefix pins the signed/fallback URL inside THIS shop's
            // partition (P1-18) — mirrors artworkDeliverable's decision.
            const downloadUrl = isPrintFile
                ? await signedUrlFor(art.printStoragePath, art.printUrl || null, shopPrintPrefix)
                : await signedUrlFor(art.originalStoragePath, art.originalUrl || null, `pod-artwork/${String(order.shopId || '')}/`);
            lines.push({
                ...base,
                purpose: art.purpose || mapping.profileId || null,
                artwork: {
                    tier: art.validation?.tier || null,
                    fileName: art.fileName || '',
                    ext: isPrintFile ? 'png' : (art.ext || ''),
                    isPrintFile,
                    downloadUrl,
                    previewUrl: art.previewUrl || null,
                },
            });
        }
    }
    const deliveryMethod = order.deliveryMethod === 'pickup' ? 'pickup' : 'home';
    return {
        order: {
            orderNumber: order.orderNumber || orderId,
            orderDate: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : (order.createdAt || null),
            status: order.status || '',
            orderRef: orderId,
        },
        shopName: shopName || order.shopId || '',
        deliveryMethod,
        // Pickup orders: the printer delivers to the SHOP's pickup location and the
        // shop hands over to the customer — so no customer ship-to at all (data
        // minimisation: the printer doesn't even need the customer's name; the order
        // number identifies the parcel).
        pickup: deliveryMethod === 'pickup'
            ? {
                name: order.pickupLocation?.name || '',
                address: order.pickupLocation?.address || '',
                date: order.pickupLocation?.date || '',
            }
            : null,
        // ship-to ONLY — name + address, needed to fulfil. NO email/phone.
        shipTo: deliveryMethod === 'pickup'
            ? null
            : {
                name: order.customerInfo?.name || '',
                line1: ship.address || '',
                line2: ship.apartment || '',
                postalCode: ship.postalCode || '',
                city: ship.city || '',
                country: ship.country || '',
            },
        lines,
    };
}
exports.toPrintJob = toPrintJob;
//# sourceMappingURL=printProjection.js.map