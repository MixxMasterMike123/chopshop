"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPrintArtworkDownload = exports.getPrintArtworkLibrary = exports.createPrintShopUser = exports.getPrintQueueExport = exports.getPrintJob = exports.getPrintQueue = void 0;
// functions.ts — the print-shop CALLABLES (callable projection model).
//
// The print_shop role has NO direct DB/Storage access. These callables enforce
// scope off the caller's LIVE user doc (instant revoke) and return ONLY
// production-scoped data + short-lived signed URLs:
//   - getPrintQueue        minimal list of the printer's POD orders
//   - getPrintJob          one order's production view (ship-to + lines + signed files)
//   - getPrintQueueExport  production rows for a CSV (built client-side)
//   - createPrintShopUser  PLATFORM-only: provision a print_shop user + assigned shops
const https_1 = require("firebase-functions/v2/https");
const auth_1 = require("firebase-admin/auth");
const firestore_1 = require("firebase-admin/firestore");
const database_1 = require("../config/database");
const app_urls_1 = require("../config/app-urls");
const authGuard_1 = require("../email-orchestrator/functions/authGuard");
const printGuard_1 = require("./printGuard");
const printProjection_1 = require("./printProjection");
const auth = (0, auth_1.getAuth)();
// A printer must NEVER print a finished or dead order (a refunded order shipped
// again is money lost). These statuses are hidden from the queue by default; the
// includeAll flag surfaces them (for reference / a printer double-checking history).
const HIDDEN_STATUSES = new Set(['cancelled', 'refunded', 'shipped', 'delivered', 'completed']);
// `as const` keeps memory:'256MiB' as the literal MemoryOption type (an inline
// object widens it to string, which onCall rejects — same reason createShopUser
// passes options inline).
const COMMON = { region: 'us-central1', memory: '256MiB', timeoutSeconds: 120, cors: app_urls_1.appUrls.CORS_ORIGINS };
// Resolve shop display names once (small set of assigned shops).
async function shopNames(shopIds) {
    const out = {};
    await Promise.all(shopIds.map(async (id) => {
        const s = await database_1.db.collection('shops').doc(id).get();
        out[id] = (s.exists && (s.data()?.name || s.data()?.storeIdentity?.shopName)) || id;
    }));
    return out;
}
// ---- getPrintQueue: minimal list of the printer's POD orders ----
exports.getPrintQueue = (0, https_1.onCall)(COMMON, async (request) => {
    const ctx = await (0, printGuard_1.getPrintShopContext)(request.auth?.uid);
    const sinceDays = Math.min(Math.max(Number(request.data?.sinceDays) || 90, 1), 365);
    const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    // By default hide finished/dead orders (a printer must never print a refunded
    // order). includeAll=true surfaces them for history/reference.
    const includeAll = request.data?.includeAll === true;
    const names = await shopNames(ctx.printShopShops);
    const jobs = [];
    // Per-shop (avoids the 30-item `in` cap and lets us load each shop's mappings once).
    for (const shopId of ctx.printShopShops) {
        const mappings = await (0, printProjection_1.loadShopMappings)(shopId);
        if (mappings.size === 0)
            continue; // shop has no POD mappings → no POD orders
        const snap = await database_1.db.collection('orders').where('shopId', '==', shopId).get();
        snap.docs.forEach((d) => {
            const order = d.data();
            const createdMs = order.createdAt?.toDate ? order.createdAt.toDate().getTime() : 0;
            if (createdMs && createdMs < sinceMs)
                return;
            if (!includeAll && HIDDEN_STATUSES.has(String(order.status || '')))
                return;
            if (!(0, printProjection_1.orderHasPodLine)(order, mappings))
                return;
            jobs.push((0, printProjection_1.toQueueRow)(d.id, order, names[shopId], mappings));
        });
    }
    jobs.sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')));
    return { jobs };
});
// ---- getPrintJob: one order's production view (per-resource scope check) ----
exports.getPrintJob = (0, https_1.onCall)(COMMON, async (request) => {
    const ctx = await (0, printGuard_1.getPrintShopContext)(request.auth?.uid);
    const orderId = String(request.data?.orderId || '').trim();
    if (!orderId)
        throw new https_1.HttpsError('invalid-argument', 'orderId is required');
    const snap = await database_1.db.collection('orders').doc(orderId).get();
    if (!snap.exists)
        throw new https_1.HttpsError('not-found', 'Order not found');
    const order = snap.data();
    // CRUX: the order's shop must be one this printer may fulfil.
    (0, printGuard_1.assertShopAllowed)(ctx, order.shopId);
    const mappings = await (0, printProjection_1.loadShopMappings)(order.shopId);
    const names = await shopNames([order.shopId]);
    return (0, printProjection_1.toPrintJob)(orderId, order, names[order.shopId], mappings);
});
// ---- getPrintQueueExport: production rows for a CSV (built client-side) ----
exports.getPrintQueueExport = (0, https_1.onCall)(COMMON, async (request) => {
    const ctx = await (0, printGuard_1.getPrintShopContext)(request.auth?.uid);
    const sinceDays = Math.min(Math.max(Number(request.data?.sinceDays) || 90, 1), 365);
    const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const onlyShop = String(request.data?.shopId || '').trim();
    const includeAll = request.data?.includeAll === true;
    const targetShops = onlyShop ? ctx.printShopShops.filter((s) => s === onlyShop) : ctx.printShopShops;
    if (onlyShop && targetShops.length === 0)
        throw new https_1.HttpsError('permission-denied', 'Shop not assigned');
    const names = await shopNames(targetShops);
    const rows = [];
    for (const shopId of targetShops) {
        const mappings = await (0, printProjection_1.loadShopMappings)(shopId);
        if (mappings.size === 0)
            continue;
        const snap = await database_1.db.collection('orders').where('shopId', '==', shopId).get();
        for (const d of snap.docs) {
            const order = d.data();
            const createdMs = order.createdAt?.toDate ? order.createdAt.toDate().getTime() : 0;
            if (createdMs && createdMs < sinceMs)
                continue;
            if (!includeAll && HIDDEN_STATUSES.has(String(order.status || '')))
                continue;
            if (!(0, printProjection_1.orderHasPodLine)(order, mappings))
                continue;
            const job = await (0, printProjection_1.toPrintJob)(d.id, order, names[shopId], mappings);
            job.lines.forEach((ln) => {
                rows.push({
                    orderNumber: job.order.orderNumber,
                    orderDate: job.order.orderDate,
                    shopName: job.shopName,
                    productName: ln.productName,
                    sku: ln.sku,
                    variant: ln.variantLabel || '',
                    quantity: ln.quantity,
                    slot: ln.slotLabel || '',
                    placement: ln.placement || '',
                    purpose: ln.purpose || '',
                    fileName: ln.artwork?.fileName || (ln.artwork?.unresolved ? `OLÖST: ${ln.artwork.reason}` : ''),
                    // The DELIVERED format (print PNG for gated artwork), not the upload's —
                    // fileName keeps the seller's name (logo.tiff) while the download is .png.
                    format: ln.artwork?.ext ? ln.artwork.ext.toUpperCase() : '',
                    tier: ln.artwork?.tier || '',
                    // Pickup orders have NO customer ship-to (shipTo is null) — the row
                    // shows the shop's pickup location instead.
                    shipToCity: job.deliveryMethod === 'pickup'
                        ? `Upphämtning: ${job.pickup?.name || ''}`.replace(/: $/, '')
                        : (job.shipTo?.city || ''),
                    shipToCountry: job.shipTo?.country || '',
                });
            });
        }
    }
    return { rows };
});
exports.createPrintShopUser = (0, https_1.onCall)(COMMON, async (request) => {
    await (0, authGuard_1.requirePlatform)(request.auth?.uid);
    const email = (request.data.email || '').trim().toLowerCase();
    const name = (request.data.name || '').trim() || email;
    const shops = Array.isArray(request.data.printShopShops)
        ? request.data.printShopShops.map((s) => String(s).trim()).filter(Boolean)
        : [];
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new https_1.HttpsError('invalid-argument', 'A valid email is required');
    }
    if (shops.length === 0) {
        throw new https_1.HttpsError('invalid-argument', 'At least one shop must be assigned');
    }
    // Every assigned shop must exist.
    for (const shopId of shops) {
        const s = await database_1.db.collection('shops').doc(shopId).get();
        if (!s.exists)
            throw new https_1.HttpsError('not-found', `Shop "${shopId}" does not exist`);
    }
    const tempPassword = Math.random().toString(36).slice(2) + 'A1!';
    let authUser;
    let wasExisting = false;
    try {
        authUser = await auth.createUser({ email, password: tempPassword, displayName: name, emailVerified: true });
    }
    catch (error) {
        if (error.code === 'auth/email-already-exists') {
            authUser = await auth.getUserByEmail(email);
            // Deny-by-default reuse guard: only reuse an account that is ALREADY a
            // print_shop user (re-inviting). Never promote an admin/customer/affiliate.
            const existing = await database_1.db.collection('users').doc(authUser.uid).get();
            const ed = existing.exists ? existing.data() : null;
            if (!ed || ed.role !== 'print_shop') {
                throw new https_1.HttpsError('already-exists', `${email} is already in use and cannot be made a print account. Use a different email.`);
            }
            await auth.updateUser(authUser.uid, { password: tempPassword });
            wasExisting = true;
        }
        else {
            throw error;
        }
    }
    const uid = authUser.uid;
    await database_1.db.collection('users').doc(uid).set({
        email,
        contactPerson: name,
        role: 'print_shop',
        printShopShops: shops,
        platform: false,
        active: true,
        isActive: true,
        createdByPlatform: true,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
        ...(wasExisting ? {} : { createdAt: firestore_1.FieldValue.serverTimestamp() }),
    }, { merge: true });
    // NO custom claim is set — the print_shop role uses none (callables read the live
    // doc; signed URLs replace any Storage claim). This is intentional, not an omission.
    return { success: true, uid, email, printShopShops: shops, wasExisting, tempPassword };
});
// ---- getPrintArtworkLibrary: the printer's ARTWORK library (2026-08-11) ----
// The printer needs to re-download and printability-check uploaded originals
// OUTSIDE the order flow (Mikael request). Same projection discipline as the
// queue: field-minimized rows for the caller's ASSIGNED shops only — file
// facts + validation verdict + stored preview thumb. No uploader identity, no
// signed URLs here (download URLs are minted per file by
// getPrintArtworkDownload so links stay short-lived).
exports.getPrintArtworkLibrary = (0, https_1.onCall)(COMMON, async (request) => {
    const ctx = await (0, printGuard_1.getPrintShopContext)(request.auth?.uid);
    const names = await shopNames(ctx.printShopShops);
    const rows = [];
    for (const shopId of ctx.printShopShops) {
        const snap = await database_1.db.collection('podArtwork').where('shopId', '==', shopId).get();
        snap.docs.forEach((d) => {
            const a = d.data();
            const shopPrintPrefix = `pod-artwork/${shopId}/print/`;
            const hasPrintFile = typeof a.printStoragePath === 'string' && a.printStoragePath.startsWith(shopPrintPrefix);
            rows.push({
                id: d.id,
                shopId,
                shopName: names[shopId] || shopId,
                fileName: a.fileName || '',
                label: a.label || '',
                ext: a.ext || '',
                tier: a.validation?.tier || null,
                status: a.status || null,
                hasPrintFile,
                widthPx: a.sourceWidthPx || null,
                heightPx: a.sourceHeightPx || null,
                previewUrl: typeof a.previewUrl === 'string' ? a.previewUrl : null,
                createdAt: a.createdAt?.toDate ? a.createdAt.toDate().toISOString() : null,
            });
        });
    }
    // Newest first across shops.
    rows.sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
    return { artworks: rows };
});
// ---- getPrintArtworkDownload: mint ONE short-lived signed URL ----
// kind 'print' (the gate-verified PNG) or 'original' (the raw upload). Path
// guards mirror toPrintJob: only server-owned paths inside the artwork's OWN
// shop folder are honoured — a hand-crafted doc can't route foreign bytes.
exports.getPrintArtworkDownload = (0, https_1.onCall)(COMMON, async (request) => {
    const ctx = await (0, printGuard_1.getPrintShopContext)(request.auth?.uid);
    const artworkId = String(request.data?.artworkId || '');
    const kind = request.data?.kind === 'original' ? 'original' : 'print';
    if (!artworkId)
        throw new https_1.HttpsError('invalid-argument', 'artworkId krävs');
    const snap = await database_1.db.collection('podArtwork').doc(artworkId).get();
    if (!snap.exists)
        throw new https_1.HttpsError('not-found', 'Originalet finns inte längre');
    const a = snap.data();
    (0, printGuard_1.assertShopAllowed)(ctx, String(a.shopId || ''));
    const shopPrefix = `pod-artwork/${a.shopId}/`;
    const path = kind === 'print' ? a.printStoragePath : a.originalStoragePath;
    const fallback = kind === 'print' ? (a.printUrl || null) : (a.originalUrl || null);
    if (typeof path !== 'string' || !path.startsWith(shopPrefix)) {
        throw new https_1.HttpsError('not-found', kind === 'print'
            ? 'Tryckfil saknas — be butiken validera om originalet'
            : 'Originalfilen saknas');
    }
    const url = await (0, printProjection_1.signedUrlFor)(path, fallback);
    if (!url)
        throw new https_1.HttpsError('internal', 'Kunde inte skapa nedladdningslänk');
    return { url, kind, fileName: a.fileName || '', ext: kind === 'print' ? 'png' : (a.ext || '') };
});
//# sourceMappingURL=functions.js.map