// Content pages and posts: an answer of GET /v1/pages or GET /v1/pages/:slug
// (CP4-C, cloudflare/src/content/pages.ts PublicPageSummary /
// PublicPageDetail) → the object the pages read today (a Firestore `pages`
// document). Pure; tested under Node (adapters.test.mjs).
//
// The API answers every text in ONE language already (the requested one,
// else the shop's default), so `title`, `content`, `metaTitle` and
// `metaDescription` are strings; the pages read them through getContentValue,
// which passes a string through. `updatedAt` is an ISO time; the page reads
// it as a Firestore timestamp (`updatedAt.toDate()`), so it is handed on as
// an object with `toDate()`. The content is HTML: DynamicPage cleans it with
// DOMPurify where it renders it. No page carries attachments (D94).

const text = (value) => (typeof value === 'string' ? value : '');

function timestamp(iso) {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return null;
  return { toDate: () => new Date(iso) };
}

/** One published page or post (GET /v1/pages/:slug). */
export function toPagePage(api) {
  if (!api || typeof api !== 'object' || typeof api.slug !== 'string') return null;
  return {
    id: api.slug,
    slug: api.slug,
    kind: api.kind,
    status: 'published',
    title: text(api.title),
    content: text(api.content),
    summary: text(api.summary),
    metaTitle: text(api.metaTitle),
    metaDescription: text(api.metaDescription),
    author: typeof api.author === 'string' && api.author ? api.author : null,
    image: api.image && typeof api.image.url === 'string' ? api.image.url : null,
    updatedAt: timestamp(api.updatedAt),
  };
}

/**
 * The footer's list: every published page of the list answers, as
 * `{ slug, title }` (what ShopFooter keeps of a page document).
 */
export function toFooterPages(list) {
  return (Array.isArray(list) ? list : [])
    .map((page) => ({ slug: page?.slug, title: text(page?.title) }))
    .filter((page) => typeof page.slug === 'string' && page.slug && page.title);
}
