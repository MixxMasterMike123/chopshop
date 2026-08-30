// printRouting — WHICH printer makes a given garment, and what that printer's
// tier says it costs. Pure functions: no firebase imports, no I/O, no React.
// The caller hands in the already-loaded routing doc + printer tiers (see
// src/config/printRouting.js for the client loader).
//
// WHY THIS EXISTS (Slice 3 of the multi-printer plan): until now the seller's
// production cost came from the MOCKUP TEMPLATE (settings/podMockupTemplates
// carries blankCostSek/printCostSek). That only works with one printer: the
// template describes a garment, not who makes it. From here the PLATFORM routes
// each garment type to a printer, and the cost comes from THAT printer's tier
// (printers/{uid}.pricing). The template prices survive only as the fallback
// that keeps every existing shop working until routing is configured.
//
// ⚠️ SERVER TWIN: functions/src/print/printRouting.ts holds the same logic for
// the payment-time snapshot (Slice 4). The two are kept honest by
// rules-tests/print-routing-parity.test.cjs, which runs a fixture table through
// BOTH. Change one → change the other → run that test.
//
// EVERYTHING HERE IS EX MOMS, like every other stored cost term in the POD money
// path (podCostSek, snapshot line cost, printer tiers). Inkl-moms is a display
// concern on the seller-facing surfaces only (podPricing's inklMoms).
// Explicit .js extension: this module is imported BOTH by Vite (which resolves
// either way) and by plain `node --test` in the parity/unit suites, where ESM
// requires the extension.
import { PLATFORM_CUT_SEK, podCostForSlots } from './podPricing.js';

/**
 * resolvePrinterUid(garment, routing, printersById) → uid | null
 *
 * The routing decision, in one place:
 *   1. An EXPLICIT route (routing.byGarment[garment]) wins — but only if that
 *      printer is still eligible: it has a printers/{uid} doc (deleting the doc
 *      un-routes it) AND that doc lists this garment in `garments[]`. A stale
 *      route to a printer that no longer makes the garment must NOT silently
 *      price the product off the wrong tier — it falls through to the default.
 *   2. Otherwise the DEFAULT printer (routing.defaultPrinterUid), if it has a
 *      tier doc. The default is deliberately NOT required to list the garment:
 *      it is the operator's "everything else goes here" catch-all, and its tier
 *      simply may not price that blank (→ tierCostForSlots returns null → the
 *      caller falls back to the template).
 *   3. Otherwise null — nothing is routed.
 *
 * A null/unknown `garment` (an old mapping row, a template we can't classify)
 * takes route 2 straight away: there is no per-garment rule to apply.
 */
export const resolvePrinterUid = (garment, routing, printersById) => {
  const printers = printersById || {};
  const byGarment = routing?.byGarment || {};
  const g = typeof garment === 'string' && garment.trim() ? garment.trim() : null;

  // A DEACTIVATED printer (Tryckerier → Inaktivera mirrors users.active onto
  // printers/{uid}.active) is never eligible: printGuard rejects it at login,
  // so a line routed there would sit unprintable. Absent flag = active
  // (docs written before the mirror existed).
  const eligible = (uid) => !!uid && !!printers[uid] && printers[uid].active !== false;

  if (g) {
    const uid = byGarment[g];
    const tier = eligible(uid) ? printers[uid] : null;
    const garments = Array.isArray(tier?.garments) ? tier.garments : [];
    if (tier && garments.includes(g)) return uid;
  }

  const fallbackUid = routing?.defaultPrinterUid || null;
  return eligible(fallbackUid) ? fallbackUid : null;
};

/**
 * tierCostForSlots(tier, garment, slots) → number (EX moms) | null
 *
 * The printer's own quote for one garment with these DESIGNED slots printed:
 *
 *   blankCostSek[garment] + Σ printCostSek[slot]
 *
 * NOT including the platform cut — that is podCostForSlotsRouted's job, because
 * the cut is printer-independent (podPricing's PLATFORM_CUT_SEK) and must be
 * added exactly once.
 *
 * null when the blank price for THIS garment is missing: a printer that has not
 * quoted the blank cannot price the product at all, and guessing would put the
 * floor below the real cost. A missing SLOT price counts as 0 instead — the
 * same lenience as podCostForSlots, and for the same reason: an unquoted print
 * surface must not silence the whole floor (a slightly low floor still protects
 * far more than no floor at all, and the operator sees the gap in the tier UI).
 */
export const tierCostForSlots = (tier, garment, slots) => {
  const blank = tier?.pricing?.blankCostSek || {};
  const base = garment ? blank[garment] : undefined;
  if (!Number.isFinite(base)) return null;
  const print = tier?.pricing?.printCostSek || {};
  const prints = (Array.isArray(slots) ? slots : []).reduce(
    (sum, slot) => sum + (Number.isFinite(print[slot]) ? print[slot] : 0),
    0
  );
  return base + prints;
};

/**
 * podCostForSlotsRouted({ garment, slots, routing, printersById, template })
 *   → { cost: number|null, source: 'printer'|'template'|null, printerUid: string|null }
 *
 * The seller's production cost (EX moms) for a design, from the ROUTED printer's
 * tier when one resolves:
 *
 *   cost = tierCostForSlots(...) + PLATFORM_CUT_SEK
 *
 * FALLBACK (source: 'template'): when no printer routes, or the routed printer
 * has not priced this blank, we fall back to podCostForSlots(template, slots) —
 * the legacy per-template prices, which already include the cut. That keeps
 * every existing shop pricing exactly as before until the platform configures
 * routing; nothing regresses on the day this ships.
 *
 * `printerUid` is the routed printer when source === 'printer', else null — the
 * publish flow stamps it next to podCostSek so the product form can say which
 * tier the frozen cost came from. It is deliberately null on the template
 * fallback: no printer stands behind that number.
 *
 * source === null (cost null) means neither basis could price it — the caller
 * shows "—"/"Produktionskostnad saknas" rather than a made-up floor.
 */
export const podCostForSlotsRouted = ({ garment, slots, routing, printersById, template } = {}) => {
  const uid = resolvePrinterUid(garment, routing, printersById);
  const tier = uid ? (printersById || {})[uid] : null;
  const tierCost = tier ? tierCostForSlots(tier, garment, slots) : null;
  if (tierCost != null) {
    return { cost: tierCost + PLATFORM_CUT_SEK, source: 'printer', printerUid: uid };
  }
  const legacy = podCostForSlots(template, slots);
  return legacy != null
    ? { cost: legacy, source: 'template', printerUid: null }
    : { cost: null, source: null, printerUid: null };
};
