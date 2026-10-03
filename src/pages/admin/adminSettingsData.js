// AdminSettings' legal-pages data layer — the OLDER build's implementation
// (Firebase).
//
// The page (AdminSettings.jsx) reaches the seller's own legal texts only
// through this module, so one page serves two builds: the older build
// (vite.config.js) uses this file as it is; the admin build
// (vite.admin.config.js) swaps it, by its alias list, for
// src/admin-app/replacements/adminSettingsData.js (the API). Both files export
// the same names with the same meaning.
//
// Here a seller's own legal text is a CMS `pages` doc on the legal slug (the
// page's former inline code, moved and unchanged); there it is kept in the
// store identity and edited on the settings page itself (D79: legal pages are
// not content pages).

import { addDoc, collection, doc, getDocs, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { withShopId } from '../../config/withShopId';
import { LEGAL_PAGES, LEGAL_PAGE_KEYS } from '../../config/legalTemplates';

/** false: the seller's own text is a CMS page, edited in the page editor. */
export const LEGAL_TEXTS_IN_SETTINGS = false;

/** The identity fields the seller may not edit here: none in this build. */
export const PLATFORM_OWNED_FIELDS = [];

// Read the content of a multilingual-or-plain CMS field. Mirrors
// useContentTranslation().getContentValue / DynamicPage, but standalone: the
// acceptance snapshot must capture the SWEDISH consumer text regardless of
// which admin UI language happens to be active.
const readContentValue = (field) => {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object') {
    if (field['sv-SE']) return field['sv-SE'];
    const first = Object.keys(field)[0];
    if (first) return field[first] || '';
  }
  return '';
};

// Find this shop's CMS page on a given slug, if it exists.
// Nothing enforces slug uniqueness on `pages`, so more than one doc can share
// a slug. Prefer a PUBLISHED one — that is the doc DynamicPage serves — so the
// editor, the acceptance snapshot and the storefront all resolve to the same
// document instead of an arbitrary `docs[0]`.
const findLegalPage = async (shopId, slug, { publishedOnly = false } = {}) => {
  const snap = await getDocs(query(
    collection(db, 'pages'),
    where('shopId', '==', shopId),
    where('slug', '==', slug)
  ));
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const published = docs.find((p) => p.status === 'published');
  if (publishedOnly) return published || null;
  return published || docs[0] || null;
};

/** The server's legal readiness, or null: this build computes it from the form. */
export async function loadLegalState() {
  return null;
}

/** null: this build flags a re-acceptance from the identity (legalPageReadiness.js). */
export async function legalTextsChanged() {
  return null;
}

/**
 * "Redigera texten själv" — copy-on-write. Writes the rendered template into
 * a CMS page on the legal slug (reusing an existing one rather than creating
 * a duplicate). Resolves { navigateTo: the editor of that page, legalPatch:
 * the identity's `legal` patch that flags the key as custom }.
 */
export async function takeOverLegalText({ shopId, slug, key, rendered, uid }) {
  const existing = await findLegalPage(shopId, slug);
  let pageId = existing?.id;
  if (existing) {
    // Reuse the page already on this slug rather than creating a duplicate.
    // Only SEED the template text when that page has no content of its own —
    // a page the seller previously wrote (and reverted to draft, or drafted
    // by hand) must never be overwritten; there is no undo for that.
    const existingHtml = readContentValue(existing.content).trim();
    await updateDoc(doc(db, 'pages', existing.id), {
      ...(existingHtml ? {} : { content: { 'sv-SE': rendered.html } }),
      status: 'published',
      updatedAt: serverTimestamp(),
      updatedBy: uid || '',
    });
  } else {
    const created = await addDoc(collection(db, 'pages'), withShopId({
      title: { 'sv-SE': rendered.title },
      slug,
      content: { 'sv-SE': rendered.html },
      status: 'published',
      metaTitle: '',
      metaDescription: '',
      attachments: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: uid || '',
      updatedBy: uid || '',
    }, shopId));
    pageId = created.id;
  }

  // Narrow patch: only THIS key's flag. The merge write leaves the other
  // two keys' flags untouched (see the page's persistLegal).
  return {
    navigateTo: `/admin/pages/${pageId}`,
    legalPatch: { custom: { [key]: true }, customUpdatedAt: new Date().toISOString() },
  };
}

/** The seller's own page in the CMS editor: { navigateTo }, or null when it is gone. */
export async function openLegalText({ shopId, slug }) {
  const existing = await findLegalPage(shopId, slug);
  return existing ? { navigateTo: `/admin/pages/${existing.id}` } : null;
}

/**
 * "Återgå till plattformens mall" — unpublishes the seller's page (never
 * deletes it, so the text is recoverable) so it stops rendering on the
 * storefront. Resolves the `legal` patch that clears the key's flag.
 */
export async function revertLegalText({ shopId, slug, key, uid }) {
  const existing = await findLegalPage(shopId, slug);
  if (existing) {
    await updateDoc(doc(db, 'pages', existing.id), {
      status: 'draft',
      updatedAt: serverTimestamp(),
      updatedBy: uid || '',
    });
  }
  return { custom: { [key]: false }, customUpdatedAt: new Date().toISOString() };
}

/**
 * The seller's own HTML for every key they took over, so the evidence
 * snapshot holds the text the STOREFRONT actually serves. Only a PUBLISHED
 * page counts: DynamicPage falls back to the platform template when the
 * seller's page is a draft. Resolves { customHtml, unpublished: [titles] }.
 */
export async function collectCustomHtml({ shopId, custom }) {
  const customHtml = {};
  const unpublished = [];
  for (const [slug, key] of Object.entries(LEGAL_PAGE_KEYS)) {
    if (custom[key] !== true) continue;
    const page = await findLegalPage(shopId, slug, { publishedOnly: true });
    const html = readContentValue(page?.content);
    if (html) customHtml[key] = html;
    else unpublished.push(LEGAL_PAGES[slug].title);
  }
  return { customHtml, unpublished };
}
