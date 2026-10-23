// The affiliate pages' data layer — the ADMIN build's implementation (CP13
// A2). The alias list of vite.admin.config.js puts this module where the six
// pages (AdminAffiliates, AdminAffiliateApplication, AdminAffiliateCreate,
// AdminAffiliateEdit, AdminAffiliatePayout, AdminAffiliateAnalytics) import
// src/pages/admin/adminAffiliateData.js (the older build's, Firebase). Same
// names, same meaning.
//
// The routes: src/api/admin/affiliates.js (CP13_A1_REPORT.md §4.3). The pages
// hold the API's shapes (öre, basis points, ISO times); a form becomes a body
// in adapters/affiliate.js. Nothing here computes a commission, a balance or
// what is payable: every such number is the server's.
//
// A refusal is thrown as an Error whose `message` is the Swedish sentence the
// page shows (affiliateRefusalMessage), `code` the API's.

import * as api from '../../api/admin/affiliates.js';
import { deleteObject, uploadObject } from '../../api/admin/uploads.js';
import {
  adjustmentBodyOf,
  affiliatePatchOf,
  approveBodyOf,
  inviteBodyOf,
  invoiceFileProblem,
  oneLine,
  recordPayoutBodyOf,
  sinceForDays,
} from '../adapters/affiliate.js';
import { mailNotSentMessage } from '../adapters/member.js';

/** The admin build's addresses (AdminApp.jsx ADMIN_ROUTES). */
export const PATHS = {
  list: '/admin/affiliates',
  invite: '/admin/affiliates/new',
  analytics: '/admin/affiliates/analytics',
  application: (id) => `/admin/affiliates/applications/${encodeURIComponent(id)}`,
  detail: (id) => `/admin/affiliates/${encodeURIComponent(id)}`,
  payout: (id) => `/admin/affiliates/${encodeURIComponent(id)}/payout`,
  order: (orderId) => `/admin/orders/${encodeURIComponent(orderId)}`,
};

/** What this build can do (the older build lacks the ledger, the invites and the payout requests). */
export const CAPABILITIES = { ledger: true, adjustments: true, invites: true, payoutRequests: true, revoke: true };

/** The analytics page's periods, in days (design §7.2: real, not a placebo). */
export const PERIODS = [30, 90, 365];

const PAGE = 50;

class PageError extends Error {}

function pageError(error, fallback, options) {
  const message = api.affiliateRefusalMessage(error, options);
  if (message === null && !fallback) return error;
  const wrapped = new PageError(message ?? fallback);
  wrapped.code = error?.code ?? null;
  wrapped.status = error?.status ?? null;
  return wrapped;
}

async function run(call, fallback, options) {
  try {
    return await call();
  } catch (error) {
    throw pageError(error, fallback, options);
  }
}

/** The invite calls ("Bjud in", approve, re-send): their 429 is the invite buckets'. */
const INVITE = { invite: true };

const opts = (shopId) => ({ shopId });

/** What the admission's answer means for the person, in a sentence, or null. */
function admissionNotice(result, email) {
  if (result.inviteError) {
    return 'Affiliaten är tillagd, men inbjudan kunde inte skickas. Skicka den igen från affiliatens sida (Konto).';
  }
  if (result.invited && result.mailConfigured === false) return mailNotSentMessage(email || 'Affiliaten');
  return null;
}

// ── the list (AdminAffiliates) ──────────────────────────────────────────────

/**
 * The list page: the pending applications, the first page of affiliates and
 * the KPIs of the last 30 days (the analytics route).
 */
export async function loadAffiliatesOverview(shopId) {
  return run(async () => {
    const [applications, affiliates, analytics] = await Promise.all([
      api.listApplications({ status: 'pending', limit: 100, ...opts(shopId) }),
      api.listAffiliates({ limit: PAGE, ...opts(shopId) }),
      api.getAnalytics({ since: sinceForDays(30), ...opts(shopId) }),
    ]);
    return {
      applications: applications.applications,
      moreApplications: applications.nextCursor !== null,
      affiliates: affiliates.affiliates,
      nextCursor: affiliates.nextCursor,
      kpis: {
        pending: applications.applications.length,
        clicks: analytics?.clicks ?? null,
        conversions: analytics?.conversions ?? null,
        accruedMinor: analytics?.unpaidMinor ?? null,
        currency: analytics?.currency ?? 'SEK',
      },
    };
  }, 'Kunde inte hämta affiliates.');
}

export async function loadMoreAffiliates(shopId, cursor) {
  return run(() => api.listAffiliates({ cursor, limit: PAGE, ...opts(shopId) }), 'Kunde inte hämta fler affiliates.');
}

/** "Testlänk": the server's link for the affiliate (built from the canonical origin, never here). */
export async function testLinkOf(shopId, row) {
  return run(async () => {
    const affiliate = await api.getAffiliate(row.affiliateId, opts(shopId));
    const link = affiliate?.links?.refLink;
    if (typeof link !== 'string' || link === '') throw new PageError('Länken finns inte: butikens webbadress är inte inställd.');
    return link;
  }, 'Kunde inte hämta länken.');
}

// ── an application (AdminAffiliateApplication) ──────────────────────────────

export async function loadApplication(shopId, applicationId) {
  return run(() => api.getApplication(applicationId, opts(shopId)), 'Kunde inte hämta ansökan.');
}

/** "Godkänn och bjud in". → { affiliateId, notice } */
export async function approveApplication(shopId, application, form) {
  const parsed = approveBodyOf(form);
  if (parsed.error) throw new PageError(parsed.error);
  return run(async () => {
    const result = await api.approveApplication(application.applicationId, parsed.body, opts(shopId));
    return { affiliateId: result.affiliate?.affiliateId ?? null, notice: admissionNotice(result, application.email) };
  }, 'Kunde inte godkänna ansökan.', INVITE);
}

/** "Avslå" with the reason (mailed to the applicant). → the application */
export async function denyApplication(shopId, applicationId, reason) {
  const text = String(reason ?? '').trim();
  if (text === '' || text.length > 500) throw new PageError('Ange en orsak (högst 500 tecken).');
  return run(() => api.denyApplication(applicationId, text, opts(shopId)), 'Kunde inte avslå ansökan.');
}

// ── "Bjud in affiliate" (AdminAffiliateCreate) ──────────────────────────────

/** → { affiliateId, notice } */
export async function inviteAffiliate(shopId, form) {
  const parsed = inviteBodyOf(form);
  if (parsed.error) throw new PageError(parsed.error);
  return run(async () => {
    const result = await api.inviteAffiliate(parsed.body, opts(shopId));
    return { affiliateId: result.affiliate?.affiliateId ?? null, notice: admissionNotice(result, parsed.body.email) };
  }, 'Kunde inte bjuda in affiliaten.', INVITE);
}

// ── one affiliate (AdminAffiliateEdit, AdminAffiliatePayout) ────────────────

/** The server's AdminAffiliateDetail, or null (gone, or another shop's). */
export async function loadAffiliate(shopId, affiliateId) {
  return run(() => api.getAffiliate(affiliateId, opts(shopId)), 'Kunde inte hämta affiliaten.');
}

export async function loadAffiliateOrders(shopId, affiliateId, cursor = null) {
  return run(() => api.listAffiliateOrders(affiliateId, { cursor, limit: PAGE, ...opts(shopId) }), 'Kunde inte hämta beställningarna.');
}

export async function loadAffiliateLedger(shopId, affiliateId, cursor = null) {
  return run(() => api.listLedger(affiliateId, { cursor, limit: PAGE, ...opts(shopId) }), 'Kunde inte hämta reskontran.');
}

export async function loadAffiliatePayouts(shopId, affiliateId, cursor = null) {
  return run(() => api.listPayouts(affiliateId, { cursor, limit: PAGE, ...opts(shopId) }), 'Kunde inte hämta utbetalningarna.');
}

/** Saves what the form changed. → the affiliate (unchanged when nothing changed) */
export async function saveAffiliate(shopId, affiliate, form) {
  const parsed = affiliatePatchOf(affiliate, form);
  if (parsed.error) throw new PageError(parsed.error);
  if (parsed.body === null) return affiliate;
  return run(() => api.updateAffiliate(affiliate.affiliateId, parsed.body, opts(shopId)), 'Kunde inte spara ändringarna.');
}

/** Aktiv / Inaktiv / Avstängd. → the affiliate */
export async function setAffiliateStatus(shopId, affiliateId, status) {
  return run(() => api.updateAffiliate(affiliateId, { status }, opts(shopId)), 'Kunde inte ändra status.');
}

/** "Ta bort": inactive, the portal login closed; history and ledger kept. → the affiliate */
export async function removeAffiliate(shopId, affiliateId) {
  return run(() => api.revokeAffiliate(affiliateId, opts(shopId)), 'Kunde inte ta bort affiliaten.');
}

/** "Skicka inbjudan igen". → { notice } (null: sent) */
export async function resendInvite(shopId, affiliate) {
  return run(async () => {
    const result = await api.resendAffiliateInvite(affiliate.affiliateId, opts(shopId));
    return { notice: result.mailConfigured === false ? mailNotSentMessage(affiliate.email || 'Affiliaten') : null };
  }, 'Kunde inte skicka inbjudan.', INVITE);
}

/** "Lägg till justering". → the ledger entry */
export async function addAdjustment(shopId, affiliateId, form) {
  const parsed = adjustmentBodyOf(form);
  if (parsed.error) throw new PageError(parsed.error);
  return run(() => api.addAdjustment(affiliateId, parsed.body, opts(shopId)), 'Kunde inte lägga till justeringen.');
}

// ── payouts (AdminAffiliatePayout) ──────────────────────────────────────────

/**
 * "Registrera utbetalning": the invoice PDF (optional) is uploaded first as a
 * private document of the shop, then the payout is recorded as requested and
 * paid at once. `payableMinor` is what the server last said (it decides again).
 */
export async function recordPayout(shopId, affiliateId, form, payableMinor) {
  const parsed = recordPayoutBodyOf(form, payableMinor);
  if (parsed.error) throw new PageError(parsed.error);
  const problem = invoiceFileProblem(form.invoiceFile);
  if (problem) throw new PageError(problem);
  return run(async () => {
    const body = { ...parsed.body };
    if (form.invoiceFile) {
      const { objectId } = await uploadObject(form.invoiceFile, { kind: 'document', contentType: 'application/pdf', shopId });
      body.invoiceObjectId = objectId;
    }
    try {
      return await api.recordPayout(affiliateId, body, opts(shopId));
    } catch (error) {
      // A refused record names no payout, so its uploaded invoice is loose and
      // not frozen yet: remove it, or every retry would leave one more active document.
      if (body.invoiceObjectId) await deleteObject(body.invoiceObjectId, { shopId }).catch(() => {});
      throw error;
    }
  }, 'Kunde inte registrera utbetalningen.');
}

/** "Markera som betald" (an open request). → the payout */
export async function markPayoutPaid(shopId, payoutId, form) {
  const reference = oneLine(form?.reference ?? '');
  const notes = oneLine(form?.notes ?? '');
  if (reference.length > 100 || notes.length > 1000) throw new PageError('Referensen eller anteckningen är för lång.');
  return run(() => api.markPayoutPaid(payoutId, { reference, notes }, opts(shopId)), 'Kunde inte markera utbetalningen som betald.');
}

/** "Avvisa" an open request, with the reason mailed to the affiliate. → the payout */
export async function voidPayout(shopId, payoutId, reason) {
  // The reason's textarea may hold line breaks; the server takes one line.
  const text = oneLine(reason ?? '');
  if (text === '' || text.length > 500) throw new PageError('Ange en orsak (högst 500 tecken).');
  return run(() => api.voidPayout(payoutId, text, opts(shopId)), 'Kunde inte avvisa begäran.');
}

/** The payout's invoice PDF, downloaded (a private object of the shop). */
export async function downloadInvoice(shopId, payout) {
  if (!payout?.invoiceObjectId) throw new PageError('Utbetalningen har ingen faktura.');
  const name = `faktura-${String(payout.invoiceNumber || payout.payoutId).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
  return run(() => api.downloadInvoice(payout.invoiceObjectId, name, { shopId }), 'Kunde inte hämta fakturan.');
}

// ── analytics (AdminAffiliateAnalytics) ─────────────────────────────────────

/** The server's analytics for the last `days` days. */
export async function loadAnalytics(shopId, days) {
  return run(() => api.getAnalytics({ since: sinceForDays(days), ...opts(shopId) }), 'Kunde inte hämta statistiken.');
}
