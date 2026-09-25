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
 *      un-routes it), it is not deactivated, AND that doc lists this garment in
 *      `garments[]`. A stale route to a printer that no longer makes the
 *      garment must NOT silently price the product off the wrong tier — it
 *      falls through to the default.
 *   2. Otherwise the DEFAULT printer (routing.defaultPrinterUid) — under the
 *      SAME eligibility rule, INCLUDING "lists the garment" (SnapWear A4,
 *      2026-09-25). The default used to be an unconditional catch-all; that
 *      was a capability bypass: a flat cap SnapWear cannot make would have
 *      been "routed" to SnapWear, withheld nothing (no blank price) and been
 *      sent nowhere. The default now means "who makes the garments nobody
 *      routed explicitly", never "who gets what nobody can make".
 *   3. Otherwise null — nothing is routed. The studio hides such a garment and
 *      checkout refuses it (409 no-printer-for-garment).
 *
 * A null/unknown `garment` (an old mapping row, a template we can't classify)
 * is listed by no printer → null. Fail closed: guessing would print a hoodie
 * off a tee tier.
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

  if (!g) return null;
  const makes = (uid) =>
    eligible(uid) && Array.isArray(printers[uid].garments) && printers[uid].garments.includes(g);

  const routedUid = byGarment[g];
  if (makes(routedUid)) return routedUid;
  const fallbackUid = routing?.defaultPrinterUid || null;
  return makes(fallbackUid) ? fallbackUid : null;
};

// A usable print frame: both sides positive, finite millimetres.
const isArea = (a) =>
  !!a && typeof a === 'object' && Number.isFinite(a.w) && a.w > 0 && Number.isFinite(a.h) && a.h > 0;

/**
 * isSlotPrintableInAreas(areasForGarment, slot) → boolean
 *
 * Can a printer whose frames for ONE garment are `areasForGarment`
 * (printers/{uid}.printAreasMm[garment] = { [slot]: { w, h, offsetTopMm? } })
 * print `slot`?
 *   • no frames recorded for the garment (null / not an object) → true: the
 *     printer published no capability data, so nothing is gated — the pre-A3
 *     behaviour, and what every tier without printAreasMm keeps.
 *   • 'other' → true: the catch-all placement is not a physical surface.
 *   • the slot has its own frame → true.
 *   • 'pocket' without one → true when `front` has a frame: the pocket is a
 *     POSITION inside the front canvas (SnapWear places a left-chest logo 1:1
 *     there), not a separate surface.
 *   • otherwise false — an ABSENT slot means the printer cannot print it
 *     (SnapWear: sleeves).
 */
export const isSlotPrintableInAreas = (areasForGarment, slot) => {
  if (!areasForGarment || typeof areasForGarment !== 'object') return true;
  if (slot === 'other') return true;
  if (isArea(areasForGarment[slot])) return true;
  return slot === 'pocket' && isArea(areasForGarment.front);
};

/** isSlotPrintable(tier, garment, slot) — isSlotPrintableInAreas on a tier doc. */
export const isSlotPrintable = (tier, garment, slot) =>
  isSlotPrintableInAreas(garment ? tier?.printAreasMm?.[garment] : null, slot);

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
