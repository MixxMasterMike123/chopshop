/**
 * Seller acceptance of legal text — the platform-liability guard.
 *
 * The platform GENERATES the three consumer-facing legal pages and the seller
 * must explicitly ACCEPT them as their own terms before the shop's checkout
 * opens (legalPageReadiness.js hard gate (c); server backstop in
 * createPaymentIntent.ts). Same model as Shopify ("you're responsible for
 * following your published policies", generated text = the merchant's own
 * Materials) and WordPress/WooCommerce (suggested text the owner adopts).
 *
 * Two things are written per acceptance:
 *   1. EVIDENCE — shops/{shopId}/legalAcceptances/{autoId}: who, when, which
 *      template version, and a SNAPSHOT of the exact rendered text accepted
 *      (append-only by rules: no update/delete). This is what proves, later,
 *      what the seller saw and agreed to.
 *   2. POINTER — shops/{shopId}.storeIdentity.legal.acceptance: the compact
 *      summary the readiness gate reads ({ uid, email, acceptedAt,
 *      templateVersion, acceptanceId }). Written with merge so nothing else in
 *      storeIdentity is touched.
 *
 * Platform terms (the B2B agreement between platform and seller) use the same
 * evidence collection with type 'platformTerms' and a pointer at
 * shops/{shopId}.platformTerms (NOT under storeIdentity — it's not storefront
 * config, and the storefront must never depend on it).
 */

import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  LEGAL_PAGES,
  LEGAL_PAGE_KEYS,
  LEGAL_TEMPLATE_VERSION,
} from '../config/legalTemplates';
import { renderLegalPage } from './legalPageRenderer';
import { PLATFORM_TERMS_VERSION } from '../config/platformTerms';
import { renderPlatformTerms } from './platformTermsRenderer';

// Compact user identity for the records. `user` is a Firebase Auth user.
function actor(user) {
  return {
    uid: String(user?.uid || ''),
    email: String(user?.email || ''),
  };
}

/**
 * Render the three legal pages exactly as the storefront shows them, keyed by
 * LEGAL_PAGE_KEYS. Seller-owned (copy-on-write) pages come from `customHtml`
 * (the CMS page content the seller edited) instead of the template.
 *
 * @param {object} identity - storeIdentity
 * @param {{ pod?: boolean }} options - entitlement flags (pod → print wording)
 * @param {Record<string,string>} [customHtml] - key → seller's HTML, when custom
 * @returns {Record<string,string>} key → html
 */
export function renderAcceptedLegalTexts(identity = {}, options = {}, customHtml = {}) {
  const out = {};
  for (const slug of Object.keys(LEGAL_PAGES)) {
    const key = LEGAL_PAGE_KEYS[slug];
    const custom = customHtml && typeof customHtml[key] === 'string' && customHtml[key].trim();
    out[key] = custom ? customHtml[key] : (renderLegalPage(slug, identity, options)?.html || '');
  }
  return out;
}

/**
 * Record the seller's acceptance of the shop's legal pages.
 * Writes the evidence doc first (so a pointer never exists without evidence),
 * then the pointer. Returns the pointer object that was written, so the caller
 * can merge it into local form state without a re-read.
 *
 * @param {object} p
 * @param {string} p.shopId
 * @param {object} p.user - Firebase Auth user (uid + email)
 * @param {object} p.identity - the shop's storeIdentity as currently SAVED
 * @param {boolean} p.pod - shops/{id}.features.pod entitlement
 * @param {Record<string,boolean>} [p.custom] - storeIdentity.legal.custom map
 * @param {Record<string,string>} [p.customHtml] - seller HTML for custom keys
 */
export async function recordLegalAcceptance({ shopId, user, identity, pod, custom = {}, customHtml = {} }) {
  if (!shopId) throw new Error('recordLegalAcceptance: shopId required');
  if (!user?.uid) throw new Error('recordLegalAcceptance: signed-in user required');

  const who = actor(user);
  const acceptedAtIso = new Date().toISOString();
  const texts = renderAcceptedLegalTexts(identity, { pod: pod === true }, customHtml);

  const evidence = await addDoc(collection(db, 'shops', shopId, 'legalAcceptances'), {
    type: 'legalPages',
    shopId,
    ...who,
    acceptedAt: serverTimestamp(),
    acceptedAtIso,
    templateVersion: LEGAL_TEMPLATE_VERSION,
    pod: pod === true,
    custom: { ...custom },
    texts,
    userAgent: typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '',
  });

  const pointer = {
    ...who,
    acceptedAt: acceptedAtIso,
    templateVersion: LEGAL_TEMPLATE_VERSION,
    acceptanceId: evidence.id,
  };

  await setDoc(
    doc(db, 'shops', shopId),
    { storeIdentity: { legal: { acceptance: pointer } }, updatedAt: acceptedAtIso },
    { merge: true }
  );

  return pointer;
}

// ── Platform terms (B2B: platform ↔ seller) ─────────────────────────────────

// True when the shop has accepted the CURRENT platform terms version. Read by
// the admin gate (PlatformTermsGate) — a seller must accept before using admin.
export function hasAcceptedCurrentPlatformTerms(shop = {}) {
  const t = shop?.platformTerms;
  return Boolean(t && t.version === PLATFORM_TERMS_VERSION && String(t.acceptedAt || '').trim());
}

/**
 * Record the seller's acceptance of the platform terms + PUB-avtal.
 * Same evidence-then-pointer order as recordLegalAcceptance.
 */
export async function recordPlatformTermsAcceptance({ shopId, user }) {
  if (!shopId) throw new Error('recordPlatformTermsAcceptance: shopId required');
  if (!user?.uid) throw new Error('recordPlatformTermsAcceptance: signed-in user required');

  const who = actor(user);
  const acceptedAtIso = new Date().toISOString();
  const rendered = renderPlatformTerms();

  const evidence = await addDoc(collection(db, 'shops', shopId, 'legalAcceptances'), {
    type: 'platformTerms',
    shopId,
    ...who,
    acceptedAt: serverTimestamp(),
    acceptedAtIso,
    version: PLATFORM_TERMS_VERSION,
    texts: { terms: rendered.terms.html, dpa: rendered.dpa.html },
    userAgent: typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '',
  });

  const pointer = {
    ...who,
    acceptedAt: acceptedAtIso,
    version: PLATFORM_TERMS_VERSION,
    acceptanceId: evidence.id,
  };

  await setDoc(doc(db, 'shops', shopId), { platformTerms: pointer, updatedAt: acceptedAtIso }, { merge: true });
  return pointer;
}
