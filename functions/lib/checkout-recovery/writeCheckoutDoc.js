"use strict";
// Server-only checkout persistence. The immutable production snapshot is a
// REQUIRED payment invariant; abandoned-checkout recovery fields are layered
// onto the same rules-locked doc on a best-effort basis. The sweep (sweep.ts)
// later reminds the buyer if no order materialized.
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAbandonedCheckoutDoc = exports.writeCheckoutProductionSnapshot = void 0;
const firebase_functions_1 = require("firebase-functions");
const database_1 = require("../config/database");
const tokens_1 = require("./tokens");
// Clamp the per-shop reminder delay to a sane window.
const DEFAULT_DELAY_HOURS = 1;
const MIN_DELAY_HOURS = 1;
const MAX_DELAY_HOURS = 24;
const EXPIRY_DAYS = 7;
const PRODUCTION_SNAPSHOT_RETENTION_DAYS = 30;
/**
 * Persist the immutable production graph before the PaymentIntent client secret
 * is returned. This write is part of payment correctness (not recovery), so its
 * caller must fail checkout if it cannot complete.
 */
async function writeCheckoutProductionSnapshot(paymentIntentId, shopId, productionSnapshot) {
    const now = new Date();
    await database_1.db.collection('checkouts').doc(paymentIntentId).set({
        shopId,
        paymentIntentId,
        productionSnapshotRequired: true,
        productionSnapshot,
        createdAt: now,
        productionSnapshotCreatedAt: now,
        retentionNextAttemptAt: new Date(now.getTime() + PRODUCTION_SNAPSHOT_RETENTION_DAYS * 86400 * 1000),
        expiresAt: new Date(now.getTime() + EXPIRY_DAYS * 86400 * 1000),
    }, { merge: true });
}
exports.writeCheckoutProductionSnapshot = writeCheckoutProductionSnapshot;
/**
 * Read a shop's cart-recovery reminder delay (hours), clamped to [1, 24]. Fails
 * open to the default so a transient read error never breaks checkout doc writes.
 */
async function resolveDelayHours(shopId) {
    try {
        const snap = await database_1.db.collection('shops').doc(shopId).get();
        const raw = snap.data()?.cartRecovery?.delayHours;
        const n = Number(raw);
        if (!Number.isFinite(n))
            return DEFAULT_DELAY_HOURS;
        return Math.min(MAX_DELAY_HOURS, Math.max(MIN_DELAY_HOURS, Math.round(n)));
    }
    catch {
        return DEFAULT_DELAY_HOURS;
    }
}
/**
 * Write (or overwrite) the abandoned-checkout doc for this PaymentIntent. Keyed
 * on the paymentIntentId so a retried checkout naturally supersedes its own doc.
 */
async function writeAbandonedCheckoutDoc(params) {
    const { paymentIntentId, shopId, customerInfo, itemsJson, totals } = params;
    const email = String(customerInfo?.email || '').trim();
    if (!email) {
        firebase_functions_1.logger.warn('checkout-recovery: no email, skipping checkout doc', { paymentIntentId });
        return;
    }
    // emailNorm is REQUIRED — all dedupe/cap/suppression logic keys on it.
    const emailNorm = email.toLowerCase();
    let items = [];
    try {
        const parsed = JSON.parse(itemsJson);
        if (Array.isArray(parsed)) {
            items = parsed.map((it) => ({
                productId: it?.productId || '',
                variantSku: it?.variantSku || '',
                sku: it?.sku || '',
                name: typeof it?.name === 'string' ? it.name : '',
                label: it?.label || '',
                price: Number(it?.price) || 0,
                quantity: Number(it?.quantity) || 1,
            }));
        }
    }
    catch (e) {
        firebase_functions_1.logger.warn('checkout-recovery: could not parse itemsJson', { paymentIntentId, error: e?.message });
    }
    const delayHours = await resolveDelayHours(shopId);
    const now = new Date();
    const remindAt = new Date(now.getTime() + delayHours * 3600 * 1000);
    const expiresAt = new Date(now.getTime() + EXPIRY_DAYS * 86400 * 1000);
    const firstName = String(customerInfo?.firstName || '').trim();
    const language = customerInfo?.preferredLang || 'sv-SE';
    await database_1.db.collection('checkouts').doc(paymentIntentId).set({
        shopId,
        paymentIntentId,
        customerEmail: email,
        emailNorm,
        customerName: String(customerInfo?.name || '').trim(),
        customerFirstName: firstName,
        language,
        consent: {
            marketing: customerInfo?.marketing === true,
            remindMe: customerInfo?.remindMe === true,
        },
        items,
        totals: {
            subtotal: Number(totals?.subtotal) || 0,
            vat: Number(totals?.vat) || 0,
            shipping: Number(totals?.shipping) || 0,
            discountAmount: Number(totals?.discountAmount) || 0,
            total: Number(totals?.total) || 0,
        },
        recoveryToken: (0, tokens_1.generateToken)(),
        createdAt: now,
        remindAt,
        expiresAt,
        status: 'open',
    }, { merge: true });
}
exports.writeAbandonedCheckoutDoc = writeAbandonedCheckoutDoc;
//# sourceMappingURL=writeCheckoutDoc.js.map