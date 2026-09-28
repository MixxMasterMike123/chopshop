/**
 * scripts/cf-port/migrate/lib/transform-pages.mjs — manifest row 40 (`pages`)
 * → pages (0042), by the rule of docs/cf-port/CP4_C_REPORT.md "For S"
 * (Reviewer wiring 5):
 *
 *   id                        page_id (kept)
 *   slug                      slug: the grammar and the reserved list of the
 *                             Worker's parsePageInput (refused, not repaired)
 *   title, content            title_json, content_json: a map per language; a
 *                             plain string becomes { "sv-SE": … }
 *   metaTitle, metaDescription, summary   their *_json maps (blank = none)
 *   content's HTML            the Worker's checkHtml, through parsePageInput;
 *                             a page it refuses is left out, counted by reason
 *   an image of the source's storage inside the HTML
 *                             replaced by its copied object's PUBLIC ADDRESS
 *                             (the pinned public base + the object's key, as
 *                             the Worker's publicObjectUrl builds it); an
 *                             <img> whose file was not copied is removed and
 *                             counted; any other address of the source's
 *                             storage makes checkHtml refuse the page
 *   status                    'published' | 'draft'; a published page is dated
 *                             by its createdAt (the source has no date of its own)
 *   kind (or type)            'page' | 'post', else 'page'
 *   author, imageUrl          author; image_object_id (copied, product_media)
 *   createdBy, updatedBy      the user map of CP3 (legacy_id_map), else NULL
 *   attachments               not carried (D94), counted
 */

import { objectKeyOf } from './copy-manifest.mjs';
import { sourceAddressesInHtml } from './copy-sources.mjs';
import { count, insertRow, isoOf, lookup, resolveImage, sourceMillis } from './transform-products.mjs';
import { clampForward } from './timestamps.mjs';

export const PAGE_COLUMNS = [
  'page_id', 'tenant_id', 'slug', 'kind', 'status', 'title_json', 'content_json', 'summary_json', 'meta_title_json',
  'meta_description_json', 'author', 'image_object_id', 'published_at', 'created_at', 'updated_at', 'created_by', 'updated_by',
];

/** The language of a text the source stored as a plain string (C: `sv-SE`). */
export const PLAIN_TEXT_LANGUAGE = 'sv-SE';

/** src/content/pages.ts mapJson: the keys sorted. */
export function mapJson(map) {
  const sorted = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  return JSON.stringify(sorted);
}

function asMap(value) {
  if (typeof value === 'string') return { [PLAIN_TEXT_LANGUAGE]: value };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  return undefined;
}

function scrubMap(ctx, map, where) {
  if (map === undefined) return undefined;
  const out = {};
  for (const [language, text] of Object.entries(map)) out[language] = typeof text === 'string' ? ctx.textScrub(text, `${where}.${language}`) : text;
  return out;
}

/** An optional text map with nothing but blanks is no map. */
function optionalMap(map) {
  if (map === undefined) return undefined;
  return Object.values(map).some((text) => typeof text === 'string' && text.trim().length > 0) ? map : undefined;
}

/**
 * The HTML of one language with every source-storage image dealt with:
 * a copied file → its public address; an <img> whose file was not copied →
 * removed. Addresses are the ones lib/copy-sources.mjs finds (the copy's own
 * function), longest first so no address is cut inside a longer one.
 */
function rewriteHtml(ctx, shopId, html) {
  let text = html;
  const addresses = sourceAddressesInHtml(html).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  for (const address of addresses) {
    const image = resolveImagePublic(ctx, shopId, address);
    if (image.status === 'copied') {
      text = text.split(address).join(image.url);
      count(ctx.report, shopId, 'page_images_replaced');
      continue;
    }
    const before = text;
    text = text.replace(/<img\b[^>]*>/gi, (tag) => (tag.includes(address) ? '' : tag));
    count(ctx.report, shopId, before === text ? `page_images_not_removable:${image.status}` : `page_images_removed:${image.status}`);
  }
  return text;
}

/** A copied object of this shop of either public kind, with its address. */
function resolveImagePublic(ctx, shopId, address) {
  let image = resolveImage(ctx, shopId, address, 'product_media');
  if (image.status === 'wrong_kind') image = resolveImage(ctx, shopId, address, 'shop_branding');
  if (image.status !== 'copied') return image;
  const key = objectKeyOf(image.entry);
  const url = ctx.publicBase === null || key === null ? null : ctx.rules.publicObjectUrl(ctx.publicBase, key);
  if (url === null) {
    ctx.problems.push('REFUSED: a page image needs the public address of its object, and the pinned public base or the object key is not usable');
    return { status: 'no_address' };
  }
  return { ...image, url };
}

/**
 * @param {object} args
 * @param {object} args.ctx      the shared context (transform-products.mjs); ctx.publicBase, ctx.userIds
 * @param {object[]} args.docs   decoded `pages` documents
 * @param {Map} args.tenants     the shops this plan writes into
 * @param {object} args.expected the per-shop expected block, extended here
 */
export function transformPages({ ctx, docs, expected, tenants }) {
  const { nowMillis, report, rules } = ctx;
  const sections = { pages: [] };
  const slugs = lookup(); // `${shopId}\n${slug}` → true

  const sorted = [...docs].sort((a, b) => (a.data?.shopId ?? '').localeCompare(b.data?.shopId ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const doc of sorted) {
    const data = doc.data ?? {};
    const shopId = typeof data.shopId === 'string' ? data.shopId : null;
    if (shopId === null || !tenants.has(shopId)) {
      count(report, shopId ?? '(none)', 'pages_left_out:shop_not_in_target');
      continue;
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(doc.id)) {
      count(report, shopId, 'pages_left_out:id_shape');
      continue;
    }
    const where = `pages/${doc.id}`;
    if (Array.isArray(data.attachments) && data.attachments.length > 0) count(report, shopId, 'page_attachments_not_carried', data.attachments.length);

    const content = scrubMap(ctx, asMap(data.content), `${where}.content`);
    if (content !== undefined) {
      for (const [language, html] of Object.entries(content)) {
        if (typeof html === 'string') content[language] = rewriteHtml(ctx, shopId, html);
      }
    }
    const status = data.status === 'published' ? 'published' : 'draft';
    const kindSource = data.kind ?? data.type;
    const kind = kindSource === 'post' ? 'post' : 'page';
    const createdMs = sourceMillis(data.createdAt, sourceMillis(data.updatedAt, nowMillis));
    const updatedMs = clampForward(sourceMillis(data.updatedAt, createdMs), createdMs);
    const publishedMs = status === 'published' ? sourceMillis(data.publishedAt, createdMs) : null;

    const body = {
      content,
      kind,
      publishedAt: publishedMs === null ? null : isoOf(publishedMs),
      slug: data.slug,
      status,
      title: scrubMap(ctx, asMap(data.title), `${where}.title`),
    };
    const summary = optionalMap(scrubMap(ctx, asMap(data.summary), `${where}.summary`));
    if (summary !== undefined) body.summary = summary;
    const metaTitle = optionalMap(scrubMap(ctx, asMap(data.metaTitle), `${where}.metaTitle`));
    if (metaTitle !== undefined) body.metaTitle = metaTitle;
    const metaDescription = optionalMap(scrubMap(ctx, asMap(data.metaDescription), `${where}.metaDescription`));
    if (metaDescription !== undefined) body.metaDescription = metaDescription;
    if (typeof data.author === 'string' && data.author.trim().length > 0) body.author = ctx.textScrub(data.author, `${where}.author`);
    const imageAddress = typeof data.imageUrl === 'string' ? data.imageUrl : typeof data.image === 'string' ? data.image : null;
    if (imageAddress !== null && imageAddress.trim().length > 0) {
      const image = resolveImage(ctx, shopId, imageAddress, 'product_media');
      if (image.status === 'copied') body.imageObjectId = image.objectId;
      else count(report, shopId, `page_image_left_out:${image.status}`);
    }

    const parsed = rules.parsePageInput(body, 'create');
    if (parsed.status !== 'ok') {
      count(report, shopId, `pages_left_out:${parsed.status === 'content_refused' ? `content_refused:${parsed.reason}` : parsed.status}`);
      continue;
    }
    const input = parsed.input;
    if (slugs[`${shopId}\n${input.slug}`] === true) {
      count(report, shopId, 'pages_left_out:slug_taken');
      continue;
    }
    slugs[`${shopId}\n${input.slug}`] = true;

    const userOf = (uid) => (typeof uid === 'string' && ctx.userIds.has(uid) ? ctx.userIds.get(uid) : null);
    if (typeof data.createdBy === 'string' && userOf(data.createdBy) === null) count(report, shopId, 'page_actor_not_mapped');
    sections.pages.push(
      insertRow('pages', doc.id, PAGE_COLUMNS, {
        author: input.author ?? null,
        content_json: mapJson(input.content),
        created_at: isoOf(createdMs),
        created_by: userOf(data.createdBy),
        image_object_id: input.imageObjectId ?? null,
        kind: input.kind ?? 'page',
        meta_description_json: input.metaDescription ? mapJson(input.metaDescription) : null,
        meta_title_json: input.metaTitle ? mapJson(input.metaTitle) : null,
        page_id: doc.id,
        published_at: input.publishedAt ?? null,
        slug: input.slug,
        status: input.status ?? 'draft',
        summary_json: input.summary ? mapJson(input.summary) : null,
        tenant_id: shopId,
        title_json: mapJson(input.title),
        updated_at: isoOf(updatedMs),
        updated_by: userOf(data.updatedBy),
      }),
    );
    expected[shopId] ??= {};
    expected[shopId].pages = (expected[shopId].pages ?? 0) + 1;
  }
  return { sections };
}
