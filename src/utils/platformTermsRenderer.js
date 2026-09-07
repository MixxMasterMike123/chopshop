/**
 * Renders the platform's own B2B terms (Plattformsvillkor + the
 * personuppgiftsbiträdesavtal annex) to sanitized HTML.
 *
 * These are the PLATFORM's documents toward the SELLER — not per-shop text, so
 * no seller identity is merged in. Only the platform merge fields
 * ({{platform_legal_name}}, {{platform_org_suffix}}) and {{last_updated}}
 * apply. Reuses the legal-page renderer's pipeline (same markdown + DOMPurify)
 * so the two document families look identical wherever they're shown.
 *
 * {{last_updated}} is the TERMS VERSION DATE, not today: the seller accepted a
 * specific dated version (shops/{id}.platformTerms.version) and the public
 * page must show that same date.
 */

import {
  PLATFORM_TERMS_TEMPLATE,
  PLATFORM_DPA_TEMPLATE,
  PLATFORM_TERMS_TITLE,
  PLATFORM_DPA_TITLE,
  PLATFORM_TERMS_VERSION,
} from '../config/platformTerms';
import { renderLegalTemplate } from './legalPageRenderer';

function renderDoc(template, title) {
  const dated = String(template).replace(/\{\{last_updated\}\}/g, PLATFORM_TERMS_VERSION);
  return { title, html: renderLegalTemplate(dated, {}, {}) };
}

// { terms: {title, html}, dpa: {title, html}, version }
export function renderPlatformTerms() {
  return {
    version: PLATFORM_TERMS_VERSION,
    terms: renderDoc(PLATFORM_TERMS_TEMPLATE, PLATFORM_TERMS_TITLE),
    dpa: renderDoc(PLATFORM_DPA_TEMPLATE, PLATFORM_DPA_TITLE),
  };
}
