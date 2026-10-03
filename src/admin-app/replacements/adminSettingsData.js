// src/pages/admin/adminSettingsData.js for the admin build (alias list,
// vite.admin.config.js): the same names, fed by the API (CP5 brief FE).
//
// D79: a legal page is not a content page. The seller's own text ("Redigera
// texten själv") is kept in the store identity, `legal.customTexts[key]`,
// beside the per-page flags `legal.custom[key]`, edited on the settings page
// itself, and adopted by POST /v1/admin/legal/accept-pages with the texts the
// page shows (src/admin-app/replacements/legalAcceptance.js). Nothing writes
// `pages`.

import { getLegalPagesAcceptance, getLegalPagesStatus } from '../../api/admin/legal.js';
import { LEGAL_TEMPLATE_VERSION } from '../../config/legalTemplates.js';
import {
  LEGAL_KEYS,
  acceptanceFromView,
  readinessFromStatus,
  textsChangedSince,
} from '../adapters/settings.js';

/** true: the seller's own text is edited on the settings page and kept in the identity. */
export const LEGAL_TEXTS_IN_SETTINGS = true;

/**
 * D99: the shop's name, support address and VAT rate are the platform's
 * (PATCH /v1/platform/tenants/:id); the currency too (a refused identity key,
 * tenant-config.ts). Shown read-only; saveShopConfig never sends them.
 */
export const PLATFORM_OWNED_FIELDS = ['shopName', 'supportEmail', 'currency', 'vatRate'];

/**
 * The server's view of the shop's legal state: `readiness` (the checkout's
 * gate, adapters readinessFromStatus), `acceptance` (the pointer the page
 * reads, or null) and `adopted` (the API's view of the latest adoption).
 */
export async function loadLegalState(shopId) {
  const opts = shopId ? { shopId } : {};
  const [status, view] = await Promise.all([getLegalPagesStatus(opts), getLegalPagesAcceptance(opts)]);
  return { readiness: readinessFromStatus(status), acceptance: acceptanceFromView(view), adopted: view };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether what the page would adopt now differs from the latest adoption in
 * a way the seller must re-adopt (the older build's needsReacceptance): a
 * newer template version, a page switched between template and own text, or
 * an own text that is not the one adopted (by its SHA-256, so no clock is
 * compared). null when there is nothing adopted.
 */
export async function legalTextsChanged(legalState, texts, customPages) {
  const adopted = legalState?.adopted;
  if (!adopted) return null;
  const shas = {};
  for (const key of LEGAL_KEYS) {
    if (customPages?.[key] === true && typeof texts?.[key] === 'string') shas[key] = await sha256Hex(texts[key]);
  }
  return textsChangedSince(adopted, { templateVersion: LEGAL_TEMPLATE_VERSION, customPages, shas });
}

/**
 * "Redigera texten själv": the key becomes the seller's own text, starting
 * from the text it had (a draft kept from an earlier take-over is never
 * overwritten) or else from the template as rendered now. Nothing is sent
 * here; the page saves the patch through saveShopConfig.
 */
export async function takeOverLegalText({ key, rendered, currentText }) {
  const text = typeof currentText === 'string' && currentText.trim() !== '' ? currentText : rendered.html;
  return {
    navigateTo: null,
    legalPatch: { custom: { [key]: true }, customTexts: { [key]: text }, customUpdatedAt: new Date().toISOString() },
  };
}

/** The editor is on the settings page: nothing to open elsewhere. */
export async function openLegalText() {
  return { navigateTo: null };
}

/** "Återgå till plattformens mall": the flag is cleared; the draft stays in the identity. */
export async function revertLegalText({ key }) {
  return { custom: { [key]: false }, customUpdatedAt: new Date().toISOString() };
}

/**
 * The seller's own texts to adopt: exactly the strings the page shows for
 * the custom keys (`shownCustomHtml`). Never "unpublished": a draft is shown
 * on the page, and what is shown is what is adopted.
 */
export async function collectCustomHtml({ custom, shownCustomHtml }) {
  const customHtml = {};
  for (const key of LEGAL_KEYS) {
    if (custom?.[key] === true && typeof shownCustomHtml?.[key] === 'string') customHtml[key] = shownCustomHtml[key];
  }
  return { customHtml, unpublished: [] };
}
