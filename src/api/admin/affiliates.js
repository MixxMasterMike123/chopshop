// The shop's affiliate program (CP13 A2; the Worker:
// cloudflare/src/routes/affiliate-admin.ts, contract CP13_A1_REPORT.md §4.3).
//
// [gated] = the opaque 404 while the shop's `affiliate` add-on is OFF. The
// ungated routes stay open so liabilities can still be settled (design §4.5).
//
//   GET   /v1/admin/affiliates?status&cursor&limit             [gated] { affiliates, nextCursor }
//   POST  /v1/admin/affiliates  ("Bjud in")                     [gated] 201 { affiliate, invited, inviteError?, mailConfigured }
//   GET   /v1/admin/affiliates/applications?status&cursor&limit [gated] { applications, nextCursor }
//   GET   /v1/admin/affiliates/applications/:id                [gated] { application }
//   POST  /v1/admin/affiliates/applications/:id/approve        [gated] 201 { affiliate, application, invited, inviteError?, mailConfigured }
//   POST  /v1/admin/affiliates/applications/:id/deny           [gated] { application }
//   GET   /v1/admin/affiliates/analytics?since                 [gated] { analytics }
//   GET   /v1/admin/affiliates/:id                                     { affiliate }
//   PATCH /v1/admin/affiliates/:id                                     { affiliate }
//   POST  /v1/admin/affiliates/:id/invite   (re-send)          [gated] 202 { mailConfigured }
//   POST  /v1/admin/affiliates/:id/revoke   ("Ta bort")                { affiliate }
//   POST  /v1/admin/affiliates/:id/adjustments                         201 { entry }
//   GET   /v1/admin/affiliates/:id/ledger?cursor&limit                 { entries, nextCursor }
//   GET   /v1/admin/affiliates/:id/orders?cursor&limit                 { orders, nextCursor }
//   GET   /v1/admin/affiliates/:id/payouts?cursor&limit                { balances, payouts, nextCursor }
//   POST  /v1/admin/affiliates/:id/payouts  (record a payment)         201 { payout }
//   POST  /v1/admin/affiliates/payouts/:payoutId/paid                  { payout }
//   POST  /v1/admin/affiliates/payouts/:payoutId/void                  { payout }
//
// Rates go IN as whole percent (commissionPercent, discountPercent) and come
// OUT as basis points; money is öre both ways. Every request carries X-Shop-Id
// (adminRequest). A refusal rejects with the AdminApiError (`status`, `code`,
// `reason`); affiliateRefusalMessage() says it in Swedish.

import { AdminApiError, adminRequest, getRequestShopId, segment, withQuery } from './client.js';

export const AFFILIATES_PATH = '/v1/admin/affiliates';

const affiliatePath = (affiliateId, rest = '') => `${AFFILIATES_PATH}/${segment(affiliateId)}${rest}`;
const applicationPath = (applicationId, rest = '') => `${AFFILIATES_PATH}/applications/${segment(applicationId)}${rest}`;
const payoutPath = (payoutId, rest) => `${AFFILIATES_PATH}/payouts/${segment(payoutId)}${rest}`;

const list = (value) => (Array.isArray(value) ? value : []);
const cursorOf = (data) => (typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null);
const mailConfiguredOf = (data) => (typeof data?.mailConfigured === 'boolean' ? data.mailConfigured : null);

/** An admission's answer (approve, "Bjud in"). */
function admission(data) {
  return {
    affiliate: data?.affiliate ?? null,
    application: data?.application ?? null,
    invited: data?.invited === true,
    inviteError: typeof data?.inviteError === 'string' ? data.inviteError : null,
    mailConfigured: mailConfiguredOf(data),
  };
}

// ── the program (gated) ─────────────────────────────────────────────────────

/** One page of the shop's affiliates, newest first. → { affiliates, nextCursor } */
export async function listAffiliates({ status, cursor, limit, shopId, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery(AFFILIATES_PATH, { status, cursor, limit }), { shopId, signal });
  return { affiliates: list(data?.affiliates), nextCursor: cursorOf(data) };
}

/** "Bjud in affiliate": `{ name, email, code?, commissionPercent?, discountPercent?, preferredLang? }`. */
export async function inviteAffiliate(body, { shopId } = {}) {
  const { data } = await adminRequest('POST', AFFILIATES_PATH, { shopId, json: body });
  return admission(data);
}

/** One page of applications, pending first, then newest. → { applications, nextCursor } */
export async function listApplications({ status, cursor, limit, shopId, signal } = {}) {
  const path = withQuery(`${AFFILIATES_PATH}/applications`, { status, cursor, limit });
  const { data } = await adminRequest('GET', path, { shopId, signal });
  return { applications: list(data?.applications), nextCursor: cursorOf(data) };
}

/** One application, or null on the opaque 404 (gone, another shop's, or the add-on is OFF). */
export async function getApplication(applicationId, { shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', applicationPath(applicationId), { shopId, signal });
    return data?.application ?? null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

/** Approve: `{ code?, commissionPercent?, discountPercent? }` (the server's defaults 15 / 10). */
export async function approveApplication(applicationId, body, { shopId } = {}) {
  const { data } = await adminRequest('POST', applicationPath(applicationId, '/approve'), { shopId, json: body ?? {} });
  return admission(data);
}

/** Deny with a reason (1–500, mailed to the applicant). → the application */
export async function denyApplication(applicationId, reason, { shopId } = {}) {
  const { data } = await adminRequest('POST', applicationPath(applicationId, '/deny'), { shopId, json: { reason } });
  return data?.application ?? null;
}

/** `since`: an ISO date (`YYYY-MM-DD`) or date-time, at most 400 days back. → the analytics */
export async function getAnalytics({ since, shopId, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery(`${AFFILIATES_PATH}/analytics`, { since }), { shopId, signal });
  return data?.analytics ?? null;
}

/** A new invite link for an affiliate without a password. → { mailConfigured } */
export async function resendAffiliateInvite(affiliateId, { shopId } = {}) {
  const { data } = await adminRequest('POST', affiliatePath(affiliateId, '/invite'), { shopId });
  return { mailConfigured: mailConfiguredOf(data) };
}

// ── one affiliate (open while the add-on is OFF) ────────────────────────────

/** The shop's view of one affiliate, or null on the opaque 404. */
export async function getAffiliate(affiliateId, { shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', affiliatePath(affiliateId), { shopId, signal });
    return data?.affiliate ?? null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

/** Edits any subset of the editable keys (rates in whole percent). → the affiliate */
export async function updateAffiliate(affiliateId, body, { shopId } = {}) {
  const { data } = await adminRequest('PATCH', affiliatePath(affiliateId), { shopId, json: body });
  return data?.affiliate ?? null;
}

/** "Ta bort": inactive and the membership revoked; nothing is deleted. → the affiliate */
export async function revokeAffiliate(affiliateId, { shopId } = {}) {
  const { data } = await adminRequest('POST', affiliatePath(affiliateId, '/revoke'), { shopId });
  return data?.affiliate ?? null;
}

/** "Lägg till justering": `{ amountMinor (≠ 0), reason }`. → the ledger entry */
export async function addAdjustment(affiliateId, { amountMinor, reason }, { shopId } = {}) {
  const { data } = await adminRequest('POST', affiliatePath(affiliateId, '/adjustments'), {
    shopId,
    json: { amountMinor, reason },
  });
  return data?.entry ?? null;
}

/** One page of the ledger, newest first. → { entries, nextCursor } */
export async function listLedger(affiliateId, { cursor, limit, shopId, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery(affiliatePath(affiliateId, '/ledger'), { cursor, limit }), { shopId, signal });
  return { entries: list(data?.entries), nextCursor: cursorOf(data) };
}

/** One page of the shop's orders attributed to the affiliate. → { orders, nextCursor } */
export async function listAffiliateOrders(affiliateId, { cursor, limit, shopId, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery(affiliatePath(affiliateId, '/orders'), { cursor, limit }), { shopId, signal });
  return { orders: list(data?.orders), nextCursor: cursorOf(data) };
}

/** The balances and one page of payouts. → { balances, payouts, nextCursor } */
export async function listPayouts(affiliateId, { cursor, limit, shopId, signal } = {}) {
  const { data } = await adminRequest('GET', withQuery(affiliatePath(affiliateId, '/payouts'), { cursor, limit }), { shopId, signal });
  return { balances: list(data?.balances), payouts: list(data?.payouts), nextCursor: cursorOf(data) };
}

/** Records a payment the shop made: `{ amountMinor, invoiceNumber?, invoiceObjectId?, reference?, notes? }`. */
export async function recordPayout(affiliateId, body, { shopId } = {}) {
  const { data } = await adminRequest('POST', affiliatePath(affiliateId, '/payouts'), { shopId, json: body });
  return data?.payout ?? null;
}

/** An open request → paid, with the shop's evidence `{ reference?, notes? }`. */
export async function markPayoutPaid(payoutId, { reference, notes } = {}, { shopId } = {}) {
  const json = {};
  if (reference) json.reference = reference;
  if (notes) json.notes = notes;
  const { data } = await adminRequest('POST', payoutPath(payoutId, '/paid'), { shopId, json });
  return data?.payout ?? null;
}

/** An open request → void (released by a compensating row), with the reason mailed to the affiliate. */
export async function voidPayout(payoutId, reason, { shopId } = {}) {
  const { data } = await adminRequest('POST', payoutPath(payoutId, '/void'), { shopId, json: { reason } });
  return data?.payout ?? null;
}

/**
 * The invoice PDF of a payout, saved by the browser: the bytes of the shop's
 * private object (GET /v1/admin/objects/:id/content, an attachment). A plain
 * link cannot carry X-Shop-Id, so the bytes are read here and handed over as
 * a blob address. Resolves when the download was started.
 */
export async function downloadInvoice(objectId, fileName, { shopId, fetchImpl = globalThis.fetch } = {}) {
  const shop = shopId ?? getRequestShopId();
  if (typeof shop !== 'string' || shop === '') {
    throw new AdminApiError({ status: 0, code: 'no_shop', message: 'Ingen butik är vald' });
  }
  const response = await fetchImpl(`/_api/v1/admin/objects/${segment(objectId)}/content`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'x-shop-id': shop },
  });
  if (!response.ok) {
    throw new AdminApiError({ status: response.status, code: response.status === 404 ? 'not_found' : 'http_error', message: `HTTP ${response.status}` });
  }
  const address = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement('a');
    link.href = address;
    link.download = fileName || 'faktura.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // The browser has the bytes once the click is handled; the address is freed a moment later.
    setTimeout(() => URL.revokeObjectURL(address), 10_000)?.unref?.();
  }
}

// ── refusals, in Swedish ────────────────────────────────────────────────────

const REFUSALS = {
  code_taken: 'Koden används redan av en annan affiliate eller av en rabattkod i butiken. Välj en annan kod.',
  code_invalid: 'Koden får bara innehålla A–Z, 0–9 och bindestreck, 3–20 tecken.',
  code_reserved: 'Koden är reserverad. Välj en annan kod.',
  not_addable: 'Adressen används redan av ett annat konto på plattformen. Affiliaten behöver en annan e-postadress.',
  already_affiliate: 'Adressen är redan affiliate i den här butiken.',
  already_decided: 'Ansökan är redan behandlad. Ladda om sidan.',
  not_invited: 'Affiliaten har redan valt ett lösenord. Ingen ny inbjudan behövs.',
  not_invitable: 'Affiliaten kan inte bjudas in just nu.',
  payout_open: 'Det finns redan en öppen utbetalningsbegäran. Markera den som betald eller avvisa den först.',
  insufficient_balance: 'Beloppet är större än det som kan betalas ut.',
  invalid_invoice: 'Fakturan kan inte bifogas. Ladda upp PDF-filen igen.',
  payout_not_open: 'Utbetalningen är inte längre öppen. Ladda om sidan.',
  email_unavailable: 'Inbjudan kunde inte köas för utskick. Försök igen om en stund.',
  rate_limited: 'För många försök, vänta en stund.',
  network_error: 'Servern kunde inte nås. Kontrollera anslutningen och försök igen.',
  unauthenticated: 'Sessionen har gått ut. Logga in igen.',
};

const INVITE_RATE_LIMITED = 'För många inbjudningar på kort tid. Vänta en stund och försök igen.';

/**
 * A Swedish sentence for a refusal of these routes (by reason, then code), or
 * null. `{ invite: true }`: the call was an invite ("Bjud in", approve, re-send),
 * whose 429 is the invite buckets'.
 */
export function affiliateRefusalMessage(error, { invite = false } = {}) {
  if (!error || typeof error !== 'object') return null;
  if (invite && error.code === 'rate_limited') return INVITE_RATE_LIMITED;
  const known = REFUSALS[error.reason] ?? REFUSALS[error.code];
  if (known) return known;
  if (error.status === 404) return 'Hittades inte, eller så är affiliateprogrammet avstängt för butiken.';
  if (error.status === 400) return 'Uppgifterna godtogs inte. Kontrollera fälten och försök igen.';
  return null;
}
