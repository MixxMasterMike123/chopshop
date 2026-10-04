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
//   4. the print mappings: per variant, one per artwork it prints (the slots
//      that print the same artwork share one), on the variant's article
//   5. PATCH { status: 'active' }, then POST …/publish (the server's POD gate
//      and floor decide; its refusal is said, the product stays a draft)
// A failure at 3–5 leaves a draft that is not sold: the message says what
// exists, and the next "Skapa produkt" CONTINUES that draft (the tab
// remembers it per shop) instead of creating a second one: the product is
// written again (PATCH), the variants synced by SKU, the mappings planned
// against the server's (a mapping POST of the same artwork, printer and
// article re-activates its row), then published.
//
// AN EXISTING PRODUCT ("Uppdatera befintlig produkt"): only its print
// mappings are written, per variant (or the product's own scope when it has
// no variant), and only where they differ from the server's; its variants,
// prices and texts are not touched (as in the older studio). A live product's
// mapping change is checked by the server against its floor.
//
// IMAGES: none in this build (unit FN2 uploads the mockups). The routes do not
// require an image to publish, so a new product is published without one and
// the result says so.
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
import { quoteDesign } from './podCostQuote.js';

export const QUOTE_FAILED_MSG = 'Inköpspriset kunde inte hämtas. Kontrollera anslutningen och försök igen.';
export const NO_IMAGES_NOTE =
  'Produkten har inga produktbilder ännu: mockuperna sparas inte som produktbilder i den här versionen av adminen. ' +
  'Ladda ned dem i steg 7 och lägg till dem på produkten under Produkter.';
export const NO_IMAGES_UPDATE_NOTE =
  'Mockuperna läggs inte till som produktbilder i den här versionen av adminen. Ladda ned dem i steg 7 om du vill lägga till dem under Produkter.';

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

function mappingStepMessage(error) {
  return mappingRefusalMessage(error) ?? (isNetwork(error) ? 'Anslutningen bröts.' : 'En tryckkoppling kunde inte sparas.');
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
 * deps: { skuFromName, uniqueSku, deriveVariantsFromGroups }
 *
 * → { result: { name, sku, productId, published: true, note, screeningNotice } }
 *   | { error, field?: 'price', changed?: true }   (changed: something was written)
 */
export async function publishNewDesign(input, deps) {
  const { shopId, currency, name, price, colorways, slots, printerId, artworkFor } = input;
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

  // 4. The mappings: per variant, only what differs from the server's.
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

  // 5. Active, then published (the server's gate decides).
  let after;
  try {
    if (server?.product.status !== 'active') await updateProduct(productId, { status: 'active' }, { shopId });
    after = server?.publication?.published === true && server?.product.status === 'active'
      ? server.product
      : await publishProduct(productId, { shopId });
  } catch (error) {
    if (error?.code === 'unauthenticated') return draftError(SESSION_GONE);
    const said = refusalMessage(error, { step: 'publish' });
    if (error?.code === 'price_below_floor') {
      return { ...draftError('Priset ligger under prisgolvet.'), field: 'price' };
    }
    return draftError(said ?? 'Produkten kunde inte publiceras.');
  }

  pendingRuns.delete(shopId);
  return {
    result: {
      name,
      sku: resolvedSku,
      productId,
      published: true,
      note: NO_IMAGES_NOTE,
      screeningNotice: screeningNoticeFor(after?.screeningStatus),
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
 *
 * → { result: { name, sku, updated: true, note } } | { error, changed?: true }
 */
export async function updateExistingFromDesign(input) {
  const { shopId, productId, slots, printerId, articles, colorways, overrideColorwayIds, artworkFor } = input;

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

  return { result: { name: product.name || '(namnlös produkt)', sku: product.sku || '', updated: true, note: NO_IMAGES_UPDATE_NOTE } };
}
