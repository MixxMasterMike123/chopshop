// functions.ts — the print-shop CALLABLES (callable projection model).
//
// The print_shop role has NO direct DB/Storage access. These callables enforce
// scope off the caller's LIVE user doc (instant revoke) and return ONLY
// production-scoped data + short-lived signed URLs:
//   - getPrintQueue        minimal list of the printer's POD orders
//   - getPrintJob          one order's production view (ship-to + lines + signed files)
//   - getPrintQueueExport  production rows for a CSV (built client-side)
//   - createPrintShopUser  PLATFORM-only: provision a print_shop user + assigned shops
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/database';
import { appUrls } from '../config/app-urls';
import { requirePlatform } from '../email-orchestrator/functions/authGuard';
import { getPrintShopContext, assertShopAllowed } from './printGuard';
import { loadShopMappings, orderHasPodLine, toQueueRow, toPrintJob } from './printProjection';

const auth = getAuth();

// A printer must NEVER print a finished or dead order (a refunded order shipped
// again is money lost). These statuses are hidden from the queue by default; the
// includeAll flag surfaces them (for reference / a printer double-checking history).
const HIDDEN_STATUSES = new Set(['cancelled', 'refunded', 'shipped', 'delivered', 'completed']);
// `as const` keeps memory:'256MiB' as the literal MemoryOption type (an inline
// object widens it to string, which onCall rejects — same reason createShopUser
// passes options inline).
const COMMON = { region: 'us-central1', memory: '256MiB', timeoutSeconds: 120, cors: appUrls.CORS_ORIGINS } as const;

// Resolve shop display names once (small set of assigned shops).
async function shopNames(shopIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(shopIds.map(async (id) => {
    const s = await db.collection('shops').doc(id).get();
    out[id] = (s.exists && (s.data()?.name || s.data()?.storeIdentity?.shopName)) || id;
  }));
  return out;
}

// ---- getPrintQueue: minimal list of the printer's POD orders ----
export const getPrintQueue = onCall(COMMON, async (request) => {
  const ctx = await getPrintShopContext(request.auth?.uid);
  const sinceDays = Math.min(Math.max(Number(request.data?.sinceDays) || 90, 1), 365);
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  // By default hide finished/dead orders (a printer must never print a refunded
  // order). includeAll=true surfaces them for history/reference.
  const includeAll = request.data?.includeAll === true;
  const names = await shopNames(ctx.printShopShops);

  const jobs: any[] = [];
  // Per-shop (avoids the 30-item `in` cap and lets us load each shop's mappings once).
  for (const shopId of ctx.printShopShops) {
    const mappings = await loadShopMappings(shopId);
    if (mappings.size === 0) continue; // shop has no POD mappings → no POD orders
    const snap = await db.collection('orders').where('shopId', '==', shopId).get();
    snap.docs.forEach((d) => {
      const order = d.data();
      const createdMs = order.createdAt?.toDate ? order.createdAt.toDate().getTime() : 0;
      if (createdMs && createdMs < sinceMs) return;
      if (!includeAll && HIDDEN_STATUSES.has(String(order.status || ''))) return;
      if (!orderHasPodLine(order, mappings)) return;
      jobs.push(toQueueRow(d.id, order, names[shopId], mappings));
    });
  }
  jobs.sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')));
  return { jobs };
});

// ---- getPrintJob: one order's production view (per-resource scope check) ----
export const getPrintJob = onCall(COMMON, async (request) => {
  const ctx = await getPrintShopContext(request.auth?.uid);
  const orderId = String(request.data?.orderId || '').trim();
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required');

  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data() as any;

  // CRUX: the order's shop must be one this printer may fulfil.
  assertShopAllowed(ctx, order.shopId);

  const mappings = await loadShopMappings(order.shopId);
  const names = await shopNames([order.shopId]);
  return toPrintJob(orderId, order, names[order.shopId], mappings);
});

// ---- getPrintQueueExport: production rows for a CSV (built client-side) ----
export const getPrintQueueExport = onCall(COMMON, async (request) => {
  const ctx = await getPrintShopContext(request.auth?.uid);
  const sinceDays = Math.min(Math.max(Number(request.data?.sinceDays) || 90, 1), 365);
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const onlyShop = String(request.data?.shopId || '').trim();
  const includeAll = request.data?.includeAll === true;
  const targetShops = onlyShop ? ctx.printShopShops.filter((s) => s === onlyShop) : ctx.printShopShops;
  if (onlyShop && targetShops.length === 0) throw new HttpsError('permission-denied', 'Shop not assigned');
  const names = await shopNames(targetShops);

  const rows: any[] = [];
  for (const shopId of targetShops) {
    const mappings = await loadShopMappings(shopId);
    if (mappings.size === 0) continue;
    const snap = await db.collection('orders').where('shopId', '==', shopId).get();
    for (const d of snap.docs) {
      const order = d.data() as any;
      const createdMs = order.createdAt?.toDate ? order.createdAt.toDate().getTime() : 0;
      if (createdMs && createdMs < sinceMs) continue;
      if (!includeAll && HIDDEN_STATUSES.has(String(order.status || ''))) continue;
      if (!orderHasPodLine(order, mappings)) continue;
      const job = await toPrintJob(d.id, order, names[shopId], mappings);
      job.lines.forEach((ln: any) => {
        rows.push({
          orderNumber: job.order.orderNumber,
          orderDate: job.order.orderDate,
          shopName: job.shopName,
          productName: ln.productName,
          sku: ln.sku,
          variant: ln.variantLabel || '',
          quantity: ln.quantity,
          slot: ln.slotLabel || '',
          placement: ln.placement || '',
          purpose: ln.purpose || '',
          fileName: ln.artwork?.fileName || (ln.artwork?.unresolved ? `OLÖST: ${ln.artwork.reason}` : ''),
          // The DELIVERED format (print PNG for gated artwork), not the upload's —
          // fileName keeps the seller's name (logo.tiff) while the download is .png.
          format: ln.artwork?.ext ? ln.artwork.ext.toUpperCase() : '',
          tier: ln.artwork?.tier || '',
          // Pickup orders have NO customer ship-to (shipTo is null) — the row
          // shows the shop's pickup location instead.
          shipToCity: job.deliveryMethod === 'pickup'
            ? `Upphämtning: ${job.pickup?.name || ''}`.replace(/: $/, '')
            : (job.shipTo?.city || ''),
          shipToCountry: job.shipTo?.country || '',
        });
      });
    }
  }
  return { rows };
});

// ---- createPrintShopUser: PLATFORM-only provisioning ----
interface CreatePrintShopUserRequest {
  email: string;
  name?: string;
  printShopShops: string[];
}

export const createPrintShopUser = onCall<CreatePrintShopUserRequest>(COMMON, async (request) => {
  await requirePlatform(request.auth?.uid);

  const email = (request.data.email || '').trim().toLowerCase();
  const name = (request.data.name || '').trim() || email;
  const shops = Array.isArray(request.data.printShopShops)
    ? request.data.printShopShops.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'A valid email is required');
  }
  if (shops.length === 0) {
    throw new HttpsError('invalid-argument', 'At least one shop must be assigned');
  }
  // Every assigned shop must exist.
  for (const shopId of shops) {
    const s = await db.collection('shops').doc(shopId).get();
    if (!s.exists) throw new HttpsError('not-found', `Shop "${shopId}" does not exist`);
  }

  const tempPassword = Math.random().toString(36).slice(2) + 'A1!';
  let authUser;
  let wasExisting = false;
  try {
    authUser = await auth.createUser({ email, password: tempPassword, displayName: name, emailVerified: true });
  } catch (error: any) {
    if (error.code === 'auth/email-already-exists') {
      authUser = await auth.getUserByEmail(email);
      // Deny-by-default reuse guard: only reuse an account that is ALREADY a
      // print_shop user (re-inviting). Never promote an admin/customer/affiliate.
      const existing = await db.collection('users').doc(authUser.uid).get();
      const ed = existing.exists ? existing.data() : null;
      if (!ed || ed.role !== 'print_shop') {
        throw new HttpsError('already-exists', `${email} is already in use and cannot be made a print account. Use a different email.`);
      }
      await auth.updateUser(authUser.uid, { password: tempPassword });
      wasExisting = true;
    } else {
      throw error;
    }
  }

  const uid = authUser.uid;
  await db.collection('users').doc(uid).set(
    {
      email,
      contactPerson: name,
      role: 'print_shop',
      printShopShops: shops,
      platform: false,
      active: true,
      isActive: true,
      createdByPlatform: true,
      updatedAt: FieldValue.serverTimestamp(),
      ...(wasExisting ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true }
  );

  // NO custom claim is set — the print_shop role uses none (callables read the live
  // doc; signed URLs replace any Storage claim). This is intentional, not an omission.

  return { success: true, uid, email, printShopShops: shops, wasExisting, tempPassword };
});
