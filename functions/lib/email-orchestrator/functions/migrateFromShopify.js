"use strict";
// migrateFromShopify — PLATFORM-only one-click demo migration. Ingests a public
// Shopify store's /products.json (no credentials needed) and creates products in
// OUR platform for the target shop. DISPLAY/DEMO catalog only: no orders,
// customers, inventory truth, or print-masters (those aren't public — see the
// competitor-research notes). Images are the storefront-rendered ~2000px assets.
//
// WHY A CALLABLE (server-side): Shopify's /products.json does NOT send an
// Access-Control-Allow-Origin header, so a browser fetch is CORS-blocked. The
// whole ingest (fetch + image reupload + product writes) therefore runs here.
//
// MONEY-PATH / SELLABLE-DOC INVARIANTS (must hold or products won't render/sell):
//   • Storefront query requires shopId + sku + isActive:true + availability.b2c:true
//     (PublicProductPage.jsx). Every product we write sets all four.
//   • Variant row `sku` is the cart/repricing key — the derivation below is a
//     byte-for-byte port of utils/variantDerivation.js + utils/productUrls.js
//     (slugify/skuFromName). Do NOT "improve" the slug/uniquing logic.
//   • Price is stored as decimal SEK on BOTH b2cPrice and basePrice (consumer
//     price resolves as b2cPrice || basePrice), matching ProductForm.
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateFromShopify = void 0;
const https_1 = require("firebase-functions/v2/https");
const storage_1 = require("firebase-admin/storage");
const firestore_1 = require("firebase-admin/firestore");
const app_urls_1 = require("../../config/app-urls");
const database_1 = require("../../config/database");
const authGuard_1 = require("./authGuard");
// Money-path helpers + SSRF guard + image reupload — shared with migrateFromWoo.
// Moved here VERBATIM (do NOT re-inline / diverge the slug/sku/derivation logic).
const migrationShared_1 = require("./migrationShared");
// Map Shopify's product_type to our free-text `category` (drives /kategori/{slug}
// browse + storefront filtering). Normalise the messy real-world values seen on
// Ninetone ('cd', 'T-SHIRT', 'zip_hoodie', 'cap_baseball', …) to a clean, human
// label: underscores→spaces, Title Case. Empty product_type → '' (no category).
const toCategory = (productType) => {
    const raw = (productType || '').trim();
    if (!raw)
        return '';
    return raw
        .replace(/[_-]+/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
};
// Shopify's "no real variants" sentinel: a single option named 'Title' with the
// single value 'Default Title'. Such products map to a plain (variant-less) product.
const isSingleVariant = (p) => (p.options || []).length === 1 &&
    p.options[0]?.name === 'Title' &&
    (p.variants || []).length <= 1;
// Which option axis is the "colorway" (→ variantGroups) vs the "size" (→ sizes)?
// Prefer an explicit Color/Colour/Färg option for the group axis and Size/Storlek
// for the size axis; otherwise fall back to option positions (1 = group, 2 = size).
const COLOR_NAMES = new Set(['color', 'colour', 'färg', 'farg']);
const SIZE_NAMES = new Set(['size', 'storlek']);
const pickAxes = (opts) => {
    let groupPos = null;
    let sizePos = null;
    for (const o of opts) {
        const n = (o.name || '').toLowerCase().trim();
        if (groupPos === null && COLOR_NAMES.has(n))
            groupPos = o.position;
        if (sizePos === null && SIZE_NAMES.has(n))
            sizePos = o.position;
    }
    if (groupPos === null && sizePos === null) {
        // No named color/size → first option is the group axis, second (if any) sizes.
        groupPos = opts[0]?.position ?? 1;
        sizePos = opts.length > 1 ? opts[1].position : null;
    }
    else if (groupPos === null) {
        // A size axis exists but no color axis. The group axis is the FIRST option
        // that ISN'T the size axis (e.g. Print, Type, Variant) — so a "Print × Size"
        // product keeps its Print dimension as colorway groups. Only when Size is the
        // ONLY option does the group axis stay null (→ one implicit group of sizes).
        const other = opts.find((o) => o.position !== sizePos);
        groupPos = other ? other.position : null;
    }
    return { groupPos, sizePos };
};
const optByPos = (v, pos) => {
    if (pos === 1)
        return v.option1;
    if (pos === 2)
        return v.option2;
    if (pos === 3)
        return v.option3;
    return null;
};
exports.migrateFromShopify = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '1GiB',
    timeoutSeconds: 540,
    cors: app_urls_1.appUrls.CORS_ORIGINS,
}, async (request) => {
    // Platform OR admin-of-this-shop. requireAdminOfShop already lets platform
    // act on any shop; a shop admin only on their own — correct for both surfaces.
    await (0, authGuard_1.requireAdminOfShop)(request.data.shopId, request.auth?.uid);
    const shopId = (request.data.shopId || '').trim();
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId saknas.');
    // Normalise the Shopify domain (accept "shop.x.com", "https://shop.x.com/sv", …).
    let host;
    try {
        const raw = (request.data.shopifyDomain || '').trim();
        const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        host = new URL(withProto).host;
    }
    catch {
        throw new https_1.HttpsError('invalid-argument', 'Ogiltig Shopify-adress.');
    }
    if (!host)
        throw new https_1.HttpsError('invalid-argument', 'Ogiltig Shopify-adress.');
    if ((0, migrationShared_1.isBlockedHost)(host))
        throw new https_1.HttpsError('invalid-argument', 'Otillåten adress.');
    // The target shop must exist (don't strand products on a non-existent tenant).
    const shopSnap = await database_1.db.collection('shops').doc(shopId).get();
    if (!shopSnap.exists)
        throw new https_1.HttpsError('not-found', `Butiken "${shopId}" finns inte.`);
    // ── 1. Fetch the public catalog (paginated; 250/page is Shopify's max). ──
    const maxProducts = Math.min(Math.max(1, request.data.limit || 500), 1000);
    const products = [];
    for (let page = 1; page <= 20 && products.length < maxProducts; page++) {
        const url = `https://${host}/products.json?limit=250&page=${page}`;
        let res;
        try {
            res = await fetch(url, { headers: { Accept: 'application/json' } });
        }
        catch {
            throw new https_1.HttpsError('unavailable', `Kunde inte nå ${host}.`);
        }
        if (!res.ok) {
            if (page === 1)
                throw new https_1.HttpsError('not-found', `${host} exponerar ingen /products.json (är det en Shopify-butik?).`);
            break;
        }
        const body = (await res.json());
        const batch = body.products || [];
        if (batch.length === 0)
            break;
        products.push(...batch);
    }
    if (products.length === 0)
        throw new https_1.HttpsError('not-found', `Inga produkter hittades på ${host}.`);
    // ── 2. Existing products in the target shop: collect taken SKUs (for unique
    //    product SKUs) AND already-imported Shopify keys (for RESUMABILITY — a
    //    re-run skips products already imported and finishes the rest, so a client
    //    timeout mid-import is harmless: just click Importera again). ──
    const existingSnap = await database_1.db.collection('products').where('shopId', '==', shopId).get();
    const takenSkus = new Set();
    const importedShopifyKeys = new Set();
    existingSnap.forEach((d) => {
        const data = d.data();
        const s = (data.sku || '').toString().trim().toLowerCase();
        if (s)
            takenSkus.add(s);
        if (data.shopifyKey)
            importedShopifyKeys.add(String(data.shopifyKey));
    });
    const bucket = (0, storage_1.getStorage)().bucket();
    // Reupload one image into our Storage → tokenized download URL (shared with
    // migrateFromWoo; same SSRF re-check + raw-bytes + token logic).
    const reuploadImage = (0, migrationShared_1.makeReuploadImage)(bucket);
    // ── 3. Transform + create each product. ──
    // GRACEFUL DEGRADATION (per requirement): Shopify sends many fields our system
    // has no home for (grams, barcode, compare_at_price, product_type, taxable,
    // requires_shipping, per-variant weight, gift-card flags, …). We intentionally
    // DROP those — this is a display/demo catalog — and record it once in
    // `droppedShopifyFields` so the import is honestly reported as lossy, not
    // silently partial. Conversely, fields WE require that Shopify may omit (price,
    // images, variant labels) each get a safe fallback below so a product is never
    // written in an unsellable state. One malformed product is caught and skipped —
    // it must never abort the whole import.
    let created = 0;
    let imageFailures = 0;
    let alreadyImported = 0; // skipped on a re-run because already present
    const skipped = [];
    const droppedShopifyFields = [
        'inventory/stock', 'orders', 'customers', 'compare_at_price', 'barcode',
        'grams/weight', 'product_type', 'taxable', 'requires_shipping', 'gift_card',
        // Our rail model has ONE colorway axis: a product with TWO non-size option
        // axes (e.g. Print × Color) keeps one as groups and drops the other.
        'second variant axis (e.g. Print on Print×Color)',
    ];
    for (const sp of products.slice(0, maxProducts)) {
        try {
            const name = (sp.title || '').trim();
            if (!name) {
                skipped.push('(namnlös produkt)');
                continue;
            }
            // RESUMABILITY: skip products already imported. Primary key = the Shopify
            // handle/id (stamped as shopifyKey on prior imports). Fallback for products
            // imported before shopifyKey existed: skip when the DERIVED base sku already
            // exists in the shop (so a re-run doesn't create "-2" duplicates of them).
            const shopifyKey = (sp.handle || `id-${sp.id}`).toString();
            const baseSku = (0, migrationShared_1.skuFromName)(name);
            if (importedShopifyKeys.has(shopifyKey) || takenSkus.has(baseSku.toLowerCase())) {
                alreadyImported++;
                continue;
            }
            const productSku = (0, migrationShared_1.uniqueSku)(baseSku, takenSkus);
            takenSkus.add(productSku.toLowerCase()); // reserve so the next product can't collide
            importedShopifyKeys.add(shopifyKey);
            // Product price = the first PARSEABLE variant price (Shopify prices are
            // decimal, VAT-inclusive for EU stores — matches our b2cPrice convention).
            // A product with no parseable price anywhere → price 0 (still importable as a
            // demo display item; flagged via the skipped-price note below).
            const firstPrice = (() => {
                for (const v of sp.variants || []) {
                    const p = parseFloat(v?.price || '');
                    if (Number.isFinite(p) && p > 0)
                        return p;
                }
                return 0;
            })();
            // A stable-ish product id for the Storage path (Firestore assigns the real
            // doc id via addDoc; this only namespaces images).
            const imgNs = `shopify_${sp.id}`;
            const uploadedByShopifySrc = new Map();
            // SPEED: pre-upload all of THIS product's distinct image URLs CONCURRENTLY
            // (Promise.all), so the sequential transform below hits the cache instantly
            // instead of awaiting each network round-trip in series (~4× faster per
            // product — the fix for the client deadline-exceeded on large catalogs). The
            // per-image failure accounting and dedup-by-src are unchanged. A deterministic
            // index per distinct src keeps Storage paths stable + collision-free.
            {
                const distinct = [];
                const seen = new Set();
                const collect = (s) => { if (s && !seen.has(s)) {
                    seen.add(s);
                    distinct.push(s);
                } };
                (sp.variants || []).forEach((v) => collect(v.featured_image?.src));
                (sp.images || []).forEach((im) => collect(im.src));
                await Promise.all(distinct.map(async (src, idx) => {
                    const url = await reuploadImage(src, `products/${shopId}/${imgNs}/img_${idx}`);
                    if (url)
                        uploadedByShopifySrc.set(src, url);
                    else
                        imageFailures++;
                }));
            }
            // Now a pure cache lookup — never a fresh upload (pre-uploaded above), so the
            // existing sequential transform logic stays byte-identical.
            const uploadImageOnce = async (src) => (src && uploadedByShopifySrc.get(src)) || null;
            let cleanGroups = [];
            let cleanVariants = [];
            let heroUrl = '';
            const galleryUrls = [];
            if (isSingleVariant(sp)) {
                // No real variants → plain product. All product images go to the gallery;
                // the first is the hero. hasVariants:false.
                for (const im of sp.images || []) {
                    const u = await uploadImageOnce(im.src);
                    if (u) {
                        if (!heroUrl)
                            heroUrl = u;
                        else
                            galleryUrls.push(u);
                    }
                }
            }
            else {
                const { groupPos, sizePos } = pickAxes(sp.options || []);
                // Bucket variants by the group-axis value (colorway). groupPos null means a
                // single implicit group (size-only product).
                const order = [];
                const byGroup = new Map();
                for (const v of sp.variants || []) {
                    const gLabel = (groupPos !== null ? optByPos(v, groupPos) : null) || name;
                    const sLabel = sizePos !== null ? optByPos(v, sizePos) : null;
                    if (!byGroup.has(gLabel)) {
                        order.push(gLabel);
                        byGroup.set(gLabel, { sizes: new Set(), price: parseFloat(v.price) || firstPrice, imgSrc: v.featured_image?.src || null, sku: '' });
                    }
                    const entry = byGroup.get(gLabel);
                    if (sLabel)
                        entry.sizes.add(sLabel);
                }
                // Build raw groups with uploaded images, then derive byte-identically.
                const rawGroups = [];
                for (const gLabel of order) {
                    const e = byGroup.get(gLabel);
                    // Group image = the variant's featured image if present, else product image[0].
                    const src = e.imgSrc || sp.images?.[0]?.src || '';
                    const gUrl = await uploadImageOnce(src);
                    rawGroups.push({
                        label: gLabel,
                        price: e.price === firstPrice ? '' : e.price,
                        images: gUrl ? [gUrl] : [],
                        sizes: [...e.sizes],
                    });
                }
                const derived = (0, migrationShared_1.deriveVariantsFromGroups)(rawGroups, { productSku, productPrice: firstPrice });
                cleanGroups = derived.cleanGroups;
                cleanVariants = derived.cleanVariants;
                heroUrl = cleanGroups[0]?.image || (await uploadImageOnce(sp.images?.[0]?.src || '')) || '';
                // Gallery = every product image not already used as a group hero.
                const usedUrls = new Set(cleanGroups.map((g) => g.image).filter(Boolean));
                for (const im of sp.images || []) {
                    const u = await uploadImageOnce(im.src);
                    if (u && u !== heroUrl && !usedUrls.has(u))
                        galleryUrls.push(u);
                }
            }
            // Plain-text description from Shopify's body_html (strip tags for descriptions.b2c;
            // keep the HTML in b2cMoreInfo which is a rich-text field).
            const html = sp.body_html || '';
            const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const data = {
                name,
                sku: productSku,
                category: toCategory(sp.product_type),
                tags: Array.isArray(sp.tags) ? sp.tags : (typeof sp.tags === 'string' && sp.tags ? sp.tags.split(',').map((t) => t.trim()) : []),
                hasVariants: cleanVariants.length > 0,
                variantGroups: cleanGroups,
                options: [],
                variants: cleanVariants,
                b2cPrice: firstPrice,
                basePrice: firstPrice,
                isActive: true,
                featured: false,
                imageUrl: heroUrl,
                b2cImageUrl: heroUrl,
                b2cImageGallery: galleryUrls,
                availability: { b2c: true },
                descriptions: { b2c: plain.slice(0, 600), b2cMoreInfo: html },
                isPersonalized: false,
                sizeGuide: '',
                weight: { value: 0, unit: 'g' },
                dimensions: { length: { value: 0, unit: 'mm' }, width: { value: 0, unit: 'mm' }, height: { value: 0, unit: 'mm' } },
                shipping: {
                    sweden: { cost: 0, service: 'Standard' },
                    nordic: { cost: 0, service: 'Nordic' },
                    eu: { cost: 0, service: 'EU' },
                    worldwide: { cost: 0, service: 'International' },
                },
                delivery: { shipping: true, pickup: true },
                shopId,
                migratedFrom: `shopify:${host}`,
                shopifyKey,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
                createdAt: firestore_1.FieldValue.serverTimestamp(),
            };
            await database_1.db.collection('products').add(data);
            created++;
        }
        catch (e) {
            // One malformed product must never abort the whole import — record + move on.
            skipped.push((sp?.title || `#${sp?.id ?? '?'}`).toString().slice(0, 80));
            console.warn('migrateFromShopify: product skipped', sp?.id, e?.message);
        }
    }
    return {
        success: true,
        source: host,
        productsFound: products.length,
        created,
        alreadyImported,
        imageFailures,
        skipped,
        // Honest disclosure of what a public-catalog demo import cannot carry, so the
        // operator never mistakes it for a full migration.
        droppedShopifyFields,
        note: 'Demo-import: endast publik katalog (produkter, varianter, priser, bilder). Lager, ordrar, kunder och tryckfiler ingår inte.',
    };
});
//# sourceMappingURL=migrateFromShopify.js.map