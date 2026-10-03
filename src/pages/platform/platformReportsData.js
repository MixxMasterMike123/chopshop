// PlatformReports' data layer: the OLDER build's implementation (Firebase).
//
// The page (PlatformReports.jsx) reaches its data only through this module, so
// one page serves two builds: the older build (vite.config.js) uses this file
// as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/platformReportsData.js (the API). Both
// files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, getDocs, getDoc, doc, updateDoc, query, orderBy, where, serverTimestamp } from 'firebase/firestore';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { db } from '../../firebase/config';

// Screening statuses that belong in the queue (server-stamped by
// screenProductOnWrite).
const QUEUE_STATUS_KEYS = ['blocked', 'flagged', 'review'];

/** The queue's note field ("Anteckning (vid avpublicering)") has somewhere to go. */
export const QUEUE_NOTE = true;

/** The paragraph above the queue. */
export const QUEUE_INTRO =
  'Flaggade produkter publiceras ändå — granska och avpublicera om säljaren saknar rätt till märket. Nya butikers första produkter hamnar här för en rutinkoll.';

/**
 * Everything the page shows: { reports, queue, shopNames }. The reports carry
 * their matched product (for the storefront link); the queue is unsorted.
 */
export async function loadReports() {
  const [repSnap, queueSnap, shopSnap] = await Promise.all([
    // Single orderBy on one collection — no composite index needed.
    getDocs(query(collection(db, 'infringementReports'), orderBy('createdAt', 'desc'))),
    // Single-field `in` — no composite index; sorted client-side.
    getDocs(query(collection(db, 'products'), where('screening.status', 'in', QUEUE_STATUS_KEYS))),
    getDocs(collection(db, 'shops')),
  ]);
  const names = {};
  shopSnap.docs.forEach((d) => {
    const s = d.data();
    names[d.id] = s.storeIdentity?.shopName || s.name || d.id;
  });

  const reps = repSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // The matched product (for the storefront link) — one read per distinct id.
  const ids = [...new Set(reps.map((r) => r.productId).filter(Boolean))];
  const prods = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, 'products', id));
      if (snap.exists()) prods[id] = { id, ...snap.data() };
    } catch { /* deleted product — row still renders from the report */ }
  }));

  const q = queueSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return {
    shopNames: names,
    reports: reps.map((r) => ({ ...r, product: prods[r.productId] || null })),
    queue: q,
  };
}

const takedown = (productId, reportId, note) =>
  httpsCallable(getFunctions(undefined, 'us-central1'), 'takedownProduct')({ productId, reportId, note });

/** Takes the report's product down (the takedownProduct callable). */
export const takedownForReport = (report, productId, note) => takedown(productId, report.id, note);

/** Closes the report ("Avvisa"). */
export const rejectReport = (report, note, uid) =>
  updateDoc(doc(db, 'infringementReports', report.id), {
    status: 'rejected', note: note || '', handledAt: serverTimestamp(), handledBy: uid || null,
  });

/** Moves the report to "Granskas" (also reopens a rejected one). */
export const markReportReviewing = (report) =>
  updateDoc(doc(db, 'infringementReports', report.id), { status: 'reviewing' });

/** "Godkänn": the screening is cleared. */
export const clearProduct = (product, uid) =>
  updateDoc(doc(db, 'products', product.id), {
    'screening.status': 'cleared',
    'screening.clearedAt': serverTimestamp(),
    'screening.clearedBy': uid || null,
  });

/** "Avpublicera" in the queue: the same takedown, with no report. */
export const takedownProduct = (product, note) => takedown(product.id, null, note);
