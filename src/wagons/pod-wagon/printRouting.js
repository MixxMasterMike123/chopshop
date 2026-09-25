// printRouting — WHICH printer makes a given garment, and which print surfaces
// it can take. Pure functions: no firebase imports, no I/O, no React. The
// caller hands in the already-loaded routing doc + printer capability docs
// (printersPublic/{uid}, see src/config/printRouting.js for the loader).
//
// WHY THIS EXISTS (Slice 3 of the multi-printer plan): the PLATFORM routes each
// garment type to a printer. The studio needs the SAME routing decision the
// server freezes at payment — to offer only garments someone makes, and to
// reshape the template to the routed printer's real print frames.
//
// NO COST CODE HERE (A13, "seller sees ONE number", Mikael 2026-09-25). This
// module used to price a design off the routed printer's tier; that required
// every seller to be able to read the tiers, and by subtraction the platform's
// cut. Cost is server-only now: the studio asks the quotePodCost callable
// (src/config/podCostQuote.js) for one number. rules-tests/one-number-pure.test.cjs
// greps THIS file and fails if any tier-price field name reappears in it.
//
// ⚠️ SERVER TWIN: functions/src/print/printRouting.ts holds the same routing +
// capability logic for the payment-time snapshot (Slice 4). The two are kept
// honest by rules-tests/print-routing-parity.test.cjs, which runs a fixture
// table through BOTH. Change one → change the other → run that test.
//
// Imported BOTH by Vite and by plain `node --test` / the parity suite — keep it
// dependency-free (any future relative import needs an explicit .js extension).

/**
 * resolvePrinterUid(garment, routing, printersById) → uid | null
 *
 * The routing decision, in one place:
 *   1. An EXPLICIT route (routing.byGarment[garment]) wins — but only if that
 *      printer is still eligible: it has a printersPublic/{uid} doc (deleting
 *      the tier removes the mirror and un-routes it), it is not deactivated, AND that doc lists this garment in
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
 * is listed by no printer → null. Fail closed: guessing would send a hoodie
 * to a tee-only printer.
 */
export const resolvePrinterUid = (garment, routing, printersById) => {
  const printers = printersById || {};
  const byGarment = routing?.byGarment || {};
  const g = typeof garment === 'string' && garment.trim() ? garment.trim() : null;

  // A DEACTIVATED printer (Tryckerier → Inaktivera mirrors users.active onto
  // printers/{uid}.active, projected onto printersPublic) is never eligible: printGuard rejects it at login,
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
 * (printersPublic/{uid}.printAreasMm[garment] = { [slot]: { w, h, offsetTopMm? } })
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

/** isSlotPrintable(printer, garment, slot) — isSlotPrintableInAreas on a printersPublic doc. */
export const isSlotPrintable = (tier, garment, slot) =>
  isSlotPrintableInAreas(garment ? tier?.printAreasMm?.[garment] : null, slot);
