// Legal pages: an answer of GET /v1/legal/:key (CP4-C,
// cloudflare/src/routes/public-legal.ts) → what DynamicPage renders today.
// Pure; tested under Node (adapters.test.mjs). The two functions that touch
// markup are handed in by the page: `sanitize` (DOMPurify) and `render` (the
// legal-page markdown renderer, src/utils/legalPageRenderer.js).
//
// A SHOP's legal page is the HTML the seller ADOPTED, as adopted (D79). The
// page renders the object `{ title, html, ready, blockers, custom }`; on
// Cloudflare:
//   html     the adopted text, cleaned by `sanitize` (it is shown with
//            dangerouslySetInnerHTML; today the page generated it itself and
//            cleaned it in the same step, legalPageRenderer.js)
//   ready    true: a page the API answers is one the seller adopted (the
//            readiness of the shop's legal data is the server's gate, and the
//            search engines' robots answer is D's /v1/seo)
//   custom   {}: a copy-on-write text is part of the adopted snapshot, and no
//            content page can take a legal address (C, reserved slugs), so
//            there is never a seller page to append or to swap in
//
// The PLATFORM's terms arrive as the archived text of the current version,
// in the format of the source's templates: JSON `{ version, terms, dpa }`,
// each a markdown template (CP3-E §2). They are rendered as the page renders
// them today (platformTermsRenderer.js): `{{last_updated}}` is the version,
// the rest of the markdown pipeline is the shop pages'.

/** The shop legal page as DynamicPage's `legal` state. */
export function toPageLegal(api, { sanitize } = {}) {
  if (!api || typeof api !== 'object' || typeof api.html !== 'string' || typeof sanitize !== 'function') {
    return null;
  }
  return {
    title: typeof api.title === 'string' ? api.title : '',
    html: sanitize(api.html),
    ready: true,
    blockers: [],
    custom: {},
    adoptedAt: typeof api.adoptedAt === 'string' ? api.adoptedAt : null,
  };
}

/**
 * The platform's terms as renderPlatformTerms() returned them:
 * `{ version, terms: { title, html }, dpa: { title, html } }`, or null when
 * the archived text is not in the templates' format.
 */
export function toPagePlatformTerms(api, { render, dpaTitle } = {}) {
  if (!api || typeof api !== 'object' || typeof api.text !== 'string' || typeof render !== 'function') {
    return null;
  }
  let archived;
  try {
    archived = JSON.parse(api.text);
  } catch {
    return null;
  }
  if (!archived || typeof archived.terms !== 'string' || typeof archived.dpa !== 'string') return null;

  const version = typeof api.version === 'string' && api.version ? api.version : String(archived.version ?? '');
  const dated = (template) => template.replace(/\{\{last_updated\}\}/g, version);
  return {
    version,
    terms: { title: typeof api.title === 'string' ? api.title : '', html: render(dated(archived.terms)) },
    dpa: { title: typeof dpaTitle === 'string' ? dpaTitle : '', html: render(dated(archived.dpa)) },
  };
}
