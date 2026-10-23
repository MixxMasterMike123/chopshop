// The affiliate pages' data layer — the OLDER build's implementation
// (Firebase, CP13 A2).
//
// The six affiliate pages reach their data only through this module, so one
// page serves two builds: the older build (vite.config.js) uses this file as
// it is; the admin build (vite.admin.config.js) swaps it, by its alias list,
// for src/admin-app/replacements/adminAffiliateData.js (the API). Both files
// export the same names with the same meaning.
//
// The pages now hold the API's shapes (öre, basis points, ISO times), so this
// module maps the Firestore documents into them: kronor × 100, percent × 100.
// The reads and writes are the pages' former inline code, moved: approve is
// the `approveAffiliate` callable, deny deletes the application, the payout is
// processAffiliatePayout with its uploaded invoice, the invite creates the
// affiliate document (inactive, no login) as "Lägg till affiliate" did. What
// Firebase never had (a ledger, adjustments, invite links, payout requests)
// is switched off by CAPABILITIES; its calls refuse.

import { db, functions } from '../../firebase/config';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { withShopId } from '../../config/withShopId';
import { APP_URLS } from '../../config/urls';
import { getAffiliatePayoutHistory, processAffiliatePayout, uploadInvoicePDF } from '../../utils/affiliatePayouts';
import { validateCustomAffiliateCode } from '../../utils/affiliateCalculations';

/** The older build's addresses (src/App.jsx). */
export const PATHS = {
  list: '/admin/affiliates',
  invite: '/admin/affiliates/create',
  analytics: '/admin/affiliates/analytics',
  application: (id) => `/admin/affiliates/application/${id}`,
  detail: (id) => `/admin/affiliates/manage/${id}`,
  payout: (id) => `/admin/affiliates/payout/${id}`,
  order: (orderId) => `/admin/orders/${orderId}`,
};

export const CAPABILITIES = { ledger: false, adjustments: false, invites: false, payoutRequests: false, revoke: true };

export const PERIODS = [30, 90, 365];

const notHere = (what) => new Error(`${what} finns inte i den här versionen.`);
const minor = (kronor) => (Number.isFinite(Number(kronor)) ? Math.round(Number(kronor) * 100) : 0);
const bp = (percent) => (Number.isFinite(Number(percent)) ? Math.round(Number(percent) * 100) : 0);
const iso = (ts) => {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const lang = (value) => (String(value || 'sv').startsWith('en') ? 'en' : 'sv');

function rowOf(id, a) {
  const s = a.stats || {};
  return {
    affiliateId: id,
    code: a.affiliateCode || '',
    name: a.name || '',
    status: a.status || 'inactive',
    commissionBp: bp(a.commissionRate),
    discountBp: bp(a.checkoutDiscount),
    currency: 'SEK',
    // Firestore counts these for all time, not per 30 days.
    clicks30d: s.clicks || 0,
    conversions30d: s.conversions || 0,
    earnedMinor: minor(s.totalEarnings),
    payableMinor: minor(s.balance),
    createdAt: iso(a.createdAt),
  };
}

function applicationOf(id, x) {
  return {
    applicationId: id,
    status: x.status || 'pending',
    name: x.name || '',
    email: x.email || '',
    phone: x.phone || null,
    socials: x.socials || {},
    promotionMethod: x.promotionMethod || '',
    message: x.message || null,
    preferredLang: lang(x.preferredLang),
    termsVersion: null,
    termsAcceptedAt: null,
    decidedAt: null,
    decisionReason: null,
    affiliateId: null,
    createdAt: iso(x.createdAt),
  };
}

function detailOf(id, a) {
  const s = a.stats || {};
  const balance = minor(s.balance);
  return {
    affiliateId: id,
    applicationId: null,
    account: { invited: !a.credentialsSent, membership: null },
    address: { line1: a.address || null, line2: null, postalCode: a.postalCode || null, city: a.city || null, country: a.country || 'SE' },
    balances: [{
      currency: 'SEK',
      balanceMinor: balance,
      earnedMinor: minor(s.totalEarnings),
      heldMinor: 0,
      paidMinor: minor(s.totalPaidOut),
      payableMinor: balance,
      requestedMinor: 0,
    }],
    clicksByDay: [],
    code: a.affiliateCode || '',
    commissionBp: bp(a.commissionRate),
    conversions: s.conversions || 0,
    createdAt: iso(a.createdAt),
    currency: 'SEK',
    discountBp: bp(a.checkoutDiscount),
    email: a.email || '',
    links: { portalUrl: null, refLink: null },
    name: a.name || '',
    phone: a.phone || null,
    preferredLang: lang(a.preferredLang),
    programOn: true,
    promotionMethod: a.promotionMethod || null,
    reversedMinor: 0,
    socials: a.socials || {},
    status: a.status || 'inactive',
    terms: { acceptedAt: null, acceptedVersion: null, currentVersion: null, outdated: false },
  };
}

// ── the list ────────────────────────────────────────────────────────────────

export async function loadAffiliatesOverview(shopId) {
  const appSnap = await getDocs(query(collection(db, 'affiliateApplications'), where('shopId', '==', shopId), where('status', '==', 'pending')));
  const applications = appSnap.docs.map((d) => applicationOf(d.id, d.data()));
  const affSnap = await getDocs(query(collection(db, 'affiliates'), where('shopId', '==', shopId), orderBy('createdAt', 'desc')));
  const affiliates = affSnap.docs.map((d) => rowOf(d.id, d.data()));
  return {
    applications,
    moreApplications: false,
    affiliates,
    nextCursor: null,
    kpis: {
      pending: applications.length,
      clicks: affiliates.reduce((sum, a) => sum + a.clicks30d, 0),
      conversions: affiliates.reduce((sum, a) => sum + a.conversions30d, 0),
      accruedMinor: affiliates.reduce((sum, a) => sum + a.payableMinor, 0),
      currency: 'SEK',
    },
  };
}

export async function loadMoreAffiliates() {
  return { affiliates: [], nextCursor: null };
}

export async function testLinkOf(_shopId, row) {
  return `${APP_URLS.B2C_SHOP}/se?ref=${row.code}`;
}

// ── an application ──────────────────────────────────────────────────────────

export async function loadApplication(_shopId, applicationId) {
  const snap = await getDoc(doc(db, 'affiliateApplications', applicationId));
  return snap.exists() ? applicationOf(snap.id, snap.data()) : null;
}

export async function approveApplication(_shopId, application, form) {
  const approve = httpsCallable(functions, 'approveAffiliate');
  const result = await approve({
    applicationId: application.applicationId,
    name: application.name,
    email: application.email,
    phone: application.phone || '',
    socials: application.socials || {},
    promotionMethod: application.promotionMethod || '',
    message: application.message || '',
    checkoutDiscount: Number(form.discountPercent) || 10,
  });
  return { affiliateId: result?.data?.affiliateId ?? null, notice: null };
}

export async function denyApplication(_shopId, applicationId) {
  await deleteDoc(doc(db, 'affiliateApplications', applicationId));
  return { applicationId, status: 'denied' };
}

// ── "Lägg till affiliate" ───────────────────────────────────────────────────

export async function inviteAffiliate(shopId, form) {
  const name = String(form.name || '').trim();
  const email = String(form.email || '').trim();
  if (!name || !email) throw new Error('Namn och e-post är obligatoriska fält.');
  const code = String(form.code || '').trim().toUpperCase()
    || `${name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '').substring(0, 8)}-${Math.floor(100 + Math.random() * 900)}`;
  const ref = await addDoc(collection(db, 'affiliates'), withShopId({
    affiliateCode: code,
    name,
    email,
    status: 'inactive',
    commissionRate: parseInt(form.commissionPercent, 10) || 15,
    checkoutDiscount: parseInt(form.discountPercent, 10) || 10,
    preferredLang: form.preferredLang === 'en' ? 'en-GB' : 'sv-SE',
    stats: { clicks: 0, conversions: 0, totalEarnings: 0, balance: 0 },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, shopId));
  await setDoc(doc(db, 'affiliates', ref.id), { id: ref.id }, { merge: true });
  return { affiliateId: ref.id, notice: null };
}

// ── one affiliate ───────────────────────────────────────────────────────────

export async function loadAffiliate(_shopId, affiliateId) {
  const snap = await getDoc(doc(db, 'affiliates', affiliateId));
  return snap.exists() ? detailOf(snap.id, snap.data()) : null;
}

export async function loadAffiliateOrders(shopId, affiliateId) {
  const snap = await getDoc(doc(db, 'affiliates', affiliateId));
  const code = snap.exists() ? snap.data().affiliateCode : null;
  if (!code) return { orders: [], nextCursor: null };
  const orders = collection(db, 'orders');
  const [a, b] = await Promise.all([
    getDocs(query(orders, where('shopId', '==', shopId), where('affiliateCode', '==', code))),
    getDocs(query(orders, where('shopId', '==', shopId), where('affiliate.code', '==', code))),
  ]);
  const seen = new Set();
  const rows = [];
  for (const d of [...a.docs, ...b.docs]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const o = d.data();
    if (o.status === 'cancelled') continue;
    rows.push({
      orderId: d.id,
      orderNumber: o.orderNumber || d.id,
      paidAt: iso(o.createdAt),
      totalMinor: minor(o.total || o.totalAmount),
      currency: 'SEK',
      attribution: null,
      affiliateCommissionMinor: minor(o.affiliateCommission),
      selfReferral: false,
      state: 'none',
    });
  }
  rows.sort((x, y) => String(y.paidAt).localeCompare(String(x.paidAt)));
  return { orders: rows, nextCursor: null };
}

export async function loadAffiliateLedger() {
  return { entries: [], nextCursor: null };
}

export async function loadAffiliatePayouts(shopId, affiliateId) {
  const [affiliate, history] = await Promise.all([loadAffiliate(shopId, affiliateId), getAffiliatePayoutHistory(affiliateId, shopId)]);
  return {
    balances: affiliate?.balances ?? [],
    payouts: history.map((p) => ({
      payoutId: p.id,
      status: 'paid',
      amountMinor: minor(p.payoutAmount),
      currency: 'SEK',
      requestedAt: iso(p.payoutDate),
      paidAt: iso(p.payoutDate),
      reference: null,
      invoiceNumber: p.invoiceNumber || null,
      invoiceObjectId: p.invoiceUrl || null,
      notes: p.notes || null,
      voidedAt: null,
      voidReason: null,
    })),
    nextCursor: null,
  };
}

export async function saveAffiliate(shopId, affiliate, form) {
  const code = String(form.code || '').trim().toUpperCase();
  if (code && code !== affiliate.code) {
    const result = await validateCustomAffiliateCode(code, affiliate.affiliateId, shopId);
    if (!result.isValid) throw new Error(result.error);
  }
  await updateDoc(doc(db, 'affiliates', affiliate.affiliateId), {
    affiliateCode: code || affiliate.code,
    commissionRate: Number(form.commissionPercent),
    checkoutDiscount: Number(form.discountPercent),
    preferredLang: form.preferredLang === 'en' ? 'en-GB' : 'sv-SE',
    name: String(form.name || '').trim(),
    phone: String(form.phone || '').trim(),
    address: String(form.addressLine1 || '').trim(),
    postalCode: String(form.postalCode || '').trim(),
    city: String(form.city || '').trim(),
    country: form.country || 'SE',
    socials: { ...form.socials },
    promotionMethod: form.promotionMethod || '',
    updatedAt: new Date(),
  });
  return loadAffiliate(shopId, affiliate.affiliateId);
}

export async function setAffiliateStatus(shopId, affiliateId, status) {
  await updateDoc(doc(db, 'affiliates', affiliateId), { status, updatedAt: new Date().toISOString() });
  return loadAffiliate(shopId, affiliateId);
}

/** "Ta bort" keeps the history here too: the affiliate is made inactive. */
export async function removeAffiliate(shopId, affiliateId) {
  return setAffiliateStatus(shopId, affiliateId, 'inactive');
}

export async function resendInvite() {
  throw notHere('Inbjudan');
}

export async function addAdjustment() {
  throw notHere('Justering');
}

// ── payouts ─────────────────────────────────────────────────────────────────

export async function recordPayout(shopId, affiliateId, form, payableMinor) {
  const amount = Number(String(form.amount || '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Ange ett giltigt belopp');
  if (minor(amount) > payableMinor) throw new Error('Beloppet kan inte vara större än nuvarande saldo');
  if (!form.invoiceFile) throw new Error('Välj en fakturafil (PDF)');
  const invoiceNumber = String(form.invoiceNumber || '').trim();
  const upload = await uploadInvoicePDF(form.invoiceFile, affiliateId, invoiceNumber, shopId);
  await processAffiliatePayout(affiliateId, {
    payoutAmount: amount,
    invoiceNumber,
    invoiceUrl: upload.url,
    invoiceFileName: upload.fileName,
    notes: String(form.notes || '').trim(),
  }, shopId);
  return { status: 'paid', amountMinor: minor(amount) };
}

export async function markPayoutPaid() {
  throw notHere('Utbetalningsbegäran');
}

export async function voidPayout() {
  throw notHere('Utbetalningsbegäran');
}

/** Here the invoice is a Storage address: opened as it is. */
export async function downloadInvoice(_shopId, payout) {
  if (payout?.invoiceObjectId) window.open(payout.invoiceObjectId, '_blank', 'noopener');
}

// ── analytics ───────────────────────────────────────────────────────────────

/** Firestore keeps each affiliate's counters for all time: the period is not applied here. */
export async function loadAnalytics(shopId) {
  const snap = await getDocs(query(collection(db, 'affiliates'), where('shopId', '==', shopId), orderBy('createdAt', 'desc')));
  const rows = snap.docs.map((d) => rowOf(d.id, d.data()));
  const active = rows.filter((r) => r.status === 'active');
  return {
    since: null,
    currency: 'SEK',
    activeAffiliates: active.length,
    clicks: active.reduce((sum, r) => sum + r.clicks30d, 0),
    conversions: active.reduce((sum, r) => sum + r.conversions30d, 0),
    commissionMinor: active.reduce((sum, r) => sum + r.earnedMinor, 0),
    unpaidMinor: active.reduce((sum, r) => sum + r.payableMinor, 0),
    ranking: active.map((r) => ({
      affiliateId: r.affiliateId,
      code: r.code,
      name: r.name,
      clicks: r.clicks30d,
      conversions: r.conversions30d,
      commissionMinor: r.earnedMinor,
    })),
  };
}
