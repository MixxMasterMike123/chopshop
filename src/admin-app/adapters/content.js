// The catalogue's content shapes, bridged (CP5 brief FG). PURE: no React, no
// fetch, no browser API; tested under Node (content.test.mjs).
//
// The pages (AdminCollections, AdminCollectionEdit, AdminMenu, AdminPages,
// AdminPageEdit, AdminStorefront) read the Firebase documents they were
// written for. The API answers collections, pages and the store identity in
// its own shapes (cloudflare/src/catalog/collections.ts, content/pages.ts,
// platform/tenant-config.ts). This module turns one into the other and back,
// so the pages' markup does not change.
//
//   collection   collectionId → id; ruleTag → rule.tag; image.url → imageUrl
//                (the API stores the cover as an OBJECT id: it is kept beside
//                the address, and written only when the address changed)
//   page         pageId → id; title / content / metaTitle / metaDescription
//                are per-language maps both ways; updatedAt answers toDate()
//   identity     logoUrl / faviconUrl / heroImageUrl / gallery[].imageUrl are
//                addresses on the page and object ids (…ObjectId) in the
//                identity; the page's address ⇄ object id table is the data
//                module's (replacements/adminStorefrontData.js)

import { toTimestamp } from '../../api/admin/time.js';

/** content/pages.ts PAGE_SLUG_PATTERN. */
export const PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** content/pages.ts LANGUAGE_TAG_PATTERN. */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const TITLE_MAX = 300;
const COLLECTION_TITLE_MAX = 200;
const COLLECTION_DESCRIPTION_MAX = 5000;
/** The empty text a page's content is stored as (the route refuses a blank one). */
export const EMPTY_CONTENT = '<p></p>';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// ── collections ─────────────────────────────────────────────────────────────

/** A list row of the collections page (the list carries a member COUNT, not the ids). */
export function collectionRowFromApi(c) {
  if (!c || typeof c.collectionId !== 'string') return null;
  return {
    id: c.collectionId,
    handle: c.handle,
    title: c.title,
    type: c.type,
    rule: { tag: c.ruleTag ?? '' },
    published: c.published === true,
    featured: c.featured === true,
    sortOrder: Number.isFinite(c.sortOrder) ? c.sortOrder : undefined,
    imageUrl: c.image?.url ?? '',
    productCount: Number.isFinite(c.productCount) ? c.productCount : 0,
  };
}

/** The edit form's document (GET /v1/admin/collections/:id → the form's fields). */
export function collectionFormFromApi(c) {
  if (!c || typeof c.collectionId !== 'string') return null;
  const productIds = Array.isArray(c.productIds) ? [...c.productIds] : [];
  const imageUrl = c.image?.url ?? '';
  return {
    title: c.title ?? '',
    handle: c.handle ?? '',
    description: c.description ?? '',
    imageUrl,
    type: c.type === 'smart' ? 'smart' : 'manual',
    productIds,
    rule: { tag: c.ruleTag ?? '' },
    published: c.published === true,
    featured: c.featured === true,
    sortOrder: Number.isFinite(c.sortOrder) ? c.sortOrder : undefined,
    // Carried by the form so that the save knows what was loaded.
    imageObjectId: c.imageObjectId ?? null,
    savedImageUrl: imageUrl,
    savedProductIds: [...productIds],
    savedType: c.type === 'smart' ? 'smart' : 'manual',
  };
}

/** What the page's own checks do not cover: the API's lengths. A message, or null. */
export function collectionLimitProblem(data) {
  if (data.title.length > COLLECTION_TITLE_MAX) return `Titeln får vara högst ${COLLECTION_TITLE_MAX} tecken.`;
  if ((data.description || '').length > COLLECTION_DESCRIPTION_MAX) return `Beskrivningen får vara högst ${COLLECTION_DESCRIPTION_MAX} tecken.`;
  if (data.type === 'smart' && data.rule?.tag && data.rule.tag.length > 50) return 'Taggen är för lång.';
  return null;
}

/**
 * The fields of POST / PATCH from the page's `data` object. `imageObjectId`
 * is passed when it is to be written (undefined = leave the cover alone).
 * A collection is created UNPUBLISHED when `forCreate` (see saveCollection).
 */
export function collectionBody(data, { imageObjectId, forCreate = false } = {}) {
  const body = {
    title: data.title,
    handle: data.handle,
    description: data.description || null,
    type: data.type,
    // A manual collection must carry no tag; a smart one needs one.
    ruleTag: data.type === 'smart' ? data.rule.tag : null,
    published: forCreate ? false : data.published === true,
    featured: data.featured === true,
  };
  if (Number.isFinite(data.sortOrder)) body.sortOrder = data.sortOrder;
  if (imageObjectId !== undefined) body.imageObjectId = imageObjectId;
  return body;
}

/** The ids of the picker's list: whether the member list differs from the loaded one. */
export function membersChanged(now, saved) {
  if (!Array.isArray(now) || !Array.isArray(saved)) return true;
  return now.length !== saved.length || now.some((id, i) => id !== saved[i]);
}

/** A picker product: the page reads name, sku, tags, the image address and the category. */
export function pickerProductFromApi(item, tags = []) {
  if (!item || typeof item.productId !== 'string') return null;
  return {
    id: item.productId,
    name: item.name,
    sku: item.sku,
    category: item.category ?? '',
    tags,
    imageUrl: item.image?.url ?? '',
    status: item.status,
  };
}

/** The sorted, de-duplicated tags of the picker's products. */
export function tagsOf(products) {
  const tags = new Set();
  for (const p of products) for (const t of p.tags ?? []) if (typeof t === 'string' && t.trim()) tags.add(t.trim());
  return [...tags].sort((a, b) => a.localeCompare(b, 'sv'));
}

/** The sorted, de-duplicated categories of a product list. */
export function categoriesOf(products) {
  const cats = new Set();
  for (const p of products) {
    const cat = typeof p.category === 'string' ? p.category.trim() : '';
    if (cat) cats.add(cat);
  }
  return [...cats].sort((a, b) => a.localeCompare(b, 'sv'));
}

const COLLECTION_REFUSALS = {
  handle_taken: (data) => `En annan samling använder redan slug "${data?.handle ?? ''}". Välj en unik slug.`,
  image_not_referencable: () => 'Bilden kan inte användas som omslag. Ladda upp den igen.',
  product_not_found: () => 'En vald produkt finns inte längre i butiken. Ta bort den ur listan och spara igen.',
  collection_not_manual: () => 'Bara en manuell samling har en produktlista.',
  conflict: () => 'Samlingen ändrades av någon annan just nu. Ladda om sidan och försök igen.',
  external_ref_taken: () => 'Samlingen krockar med en annan samling. Ladda om sidan och försök igen.',
  payload_too_large: () => 'Samlingen är för stor.',
};

/** A seller-facing sentence for an API refusal of a collection write, or null. */
export function collectionRefusal(error, data) {
  const make = COLLECTION_REFUSALS[error?.code];
  if (make) return make(data);
  if (error?.status === 400 && error?.code === 'invalid_request') return 'Samlingen innehåller något som inte är tillåtet. Kontrollera titel, slug och tagg.';
  return null;
}

// ── pages ───────────────────────────────────────────────────────────────────

/** A per-language map from what the page holds: a string (Swedish) or a map; empty values dropped. */
export function languageMap(value) {
  if (typeof value === 'string') return value.trim() === '' ? {} : { 'sv-SE': value };
  if (!isObject(value)) return {};
  const map = {};
  for (const [lang, text] of Object.entries(value)) {
    if (LANGUAGE_TAG.test(lang) && typeof text === 'string' && text.trim() !== '') map[lang] = text;
  }
  return map;
}

/** A page of the list or the edit form, from the API's page (summary or full). */
export function pageDocFromApi(p) {
  if (!p || typeof p.pageId !== 'string') return null;
  return {
    id: p.pageId,
    slug: p.slug,
    status: p.status,
    kind: p.kind,
    title: isObject(p.title) ? { ...p.title } : {},
    content: isObject(p.content) ? { ...p.content } : '',
    metaTitle: isObject(p.metaTitle) ? { ...p.metaTitle } : '',
    metaDescription: isObject(p.metaDescription) ? { ...p.metaDescription } : '',
    attachments: [],
    createdAt: toTimestamp(p.createdAt),
    updatedAt: toTimestamp(p.updatedAt),
  };
}

/** The first problem of a page's fields before anything is sent, as a sentence; else null. */
export function pageProblem(formData) {
  const slug = formData.slug;
  if (typeof slug !== 'string' || !PAGE_SLUG_PATTERN.test(slug)) {
    return 'Sluggen får bara innehålla små bokstäver (a–z), siffror och bindestreck, och börja och sluta med en bokstav eller siffra.';
  }
  const title = languageMap(formData.title);
  if (Object.values(title).some((t) => t.length > TITLE_MAX)) return `Titeln får vara högst ${TITLE_MAX} tecken.`;
  return null;
}

/** The body of POST / PATCH of a page. Content that is empty in every language is stored as an empty paragraph. */
export function pageBody(formData, status) {
  const content = languageMap(formData.content);
  const metaTitle = languageMap(formData.metaTitle);
  const metaDescription = languageMap(formData.metaDescription);
  return {
    slug: formData.slug,
    status,
    title: languageMap(formData.title),
    content: Object.keys(content).length > 0 ? content : { 'sv-SE': EMPTY_CONTENT },
    metaTitle: Object.keys(metaTitle).length > 0 ? metaTitle : null,
    metaDescription: Object.keys(metaDescription).length > 0 ? metaDescription : null,
  };
}

const HTML_REASONS = {
  script: 'skript',
  embedded_content: 'inbäddat innehåll (iframe, object, embed)',
  event_attribute: 'händelseattribut som onclick',
  unsafe_address: 'en länk eller bildadress som inte är tillåten (bara http, https, mailto och tel; bilder måste ligga på en webbadress)',
  javascript_url: 'en javascript-länk',
  storage_address: 'en adress till den gamla bildlagringen',
  unsafe_style: 'en stil som inte är tillåten',
  form: 'ett formulär',
  foreign_content: 'SVG eller MathML',
  raw_text_element: 'ett style-, title- eller textarea-element',
  document_element: 'html-, head- eller body-element',
  declaration: 'en deklaration (DOCTYPE, CDATA)',
  processing_instruction: 'en processing instruction',
  entity_reference: 'en teckenreferens som inte är tillåten',
  invalid_character: 'ett tecken som inte är tillåtet',
  malformed: 'felaktig HTML',
  escape: 'ett escape-tecken som inte är tillåtet',
  too_large: 'för stor text',
};

/**
 * The seller-facing sentence for an API refusal of a page write, and where it
 * belongs: { field: 'slug' | 'content' | null, message } or null.
 */
export function pageRefusal(error) {
  switch (error?.code) {
    case 'slug_reserved':
      return { field: 'slug', message: 'Sluggen är reserverad av butiken. Välj en annan.' };
    case 'slug_taken':
      return { field: 'slug', message: 'En annan sida använder redan den sluggen. Välj en unik slug.' };
    case 'content_refused': {
      const reason = error.details?.reason ?? error.reason;
      const language = error.details?.language;
      const what = HTML_REASONS[reason] ?? 'kod som inte är tillåten';
      const where = language && language !== 'sv-SE' ? ` (språk ${language})` : '';
      return { field: 'content', message: `Sidans innehåll innehåller ${what}${where}. Ta bort det och spara igen.` };
    }
    case 'payload_too_large':
      return { field: 'content', message: 'Sidan är för stor.' };
    case 'invalid_request':
      return { field: null, message: 'Sidan innehåller något som inte är tillåtet. Kontrollera titel, slug och texter.' };
    default:
      return null;
  }
}

// ── the menu ────────────────────────────────────────────────────────────────

/** A page title as the menu shows it: Swedish first, else any language. */
export function menuPageTitle(title) {
  if (typeof title === 'string') return title;
  return title?.['sv-SE'] || Object.values(title || {}).find((v) => typeof v === 'string') || '';
}

// ── the storefront identity ─────────────────────────────────────────────────

/** The four branding keys of the identity that name an object. */
export const IMAGE_ID_KEYS = Object.freeze(['logoObjectId', 'heroObjectId', 'faviconObjectId', 'emailLogoObjectId']);
/** Page key ← identity key. */
export const IMAGE_URL_KEYS = Object.freeze({ logoUrl: 'logoObjectId', heroImageUrl: 'heroObjectId', faviconUrl: 'faviconObjectId' });

const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isObjectId = (value) => typeof value === 'string' && OBJECT_ID.test(value);

/**
 * The patch to hand saveShopConfig, from the page's branding patch.
 *   `urls`    the table address → object id of this page (loads and uploads)
 *   `loaded`  { key: { id, resolved, unread } } for each identity image key as
 *             read: `resolved` false = the object no longer answers (removed,
 *             D93), and the PUT would refuse the stored id; `unread` true =
 *             the read failed (a network error, a 500): the page had no
 *             address to show, which is not the seller removing the image
 * The page's addresses leave; an object id goes where the page's address names
 * a known object (an upload replaces even an unread image); an address the
 * page cleared clears the key, unless the image was unread (the page never
 * showed it, so it cannot have removed it: the stored id stays); an id whose
 * object is gone is cleared as well; a key nobody touched is left out (so the
 * stored value stays). Gallery entries carry `imageObjectId`; one whose image
 * was unread keeps the id brandingFromIdentity left on it.
 */
export function brandingPatch(patch, { urls, loaded }) {
  const out = { ...patch };
  for (const urlKey of Object.keys(IMAGE_URL_KEYS)) delete out[urlKey];

  for (const [urlKey, idKey] of Object.entries(IMAGE_URL_KEYS)) {
    const url = patch[urlKey];
    const was = loaded[idKey];
    if (typeof url === 'string' && url !== '' && urls.has(url)) out[idKey] = urls.get(url);
    else if (was?.unread === true) continue; // preview unavailable: the stored id stays
    else if (url === '' && was?.id) out[idKey] = null; // removed on the page
    else if (was && was.resolved === false) out[idKey] = null;
  }
  // A dead reference on a key this page does not manage (the e-mail logo).
  if (loaded.emailLogoObjectId?.resolved === false) out.emailLogoObjectId = null;

  if (Array.isArray(patch.gallery)) {
    out.gallery = patch.gallery.map((item) => {
      const { imageUrl, imageObjectId: unreadId, ...rest } = item || {};
      const id = typeof imageUrl === 'string' ? urls.get(imageUrl) : undefined;
      if (isObjectId(id)) return { ...rest, imageObjectId: id };
      // An image whose preview could not be read, not replaced on the page.
      if (isObjectId(unreadId) && !imageUrl) return { ...rest, imageObjectId: unreadId };
      return rest;
    });
  }
  return out;
}

/**
 * The page's branding source from the stored identity and the addresses of its
 * objects. A gallery entry whose image could not be read (`unread:<id>`) keeps
 * its `imageObjectId` (the page carries an entry's other keys along), so the
 * save keeps it; every other entry trades the id for its address.
 */
export function brandingFromIdentity(identity, addresses) {
  const saved = { ...(isObject(identity) ? identity : {}) };
  for (const [urlKey, idKey] of Object.entries(IMAGE_URL_KEYS)) {
    const url = addresses[idKey];
    if (typeof url === 'string' && url !== '') saved[urlKey] = url;
  }
  if (Array.isArray(saved.gallery)) {
    saved.gallery = saved.gallery.map((item) => {
      if (!isObject(item)) return item;
      const { imageObjectId, ...rest } = item;
      const url = typeof imageObjectId === 'string' ? addresses[`gallery:${imageObjectId}`] : undefined;
      if (url) return { ...rest, imageUrl: url };
      if (typeof imageObjectId === 'string' && addresses[`unread:${imageObjectId}`]) return { ...rest, imageObjectId };
      return rest;
    });
  }
  return saved;
}

/** The refusal of a settings write, as a sentence; null when it is not one of its own. */
export function settingsRefusal(error) {
  if (error?.code === 'unreferencable_images') return 'En av bilderna finns inte längre. Ladda upp den igen och spara.';
  if (error?.code === 'refused_store_identity_keys') return 'Något i butikens uppgifter får inte sparas här.';
  return null;
}

/** The refusal of an image upload, as a sentence; null when it is not one of its own. */
export function uploadRefusal(error) {
  if (error?.code === 'payload_too_large' || error?.status === 413) return 'Bilden är för stor (högst 15 MB, SVG högst 512 KB).';
  if (error?.code === 'invalid_request' && error.reason === 'type_not_as_stated') return 'Filen är inte den bildtyp den utger sig för att vara.';
  if (error?.code === 'invalid_request' && typeof error.reason === 'string' && error.reason.startsWith('svg_')) return 'SVG-filen innehåller något som inte är tillåtet.';
  return null;
}
