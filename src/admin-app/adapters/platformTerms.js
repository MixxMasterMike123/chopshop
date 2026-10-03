// The platform's terms: the answers of GET /v1/admin/legal/status and
// GET /v1/admin/legal/terms (cloudflare/src/routes/legal-admin.ts, CP3-E) →
// what PlatformTermsGate and AdminPlatformTerms read
// (components/admin/platformTermsData.js):
//
//   { rendered, accepted, acceptance }
//     rendered    { version, terms: {title, html}, dpa: {title, html} } of the
//                 CURRENT version, or null when this client cannot show that
//                 version's text
//     accepted    the shop has accepted the current version (or there is
//                 nothing it could accept: no version published, or no text
//                 to show for it; the gate then lets the seller through, as
//                 it does on a failed read)
//     acceptance  { acceptedAt, version } of the latest acceptance, or null
//
// The text is the archived one (JSON { version, terms, dpa }, the templates'
// markdown), rendered as the older admin rendered the bundled templates
// (src/storefront/adapters/legal.js toPagePlatformTerms). Without an archived
// text nothing is shown and nothing can be signed: the seller is not asked to
// accept a text this client cannot show. Pure: `render` (markdown → HTML) is
// handed in.

import { toPagePlatformTerms } from '../../storefront/adapters/legal.js';
import { signerLabelOf } from './signer.js';

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** The terms of the current version to show, or null. */
export function renderedTermsOf(termsApi, { render, termsTitle, dpaTitle } = {}) {
  const version = text(termsApi?.version);
  if (!version) return null;
  const archived = toPagePlatformTerms(termsApi, { render, dpaTitle });
  return archived
    ? { ...archived, version, terms: { ...archived.terms, title: termsTitle ?? archived.terms.title } }
    : null;
}

/**
 * The latest acceptance the status names: `latestAcceptance` (version, time and
 * signer, also of an OLDER version than the current one); `email` is the
 * signer's label (signer.js), where the page prints "Godkända av …". Without
 * `latestAcceptance` (an older answer), the status's own fields.
 */
export function acceptanceOf(status) {
  if (!status || typeof status !== 'object') return null;
  const latest = status.latestAcceptance;
  if (latest && typeof latest === 'object' && text(latest.acceptedAt) && text(latest.version)) {
    const signer = signerLabelOf(latest.acceptedBy);
    return { acceptedAt: latest.acceptedAt, version: latest.version, ...(signer ? { email: signer } : {}) };
  }
  if (text(status.acceptedAt) && text(status.currentVersion)) {
    return { acceptedAt: status.acceptedAt, version: status.currentVersion };
  }
  if (text(status.acceptedVersion)) return { acceptedAt: null, version: status.acceptedVersion };
  return null;
}

export function platformTermsStateOf(status, termsApi, options = {}) {
  const rendered = renderedTermsOf(termsApi, options);
  const current = text(status?.currentVersion);
  const accepted = status?.accepted === true && Boolean(current);
  return {
    rendered,
    // Nothing published, or a version whose text cannot be shown: nothing to sign here.
    accepted: accepted || !current || !rendered || rendered.version !== current,
    acceptance: acceptanceOf(status),
  };
}

/** The message the gate shows when the acceptance is refused (`error` an AdminApiError). */
export function acceptErrorMessage(error) {
  if (error?.code === 'terms_version_not_current') {
    return 'Villkoren har uppdaterats medan sidan var öppen. Ladda om sidan och läs den nya versionen.';
  }
  if (error?.code === 'network_error') return 'Servern kunde inte nås. Försök igen.';
  if (error?.code === 'rate_limited') return 'För många försök. Vänta en stund och försök igen.';
  return 'Kunde inte spara godkännandet. Försök igen.';
}
