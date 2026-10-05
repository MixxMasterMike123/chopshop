// src/utils/legalAcceptance.js for the admin build (alias list,
// vite.admin.config.js): the same names (CP5 brief FE).
//
//   renderAcceptedLegalTexts  unchanged: the three pages from the templates
//                             (legalPageRenderer.js, DOMPurify in the browser),
//                             a custom key's own HTML instead of its template
//   recordLegalAcceptance     POST /v1/admin/legal/accept-pages (a legal act:
//                             the seller adopts the texts as his own terms). The
//                             texts sent are `texts` when the page passes the
//                             strings it showed, else rendered here as the older
//                             build did; `templateVersion` is the template's,
//                             `pod` the shop's entitlement, `custom` the
//                             per-page map of which texts are the seller's own.
//                             The server records who and when; it refuses an
//                             acting-as platform user (only the seller signs).
//   hasAcceptedCurrentPlatformTerms, recordPlatformTermsAcceptance
//                             the platform terms are unit FB's (the gate reads
//                             GET /v1/admin/legal/status, the acceptance is
//                             src/api/admin/legal.js); no page of this build
//                             reaches these two through this module.

import { LEGAL_PAGES, LEGAL_PAGE_KEYS, LEGAL_TEMPLATE_VERSION } from '../../config/legalTemplates.js';
import { renderLegalPage } from '../../utils/legalPageRenderer.js';
import { acceptLegalPages } from '../../api/admin/legal.js';
import { AdminApiError, notAvailable } from '../../api/admin/client.js';
import { LEGAL_KEYS, acceptanceFromView, identityGapLabels, pageNamesOf, refusedTextKeys } from '../adapters/settings.js';

export function renderAcceptedLegalTexts(identity = {}, options = {}, customHtml = {}) {
  const out = {};
  for (const slug of Object.keys(LEGAL_PAGES)) {
    const key = LEGAL_PAGE_KEYS[slug];
    const custom = customHtml && typeof customHtml[key] === 'string' && customHtml[key].trim();
    out[key] = custom ? customHtml[key] : (renderLegalPage(slug, identity, options)?.html || '');
  }
  return out;
}

/** An Error the page shows as it is (toast), with the pages it concerns. */
function legalError(message, refusedKeys = []) {
  const error = new Error(message);
  error.refusedKeys = refusedKeys;
  return error;
}

function errorOfAnswer(error) {
  if (!(error instanceof AdminApiError)) return error;
  if (error.status === 400 && error.code === 'invalid_request') {
    // The Worker names the page(s) whose HTML it refuses (`details.pages`);
    // a 400 that names none is a body that was not the route's shape.
    const keys = refusedTextKeys(error.details);
    return keys.length > 0
      ? legalError(
        `Texten för ${pageNamesOf(keys)} innehåller HTML som inte kan publiceras (till exempel skript, formulär, inbäddat innehåll eller data:-adresser). Ändra texten och godkänn igen.`,
        keys,
      )
      : legalError('Villkoren kunde inte godkännas: förfrågan avvisades.');
  }
  if (error.status === 409 && error.code === 'legal_identity_incomplete') {
    // CP9-OB: the stored identity lacks what the pages print (legal-identity.ts).
    const missing = identityGapLabels(error.details?.missing);
    return legalError(
      missing.length > 0
        ? `Villkoren kan inte godkännas ännu: ${missing.join(', ')}. Fyll i uppgifterna, spara och godkänn igen.`
        : 'Villkoren kan inte godkännas ännu: butikens uppgifter är inte kompletta.',
    );
  }
  if (error.status === 413) return legalError('Texterna är för långa för att kunna sparas.');
  if (error.status === 429) {
    const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 3600) / 60));
    return legalError(`För många godkännanden den senaste timmen. Försök igen om ${minutes} min.`);
  }
  if (error.status === 404) return legalError('Endast butikens egen administratör kan godkänna villkoren.');
  return error;
}

/**
 * Records the seller's adoption of the shop's legal pages. Resolves the
 * pointer the page keeps ({ uid, email, acceptedAt, templateVersion,
 * acceptanceId }: the signer is the signed-in user who just adopted).
 *
 * @param {object} p
 * @param {string} p.shopId
 * @param {{uid:string,email:string}} p.user  the signed-in user
 * @param {object} p.identity     the identity the templates are rendered from
 * @param {boolean} p.pod         the shop's print-on-demand entitlement
 * @param {Record<string,boolean>} [p.custom]      storeIdentity.legal.custom
 * @param {Record<string,string>} [p.customHtml]   the seller's own HTML per custom key
 * @param {Record<string,string>} [p.texts]        the three texts AS SHOWN; sent unchanged
 */
export async function recordLegalAcceptance({ shopId, user, identity, pod, custom = {}, customHtml = {}, texts }) {
  if (!shopId) throw new Error('recordLegalAcceptance: shopId required');
  if (!user?.uid) throw new Error('recordLegalAcceptance: signed-in user required');

  // A page is the seller's own exactly when its text is the seller's HTML.
  const customPages = {};
  for (const key of LEGAL_KEYS) {
    customPages[key] = custom?.[key] === true && typeof customHtml?.[key] === 'string' && customHtml[key].trim() !== '';
  }
  const sent = texts ?? renderAcceptedLegalTexts(identity, { pod: pod === true }, customHtml);
  for (const key of LEGAL_KEYS) {
    if (customPages[key] && sent[key] !== customHtml[key]) {
      throw new Error(`recordLegalAcceptance: the text of ${key} is not the seller's own text`);
    }
  }

  let acceptance;
  try {
    acceptance = await acceptLegalPages(
      { templateVersion: LEGAL_TEMPLATE_VERSION, texts: sent, pod: pod === true, customPages },
      { shopId },
    );
  } catch (error) {
    throw errorOfAnswer(error);
  }
  const pointer = acceptanceFromView(acceptance);
  if (!pointer) throw new Error('Svaret saknar godkännandet.');
  return { uid: String(user.uid), email: String(user.email || ''), ...pointer };
}

export function hasAcceptedCurrentPlatformTerms() {
  throw notAvailable('Plattformsvillkoren (läses av villkorsspärren)');
}

export async function recordPlatformTermsAcceptance() {
  throw notAvailable('Plattformsvillkoren (godkänns på sidan Plattformsvillkor)');
}
