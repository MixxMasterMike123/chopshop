// podCostQuote.js — the seller's production cost for a design, as ONE number
// from the server (A13, "seller sees ONE number", Mikael 2026-09-25).
//
// The studio used to compute this client-side from the printers' price tiers.
// Those tiers are platform-only now; this asks the quotePodCost callable and
// gets back { costSek, printerUid } — costSek = everything baked into one
// figure, EX moms (the "Inköp" basis; shown inkl. moms at the edge). Nothing
// here can tell the seller how that number is made up.
//
// Contract (same as the other studio loaders): never throws into the studio.
// Any failure — network, permission — degrades to { costSek: null, failed:
// true }, which the studio renders as "Produktionskostnad saknas". Callers that
// STAMP the number (publish/update) pass { fresh: true } so a stale memoised
// quote is never frozen onto a product, and refuse to write on `failed`.
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';

const NONE = Object.freeze({ costSek: null, printerUid: null });

// In-memory memo: the quote only changes when the platform re-prices or
// re-routes, which clearPodCostQuoteCache() (studio "Försök igen") covers.
const _memo = new Map();
const keyOf = (shopId, garment, slots) => `${shopId}|${garment}|${[...slots].sort()}`;

// DEV-only stub (studio harness): (args) => { costSek, printerUid }.
let _devQuote = null;

/**
 * quotePodCost({ shopId, garment, slots }, { fresh }) → Promise<{ costSek, printerUid }>
 */
export const quotePodCost = async ({ shopId, garment, slots } = {}, { fresh = false } = {}) => {
  const list = Array.isArray(slots) ? slots : [];
  if (_devQuote) return { ...NONE, ...(_devQuote({ shopId, garment, slots: list }) || {}) };
  if (!shopId || !garment) return NONE;
  const key = keyOf(shopId, garment, list);
  if (!fresh && _memo.has(key)) return _memo.get(key);
  try {
    const res = await httpsCallable(functions, 'quotePodCost')({ shopId, garment, slots: list });
    const costSek = Number.isFinite(res?.data?.costSek) ? res.data.costSek : null;
    const out = { costSek, printerUid: costSek != null ? res?.data?.printerUid || null : null };
    _memo.set(key, out);
    return out;
  } catch (err) {
    // Not memoised: a transient failure must not pin "no cost" for the session.
    // `failed` tells a STAMPING caller apart from "not priced": publish must
    // refuse rather than create a product with no cost and no price floor.
    console.warn('quotePodCost: could not fetch the production cost:', err?.message);
    return { ...NONE, failed: true };
  }
};

/** Drop every memoised quote (e.g. after a platform edit / studio retry). */
export const clearPodCostQuoteCache = () => {
  _memo.clear();
};

/** DEV-ONLY: stub the quote so the studio harness runs without the callable.
 *  No-op in production builds. */
export const seedPodCostQuoteForDev = (fn) => {
  if (!import.meta.env.DEV) return;
  _devQuote = typeof fn === 'function' ? fn : null;
};
