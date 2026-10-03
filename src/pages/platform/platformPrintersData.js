// PlatformPrinters' data layer: the OLDER build's implementation (Firebase).
//
// The page (PlatformPrinters.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/platformPrintersData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDoc, getDocs, query, where, doc, updateDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions, auth } from '../../firebase/config';

/** The "Nytt tryckerikonto" form has a backend (createPrintShopUser). */
export const CREATE_ACCOUNT = true;

/** The per-garment routing selects have a backend (settings/printRouting.byGarment). */
export const ROUTE_BY_GARMENT = true;

/** The paragraph under the page's heading. */
export const PAGE_INTRO =
  'Skapa och hantera tryckerikonton. Ett tryckeri ser endast POD-ordrar för sina tilldelade butiker (via säkra serveranrop — ingen direkt databasåtkomst, inga kunduppgifter utöver leveransadress).';

/** The routing section's heading, its paragraph and its footnote. */
export const ROUTING_HEADING = 'Styrning per plagg';
export const ROUTING_INTRO =
  'Välj vilket tryckeri som tillverkar varje plaggtyp. Ett tryckeri kan väljas för ett plagg först när det kryssat i plagget under “Plagg & priser”. Produktens produktionskostnad — och därmed prisgolvet — hämtas från det valda tryckeriets prislista.';
export const ROUTING_FOOTNOTE =
  'Plagg utan eget val går till standardtryckeriet — men bara om det tillverkar plagget. Ett plagg som inget tryckeri tillverkar visas inte i designstudion och kan inte köpas.';

/**
 * Everything the page shows: { shops, printers, tiers, routing }.
 * `printers` = the print_shop users; `tiers` = printers/{uid} docs by uid;
 * `routing` = settings/printRouting ({} when absent).
 */
export async function loadPrinters() {
  const [shopSnap, printerSnap, tierSnap, routeSnap] = await Promise.all([
    getDocs(collection(db, 'shops')),
    getDocs(query(collection(db, 'users'), where('role', '==', 'print_shop'))),
    getDocs(collection(db, 'printers')),
    getDoc(doc(db, 'settings', 'printRouting')),
  ]);
  return {
    shops: shopSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    printers: printerSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    tiers: Object.fromEntries(tierSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])),
    routing: routeSnap.exists() ? routeSnap.data() || {} : {},
  };
}

/** A print_shop account. → the callable's result ({ data: { tempPassword? } }). */
export function createPrintShopAccount({ email, name, printShopShops }) {
  return httpsCallable(functions, 'createPrintShopUser')({ email, name, printShopShops });
}

/** Flips the printer's active flag (the users doc of an account printer, and the tier doc). */
export async function setPrinterActive(row) {
  if (row.kind === 'user') {
    await updateDoc(doc(db, 'users', row.id), { active: !row.active });
  }
  // Mirror onto the tier doc so the routing resolver (client + server) can
  // skip a deactivated printer without a users/ read — a routed line must
  // never land on a printer printGuard would reject. For an API printer
  // this flag IS the switch (no users doc exists).
  await setDoc(doc(db, 'printers', row.id), { active: !row.active }, { merge: true });
}

/** Nothing to say when the tier editor opens (a printers/{uid} doc is exactly the form's shape). */
export const tierEditorNote = () => null;

/**
 * Saves the tier editor's payload to printers/{uid}. → { doc, note }: the
 * printer's doc as the page now holds it, and no extra line for the toast.
 */
export async function savePrinterTier(row, payload, before) {
  const full = {
    ...payload,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.uid || null,
  };
  // mergeFields, not merge:true: a deep merge would keep a price or a print
  // frame the operator just EMPTIED alive inside the nested maps — and an
  // emptied frame must mean "cannot print". The listed fields are replaced
  // whole; any other field on the doc (type, catalog, shippingSek from the
  // SnapWear seed) survives.
  await setDoc(doc(db, 'printers', row.id), full, { mergeFields: Object.keys(full) });
  return { doc: { ...(before || {}), id: row.id, ...full }, note: null };
}

/** Saves settings/printRouting ({ byGarment, defaultPrinterUid }). */
export async function savePrintRouting({ byGarment, defaultPrinterUid }) {
  await setDoc(doc(db, 'settings', 'printRouting'), {
    byGarment,
    defaultPrinterUid,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.uid || null,
  }, { merge: true });
}
