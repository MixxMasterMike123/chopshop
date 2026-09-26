"use strict";
/**
 * screenProductOnWrite — server-side brand screening (SnapWear A11).
 *
 * A sibling of syncProductsPublicOnWrite on the same products/{id} write
 * signal. The client publish paths (Design Studio, ProductForm) run the same
 * matcher to SHOW the seller a notice, but they never write `screening`
 * themselves — firestore.rules forbids a shop admin from touching it — so this
 * trigger is the only writer and a client that skips the check changes nothing.
 *
 * Only LIVE products are screened (isActive === true && availability.b2c ===
 * true, the same predicate as the public projection): a draft harms nobody,
 * and a takedown (isActive=false) must not be re-stamped.
 *
 * What it stamps (pure decision: decideScreening in ./contentScreening):
 *   screening = { status, hits[], earlierHits?, at, source:'server' }
 *   status: 'flagged' (blocklist hit) · 'review' (a new shop's first
 *   reviewFirstProducts live products) · 'ok' · 'blocked' (hard-blocked term →
 *   also isActive=false). The platform's review queue (PlatformReports →
 *   Granskning) reads flagged/review/blocked and writes 'cleared'.
 *
 * Loop safety: the trigger's own update re-fires it. The decision is a no-op
 * when the hit set is unchanged, and it only ever writes screening/isActive,
 * so the second run converges to nothing. The source is re-read in a
 * transaction (same reasoning as syncProductsPublic: events are unordered).
 *
 * Settings: settings/contentScreening = { blocklist: [{ term, kind, note,
 * hardBlock? }], reviewFirstProducts: 2, hardBlock?: boolean }. A missing doc
 * means no terms — only the new-shop review rule applies.
 *
 * Artwork names (F4): a POD product's screened text includes the fileName/
 * label of the artwork its podMappings point at, but the mapping editor and
 * replaceArtworkFile write podMappings/podArtwork WITHOUT touching the product.
 * rescreenProductsOnMappingWrite / rescreenProductsOnArtworkWrite below close
 * that gap by running the same screenProductNow on every affected live product.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rescreenProductsOnArtworkWrite = exports.rescreenProductsOnMappingWrite = exports.screenProductOnWrite = exports.screenProductNow = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const firestore_2 = require("firebase-admin/firestore");
const database_1 = require("../config/database");
const contentScreening_1 = require("./contentScreening");
const isLive = (p) => !!p && p.isActive === true && p.availability?.b2c === true;
const DEFAULT_REVIEW_FIRST = 2;
/** Artwork file names printed on this product (POD only): podMappings → podArtwork. */
async function artworkFileNames(p) {
    if (p.isPodProduct !== true || !p.shopId || !p.sku)
        return [];
    // sku + variantGroups skus, capped at the Firestore `in` limit. Shared with
    // productUsesMappingSku, so the rescreen triggers pick exactly these products.
    const uniqueSkus = (0, contentScreening_1.productMappingSkus)(p);
    // Two equality filters (== + in) → served by index merging, no composite index.
    const maps = await database_1.db.collection('podMappings')
        .where('shopId', '==', p.shopId)
        .where('sku', 'in', uniqueSkus)
        .get();
    const ids = [...new Set(maps.docs.map((d) => String(d.data().artworkId || '')).filter(Boolean))];
    if (ids.length === 0)
        return [];
    const arts = await database_1.db.getAll(...ids.map((id) => database_1.db.collection('podArtwork').doc(id)));
    return arts
        .filter((a) => a.exists && a.data()?.shopId === p.shopId)
        .flatMap((a) => [a.data()?.fileName, a.data()?.label])
        .filter((s) => typeof s === 'string' && s.trim() !== '');
}
/** Other LIVE products in this shop, counted up to `cap` (the public mirror = live set). */
async function otherLiveCount(shopId, selfId, cap) {
    const snap = await database_1.db.collection('productsPublic').where('shopId', '==', shopId).limit(cap + 1).get();
    return snap.docs.filter((d) => d.id !== selfId).length;
}
/**
 * Screen one product now: read it and, when LIVE, stamp the decision. The
 * products trigger passes its event payload as `known` (already checked live)
 * so its reads stay exactly as they were; the rescreen triggers below omit it
 * and the product is read fresh.
 */
async function screenProductNow(productId, known) {
    const ref = database_1.db.collection('products').doc(productId);
    const current = known ?? (await ref.get()).data();
    if (!current || !isLive(current))
        return;
    const settingsSnap = await database_1.db.collection('settings').doc('contentScreening').get();
    const settings = (settingsSnap.exists ? settingsSnap.data() : {});
    const reviewFirst = Number.isFinite(settings.reviewFirstProducts)
        ? Math.max(0, Number(settings.reviewFirstProducts))
        : DEFAULT_REVIEW_FIRST;
    // Reads that can't sit in the transaction cheaply (queries). They depend
    // only on sku/variantGroups/shopId, which a racing write rarely changes;
    // the next write re-screens anyway.
    const fileNames = await artworkFileNames(current).catch((e) => {
        logger.warn(`screenProductOnWrite: artwork lookup failed for ${productId}`, e);
        return [];
    });
    const shopPublishedCount = current.screening
        ? reviewFirst // unused when prev exists — skip the query
        : await otherLiveCount(String(current.shopId || ''), productId, reviewFirst);
    await database_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists)
            return;
        const p = snap.data();
        if (!isLive(p))
            return;
        const hits = (0, contentScreening_1.findScreeningHits)((0, contentScreening_1.productScreeningTexts)(p, fileNames), settings.blocklist);
        const terms = hits.map((h) => h.term);
        const hardBlock = hits.length > 0 && (settings.hardBlock === true || hits.some((h) => h.hardBlock));
        const prev = (p.screening && typeof p.screening === 'object') ? p.screening : null;
        const decision = (0, contentScreening_1.decideScreening)({
            prev,
            terms,
            hardBlock,
            shopPublishedCount,
            reviewFirstProducts: reviewFirst,
        });
        if (!decision.screening && !decision.deactivate)
            return;
        const update = {};
        if (decision.screening) {
            update.screening = { ...decision.screening, at: firestore_2.FieldValue.serverTimestamp(), source: 'server' };
        }
        if (decision.deactivate)
            update.isActive = false;
        tx.update(ref, update);
        logger.info(`screenProductOnWrite: ${productId} (${p.shopId}) → ${decision.screening?.status ?? prev?.status}` +
            `${terms.length ? ` hits=[${terms.join(', ')}]` : ''}${decision.deactivate ? ' · HARD BLOCK → inactive' : ''}`);
    });
}
exports.screenProductNow = screenProductNow;
exports.screenProductOnWrite = (0, firestore_1.onDocumentWritten)({
    document: 'products/{productId}',
    database: 'b8s-reseller-db',
    region: 'us-central1',
    memory: '256MiB',
}, async (event) => {
    const after = event.data?.after;
    if (!after?.exists)
        return;
    const current = after.data();
    if (!isLive(current))
        return;
    await screenProductNow(event.params.productId, current);
});
// ── F4: artwork names changed without a product write ────────────────────
//
// Loop safety: the two triggers below only ever write products (through
// screenProductNow), never podMappings/podArtwork, so they cannot re-fire
// themselves; the product write re-fires screenProductOnWrite, which
// converges as described at the top.
/**
 * Re-screen this shop's LIVE POD products fed by any of `skus`
 * (productUsesMappingSku — the same membership the artwork lookup uses).
 * One failing product is logged and skipped, not fatal to the rest.
 */
async function rescreenProductsForSkus(shopId, skus, why) {
    const wanted = [...new Set(skus)];
    if (!shopId || wanted.length === 0)
        return;
    // Two equality filters → served by index merging, no composite index.
    const snap = await database_1.db.collection('products')
        .where('shopId', '==', shopId)
        .where('isPodProduct', '==', true)
        .get();
    // A query returns each doc once, so the ids are already deduped.
    const ids = snap.docs
        .filter((d) => isLive(d.data()) && wanted.some((sku) => (0, contentScreening_1.productUsesMappingSku)(d.data(), sku)))
        .map((d) => d.id);
    for (const id of ids) {
        try {
            await screenProductNow(id);
        }
        catch (e) {
            logger.warn(`${why}: rescreen failed for ${id} (${shopId})`, e);
        }
    }
}
/** podMappings write (setMapping / deleteMapping) → re-screen what the old AND new row fed. */
exports.rescreenProductsOnMappingWrite = (0, firestore_1.onDocumentWritten)({
    document: 'podMappings/{mappingId}',
    database: 'b8s-reseller-db',
    region: 'us-central1',
    memory: '256MiB',
}, async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    // The artwork lookup reads only shopId/sku/artworkId off a mapping — a
    // placement/garment/updatedAt edit cannot change any product's names.
    if (before && after && before.shopId === after.shopId && before.sku === after.sku &&
        before.artworkId === after.artworkId)
        return;
    // Create, delete and a sku change all matter: collect both sides.
    const skusByShop = new Map();
    for (const m of [before, after]) {
        if (!m || typeof m.shopId !== 'string' || typeof m.sku !== 'string')
            continue;
        skusByShop.set(m.shopId, [...(skusByShop.get(m.shopId) || []), m.sku]);
    }
    for (const [shopId, skus] of skusByShop) {
        await rescreenProductsForSkus(shopId, skus, `rescreenProductsOnMappingWrite ${event.params.mappingId}`);
    }
});
/** podArtwork fileName/label change (rename, replaceArtworkFile) → re-screen its products. */
exports.rescreenProductsOnArtworkWrite = (0, firestore_1.onDocumentWritten)({
    document: 'podArtwork/{artworkId}',
    database: 'b8s-reseller-db',
    region: 'us-central1',
    memory: '256MiB',
}, async (event) => {
    const after = event.data?.after;
    if (!after?.exists)
        return; // a delete only drops names — nothing new to flag
    const art = after.data();
    const before = event.data?.before?.data();
    // Uploads/validation rewrite other fields constantly; only the screened two matter.
    if (before?.fileName === art.fileName && before?.label === art.label)
        return;
    const shopId = typeof art.shopId === 'string' ? art.shopId : '';
    if (!shopId)
        return;
    const artworkId = event.params.artworkId;
    // Two equality filters → served by index merging, no composite index.
    const maps = await database_1.db.collection('podMappings')
        .where('shopId', '==', shopId)
        .where('artworkId', '==', artworkId)
        .get();
    const skus = maps.docs
        .map((d) => d.data().sku)
        .filter((s) => typeof s === 'string' && s !== '');
    await rescreenProductsForSkus(shopId, skus, `rescreenProductsOnArtworkWrite ${artworkId}`);
});
//# sourceMappingURL=screenProductOnWrite.js.map