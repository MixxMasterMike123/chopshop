/**
 * DAC7 seller due-diligence + aggregation + export (Slices E/F).
 *
 * DAC7 obliges the platform to collect seller due-diligence data, aggregate per
 * seller per year, and report reportable sellers. This module provides:
 *   - saveDac7SellerProfile / getDac7SellerProfile — the seller fills/edits the
 *     DAC7 fields (branching individual vs company, Slice F), stored in the
 *     access-controlled dac7Sellers/{shopId} collection (NOT the public shops
 *     doc — PII would leak there). Can also pull validated values from Stripe.
 *   - aggregateDac7Year — per-shop gross + transaction count for a year (the
 *     pure math is aggregate.ts).
 *   - exportDac7Report — PLATFORM-ONLY: list reportable sellers for a year with
 *     their DAC7 fields + aggregate (the export the platform files / hands to
 *     Skatteverket, or cross-checks against Stripe's own DAC7 export).
 *
 * Stripe DAC7 feature (eval, 2026): Stripe Connect "platform tax reporting"
 * (tax_reporting additional verification) CAN be enabled for EU platforms incl.
 * Sweden — it collects+validates seller data and generates the EU XML report.
 * We store our own fields AND can pull from Stripe (decision E = both), so we're
 * not solely dependent on enabling the Stripe feature (which needs dashboard
 * setup). See docs/STRIPE_COMPLIANCE_REMEDIATION_PLAN.md §E.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import Stripe from 'stripe';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/database';
import { appUrls } from '../config/app-urls';
import { requireAdminOfShop, requirePlatform } from '../email-orchestrator/functions/authGuard';
import { aggregateSellerYear, mergeReportedRecord, Dac7Order } from './aggregate';

// ⚠️ DAC7 is the PLATFORM operator's legal obligation (the "reporting platform
// operator" under EU Directive 2021/514) — NOT the shop owner's. The
// AUTHORITATIVE record + pull-from-Stripe + aggregation + de-minimis + export
// are PLATFORM-ONLY (requirePlatform). A seller gets GDPR rights over their OWN
// record only: VIEW it (access/transparency), CORRECT contact fields
// (rectification), and REQUEST a change to identity fields (which the platform
// approves). A seller can NEVER see another seller's data.

// Identity fields a seller may NOT self-edit (platform-only / via request).
const IDENTITY_KEYS = ['taxId', 'dateOfBirth', 'sellerType', 'orgNumber', 'personnummer'] as const;
// Contact fields a seller MAY self-correct (GDPR rectification).
const CONTACT_KEYS = ['legalName', 'vatNumber', 'address', 'countryOfResidence'] as const;

const COMMON = {
  region: 'us-central1' as const,
  memory: '256MiB' as const,
  timeoutSeconds: 60,
  cors: appUrls.CORS_ORIGINS,
  secrets: ['STRIPE_SECRET_KEY'],
};

// The DAC7 due-diligence fields. sellerType drives which identifier applies
// (individual → personnummer + DOB; company → orgNumber + VAT). We store our own
// copy AND, where available, mirror Stripe-verified values (verifiedViaStripe).
interface Dac7Profile {
  sellerType?: 'individual' | 'company';
  legalName?: string;
  taxId?: string;            // personnummer (individual) OR org.nr (company)
  vatNumber?: string;
  address?: string;
  countryOfResidence?: string; // ISO 3166-1 alpha-2
  dateOfBirth?: string;        // individuals only, ISO YYYY-MM-DD
}

function sanitizeProfile(input: any): Dac7Profile {
  const out: Dac7Profile = {};
  if (input?.sellerType === 'individual' || input?.sellerType === 'company') out.sellerType = input.sellerType;
  for (const k of ['legalName', 'taxId', 'vatNumber', 'address', 'countryOfResidence', 'dateOfBirth'] as const) {
    if (typeof input?.[k] === 'string') out[k] = input[k].trim();
  }
  return out;
}

// ── saveDac7SellerProfile (PLATFORM-ONLY) ───────────────────────────────────
// The platform operator writes/edits the AUTHORITATIVE DAC7 record, including
// the identity fields. Stored in dac7Sellers/{shopId}.
interface SaveProfileRequest { shopId: string; profile: Dac7Profile }

export const saveDac7SellerProfile = onCall<SaveProfileRequest>(COMMON, async (request) => {
  await requirePlatform(request.auth?.uid);
  const shopId = (request.data?.shopId || '').trim();
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');

  const profile = sanitizeProfile(request.data?.profile);
  // Stamp shopId == doc id so the rules' shopId-equality check passes.
  await db.collection('dac7Sellers').doc(shopId).set(
    { shopId, ...profile, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  // SSOT for sellerType: keep the shop's first-class storeIdentity.sellerType in
  // sync with what the platform set here, so contract-track / UI logic outside
  // DAC7 reads the same value (mirrors the pull-from-Stripe sync).
  if (profile.sellerType === 'individual' || profile.sellerType === 'company') {
    await db.collection('shops').doc(shopId).set(
      { storeIdentity: { sellerType: profile.sellerType } },
      { merge: true }
    );
  }
  return { shopId, saved: true };
});

// ── getDac7SellerProfile (PLATFORM-ONLY) ────────────────────────────────────
// Platform reads any seller's full DAC7 record (for the export/edit console).
interface ShopIdRequest { shopId: string }

export const getDac7SellerProfile = onCall<ShopIdRequest>(COMMON, async (request) => {
  await requirePlatform(request.auth?.uid);
  const shopId = (request.data?.shopId || '').trim();
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');
  const snap = await db.collection('dac7Sellers').doc(shopId).get();
  const profile = snap.exists ? (snap.data() as any) : null;
  // Single source of truth: if the DAC7 record has no sellerType yet, fall back
  // to the shop's first-class storeIdentity.sellerType (set at onboarding) so the
  // editor + identifier resolution stay coherent before a Stripe pull runs.
  if (profile && !profile.sellerType) {
    const shopSnap = await db.collection('shops').doc(shopId).get();
    const st = (shopSnap.data() as any)?.storeIdentity?.sellerType;
    if (st === 'individual' || st === 'company') profile.sellerType = st;
  }
  return { shopId, profile };
});

// ── getOwnDac7 (SELLER, own shop only) ──────────────────────────────────────
// GDPR access + DAC7 transparency: a shop admin reads ONLY their OWN record —
// what is held/reported about them. Never another seller's. shopId derives from
// the caller's own user doc via requireAdminOfShop, so it can't be spoofed.
interface OwnShopRequest { shopId: string }

export const getOwnDac7 = onCall<OwnShopRequest>(COMMON, async (request) => {
  const shopId = (request.data?.shopId || '').trim();
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');
  // A shop admin may only pass THEIR OWN shopId (platform may pass any).
  await requireAdminOfShop(shopId, request.auth?.uid);
  const snap = await db.collection('dac7Sellers').doc(shopId).get();
  return { shopId, profile: snap.exists ? snap.data() : null };
});

// ── correctOwnDac7Contact (SELLER, own shop, CONTACT fields only) ────────────
// GDPR rectification of the CONTACT subset (legalName/vatNumber/address/country).
// Identity keys are rejected here — those go through requestDac7Correction.
interface CorrectContactRequest { shopId: string; contact: Partial<Record<typeof CONTACT_KEYS[number], string>> }

export const correctOwnDac7Contact = onCall<CorrectContactRequest>(COMMON, async (request) => {
  const shopId = (request.data?.shopId || '').trim();
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');
  await requireAdminOfShop(shopId, request.auth?.uid);

  const input = request.data?.contact || {};
  const patch: Record<string, any> = {};
  for (const k of CONTACT_KEYS) {
    if (typeof (input as any)[k] === 'string') patch[k] = (input as any)[k].trim();
  }
  // Reject any identity key sneaking in (defense in depth vs the rules).
  for (const k of IDENTITY_KEYS) {
    if (k in (input as any)) throw new HttpsError('permission-denied', `Field ${k} cannot be self-edited; submit a correction request`);
  }
  if (Object.keys(patch).length === 0) throw new HttpsError('invalid-argument', 'No correctable contact fields supplied');

  await db.collection('dac7Sellers').doc(shopId).set(
    { shopId, ...patch, updatedAt: FieldValue.serverTimestamp(), lastSelfCorrectedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { shopId, corrected: Object.keys(patch) };
});

// ── requestDac7Correction (SELLER) / resolveDac7Correction (PLATFORM) ────────
// A seller requests a change to an IDENTITY field; the platform approves/rejects
// and applies it. Satisfies rectification while keeping report integrity.
interface RequestCorrectionRequest { shopId: string; field: string; requestedValue: string; note?: string }

export const requestDac7Correction = onCall<RequestCorrectionRequest>(COMMON, async (request) => {
  const shopId = (request.data?.shopId || '').trim();
  const field = (request.data?.field || '').trim();
  const requestedValue = (request.data?.requestedValue || '').trim();
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');
  await requireAdminOfShop(shopId, request.auth?.uid);
  if (!(IDENTITY_KEYS as readonly string[]).includes(field)) {
    throw new HttpsError('invalid-argument', 'field must be a DAC7 identity field');
  }
  const ref = await db.collection('dac7CorrectionRequests').add({
    shopId, field, requestedValue,
    note: (request.data?.note || '').toString().slice(0, 500),
    status: 'pending',
    requestedBy: request.auth?.uid || null,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id, status: 'pending' };
});

interface ResolveCorrectionRequest { requestId: string; approve: boolean }

export const resolveDac7Correction = onCall<ResolveCorrectionRequest>(COMMON, async (request) => {
  await requirePlatform(request.auth?.uid);
  const requestId = (request.data?.requestId || '').trim();
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required');
  const reqRef = db.collection('dac7CorrectionRequests').doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'Correction request not found');
  const r = reqSnap.data() as any;
  if (r.status !== 'pending') throw new HttpsError('failed-precondition', 'Request already resolved');

  if (request.data?.approve === true) {
    // Apply the identity change to the authoritative record.
    if ((IDENTITY_KEYS as readonly string[]).includes(r.field)) {
      await db.collection('dac7Sellers').doc(r.shopId).set(
        { shopId: r.shopId, [r.field]: r.requestedValue, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    await reqRef.update({ status: 'approved', resolvedBy: request.auth?.uid || null, resolvedAt: FieldValue.serverTimestamp() });
    return { status: 'approved' };
  }
  await reqRef.update({ status: 'rejected', resolvedBy: request.auth?.uid || null, resolvedAt: FieldValue.serverTimestamp() });
  return { status: 'rejected' };
});

// ── pullDac7FromStripe (PLATFORM-ONLY) ──────────────────────────────────────
// PRIMARY source: populate the authoritative DAC7 record from the connected
// account's Stripe Express KYC. business_type → sellerType; the account's
// company/individual blocks expose name/address/country/DOB; full tax ids are
// usually redacted by Stripe → the platform manually gap-fills those. This
// writes the authoritative identity record → platform-only.
export const pullDac7FromStripe = onCall<ShopIdRequest>(COMMON, async (request) => {
  await requirePlatform(request.auth?.uid);
  const shopId = (request.data?.shopId || '').trim();
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');

  const shopSnap = await db.collection('shops').doc(shopId).get();
  const accountId = (shopSnap.data() as any)?.payments?.stripeAccountId;
  if (!accountId) throw new HttpsError('failed-precondition', 'No connected account to pull from');

  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) throw new HttpsError('failed-precondition', 'Stripe is not configured');
  const stripe = new Stripe(key, { apiVersion: '2023-10-16' });
  const acct = await stripe.accounts.retrieve(accountId);

  const pulled: Dac7Profile & { verifiedViaStripe?: boolean } = {};
  const bt = (acct as any).business_type;
  if (bt === 'individual') pulled.sellerType = 'individual';
  else if (bt === 'company') pulled.sellerType = 'company';

  const ind = (acct as any).individual;
  const comp = (acct as any).company;
  if (pulled.sellerType === 'individual' && ind) {
    const name = [ind.first_name, ind.last_name].filter(Boolean).join(' ').trim();
    if (name) pulled.legalName = name;
    if (ind.dob?.year && ind.dob?.month && ind.dob?.day) {
      pulled.dateOfBirth = `${ind.dob.year}-${String(ind.dob.month).padStart(2, '0')}-${String(ind.dob.day).padStart(2, '0')}`;
    }
    if (ind.address?.country) pulled.countryOfResidence = ind.address.country;
    if (ind.address) pulled.address = formatStripeAddress(ind.address);
  } else if (pulled.sellerType === 'company' && comp) {
    if (comp.name) pulled.legalName = comp.name;
    if (comp.tax_id_provided) pulled.taxId = pulled.taxId; // Stripe redacts the value; flag only
    if (comp.vat_id_provided) pulled.vatNumber = pulled.vatNumber;
    if (comp.address?.country) pulled.countryOfResidence = comp.address.country;
    if (comp.address) pulled.address = formatStripeAddress(comp.address);
  }
  if (acct.country && !pulled.countryOfResidence) pulled.countryOfResidence = acct.country;
  pulled.verifiedViaStripe = true;

  // Merge (don't overwrite manually-entered values with empty Stripe values).
  const clean = sanitizeProfile(pulled);
  await db.collection('dac7Sellers').doc(shopId).set(
    { shopId, ...clean, verifiedViaStripe: true, stripePulledAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  // Single source of truth: keep the shop's first-class sellerType in sync with
  // the Stripe-verified business_type, so contract-track / UI logic outside DAC7
  // reads the same value. Only write when Stripe resolved it.
  if (clean.sellerType === 'individual' || clean.sellerType === 'company') {
    await db.collection('shops').doc(shopId).set(
      { storeIdentity: { sellerType: clean.sellerType } },
      { merge: true }
    );
  }
  return { shopId, pulled: clean };
});

function formatStripeAddress(a: any): string {
  return [a.line1, a.line2, a.postal_code, a.city, a.state, a.country].filter(Boolean).join(', ');
}

// ── aggregateDac7Year (PLATFORM-ONLY) ───────────────────────────────────────
// Reporting side: per-shop gross consideration + transaction count for a
// calendar year. On-demand query over the shop's orders (already shopId-stamped
// with createdAt — no migration). The reporting figures are the platform's, so
// platform-only.
interface AggregateRequest { shopId: string; year: number; sekToEurRate?: number }

export const aggregateDac7Year = onCall<AggregateRequest>(COMMON, async (request) => {
  await requirePlatform(request.auth?.uid);
  const shopId = (request.data?.shopId || '').trim();
  const year = Number(request.data?.year);
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required');
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new HttpsError('invalid-argument', 'year must be a valid calendar year');
  }

  const orders = await loadShopOrders(shopId);
  const rate = Number.isFinite(request.data?.sekToEurRate) ? (request.data!.sekToEurRate as number) : DEFAULT_SEK_TO_EUR;
  const agg = aggregateSellerYear(orders, year, rate);
  return agg;
});

// A documented default SEK→EUR rate. The threshold is in EUR; orders are SEK.
// Override per-call with sekToEurRate from a live source; this default is a
// conservative placeholder for the de-minimis test (refine with the advisor).
const DEFAULT_SEK_TO_EUR = 0.087;

async function loadShopOrders(shopId: string): Promise<Dac7Order[]> {
  // All of this shop's orders (b2c + b2b are both the seller's sales).
  const snap = await db.collection('orders').where('shopId', '==', shopId).get();
  return snap.docs.map((d) => {
    const o = d.data() as any;
    return {
      total: o.total,
      status: o.status,
      createdAt: o.createdAt,
      source: o.source,
      // Partial-refund carve-out (aggregate subtracts what was refunded).
      refundedTotalSek: o.payment?.refundedTotalSek,
    };
  });
}

// ── exportDac7Report ────────────────────────────────────────────────────────
// PLATFORM-ONLY: the reportable-seller export for a calendar year. For each
// active shop: its DAC7 profile + the year aggregate, with the de-minimis
// verdict. Skatteverket registration/filing is a separate manual step (we hand
// over this data or cross-check Stripe's DAC7 export).
//
// markReported (default false): a plain run is a PREVIEW (the platform may run
// it repeatedly to try FX rates) and writes NOTHING. When the platform actually
// FILES, it calls with markReported:true → for each REPORTABLE seller (NOT the
// de-minimis-excluded ones) we append a per-seller transparency record on
// dac7Sellers/{shopId}.reported so the seller is actively informed (DAC7
// transparency requirement). Idempotent per (shopId, year): re-filing the same
// year replaces that year's record, never duplicates.
interface ExportRequest { year: number; sekToEurRate?: number; includeBelowDeMinimis?: boolean; markReported?: boolean }

export const exportDac7Report = onCall<ExportRequest>(COMMON, async (request) => {
  await requirePlatform(request.auth?.uid);
  const year = Number(request.data?.year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new HttpsError('invalid-argument', 'year must be a valid calendar year');
  }
  const rate = Number.isFinite(request.data?.sekToEurRate) ? (request.data!.sekToEurRate as number) : DEFAULT_SEK_TO_EUR;
  const includeBelow = request.data?.includeBelowDeMinimis === true;
  const markReported = request.data?.markReported === true;

  const shopsSnap = await db.collection('shops').get();
  const rows: any[] = [];
  let markedReported = 0;
  for (const shopDoc of shopsSnap.docs) {
    const shopId = shopDoc.id;
    const shop = shopDoc.data() as any;
    const orders = await loadShopOrders(shopId);
    const agg = aggregateSellerYear(orders, year, rate);
    // Skip sellers with no activity at all in the year unless asked.
    if (agg.transactionCount === 0 && !includeBelow) continue;
    if (agg.belowDeMinimis && !includeBelow) continue;

    const profileSnap = await db.collection('dac7Sellers').doc(shopId).get();
    const profile = profileSnap.exists ? (profileSnap.data() as any) : null;

    // Transparency: when finalising, record that this REPORTABLE seller was
    // reported for this year. De-minimis-excluded sellers are NOT reported, so
    // they get no record (their page shows nothing).
    if (markReported && agg.reportable) {
      await appendReportedRecord(shopId, year, agg);
      markedReported += 1;
    }

    rows.push({
      shopId,
      shopName: shop?.storeIdentity?.shopName || shop?.name || shopId,
      profile,
      aggregate: agg,
      // Flag sellers we'd report but whose DAC7 profile is incomplete.
      profileComplete: isProfileComplete(profile),
    });
  }
  return {
    year, sekToEurRate: rate,
    reportableCount: rows.filter((r) => r.aggregate.reportable).length,
    markedReported: markReported ? markedReported : undefined,
    rows,
  };
});

// Append (or replace, per year) a transparency record on the seller's DAC7 doc.
// reported is an array of { year, reportedAt, activity, grossReportedSek/Eur,
// txCountReported }. One entry per year; re-filing a year replaces it (no dupes).
async function appendReportedRecord(shopId: string, year: number, agg: any): Promise<void> {
  const ref = db.collection('dac7Sellers').doc(shopId);
  const snap = await ref.get();
  const entry = {
    year,
    reportedAt: new Date().toISOString(),
    activity: 'sale_of_goods',
    grossReportedSek: agg.grossConsiderationSek,
    grossReportedEur: agg.grossConsiderationEur,
    txCountReported: agg.transactionCount,
  };
  // Pure merge (aggregate.ts, unit-tested): replace this year, no dupes.
  const next = mergeReportedRecord(snap.data()?.reported, entry);
  // shopId stamped so the rules' shopId-equality holds (platform write anyway).
  await ref.set({ shopId, reported: next }, { merge: true });
}

function isProfileComplete(p: any): boolean {
  if (!p) return false;
  if (p.sellerType !== 'individual' && p.sellerType !== 'company') return false;
  if (!p.legalName || !p.taxId || !p.address || !p.countryOfResidence) return false;
  if (p.sellerType === 'individual' && !p.dateOfBirth) return false;
  return true;
}
