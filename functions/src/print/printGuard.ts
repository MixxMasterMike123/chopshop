// printGuard.ts — auth + scope for the print-shop CALLABLES.
//
// The print_shop role gets ZERO direct Firestore/Storage access (document-level
// rules can't field-scope an order's customer PII). All access flows through the
// callables in this folder, which enforce scope HERE by reading the caller's LIVE
// users/{uid} doc — so deactivating or re-roling a printer takes effect immediately
// (no token-TTL window, matching the firestore.rules "authority from the doc" rule).
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../config/database';
import { isShopFeatureEnabled } from '../config/shopFeatures';

export interface PrintShopContext {
  uid: string;
  printShopShops: string[]; // the shops this printer is allowed to fulfil (pod-enabled only)
}

/**
 * Assert the caller is an ACTIVE print_shop user; return their allowed shop list.
 * Throws (unauthenticated / permission-denied) otherwise. Reads the live doc.
 *
 * D6 (pod-shop-type-selector plan): a printer's assignment to a shop is not
 * enough — the shop must ALSO have the `pod` add-on enabled. Filtering HERE
 * (the one entry point every print callable calls first — getPrintQueue,
 * getPrintJob, getPrintQueueExport, getPrintArtworkLibrary,
 * getPrintArtworkDownload, setPrintJobStatus all start with this call) means
 * the pod-disabled shop simply never appears in printShopShops: the queue/
 * export/library loops skip it, and assertShopAllowed denies it for the
 * per-resource callables — one gate, six call sites, no per-file duplication.
 * Uses the SAME predicate as everywhere else (isShopFeatureEnabled), so this
 * stays default-ON until D3 flips pod to explicit opt-in.
 */
export async function getPrintShopContext(authUid?: string): Promise<PrintShopContext> {
  if (!authUid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const snap = await db.collection('users').doc(authUid).get();
  const data = snap.exists ? snap.data() : null;
  if (!data || data.role !== 'print_shop' || data.active !== true) {
    throw new HttpsError('permission-denied', 'Print shop access required');
  }
  const assignedShops = Array.isArray(data.printShopShops) ? data.printShopShops.filter((s: any) => typeof s === 'string') : [];
  if (assignedShops.length === 0) {
    // A printer with no assigned shops can see nothing — explicit, not a silent empty.
    throw new HttpsError('permission-denied', 'No shops assigned to this print account');
  }
  const podFlags = await Promise.all(assignedShops.map((shopId: string) => isShopFeatureEnabled(shopId, 'pod')));
  const shops = assignedShops.filter((_: string, i: number) => podFlags[i]);
  if (shops.length === 0) {
    // Every assigned shop has pod disabled — distinct message from "no shops
    // assigned" so a printer/operator can tell the two cases apart.
    throw new HttpsError('permission-denied', 'Print on demand is not enabled for any of your assigned shops');
  }
  return { uid: authUid, printShopShops: shops };
}

/** Assert an order's shop is one the caller may fulfil (per-resource scope check). */
export function assertShopAllowed(ctx: PrintShopContext, shopId: string): void {
  if (!shopId || !ctx.printShopShops.includes(shopId)) {
    throw new HttpsError('permission-denied', 'This order is not in your assigned shops');
  }
}
