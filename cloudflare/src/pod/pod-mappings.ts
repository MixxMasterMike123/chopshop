import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import {
  isScreeningConflict,
  readScreeningGuard,
  screeningFenceStatement,
  screeningStatementsFor,
  withScreeningRetry,
} from "../catalog/screening";
import type { PodQuote, TierFacts } from "./pod-quote";
import { podPriceFloorMinor, quoteFromTier, quotePodCost } from "./pod-quote";
import type {
  FlatFit,
  PrintArea,
  PrintSlot,
  Printer,
  PrinterEnvironment,
  PrinterItemFacts,
  PrinterProvider,
  PrinterRow,
} from "./printers";
import {
  DEFAULT_FLAT_BACKGROUND,
  DEFAULT_FLAT_FIT,
  flatAreaPx,
  flatReachesPx,
  isFlatBackground,
  isFlatFit,
  isStandInSku,
  loadUsablePrinter,
  PRINT_SLOTS,
  printerItemFacts,
  printerShipsTo,
  providerAllowedIn,
  providerTakesCollectedOrders,
  requiredSlotsOf,
  slotFrame,
  toPrinter,
} from "./printers";

/**
 * POD mappings — "product P prints artwork A on slots S of printer X's SKU K".
 *
 * The CF equivalent of Firebase `podMappings` + the parts of printProjection.ts
 * that resolve them (resolveSlots, artworkDeliverable, stampRouting). Keyed by
 * the product FK; a variant may carry its own mapping set (per-size printer
 * SKU), otherwise the product-level set applies — the one level of override
 * that replaces Firebase's longest-SKU-prefix match.
 *
 * INVARIANTS every write keeps (and the checkout freeze re-checks from current
 * facts, PLAN §2.3):
 *   - one scope (product, or product+variant) routes to ONE printer + ONE SKU
 *     (A4 "one order → one printer", and a line is one physical blank);
 *   - a slot is filled by at most one active mapping per scope;
 *   - every slot has a frame on the printer for that SKU (A3/A4) and is sized
 *     to fit it at the artwork's minimum DPI (docs/POD_PRINT_SPEC.md §2);
 *   - the SKU is priced for every slot (A1: nothing unrecoverable is sold).
 */

export type MappingStatus = "active" | "inactive" | "suspended";

export interface MappingSlot {
  /**
   * CP12 (flat prints only): the sheet colour around a contained motif or
   * under its transparency, `#rrggbb`. Stored on every flat slot (default
   * DEFAULT_FLAT_BACKGROUND); never on a garment's.
   */
  background?: string;
  /** CP12 (flat prints only): `contain` | `cover`, stored on every flat slot (default contain). */
  fit?: FlatFit;
  heightMm: number;
  slot: PrintSlot;
  widthMm: number;
}

/** CP12: the placement a mapping write may give one slot (flat prints only). */
export interface SlotPlacement {
  background?: string;
  fit?: FlatFit;
}

export interface PodMapping {
  artworkId: string;
  createdAt: string;
  mappingId: string;
  printerId: string;
  productId: string;
  sku: string;
  slots: MappingSlot[];
  status: MappingStatus;
  suspendedReason: string | null;
  updatedAt: string;
  variantId: string | null;
}

export interface CreateMappingInput {
  artworkId: string;
  /**
   * CP12: per-slot placement, from a `slots` entry written as an object
   * (`{ slot, fit?, background? }`). Only a flat model takes one; a garment
   * mapping that names one is refused `placement_unsupported`.
   */
  placements?: Partial<Record<PrintSlot, SlotPlacement>>;
  printerId: string;
  productId: string;
  sku: string;
  slots: PrintSlot[];
  variantId: string | null;
}

/** The two numbers a seller may see about a POD product (A13). */
export interface SellerQuote {
  currency: string;
  inkopMinor: number;
  priceFloorMinor: number;
}

export type RefusalCode =
  | "artwork_not_ready"
  | "currency_mismatch"
  /** CP6-PS4: the SKU's model has only stand-in frames while the print canvas is on. */
  | "pod_frame_unconfirmed"
  /** CP12: a placement (fit/background) on a slot of a garment model. */
  | "placement_unsupported"
  | "price_below_floor"
  | "printer_unavailable"
  | "resolution_too_low"
  | "sku_unavailable"
  | "slot_not_printable"
  | "unpriced";

export type ConflictCode =
  | "conflict"
  | "pod_too_large"
  | "product_archived"
  | "sku_mismatch"
  | "slot_taken"
  | "variant_mismatch";

export type CreateMappingResult =
  | { created: boolean; mapping: PodMapping; quote: SellerQuote; status: "ok" }
  | { code: ConflictCode; status: "conflict" }
  | { code: RefusalCode; status: "refused" }
  | { status: "not_found" };

/** docs/POD_PRINT_SPEC.md §2: the DPI floor when the artwork's profile is gone. */
export const DEFAULT_MIN_DPI = 300;

/**
 * NO SILENT TRUNCATION (Codex CP2 P2). Every read a money or production
 * decision depends on is either complete or refused — never a LIMIT that
 * quietly drops rows (a truncated scope once froze a front+back garment as
 * front-only; a truncated variant list once skipped a variant's price floor).
 *
 *   MAX_SCOPE_MAPPINGS   a scope's ACTIVE set fills distinct slots (createMapping
 *                        refuses slot_taken), so it can never exceed the slot
 *                        count; more rows is a broken invariant → refuse.
 *   MAX_GATE_VARIANTS    the variants one publish gate prices; more → refused
 *                        with `pod_too_large` rather than half-checked.
 *   MAX_PRODUCT_MAPPINGS one product's active + suspended mappings across all
 *                        its scopes; more → refused, never truncated.
 */
export const MAX_SCOPE_MAPPINGS = PRINT_SLOTS.length;
export const MAX_GATE_VARIANTS = 200;
export const MAX_PRODUCT_MAPPINGS = (MAX_GATE_VARIANTS + 1) * MAX_SCOPE_MAPPINGS;
const MM_PER_INCH = 25.4;

const ID_MAX_LENGTH = 128;
const SKU_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CREATE_KEYS = [
  "artworkId",
  "printerId",
  "productId",
  "sku",
  "slots",
  "variantId",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseId(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= ID_MAX_LENGTH
    ? value
    : null;
}

export function parseCreateMappingInput(body: unknown): CreateMappingInput | null {
  if (!isPlainObject(body) || !Object.keys(body).every((key) => (CREATE_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const productId = parseId(body.productId);
  const artworkId = parseId(body.artworkId);
  const printerId = parseId(body.printerId);
  const sku = typeof body.sku === "string" && SKU_PATTERN.test(body.sku) ? body.sku : null;
  const variantId =
    body.variantId === undefined || body.variantId === null ? null : parseId(body.variantId);
  if (
    productId === null ||
    artworkId === null ||
    printerId === null ||
    sku === null ||
    (body.variantId !== undefined && body.variantId !== null && variantId === null)
  ) {
    return null;
  }
  if (!Array.isArray(body.slots) || body.slots.length === 0 || body.slots.length > PRINT_SLOTS.length) {
    return null;
  }
  const slots: PrintSlot[] = [];
  const placements: Partial<Record<PrintSlot, SlotPlacement>> = {};
  for (const raw of body.slots) {
    // CP12: an entry is a slot name, or `{ slot, fit?, background? }` (a flat
    // print's placement; background `#rrggbb`, stored lower case).
    let slot: unknown = raw;
    if (isPlainObject(raw)) {
      if (!Object.keys(raw).every((key) => key === "background" || key === "fit" || key === "slot")) {
        return null;
      }
      const background = typeof raw.background === "string" ? raw.background.toLowerCase() : raw.background;
      if (
        (raw.fit !== undefined && !isFlatFit(raw.fit)) ||
        (background !== undefined && !isFlatBackground(background))
      ) {
        return null;
      }
      slot = raw.slot;
      if (raw.fit !== undefined || background !== undefined) {
        placements[slot as PrintSlot] = {
          ...(background === undefined ? {} : { background: background as string }),
          ...(raw.fit === undefined ? {} : { fit: raw.fit as FlatFit }),
        };
      }
    }
    // Duplicates are refused rather than collapsed: the caller described the
    // same print twice, which is a client bug, not a request to merge.
    if (!(PRINT_SLOTS as readonly unknown[]).includes(slot) || slots.includes(slot as PrintSlot)) {
      return null;
    }
    slots.push(slot as PrintSlot);
  }
  return {
    artworkId,
    ...(Object.keys(placements).length === 0 ? {} : { placements }),
    printerId,
    productId,
    sku,
    slots,
    variantId,
  };
}

/**
 * CP12: a flat slot's printed size in millimetres — the sheet under `cover`,
 * the contained motif's box (floored, at least 1 mm) under `contain` — from
 * the master's pixels and the sheet's exact pixel area. What the storefront's
 * print areas and the suspension check read; the canvas uses the pixels.
 */
export function flatSlotMm(
  sourcePx: { h: number; w: number },
  frame: PrintArea,
  areaPx: { h: number; w: number },
  fit: FlatFit,
): { heightMm: number; widthMm: number } {
  if (fit === "cover") {
    return { heightMm: frame.h, widthMm: frame.w };
  }
  const scale = Math.min(areaPx.w / sourcePx.w, areaPx.h / sourcePx.h);
  const motifW = Math.min(areaPx.w, Math.round(sourcePx.w * scale));
  const motifH = Math.min(areaPx.h, Math.round(sourcePx.h * scale));
  return {
    heightMm: Math.max(1, Math.floor((motifH / areaPx.h) * frame.h)),
    widthMm: Math.max(1, Math.floor((motifW / areaPx.w) * frame.w)),
  };
}

/**
 * The print size of an artwork in a frame: contain-fit (aspect preserved) — the
 * same geometry as the render pipeline's gate (render/src/pipeline.ts
 * maxPrintMmFor) — then capped at the width where the artwork still holds
 * `minDpi`. Floored to whole millimetres so the stored size is always inside the
 * frame and at or above the DPI floor. null when the result is under 1 mm.
 */
export function sizeSlot(
  widthPx: number,
  heightPx: number,
  frame: PrintArea,
  minDpi: number,
): { heightMm: number; widthMm: number } | null {
  if (!(widthPx > 0) || !(heightPx > 0) || !(minDpi > 0)) {
    return null;
  }
  const aspect = widthPx / heightPx;
  const containW = Math.min(frame.w, frame.h * aspect);
  const maxWAtDpi = (widthPx / minDpi) * MM_PER_INCH;
  const w = Math.min(containW, maxWAtDpi);
  const widthMm = Math.floor(w);
  const heightMm = Math.floor(w / aspect);
  return widthMm >= 1 && heightMm >= 1 ? { heightMm, widthMm } : null;
}

interface MappingRow {
  artwork_id: string;
  created_at: string;
  id: string;
  printer_id: string;
  product_id: string;
  sku: string;
  slots_json: string;
  status: MappingStatus;
  suspended_reason: string | null;
  updated_at: string;
  variant_id: string | null;
}

const MAPPING_COLUMNS = `id, product_id, variant_id, artwork_id, printer_id, sku,
     slots_json, status, suspended_reason, created_at, updated_at`;

function parseSlots(json: string): MappingSlot[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as MappingSlot[]) : [];
  } catch {
    return [];
  }
}

function toMapping(row: MappingRow): PodMapping {
  return {
    artworkId: row.artwork_id,
    createdAt: row.created_at,
    mappingId: row.id,
    printerId: row.printer_id,
    productId: row.product_id,
    sku: row.sku,
    slots: parseSlots(row.slots_json),
    status: row.status,
    suspendedReason: row.suspended_reason,
    updatedAt: row.updated_at,
    variantId: row.variant_id,
  };
}

/**
 * The product's ACTIVE and SUSPENDED mappings — every row a sale, a gate or a
 * quote can depend on — complete, or null when there are more than
 * MAX_PRODUCT_MAPPINGS (refuse, never truncate). Inactive rows are history and
 * are not read here.
 */
async function loadLiveMappings(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<PodMapping[] | null> {
  const result = await db
    .prepare(
      `SELECT ${MAPPING_COLUMNS}
       FROM pod_mappings
       WHERE tenant_id = ?
         AND product_id = ?
         AND status IN ('active', 'suspended')
       ORDER BY created_at, id
       LIMIT ${MAX_PRODUCT_MAPPINGS + 1}`,
    )
    .bind(tenantId, productId)
    .all<MappingRow>();
  return result.results.length > MAX_PRODUCT_MAPPINGS ? null : result.results.map(toMapping);
}

async function loadActiveMappings(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<PodMapping[] | null> {
  const live = await loadLiveMappings(db, tenantId, productId);
  return live === null ? null : live.filter((mapping) => mapping.status === "active");
}

// ── scopes ──────────────────────────────────────────────────────────────────

const PRODUCT_SCOPE = "";

function scopeKey(variantId: string | null): string {
  return variantId ?? PRODUCT_SCOPE;
}

function groupByScope(mappings: readonly PodMapping[]): Map<string, PodMapping[]> {
  const scopes = new Map<string, PodMapping[]>();
  for (const mapping of mappings) {
    const key = scopeKey(mapping.variantId);
    scopes.set(key, [...(scopes.get(key) ?? []), mapping]);
  }
  return scopes;
}

/** A variant's own set when it has one, else the product-level set. */
function setFor(
  scopes: Map<string, PodMapping[]>,
  variantId: string | null,
): PodMapping[] | undefined {
  return (variantId !== null ? scopes.get(variantId) : undefined) ?? scopes.get(PRODUCT_SCOPE);
}

/** One printer, one SKU, no slot twice — or null (a misconfigured set). */
function setRouting(
  set: readonly PodMapping[],
): { printerId: string; sku: string; slots: MappingSlot[] } | null {
  const first = set[0];
  if (first === undefined) {
    return null;
  }
  const slots: MappingSlot[] = [];
  for (const mapping of set) {
    if (mapping.printerId !== first.printerId || mapping.sku !== first.sku) {
      return null;
    }
    for (const slot of mapping.slots) {
      if (slots.some((existing) => existing.slot === slot.slot)) {
        return null;
      }
      slots.push(slot);
    }
  }
  return { printerId: first.printerId, sku: first.sku, slots };
}

async function quoteSet(
  db: D1Database,
  set: readonly PodMapping[],
  quantity: number,
): Promise<PodQuote | null> {
  const routing = setRouting(set);
  return routing === null
    ? null
    : quotePodCost(db, {
        printerId: routing.printerId,
        quantity,
        sku: routing.sku,
        slots: routing.slots.map((slot) => slot.slot),
      });
}

interface ProductFacts {
  b2c_price_minor: number;
  currency: string;
  is_pod: number;
  status: "active" | "archived" | "draft";
  takedown_at: string | null;
  vat_rate_bp: number;
}

async function loadProductFacts(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<ProductFacts | null> {
  return db
    .prepare(
      `SELECT product.b2c_price_minor, product.currency, product.is_pod,
              product.status, product.takedown_at, tenant.vat_rate_bp
       FROM products AS product
       INNER JOIN tenants AS tenant ON tenant.tenant_id = product.tenant_id
       WHERE product.tenant_id = ?
         AND product.product_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, productId)
    .first<ProductFacts>();
}

async function isProductLive(db: D1Database, tenantId: string, productId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS live
       FROM product_publications AS publication
       INNER JOIN products AS product
         ON product.product_id = publication.product_id
        AND product.tenant_id = publication.tenant_id
       WHERE publication.tenant_id = ?
         AND publication.product_id = ?
         AND publication.published = 1
         AND product.status = 'active'
       LIMIT 1`,
    )
    .bind(tenantId, productId)
    .first<{ live: number }>();
  return row !== null;
}

interface SellableUnit {
  priceMinor: number;
  /**
   * A unit the product cannot be sold without: the product itself when it has
   * no active variants, and every active variant. The BASE unit of a product
   * WITH variants is optional — checkout still sells it (a line without a
   * variantId is charged the base price), so it is floor-checked whenever a
   * product-level mapping set makes it producible, and skipped otherwise (the
   * freeze refuses it then).
   */
  required: boolean;
  variantId: string | null;
}

/**
 * Everything a buyer can put in a basket for this product, complete or null
 * (more than MAX_GATE_VARIANTS active variants — refused, never half-checked).
 *
 * Firebase checked the BASE price against the floor on every publish
 * (PublishPanel.jsx `validPrice`, ProductForm.jsx `mainPrice < podFloor`) in
 * addition to each colourway override, because its storefront could sell the
 * base product. So does this gate: the base unit is always in the list.
 */
async function loadSellableUnits(
  db: D1Database,
  tenantId: string,
  productId: string,
  productPriceMinor: number,
): Promise<SellableUnit[] | null> {
  const variants = await db
    .prepare(
      `SELECT variant_id, price_minor
       FROM product_variants
       WHERE tenant_id = ? AND product_id = ? AND active = 1
       ORDER BY variant_id
       LIMIT ${MAX_GATE_VARIANTS + 1}`,
    )
    .bind(tenantId, productId)
    .all<{ price_minor: number; variant_id: string }>();
  if (variants.results.length > MAX_GATE_VARIANTS) {
    return null;
  }
  return [
    {
      priceMinor: productPriceMinor,
      required: variants.results.length === 0,
      variantId: null,
    },
    ...variants.results.map((variant) => ({
      priceMinor: variant.price_minor,
      required: true,
      variantId: variant.variant_id,
    })),
  ];
}

export type PodGateFailure =
  | "currency_mismatch"
  /** CP6-PS4: an active mapping routes to a stand-in model while the print canvas is on. */
  | "pod_frame_unconfirmed"
  | "pod_mapping_missing"
  | "pod_mapping_suspended"
  /** CP11 U7 (audit F2): a mapping set leaves out a slot its printer requires (Prodigi: front). */
  | "pod_required_slot_missing"
  /** CP12: a flat print's artwork does not reach its sheet's pixels under its fit (flatReachesPx). */
  | "pod_resolution_too_low"
  | "pod_too_large"
  | "pod_unpriced"
  | "price_below_floor";

/**
 * The admin-facing sentence for a POD refusal code — what to do next. The
 * `pod_too_large` one names the exit explicitly, so a product imported with
 * more variants than one gate checks is never silently stranded.
 *
 * TENANT-VISIBLE (A13, "never show our hand", CP3-C review): each sentence
 * says what the seller can do, never how the platform prices — no price rows,
 * tiers, printer currency, supplier or cost. test/printers-platform.test.ts
 * walks every one of these texts.
 */
export function podRefusalMessage(code: string): string {
  switch (code) {
    case "pod_too_large":
      return `The product has more than ${MAX_GATE_VARIANTS} active variants, so its price floor cannot be checked. Unpublish it and reduce its active variants to ${MAX_GATE_VARIANTS} or fewer, then change it and publish again.`;
    case "pod_mapping_suspended":
      return "A print mapping is suspended because the printer can no longer make it. Re-post or delete that mapping first.";
    case "pod_mapping_missing":
      return "A sellable variant has no active print mapping.";
    case "pod_unpriced":
      return "The printer cannot make this product with its current print mappings. Re-post or delete the mappings, or contact support.";
    case "currency_mismatch":
      return "The printer cannot make this product as it is set up. Contact support.";
    case "pod_frame_unconfirmed":
      return "The printer has not confirmed the print area for this garment yet, so it cannot be sold now. Choose another garment, or try again once the printer has confirmed it.";
    case "pod_required_slot_missing":
      return "This garment must have a print on the front. Add a front print to every print mapping of the product, then publish again.";
    case "pod_resolution_too_low":
      return "The motif's resolution is too low for one of the print sizes. Remove that size, or upload the motif in a higher resolution, then publish again.";
    case "price_below_floor":
      return "The price is below this product's price floor. Raise it to at least the floor shown with the product's print quote.";
    case "taken_down":
      return "The product has been taken down by the platform.";
    default:
      return "Product cannot be published";
  }
}

/**
 * The POD publish gate (PRISGOLV + "no mapping, no sale"), evaluated per
 * sellable unit against its mapping set. Port of the PublishPanel.jsx /
 * ProductForm.jsx rules: a POD product without a connection can be saved but
 * never live, and no price (base or per-variant) may sit under the floor.
 *
 * `mappings` / `productPriceMinor` let a caller evaluate a state it is about to
 * write (a new mapping, a new price) before writing it. `onlyScope` limits the
 * check to units served by one scope — a mapping edit must not be refused for a
 * problem in a scope it does not touch.
 *
 * `refuseStandInFrames` (CP6-PS4; the publish route passes the print canvas
 * switch): a product with ANY active mapping on a stand-in model
 * (isStandInSku) is refused `pod_frame_unconfirmed` — product-wide, whatever
 * `onlyScope` says, because THE public predicate hides the whole product then
 * (eligibility.ts STAND_IN_FRAME_TERM). Checked LAST, after every other rule
 * passed: a caller that acts on only some codes (deleteMapping, the live
 * mapping edit) never loses the floor check to an earlier return.
 *
 * CP11 U7 (audit F2): every active mapping set must print each slot its
 * printer requires for its SKU (requiredSlotsOf: Prodigi's `front`), or the
 * product is refused `pod_required_slot_missing` — product-wide, after the
 * floor rules and before the stand-in rule, for the same reason. A back-only
 * Prodigi garment is thereby never published; checkout's line resolution
 * refuses it again (decideProductionLine) and the Prodigi body builder is the
 * last guard (`front_missing`).
 */
export async function evaluatePodGate(
  db: D1Database,
  tenantId: string,
  productId: string,
  options: {
    mappings?: readonly PodMapping[];
    onlyScope?: string | null;
    productPriceMinor?: number;
    refuseStandInFrames?: boolean;
  } = {},
): Promise<PodGateFailure | null> {
  const product = await loadProductFacts(db, tenantId, productId);
  if (product === null) {
    return "pod_mapping_missing";
  }
  let mappings = options.mappings;
  if (mappings === undefined) {
    const all = await loadLiveMappings(db, tenantId, productId);
    if (all === null) {
      return "pod_too_large";
    }
    // A suspended mapping means the product as designed cannot be made (a
    // routing edit took its slot, SKU or price away). It blocks the WHOLE
    // product until the seller re-posts or removes it — selling the remaining
    // prints would silently drop one.
    if (all.some((mapping) => mapping.status === "suspended")) {
      return "pod_mapping_suspended";
    }
    mappings = all;
  }
  const scopes = groupByScope(mappings.filter((mapping) => mapping.status === "active"));
  const units = await loadSellableUnits(
    db,
    tenantId,
    productId,
    options.productPriceMinor ?? product.b2c_price_minor,
  );
  if (units === null) {
    return "pod_too_large";
  }

  for (const unit of units) {
    const set = setFor(scopes, unit.variantId);
    if (options.onlyScope !== undefined) {
      const servedBy =
        unit.variantId !== null && scopes.has(unit.variantId) ? unit.variantId : PRODUCT_SCOPE;
      if (servedBy !== scopeKey(options.onlyScope)) {
        continue;
      }
    }
    if (set === undefined) {
      if (!unit.required) {
        // The base purchase of a variant product with no product-level set:
        // not producible, so not sellable (the freeze refuses it) — no floor.
        continue;
      }
      return "pod_mapping_missing";
    }
    const quote = await quoteSet(db, set, 1);
    if (quote === null) {
      return "pod_unpriced";
    }
    if (quote.breakdown.currency !== product.currency) {
      return "currency_mismatch";
    }
    const floor = podPriceFloorMinor(quote, product.vat_rate_bp);
    if (floor === null || unit.priceMinor < floor) {
      return "price_below_floor";
    }
  }
  if (await missesRequiredSlot(db, scopes)) {
    return "pod_required_slot_missing";
  }
  if (await flatBelowResolution(db, tenantId, [...scopes.values()].flat())) {
    return "pod_resolution_too_low";
  }
  if (options.refuseStandInFrames === true && (await routesToStandIn(db, mappings))) {
    return "pod_frame_unconfirmed";
  }
  return null;
}

/**
 * The printers `mappings` route to, by id, whatever their status: one read,
 * complete (the ids are the mappings' own). A row that does not parse maps to
 * null.
 */
async function printersOf(
  db: D1Database,
  mappings: readonly PodMapping[],
): Promise<Map<string, Printer | null>> {
  const printerIds = [...new Set(mappings.map((mapping) => mapping.printerId))];
  if (printerIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .prepare(
      `SELECT id, tenant_id, type, provider, name, status, currency, shipping_cost_minor, capabilities_json
       FROM printers
       WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(printerIds))
    .all<PrinterRow>();
  return new Map(rows.results.map((row) => [row.id, toPrinter(row)]));
}

/**
 * Whether any ACTIVE one of `mappings` routes to a stand-in model on its
 * printer (isStandInSku), whatever the printer's status: the SQL twin joins
 * the printer by id alone.
 */
async function routesToStandIn(db: D1Database, mappings: readonly PodMapping[]): Promise<boolean> {
  const active = mappings.filter((mapping) => mapping.status === "active");
  const printers = await printersOf(db, active);
  return active.some((mapping) => {
    const printer = printers.get(mapping.printerId);
    return printer !== null && printer !== undefined && isStandInSku(printer.capabilities, mapping.sku);
  });
}

/**
 * CP11 U7 (audit F2): whether some scope's set (already active-only) leaves
 * out a slot its printer requires for its SKU. A set that does not route to
 * one printer + SKU, or names a printer that cannot be read, is judged by the
 * gate's other rules, not here.
 */
async function missesRequiredSlot(
  db: D1Database,
  scopes: ReadonlyMap<string, PodMapping[]>,
): Promise<boolean> {
  const sets = [...scopes.values()];
  const printers = await printersOf(db, sets.flat());
  return sets.some((set) => {
    const routing = setRouting(set);
    const printer = routing === null ? null : (printers.get(routing.printerId) ?? null);
    if (routing === null || printer === null) {
      return false;
    }
    return requiredSlotsOf(printer.provider, printer.capabilities, routing.sku).some(
      (slot) => !routing.slots.some((mapped) => mapped.slot === slot),
    );
  });
}

/**
 * CP12 (D5): whether some ACTIVE mapping on a flat model has an artwork that
 * does not reach the sheet's pixels under its fit — the printer's sheet may
 * have changed since the mapping was written (a catalogue re-apply), which
 * the suspension check (millimetres) does not see. An artwork without
 * measured pixels counts as not reaching. Mappings on garments: not judged.
 */
async function flatBelowResolution(
  db: D1Database,
  tenantId: string,
  mappings: readonly PodMapping[],
): Promise<boolean> {
  const active = mappings.filter((mapping) => mapping.status === "active");
  const printers = await printersOf(db, active);
  const flat = active.flatMap((mapping) => {
    const printer = printers.get(mapping.printerId);
    const sheet = printer === null || printer === undefined ? null : flatAreaPx(printer.capabilities, mapping.sku);
    return sheet === null ? [] : [{ mapping, sheet }];
  });
  if (flat.length === 0) {
    return false;
  }
  const rows = await db
    .prepare(
      `SELECT artwork_id, width_px, height_px FROM pod_artwork
       WHERE tenant_id = ? AND artwork_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(tenantId, JSON.stringify([...new Set(flat.map((entry) => entry.mapping.artworkId))]))
    .all<{ artwork_id: string; height_px: number | null; width_px: number | null }>();
  const pixels = new Map(rows.results.map((row) => [row.artwork_id, row]));
  return flat.some(({ mapping, sheet }) => {
    const artwork = pixels.get(mapping.artworkId);
    if (artwork === undefined || !isPositivePx(artwork.width_px) || !isPositivePx(artwork.height_px)) {
      return true;
    }
    const source = { h: artwork.height_px, w: artwork.width_px };
    return mapping.slots.some((slot) => !flatReachesPx(source, sheet, slot.fit ?? DEFAULT_FLAT_FIT));
  });
}

async function sellerQuoteFor(
  db: D1Database,
  set: readonly PodMapping[],
  vatRateBp: number,
): Promise<SellerQuote | null> {
  const routing = setRouting(set);
  return routing === null
    ? null
    : sellerQuoteForChoice(
        db,
        { printerId: routing.printerId, sku: routing.sku, slots: routing.slots.map((slot) => slot.slot) },
        vatRateBp,
      );
}

/**
 * THE seller quote of one printer + SKU + slots at quantity 1: Inköp (the
 * production cost of one item, ex VAT) and the D41 floor over it. The ONE
 * formula behind the mapping write's floor check, the product quote
 * (sellerQuoteFor, through a mapping set's routing) and the studio's
 * design-time quote (designQuote) — none of them prices any other way.
 */
async function sellerQuoteForChoice(
  db: D1Database,
  choice: { printerId: string; sku: string; slots: readonly PrintSlot[] },
  vatRateBp: number,
): Promise<SellerQuote | null> {
  const quote = await quotePodCost(db, { ...choice, quantity: 1 });
  if (quote === null) {
    return null;
  }
  const floor = podPriceFloorMinor(quote, vatRateBp);
  return floor === null
    ? null
    : {
        currency: quote.breakdown.currency,
        // "Inköp" = the production cost of ONE item, ex VAT — the single number
        // the seller prices against (A13). The UI converts to inkl. moms at the
        // edge (podPricing.js inklMoms), never the stored number.
        inkopMinor: quote.productionCostMinor,
        priceFloorMinor: floor,
      };
}

export type QuoteResult =
  | { quote: SellerQuote; status: "ok" }
  | { status: "not_found" | "not_quotable" };

/** GET /v1/admin/pod/quote — the seller's ONE number (+ the floor). */
export async function quoteForProduct(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  variantId: string | null,
): Promise<QuoteResult> {
  const product = await loadProductFacts(db, principal.tenantId, productId);
  if (product === null) {
    return { status: "not_found" };
  }
  if (variantId !== null) {
    const variant = await db
      .prepare(
        `SELECT 1 AS present FROM product_variants
         WHERE tenant_id = ? AND product_id = ? AND variant_id = ? LIMIT 1`,
      )
      .bind(principal.tenantId, productId, variantId)
      .first();
    if (variant === null) {
      return { status: "not_found" };
    }
  }
  const active = await loadActiveMappings(db, principal.tenantId, productId);
  if (active === null) {
    return { status: "not_quotable" };
  }
  const set = setFor(groupByScope(active), variantId);
  const quote = set === undefined ? null : await sellerQuoteFor(db, set, product.vat_rate_bp);
  return quote === null ? { status: "not_quotable" } : { quote, status: "ok" };
}

// ── the studio's design-time quote (CP5-WG) ─────────────────────────────────

export interface DesignQuoteInput {
  printerId: string;
  sku: string;
  slots: PrintSlot[];
}

const DESIGN_QUOTE_PARAMS = ["printerId", "sku", "slots"] as const;

/**
 * `?printerId=&sku=&slots=front,back` — each parameter exactly once, nothing
 * else. The same grammar as a mapping's body (parseCreateMappingInput): an id
 * of 1–128 characters, a SKU key, 1–5 known slots with none twice.
 */
export function parseDesignQuoteQuery(params: URLSearchParams): DesignQuoteInput | null {
  for (const key of new Set(params.keys())) {
    if (!(DESIGN_QUOTE_PARAMS as readonly string[]).includes(key)) {
      return null;
    }
  }
  if (DESIGN_QUOTE_PARAMS.some((key) => params.getAll(key).length !== 1)) {
    return null;
  }
  const printerId = parseId(params.get("printerId"));
  const rawSku = params.get("sku");
  const sku = rawSku !== null && SKU_PATTERN.test(rawSku) ? rawSku : null;
  const rawSlots = (params.get("slots") ?? "").split(",");
  if (printerId === null || sku === null || rawSlots.length > PRINT_SLOTS.length) {
    return null;
  }
  const slots: PrintSlot[] = [];
  for (const slot of rawSlots) {
    if (!(PRINT_SLOTS as readonly string[]).includes(slot) || slots.includes(slot as PrintSlot)) {
      return null;
    }
    slots.push(slot as PrintSlot);
  }
  return { printerId, sku, slots };
}

export type DesignQuoteResult =
  | { quote: SellerQuote; status: "ok" }
  | { code: "currency_mismatch" | "printer_unavailable" | "sku_unavailable" | "slot_not_printable" | "unpriced"; status: "refused" }
  | { status: "not_found" };

/**
 * GET /v1/admin/pod/design-quote — the seller's ONE number (+ the floor) for
 * a printer, SKU and slots chosen BEFORE any product or mapping exists (the
 * studio, the mapping page before a save).
 *
 * The same checks, in the same order, as a mapping write (createMappingOnce)
 * minus the artwork and the product: the printer must be one this shop may
 * map to, the SKU in its catalogue, every slot printable on it; then the ONE
 * formula (sellerQuoteForChoice); then the shop's currency against the
 * printer's (a mapping compares the product's, which is the shop's). The
 * refusal codes are the mapping's precise ones; the route masks `unpriced`
 * and `currency_mismatch` exactly as it masks them on a mapping.
 */
export async function designQuote(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: DesignQuoteInput,
): Promise<DesignQuoteResult> {
  const tenant = await db
    .prepare("SELECT default_currency, vat_rate_bp FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(principal.tenantId)
    .first<{ default_currency: string; vat_rate_bp: number }>();
  if (tenant === null) {
    return { status: "not_found" };
  }
  const printer: Printer | null = await loadUsablePrinter(db, principal.tenantId, input.printerId);
  if (printer === null) {
    return { code: "printer_unavailable", status: "refused" };
  }
  if (printer.capabilities.skus[input.sku] === undefined) {
    return { code: "sku_unavailable", status: "refused" };
  }
  for (const slot of input.slots) {
    if (slotFrame(printer.capabilities, input.sku, slot) === null) {
      return { code: "slot_not_printable", status: "refused" };
    }
  }
  const quote = await sellerQuoteForChoice(db, input, tenant.vat_rate_bp);
  if (quote === null) {
    return { code: "unpriced", status: "refused" };
  }
  if (quote.currency !== tenant.default_currency) {
    return { code: "currency_mismatch", status: "refused" };
  }
  return { quote, status: "ok" };
}

function auditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  action: string,
  mappingId: string,
  now: number,
  metadata: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'pod_mapping', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      mappingId,
      crypto.randomUUID(),
      auditMetadataJson(principal, metadata),
      now,
    );
}

interface ArtworkFacts {
  height_px: number | null;
  profile_min_dpi: number | null;
  status: "processing" | "ready" | "rejected";
  width_px: number | null;
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

/**
 * POST /v1/admin/pod/mappings. Every check runs against current facts, then
 * ONE batch writes the mapping, marks the product POD (sticky: a POD product
 * can never again be sold without a mapping), re-screens the product when it
 * is live (PLAN §2.4 — the artwork names it screens changed), and audits.
 * Posting an existing (product, artwork, printer, SKU) tuple re-activates it
 * with the requested slots.
 *
 * Guarded by the product's screening fence (src/catalog/screening.ts): a
 * decision, an edit or another mapping change landing between the reads and
 * the batch rolls the batch back whole; it is re-run once, then answered as a
 * `conflict`.
 *
 * `refuseStandInFrames` (CP6-PS4; the route passes the print canvas switch):
 * a SKU whose model has only stand-in frames (isStandInSku) is refused
 * `pod_frame_unconfirmed`, on a draft as on a live product, like the other
 * refusals of the printer's side (the SKU, the slots, the price). Absent or
 * false = as before.
 */
export async function createMapping(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: CreateMappingInput,
  now: number,
  options: { refuseStandInFrames?: boolean } = {},
): Promise<CreateMappingResult> {
  return withScreeningRetry<CreateMappingResult>(
    now,
    (attemptNow) =>
      createMappingOnce(db, principal, input, attemptNow, options.refuseStandInFrames === true),
    () => ({ code: "conflict", status: "conflict" }),
  );
}

async function createMappingOnce(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: CreateMappingInput,
  now: number,
  refuseStandInFrames: boolean,
): Promise<CreateMappingResult> {
  const tenantId = principal.tenantId;
  // FIRST, before any content read (THE FENCE).
  const guard = await readScreeningGuard(db, tenantId, input.productId);
  const product = await loadProductFacts(db, tenantId, input.productId);
  if (product === null) {
    return { status: "not_found" };
  }
  if (product.status === "archived") {
    return { code: "product_archived", status: "conflict" };
  }
  if (input.variantId !== null) {
    const variant = await db
      .prepare(
        `SELECT 1 AS present FROM product_variants
         WHERE tenant_id = ? AND product_id = ? AND variant_id = ? LIMIT 1`,
      )
      .bind(tenantId, input.productId, input.variantId)
      .first();
    if (variant === null) {
      return { status: "not_found" };
    }
  }

  const artwork = await db
    .prepare(
      `SELECT artwork.status, artwork.width_px, artwork.height_px,
              profile.min_dpi AS profile_min_dpi
       FROM pod_artwork AS artwork
       LEFT JOIN pod_profiles AS profile ON profile.profile_id = artwork.profile_id
       WHERE artwork.tenant_id = ? AND artwork.artwork_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, input.artworkId)
    .first<ArtworkFacts>();
  if (artwork === null) {
    return { status: "not_found" };
  }
  if (artwork.status !== "ready" || artwork.width_px === null || artwork.height_px === null) {
    return { code: "artwork_not_ready", status: "refused" };
  }

  const printer: Printer | null = await loadUsablePrinter(db, tenantId, input.printerId);
  if (printer === null) {
    return { code: "printer_unavailable", status: "refused" };
  }
  if (printer.capabilities.skus[input.sku] === undefined) {
    return { code: "sku_unavailable", status: "refused" };
  }
  if (refuseStandInFrames && isStandInSku(printer.capabilities, input.sku)) {
    return { code: "pod_frame_unconfirmed", status: "refused" };
  }

  // The artwork's verdict is the input here, never re-measured: width/height in
  // pixels come from the render pipeline (render-jobs.ts writes them with the
  // 'ready' verdict), and the DPI floor is the artwork's own profile's.
  const minDpi = artwork.profile_min_dpi ?? DEFAULT_MIN_DPI;
  // CP12: a flat SKU (a poster) prints its one slot into the sheet's exact
  // pixels; the master must reach them under the chosen fit (flatReachesPx).
  const sheetPx = flatAreaPx(printer.capabilities, input.sku);
  const slots: MappingSlot[] = [];
  for (const slot of input.slots) {
    const frame = slotFrame(printer.capabilities, input.sku, slot);
    if (frame === null) {
      return { code: "slot_not_printable", status: "refused" };
    }
    const placement = input.placements?.[slot];
    if (sheetPx === null) {
      if (placement !== undefined) {
        return { code: "placement_unsupported", status: "refused" };
      }
      const size = sizeSlot(artwork.width_px, artwork.height_px, frame, minDpi);
      if (size === null) {
        return { code: "resolution_too_low", status: "refused" };
      }
      slots.push({ heightMm: size.heightMm, slot, widthMm: size.widthMm });
      continue;
    }
    const fit = placement?.fit ?? DEFAULT_FLAT_FIT;
    const source = { h: artwork.height_px, w: artwork.width_px };
    if (!flatReachesPx(source, sheetPx, fit)) {
      return { code: "resolution_too_low", status: "refused" };
    }
    const size = flatSlotMm(source, frame, sheetPx, fit);
    slots.push({
      background: placement?.background ?? DEFAULT_FLAT_BACKGROUND,
      fit,
      heightMm: size.heightMm,
      slot,
      widthMm: size.widthMm,
    });
  }

  // The tuple by its UNIQUE key (any status — an inactive row is re-activated),
  // and the live set complete (loadLiveMappings refuses rather than truncate).
  const tupleRow = await db
    .prepare(
      `SELECT ${MAPPING_COLUMNS} FROM pod_mappings
       WHERE tenant_id = ? AND product_id = ? AND artwork_id = ? AND printer_id = ? AND sku = ?
       LIMIT 1`,
    )
    .bind(tenantId, input.productId, input.artworkId, input.printerId, input.sku)
    .first<MappingRow>();
  const tuple = tupleRow === null ? undefined : toMapping(tupleRow);
  if (tuple !== undefined && tuple.variantId !== input.variantId) {
    return { code: "variant_mismatch", status: "conflict" };
  }
  const live = await loadLiveMappings(db, tenantId, input.productId);
  if (live === null) {
    return { code: "pod_too_large", status: "conflict" };
  }

  const scope = scopeKey(input.variantId);
  const others = live.filter(
    (mapping) => mapping.status === "active" && mapping.mappingId !== tuple?.mappingId,
  );
  for (const mapping of others) {
    if (scopeKey(mapping.variantId) !== scope) {
      continue;
    }
    if (mapping.printerId !== input.printerId || mapping.sku !== input.sku) {
      return { code: "sku_mismatch", status: "conflict" };
    }
    if (mapping.slots.some((existing) => input.slots.includes(existing.slot))) {
      return { code: "slot_taken", status: "conflict" };
    }
  }

  const iso = new Date(now).toISOString();
  const mapping: PodMapping = {
    artworkId: input.artworkId,
    createdAt: tuple?.createdAt ?? iso,
    mappingId: tuple?.mappingId ?? crypto.randomUUID(),
    printerId: input.printerId,
    productId: input.productId,
    sku: input.sku,
    slots,
    status: "active",
    suspendedReason: null,
    // Exactly what the row will hold: a re-activation stores
    // max(now, created_at) (a clock behind the row's creator is clamped).
    updatedAt: tuple !== undefined && tuple.createdAt > iso ? tuple.createdAt : iso,
    variantId: input.variantId,
  };
  const nextActive = [...others, mapping];
  const scopeSet = nextActive.filter((candidate) => scopeKey(candidate.variantId) === scope);

  const quote = await sellerQuoteFor(db, scopeSet, product.vat_rate_bp);
  if (quote === null) {
    return { code: "unpriced", status: "refused" };
  }
  if (quote.currency !== product.currency) {
    return { code: "currency_mismatch", status: "refused" };
  }

  const productLive = await isProductLive(db, tenantId, input.productId);
  if (productLive) {
    // A mapping edit on a LIVE product is a re-publish of that scope: the new
    // cost must not leave any price in it under the floor (PRISGOLV).
    const failure = await evaluatePodGate(db, tenantId, input.productId, {
      mappings: nextActive,
      onlyScope: input.variantId,
    });
    if (failure === "price_below_floor") {
      return { code: "price_below_floor", status: "refused" };
    }
    // The gate could not price every unit of this live product (more
    // variants than it checks completely), so it cannot vouch that the new
    // cost keeps them above the floor: refused, never treated as a pass.
    if (failure === "pod_too_large") {
      return { code: "pod_too_large", status: "conflict" };
    }
  }

  const statements: D1PreparedStatement[] = [
    tuple === undefined
      ? db
          .prepare(
            `INSERT INTO pod_mappings (
               id, tenant_id, product_id, variant_id, artwork_id, printer_id, sku,
               slots_json, status, suspended_reason, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
          )
          .bind(
            mapping.mappingId,
            tenantId,
            input.productId,
            input.variantId,
            input.artworkId,
            input.printerId,
            input.sku,
            JSON.stringify(slots),
            iso,
            iso,
          )
      : db
          .prepare(
            `UPDATE pod_mappings
             SET status = 'active', suspended_reason = NULL, slots_json = ?,
                 updated_at = max(?, created_at)
             WHERE tenant_id = ? AND id = ?`,
          )
          .bind(JSON.stringify(slots), iso, tenantId, mapping.mappingId),
    // Every mapping write moves products.updated_at strictly forward: it is
    // screened content (artwork names), and a concurrent FIRST publish of this
    // product fences on that column (publishAdminProduct).
    db
      .prepare(
        `UPDATE products SET is_pod = 1, updated_at = max(?, updated_at + 1)
         WHERE tenant_id = ? AND product_id = ?`,
      )
      .bind(now, tenantId, input.productId),
  ];

  if (productLive) {
    const screening = await screeningStatementsFor(db, {
      artworkIds: nextActive.map((candidate) => candidate.artworkId),
      guard,
      now,
    });
    statements.push(...screening.statements);
  } else {
    statements.push(screeningFenceStatement(db, guard, now));
  }

  statements.push(
    auditStatement(
      db,
      principal,
      tuple === undefined ? "pod.mapping.create" : "pod.mapping.activate",
      mapping.mappingId,
      now,
      {
        artworkId: input.artworkId,
        printerId: input.printerId,
        productId: input.productId,
        sku: input.sku,
        slots: input.slots,
        variantId: input.variantId,
      },
    ),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (!isScreeningConflict(error) && isUniqueConstraintFailure(error)) {
      return { code: "conflict", status: "conflict" };
    }
    throw error;
  }

  return { created: tuple === undefined, mapping, quote, status: "ok" };
}

export async function listMappings(
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string | null,
): Promise<PodMapping[]> {
  if (productId !== null) {
    // A DISPLAY list (every status, newest last); nothing is decided from it.
    const rows = await db
      .prepare(
        `SELECT ${MAPPING_COLUMNS} FROM pod_mappings
         WHERE tenant_id = ? AND product_id = ?
         ORDER BY created_at, id
         LIMIT 500`,
      )
      .bind(principal.tenantId, productId)
      .all<MappingRow>();
    return rows.results.map(toMapping);
  }
  const result = await db
    .prepare(
      `SELECT ${MAPPING_COLUMNS}
       FROM pod_mappings
       WHERE tenant_id = ?
       ORDER BY created_at DESC, id
       LIMIT 500`,
    )
    .bind(principal.tenantId)
    .all<MappingRow>();
  return result.results.map(toMapping);
}

/**
 * DELETE /v1/admin/pod/mappings/:id — soft: status 'inactive'. The row stays so
 * the artwork (and with it the print master) remains referenced. Re-screens a
 * live product in the same batch; the catalog_version bump (a live POD product
 * that loses its last mapping leaves the storefront) is the trigger's. Fenced
 * and retried like createMapping; a second conflict answers `conflict` (409).
 */
export type DeleteMappingResult =
  | { code: "pod_too_large" | "price_below_floor"; status: "refused" }
  | { status: "conflict" | "not_found" | "ok" };

export async function deleteMapping(
  db: D1Database,
  principal: TenantAdminPrincipal,
  mappingId: string,
  now: number,
): Promise<DeleteMappingResult> {
  return withScreeningRetry<DeleteMappingResult>(
    now,
    (attemptNow) => deleteMappingOnce(db, principal, mappingId, attemptNow),
    () => ({ status: "conflict" }),
  );
}

async function deleteMappingOnce(
  db: D1Database,
  principal: TenantAdminPrincipal,
  mappingId: string,
  now: number,
): Promise<DeleteMappingResult> {
  const tenantId = principal.tenantId;
  const loadRow = () =>
    db
      .prepare(`SELECT ${MAPPING_COLUMNS} FROM pod_mappings WHERE tenant_id = ? AND id = ? LIMIT 1`)
      .bind(tenantId, mappingId)
      .first<MappingRow>();
  // The product id first (immutable on the row), then the guard, then every
  // fact this batch depends on — the row included — read after the guard.
  const located = await loadRow();
  if (located === null) {
    return { status: "not_found" };
  }
  const guard = await readScreeningGuard(db, tenantId, located.product_id);
  const row = await loadRow();
  if (row === null) {
    return { status: "not_found" };
  }
  if (row.status === "inactive") {
    return { status: "ok" };
  }

  const iso = new Date(now).toISOString();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE pod_mappings SET status = 'inactive', suspended_reason = NULL,
           updated_at = max(?, created_at)
         WHERE tenant_id = ? AND id = ?`,
      )
      .bind(iso, tenantId, mappingId),
    db
      .prepare(
        `UPDATE products SET updated_at = max(?, updated_at + 1)
         WHERE tenant_id = ? AND product_id = ?`,
      )
      .bind(now, tenantId, row.product_id),
  ];

  if (await isProductLive(db, tenantId, row.product_id)) {
    // PRISGOLV on the state this delete leaves behind (reviewer P2): removing
    // a mapping can make a unit sellable again (the last SUSPENDED mapping of a
    // product goes, and it returns to the storefront at whatever price it has)
    // or move a variant onto the costlier product-level set (its own set goes).
    // Either may put a live price under the floor — refused, like any other
    // mapping edit of a live product. A delete that leaves a unit with no set
    // at all is allowed: that unit simply stops being sellable.
    const active = await loadActiveMappings(db, tenantId, row.product_id);
    if (active === null) {
      return { code: "pod_too_large", status: "refused" };
    }
    const failure = await evaluatePodGate(db, tenantId, row.product_id, {
      mappings: active.filter((mapping) => mapping.mappingId !== mappingId),
    });
    if (failure === "price_below_floor" || failure === "pod_too_large") {
      return { code: failure, status: "refused" };
    }

    // Complete by construction (DISTINCT artwork ids of the active rows).
    const remaining = await db
      .prepare(
        `SELECT DISTINCT artwork_id FROM pod_mappings
         WHERE tenant_id = ? AND product_id = ? AND status = 'active' AND id <> ?`,
      )
      .bind(tenantId, row.product_id, mappingId)
      .all<{ artwork_id: string }>();
    const screening = await screeningStatementsFor(db, {
      artworkIds: remaining.results.map((entry) => entry.artwork_id),
      guard,
      now,
    });
    statements.push(...screening.statements);
  } else {
    statements.push(screeningFenceStatement(db, guard, now));
  }

  statements.push(
    auditStatement(db, principal, "pod.mapping.delete", mappingId, now, {
      artworkId: row.artwork_id,
      productId: row.product_id,
    }),
  );
  await db.batch(statements);
  return { status: "ok" };
}

// ── checkout: production eligibility + the frozen line ─────────────────────

export interface PrintFile {
  /**
   * CP6-PS2 (additive; nothing reads these for money): the printer's frame
   * for this slot as it stood at checkout, whether that frame is a stand-in
   * (the model's `provisional` flag), and the artwork's pixel size. The print
   * canvas (src/dispatch/print-canvas.ts) is built from these frozen facts,
   * never from the catalogue at dispatch time. `sourcePx` is absent only for an
   * artwork row without measured pixels, which no 'ready' artwork lacks today;
   * the canvas then refuses the line rather than checkout refusing the cart.
   */
  /**
   * CP12: a flat print's canvas facts — the sheet's exact pixels (the model's
   * `front.px` at checkout) and the mapping's fit and background. Present
   * exactly on a flat line's slot; the canvas of such a slot is the sheet
   * (src/dispatch/print-canvas.ts flatCanvasSpec).
   */
  flat?: { background: string; canvasPx: { h: number; w: number }; fit: FlatFit };
  frameMm: PrintArea;
  frameProvisional: boolean;
  heightMm: number;
  r2Key: string;
  sha256: string;
  slot: PrintSlot;
  sourcePx?: { h: number; w: number };
  widthMm: number;
}

export interface ProductionLine {
  currency: string;
  printFiles: PrintFile[];
  /**
   * CP12: the supplier-side facts of the line not in its SKU key (a flat
   * model, the print-area name, fixed attributes: printerItemFacts), frozen
   * so the printer's wire reads the order as sold. Absent when there are none.
   */
  printerItem?: PrinterItemFacts;
  printerId: string;
  /** CP11: the routed printer's provider, read in the same snapshot. */
  provider: PrinterProvider;
  productionCostMinor: number;
  /** The printer's flat per-order parcel (ex VAT), read in the same snapshot. */
  shippingCostMinor: number;
  sku: string;
}

interface ProductionRow extends MappingRow {
  artwork_height_px: number | null;
  artwork_status: string | null;
  artwork_width_px: number | null;
  print_object_key: string | null;
  print_sha256: string | null;
}

const SLOT_ORDER = new Map<PrintSlot, number>(PRINT_SLOTS.map((slot, index) => [slot, index]));

function isPositivePx(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Production eligibility for ONE checkout line, recomputed from current facts
 * (PLAN §2.3) — the CF stampRouting + artworkDeliverable. null = not producible
 * (the checkout is refused):
 *
 *   - an active mapping set for the line's scope, one printer + one SKU;
 *   - the printer active and usable by this tenant, an `api` printer (one the
 *     dispatcher submits to), and — CP11, D3 — of a provider this environment
 *     may hold (providerAllowedIn; `policy` "any" when the caller did not name
 *     its environment: any api provider, never `manual`);
 *   - the SKU still in its capabilities and every slot still framed and still
 *     large enough for the print it was sized for (A3/A4);
 *   - every artwork 'ready' with a print master under this tenant's own
 *     `pod/{tenant}/print/` prefix (artworkDeliverable's containment rule);
 *   - the SKU priced for every slot (A1);
 *   - when `refuseStandInFrames` (CP6-PS3: the checkout passes the print
 *     canvas switch, src/dispatch/print-canvas.ts printCanvasEnabled), the
 *     SKU's model has real frames, not a stand-in (`provisional`): with the
 *     canvas on, dispatch refuses to print a stand-in frame (canvasFrame), so
 *     such a line must not be paid for. False = the stand-in flag is only
 *     frozen beside each slot, as before.
 *
 * The scope's set is read COMPLETE (Codex CP2 P2): the variant's own set, else
 * the product-level set, each queried exactly — never a product-wide page that
 * could cut a set in half and freeze a front+back garment as front-only. A set
 * larger than MAX_SCOPE_MAPPINGS breaks the one-mapping-per-slot invariant and
 * is refused. Suspended mappings are checked on their own, across all scopes.
 */
interface ProductionItem {
  productId: string;
  quantity: number;
  variantId: string | null;
}

// The rows a production read returns, per line.
const STATEMENTS_PER_LINE = 3;

// Suspended rows first; beyond this many rows the one-per-slot invariant broke.
const PRODUCTION_PAGE_SIZE = 2 * MAX_SCOPE_MAPPINGS;

/**
 * The freeze's tier read — MAPPING-FIRST (Codex CP2 P2, performance). The
 * line's few active scope mappings are found through
 * `pod_mappings_tenant_product_status_idx`, and each one looks up its tier by
 * the `(printer_id, sku)` primary key. `CROSS JOIN` pins that loop order
 * (SQLite never reorders the left operand of a CROSS JOIN out of the outer
 * loop), so the planner can never fall back to scanning every tier of the
 * printer and re-searching the product's mappings per tier — the correlated
 * `EXISTS` this replaces did exactly that, once per checkout line.
 *
 * Binds (tenant_id, product_id, variant_id) — the same as the line's other two
 * reads, and it runs inside the same D1 batch, so the one-snapshot guarantee is
 * unchanged. Exported so a test can pin its query plan.
 */
export const PRODUCTION_TIER_READ_SQL = `SELECT tier.printer_id, tier.sku,
       tier.blank_cost_minor, tier.print_costs_json
FROM pod_mappings AS mapping
CROSS JOIN printer_sku_tiers AS tier
  ON tier.printer_id = mapping.printer_id
 AND tier.sku = mapping.sku
WHERE mapping.tenant_id = ?
  AND mapping.product_id = ?
  AND mapping.status = 'active'
  AND (mapping.variant_id IS ? OR mapping.variant_id IS NULL)`;

function productionReadStatements(
  db: D1Database,
  tenantId: string,
  item: ProductionItem,
): D1PreparedStatement[] {
  // ── ONE consistent read (Codex CP2 P1) ─────────────────────────────────────
  // The mappings the line can use, every suspended mapping of the product,
  // the printer(s) and the price tiers behind them are read in ONE D1 batch —
  // one transaction, one snapshot. Separate reads let a routing edit land
  // between "is anything suspended?" and "which mappings are active?": the
  // edit suspends the back mapping, the back vanishes from the active set, and
  // a front+back garment freezes front-only. Inside one snapshot the edit is
  // either wholly before (suspended row seen → refused) or wholly after
  // (complete set, validated against the capabilities and prices of the same
  // moment) — never half.
  const scope = `mapping.tenant_id = ?
         AND mapping.product_id = ?
         AND (
           mapping.status = 'suspended'
           OR (mapping.status = 'active'
               AND (mapping.variant_id IS ? OR mapping.variant_id IS NULL))
         )`;
  const scopeBinds = [tenantId, item.productId, item.variantId] as const;
  // Suspended rows sort first, so a page can never hide one; without any, the
  // two candidate scopes hold at most 2 × MAX_SCOPE_MAPPINGS active rows (one
  // per slot each) and a fuller page is a broken invariant.
  return [
    db
      .prepare(
        `SELECT mapping.id, mapping.product_id, mapping.variant_id, mapping.artwork_id,
                mapping.printer_id, mapping.sku, mapping.slots_json, mapping.status,
                mapping.suspended_reason, mapping.created_at, mapping.updated_at,
                artwork.status AS artwork_status,
                artwork.print_object_key, artwork.print_sha256,
                artwork.width_px AS artwork_width_px,
                artwork.height_px AS artwork_height_px
         FROM pod_mappings AS mapping
         LEFT JOIN pod_artwork AS artwork
           ON artwork.artwork_id = mapping.artwork_id
          AND artwork.tenant_id = mapping.tenant_id
         WHERE ${scope}
         ORDER BY (mapping.status = 'suspended') DESC, mapping.created_at, mapping.id
         LIMIT ${PRODUCTION_PAGE_SIZE + 1}`,
      )
      .bind(...scopeBinds),
    db
      .prepare(
        `SELECT id, tenant_id, type, provider, name, status, currency, shipping_cost_minor,
                capabilities_json
         FROM printers
         WHERE id IN (
           SELECT mapping.printer_id FROM pod_mappings AS mapping
           WHERE ${scope} AND mapping.status = 'active'
         )`,
      )
      .bind(...scopeBinds),
    db.prepare(PRODUCTION_TIER_READ_SQL).bind(...scopeBinds),
  ];
}

/**
 * CP11 (D3): which printers a production line may be routed to — the
 * environment's provider policy, or "any" api provider when the caller did not
 * name its environment (a caller that predates the option).
 */
export type ProductionPolicy = PrinterEnvironment | "any";

/**
 * CP11 U7 (audit F3, F4): where the order goes — collected, or shipped to a
 * country (ISO 3166-1 alpha-2, upper case). A line is not producible when its
 * printer cannot take a collected order (providerTakesCollectedOrders), or
 * does not ship to that country (printerShipsTo). Undefined = not judged (a
 * caller that knows no destination).
 */
export type ProductionDestination = { country: string; method: "ship" } | { method: "pickup" };

/** Whether `printer` can deliver to `destination` (see ProductionDestination). */
export function printerDelivers(
  printer: Pick<Printer, "capabilities" | "provider">,
  destination: ProductionDestination,
): boolean {
  if (destination.method === "pickup") {
    return providerTakesCollectedOrders(printer.provider);
  }
  const shipsTo = printerShipsTo(printer.provider, printer.capabilities);
  return shipsTo === null || shipsTo.includes(destination.country);
}

function decideProductionLine(
  tenantId: string,
  item: ProductionItem,
  policy: ProductionPolicy,
  refuseStandInFrames: boolean,
  results: ReadonlyArray<D1Result<unknown> | undefined>,
  destination: ProductionDestination | undefined,
): ProductionLine | null {
  const [mappingResult, printerResult, tierResult] = results;
  const rowsRead = (mappingResult?.results ?? []) as ProductionRow[];
  const printerRows = (printerResult?.results ?? []) as PrinterRow[];
  const tierRows = (tierResult?.results ?? []) as Array<
    Omit<TierFacts, "currency"> & { printer_id: string; sku: string }
  >;

  // Any suspended mapping: the product as designed cannot be produced
  // (evaluatePodGate's rule; the public predicate hides it too).
  if (rowsRead.length > PRODUCTION_PAGE_SIZE || rowsRead.some((row) => row.status === "suspended")) {
    return null;
  }
  // The variant's own set when it has one, else the product-level set.
  const variantRows =
    item.variantId === null ? [] : rowsRead.filter((row) => row.variant_id === item.variantId);
  const scoped = variantRows.length > 0 ? variantRows : rowsRead.filter((row) => row.variant_id === null);
  if (scoped.length === 0 || scoped.length > MAX_SCOPE_MAPPINGS) {
    return null;
  }
  const rows = new Map(scoped.map((row) => [row.id, row]));
  const set = scoped.map(toMapping);
  const routing = setRouting(set);
  if (routing === null) {
    return null;
  }

  const printerRow = printerRows.find((row) => row.id === routing.printerId);
  const printer = printerRow === undefined ? null : toPrinter(printerRow);
  if (
    printer === null ||
    printer.status !== "active" ||
    // CP11 (D3, it replaced "the printer IS the environment's dispatch
    // target"): an api printer whose provider may exist here. A manual
    // printer, or an api row left `manual` by 0057's backfill, receives no
    // job from the dispatcher, so nothing is sold that no printer receives.
    printer.type !== "api" ||
    printer.provider === "manual" ||
    (policy !== "any" && !providerAllowedIn(printer.provider, policy)) ||
    (printer.tenantId !== null && printer.tenantId !== tenantId) ||
    printer.capabilities.skus[routing.sku] === undefined
  ) {
    return null;
  }
  // CP11 U7 (audit F2): every slot the printer requires is printed (Prodigi:
  // front). A back-only Prodigi line is refused BEFORE payment, never left to
  // the printer's validation after it.
  if (
    requiredSlotsOf(printer.provider, printer.capabilities, routing.sku).some(
      (slot) => !routing.slots.some((mapped) => mapped.slot === slot),
    )
  ) {
    return null;
  }
  // CP11 U7 (audit F3, F4): the printer can deliver where this order goes.
  if (destination !== undefined && !printerDelivers(printer, destination)) {
    return null;
  }

  const printPrefix = `pod/${tenantId}/print/`;
  // CP6-PS2: frozen beside each slot. CP6-PS3: a reason to refuse the cart
  // only when the caller says the print canvas is on.
  const frameProvisional = isStandInSku(printer.capabilities, routing.sku);
  if (refuseStandInFrames && frameProvisional) {
    return null;
  }
  const sheetPx = flatAreaPx(printer.capabilities, routing.sku);
  const printFiles: PrintFile[] = [];
  for (const mapping of set) {
    const row = rows.get(mapping.mappingId);
    if (
      row === undefined ||
      row.artwork_status !== "ready" ||
      row.print_object_key === null ||
      row.print_sha256 === null ||
      !row.print_object_key.startsWith(printPrefix)
    ) {
      return null;
    }
    for (const slot of mapping.slots) {
      const frame = slotFrame(printer.capabilities, routing.sku, slot.slot);
      if (frame === null || frame.w < slot.widthMm || frame.h < slot.heightMm) {
        return null;
      }
      // CP12: a flat slot is printed at the sheet's exact pixels; a master
      // that no longer reaches them (the sheet changed) is not sold.
      let flat: PrintFile["flat"];
      if (sheetPx !== null) {
        const fit = slot.fit ?? DEFAULT_FLAT_FIT;
        if (
          !isPositivePx(row.artwork_width_px) ||
          !isPositivePx(row.artwork_height_px) ||
          !flatReachesPx({ h: row.artwork_height_px, w: row.artwork_width_px }, sheetPx, fit)
        ) {
          return null;
        }
        flat = {
          background: slot.background ?? DEFAULT_FLAT_BACKGROUND,
          canvasPx: { h: sheetPx.h, w: sheetPx.w },
          fit,
        };
      }
      printFiles.push({
        ...(flat === undefined ? {} : { flat }),
        frameMm: frame,
        frameProvisional,
        heightMm: slot.heightMm,
        r2Key: row.print_object_key,
        sha256: row.print_sha256,
        slot: slot.slot,
        ...(isPositivePx(row.artwork_width_px) && isPositivePx(row.artwork_height_px)
          ? { sourcePx: { h: row.artwork_height_px, w: row.artwork_width_px } }
          : {}),
        widthMm: slot.widthMm,
      });
    }
  }
  printFiles.sort((a, b) => (SLOT_ORDER.get(a.slot) ?? 0) - (SLOT_ORDER.get(b.slot) ?? 0));

  const tier = tierRows.find(
    (row) => row.printer_id === routing.printerId && row.sku === routing.sku,
  );
  const quote =
    tier === undefined
      ? null
      : quoteFromTier(
          { ...tier, currency: printer.currency },
          { quantity: item.quantity, slots: printFiles.map((file) => file.slot) },
        );
  if (quote === null) {
    return null;
  }

  const printerItem = printerItemFacts(printer.capabilities, routing.sku);
  return {
    currency: quote.breakdown.currency,
    printFiles,
    ...(printerItem === undefined ? {} : { printerItem }),
    printerId: routing.printerId,
    provider: printer.provider,
    productionCostMinor: quote.productionCostMinor,
    shippingCostMinor: printer.shippingCostMinor,
    sku: routing.sku,
  };
}

/**
 * Production eligibility for EVERY POD line of a checkout, read in ONE D1
 * batch — one transaction, one snapshot of mappings, suspensions, printers and
 * tiers for all lines together (reviewer P3): a routing edit (a tier price, a
 * frame) can never land between line 1 and line 2 and freeze a price list that
 * mixes the old and the new. Index-aligned with `items`; null = that line is
 * not producible. `refuseStandInFrames`: see decideProductionLine's header.
 */
export async function resolveProductionLines(
  db: D1Database,
  tenantId: string,
  items: readonly ProductionItem[],
  policy: ProductionPolicy,
  refuseStandInFrames: boolean,
  destination?: ProductionDestination,
): Promise<Array<ProductionLine | null>> {
  if (items.length === 0) {
    return [];
  }
  const results = await db.batch<unknown>(
    items.flatMap((item) => productionReadStatements(db, tenantId, item)),
  );
  return items.map((item, index) =>
    decideProductionLine(
      tenantId,
      item,
      policy,
      refuseStandInFrames,
      results.slice(index * STATEMENTS_PER_LINE, (index + 1) * STATEMENTS_PER_LINE),
      destination,
    ),
  );
}

/**
 * One line on its own (its own snapshot) — see resolveProductionLines. A
 * stand-in frame is never a refusal here (its behaviour before CP6-PS3).
 */
export async function resolveProductionLine(
  db: D1Database,
  tenantId: string,
  item: ProductionItem,
  policy: ProductionPolicy,
  destination?: ProductionDestination,
): Promise<ProductionLine | null> {
  const [line] = await resolveProductionLines(db, tenantId, [item], policy, false, destination);
  return line ?? null;
}

// ── storefront: what a buyer may see of a POD product ──────────────────────

export interface PublicPodFields {
  previewUrls: string[];
  printAreas: MappingSlot[];
}

/** The storefront path of one artwork preview (src/routes/pod-storefront.ts). */
export function previewPath(productId: string, artworkId: string): string {
  return `/v1/storefront/pod-previews/${encodeURIComponent(productId)}/${encodeURIComponent(artworkId)}`;
}

/**
 * The public POD fields of a product the caller has ALREADY proven publicly
 * eligible: the print areas (slot + mm) of its active mappings and the preview
 * paths of their artworks. No SKU, no printer, no cost — nothing a competitor
 * or a buyer could turn into the supplier or the margin.
 */
export async function publicPodFields(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<PublicPodFields> {
  // Display-only, of a product already proven public; an overflow (which the
  // write path refuses) shows no POD fields rather than a partial set.
  const mappings = (await loadActiveMappings(db, tenantId, productId)) ?? [];
  const printAreas: MappingSlot[] = [];
  const previewUrls: string[] = [];
  for (const mapping of mappings) {
    for (const slot of mapping.slots) {
      if (!printAreas.some((existing) => existing.slot === slot.slot)) {
        printAreas.push({ heightMm: slot.heightMm, slot: slot.slot, widthMm: slot.widthMm });
      }
    }
    const url = previewPath(productId, mapping.artworkId);
    if (!previewUrls.includes(url)) {
      previewUrls.push(url);
    }
  }
  printAreas.sort((a, b) => (SLOT_ORDER.get(a.slot) ?? 0) - (SLOT_ORDER.get(b.slot) ?? 0));
  return { previewUrls, printAreas };
}

/**
 * CP11 U7 (audit F3, F4): how a POD product may be delivered, from the
 * printers its ACTIVE mappings route to — the same rules checkout's line
 * resolution applies (printerDelivers), so the storefront never offers what
 * checkout would refuse:
 *   pickup   false when any of those printers cannot take a collected order;
 *   shipsTo  the countries EVERY one of them ships to (their intersection),
 *            or null when none restricts.
 * Display-only, of a product already proven public. Only the rule's result
 * leaves: never a printer, a provider or an SKU.
 */
export interface PublicPodDelivery {
  pickup: boolean;
  shipsTo: string[] | null;
}

export async function publicPodDelivery(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<PublicPodDelivery> {
  const mappings = (await loadActiveMappings(db, tenantId, productId)) ?? [];
  const printers = await printersOf(db, mappings);
  let pickup = true;
  let shipsTo: string[] | null = null;
  for (const printer of printers.values()) {
    if (printer === null) {
      continue;
    }
    if (!providerTakesCollectedOrders(printer.provider)) {
      pickup = false;
    }
    const own = printerShipsTo(printer.provider, printer.capabilities);
    if (own !== null) {
      shipsTo = shipsTo === null ? [...own] : shipsTo.filter((country) => own.includes(country));
    }
  }
  return { pickup, shipsTo: shipsTo === null ? null : [...shipsTo].sort() };
}
