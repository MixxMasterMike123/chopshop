"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUnresolvedShopId = exports.DEFAULT_SHOP_ID = exports.UNRESOLVED_SHOP_ID = void 0;
// Tenancy constants for Cloud Functions (server side).
//
// Mirrors src/config/tenancy.js. The two packages can't share code, so keep
// these values in sync with the client by hand.
//
// There is NO default shop. This sentinel is the fallback tenant id used when a
// request/metadata doesn't carry one — so a missing shopId can never produce an
// UNTAGGED order/doc, while also never silently binding the write to a real
// tenant's data (the b8shield default used to do exactly that). A doc stamped
// with the sentinel matches no shop's queries and is trivially greppable.
// See docs/SUPERADMIN_TENANCY_PLAN.md Phase 1.
exports.UNRESOLVED_SHOP_ID = '__unresolved__';
/** Back-compat alias for the remaining `shopId || DEFAULT_SHOP_ID` guard sites. */
exports.DEFAULT_SHOP_ID = exports.UNRESOLVED_SHOP_ID;
/** True when a shopId is missing or the unresolved sentinel (i.e. no real shop). */
const isUnresolvedShopId = (shopId) => !shopId || shopId === exports.UNRESOLVED_SHOP_ID;
exports.isUnresolvedShopId = isUnresolvedShopId;
//# sourceMappingURL=tenancy.js.map