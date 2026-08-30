"use strict";
// Server-side per-shop add-on entitlement reader. Mirrors the client's
// default-ON semantics (src/config/addons.js isFeatureEnabled): a feature is
// enabled unless EXPLICITLY set to false on shops/{shopId}.features. So a shop
// with no `features` field (e.g. the original b8shield shop), a missing key, or
// an unreadable doc all resolve to ENABLED — nothing is silently gated off.
//
// Used to enforce add-on flags inside Cloud Functions (P4.5b: affiliate). The
// `shops` doc lives in the named DB `b8s-reseller-db` — same `db` the rest of
// the functions read it through (see config/database + createShopUser.ts).
//
// This is the SERVER half of the affiliate money-path gate: it MUST agree with
// the client's useShopFeatures().isEnabled(...) decision, or the displayed
// total and the Stripe charge diverge (total-parity break). See
// docs/P4_5B_AFFILIATE_ENFORCEMENT_PLAN.md.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isShopFeatureEnabled = void 0;
const database_1 = require("./database");
const tenancy_1 = require("./tenancy");
// Explicit OPT-IN keys — MUST stay in lockstep with the client's OPT_IN_KEYS in
// src/config/addons.js. `pod` flipped to opt-in 2026-08-18 (pod-shop-type-
// selector plan D3) AFTER every existing shop got an explicit backfilled value.
const OPT_IN_KEYS = new Set(['pod', 'contentStudio', 'marketingMaterials']);
/**
 * Is `key` enabled for `shopId`? Legacy keys are default-ON: true unless the
 * flag is the literal boolean false. OPT_IN_KEYS are the inverse: false unless
 * the flag is the literal boolean true (missing doc/map/flag → OFF). Both fail
 * OPEN (return true) on a READ ERROR only, so a transient Firestore problem
 * never disables a paid feature mid-checkout (for pod: never blocks a POD
 * shop's checkout snapshot; the printer's shop ASSIGNMENT remains the primary
 * access control regardless).
 */
const isShopFeatureEnabled = async (shopId, key) => {
    try {
        const id = (shopId || tenancy_1.DEFAULT_SHOP_ID).trim() || tenancy_1.DEFAULT_SHOP_ID;
        const snap = await database_1.db.collection('shops').doc(id).get();
        const features = snap.exists ? snap.data()?.features : undefined;
        const map = features && typeof features === 'object' ? features : undefined;
        if (OPT_IN_KEYS.has(key))
            return map?.[key] === true; // opt-in: only literal true enables
        if (!map)
            return true; // no shop doc / no features map → default-ON (legacy keys)
        return map[key] !== false; // explicit false disables; anything else → ON
    }
    catch (err) {
        console.warn(`isShopFeatureEnabled(${shopId}, ${key}) failed; defaulting ON:`, err);
        return true;
    }
};
exports.isShopFeatureEnabled = isShopFeatureEnabled;
//# sourceMappingURL=shopFeatures.js.map