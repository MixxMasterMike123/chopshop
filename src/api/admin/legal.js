// The shop admin's legal routes (cloudflare/src/routes/legal-admin.ts).
// Unit FB owns the platform-TERMS calls of this file; unit FE the legal-PAGES
// calls below. Each unit adds to its own section only.

import { adminRequest } from './client.js';
import { acceptPagesBody } from '../../admin-app/adapters/settings.js';

// ── the platform's terms: status, text, the seller's acceptance (CP5-FB) ───
//
//   GET  /v1/admin/legal/status        { currentVersion, accepted, acceptedAt,
//        acceptedVersion, inGrace, graceDeadline, readiness }   (an acting-as
//        platform user may read it)
//   GET  /v1/admin/legal/terms         { version, sha256, publishedAt,
//        textArchived, text }   the CURRENT version; text = JSON
//        { version, terms, dpa } (markdown templates) or null; all null when
//        no version is published
//   POST /v1/admin/legal/accept-terms  { termsVersion }
//        201 recorded · 200 already accepted → { acceptance: { termsVersion, acceptedAt } }
//        409 terms_version_not_current { currentVersion }
//        404 an acting-as platform user: only the shop's own admin signs.

/** The terms status of the shop (and the readiness booleans beside it). */
export async function getPlatformTermsStatus({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', '/v1/admin/legal/status', shopId ? { shopId, signal } : { signal });
  return data ?? null;
}

/** The current terms version and its archived text. */
export async function getPlatformTermsText({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', '/v1/admin/legal/terms', shopId ? { shopId, signal } : { signal });
  return data ?? null;
}

/** The seller accepts `termsVersion` (the version shown). Resolves `{ termsVersion, acceptedAt }`. */
export async function acceptPlatformTermsVersion(termsVersion, { shopId } = {}) {
  const json = { termsVersion };
  const { data } = await adminRequest('POST', '/v1/admin/legal/accept-terms', shopId ? { shopId, json } : { json });
  return data?.acceptance ?? null;
}

// ── the legal pages: readiness and the seller's adoption (CP5-FE) ──────────
//
//   GET  /v1/admin/legal/status        { currentVersion, accepted, acceptedAt,
//        acceptedVersion, inGrace, graceDeadline,
//        readiness: { returnAddress, vatAnswered, legalPagesAccepted, ready } }
//   GET  /v1/admin/legal/pages         { acceptance: { acceptanceId, acceptedAt,
//        custom, customPages, pageSha256, pod, source, templateVersion,
//        textsSha256, version } | null }
//   POST /v1/admin/legal/accept-pages  { templateVersion, texts: { kopvillkor,
//        angerratt, integritetspolicy }, pod, custom }   (exactly these keys)
//        201 { acceptance: { acceptanceId, acceptedAt, templateVersion,
//              textsSha256, pod, custom, customPages } }
//        400 invalid_request (also: a text whose HTML the route refuses)
//        413 payload_too_large · 429 rate_limited (Retry-After)
//        404 an acting-as platform user: only the shop's own admin adopts.

const options = (shopId, extra = {}) => (shopId ? { ...extra, shopId } : extra);

/** The legal status and the checkout readiness of the shop. */
export async function getLegalPagesStatus({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', '/v1/admin/legal/status', options(shopId, { signal }));
  return data ?? null;
}

/** The shop's latest legal-pages adoption, or null. */
export async function getLegalPagesAcceptance({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', '/v1/admin/legal/pages', options(shopId, { signal }));
  return data?.acceptance ?? null;
}

/**
 * Adopts the three texts as the seller's own terms. `texts` must be the very
 * strings the seller was shown; `customPages` the per-page map of which are
 * the seller's own (adapters/settings.js customPagesOf). Throws before
 * sending when the body would not be the route's shape.
 */
export async function acceptLegalPages({ templateVersion, texts, pod, customPages }, { shopId } = {}) {
  const json = acceptPagesBody({ templateVersion, texts, pod, customPages });
  const { data } = await adminRequest('POST', '/v1/admin/legal/accept-pages', options(shopId, { json }));
  return data?.acceptance ?? null;
}
