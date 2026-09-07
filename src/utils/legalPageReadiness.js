/**
 * Legal-page readiness gate.
 *
 * The auto-generated legal pages may render for PREVIEW at any time, but they
 * must NOT be treated as live/published on a real shop until two conditions hold
 * (per the implementation brief + docs/legal-template-files/README.md).
 * While any hard condition fails the CHECKOUT is closed too (server backstop in
 * createPaymentIntent.ts):
 *
 *   (a) {{return_address}} is collected — the köpvillkor §8 + ångerrätt page
 *       both require a real return address; without it the pages are wrong.
 *   (b) the seller-side VAT branch is resolvable — `vatRegistered` must be set
 *       (true/false), so the page's VAT wording matches what checkout charges.
 *       An unset flag means we can't promise the page is truthful.
 *   (c) the SELLER has explicitly accepted the pages as their own terms
 *       (storeIdentity.legal.acceptance) — the platform-liability guard: the
 *       text is a template the seller reviewed and adopted, not the platform's.
 *
 * Until ALL THREE hold, the seller (AdminSettings) and the operator (PlatformShops)
 * see a clear "legal pages incomplete" state.
 *
 * `sellerType` is also needed to pick the company/individual identity branch; a
 * shop with no sellerType still renders (defaults to the individual branch) but
 * is flagged as incomplete so identity disclosure is correct before going live.
 */

import { LEGAL_TEMPLATE_VERSION } from '../config/legalTemplates';

// True when the seller has recorded an explicit acceptance of the legal pages
// (storeIdentity.legal.acceptance, written by legalAcceptance.js). The
// acceptance is what makes the generated text the SELLER's own terms rather
// than something the platform put on their site — see docs/legal-template-files
// /README.md "Seller ownership". Shape: { uid, email, acceptedAt, templateVersion }.
export function hasLegalAcceptance(identity = {}) {
  const a = identity?.legal?.acceptance;
  return Boolean(a && typeof a === 'object' && String(a.acceptedAt || '').trim());
}

// True when an acceptance exists but covers an OLDER template version than the
// one currently shipped. SOFT signal only (never a checkout blocker — a template
// bump must not close every live shop's checkout): admin shows a re-accept
// notice, platform shows a badge.
export function needsLegalReacceptance(identity = {}) {
  if (!hasLegalAcceptance(identity)) return false;
  const a = identity.legal.acceptance;
  if (a.templateVersion !== LEGAL_TEMPLATE_VERSION) return true;
  // Seller-owned text (copy-on-write) edited AFTER the last acceptance: the
  // CMS editor stamps storeIdentity.legal.customUpdatedAt on every save of a
  // legal-slug page (and on toggling custom on/off). ISO strings compare
  // lexicographically.
  const edited = String(identity.legal.customUpdatedAt || '');
  return Boolean(edited && edited > String(a.acceptedAt || ''));
}

// One readiness check. `identity` is the shop's storeIdentity object.
// Returns { ready, missing, blockers, needsReacceptance }.
// `blockers` are the HARD gates (a + b + c). `missing` includes softer identity gaps.
//
// ⚠️ MIRRORED SERVER-SIDE in functions/src/payment/createPaymentIntent.ts
// (legalCheckoutBlockReason) — the checkout refuses to create a PaymentIntent
// while any HARD blocker holds. Keep the two in sync.
export function getLegalReadiness(identity = {}) {
  const blockers = [];

  // (a) Return address — hard gate.
  if (!String(identity.returnAddress || '').trim()) {
    blockers.push({ key: 'returnAddress', label: 'Returadress saknas' });
  }

  // (b) VAT branch must be resolvable — hard gate. Must be an explicit boolean.
  if (typeof identity.vatRegistered !== 'boolean') {
    blockers.push({ key: 'vatRegistered', label: 'Momsregistrering ej angiven (krävs för att momstexten ska matcha kassan)' });
  }

  // (c) Seller acceptance — hard gate. Without it the platform, not the seller,
  // is the author of the shop's consumer terms.
  if (!hasLegalAcceptance(identity)) {
    blockers.push({ key: 'acceptance', label: 'Villkoren är inte godkända av butiksägaren' });
  }

  // Softer identity gaps — not hard blockers, but the pages render incomplete.
  const missing = [];
  if (!String(identity.legalName || '').trim()) missing.push('legalName');
  if (!String(identity.address || '').trim()) missing.push('address');
  // Empty OR an obvious placeholder (hello@example.com etc.) — a placeholder
  // support email printed in live legal pages is as wrong as a missing one.
  const supportEmail = String(identity.supportEmail || '').trim();
  if (!supportEmail || /@example\.(com|org|net|se)$/i.test(supportEmail)) missing.push('supportEmail');
  if (!String(identity.sellerType || '').trim()) missing.push('sellerType');
  // Company sellers must disclose org number.
  if (identity.sellerType === 'company' && !String(identity.orgNumber || '').trim()) {
    missing.push('orgNumber');
  }
  // VAT-registered sellers must disclose VAT number.
  if (identity.vatRegistered === true && !String(identity.vatNumber || '').trim()) {
    missing.push('vatNumber');
  }

  return {
    ready: blockers.length === 0,
    blockers,
    missing,
    needsReacceptance: needsLegalReacceptance(identity),
  };
}

// Convenience: just the boolean "can these pages go live?".
export const isLegalReady = (identity = {}) => getLegalReadiness(identity).ready;
