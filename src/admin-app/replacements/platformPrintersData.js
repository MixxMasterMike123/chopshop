// PlatformPrinters' data layer: the ADMIN build's implementation (CP5 unit FK).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/platformPrintersData.js (the older build's, Firebase);
// both export the same names with the same meaning, so the page is the same
// file in both builds.
//
// PLATFORM-ONLY (the seller sees ONE number): prices, print frames and the
// default printer. Only the platform console's printer page reaches this
// module; no module of the admin tree may.
//
// The printers: GET /v1/platform/printers, read to its end (every printer
// whole, with its tiers, and the default's id). Each becomes the page's
// printer doc (adapters/platformPrinters.js printerDocOf).
//   Aktivera / Inaktivera   PATCH …/:id { status }
//   Plagg & priser → Spara  PATCH …/:id { capabilities?, tiers?, expectedRevision }:
//                           only what the operator changed (printerPatchOf)
//   Standardtryckeri        PUT /v1/platform/printers/default { printerId | null }
// What has no route here, and leaves the page:
//   - tryckerikonton (createPrintShopUser): the print portal is PORT-LATER
//     (D12), so there are no print-shop accounts and no "Nytt tryckerikonto";
//   - styrning per plagg (settings/printRouting.byGarment): on the Worker a
//     POD product's mapping names its printer, so nothing is routed by garment
//     (D52); only the default printer remains.

import { AdminApiError, notAvailable } from '../../api/admin/client.js';
import { patchPrinter, putDefaultPrinter, readAllPrinters } from '../../api/admin/platform.js';
import {
  printerDocOf,
  printerErrorMessage,
  printerPatchOf,
  saveNoteOf,
  tierEditorNoteOf,
} from '../adapters/platformPrinters.js';

/** No print-shop accounts (the print portal is PORT-LATER): the create form leaves. */
export const CREATE_ACCOUNT = false;

/** No routing by garment (a product's mapping names its printer): the per-garment selects leave. */
export const ROUTE_BY_GARMENT = false;

/** The paragraph under the page's heading (the older one is about print-shop accounts). */
export const PAGE_INTRO =
  'Hantera plattformens tryckerier: vilka plagg de tillverkar, vad de kostar och var på plagget de kan trycka. Priserna och tryckytorna syns bara här — säljaren ser ett enda inköpspris per produkt. Tryckerikonton och tryckeriportalen finns inte i den här versionen.';

/** The routing section (the older one routes each garment to a printer: no such thing here). */
export const ROUTING_HEADING = 'Styrning';
export const ROUTING_INTRO =
  'Varje POD-produkt kopplas till ett bestämt tryckeri när den skapas. Produktens produktionskostnad — och därmed prisgolvet — hämtas från det tryckeriets prislista, så en prisändring under “Plagg & priser” gäller direkt även befintliga produkter.';
export const ROUTING_FOOTNOTE =
  'Standardtryckeriet är plattformens förval för nya produkter. Att byta det flyttar inga befintliga produkter och ändrar inga priser.';

/** An Error the page shows as it is (`userMessage`). */
function pageError(message, cause) {
  const error = new Error(message);
  error.userMessage = message;
  if (cause) error.cause = cause;
  return error;
}

async function run(call) {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof AdminApiError ? printerErrorMessage(error) : null;
    if (message) throw pageError(message, error);
    throw error;
  }
}

/**
 * Everything the page shows: { shops, printers, tiers, routing }. No shops
 * (they served the create form) and no print-shop users: every printer is a
 * printer doc in `tiers`, keyed by its id. `routing.byGarment` is empty.
 */
export async function loadPrinters() {
  const { printers, defaultPrinterId } = await readAllPrinters();
  return {
    shops: [],
    printers: [],
    tiers: Object.fromEntries(printers.map((view) => [view.printerId, printerDocOf(view)])),
    routing: { byGarment: {}, defaultPrinterUid: defaultPrinterId },
  };
}

/** No print-shop accounts in this build (the form is not shown). */
export function createPrintShopAccount() {
  return Promise.reject(notAvailable('Tryckerikonton'));
}

/** Aktivera / Inaktivera: the printer's status. */
export function setPrinterActive(row) {
  return run(() => patchPrinter(row.id, { status: row.active ? 'inactive' : 'active' }));
}

/** What the form cannot show as one value, said when the editor opens (or null). */
export const tierEditorNote = (doc) => tierEditorNoteOf(doc);

/**
 * Saves the tier editor: the changed fields only, fenced on the revision the
 * page was shown. → { doc, note, resync }: the printer as the server now
 * holds it, and what the edit did to live products (paused mappings, products
 * under the floor), for the toast.
 *
 * `resync`: the next save is a diff against `doc`, so the form must show
 * `doc` again. A save can change what a field projects to (removing one
 * garment's tier makes a print price that differed between garments one
 * value): a form left as it was would show that field empty and the next
 * save would delete the price, untouched.
 */
export async function savePrinterTier(row, payload, before) {
  const patch = printerPatchOf(before, payload);
  if (patch.problems) throw pageError(patch.problems.join(' '));
  if (patch.body === null) return { doc: before, note: null, resync: false };
  const result = await run(() => patchPrinter(row.id, patch.body));
  if (!result.printer) {
    // The edit went through but its answer carries no printer: there is no
    // baseline for another save from this page.
    throw pageError('Ändringen sparades, men tryckeriet kunde inte läsas tillbaka. Ladda om sidan innan du sparar igen.');
  }
  return { doc: printerDocOf(result.printer), note: saveNoteOf(result), resync: true };
}

/** Saves the default printer. A rule per garment cannot be saved (there is none on the API). */
export async function savePrintRouting({ byGarment, defaultPrinterUid }) {
  if (byGarment && Object.keys(byGarment).length > 0) {
    throw pageError('Styrning per plagg finns inte här: varje produkt kopplas till sitt tryckeri.');
  }
  await run(() => putDefaultPrinter(defaultPrinterUid ?? null));
}
