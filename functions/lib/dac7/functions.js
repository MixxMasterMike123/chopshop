"use strict";
/**
 * DAC7 seller due-diligence + aggregation + export (Slices E/F).
 *
 * DAC7 obliges the platform to collect seller due-diligence data, aggregate per
 * seller per year, and report reportable sellers. This module provides:
 *   - saveDac7SellerProfile / getDac7SellerProfile — the seller fills/edits the
 *     DAC7 fields (branching individual vs company, Slice F), stored in the
 *     access-controlled dac7Sellers/{shopId} collection (NOT the public shops
 *     doc — PII would leak there). Can also pull validated values from Stripe.
 *   - aggregateDac7Year — per-shop gross + transaction count for a year (the
 *     pure math is aggregate.ts).
 *   - exportDac7Report — PLATFORM-ONLY: list reportable sellers for a year with
 *     their DAC7 fields + aggregate (the export the platform files / hands to
 *     Skatteverket, or cross-checks against Stripe's own DAC7 export).
 *
 * Stripe DAC7 feature (eval, 2026): Stripe Connect "platform tax reporting"
 * (tax_reporting additional verification) CAN be enabled for EU platforms incl.
 * Sweden — it collects+validates seller data and generates the EU XML report.
 * We store our own fields AND can pull from Stripe (decision E = both), so we're
 * not solely dependent on enabling the Stripe feature (which needs dashboard
 * setup). See docs/STRIPE_COMPLIANCE_REMEDIATION_PLAN.md §E.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportDac7Report = exports.aggregateDac7Year = exports.pullDac7FromStripe = exports.resolveDac7Correction = exports.requestDac7Correction = exports.correctOwnDac7Contact = exports.getOwnDac7 = exports.getDac7SellerProfile = exports.saveDac7SellerProfile = void 0;
const https_1 = require("firebase-functions/v2/https");
const stripe_1 = __importDefault(require("stripe"));
const firestore_1 = require("firebase-admin/firestore");
const database_1 = require("../config/database");
const app_urls_1 = require("../config/app-urls");
const authGuard_1 = require("../email-orchestrator/functions/authGuard");
const aggregate_1 = require("./aggregate");
// ⚠️ DAC7 is the PLATFORM operator's legal obligation (the "reporting platform
// operator" under EU Directive 2021/514) — NOT the shop owner's. The
// AUTHORITATIVE record + pull-from-Stripe + aggregation + de-minimis + export
// are PLATFORM-ONLY (requirePlatform). A seller gets GDPR rights over their OWN
// record only: VIEW it (access/transparency), CORRECT contact fields
// (rectification), and REQUEST a change to identity fields (which the platform
// approves). A seller can NEVER see another seller's data.
// Identity fields a seller may NOT self-edit (platform-only / via request).
const IDENTITY_KEYS = ['taxId', 'dateOfBirth', 'sellerType', 'orgNumber', 'personnummer'];
// Contact fields a seller MAY self-correct (GDPR rectification).
const CONTACT_KEYS = ['legalName', 'vatNumber', 'address', 'countryOfResidence'];
const COMMON = {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS,
    secrets: ['STRIPE_SECRET_KEY'],
};
function sanitizeProfile(input) {
    const out = {};
    if (input?.sellerType === 'individual' || input?.sellerType === 'company')
        out.sellerType = input.sellerType;
    for (const k of ['legalName', 'taxId', 'vatNumber', 'address', 'countryOfResidence', 'dateOfBirth']) {
        if (typeof input?.[k] === 'string')
            out[k] = input[k].trim();
    }
    return out;
}
exports.saveDac7SellerProfile = (0, https_1.onCall)(COMMON, async (request) => {
    await (0, authGuard_1.requirePlatform)(request.auth?.uid);
    const shopId = (request.data?.shopId || '').trim();
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId is required');
    const profile = sanitizeProfile(request.data?.profile);
    // Stamp shopId == doc id so the rules' shopId-equality check passes.
    await database_1.db.collection('dac7Sellers').doc(shopId).set({ shopId, ...profile, updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
    // SSOT for sellerType: keep the shop's first-class storeIdentity.sellerType in
    // sync with what the platform set here, so contract-track / UI logic outside
    // DAC7 reads the same value (mirrors the pull-from-Stripe sync).
    if (profile.sellerType === 'individual' || profile.sellerType === 'company') {
        await database_1.db.collection('shops').doc(shopId).set({ storeIdentity: { sellerType: profile.sellerType } }, { merge: true });
    }
    return { shopId, saved: true };
});
exports.getDac7SellerProfile = (0, https_1.onCall)(COMMON, async (request) => {
    await (0, authGuard_1.requirePlatform)(request.auth?.uid);
    const shopId = (request.data?.shopId || '').trim();
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId is required');
    const snap = await database_1.db.collection('dac7Sellers').doc(shopId).get();
    const profile = snap.exists ? snap.data() : null;
    // Single source of truth: if the DAC7 record has no sellerType yet, fall back
    // to the shop's first-class storeIdentity.sellerType (set at onboarding) so the
    // editor + identifier resolution stay coherent before a Stripe pull runs.
    if (profile && !profile.sellerType) {
        const shopSnap = await database_1.db.collection('shops').doc(shopId).get();
        const st = shopSnap.data()?.storeIdentity?.sellerType;
        if (st === 'individual' || st === 'company')
            profile.sellerType = st;
    }
    return { shopId, profile };
});
exports.getOwnDac7 = (0, https_1.onCall)(COMMON, async (request) => {
    const shopId = (request.data?.shopId || '').trim();
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId is required');
    // A shop admin may only pass THEIR OWN shopId (platform may pass any).
    await (0, authGuard_1.requireAdminOfShop)(shopId, request.auth?.uid);
    const snap = await database_1.db.collection('dac7Sellers').doc(shopId).get();
    return { shopId, profile: snap.exists ? snap.data() : null };
});
exports.correctOwnDac7Contact = (0, https_1.onCall)(COMMON, async (request) => {
    const shopId = (request.data?.shopId || '').trim();
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId is required');
    await (0, authGuard_1.requireAdminOfShop)(shopId, request.auth?.uid);
    const input = request.data?.contact || {};
    const patch = {};
    for (const k of CONTACT_KEYS) {
        if (typeof input[k] === 'string')
            patch[k] = input[k].trim();
    }
    // Reject any identity key sneaking in (defense in depth vs the rules).
    for (const k of IDENTITY_KEYS) {
        if (k in input)
            throw new https_1.HttpsError('permission-denied', `Field ${k} cannot be self-edited; submit a correction request`);
    }
    if (Object.keys(patch).length === 0)
        throw new https_1.HttpsError('invalid-argument', 'No correctable contact fields supplied');
    await database_1.db.collection('dac7Sellers').doc(shopId).set({ shopId, ...patch, updatedAt: firestore_1.FieldValue.serverTimestamp(), lastSelfCorrectedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
    return { shopId, corrected: Object.keys(patch) };
});
exports.requestDac7Correction = (0, https_1.onCall)(COMMON, async (request) => {
    const shopId = (request.data?.shopId || '').trim();
    const field = (request.data?.field || '').trim();
    const requestedValue = (request.data?.requestedValue || '').trim();
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId is required');
    await (0, authGuard_1.requireAdminOfShop)(shopId, request.auth?.uid);
    if (!IDENTITY_KEYS.includes(field)) {
        throw new https_1.HttpsError('invalid-argument', 'field must be a DAC7 identity field');
    }
    const ref = await database_1.db.collection('dac7CorrectionRequests').add({
        shopId, field, requestedValue,
        note: (request.data?.note || '').toString().slice(0, 500),
        status: 'pending',
        requestedBy: request.auth?.uid || null,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    });
    return { id: ref.id, status: 'pending' };
});
exports.resolveDac7Correction = (0, https_1.onCall)(COMMON, async (request) => {
    await (0, authGuard_1.requirePlatform)(request.auth?.uid);
    const requestId = (request.data?.requestId || '').trim();
    if (!requestId)
        throw new https_1.HttpsError('invalid-argument', 'requestId is required');
    const reqRef = database_1.db.collection('dac7CorrectionRequests').doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists)
        throw new https_1.HttpsError('not-found', 'Correction request not found');
    const r = reqSnap.data();
    if (r.status !== 'pending')
        throw new https_1.HttpsError('failed-precondition', 'Request already resolved');
    if (request.data?.approve === true) {
        // Apply the identity change to the authoritative record.
        if (IDENTITY_KEYS.includes(r.field)) {
            await database_1.db.collection('dac7Sellers').doc(r.shopId).set({ shopId: r.shopId, [r.field]: r.requestedValue, updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
        }
        await reqRef.update({ status: 'approved', resolvedBy: request.auth?.uid || null, resolvedAt: firestore_1.FieldValue.serverTimestamp() });
        return { status: 'approved' };
    }
    await reqRef.update({ status: 'rejected', resolvedBy: request.auth?.uid || null, resolvedAt: firestore_1.FieldValue.serverTimestamp() });
    return { status: 'rejected' };
});
// ── pullDac7FromStripe (PLATFORM-ONLY) ──────────────────────────────────────
// PRIMARY source: populate the authoritative DAC7 record from the connected
// account's Stripe Express KYC. business_type → sellerType; the account's
// company/individual blocks expose name/address/country/DOB; full tax ids are
// usually redacted by Stripe → the platform manually gap-fills those. This
// writes the authoritative identity record → platform-only.
exports.pullDac7FromStripe = (0, https_1.onCall)(COMMON, async (request) => {
    await (0, authGuard_1.requirePlatform)(request.auth?.uid);
    const shopId = (request.data?.shopId || '').trim();
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId is required');
    const shopSnap = await database_1.db.collection('shops').doc(shopId).get();
    const accountId = shopSnap.data()?.payments?.stripeAccountId;
    if (!accountId)
        throw new https_1.HttpsError('failed-precondition', 'No connected account to pull from');
    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!key)
        throw new https_1.HttpsError('failed-precondition', 'Stripe is not configured');
    const stripe = new stripe_1.default(key, { apiVersion: '2023-10-16' });
    const acct = await stripe.accounts.retrieve(accountId);
    const pulled = {};
    const bt = acct.business_type;
    if (bt === 'individual')
        pulled.sellerType = 'individual';
    else if (bt === 'company')
        pulled.sellerType = 'company';
    const ind = acct.individual;
    const comp = acct.company;
    if (pulled.sellerType === 'individual' && ind) {
        const name = [ind.first_name, ind.last_name].filter(Boolean).join(' ').trim();
        if (name)
            pulled.legalName = name;
        if (ind.dob?.year && ind.dob?.month && ind.dob?.day) {
            pulled.dateOfBirth = `${ind.dob.year}-${String(ind.dob.month).padStart(2, '0')}-${String(ind.dob.day).padStart(2, '0')}`;
        }
        if (ind.address?.country)
            pulled.countryOfResidence = ind.address.country;
        if (ind.address)
            pulled.address = formatStripeAddress(ind.address);
    }
    else if (pulled.sellerType === 'company' && comp) {
        if (comp.name)
            pulled.legalName = comp.name;
        if (comp.tax_id_provided)
            pulled.taxId = pulled.taxId; // Stripe redacts the value; flag only
        if (comp.vat_id_provided)
            pulled.vatNumber = pulled.vatNumber;
        if (comp.address?.country)
            pulled.countryOfResidence = comp.address.country;
        if (comp.address)
            pulled.address = formatStripeAddress(comp.address);
    }
    if (acct.country && !pulled.countryOfResidence)
        pulled.countryOfResidence = acct.country;
    pulled.verifiedViaStripe = true;
    // Merge (don't overwrite manually-entered values with empty Stripe values).
    const clean = sanitizeProfile(pulled);
    await database_1.db.collection('dac7Sellers').doc(shopId).set({ shopId, ...clean, verifiedViaStripe: true, stripePulledAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
    // Single source of truth: keep the shop's first-class sellerType in sync with
    // the Stripe-verified business_type, so contract-track / UI logic outside DAC7
    // reads the same value. Only write when Stripe resolved it.
    if (clean.sellerType === 'individual' || clean.sellerType === 'company') {
        await database_1.db.collection('shops').doc(shopId).set({ storeIdentity: { sellerType: clean.sellerType } }, { merge: true });
    }
    return { shopId, pulled: clean };
});
function formatStripeAddress(a) {
    return [a.line1, a.line2, a.postal_code, a.city, a.state, a.country].filter(Boolean).join(', ');
}
exports.aggregateDac7Year = (0, https_1.onCall)(COMMON, async (request) => {
    await (0, authGuard_1.requirePlatform)(request.auth?.uid);
    const shopId = (request.data?.shopId || '').trim();
    const year = Number(request.data?.year);
    if (!shopId)
        throw new https_1.HttpsError('invalid-argument', 'shopId is required');
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
        throw new https_1.HttpsError('invalid-argument', 'year must be a valid calendar year');
    }
    const orders = await loadShopOrders(shopId);
    const rate = Number.isFinite(request.data?.sekToEurRate) ? request.data.sekToEurRate : DEFAULT_SEK_TO_EUR;
    const agg = (0, aggregate_1.aggregateSellerYear)(orders, year, rate);
    return agg;
});
// A documented default SEK→EUR rate. The threshold is in EUR; orders are SEK.
// Override per-call with sekToEurRate from a live source; this default is a
// conservative placeholder for the de-minimis test (refine with the advisor).
const DEFAULT_SEK_TO_EUR = 0.087;
async function loadShopOrders(shopId) {
    // All of this shop's orders (b2c + b2b are both the seller's sales).
    const snap = await database_1.db.collection('orders').where('shopId', '==', shopId).get();
    return snap.docs.map((d) => {
        const o = d.data();
        return {
            total: o.total,
            status: o.status,
            createdAt: o.createdAt,
            source: o.source,
            // Partial-refund carve-out (aggregate subtracts what was refunded).
            refundedTotalSek: o.payment?.refundedTotalSek,
        };
    });
}
exports.exportDac7Report = (0, https_1.onCall)(COMMON, async (request) => {
    await (0, authGuard_1.requirePlatform)(request.auth?.uid);
    const year = Number(request.data?.year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
        throw new https_1.HttpsError('invalid-argument', 'year must be a valid calendar year');
    }
    const rate = Number.isFinite(request.data?.sekToEurRate) ? request.data.sekToEurRate : DEFAULT_SEK_TO_EUR;
    const includeBelow = request.data?.includeBelowDeMinimis === true;
    const markReported = request.data?.markReported === true;
    const shopsSnap = await database_1.db.collection('shops').get();
    const rows = [];
    let markedReported = 0;
    for (const shopDoc of shopsSnap.docs) {
        const shopId = shopDoc.id;
        const shop = shopDoc.data();
        const orders = await loadShopOrders(shopId);
        const agg = (0, aggregate_1.aggregateSellerYear)(orders, year, rate);
        // Skip sellers with no activity at all in the year unless asked.
        if (agg.transactionCount === 0 && !includeBelow)
            continue;
        if (agg.belowDeMinimis && !includeBelow)
            continue;
        const profileSnap = await database_1.db.collection('dac7Sellers').doc(shopId).get();
        const profile = profileSnap.exists ? profileSnap.data() : null;
        // Transparency: when finalising, record that this REPORTABLE seller was
        // reported for this year. De-minimis-excluded sellers are NOT reported, so
        // they get no record (their page shows nothing).
        if (markReported && agg.reportable) {
            await appendReportedRecord(shopId, year, agg);
            markedReported += 1;
        }
        rows.push({
            shopId,
            shopName: shop?.storeIdentity?.shopName || shop?.name || shopId,
            profile,
            aggregate: agg,
            // Flag sellers we'd report but whose DAC7 profile is incomplete.
            profileComplete: isProfileComplete(profile),
        });
    }
    return {
        year, sekToEurRate: rate,
        reportableCount: rows.filter((r) => r.aggregate.reportable).length,
        markedReported: markReported ? markedReported : undefined,
        rows,
    };
});
// Append (or replace, per year) a transparency record on the seller's DAC7 doc.
// reported is an array of { year, reportedAt, activity, grossReportedSek/Eur,
// txCountReported }. One entry per year; re-filing a year replaces it (no dupes).
async function appendReportedRecord(shopId, year, agg) {
    const ref = database_1.db.collection('dac7Sellers').doc(shopId);
    const snap = await ref.get();
    const entry = {
        year,
        reportedAt: new Date().toISOString(),
        activity: 'sale_of_goods',
        grossReportedSek: agg.grossConsiderationSek,
        grossReportedEur: agg.grossConsiderationEur,
        txCountReported: agg.transactionCount,
    };
    // Pure merge (aggregate.ts, unit-tested): replace this year, no dupes.
    const next = (0, aggregate_1.mergeReportedRecord)(snap.data()?.reported, entry);
    // shopId stamped so the rules' shopId-equality holds (platform write anyway).
    await ref.set({ shopId, reported: next }, { merge: true });
}
function isProfileComplete(p) {
    if (!p)
        return false;
    if (p.sellerType !== 'individual' && p.sellerType !== 'company')
        return false;
    if (!p.legalName || !p.taxId || !p.address || !p.countryOfResidence)
        return false;
    if (p.sellerType === 'individual' && !p.dateOfBirth)
        return false;
    return true;
}
//# sourceMappingURL=functions.js.map