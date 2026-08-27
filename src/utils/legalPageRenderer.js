/**
 * Legal page renderer — turns a markdown legal TEMPLATE (src/config/legalTemplates.js)
 * into sanitized HTML for ONE shop, by:
 *   1. evaluating the [[IF company]] / [[IF vat_registered]] / [[ELSE]] / [[END]]
 *      conditionals against the shop's seller data (supports nesting),
 *   2. filling the {{merge_fields}} from storeIdentity + platform config,
 *   3. rendering the resulting markdown to HTML (markdown-it) and sanitizing it
 *      (DOMPurify), matching how DynamicPage renders CMS HTML.
 *
 * 3-WAY note: every {{merge_field}} here is sourced from an admin-controllable
 * value (storeIdentity, edited in AdminSettings) or the platform constant — so
 * the storefront RENDERS only what admin/platform can CONTROL. See the readiness
 * gate (legalPageReadiness.js) for which of those fields are REQUIRED before a
 * live shop's pages are correct.
 */

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { PLATFORM } from '../config/platform.js';
import { LEGAL_PAGES } from '../config/legalTemplates.js';

// linkify on so bare URLs like www.arn.se become links; html off — the template
// is trusted markdown, not user HTML, and DOMPurify sanitizes the output anyway.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Resolve the boolean flags that drive the conditionals from a shop's identity.
//  • company:        sellerType === 'company'
//  • vat_registered: explicit vatRegistered flag (NOT inferred from sellerType —
//    a company can be under threshold, an individual over it; see the spec).
//  • pod:            the shop has the print-on-demand add-on ON. Passed in by the
//    caller from shops/{id}.features.pod (the SAME entitlement useShopFeatures()
//    reads — never a second source of truth), because it lives on the shop doc's
//    `features` map, not in storeIdentity. Drives the [[IF pod]] branches that
//    keep print vocabulary ("Print on Demand", "sprucket tryck",
//    "tryckeri/produktionspartner") out of a things-shop's public legal pages.
//    Defaults FALSE — an unknown/unloaded shop gets the neutral wording, matching
//    `pod`'s opt-in polarity in config/addons.js.
// `options || {}` (not just a default param) — a default only covers `undefined`,
// and a caller threading a possibly-null features object would otherwise throw
// while rendering a mandatory legal page.
const resolveFlags = (identity = {}, options) => ({
  company: identity.sellerType === 'company',
  vat_registered: identity.vatRegistered === true,
  pod: (options || {}).pod === true,
});

// Build the merge-field value map. Missing optional fields render as ''. Required
// fields that are missing render as a visible placeholder so a half-configured
// preview is obviously incomplete (the readiness gate blocks going live anyway).
const buildValues = (identity = {}) => ({
  shop_name: identity.shopName || '',
  seller_legal_name: identity.legalName || '',
  seller_address: stripHtml(identity.address) || '',
  contact_email: identity.supportEmail || '',
  org_number: identity.orgNumber || '',
  vat_number: identity.vatNumber || '',
  return_address: stripHtml(identity.returnAddress) || '⚠️ Returadress ej angiven',
  platform_legal_name: PLATFORM.legalName || '',
  // Whole parenthetical or nothing — never a broken "(org.nr )" while the
  // platform company is unregistered (VITE_PLATFORM_ORG_NUMBER unset).
  platform_org_suffix: PLATFORM.orgNumber ? ` (org.nr ${PLATFORM.orgNumber})` : '',
  // Optional phone bullet appended to the identity list; whole line or nothing.
  seller_phone_item: String(identity.phone || '').trim()
    ? `\n- Telefon: ${String(identity.phone).trim()}`
    : '',
  last_updated: formatToday(),
});

// The address field allows simple HTML (<br>) in the footer; in a markdown legal
// page we want plain text with newlines, so convert <br> → newline and drop tags.
function stripHtml(value) {
  if (!value || typeof value !== 'string') return value || '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// Render-time date, Swedish locale (YYYY-MM-DD style the templates expect).
function formatToday() {
  try {
    return new Date().toLocaleDateString('sv-SE');
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Evaluate [[IF flag]] … [[ELSE]] … [[END]] blocks against `flags`.
 * Handles arbitrary nesting by repeatedly resolving the INNERMOST block (one
 * with no nested [[IF]] between its own [[IF]] and [[END]]) until none remain.
 * Unknown flags evaluate falsey (renders the [[ELSE]] branch, or nothing).
 */
function evaluateConditionals(text, flags) {
  // Innermost block: [[IF x]] body-without-nested-IF [[END]], optional [[ELSE]].
  const innermost = /\[\[IF\s+(\w+)\]\]((?:(?!\[\[IF\s)[\s\S])*?)\[\[END\]\]/;
  let out = text;
  let guard = 0;
  while (innermost.test(out)) {
    if (++guard > 1000) break; // safety: never loop forever on malformed input
    out = out.replace(innermost, (_match, flag, body) => {
      // Split the matched body on the FIRST [[ELSE]] (if any) at this level.
      const elseIdx = body.indexOf('[[ELSE]]');
      let truthy = body;
      let falsy = '';
      if (elseIdx !== -1) {
        truthy = body.slice(0, elseIdx);
        falsy = body.slice(elseIdx + '[[ELSE]]'.length);
      }
      return flags[flag] ? truthy : falsy;
    });
  }
  return out;
}

// Replace {{merge_field}} tokens. Unknown tokens are left as-is so a typo is
// visible rather than silently blanked.
function fillMergeFields(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

// Collapse blank lines left behind when a conditional branch was dropped, so the
// markdown doesn't render stray empty paragraphs.
function tidyBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render a legal template (markdown string) for one shop → sanitized HTML.
 * @param {string} template - one of the *_TEMPLATE strings.
 * @param {object} identity - the shop's storeIdentity object.
 * @param {{ pod?: boolean }} [options] - entitlement flags that don't live on
 *   storeIdentity. `pod` = shops/{id}.features.pod (default false = neutral,
 *   non-print wording).
 * @returns {string} sanitized HTML.
 */
export function renderLegalTemplate(template, identity = {}, options = {}) {
  const flags = resolveFlags(identity, options);
  const values = buildValues(identity);
  let text = evaluateConditionals(template, flags);
  text = fillMergeFields(text, values);
  text = tidyBlankLines(text);
  const html = md.render(text);
  return DOMPurify.sanitize(html);
}

/**
 * Render a legal page by slug for one shop. Returns null if the slug isn't a
 * known legal page.
 * @param {string} slug
 * @param {object} identity - the shop's storeIdentity object.
 * @param {{ pod?: boolean }} [options] - see renderLegalTemplate.
 * @returns {{ title: string, pageType: string, html: string } | null}
 */
export function renderLegalPage(slug, identity = {}, options = {}) {
  const page = LEGAL_PAGES[slug];
  if (!page) return null;
  return {
    title: page.title,
    pageType: page.pageType,
    html: renderLegalTemplate(page.template, identity, options),
  };
}
