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
//                           only what the operator changed (printerPatchOf);
//                           first as a DRY RUN (unit CP5-FP): when it would pause
//                           mappings or leave products under their floor, the
//                           page's confirm says which before anything is
//                           written; then the write, fenced on the dry run's
//                           revision. A revision that moved (409
//                           revision_mismatch, at the dry run or the write):
//                           the printer is read again, the operator's changes
//                           are laid over it (adapters/merge.js; a field both
//                           changed stops the save), and the preview runs and
//                           asks again. A write whose answer is lost is read back.
//   Standardtryckeri        PUT /v1/platform/printers/default { printerId | null }
// What has no route here, and leaves the page:
//   - tryckerikonton (createPrintShopUser): the print portal is PORT-LATER
//     (D12), so there are no print-shop accounts and no "Nytt tryckerikonto";
//   - styrning per plagg (settings/printRouting.byGarment): on the Worker a
//     POD product's mapping names its printer, so nothing is routed by garment
//     (D52); only the default printer remains.

import { AdminApiError, notAvailable } from '../../api/admin/client.js';
import { getPrinter, patchPrinter, previewPrinterPatch, putDefaultPrinter, readAllPrinters } from '../../api/admin/platform.js';
import { mergeThree } from '../adapters/merge.js';
import { isLostAnswer } from '../adapters/platformModels.js';
import {
  editorFieldLabel,
  editorFieldsOf,
  previewConfirmText,
  previewNeedsConfirm,
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
    throw runError(error);
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

const isMoved = (error) => error instanceof AdminApiError && error.status === 409 && error.code === 'revision_mismatch';

/** How many times a moved printer is read again and the preview asked again before the save gives up. */
const MAX_REBASES = 2;

/**
 * The printer as stored now, with the operator's changes (`payload` against
 * `doc`, what the page was shown) laid over it. A field both changed
 * differently stops the save, naming the fields.
 */
async function rebase(row, doc, payload) {
  let fresh;
  try {
    fresh = await getPrinter(row.id);
  } catch (error) {
    throw pageError('Tryckeriet har ändrats och kunde inte läsas igen. Ladda om sidan och gör ändringen igen.', error);
  }
  if (!fresh) throw pageError('Tryckeriet finns inte längre här. Ladda om sidan.');
  const freshDoc = printerDocOf(fresh);
  const merged = mergeThree(editorFieldsOf(payload), editorFieldsOf(doc), editorFieldsOf(freshDoc));
  if (merged.lost.length > 0) {
    const names = [...new Set(merged.lost.map(editorFieldLabel))].join(', ');
    throw pageError(`Någon annan ändrade samma uppgifter på tryckeriet medan du arbetade (${names}). Ingenting sparades. Ladda om sidan och gör ändringen igen.`);
  }
  return { doc: freshDoc, payload: { ...payload, ...merged.value } };
}

/**
 * Saves the tier editor. → { doc, note, resync } (the printer as the server
 * now holds it, and the toast's note: what the edit did to live products),
 * or { cancelled: true } when the operator said no to the preview (nothing
 * was written; the form stays as it is).
 *
 * `confirmPreview(text)` → boolean (or a promise of one): asked only when the
 * dry run would pause mappings or leave products under their floor; without
 * it such a save is not made. A dry run with nothing to warn about goes
 * straight on, as the page saved before.
 *
 * `resync`: the next save is a diff against `doc`, so the form must show
 * `doc` again. A save can change what a field projects to (removing one
 * garment's tier makes a print price that differed between garments one
 * value): a form left as it was would show that field empty and the next
 * save would delete the price, untouched.
 */
export async function savePrinterTier(row, payload, before, { confirmPreview } = {}) {
  let doc = before;
  let edit = payload;
  let rebased = false;
  for (let round = 0; round <= MAX_REBASES; round += 1) {
    const patch = printerPatchOf(doc, edit);
    if (patch.problems) throw pageError(patch.problems.join(' '));
    if (patch.body === null) {
      // After a rebase: the printer already holds what the operator wants.
      return rebased ? { doc, note: 'Tryckeriet hade redan de här uppgifterna.', resync: true } : { doc: before, note: null, resync: false };
    }

    let preview;
    try {
      preview = await previewPrinterPatch(row.id, patch.body);
    } catch (error) {
      if (!isMoved(error)) throw runError(error);
      ({ doc, payload: edit } = await rebase(row, doc, edit));
      rebased = true;
      continue;
    }
    if (previewNeedsConfirm(preview)) {
      const text = previewConfirmText(preview, { printerName: doc.name, rebased });
      if (typeof confirmPreview !== 'function' || !(await confirmPreview(text))) return { cancelled: true };
    }

    const body = { ...patch.body, expectedRevision: preview.revision ?? patch.body.expectedRevision };
    let result;
    try {
      result = await patchPrinter(row.id, body);
    } catch (error) {
      if (isMoved(error)) {
        // The printer changed after the preview: read it again and ask again.
        ({ doc, payload: edit } = await rebase(row, doc, edit));
        rebased = true;
        continue;
      }
      if (!isLostAnswer(error)) throw runError(error);
      return readBackSave(row, edit, body.expectedRevision, error, rebased);
    }
    if (!result.printer) {
      // The edit went through but its answer carries no printer: there is no
      // baseline for another save from this page.
      throw pageError('Ändringen sparades, men tryckeriet kunde inte läsas tillbaka. Ladda om sidan innan du sparar igen.');
    }
    const lead = rebased ? 'Tryckeriet hade ändrats av någon annan; din ändring sparades ovanpå den ändringen.' : null;
    return { doc: printerDocOf(result.printer), note: [lead, saveNoteOf(result)].filter(Boolean).join(' ') || null, resync: true };
  }
  throw pageError('Tryckeriet ändrades flera gånger medan du sparade. Ingenting sparades. Ladda om sidan och gör ändringen igen.');
}

/**
 * A save whose answer was lost: the printer is read again. Still at the
 * revision the write was fenced on → not saved. Moved, and holding what the
 * operator's form says → saved (the form follows it). Moved otherwise, or
 * not readable → it cannot be told.
 */
async function readBackSave(row, edit, revision, cause, rebased) {
  let fresh;
  try {
    fresh = await getPrinter(row.id);
  } catch {
    fresh = undefined;
  }
  if (!fresh) {
    throw pageError('Anslutningen bröts och det är oklart om ändringen sparades. Ladda om sidan och kontrollera innan du försöker igen.', cause);
  }
  const freshDoc = printerDocOf(fresh);
  if (fresh.revision === revision) throw pageError('Anslutningen bröts och ändringen sparades inte. Försök igen.', cause);
  const check = printerPatchOf(freshDoc, edit);
  if (!check.problems && check.body === null) {
    const lead = rebased ? 'Tryckeriet hade ändrats av någon annan; din ändring sparades ovanpå den ändringen.' : null;
    return {
      doc: freshDoc,
      note: [lead, 'Svaret kom aldrig fram, men ändringen är sparad. Hur många produkter som påverkades kunde inte läsas.'].filter(Boolean).join(' '),
      resync: true,
    };
  }
  throw pageError('Anslutningen bröts och det är oklart om ändringen sparades: tryckeriet har ändrats. Ladda om sidan och kontrollera innan du försöker igen.', cause);
}

/** An API error → the page's sentence (printerErrorMessage), or the error as it is. */
function runError(error) {
  const message = error instanceof AdminApiError ? printerErrorMessage(error) : null;
  return message ? pageError(message, error) : error;
}

/** Saves the default printer. A rule per garment cannot be saved (there is none on the API). */
export async function savePrintRouting({ byGarment, defaultPrinterUid }) {
  if (byGarment && Object.keys(byGarment).length > 0) {
    throw pageError('Styrning per plagg finns inte här: varje produkt kopplas till sitt tryckeri.');
  }
  await run(() => putDefaultPrinter(defaultPrinterUid ?? null));
}
