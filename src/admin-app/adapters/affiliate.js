// The affiliate pages' shapes on the API (CP13 A2). Pure, tested under Node
// (affiliate.test.mjs). The pages hold the API's own shapes (minor units,
// basis points, ISO times; CP13_A1_REPORT.md §4.3); what is bridged here is
// the other direction: a form a person filled in → a request body, plus the
// order views' `affiliate` member and the analytics `since`. The layout
// helpers both builds' pages use (click series, the balance of the
// affiliate's own currency, the conversion rate, the edit form) live in
// src/pages/admin/affiliateView.js and are re-exported here. No commission,
// balance or payable amount is derived anywhere: they are the server's.

import { kronorToMinor } from './money.js';
import { SOCIALS, editFormOf } from '../../pages/admin/affiliateView.js';

// The layout helpers both builds' pages use live with the pages' words.
export { balanceOf, clickSeries, conversionRate, editFormOf, kronorText, utcDayOf } from '../../pages/admin/affiliateView.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE = /^[A-Z0-9-]{3,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A text the server takes as ONE line (affiliates.ts parseText refuses every
 * control character, line breaks included): a textarea's line breaks become
 * single spaces, trimmed.
 */
export const oneLine = (value) => trimmed(value).replace(/\s*[\r\n]+\s*/g, ' ');

/** The analytics route's `since` for a period of `days` ending now (the instant, as the server's own 30-day default). */
export const sinceForDays = (days, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();

/** The admin order views' `affiliate` member (CP13_A1_REPORT.md §4.4), or null. */
export function orderAffiliateOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string') return null;
  return {
    // Not in the contract's member yet (CP13_A2_REPORT.md "Reviewer wiring"): passed on when the server adds it.
    ...(typeof raw.affiliateId === 'string' && raw.affiliateId !== '' ? { affiliateId: raw.affiliateId } : {}),
    code: raw.code,
    attribution: raw.attribution === 'link' || raw.attribution === 'code' ? raw.attribution : null,
    affiliateCommissionMinor: Number.isSafeInteger(raw.affiliateCommissionMinor) ? raw.affiliateCommissionMinor : 0,
    ledgerState: typeof raw.ledgerState === 'string' ? raw.ledgerState : 'none',
    selfReferral: raw.selfReferral === true,
  };
}

// ── forms → bodies ──────────────────────────────────────────────────────────

/** A whole percent 0–100 typed as text, or null. */
export function percentOf(text) {
  const value = trimmed(String(text ?? ''));
  if (!/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n <= 100 ? n : null;
}

/** A vanity code as the server stores it (trim, upper case), '' for none, or null when it cannot be one. */
export function codeOf(text) {
  const code = trimmed(text).toUpperCase();
  if (code === '') return '';
  return CODE.test(code) ? code : null;
}

const fail = (message) => ({ error: message });

function rates(form) {
  const commissionPercent = percentOf(form.commissionPercent);
  const discountPercent = percentOf(form.discountPercent);
  if (commissionPercent === null) return fail('Provisionen ska vara ett heltal mellan 0 och 100 %.');
  if (discountPercent === null) return fail('Kundrabatten ska vara ett heltal mellan 0 och 100 %.');
  return { commissionPercent, discountPercent };
}

const CODE_RULE = 'Koden får bara innehålla A–Z, 0–9 och bindestreck, 3–20 tecken.';

/** "Godkänn och bjud in": `{ code?, commissionPercent, discountPercent }` or `{ error }`. */
export function approveBodyOf(form) {
  const code = codeOf(form.code);
  if (code === null) return fail(CODE_RULE);
  const r = rates(form);
  if (r.error) return r;
  return { body: { ...(code ? { code } : {}), ...r } };
}

/** "Bjud in": `{ name, email, code?, commissionPercent, discountPercent, preferredLang }` or `{ error }`. */
export function inviteBodyOf(form) {
  const name = trimmed(form.name);
  const email = trimmed(form.email).toLowerCase();
  if (name === '' || name.length > 100) return fail('Ange affiliatens namn (högst 100 tecken).');
  if (!EMAIL.test(email)) return fail('Ange en giltig e-postadress.');
  const approved = approveBodyOf(form);
  if (approved.error) return approved;
  const preferredLang = form.preferredLang === 'en' ? 'en' : 'sv';
  return { body: { name, email, ...approved.body, preferredLang } };
}

/**
 * The PATCH body of what the form CHANGED against the affiliate as it was
 * read (nothing else is sent), `{ body: null }` when nothing changed, or
 * `{ error }`.
 */
export function affiliatePatchOf(affiliate, form) {
  const before = editFormOf(affiliate);
  const body = {};
  const name = trimmed(form.name);
  if (name === '' || name.length > 100) return fail('Namnet får inte vara tomt (högst 100 tecken).');
  if (name !== before.name) body.name = name;
  for (const key of ['phone', 'addressLine1', 'addressLine2', 'postalCode', 'city']) {
    const value = trimmed(form[key]);
    if (value !== trimmed(before[key])) body[key] = value === '' ? null : value;
  }
  if (form.country !== before.country) {
    if (!/^[A-Za-z]{2}$/.test(form.country ?? '')) return fail('Välj ett land.');
    body.country = form.country.toUpperCase();
  }
  const code = codeOf(form.code);
  if (code === null || code === '') return fail(CODE_RULE);
  if (code !== before.code) body.code = code;
  const r = rates(form);
  if (r.error) return r;
  if (String(r.commissionPercent) !== before.commissionPercent) body.commissionPercent = r.commissionPercent;
  if (String(r.discountPercent) !== before.discountPercent) body.discountPercent = r.discountPercent;
  if ((form.promotionMethod || '') !== before.promotionMethod) body.promotionMethod = form.promotionMethod || null;
  if (form.preferredLang !== before.preferredLang) body.preferredLang = form.preferredLang === 'en' ? 'en' : 'sv';
  const socials = {};
  let socialsChanged = false;
  for (const { key } of SOCIALS) {
    const value = trimmed(form.socials?.[key]);
    if (value.length > 300) return fail('En länk får vara högst 300 tecken.');
    if (value !== '') socials[key] = value;
    if (value !== before.socials[key]) socialsChanged = true;
  }
  if (socialsChanged) body.socials = socials;
  return { body: Object.keys(body).length === 0 ? null : body };
}

/** "Lägg till justering": kronor with a sign ("−50", "25,50") and a reason → the body, or `{ error }`. */
export function adjustmentBodyOf(form) {
  const text = trimmed(form.amount).replace('−', '-').replace(/^\+/, '');
  const amountMinor = kronorToMinor(text);
  if (amountMinor === null || amountMinor === 0) return fail('Ange ett belopp i kronor, till exempel 50 eller -50.');
  if (Math.abs(amountMinor) > 100_000_000) return fail('Beloppet är för stort.');
  const reason = trimmed(form.reason);
  if (reason === '' || reason.length > 500) return fail('Ange en orsak (högst 500 tecken).');
  return { body: { amountMinor, reason } };
}

/**
 * "Registrera utbetalning": the amount in kronor (at most what is payable, as
 * the server last said it; the server decides again) → the body without the
 * invoice object, or `{ error }`.
 */
export function recordPayoutBodyOf(form, payableMinor) {
  const amountMinor = kronorToMinor(trimmed(form.amount));
  if (amountMinor === null || amountMinor <= 0) return fail('Ange ett belopp större än 0 kr.');
  if (Number.isSafeInteger(payableMinor) && amountMinor > payableMinor) return fail('Beloppet är större än det som kan betalas ut.');
  const body = { amountMinor };
  for (const [key, max] of [['invoiceNumber', 50], ['reference', 100], ['notes', 1000]]) {
    const value = oneLine(form[key]);
    if (value.length > max) return fail(`Fältet är för långt (högst ${max} tecken).`);
    if (value !== '') body[key] = value;
  }
  return { body };
}

/** An invoice file the server will take: a PDF of at most 10 MB. Null when fine, else why not. */
export function invoiceFileProblem(file) {
  if (!file) return null;
  if (file.type !== 'application/pdf') return 'Fakturan ska vara en PDF-fil.';
  if (file.size > 10 * 1024 * 1024) return 'Fakturan får vara högst 10 MB.';
  return null;
}
