// src/components/admin/platformTermsData.js for the admin build (alias list,
// vite.admin.config.js): the platform's terms from the API's legal routes
// (cloudflare/src/routes/legal-admin.ts), in the shape PlatformTermsGate and
// AdminPlatformTerms read (adapters/platformTerms.js).
//
// The acceptance is the server's record: who, when, which version (the
// seller signs; an acting-as platform user is refused by the server, and the
// gate is never shown to one).

import { renderLegalTemplate } from '../../utils/legalPageRenderer';
import { PLATFORM_DPA_TITLE, PLATFORM_TERMS_TITLE } from '../../config/platformTerms';
import {
  acceptPlatformTermsVersion,
  getPlatformTermsStatus,
  getPlatformTermsText,
} from '../../api/admin/legal.js';
import { acceptErrorMessage, platformTermsStateOf } from '../adapters/platformTerms.js';

// The text shown is always the server's archived text of the current
// version: the templates are not part of this build (a seller signs what the
// server holds). Before the read, the two documents are empty.
const EMPTY = Object.freeze({
  version: '',
  terms: Object.freeze({ title: PLATFORM_TERMS_TITLE, html: '' }),
  dpa: Object.freeze({ title: PLATFORM_DPA_TITLE, html: '' }),
});
const render = (markdown) => renderLegalTemplate(markdown, {}, {});

export function initialPlatformTerms() {
  return EMPTY;
}

// The text of a version never changes once published (its sha256 is fixed):
// kept per version for the page's life.
const textByVersion = new Map();

async function termsText(shopId, version) {
  if (version && textByVersion.has(version)) return textByVersion.get(version);
  try {
    const termsApi = await getPlatformTermsText({ shopId });
    if (termsApi?.version && typeof termsApi.text === 'string') textByVersion.set(termsApi.version, termsApi);
    return termsApi;
  } catch (error) {
    // A text that cannot be read is a text that cannot be shown (the gate
    // then lets the seller through, as on a failed read); the status decides.
    console.warn('Platform terms: the text could not be read:', error?.message);
    return null;
  }
}

/**
 * `withText`: the terms page shows the text whatever the status; the gate
 * needs it only when the current version is not accepted.
 */
export async function loadPlatformTerms(shopId, { withText = false } = {}) {
  const status = await getPlatformTermsStatus({ shopId });
  const needsText = withText || status?.accepted !== true;
  const termsApi = needsText ? await termsText(shopId, status?.currentVersion) : null;
  return platformTermsStateOf(status, termsApi, {
    render,
    termsTitle: PLATFORM_TERMS_TITLE,
    dpaTitle: PLATFORM_DPA_TITLE,
  });
}

export async function acceptPlatformTerms({ shopId, version }) {
  try {
    await acceptPlatformTermsVersion(version, { shopId });
  } catch (error) {
    throw new Error(acceptErrorMessage(error));
  }
}
