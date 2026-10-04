// The POD page's shapes (CP5 unit FM): the API's answers (src/api/admin/pod.js,
// docs/cf-port/CP5_WG_REPORT.md) → the documents the older POD components
// read (ArtworkLibrary, ArtworkUploadModal, ProductMapping, PodProductPicker),
// and the API's refusals → the Swedish sentence the page shows. Pure: no I/O,
// no React; tested under Node (pod.test.mjs).
//
// THE SELLER SEES ONE NUMBER (rule 15). The only figures that pass through
// here are the server's `inkopMinor` and `priceFloorMinor` (podFigures of the
// product adapter: öre → kr, Inköp with the production VAT). Nothing here
// prices, and no field of a printer that is not a capability is copied.
//
// THE SERVER DECIDES WHETHER A FILE CAN BE PRINTED. An artwork's status,
// notices and reasons are shown as the API gives them; nothing here measures
// DPI or judges a format.

import { podFigures } from './product.js';

export { podFigures };

/** The print slots in the order the Worker lists them (cloudflare/src/pod/printers.ts PRINT_SLOTS). */
export const PRINT_SLOTS = Object.freeze(['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve']);

/** The name shown for an artwork the seller never named (rows older than migration 0048). */
export const UNNAMED_ARTWORK = 'Namnlöst original';

/** The longest name the API takes (artwork-routes.ts ARTWORK_LABEL_MAX_LENGTH). */
export const LABEL_MAX = 120;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// ── profiles ────────────────────────────────────────────────────────────────

/** GET /v1/admin/pod/profiles row → the profile the upload modal reads (the older settings/podProfiles shape). */
export function profileFromApi(p) {
  if (!isObj(p) || typeof p.profileId !== 'string') return null;
  return {
    id: p.profileId,
    label: typeof p.label === 'string' ? p.label : p.profileId,
    accepted_formats: list(p.acceptedFormats).filter((f) => isObj(f) && typeof f.ext === 'string'),
    max_file_mb: Number.isFinite(p.maxFileMb) ? p.maxFileMb : null,
    min_dpi: Number.isFinite(p.minDpi) ? p.minDpi : null,
    print_area_mm: isObj(p.printAreaMm) ? { w: p.printAreaMm.w, h: p.printAreaMm.h } : null,
  };
}

// ── artwork ─────────────────────────────────────────────────────────────────

/** A stored object's content type → the extension the library shows (PNG, JPG, …), or null. */
export function extOfContentType(contentType) {
  const m = /^[a-z]+\/([a-z0-9.+-]+)/i.exec(String(contentType ?? ''));
  if (!m) return null;
  const sub = m[1].toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  if (sub === 'x-icon' || sub === 'vnd.microsoft.icon') return 'ico';
  return /^[a-z0-9]{2,5}$/.test(sub) ? sub : null;
}

const tierOf = (status) => (status === 'ready' ? 'PASS' : status === 'rejected' ? 'FAIL' : undefined);

const messages = (v) =>
  list(v).filter((n) => isObj(n) && typeof n.message === 'string').map((n) => ({ code: typeof n.code === 'string' ? n.code : 'notice', message: n.message }));

/**
 * An artwork as the library reads it. `summary`: a row of the list (or the
 * detail itself); `detail`: GET …/artwork/:id's `artwork` (notices, reasons);
 * `previewUrl`: its short-lived preview address; `object`: the original's
 * metadata (GET /v1/admin/objects/:id: type, size, sha256). Each of the three
 * may be missing (a read that failed): the row then lacks that part, it is
 * never dropped.
 *
 * No print file and no original address: the print file is reached by the
 * print shop only, and the original is private (its content route needs the
 * shop header, which a link cannot send).
 */
export function artworkRow(summary, { detail = null, previewUrl = null, object = null } = {}) {
  const s = summary;
  const d = isObj(detail) ? detail : null;
  const label = typeof s.label === 'string' && s.label !== '' ? s.label : null;
  return {
    id: s.artworkId,
    label,
    fileName: UNNAMED_ARTWORK,
    purpose: s.profileId ?? null,
    status: s.status,
    sourceWidthPx: Number.isFinite(s.widthPx) ? s.widthPx : null,
    sourceHeightPx: Number.isFinite(s.heightPx) ? s.heightPx : null,
    validation: {
      effectiveDpi: Number.isFinite(s.effectiveDpi) ? s.effectiveDpi : null,
      notices: messages(d?.notices),
      reasons: messages(d?.reasons),
      tier: tierOf(s.status),
    },
    previewUrl: s.status === 'ready' && typeof previewUrl === 'string' ? previewUrl : null,
    printUrl: null,
    originalUrl: null,
    ext: extOfContentType(object?.contentType),
    fileSizeBytes: Number.isSafeInteger(object?.sizeBytes) ? object.sizeBytes : null,
    sha256: typeof object?.sha256 === 'string' ? object.sha256 : null,
    originalObjectId: s.originalObjectId ?? null,
    createdAt: Number.isFinite(s.createdAt) ? s.createdAt : null,
  };
}

/**
 * A render this tab saw start and that the server now answers as failed (its
 * row is gone from the list; only the detail still says "failed"). `tracked`:
 * what the tab remembers of it ({ artworkId, label, profileId, createdAt }).
 */
export function failedArtworkRow(tracked) {
  return {
    id: tracked.artworkId,
    label: tracked.label ?? null,
    fileName: UNNAMED_ARTWORK,
    purpose: tracked.profileId ?? null,
    status: 'failed',
    sourceWidthPx: null,
    sourceHeightPx: null,
    validation: { effectiveDpi: null, notices: [], reasons: [], tier: undefined },
    previewUrl: null,
    printUrl: null,
    originalUrl: null,
    ext: null,
    fileSizeBytes: null,
    sha256: null,
    originalObjectId: tracked.originalObjectId ?? null,
    createdAt: tracked.createdAt ?? null,
  };
}

/**
 * GET …/artwork/:id → where an upload stands:
 *   { state: 'processing' | 'ready' | 'rejected' | 'failed' | 'gone', notices, reasons }
 * (`gone`: the opaque 404: deleted, or never this shop's).
 */
export function renderState(answer) {
  if (!answer || !isObj(answer.artwork)) return { state: 'gone', notices: [], reasons: [] };
  const a = answer.artwork;
  const state = ['processing', 'ready', 'rejected', 'failed'].includes(a.status) ? a.status : 'processing';
  return { state, notices: messages(a.notices), reasons: messages(a.reasons) };
}

/**
 * The name an upload is sent with: the seller's, else the file's name
 * without its extension, cut to the API's 120 characters, with no control
 * characters (the API refuses them); null when nothing is left.
 */
export function uploadLabel(typed, fileName) {
  const base = String(typed ?? '').trim() || String(fileName ?? '').replace(/\.[a-z0-9]+$/i, '').trim();
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, LABEL_MAX).trim();
  return clean === '' ? null : clean;
}

/**
 * A rename typed by the seller → the PATCH body's label, or `undefined` when
 * nothing is to be written (cancelled, or the same name). An emptied name
 * clears it (null).
 */
export function renameValue(typed, current) {
  if (typed === null || typed === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = String(typed).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
  const next = clean === '' ? null : clean;
  if (next === (current ?? null)) return undefined;
  return next;
}

/** The delay before the next look at a render still processing: 2 s, doubling, at most 10 s. */
export function pollDelay(attempt) {
  return Math.min(10_000, 2_000 * 2 ** Math.max(0, attempt));
}

// ── printers and articles (capabilities only) ───────────────────────────────

/**
 * Can `model` print `slot`? Its own frame, or — for the pocket — a front
 * frame (the Worker's slotFrame: the pocket is a position inside the front).
 * What the page OFFERS; the mapping write and the quote decide.
 */
export function modelPrintsSlot(model, slot) {
  const areas = isObj(model?.printAreasMm) ? model.printAreasMm : {};
  if (isObj(areas[slot])) return true;
  return slot === 'pocket' && isObj(areas.front);
}

/**
 * GET /v1/admin/pod/printers → the choices of the mapping form:
 *   [{ printerId, name, articles: [{ sku, label, garment, modelName, provisional, slots }] }]
 * Only what a seller may see is read (name, articles, frames' existence).
 * Articles are grouped by garment and model, in the catalogue's order.
 */
export function printerChoices(printers) {
  return list(printers)
    .filter((p) => isObj(p) && typeof p.printerId === 'string')
    .map((p) => {
      const models = isObj(p.capabilities?.models) ? p.capabilities.models : {};
      const skus = isObj(p.capabilities?.skus) ? p.capabilities.skus : {};
      const articles = Object.entries(skus)
        .filter(([, entry]) => isObj(entry) && isObj(models[entry.model]))
        .map(([sku, entry]) => {
          const model = models[entry.model];
          return {
            sku,
            label: typeof entry.label === 'string' ? entry.label : null,
            garment: typeof model.garment === 'string' ? model.garment : null,
            modelName: typeof model.name === 'string' ? model.name : entry.model,
            provisional: model.provisional === true,
            slots: PRINT_SLOTS.filter((slot) => modelPrintsSlot(model, slot)),
          };
        })
        // By garment and model; within a model the catalogue's own order (stable sort).
        .sort((a, b) => `${a.garment ?? ''}\n${a.modelName}`.localeCompare(`${b.garment ?? ''}\n${b.modelName}`, 'sv'));
      return { printerId: p.printerId, name: typeof p.name === 'string' ? p.name : p.printerId, articles };
    });
}

/**
 * "Svart / M — T-shirt · Unisex Tee (2700003)": the article's own label first
 * (colour and size: what tells two articles of a model apart, and what a
 * narrow select still shows), then the garment and the model
 * (`garmentLabel` is config/podGarments.js's, injected).
 */
export function articleText(article, garmentLabel = (g) => g) {
  const kind = [article.garment ? garmentLabel(article.garment) : null, article.modelName].filter(Boolean).join(' · ');
  return `${article.label ? `${article.label} — ` : ''}${kind} (${article.sku})`;
}

// ── products for the picker ─────────────────────────────────────────────────

const scopeKey = (productId, variantId) => `${productId}\n${variantId ?? ''}`;

/**
 * The shop's products (list rows, each with its detail when read) → the
 * product picker's rows and how a picked SKU resolves:
 *   products  [{ id, sku, name, image, hasSku, priceMinor, variants: [{ sku, label, image, variantId, priceMinor }] }]
 *             (PodProductPicker's shape: the value is a SKU; a product's own
 *             SKU maps the whole product, a variant's SKU only that variant)
 *   skus      Set of every pickable SKU
 *   targets   Map SKU → { productId, variantId, name }
 *   byScope   Map "productId\nvariantId" → { sku, name }
 * Archived products are left out (a mapping on one is refused). A variant
 * that is inactive or has no SKU cannot be picked. A product whose detail
 * could not be read is listed with no variants (it can still be mapped whole).
 */
export function pickerProducts(entries) {
  const products = [];
  const targets = new Map();
  const byScope = new Map();
  for (const { item, detail } of list(entries)) {
    if (!isObj(item) || item.status === 'archived' || typeof item.productId !== 'string') continue;
    const sku = typeof item.sku === 'string' ? item.sku : '';
    const name = typeof item.name === 'string' ? item.name : '';
    const image = typeof item.image?.url === 'string' ? item.image.url : null;
    const imageRows = list(detail?.images);
    const variants = list(detail?.variants)
      .filter((v) => isObj(v) && v.active !== false && typeof v.sku === 'string' && v.sku !== '' && typeof v.variantId === 'string')
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((v) => {
        const label = [v.group, v.size].filter((x) => typeof x === 'string' && x.trim() !== '').join(' · ') || v.sku;
        const own = imageRows.find((row) => row?.variantId === v.variantId && typeof row?.image?.url === 'string');
        return {
          sku: v.sku, label, image: own ? own.image.url : null, variantId: v.variantId,
          priceMinor: Number.isSafeInteger(v.priceMinor) ? v.priceMinor : null,
        };
      });
    const priceMinor = Number.isSafeInteger(item.priceMinor) ? item.priceMinor : null;
    products.push({ id: item.productId, sku, name, image, hasSku: sku !== '', variants, priceMinor });
    byScope.set(scopeKey(item.productId, null), { sku, name });
    if (sku !== '') targets.set(sku, { productId: item.productId, variantId: null, name });
    for (const v of variants) {
      targets.set(v.sku, { productId: item.productId, variantId: v.variantId, name: `${name} — ${v.label}` });
      byScope.set(scopeKey(item.productId, v.variantId), { sku: v.sku, name: `${name} — ${v.label}` });
    }
  }
  products.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'sv'));
  return { products, skus: new Set(targets.keys()), targets, byScope };
}

/** A typed or picked SKU → { productId, variantId } (exact match only), or null. */
export function targetOfSku(targets, sku) {
  const key = String(sku ?? '').trim();
  return key === '' ? null : targets.get(key) ?? null;
}

// ── mappings as the list shows them ─────────────────────────────────────────

/** "Bröst + Rygg" (`slotLabel` is config/podSlots.js's, injected). */
export function slotsText(slots, slotLabel = (s) => s) {
  return list(slots).map((s) => slotLabel(typeof s === 'string' ? s : s?.slot)).join(' + ');
}

/**
 * GET /v1/admin/pod/mappings → the rows of the mapping list, in the older
 * row shape (sku = the seller's product or variant SKU, garment from the
 * printer's article), one row per mapping. A removed (inactive) mapping is
 * not listed. `problem`: what stops the mapping from being produced, said to
 * the seller, or null.
 *
 * context: { byScope, printers (printerChoices), artworkById, slotLabel }
 */
export function mappingRows(mappings, { byScope = new Map(), printers = [], artworkById = new Map(), slotLabel } = {}) {
  const printerById = new Map(list(printers).map((p) => [p.printerId, p]));
  return list(mappings)
    .filter((m) => isObj(m) && m.status !== 'inactive' && typeof m.mappingId === 'string')
    .map((m) => {
      const scope = byScope.get(scopeKey(m.productId, m.variantId ?? null));
      const printer = printerById.get(m.printerId);
      const article = printer?.articles.find((a) => a.sku === m.sku) ?? null;
      const art = artworkById.get(m.artworkId) ?? null;
      const slotIds = list(m.slots).map((s) => s?.slot).filter((s) => typeof s === 'string');
      let problem = null;
      if (m.status === 'suspended') {
        problem = 'Pausad — tryckeriet kan inte längre göra den här kopplingen. Ta bort den och lägg till den igen med en artikel och placering som går att trycka.';
      } else if (!article) {
        problem = 'Tryckeriet eller artikeln finns inte längre — ta bort kopplingen och koppla om produkten.';
      }
      return {
        id: m.mappingId,
        mappingId: m.mappingId,
        sku: scope?.sku || m.productId,
        productName: scope?.name ?? null,
        // The product's own name and SKU (a variant's row names the variant above).
        productTitle: byScope.get(scopeKey(m.productId, null))?.name || null,
        productSku: byScope.get(scopeKey(m.productId, null))?.sku || null,
        placementSlot: slotIds[0] ?? null,
        slotIds,
        slotsLabel: slotsText(slotIds, slotLabel),
        artworkId: m.artworkId,
        garment: article?.garment ?? null,
        profileId: art?.purpose ?? null,
        // The garment is already on the row (garmentLabel(garment)): the article without it.
        placement: article ? `${printer.name} · ${articleText({ ...article, garment: null })}` : '',
        status: m.status,
        problem,
        productId: m.productId,
        variantId: m.variantId ?? null,
        printerId: m.printerId,
        printerSku: m.sku,
      };
    });
}

/**
 * The "Används av" pills of the artwork library, per artwork (unit CP5-FP):
 * ONE pill per PRODUCT, however many of its variants print the artwork (a
 * studio product maps every variant, e.g. 65 on one row), with the count of
 * its variant mappings when there are several and every slot any of them
 * prints. → Map artworkId → [{ key, text, mono, variants, slots }]: `text` is
 * the product's name (else its SKU, in mono), `variants` the number of
 * variant mappings (0 when the product is mapped whole). `rows` are
 * mappingRows' rows; `slotLabel` is config/podSlots.js's.
 */
export function usagePillsByArtwork(rows, slotLabel = (s) => s) {
  const byArtwork = new Map();
  for (const row of list(rows)) {
    if (!isObj(row) || typeof row.artworkId !== 'string' || typeof row.productId !== 'string') continue;
    if (!byArtwork.has(row.artworkId)) byArtwork.set(row.artworkId, new Map());
    const products = byArtwork.get(row.artworkId);
    if (!products.has(row.productId)) {
      const name = row.productTitle || null;
      products.set(row.productId, {
        key: `${row.artworkId}\n${row.productId}`,
        text: name || row.productSku || row.sku || row.productId,
        mono: !name,
        variants: 0,
        slotIds: [],
      });
    }
    const pill = products.get(row.productId);
    if (row.variantId) pill.variants += 1;
    for (const slot of list(row.slotIds)) if (!pill.slotIds.includes(slot)) pill.slotIds.push(slot);
  }
  const out = new Map();
  for (const [artworkId, products] of byArtwork) {
    out.set(artworkId, [...products.values()].map(({ slotIds, ...pill }) => ({ ...pill, slots: slotsText(slotIds, slotLabel) })));
  }
  return out;
}

/**
 * The slots a new mapping's quote covers: the chosen ones plus those the
 * scope's other active mappings on the SAME printer and article already
 * print (the scope is one garment: its Inköp is the whole set's).
 */
export function scopeSlots(mappings, { productId, variantId = null, printerId, sku, slots }) {
  const taken = new Set(slots);
  for (const m of list(mappings)) {
    if (!isObj(m) || m.status !== 'active' || m.productId !== productId || (m.variantId ?? null) !== (variantId ?? null)) continue;
    if (m.printerId !== printerId || m.sku !== sku) continue;
    for (const s of list(m.slots)) if (typeof s?.slot === 'string') taken.add(s.slot);
  }
  return PRINT_SLOTS.filter((s) => taken.has(s));
}

// ── the quote, as the form shows it ─────────────────────────────────────────

const krText = (value) =>
  `${Number(value).toLocaleString('sv-SE', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(value) ? 0 : 2 })} kr`;

/** The server's quote → "Inköp 175 kr inkl. moms · prisgolv 253 kr", or null. */
export function quoteText(quote) {
  const f = podFigures(quote);
  return f ? `Inköp ${krText(f.inkopKr)} inkl. moms · prisgolv ${krText(f.floorKr)}` : null;
}

// ── the API's refusals, in the page's words ─────────────────────────────────

const SESSION_GONE = 'Sessionen har gått ut. Logga in igen.';

const MAPPING_REFUSALS = {
  price_below_floor: 'Produktens pris ligger under prisgolvet för den här kopplingen. Höj priset på produkten till minst prisgolvet och lägg till kopplingen igen.',
  artwork_not_ready: 'Originalet är inte godkänt (än). Välj ett original med status Godkänd.',
  printer_unavailable: 'Tryckeriet kan inte användas av butiken just nu. Välj ett annat tryckeri eller kontakta plattformen.',
  sku_unavailable: 'Artikeln går inte att beställa hos tryckeriet just nu. Välj en annan artikel.',
  slot_not_printable: 'Tryckeriet kan inte trycka på den placeringen för den här artikeln.',
  resolution_too_low: 'Originalet har för låg upplösning för den placeringen på den här artikeln.',
  slot_taken: 'Placeringen har redan ett original för den här produkten (eller varianten). Ta bort den kopplingen först.',
  sku_mismatch: 'Produkten (eller varianten) är redan kopplad till en annan artikel eller ett annat tryckeri. Den trycks på ett enda plagg: ta bort de andra kopplingarna först.',
  variant_mismatch: 'Originalet är redan kopplat till samma artikel på en annan nivå av produkten (hela produkten eller en variant). Ta bort den kopplingen först.',
  product_archived: 'Produkten är borttagen och kan inte kopplas.',
  // CP6-PS4: the article's model has only stand-in frames while the print canvas is on.
  pod_frame_unconfirmed: 'Tryckeriet har inte bekräftat tryckytan för det här plagget än, så det kan inte kopplas just nu. Välj ett annat plagg, eller försök igen när tryckeriet har bekräftat tryckytan.',
  pod_too_large: 'Produkten har för många aktiva varianter för att prisgolvet ska kunna kontrolleras (högst 200).',
  conflict: 'Produkten ändrades samtidigt. Försök igen.',
};

/** A mapping write's (or removal's) refusal → the sentence, or null for the page's own. */
export function mappingRefusalMessage(error, { removing = false } = {}) {
  const code = error?.code;
  if (code === 'unauthenticated') return SESSION_GONE;
  if (removing) {
    if (code === 'price_below_floor') {
      return 'Kopplingen kan inte tas bort: utan den hamnar ett pris under prisgolvet (en variant faller tillbaka på en dyrare koppling). Höj priset först eller avpublicera produkten.';
    }
    if (code === 'pod_too_large' || code === 'conflict') return MAPPING_REFUSALS[code];
    if (error?.status === 404) return 'Kopplingen finns inte längre. Ladda om sidan.';
    return null;
  }
  if (MAPPING_REFUSALS[code]) return MAPPING_REFUSALS[code];
  if (error?.status === 404) return 'Produkten, varianten eller originalet finns inte (längre). Ladda om sidan.';
  if (error?.status === 400) return 'Kopplingen kunde inte sparas: kontrollera produkt, artikel och placering.';
  return null;
}

/** The design quote's refusal → the sentence the form shows instead of a figure. */
export function quoteRefusalMessage(error) {
  const code = error?.code;
  if (code === 'unauthenticated') return SESSION_GONE;
  if (code === 'printer_unavailable' || code === 'sku_unavailable' || code === 'slot_not_printable') return MAPPING_REFUSALS[code];
  return 'Inköpspriset kunde inte hämtas just nu.';
}

/** An artwork call's refusal (upload, rename, removal) → the sentence, or null. */
export function artworkRefusalMessage(error, { step = 'upload' } = {}) {
  const code = error?.code;
  if (code === 'unauthenticated') return SESSION_GONE;
  if (code === 'rights_not_confirmed') return 'Bekräfta att du har rätt att använda motivet.';
  if (step === 'delete') {
    if (error?.status === 409) {
      return 'Originalet har använts i en tryckkoppling och kan inte tas bort — tryckfilen kan behövas för beställningar som redan finns.';
    }
    if (error?.status === 404) return 'Originalet finns inte längre. Ladda om sidan.';
    return null;
  }
  if (step === 'rename') {
    if (error?.status === 400) return `Namnet kan inte användas (1–${LABEL_MAX} tecken, inga radbrytningar).`;
    if (error?.status === 404) return 'Originalet finns inte längre. Ladda om sidan.';
    return null;
  }
  if (error?.status === 429 || code === 'rate_limited') return 'Du har laddat upp många filer på kort tid. Vänta en minut och försök igen.';
  if (error?.status === 413 || code === 'payload_too_large') return 'Filen är för stor (högst 100 MB).';
  if (error?.status === 400 && error.reason === 'bytes_not_as_declared') return 'Filen ändrades medan den laddades upp. Försök igen.';
  if (error?.status === 409) return 'Den här filen finns redan i biblioteket med samma tryckändamål.';
  if (error?.status === 404) return 'Filen eller tryckändamålet kunde inte användas. Ladda upp filen igen.';
  if (error?.status === 502 || code === 'artwork_unavailable') return 'Filen kunde inte bearbetas på servern — försök igen om en stund.';
  return null;
}
