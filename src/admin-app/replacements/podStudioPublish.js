// The design studio's PUBLISH on the API (CP5 unit FN1). No React: the
// studio's data module (podStudioData.js) calls these, and they are tested
// under Node against the dev API (podStudioPublish.test.mjs). The helpers
// whose module the Node runner cannot load (utils/productUrls) are passed in.
//
// A NEW PRODUCT, in the order that leaves nothing half-live:
//   0. checks that write nothing: every colour/size has its own article, no
//      article twice, the server's quote for every article asked AGAIN (a
//      failed quote stops here: it is never "0 kr"), every price at or over
//      the server's floor for its article (said at the price field)
//   1. the SKU made unique in the shop (as the product form does)
//   2. POST /v1/admin/products (a DRAFT: not in the storefront)
//   3. the variants (one per colour and size): POST …/variants
//   4. the IMAGES (unit FN2): each mockup uploaded (or kept, when the product
//      already holds the same bytes for that colour and side, or this tab
//      uploaded them before), then the whole list PUT: the hero first, every
//      mockup in the product's own rows, each colour's mockups on its first
//      variant (podStudioImages.js, adapters/studioMedia.js). A lost answer to
//      the PUT is read back before anything is said.
//   5. the print mappings: per variant, one per artwork it prints (the slots
//      that print the same artwork share one), on the variant's article
//   6. PATCH { status: 'active' }, then POST …/publish (the server's POD gate
//      and floor decide; its refusal is said, the product stays a draft)
// So a studio product is never live without its images. A failure at 3–6
// leaves a draft that is not sold: the message says what exists, and the next
// "Skapa produkt" CONTINUES that draft (the tab remembers it per shop) instead
// of creating a second one: the product is written again (PATCH), the
// variants synced by SKU, the images re-planned (only what is missing is
// uploaded; an identical list is not written), the mappings planned against
// the server's (a mapping POST of the same artwork, printer and article
// re-activates its row), then published.
// A colour with no mockup at all stops the publish before anything is written
// (said with the colour's name); a colour missing one printed side is
// published with a visible note naming the side.
//
// AN EXISTING PRODUCT ("Uppdatera befintlig produkt"): its print mappings are
// written per variant (or the product's own scope when it has no variant),
// only where they differ from the server's; then its images: the studio's
// rows of the published colours are replaced, the seller's are kept
// (adapters/studioMedia.js says exactly which rows are the studio's). Its
// variants, prices and texts are not touched (as in the older studio). A live
// product's mapping change is checked by the server against its floor.
//
// THE SELLER SEES ONE NUMBER: the only figures read are the server's quote
// (inkopMinor, priceFloorMinor); nothing here prices.

import { AdminApiError } from '../../api/admin/client.js';
import {
  createProduct,
  createVariant,
  deleteVariant,
  getProduct,
  listAllProducts,
  publishProduct,
  updateProduct,
  updateVariant,
} from '../../api/admin/products.js';
import { createMapping, deleteMapping, listMappings } from '../../api/admin/pod.js';
import {
  desiredVariants,
  planVariantSync,
  productBodyProblem,
  productWriteBody,
  refusalMessage,
  screeningNoticeFor,
  variantProblem,
  ore,
} from '../adapters/product.js';
import { mappingRefusalMessage, quoteRefusalMessage } from '../adapters/pod.js';
import {
  duplicateArticles,
  krText,
  mappingGroups,
  mappingsInScope,
  normalizeLabel,
  planScopeMappings,
} from '../adapters/studio.js';
import { IMAGE_ROWS_MAX, SIDE_WORDS, mockupCoverage, planStudioImages } from '../adapters/studioMedia.js';
import { quoteDesign } from './podCostQuote.js';
import { imageStepCause, resolveMockupObjects, rowsOf, writeStudioImages } from './podStudioImages.js';

export const QUOTE_FAILED_MSG = 'Inköpspriset kunde inte hämtas. Kontrollera anslutningen och försök igen.';

const SESSION_GONE = 'Sessionen har gått ut. Logga in igen.';

// ── the draft a failed publish left, per shop (for the life of the tab) ─────

const pendingRuns = new Map(); // shopId → { productId, sku }

/** The draft the next publish in this shop continues, or null. */
export function pendingRun(shopId) {
  return pendingRuns.get(shopId) ?? null;
}

/** Forget the draft (tests; a new sign-in). The draft itself stays on the server. */
export function forgetPendingRun(shopId) {
  if (shopId === undefined) pendingRuns.clear();
  else pendingRuns.delete(shopId);
}

// ── shared checks ───────────────────────────────────────────────────────────

const isNetwork = (error) => !(error instanceof AdminApiError) || error.status === 0 || error.status >= 500;

/**
 * The server's quote for every article, asked again now. → { ok: true,
 * floorBySku: Map sku → floorMinor } or { ok: false, error }.
 */
async function freshFloors(skus, { shopId, printerId, slots }) {
  const distinct = [...new Set(skus)];
  const floorBySku = new Map();
  for (const sku of distinct) {
    let quote;
    try {
      quote = await quoteDesign({ printerId, sku, slots }, { shopId, fresh: true });
    } catch (error) {
      if (error?.code === 'unauthenticated') return { ok: false, error: SESSION_GONE };
      const known = error instanceof AdminApiError && error.status === 422;
      return { ok: false, error: known ? quoteRefusalMessage(error) : QUOTE_FAILED_MSG };
    }
    floorBySku.set(sku, quote.priceFloorMinor);
  }
  return { ok: true, floorBySku };
}

const floorKr = (minor) => krText(minor / 100);

/**
 * The product as the server holds it after a write whose answer was lost:
 * { published, product } (published = live: active and published), or null
 * when it cannot be read either (the outcome is then unknown).
 */
async function readBackLive(productId, shopId) {
  try {
    const detail = await getProduct(productId, { shopId });
    if (!detail) return null;
    return {
      published: detail.publication?.published === true && detail.product?.status === 'active',
      product: detail.product,
    };
  } catch {
    return null;
  }
}

function mappingStepMessage(error) {
  return mappingRefusalMessage(error) ?? (isNetwork(error) ? 'Anslutningen bröts.' : 'En tryckkoppling kunde inte sparas.');
}

// ── the mockups (unit FN2) ──────────────────────────────────────────────────

const sideText = ({ label, slot }) => `${label} (${SIDE_WORDS[slot] ?? slot})`;
const hasBytes = (m) => typeof m?.blob?.arrayBuffer === 'function' && m.blob.size > 0;

/**
 * The checks of the mockups that write nothing: every published colour has at
 * least one, and the list fits the server's cap. → { error } | { missingSides }
 * `colours` [{ id, label, variantIds }] (placeholders are enough for the count).
 */
function mockupCheck({ mockups, colours, slots, rows = [], heroKey, replaceImages = false, fresh }) {
  const usable = mockups.filter(hasBytes);
  const { colourless, missingSides } = mockupCoverage({ mockups: usable, colours, slots });
  if (colourless.length > 0) {
    return {
      error: `Det finns ingen mockup för ${colourless.join(', ')}. Generera mockuperna igen i steg 7 — en färg publiceras inte utan bild.`,
    };
  }
  const plan = planStudioImages({ rows, colours, mockups: usable.map((m) => ({ ...m, objectId: `new:${m.key}` })), heroKey, replaceImages, fresh });
  if (plan.error) return { error: tooManyImages(plan.count) };
  return { missingSides };
}

/**
 * Each published colour's variants on a product by its exact name (the
 * variant's group, else its label): `variantIds` the ACTIVE ones by position
 * (the studio's rows name the first), `siblingIds` every one, inactive too.
 * Ids decide the write; the name only finds the colour's group.
 */
function coloursOnProduct(colorways, variants) {
  const all = [...(variants ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return colorways.map((c) => {
    const mine = all.filter((v) => normalizeLabel(v.group ?? v.label) === normalizeLabel(c.label));
    return {
      id: c.id,
      label: c.label,
      variantIds: mine.filter((v) => v.active === true).map((v) => v.variantId),
      siblingIds: mine.map((v) => v.variantId),
    };
  });
}

const tooManyImages = (count) =>
  `Produkten skulle få ${count} bilder, men högst ${IMAGE_ROWS_MAX} är tillåtna. Välj färre färger, eller ta bort bilder under Produkter.`;

/** The note under a success: what the seller should know about the images. */
function imageNote({ missingSides = [], compacted = false, galleryOnly = [], keptSeller = [] }) {
  const parts = [];
  if (missingSides.length > 0) {
    parts.push(`Ingen mockup kunde göras för ${missingSides.map(sideText).join(', ')}: den bilden saknas på produkten.`);
  }
  if (compacted) {
    parts.push(`Produkten får högst ${IMAGE_ROWS_MAX} bilder, så bildgalleriet visar huvudbilden och varje färgs mockuper visas på färgen.`);
  }
  if (galleryOnly.length > 0) {
    parts.push(`${galleryOnly.join(', ')} finns inte som variant på produkten: de mockuperna ligger bara i produktens bildgalleri.`);
  }
  if (keptSeller.length > 0) {
    parts.push(`${keptSeller.join(', ')} har egna bilder som behölls. Kryssa i ”Ersätt även befintlig huvudbild/variantbilder” för att lägga mockuperna först.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * The image step on a product that exists: the objects (kept, reused or
 * uploaded), the planned list, the write (read back when its answer is lost).
 * → { ok: true, plan } | { ok: false, cause, unknown?: true }
 */
async function imageStep({ shopId, productId, rows, colours, mockups, heroKey, replaceImages = false, fresh }) {
  const usable = mockups.filter(hasBytes);
  let objectIdByKey;
  try {
    ({ objectIdByKey } = await resolveMockupObjects(usable, { shopId, productId, rows, colours }));
  } catch (error) {
    const progress = Number.isInteger(error?.total) && error.total > 0 ? ` (${error.done} av ${error.total} uppladdade)` : '';
    return { ok: false, cause: `Produktbilderna kunde inte sparas${progress}: ${imageStepCause(error)}` };
  }
  const plan = planStudioImages({
    rows,
    colours,
    mockups: usable.map((m) => ({ key: m.key, colorwayId: m.colorwayId, slot: m.slot, objectId: objectIdByKey[m.key] })),
    heroKey,
    replaceImages,
    fresh,
  });
  if (plan.error) return { ok: false, cause: tooManyImages(plan.count) };
  const wrote = await writeStudioImages(productId, plan.list, { shopId, before: rows, colours });
  if (!wrote.ok) {
    return wrote.unknown
      ? { ok: false, unknown: true, cause: 'Anslutningen bröts, och det är oklart om produktbilderna sparades.' }
      : { ok: false, cause: `Produktbilderna kunde inte sparas: ${wrote.cause}` };
  }
  return { ok: true, plan };
}

// ── a new product ───────────────────────────────────────────────────────────

/**
 * input:
 *   shopId, currency
 *   name, price            the product's name and price (kr, incl. VAT)
 *   colorways              [{ id, label, price: '' | kr, cells: [{ size: 'S' | null, sku }] }]
 *                          in the order they are published; `price` '' follows
 *                          the product's; `size` null = a one-size garment
 *   slots                  the designed slots
 *   printerId              the printer of every article
 *   artworkFor(slot, colorwayId) → artworkId
 *   mockups                the published colours' mockups [{ key, colorwayId, slot,
 *                          blob, type }], in the studio's order
 *   heroKey                the mockup the seller picked as the main image
 * deps: { skuFromName, uniqueSku, deriveVariantsFromGroups }
 *
 * → { result: { name, sku, productId, published: true, note, screeningNotice, held, blocked } }
 *   | { error, field?: 'price', changed?: true }   (changed: something was written)
 */
export async function publishNewDesign(input, deps) {
  const { shopId, currency, name, price, colorways, slots, printerId, artworkFor, mockups = [], heroKey = null } = input;
  const { skuFromName, uniqueSku, deriveVariantsFromGroups } = deps;

  // 0. Checks that write nothing.
  const labels = colorways.map((c) => normalizeLabel(c.label));
  if (new Set(labels).size !== labels.length) {
    return { error: 'Två färger har samma namn. Välj färger med olika namn.' };
  }
  const cells = colorways.flatMap((c) => c.cells.map((cell) => ({ ...cell, colorway: c })));
  if (cells.length === 0 || cells.some((cell) => !cell.sku)) {
    return { error: 'Välj tryckeriets artikel för varje färg och storlek som ska säljas.' };
  }
  if (duplicateArticles(cells.map((cell) => cell.sku)).length > 0) {
    return { error: 'Samma artikel hos tryckeriet är vald för två varianter. Välj en egen artikel för varje färg och storlek.' };
  }
  // Every colour has its mockup, and the images fit (placeholders: nothing is uploaded yet).
  const images = mockupCheck({
    mockups, slots, heroKey, fresh: true,
    colours: colorways.map((c) => ({ id: c.id, label: c.label, variantIds: [`new:${c.id}`] })),
  });
  if (images.error) return { error: images.error };
  const floors = await freshFloors(cells.map((cell) => cell.sku), { shopId, printerId, slots });
  if (!floors.ok) return { error: floors.error };
  const priceMinor = ore(price);
  const strictest = Math.max(...floors.floorBySku.values());
  if (priceMinor === null || priceMinor < strictest) {
    return { error: `Priset måste vara minst prisgolvet ${floorKr(strictest)} — under det tjänar du 0 kr.`, field: 'price' };
  }
  for (const c of colorways) {
    const own = String(c.price ?? '').trim();
    if (own === '' || !(parseFloat(own) > 0)) continue;
    const rowFloor = Math.max(...c.cells.map((cell) => floors.floorBySku.get(cell.sku)));
    if (ore(own) < rowFloor) {
      return { error: `Priset för ${c.label} ligger under prisgolvet ${floorKr(rowFloor)}.`, field: 'price' };
    }
  }

  // 1. The SKU (the draft a failed run left keeps its own).
  let resume = pendingRuns.get(shopId) ?? null;
  let server = null;
  if (resume) {
    server = await getProduct(resume.productId, { shopId }).catch(() => undefined);
    if (server === undefined) return { error: 'Utkastet från förra försöket kunde inte läsas. Försök igen om en stund.' };
    if (server === null || server.product.status === 'archived') {
      pendingRuns.delete(shopId);
      resume = null;
      server = null;
    }
  }
  let resolvedSku;
  try {
    const taken = (await listAllProducts({ shopId }))
      .filter((p) => p.productId !== resume?.productId)
      .map((p) => (p.sku || '').trim())
      .filter(Boolean);
    resolvedSku = uniqueSku(skuFromName(name), taken, server?.product.sku ?? '');
  } catch (error) {
    return { error: error?.code === 'unauthenticated' ? SESSION_GONE : 'Butikens produkter kunde inte läsas. Försök igen.' };
  }

  // The variants: one per colour and size (the studio's rail).
  const groups = colorways.map((c) => ({
    label: c.label,
    sku: '',
    price: String(c.price ?? '').trim(),
    images: [],
    sizes: c.cells.map((cell) => cell.size).filter(Boolean),
  }));
  const { cleanGroups, cleanVariants } = deriveVariantsFromGroups(groups, { productSku: resolvedSku, productPrice: price, skuFromName });
  const desired = desiredVariants(cleanVariants, cleanGroups);
  // Each row's colour (the derivation keeps the groups' order, one group per colour) and article.
  const colorwayOfGroup = new Map(cleanGroups.map((g, i) => [g.label, colorways[i]]));
  const units = cleanVariants.map((row) => {
    const colorway = colorwayOfGroup.get(row.group);
    const cell = colorway.cells.find((x) => (x.size ?? null) === (row.size ?? null));
    return { row, colorway, sku: cell?.sku };
  });
  if (units.some((u) => !u.sku)) return { error: 'Varje variant behöver en artikel hos tryckeriet.' };

  const body = productWriteBody({
    formData: {
      name,
      descriptions: { b2c: '', b2cMoreInfo: '' },
      category: '',
      tags: [],
      featured: false,
      sizeGuide: '',
      launchDate: '',
      weight: { value: 0, unit: 'g' },
      delivery: { shipping: true, pickup: true },
      shipping: null,
      isActive: server ? server.product.status === 'active' : false,
    },
    sku: resolvedSku,
    price,
    compareAtPrice: 0,
    create: !server,
    currency,
  });
  const problem = productBodyProblem(body) ?? variantProblem(desired);
  if (problem) return { error: problem.message, field: problem.field === 'price' ? 'price' : undefined };

  // 2. The product (a draft), or the draft of the last failed run.
  let productId = server?.product.productId ?? null;
  try {
    if (server) {
      await updateProduct(productId, body, { shopId });
    } else {
      const created = await createProduct(body, { shopId });
      productId = created?.productId;
      if (!productId) throw new AdminApiError({ status: 0, code: 'no_product', message: 'The create named no product' });
    }
  } catch (error) {
    if (!server && isNetwork(error)) {
      // The answer was lost: the product may exist. Look for its SKU so the next try continues it.
      const found = await listAllProducts({ shopId }).then((all) => all.find((p) => p.sku === resolvedSku)).catch(() => null);
      if (found) {
        pendingRuns.set(shopId, { productId: found.productId, sku: resolvedSku });
        return {
          changed: true,
          error: `Anslutningen bröts, men produkten ”${name}” (SKU ${resolvedSku}) skapades som utkast. Tryck ”Skapa produkt” igen för att fortsätta med den.`,
        };
      }
      return { error: 'Anslutningen bröts och det är oklart om produkten skapades. Kontrollera under Produkter innan du försöker igen.' };
    }
    return { error: refusalMessage(error, { step: 'product' }) ?? 'Produkten kunde inte skapas.' };
  }
  pendingRuns.set(shopId, { productId, sku: resolvedSku });

  const stage = { variantsDone: 0, variantsTotal: desired.length, mappingsDone: 0, mappingsTotal: null };
  const draftError = (cause) => ({
    changed: true,
    error:
      `Produkten ”${name}” (SKU ${resolvedSku}) finns som utkast och visas inte i butiken: ` +
      `${stage.variantsDone} av ${stage.variantsTotal} varianter` +
      (stage.mappingsTotal === null ? '' : ` och ${stage.mappingsDone} av ${stage.mappingsTotal} tryckkopplingar`) +
      ` är sparade. ${cause} Tryck ”Skapa produkt” igen för att fortsätta med samma utkast, eller öppna det under Produkter.`,
  });

  // 3. The variants (synced by SKU against the draft's, when continuing one).
  const variantIdBySku = new Map();
  let current = null; // the variant being written (named in a refusal)
  try {
    const existing = server?.variants ?? [];
    for (const v of existing) if (v.active === true) variantIdBySku.set(v.sku.toLowerCase(), v.variantId);
    const plan = planVariantSync(existing, desired);
    stage.variantsDone = desired.length - plan.creates.length - plan.updates.length;
    for (const variantId of plan.deletes) await deleteVariant(productId, variantId, { shopId });
    for (const { variantId, sku, body: patch } of plan.updates) {
      current = { sku, label: desired.find((d) => d.sku === sku)?.label };
      await updateVariant(productId, variantId, patch, { shopId });
      variantIdBySku.set(sku.toLowerCase(), variantId);
      stage.variantsDone += 1;
    }
    for (const { sku, body: create } of plan.creates) {
      current = { sku, label: create.label };
      const variant = await createVariant(productId, create, { shopId });
      if (!variant?.variantId) throw new AdminApiError({ status: 0, code: 'no_variant', message: 'The create named no variant' });
      variantIdBySku.set(sku.toLowerCase(), variant.variantId);
      stage.variantsDone += 1;
    }
  } catch (error) {
    if (error?.code === 'unauthenticated') return draftError(SESSION_GONE);
    return draftError(refusalMessage(error, { step: 'variant', sku: current?.sku, label: current?.label }) ?? 'En variant kunde inte sparas.');
  }

  // 4. The images (before anything can make the product live).
  let colourVariants = colorways.map((c) => ({
    id: c.id,
    label: c.label,
    variantIds: units.filter((u) => u.colorway.id === c.id).map((u) => variantIdBySku.get(u.row.sku.toLowerCase())).filter(Boolean),
  }));
  let rowsNow = [];
  if (server) {
    // The draft's rows as they are now (the variant sync may have removed
    // some), and its variants: a size the sync could only DEACTIVATE (a
    // mapping names it) still carries the colour's earlier rows.
    try {
      const now = await getProduct(productId, { shopId });
      rowsNow = rowsOf(now);
      const siblings = coloursOnProduct(colorways, now?.variants);
      colourVariants = colourVariants.map((c, i) => ({ ...c, siblingIds: siblings[i].siblingIds }));
    } catch (error) {
      return draftError(error?.code === 'unauthenticated' ? SESSION_GONE : `Produktbilderna kunde inte sparas: ${imageStepCause(error)}`);
    }
  }
  const imaged = await imageStep({ shopId, productId, rows: rowsNow, colours: colourVariants, mockups, heroKey, fresh: true });
  if (!imaged.ok) return draftError(imaged.cause);

  // 5. The mappings: per variant, only what differs from the server's.
  try {
    const existing = server ? await listMappings({ productId, shopId }) : [];
    const plans = units.map((u) => {
      const variantId = variantIdBySku.get(u.row.sku.toLowerCase());
      const wanted = mappingGroups(slots, (slot) => artworkFor(slot, u.colorway.id))
        .map((g) => ({ ...g, printerId, sku: u.sku }));
      return { variantId, plan: planScopeMappings(mappingsInScope(existing, variantId), wanted) };
    });
    stage.mappingsTotal = plans.reduce((n, p) => n + p.plan.keep.length + p.plan.posts.length, 0);
    stage.mappingsDone = plans.reduce((n, p) => n + p.plan.keep.length, 0);
    for (const { variantId, plan } of plans) {
      for (const mappingId of plan.deletes) await deleteMapping(mappingId, { shopId });
      for (const m of plan.posts) {
        await createMapping({ productId, variantId, artworkId: m.artworkId, printerId: m.printerId, sku: m.sku, slots: m.slots }, { shopId });
        stage.mappingsDone += 1;
      }
    }
  } catch (error) {
    if (error?.code === 'unauthenticated') return draftError(SESSION_GONE);
    return draftError(mappingStepMessage(error));
  }

  // 6. Active, then published (the server's gate decides).
  let after;
  try {
    if (server?.product.status !== 'active') await updateProduct(productId, { status: 'active' }, { shopId });
    after = server?.publication?.published === true && server?.product.status === 'active'
      ? server.product
      : await publishProduct(productId, { shopId });
  } catch (error) {
    if (error?.code === 'unauthenticated') return draftError(SESSION_GONE);
    if (isNetwork(error)) {
      // The answer was lost (or replaced by a gateway error): the server may
      // have done it. The product is read back before anything is said about
      // whether customers can buy it (Codex FN1 round 1).
      const live = await readBackLive(productId, shopId);
      if (live === null) {
        return {
          changed: true,
          error:
            `Anslutningen bröts och det är oklart om produkten ”${name}” (SKU ${resolvedSku}) publicerades. ` +
            'Kontrollera under Produkter innan du försöker igen.',
        };
      }
      if (live.published) {
        after = live.product;
      } else {
        return draftError('Anslutningen bröts innan produkten publicerades.');
      }
    } else {
      const said = refusalMessage(error, { step: 'publish' });
      if (error?.code === 'price_below_floor') {
        return { ...draftError('Priset ligger under prisgolvet.'), field: 'price' };
      }
      return draftError(said ?? 'Produkten kunde inte publiceras.');
    }
  }

  pendingRuns.delete(shopId);
  return {
    result: {
      name,
      sku: resolvedSku,
      productId,
      published: true,
      note: imageNote({ ...imaged.plan, missingSides: images.missingSides }),
      screeningNotice: screeningNoticeFor(after?.screeningStatus),
      // CP9-OB: published but not shown: held for the platform's review, or
      // stopped by it. The panel then never says "LIVE".
      held: after?.screeningStatus === 'pending',
      blocked: after?.screeningStatus === 'blocked',
    },
  };
}

// ── an existing product ─────────────────────────────────────────────────────

/**
 * input:
 *   shopId, productId, slots, printerId
 *   articles               { [variantId, or '' for the product's own scope]: sku }
 *   colorways              the published colours [{ id, label }]
 *   overrideColorwayIds    the colours that print another artwork somewhere
 *   artworkFor(slot, colorwayId | null) → artworkId (null: the slot's own artwork)
 *   mockups, heroKey       as for a new product (the published colours' mockups)
 *   replaceImages          the seller's "Ersätt även befintlig huvudbild/variantbilder"
 *
 * → { result: { name, sku, updated: true, note } } | { error, changed?: true }
 */
export async function updateExistingFromDesign(input) {
  const {
    shopId, productId, slots, printerId, articles, colorways, overrideColorwayIds, artworkFor,
    mockups = [], heroKey = null, replaceImages = false,
  } = input;

  let detail;
  try {
    detail = await getProduct(productId, { shopId });
  } catch (error) {
    return { error: error?.code === 'unauthenticated' ? SESSION_GONE : 'Produkten kunde inte läsas. Försök igen.' };
  }
  if (!detail) return { error: 'Produkten finns inte längre.' };
  if (detail.product.status === 'archived') return { error: 'Produkten är borttagen och kan inte kopplas.' };
  const product = detail.product;

  const variants = (detail.variants ?? []).filter((v) => v.active === true)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const scopes = variants.length > 0
    ? variants.map((v) => ({ variantId: v.variantId, label: v.label, group: v.group ?? v.label, priceMinor: v.priceMinor }))
    : [{ variantId: null, label: product.name, group: null, priceMinor: product.priceMinor }];

  // A colour-specific motif needs its colour on the product (an exact name, as the older studio).
  const colorwayOfGroup = (group) => colorways.find((c) => group && normalizeLabel(c.label) === normalizeLabel(group)) ?? null;
  const missing = overrideColorwayIds
    .map((id) => colorways.find((c) => c.id === id))
    .filter((c) => c && !scopes.some((s) => s.group && normalizeLabel(s.group) === normalizeLabel(c.label)));
  if (missing.length > 0) {
    return {
      error: `Motivet för ${missing.map((c) => c.label).join(', ')} kan inte kopplas eftersom färgnamnet saknas på produkten. Uppdatera produktens färger eller skapa en ny produkt.`,
    };
  }

  const chosen = scopes.map((s) => articles[s.variantId ?? ''] || '');
  if (chosen.some((sku) => !sku)) return { error: 'Välj tryckeriets artikel för varje variant.' };
  if (duplicateArticles(chosen).length > 0) {
    return { error: 'Samma artikel hos tryckeriet är vald för två varianter. Välj en egen artikel för varje variant.' };
  }
  // The images: each published colour's variants on the product (its exact
  // name, as the motif rule above), the first ACTIVE one first, and every
  // variant of the colour, inactive ones too (their rows are the colour's:
  // the storefront shows them on the active sizes); the checks write nothing.
  const colourVariants = coloursOnProduct(colorways, detail.variants);
  const rows = rowsOf(detail);
  const images = mockupCheck({ mockups, colours: colourVariants, slots, rows, heroKey, replaceImages, fresh: false });
  if (images.error) return { error: images.error };

  const floors = await freshFloors(chosen, { shopId, printerId, slots });
  if (!floors.ok) return { error: floors.error };
  const under = scopes.filter((s, i) => Number.isSafeInteger(s.priceMinor) && s.priceMinor < floors.floorBySku.get(chosen[i]));
  if (under.length > 0) {
    const s = under[0];
    return {
      error: `Priset för ${s.label} ligger under prisgolvet ${floorKr(floors.floorBySku.get(chosen[scopes.indexOf(s)]))}. Höj priset under Produkter och försök igen.`,
    };
  }

  let written = 0;
  try {
    const existing = await listMappings({ productId, shopId });
    for (let i = 0; i < scopes.length; i++) {
      const scope = scopes[i];
      const colorway = colorwayOfGroup(scope.group);
      const wanted = mappingGroups(slots, (slot) => artworkFor(slot, colorway?.id ?? null))
        .map((g) => ({ ...g, printerId, sku: chosen[i] }));
      const plan = planScopeMappings(mappingsInScope(existing, scope.variantId), wanted);
      for (const mappingId of plan.deletes) {
        await deleteMapping(mappingId, { shopId }).catch((error) => {
          throw Object.assign(error, { removing: true });
        });
        written += 1;
      }
      for (const m of plan.posts) {
        await createMapping({ productId, variantId: scope.variantId, artworkId: m.artworkId, printerId: m.printerId, sku: m.sku, slots: m.slots }, { shopId });
        written += 1;
      }
    }
  } catch (error) {
    if (error?.code === 'unauthenticated') return { error: SESSION_GONE, changed: written > 0 };
    const said = mappingRefusalMessage(error, { removing: error?.removing === true }) ?? (isNetwork(error) ? 'Anslutningen bröts.' : 'En tryckkoppling kunde inte sparas.');
    return {
      changed: written > 0,
      error: written > 0
        ? `Tryckkopplingen uppdaterades bara delvis (${written} ändringar sparade): ${said} Kontrollera produkten under Print on demand → Avancerat och försök igen.`
        : said,
    };
  }

  // The images, after the print is right (as the older studio: the mappings first).
  const imaged = await imageStep({ shopId, productId, rows, colours: colourVariants, mockups, heroKey, replaceImages, fresh: false });
  if (!imaged.ok) {
    if (imaged.unknown) {
      return { changed: true, error: `${imaged.cause} Kontrollera produkten under Produkter innan du försöker igen.` };
    }
    return {
      changed: written > 0,
      error: `${imaged.cause} ${written > 0 ? 'Tryckkopplingen är redan uppdaterad. ' : ''}Tryck ”Uppdatera produkten” igen för att försöka igen.`,
    };
  }

  return {
    result: {
      name: product.name || '(namnlös produkt)',
      sku: product.sku || '',
      updated: true,
      note: imageNote({ ...imaged.plan, missingSides: images.missingSides }),
    },
  };
}
