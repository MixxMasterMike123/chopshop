import type { PlatformPrincipal } from "../auth/live-authorization";
import { SNAPWEAR_SKUS } from "../dispatch/snapwear-skus";
import { podPriceFloorMinor, quoteFromTier } from "./pod-quote";

/**
 * Printers, their capabilities and their price tiers (LAUNCH_TODO A2–A4, A13).
 *
 * Ported from functions/src/print/printRouting.ts (resolvePrinterUid,
 * isSlotPrintableInAreas) and the SnapWear seed (scripts/seed-snapwear-printer.cjs).
 * Firebase routed by GARMENT through settings/printRouting; here the mapping
 * names the printer and the printer's SKU directly, so "routing" is the
 * printer set itself: one platform printer per environment (`fake-printer` in
 * staging, `snapwear` in production — the env's DISPATCH_TARGET), replaced
 * wholesale by PUT /v1/platform/printers or edited one printer at a time by
 * PATCH /v1/platform/printers/:id (CP3).
 *
 * MONEY IS PLATFORM-ONLY (A13, "seller sees ONE number"). `printer_sku_tiers`
 * and `printers.shipping_cost_minor` are read by quotePodCost, the checkout
 * snapshot and the PLATFORM views below, never by a tenant projection;
 * listTenantPrinters is the only tenant-facing shape and it is built by
 * picking allowed capability fields (an allowlist), never by deleting prices.
 */

export const PRINT_SLOTS = [
  "front",
  "back",
  "pocket",
  "left_sleeve",
  "right_sleeve",
] as const;
export type PrintSlot = (typeof PRINT_SLOTS)[number];

export interface PrintArea {
  h: number;
  offsetTopMm?: number;
  w: number;
}

export interface PrinterModel {
  garment: string | null;
  name?: string;
  printAreasMm: Partial<Record<PrintSlot, PrintArea>>;
  /**
   * CP3: the frames are a stand-in until the printer confirms them (Firebase
   * `provisionalAreas`). Stored only when true.
   */
  provisional?: true;
}

export interface PrinterCapabilities {
  models: Record<string, PrinterModel>;
  skus: Record<string, { label?: string; model: string }>;
}

export interface PrinterTierInput {
  blankCostMinor: number;
  printCostsMinor: Partial<Record<PrintSlot, number>>;
  sku: string;
}

export interface PrinterInput {
  capabilities: PrinterCapabilities;
  currency: string;
  name: string;
  printerId: string;
  shippingCostMinor: number;
  status: "active" | "inactive";
  tiers: PrinterTierInput[];
  type: "api" | "manual";
}

export interface Printer {
  capabilities: PrinterCapabilities;
  currency: string;
  name: string;
  printerId: string;
  shippingCostMinor: number;
  status: "active" | "inactive";
  tenantId: string | null;
  type: "api" | "manual";
}

export interface PrinterRow {
  capabilities_json: string;
  currency: string;
  id: string;
  name: string;
  shipping_cost_minor: number;
  status: "active" | "inactive";
  tenant_id: string | null;
  type: "api" | "manual";
}

/**
 * The pocket print area (docs/POD_PRINT_SPEC.md §1: 100 × 100 mm, a position
 * INSIDE the front canvas). printRouting.ts isSlotPrintableInAreas: pocket is
 * printable when the garment has a front frame; it is clamped to that frame.
 */
export const POCKET_AREA_MM = { h: 100, w: 100 } as const;

/**
 * `default` names the default-printer resource (/v1/platform/printers/default),
 * so it can never be a printer id (migration 0035 refuses it too).
 */
export const RESERVED_PRINTER_IDS: ReadonlySet<string> = new Set(["default"]);

const PRINTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SKU_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_PRINTERS = 10;
export const MAX_PRINTER_MODELS = 500;
export const MAX_PRINTER_SKUS = 5_000;
const MAX_AREA_MM = 2_000;
export const MAX_COST_MINOR = 10_000_000;
const LABEL_MAX_LENGTH = 200;
const GARMENT_MAX_LENGTH = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

export function isPrintSlot(value: unknown): value is PrintSlot {
  return typeof value === "string" && (PRINT_SLOTS as readonly string[]).includes(value);
}

/** A printer id a route may address: the schema's grammar, minus reserved words. */
export function isPrinterId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PRINTER_ID_PATTERN.test(value) &&
    !RESERVED_PRINTER_IDS.has(value)
  );
}

export function isSkuKey(value: unknown): value is string {
  return typeof value === "string" && SKU_PATTERN.test(value);
}

export function isModelKey(value: unknown): value is string {
  return typeof value === "string" && MODEL_KEY_PATTERN.test(value);
}

export function isGarment(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= GARMENT_MAX_LENGTH;
}

export function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= LABEL_MAX_LENGTH;
}

export function parsePrintArea(value: unknown): PrintArea | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["h", "offsetTopMm", "w"])) {
    return null;
  }
  if (!isBoundedInt(value.w, 1, MAX_AREA_MM) || !isBoundedInt(value.h, 1, MAX_AREA_MM)) {
    return null;
  }
  if (value.offsetTopMm === undefined) {
    return { h: value.h, w: value.w };
  }
  return isBoundedInt(value.offsetTopMm, 0, MAX_AREA_MM)
    ? { h: value.h, offsetTopMm: value.offsetTopMm, w: value.w }
    : null;
}

function parseLabel(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return isLabel(value) ? value : null;
}

/** The capability document, validated key by key (unknown keys refuse it). */
export function parsePrinterCapabilities(value: unknown): PrinterCapabilities | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["models", "skus"])) {
    return null;
  }
  const { models, skus } = value;
  if (!isPlainObject(models) || !isPlainObject(skus)) {
    return null;
  }
  const modelKeys = Object.keys(models);
  const skuKeys = Object.keys(skus);
  if (modelKeys.length > MAX_PRINTER_MODELS || skuKeys.length > MAX_PRINTER_SKUS) {
    return null;
  }

  const parsedModels: Record<string, PrinterModel> = {};
  for (const key of modelKeys) {
    const model = models[key];
    if (
      !MODEL_KEY_PATTERN.test(key) ||
      !isPlainObject(model) ||
      !hasOnlyKeys(model, ["garment", "name", "printAreasMm", "provisional"])
    ) {
      return null;
    }
    const garment = model.garment;
    if (garment !== null && !isGarment(garment)) {
      return null;
    }
    const name = parseLabel(model.name);
    if (name === null || !isPlainObject(model.printAreasMm)) {
      return null;
    }
    if (model.provisional !== undefined && typeof model.provisional !== "boolean") {
      return null;
    }
    const areas: Partial<Record<PrintSlot, PrintArea>> = {};
    for (const [slot, rawArea] of Object.entries(model.printAreasMm)) {
      const area = parsePrintArea(rawArea);
      if (!isPrintSlot(slot) || area === null) {
        return null;
      }
      areas[slot] = area;
    }
    parsedModels[key] = {
      garment: garment as string | null,
      ...(name === undefined ? {} : { name }),
      printAreasMm: areas,
      ...(model.provisional === true ? { provisional: true as const } : {}),
    };
  }

  const parsedSkus: Record<string, { label?: string; model: string }> = {};
  for (const key of skuKeys) {
    const entry = skus[key];
    if (!SKU_PATTERN.test(key) || !isPlainObject(entry) || !hasOnlyKeys(entry, ["label", "model"])) {
      return null;
    }
    const label = parseLabel(entry.label);
    if (label === null || typeof entry.model !== "string" || parsedModels[entry.model] === undefined) {
      return null;
    }
    parsedSkus[key] = label === undefined ? { model: entry.model } : { label, model: entry.model };
  }

  return { models: parsedModels, skus: parsedSkus };
}

/** One tier's SHAPE (the SKU's membership in a capability document is checked by the caller). */
export function parseTierEntry(raw: unknown): PrinterTierInput | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["blankCostMinor", "printCostsMinor", "sku"])) {
    return null;
  }
  const { blankCostMinor, printCostsMinor, sku } = raw;
  if (
    !isSkuKey(sku) ||
    !isBoundedInt(blankCostMinor, 0, MAX_COST_MINOR) ||
    !isPlainObject(printCostsMinor)
  ) {
    return null;
  }
  const prints: Partial<Record<PrintSlot, number>> = {};
  for (const [slot, cost] of Object.entries(printCostsMinor)) {
    if (!isPrintSlot(slot) || !isBoundedInt(cost, 0, MAX_COST_MINOR)) {
      return null;
    }
    prints[slot] = cost;
  }
  return { blankCostMinor, printCostsMinor: prints, sku };
}

function parseTiers(value: unknown, capabilities: PrinterCapabilities): PrinterTierInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_PRINTER_SKUS) {
    return null;
  }
  const tiers: PrinterTierInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const tier = parseTierEntry(raw);
    // A tier for a SKU the printer does not list could never be reached and
    // would only hide a typo in the operator's document.
    if (tier === null || capabilities.skus[tier.sku] === undefined || seen.has(tier.sku)) {
      return null;
    }
    seen.add(tier.sku);
    tiers.push(tier);
  }
  return tiers;
}

const PRINTER_KEYS = [
  "capabilities",
  "currency",
  "name",
  "printerId",
  "shippingCostMinor",
  "status",
  "tiers",
  "type",
] as const;

function parsePrinter(value: unknown): PrinterInput | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, PRINTER_KEYS)) {
    return null;
  }
  const { currency, name, printerId, shippingCostMinor, status, type } = value;
  if (
    !isPrinterId(printerId) ||
    (type !== "api" && type !== "manual") ||
    !isLabel(name) ||
    (status !== "active" && status !== "inactive") ||
    typeof currency !== "string" ||
    !CURRENCY_PATTERN.test(currency) ||
    !isBoundedInt(shippingCostMinor, 0, MAX_COST_MINOR)
  ) {
    return null;
  }
  const capabilities = parsePrinterCapabilities(value.capabilities);
  if (capabilities === null) {
    return null;
  }
  const tiers = parseTiers(value.tiers, capabilities);
  if (tiers === null) {
    return null;
  }
  return {
    capabilities,
    currency,
    name,
    printerId,
    shippingCostMinor,
    status,
    tiers,
    type,
  };
}

/** The shape of `{ printers: [...] }`. Environment policy is checked separately. */
export function parseReplacePrintersInput(body: unknown): PrinterInput[] | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["printers"])) {
    return null;
  }
  const { printers } = body;
  if (!Array.isArray(printers) || printers.length > MAX_PRINTERS) {
    return null;
  }
  const parsed: PrinterInput[] = [];
  const seen = new Set<string>();
  for (const raw of printers) {
    const printer = parsePrinter(raw);
    if (printer === null || seen.has(printer.printerId)) {
      return null;
    }
    seen.add(printer.printerId);
    parsed.push(printer);
  }
  return parsed;
}

/**
 * The environment's dispatch target when it is one this platform can dispatch
 * to, else null (the printer surface is then dark). The staging fake printer is
 * a target ONLY in staging — the same condition its route uses.
 */
export function dispatchTargetOf(env: Env): "fake-printer" | "snapwear" | null {
  if (env.DISPATCH_TARGET === "snapwear") {
    return "snapwear";
  }
  if (env.DISPATCH_TARGET === "fake-printer" && env.APP_ENV === "staging") {
    return "fake-printer";
  }
  return null;
}

/**
 * Environment policy on a parsed printer set (PLAN §2.6: one printer per env).
 * An `api` printer is one the dispatcher submits to, so its id MUST be this
 * environment's DISPATCH_TARGET — production can never be seeded with the
 * fake printer, staging never with SnapWear. Both speak SnapWear's catalogue
 * (the fake printer 422s any other SKU), so every SKU must be a SnapWear SKU.
 * The replace-all PUT, the PATCH and the catalogue apply all check the state
 * they are about to write against THIS function.
 */
export function printersAllowedIn(
  printers: readonly PrinterInput[],
  target: "fake-printer" | "snapwear",
): boolean {
  return printers.every((printer) => {
    if (printer.type === "manual") {
      return printer.printerId !== "fake-printer" && printer.printerId !== "snapwear";
    }
    return (
      printer.printerId === target &&
      Object.keys(printer.capabilities.skus).every((sku) => SNAPWEAR_SKUS.has(sku))
    );
  });
}

function parseCapabilitiesJson(json: string): PrinterCapabilities | null {
  try {
    return parsePrinterCapabilities(JSON.parse(json));
  } catch {
    return null;
  }
}

export function toPrinter(row: PrinterRow): Printer | null {
  const capabilities = parseCapabilitiesJson(row.capabilities_json);
  // A row this module did not write would parse to null; treat the printer as
  // capable of nothing rather than guessing (fail closed).
  return capabilities === null
    ? null
    : {
        capabilities,
        currency: row.currency,
        name: row.name,
        printerId: row.id,
        shippingCostMinor: row.shipping_cost_minor,
        status: row.status,
        tenantId: row.tenant_id,
        type: row.type,
      };
}

const PRINTER_SELECT = `SELECT id, tenant_id, type, name, status, currency,
     shipping_cost_minor, capabilities_json
   FROM printers`;

/** A printer the tenant may map to: active, and platform-owned or its own. */
export async function loadUsablePrinter(
  db: D1Database,
  tenantId: string,
  printerId: string,
): Promise<Printer | null> {
  const row = await db
    .prepare(
      `${PRINTER_SELECT}
       WHERE id = ?
         AND status = 'active'
         AND (tenant_id IS NULL OR tenant_id = ?)
       LIMIT 1`,
    )
    .bind(printerId, tenantId)
    .first<PrinterRow>();
  return row === null ? null : toPrinter(row);
}

/**
 * The frame a printer prints `slot` into for `sku`, or null when it cannot.
 * Port of isSlotPrintableInAreas (printRouting.ts L132–140), FAIL CLOSED where
 * Firebase was lenient: an unknown SKU, a model with no frames, and the `other`
 * slot are all "cannot print" here — a missing frame is missing capability
 * data, and printing on a guess is how a garment comes back.
 */
export function slotFrame(
  capabilities: PrinterCapabilities,
  sku: string,
  slot: PrintSlot,
): PrintArea | null {
  const skuEntry = capabilities.skus[sku];
  const model = skuEntry === undefined ? undefined : capabilities.models[skuEntry.model];
  if (model === undefined) {
    return null;
  }
  const own = model.printAreasMm[slot];
  if (own !== undefined) {
    return own;
  }
  if (slot === "pocket") {
    const front = model.printAreasMm.front;
    return front === undefined
      ? null
      : {
          h: Math.min(POCKET_AREA_MM.h, front.h),
          w: Math.min(POCKET_AREA_MM.w, front.w),
        };
  }
  return null;
}

// ── the tenant view (A13: capability only, built by ALLOWLIST) ─────────────

/**
 * What a tenant admin may see of the printers it can map to: capability only.
 * `garments` and `provisionalAreas` port the Firebase price-free projection
 * (functions/src/print/projectPrinterPublic.ts): the garments the printer can
 * make (those of a model at least one SKU points at) and, of those, the ones
 * whose frames are a stand-in.
 */
export interface TenantPrinterView {
  capabilities: PrinterCapabilities;
  garments: string[];
  name: string;
  printerId: string;
  provisionalAreas: string[];
}

function pickArea(area: PrintArea): PrintArea {
  return area.offsetTopMm === undefined
    ? { h: area.h, w: area.w }
    : { h: area.h, offsetTopMm: area.offsetTopMm, w: area.w };
}

/**
 * Rebuilt field by field: a key this function does not name cannot reach a
 * seller, whatever a stored document (or a later schema change) carries. A
 * new capability field the admin UI needs must be added HERE, explicitly —
 * that failure is visible; a blocklist's failure is a silent leak.
 */
function tenantPrinterView(printer: Printer): TenantPrinterView {
  const models: Record<string, PrinterModel> = {};
  for (const [key, model] of Object.entries(printer.capabilities.models)) {
    const areas: Partial<Record<PrintSlot, PrintArea>> = {};
    for (const slot of PRINT_SLOTS) {
      const area = model.printAreasMm[slot];
      if (area !== undefined) {
        areas[slot] = pickArea(area);
      }
    }
    models[key] = {
      garment: model.garment,
      ...(model.name === undefined ? {} : { name: model.name }),
      printAreasMm: areas,
      ...(model.provisional === true ? { provisional: true as const } : {}),
    };
  }
  const skus: Record<string, { label?: string; model: string }> = {};
  const offered = new Set<string>();
  for (const [key, entry] of Object.entries(printer.capabilities.skus)) {
    skus[key] = entry.label === undefined ? { model: entry.model } : { label: entry.label, model: entry.model };
    offered.add(entry.model);
  }
  const garments = new Set<string>();
  const provisional = new Set<string>();
  for (const key of offered) {
    const model = models[key];
    if (model === undefined || model.garment === null) {
      continue;
    }
    garments.add(model.garment);
    if (model.provisional === true) {
      provisional.add(model.garment);
    }
  }
  return {
    capabilities: { models, skus },
    garments: [...garments].sort(),
    name: printer.name,
    printerId: printer.printerId,
    provisionalAreas: [...provisional].sort(),
  };
}

export async function listTenantPrinters(
  db: D1Database,
  tenantId: string,
): Promise<TenantPrinterView[]> {
  const result = await db
    .prepare(
      `${PRINTER_SELECT}
       WHERE status = 'active'
         AND (tenant_id IS NULL OR tenant_id = ?)
       ORDER BY id
       LIMIT ${MAX_PRINTERS * 2}`,
    )
    .bind(tenantId)
    .all<PrinterRow>();
  return result.results
    .map(toPrinter)
    .filter((printer): printer is Printer => printer !== null)
    .map(tenantPrinterView);
}

// ── suspension (shared by the replace-all PUT, the PATCH and the apply) ─────

export type SuspendReason = "slot_not_printable" | "sku_unavailable" | "unpriced";

interface MappingCheckRow {
  id: string;
  sku: string;
  slots_json: string;
}

/**
 * Why an ACTIVE mapping can no longer be honoured by a printer document, or
 * null when it still can: SKU gone, slot frame gone or too small for the print
 * it was sized for, or the SKU/slot no longer priced.
 */
function mappingSuspendReason(
  capabilities: PrinterCapabilities,
  tierBySku: ReadonlyMap<string, PrinterTierInput>,
  row: MappingCheckRow,
): SuspendReason | null {
  if (capabilities.skus[row.sku] === undefined) {
    return "sku_unavailable";
  }
  let slots: Array<{ heightMm: number; slot: PrintSlot; widthMm: number }>;
  try {
    slots = JSON.parse(row.slots_json) as typeof slots;
  } catch {
    return "slot_not_printable";
  }
  for (const slot of slots) {
    const frame = slotFrame(capabilities, row.sku, slot.slot);
    // A frame that shrank below the print it was sized for no longer holds it.
    if (frame === null || frame.w < slot.widthMm || frame.h < slot.heightMm) {
      return "slot_not_printable";
    }
  }
  const tier = tierBySku.get(row.sku);
  if (tier === undefined || slots.some((slot) => tier.printCostsMinor[slot.slot] === undefined)) {
    return "unpriced";
  }
  return null;
}

/** D1 caps bound parameters at 100 per statement. */
const IN_CHUNK = 90;

/**
 * The statements that suspend `suspensions` (mapping ids grouped by reason).
 * `WHERE status = 'active'` so a row another writer already moved is left
 * alone; the stamp is clamped to the row's own created_at (a clock behind
 * another isolate's can never write updated_at < created_at).
 */
function suspensionStatements(
  db: D1Database,
  suspensions: ReadonlyMap<SuspendReason, readonly string[]>,
  iso: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [reason, mappingIds] of suspensions) {
    for (let start = 0; start < mappingIds.length; start += IN_CHUNK) {
      const chunk = mappingIds.slice(start, start + IN_CHUNK);
      statements.push(
        db
          .prepare(
            `UPDATE pod_mappings
             SET status = 'suspended', suspended_reason = ?, updated_at = max(?, created_at)
             WHERE status = 'active'
               AND id IN (${chunk.map(() => "?").join(", ")})`,
          )
          .bind(reason, iso, ...chunk),
      );
    }
  }
  return statements;
}

function tierMap(tiers: readonly PrinterTierInput[]): Map<string, PrinterTierInput> {
  return new Map(tiers.map((tier) => [tier.sku, tier]));
}

// ── the platform replace ────────────────────────────────────────────────────

export interface ReplacePrintersResult {
  printers: Array<{
    currency: string;
    name: string;
    pricedSkuCount: number;
    printerId: string;
    skuCount: number;
    status: "active" | "inactive";
    type: "api" | "manual";
  }>;
  suspendedMappings: number;
}

/**
 * Replace the platform printer set in ONE batch (PLAN §2.4 "routing/print-area
 * edits" revalidate in the same batch):
 *
 *   1. upsert every listed printer (platform-owned; a tenant printer with the
 *      same id refuses the whole request),
 *   2. replace each listed printer's tiers wholesale,
 *   3. deactivate every platform printer the list omits (rows are never
 *      deleted: mappings reference them),
 *   4. SUSPEND every active mapping on a listed printer that the new document
 *      can no longer honour — SKU gone, slot frame gone or too small, or the
 *      SKU/slot no longer priced — so the product leaves the storefront and
 *      checkout in the same transaction (catalog_version bumps by trigger),
 *   5. one platform audit row.
 *
 * Every printer row it writes moves `revision` by one (CP3, migration 0035), so
 * a PATCH that read the printer before this batch is refused, not overwritten.
 *
 * Returns null when a listed id belongs to a tenant printer.
 */
export async function replacePrinters(
  db: D1Database,
  principal: PlatformPrincipal,
  printers: PrinterInput[],
  now: number,
): Promise<ReplacePrintersResult | null> {
  const iso = new Date(now).toISOString();
  const ids = printers.map((printer) => printer.printerId);

  if (ids.length > 0) {
    const foreign = await db
      .prepare(
        `SELECT COUNT(*) AS total FROM printers
         WHERE tenant_id IS NOT NULL
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(ids))
      .first<{ total: number }>();
    if ((foreign?.total ?? 0) > 0) {
      return null;
    }
  }

  // Mappings to suspend, decided against the NEW document before the batch.
  const suspensions = new Map<SuspendReason, string[]>();
  for (const printer of printers) {
    const tiers = tierMap(printer.tiers);
    const active = await db
      .prepare(
        `SELECT id, sku, slots_json FROM pod_mappings
         WHERE printer_id = ? AND status = 'active'
         LIMIT 10000`,
      )
      .bind(printer.printerId)
      .all<MappingCheckRow>();
    for (const row of active.results) {
      const reason = mappingSuspendReason(printer.capabilities, tiers, row);
      if (reason !== null) {
        suspensions.set(reason, [...(suspensions.get(reason) ?? []), row.id]);
      }
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const printer of printers) {
    statements.push(
      db
        .prepare(
          `INSERT INTO printers (
             id, tenant_id, type, name, status, currency, shipping_cost_minor,
             capabilities_json, created_at, updated_at
           ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             type = excluded.type,
             name = excluded.name,
             status = excluded.status,
             currency = excluded.currency,
             shipping_cost_minor = excluded.shipping_cost_minor,
             capabilities_json = excluded.capabilities_json,
             revision = printers.revision + 1,
             updated_at = max(excluded.updated_at, printers.created_at)
           WHERE printers.tenant_id IS NULL`,
        )
        .bind(
          printer.printerId,
          printer.type,
          printer.name,
          printer.status,
          printer.currency,
          printer.shippingCostMinor,
          JSON.stringify(printer.capabilities),
          iso,
          iso,
        ),
      db.prepare("DELETE FROM printer_sku_tiers WHERE printer_id = ?").bind(printer.printerId),
    );
    if (printer.tiers.length > 0) {
      // One statement for the whole tier list: json_each expands the array, so
      // a 323-SKU catalogue is one bound parameter, not 323 statements.
      statements.push(
        db
          .prepare(
            `INSERT INTO printer_sku_tiers (
               printer_id, tenant_id, sku, blank_cost_minor, print_costs_json,
               created_at, updated_at
             )
             SELECT ?, NULL,
                    json_extract(tier.value, '$.sku'),
                    json_extract(tier.value, '$.blankCostMinor'),
                    json(json_extract(tier.value, '$.printCostsMinor')),
                    ?, ?
             FROM json_each(?) AS tier`,
          )
          .bind(printer.printerId, iso, iso, JSON.stringify(printer.tiers)),
      );
    }
  }

  statements.push(
    db
      .prepare(
        `UPDATE printers
         SET status = 'inactive', revision = revision + 1, updated_at = max(?, created_at)
         WHERE tenant_id IS NULL
           AND status = 'active'
           AND id NOT IN (SELECT value FROM json_each(?))`,
      )
      .bind(iso, JSON.stringify(ids)),
  );

  let suspendedMappings = 0;
  for (const mappingIds of suspensions.values()) {
    suspendedMappings += mappingIds.length;
  }
  statements.push(...suspensionStatements(db, suspensions, iso));

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, NULL, ?, 'pod.printers.replace', 'printers', NULL, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        // Ids and counts only — no prices in the audit trail.
        JSON.stringify({ printerIds: ids, suspendedMappings }),
        now,
      ),
  );

  await db.batch(statements);

  return {
    printers: printers.map((printer) => ({
      currency: printer.currency,
      name: printer.name,
      pricedSkuCount: printer.tiers.length,
      printerId: printer.printerId,
      skuCount: Object.keys(printer.capabilities.skus).length,
      status: printer.status,
      type: printer.type,
    })),
    suspendedMappings,
  };
}

// ── the platform read (CP3) ─────────────────────────────────────────────────

export interface PlatformTierView {
  blankCostMinor: number;
  createdAt: string;
  printCostsMinor: unknown;
  sku: string;
  updatedAt: string;
}

/**
 * EVERYTHING the platform stores about a printer — PLATFORM SESSIONS ONLY.
 * `capabilities` is the stored document as parsed JSON (shown even when it
 * fails validation, with `capabilitiesValid: false`, so an operator can see and
 * fix an imported row); `catalog` is the stored supplier catalogue's
 * fingerprint, not its body (GET …/catalog has that).
 */
export interface PlatformPrinterView {
  capabilities: unknown;
  capabilitiesValid: boolean;
  catalog: { contentSha256: string; importedAt: string; sizeBytes: number } | null;
  createdAt: string;
  currency: string;
  isDefault: boolean;
  name: string;
  printerId: string;
  revision: number;
  shippingCostMinor: number;
  status: "active" | "inactive";
  tenantId: string | null;
  tiers: PlatformTierView[];
  type: "api" | "manual";
  updatedAt: string;
}

interface PlatformPrinterRow extends PrinterRow {
  catalog_imported_at: string | null;
  catalog_sha256: string | null;
  catalog_size_bytes: number | null;
  created_at: string;
  is_default: number;
  revision: number;
  updated_at: string;
}

interface PlatformTierRow {
  blank_cost_minor: number;
  created_at: string;
  print_costs_json: string;
  printer_id: string;
  sku: string;
  updated_at: string;
}

const PLATFORM_PRINTER_SELECT = `SELECT p.id, p.tenant_id, p.type, p.name, p.status, p.currency,
       p.shipping_cost_minor, p.capabilities_json, p.revision, p.created_at, p.updated_at,
       c.content_sha256 AS catalog_sha256, c.imported_at AS catalog_imported_at,
       length(CAST(c.catalog_json AS BLOB)) AS catalog_size_bytes,
       (d.id IS NOT NULL) AS is_default
     FROM printers AS p
     LEFT JOIN printer_catalog AS c ON c.printer_id = p.id
     LEFT JOIN print_defaults AS d ON d.id = 1 AND d.default_printer_id = p.id`;

const PLATFORM_TIER_SELECT = `SELECT printer_id, sku, blank_cost_minor, print_costs_json,
       created_at, updated_at
     FROM printer_sku_tiers`;

function parseJsonOrNull(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function platformPrinterView(
  row: PlatformPrinterRow,
  tiers: readonly PlatformTierRow[],
): PlatformPrinterView {
  const capabilities = parseJsonOrNull(row.capabilities_json);
  return {
    capabilities,
    capabilitiesValid: parsePrinterCapabilities(capabilities) !== null,
    catalog:
      row.catalog_sha256 === null || row.catalog_imported_at === null
        ? null
        : {
            contentSha256: row.catalog_sha256,
            importedAt: row.catalog_imported_at,
            sizeBytes: row.catalog_size_bytes ?? 0,
          },
    createdAt: row.created_at,
    currency: row.currency,
    isDefault: row.is_default === 1,
    name: row.name,
    printerId: row.id,
    revision: row.revision,
    shippingCostMinor: row.shipping_cost_minor,
    status: row.status,
    tenantId: row.tenant_id,
    tiers: tiers.map((tier) => ({
      blankCostMinor: tier.blank_cost_minor,
      createdAt: tier.created_at,
      printCostsMinor: parseJsonOrNull(tier.print_costs_json),
      sku: tier.sku,
      updatedAt: tier.updated_at,
    })),
    type: row.type,
    updatedAt: row.updated_at,
  };
}

export const PLATFORM_PRINTER_PAGE_DEFAULT = 20;
export const PLATFORM_PRINTER_PAGE_MAX = 50;

/**
 * One page of printers (every row, platform-owned and tenant-owned, active or
 * not), ordered by id, with all their tiers. The page and its tiers are read
 * in ONE batch, so a concurrent edit is never half-visible.
 */
export async function listPlatformPrinters(
  db: D1Database,
  query: { cursor: string | null; limit: number },
): Promise<{ nextCursor: string | null; printers: PlatformPrinterView[] }> {
  const page = `SELECT id FROM printers WHERE id > ? ORDER BY id LIMIT ?`;
  const [printerResult, tierResult] = await db.batch([
    db
      .prepare(`${PLATFORM_PRINTER_SELECT} WHERE p.id > ? ORDER BY p.id LIMIT ?`)
      .bind(query.cursor ?? "", query.limit + 1),
    db
      .prepare(`${PLATFORM_TIER_SELECT} WHERE printer_id IN (${page}) ORDER BY printer_id, sku`)
      .bind(query.cursor ?? "", query.limit),
  ]);
  const rows = (printerResult?.results ?? []) as PlatformPrinterRow[];
  const tierRows = (tierResult?.results ?? []) as PlatformTierRow[];
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  return {
    nextCursor: rows.length > query.limit && last !== undefined ? last.id : null,
    printers: pageRows.map((row) =>
      platformPrinterView(row, tierRows.filter((tier) => tier.printer_id === row.id)),
    ),
  };
}

export async function getPlatformPrinter(
  db: D1Database,
  printerId: string,
): Promise<PlatformPrinterView | null> {
  const [printerResult, tierResult] = await db.batch([
    db.prepare(`${PLATFORM_PRINTER_SELECT} WHERE p.id = ?`).bind(printerId),
    db.prepare(`${PLATFORM_TIER_SELECT} WHERE printer_id = ? ORDER BY sku`).bind(printerId),
  ]);
  const row = (printerResult?.results ?? [])[0] as PlatformPrinterRow | undefined;
  return row === undefined
    ? null
    : platformPrinterView(row, (tierResult?.results ?? []) as PlatformTierRow[]);
}

// ── the platform partial edit (CP3): PATCH and the catalogue apply ─────────

export type TierEdit =
  /** PATCH: remove named tiers, then add or replace named tiers. */
  | { kind: "patch"; remove: string[]; upsert: PrinterTierInput[] }
  /** Catalogue apply: the tier list becomes exactly this. */
  | { kind: "replace"; tiers: PrinterTierInput[] };

export interface PrinterEdit {
  /** Replaces the capability document whole. */
  capabilities?: PrinterCapabilities;
  name?: string;
  shippingCostMinor?: number;
  status?: "active" | "inactive";
  tiers?: TierEdit;
}

export interface PrinterEditOptions {
  action: "pod.printers.catalog.apply" | "pod.printers.edit";
  /** Catalogue apply: the write is fenced on the stored catalogue still having this sha. */
  catalogSha256?: string;
  dryRun: boolean;
  /** Refuse (409 revision_mismatch) unless the printer is still at this revision. */
  expectedRevision?: number;
  target: "fake-printer" | "snapwear";
}

export interface KeyDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface PrinterEditSuspension {
  mappingId: string;
  productId: string;
  reason: SuspendReason;
  sku: string;
  tenantId: string;
}

/** One product whose selling price would sit under its floor on the NEXT printer document. */
export interface BelowFloorProduct {
  /** Published and active (the gate's own "live"): it is on sale right now. */
  live: boolean;
  newFloorMinor: number;
  priceMinor: number;
  productId: string;
  tenantId: string;
  /** The sellable unit with the largest shortfall: a variant, or null for the base price. */
  variantId: string | null;
}

/**
 * PLATFORM-ONLY (CP3-C review round 1): the products an edit pushes below the
 * PRISGOLV floor. Reported, never acted on — the edit does not suspend or
 * re-price them. `tooManyToCheck` when more products, mappings or variants
 * would need reading than one request does (never a silent partial list).
 */
export type BelowFloorReport =
  | { count: number; products: BelowFloorProduct[] }
  | { count: null; tooManyToCheck: true };

export interface PrinterEditDiff {
  /** Products with an active mapping on this printer priced under the NEXT document's floor (at most 200 listed). */
  belowFloor: BelowFloorReport;
  /** Top-level fields whose value changes. */
  fields: string[];
  models: KeyDiff;
  skus: KeyDiff;
  /** The mappings the edit suspends (or would suspend), at most 1 000 listed. */
  suspensions: PrinterEditSuspension[];
  tiers: KeyDiff;
  /** SKUs the printer lists after the edit that have no tier (mapping them is refused). */
  unpricedSkus: string[];
}

export type EditPrinterResult =
  | { diff: PrinterEditDiff; revision: number; status: "ok"; suspendedMappings: number }
  | { status: "not_found" }
  | {
      code: "concurrent_edit" | "revision_mismatch" | "tenant_printer" | "too_many_mappings";
      status: "conflict";
    }
  | {
      code: "invalid_capabilities" | "invalid_tiers" | "printer_not_allowed";
      problems: string[];
      status: "invalid";
    };

const PATCH_KEYS = [
  "capabilities",
  "expectedRevision",
  "name",
  "shippingCostMinor",
  "status",
  "tiers",
] as const;

export interface PrinterPatchInput {
  edit: PrinterEdit;
  expectedRevision?: number;
}

function parseSkuList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PRINTER_SKUS) {
    return null;
  }
  const seen = new Set<string>();
  for (const sku of value) {
    if (!isSkuKey(sku) || seen.has(sku)) {
      return null;
    }
    seen.add(sku);
  }
  return [...seen];
}

/**
 * `PATCH /v1/platform/printers/:id` body. Every key optional, at least one
 * edit: `{ name?, status?, shippingCostMinor?, capabilities?, tiers?:
 * { upsert?: [tier], remove?: [sku] }, expectedRevision? }`. Currency and
 * type are not editable here (a currency change would re-price every live
 * product; the type decides dispatch).
 */
export function parsePrinterPatchInput(body: unknown): PrinterPatchInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, PATCH_KEYS)) {
    return null;
  }
  const edit: PrinterEdit = {};
  if (body.name !== undefined) {
    if (!isLabel(body.name)) {
      return null;
    }
    edit.name = body.name;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "inactive") {
      return null;
    }
    edit.status = body.status;
  }
  if (body.shippingCostMinor !== undefined) {
    if (!isBoundedInt(body.shippingCostMinor, 0, MAX_COST_MINOR)) {
      return null;
    }
    edit.shippingCostMinor = body.shippingCostMinor;
  }
  if (body.capabilities !== undefined) {
    const capabilities = parsePrinterCapabilities(body.capabilities);
    if (capabilities === null) {
      return null;
    }
    edit.capabilities = capabilities;
  }
  if (body.tiers !== undefined) {
    const tiers = body.tiers;
    if (!isPlainObject(tiers) || !hasOnlyKeys(tiers, ["remove", "upsert"])) {
      return null;
    }
    const remove = tiers.remove === undefined ? [] : parseSkuList(tiers.remove);
    if (remove === null || (tiers.upsert !== undefined && !Array.isArray(tiers.upsert))) {
      return null;
    }
    const rawUpsert = (tiers.upsert ?? []) as unknown[];
    if (rawUpsert.length > MAX_PRINTER_SKUS) {
      return null;
    }
    const upsert: PrinterTierInput[] = [];
    const seen = new Set<string>();
    for (const raw of rawUpsert) {
      const tier = parseTierEntry(raw);
      if (tier === null || seen.has(tier.sku)) {
        return null;
      }
      seen.add(tier.sku);
      upsert.push(tier);
    }
    if (upsert.length === 0 && remove.length === 0) {
      return null;
    }
    edit.tiers = { kind: "patch", remove, upsert };
  }
  if (Object.keys(edit).length === 0) {
    return null;
  }
  if (body.expectedRevision === undefined) {
    return { edit };
  }
  return isBoundedInt(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER)
    ? { edit, expectedRevision: body.expectedRevision }
    : null;
}

/** JSON with object keys sorted, so two equal documents compare equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isPlainObject(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
      : entry,
  );
}

function keyDiff(
  before: Record<string, unknown> | ReadonlyMap<string, unknown>,
  after: Record<string, unknown> | ReadonlyMap<string, unknown>,
): KeyDiff {
  const asMap = (value: Record<string, unknown> | ReadonlyMap<string, unknown>) =>
    value instanceof Map ? (value as ReadonlyMap<string, unknown>) : new Map(Object.entries(value));
  const from = asMap(before);
  const to = asMap(after);
  const diff: KeyDiff = { added: [], changed: [], removed: [] };
  for (const [key, value] of to) {
    if (!from.has(key)) {
      diff.added.push(key);
    } else if (stableJson(from.get(key)) !== stableJson(value)) {
      diff.changed.push(key);
    }
  }
  for (const key of from.keys()) {
    if (!to.has(key)) {
      diff.removed.push(key);
    }
  }
  diff.added.sort();
  diff.changed.sort();
  diff.removed.sort();
  return diff;
}

function storedTier(row: { blank_cost_minor: number; print_costs_json: string; sku: string }): PrinterTierInput {
  const prints: Partial<Record<PrintSlot, number>> = {};
  const parsed = parseJsonOrNull(row.print_costs_json);
  if (isPlainObject(parsed)) {
    for (const [slot, cost] of Object.entries(parsed)) {
      if (isPrintSlot(slot) && isBoundedInt(cost, 0, MAX_COST_MINOR)) {
        prints[slot] = cost;
      }
    }
  }
  return { blankCostMinor: row.blank_cost_minor, printCostsMinor: prints, sku: row.sku };
}

/** At most this many active mappings on ONE printer are revalidated; more refuses (never truncates). */
const MAX_EDIT_MAPPINGS = 10_000;
const LISTED_SUSPENSIONS = 1_000;
export const PRINTER_REVISION_CONFLICT = "printer revision conflict";

interface EditMappingRow extends MappingCheckRow {
  product_id: string;
  tenant_id: string;
}

// ── the floor report (CP3-C review round 1) ────────────────────────────────

/** Bounds of the floor check: above any of them the report is `tooManyToCheck`. */
const MAX_FLOOR_PRODUCTS = 1_000;
const MAX_FLOOR_MAPPINGS = 20_000;
const MAX_FLOOR_VARIANTS = 20_000;
const LISTED_BELOW_FLOOR = 200;

/** Every product with an ACTIVE mapping on the printer (bound: the printer id). */
const FLOOR_PRODUCT_IDS = `SELECT product_id FROM pod_mappings WHERE printer_id = ? AND status = 'active'`;

interface FloorProductRow {
  b2c_price_minor: number;
  currency: string;
  live: number;
  product_id: string;
  tenant_id: string;
  vat_rate_bp: number;
}

interface FloorMappingRow {
  id: string;
  printer_id: string;
  product_id: string;
  sku: string;
  slots_json: string;
  status: "active" | "suspended";
  variant_id: string | null;
}

interface FloorVariantRow {
  price_minor: number;
  product_id: string;
  variant_id: string;
}

function floorReadStatements(db: D1Database, printerId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT product.tenant_id, product.product_id, product.b2c_price_minor, product.currency,
                tenant.vat_rate_bp,
                (product.status = 'active' AND EXISTS (
                   SELECT 1 FROM product_publications AS publication
                   WHERE publication.product_id = product.product_id
                     AND publication.tenant_id = product.tenant_id
                     AND publication.published = 1)) AS live
         FROM products AS product
         INNER JOIN tenants AS tenant ON tenant.tenant_id = product.tenant_id
         WHERE product.product_id IN (${FLOOR_PRODUCT_IDS})
         ORDER BY product.tenant_id, product.product_id
         LIMIT ?`,
      )
      .bind(printerId, MAX_FLOOR_PRODUCTS + 1),
    db
      .prepare(
        `SELECT id, product_id, variant_id, printer_id, sku, slots_json, status
         FROM pod_mappings
         WHERE status IN ('active', 'suspended')
           AND product_id IN (${FLOOR_PRODUCT_IDS})
         LIMIT ?`,
      )
      .bind(printerId, MAX_FLOOR_MAPPINGS + 1),
    db
      .prepare(
        `SELECT product_id, variant_id, price_minor
         FROM product_variants
         WHERE active = 1
           AND product_id IN (${FLOOR_PRODUCT_IDS})
         LIMIT ?`,
      )
      .bind(printerId, MAX_FLOOR_VARIANTS + 1),
  ];
}

/**
 * The floor of one mapping set priced on the NEXT printer document, with the
 * SAME two functions the quote route and the publish gate use
 * (evaluatePodGate → quoteSet → quotePodCost → quoteFromTier, then
 * podPriceFloorMinor): quoteFromTier takes the tier as facts, so the next
 * document's tier, currency and parcel are passed in instead of read from D1.
 * null — no floor to compare — exactly where the gate could not price the
 * set either: more than one printer or SKU, a slot twice, another printer, no
 * tier, an unpriced slot, or a currency other than the product's.
 */
function floorOnNextDocument(
  next: PrinterInput,
  nextTiers: ReadonlyMap<string, PrinterTierInput>,
  set: readonly FloorMappingRow[],
  product: FloorProductRow,
): number | null {
  const first = set[0];
  if (first === undefined || first.printer_id !== next.printerId) {
    return null;
  }
  const slots: PrintSlot[] = [];
  for (const mapping of set) {
    if (mapping.printer_id !== first.printer_id || mapping.sku !== first.sku) {
      return null;
    }
    let parsed: Array<{ slot: PrintSlot }>;
    try {
      parsed = JSON.parse(mapping.slots_json) as Array<{ slot: PrintSlot }>;
    } catch {
      return null;
    }
    for (const { slot } of parsed) {
      if (slots.includes(slot)) {
        return null;
      }
      slots.push(slot);
    }
  }
  const tier = nextTiers.get(first.sku);
  if (tier === undefined) {
    return null;
  }
  const quote = quoteFromTier(
    {
      blank_cost_minor: tier.blankCostMinor,
      currency: next.currency,
      print_costs_json: JSON.stringify(tier.printCostsMinor),
      shipping_cost_minor: next.shippingCostMinor,
    },
    { quantity: 1, slots },
  );
  if (quote === null || quote.breakdown.currency !== product.currency) {
    return null;
  }
  return podPriceFloorMinor(quote, product.vat_rate_bp);
}

/**
 * Which products the edit pushes below the floor. Units and sets follow the
 * publish gate (evaluatePodGate): the base price and every active variant, each
 * served by its variant's own active mapping set, else the product-level set.
 * A product with a SUSPENDED mapping — before this edit, or suspended by it —
 * cannot be sold at all (the gate answers pod_mapping_suspended); it appears
 * under `suspensions`, not here. An inactive printer makes nothing, so nothing
 * of it can sit under a floor.
 */
function productsBelowFloor(
  next: PrinterInput,
  nextTiers: ReadonlyMap<string, PrinterTierInput>,
  suspendedByEdit: ReadonlySet<string>,
  read: { mappings: FloorMappingRow[]; products: FloorProductRow[]; variants: FloorVariantRow[] },
): BelowFloorReport {
  if (
    read.products.length > MAX_FLOOR_PRODUCTS ||
    read.mappings.length > MAX_FLOOR_MAPPINGS ||
    read.variants.length > MAX_FLOOR_VARIANTS
  ) {
    return { count: null, tooManyToCheck: true };
  }
  if (next.status !== "active") {
    return { count: 0, products: [] };
  }
  const mappingsOf = new Map<string, FloorMappingRow[]>();
  for (const mapping of read.mappings) {
    mappingsOf.set(mapping.product_id, [...(mappingsOf.get(mapping.product_id) ?? []), mapping]);
  }
  const variantsOf = new Map<string, FloorVariantRow[]>();
  for (const variant of read.variants) {
    variantsOf.set(variant.product_id, [...(variantsOf.get(variant.product_id) ?? []), variant]);
  }

  const found: BelowFloorProduct[] = [];
  for (const product of read.products) {
    const mappings = mappingsOf.get(product.product_id) ?? [];
    if (mappings.some((mapping) => mapping.status === "suspended" || suspendedByEdit.has(mapping.id))) {
      continue;
    }
    const scopes = new Map<string, FloorMappingRow[]>();
    for (const mapping of mappings) {
      const key = mapping.variant_id ?? "";
      scopes.set(key, [...(scopes.get(key) ?? []), mapping]);
    }
    const units: Array<{ priceMinor: number; variantId: string | null }> = [
      { priceMinor: product.b2c_price_minor, variantId: null },
      ...(variantsOf.get(product.product_id) ?? []).map((variant) => ({
        priceMinor: variant.price_minor,
        variantId: variant.variant_id,
      })),
    ];
    let worst: BelowFloorProduct | null = null;
    for (const unit of units) {
      const set = (unit.variantId !== null ? scopes.get(unit.variantId) : undefined) ?? scopes.get("");
      const floor = set === undefined ? null : floorOnNextDocument(next, nextTiers, set, product);
      if (floor === null || unit.priceMinor >= floor) {
        continue;
      }
      if (worst === null || floor - unit.priceMinor > worst.newFloorMinor - worst.priceMinor) {
        worst = {
          live: product.live === 1,
          newFloorMinor: floor,
          priceMinor: unit.priceMinor,
          productId: product.product_id,
          tenantId: product.tenant_id,
          variantId: unit.variantId,
        };
      }
    }
    if (worst !== null) {
      found.push(worst);
    }
  }
  return { count: found.length, products: found.slice(0, LISTED_BELOW_FLOOR) };
}

/**
 * THE partial edit of one PLATFORM printer, shared by PATCH and the catalogue
 * apply (so both suspend and honour the environment policy identically).
 *
 *   1. ONE read batch: the printer (+ revision), its tiers, its active
 *      mappings (refused above MAX_EDIT_MAPPINGS — never truncated), and the
 *      floor report's facts (every product with an active mapping here, its
 *      live mappings and active variants).
 *   2. The next document = current + edit. Tiers of SKUs the next capability
 *      document no longer lists are dropped (a tier for an unlisted SKU can
 *      never be reached — the replace-all refuses one outright).
 *   3. printersAllowedIn(next) — the replace-all's environment policy.
 *   4. Suspensions decided with the replace-all's mappingSuspendReason, and
 *      `belowFloor` — the products the next document prices under their
 *      PRISGOLV floor — reported (dry run and real run alike), never acted on.
 *   5. Unless a dry run, ONE write batch: the printer row (FENCED: `revision =
 *      read + 1`, the 0035 trigger aborts the batch if anything moved the
 *      revision since step 1; the catalogue apply also fences on the stored
 *      catalogue's sha), the tier deletes/upserts, the suspensions, the audit
 *      row. All or nothing.
 */
export async function editPrinter(
  db: D1Database,
  principal: PlatformPrincipal,
  printerId: string,
  edit: PrinterEdit,
  now: number,
  options: PrinterEditOptions,
): Promise<EditPrinterResult> {
  const [printerResult, tierResult, mappingResult, ...floorResults] = await db.batch([
    db
      .prepare(
        `SELECT id, tenant_id, type, name, status, currency, shipping_cost_minor,
                capabilities_json, revision
         FROM printers WHERE id = ?`,
      )
      .bind(printerId),
    db
      .prepare(
        `SELECT sku, blank_cost_minor, print_costs_json
         FROM printer_sku_tiers WHERE printer_id = ? ORDER BY sku`,
      )
      .bind(printerId),
    db
      .prepare(
        `SELECT id, tenant_id, product_id, sku, slots_json
         FROM pod_mappings
         WHERE printer_id = ? AND status = 'active'
         ORDER BY id
         LIMIT ?`,
      )
      .bind(printerId, MAX_EDIT_MAPPINGS + 1),
    // The floor report's facts, in the same snapshot.
    ...floorReadStatements(db, printerId),
  ]);
  const [floorProducts, floorMappings, floorVariants] = floorResults;
  const row = (printerResult?.results ?? [])[0] as (PrinterRow & { revision: number }) | undefined;
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (row.tenant_id !== null) {
    return { code: "tenant_printer", status: "conflict" };
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== row.revision) {
    return { code: "revision_mismatch", status: "conflict" };
  }
  const mappings = (mappingResult?.results ?? []) as EditMappingRow[];
  if (mappings.length > MAX_EDIT_MAPPINGS) {
    return { code: "too_many_mappings", status: "conflict" };
  }

  const currentCapabilities = parseCapabilitiesJson(row.capabilities_json);
  const capabilities = edit.capabilities ?? currentCapabilities;
  if (capabilities === null) {
    return {
      code: "invalid_capabilities",
      problems: ["the stored capability document is not valid; send a complete `capabilities`"],
      status: "invalid",
    };
  }

  const currentTiers = tierMap(
    ((tierResult?.results ?? []) as Array<{ blank_cost_minor: number; print_costs_json: string; sku: string }>).map(
      storedTier,
    ),
  );
  const problems: string[] = [];
  let nextTiers: Map<string, PrinterTierInput>;
  if (edit.tiers?.kind === "replace") {
    nextTiers = new Map();
    for (const tier of edit.tiers.tiers) {
      if (nextTiers.has(tier.sku)) {
        problems.push(`tier ${tier.sku} is listed twice`);
      }
      nextTiers.set(tier.sku, tier);
    }
  } else {
    nextTiers = new Map(currentTiers);
    for (const sku of edit.tiers?.remove ?? []) {
      if (!currentTiers.has(sku)) {
        problems.push(`tiers.remove: ${sku} has no tier`);
      }
      nextTiers.delete(sku);
    }
    const removing = new Set(edit.tiers?.remove ?? []);
    for (const tier of edit.tiers?.upsert ?? []) {
      if (removing.has(tier.sku)) {
        problems.push(`tiers: ${tier.sku} is both upserted and removed`);
      }
      nextTiers.set(tier.sku, tier);
    }
  }
  const explicitlyTiered = new Set(
    edit.tiers?.kind === "replace"
      ? edit.tiers.tiers.map((tier) => tier.sku)
      : (edit.tiers?.upsert ?? []).map((tier) => tier.sku),
  );
  for (const sku of [...nextTiers.keys()]) {
    if (capabilities.skus[sku] !== undefined) {
      continue;
    }
    if (explicitlyTiered.has(sku)) {
      problems.push(`tier ${sku}: the printer does not list that SKU`);
    }
    // A tier for a SKU the printer no longer lists can never be reached.
    nextTiers.delete(sku);
  }
  if (problems.length > 0) {
    return { code: "invalid_tiers", problems, status: "invalid" };
  }

  const next: PrinterInput = {
    capabilities,
    currency: row.currency,
    name: edit.name ?? row.name,
    printerId: row.id,
    shippingCostMinor: edit.shippingCostMinor ?? row.shipping_cost_minor,
    status: edit.status ?? row.status,
    tiers: [...nextTiers.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
    type: row.type,
  };
  if (!printersAllowedIn([next], options.target)) {
    return {
      code: "printer_not_allowed",
      problems: [
        next.type === "api"
          ? `an api printer must be this environment's dispatch target (${options.target}) and list only SnapWear SKUs`
          : "a manual printer may not use a dispatch target's id",
      ],
      status: "invalid",
    };
  }

  const suspensions = new Map<SuspendReason, string[]>();
  const suspended: PrinterEditSuspension[] = [];
  let suspendedMappings = 0;
  for (const mapping of mappings) {
    const reason = mappingSuspendReason(capabilities, nextTiers, mapping);
    if (reason === null) {
      continue;
    }
    suspensions.set(reason, [...(suspensions.get(reason) ?? []), mapping.id]);
    suspendedMappings += 1;
    if (suspended.length < LISTED_SUSPENSIONS) {
      suspended.push({
        mappingId: mapping.id,
        productId: mapping.product_id,
        reason,
        sku: mapping.sku,
        tenantId: mapping.tenant_id,
      });
    }
  }

  const fields: string[] = [];
  if (next.name !== row.name) fields.push("name");
  if (next.status !== row.status) fields.push("status");
  if (next.shippingCostMinor !== row.shipping_cost_minor) fields.push("shippingCostMinor");
  if (currentCapabilities === null || stableJson(capabilities) !== stableJson(currentCapabilities)) {
    fields.push("capabilities");
  }
  const tierDiff = keyDiff(currentTiers, nextTiers);
  const suspendedIds = new Set([...suspensions.values()].flat());
  const diff: PrinterEditDiff = {
    belowFloor: productsBelowFloor(next, nextTiers, suspendedIds, {
      mappings: (floorMappings?.results ?? []) as FloorMappingRow[],
      products: (floorProducts?.results ?? []) as FloorProductRow[],
      variants: (floorVariants?.results ?? []) as FloorVariantRow[],
    }),
    fields,
    models: keyDiff(currentCapabilities?.models ?? {}, capabilities.models),
    skus: keyDiff(currentCapabilities?.skus ?? {}, capabilities.skus),
    suspensions: suspended,
    tiers: tierDiff,
    unpricedSkus: Object.keys(capabilities.skus)
      .filter((sku) => !nextTiers.has(sku))
      .sort(),
  };

  if (options.dryRun) {
    return { diff, revision: row.revision, status: "ok", suspendedMappings };
  }

  const iso = new Date(now).toISOString();
  const fence =
    options.catalogSha256 === undefined
      ? "1"
      : "(SELECT content_sha256 FROM printer_catalog WHERE printer_id = ?) IS ?";
  const fenceBinds = options.catalogSha256 === undefined ? [] : [printerId, options.catalogSha256];
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE printers
         SET name = ?, status = ?, shipping_cost_minor = ?, capabilities_json = ?,
             revision = CASE WHEN ${fence} THEN ? ELSE revision + 2 END,
             updated_at = max(?, created_at)
         WHERE id = ? AND tenant_id IS NULL`,
      )
      .bind(
        next.name,
        next.status,
        next.shippingCostMinor,
        JSON.stringify(capabilities),
        ...fenceBinds,
        row.revision + 1,
        iso,
        printerId,
      ),
  ];
  if (tierDiff.removed.length > 0) {
    statements.push(
      db
        .prepare(
          `DELETE FROM printer_sku_tiers
           WHERE printer_id = ? AND sku IN (SELECT value FROM json_each(?))`,
        )
        .bind(printerId, JSON.stringify(tierDiff.removed)),
    );
  }
  const written = [...tierDiff.added, ...tierDiff.changed]
    .map((sku) => nextTiers.get(sku))
    .filter((tier): tier is PrinterTierInput => tier !== undefined);
  if (written.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO printer_sku_tiers (
             printer_id, tenant_id, sku, blank_cost_minor, print_costs_json,
             created_at, updated_at
           )
           SELECT ?, NULL,
                  json_extract(tier.value, '$.sku'),
                  json_extract(tier.value, '$.blankCostMinor'),
                  json(json_extract(tier.value, '$.printCostsMinor')),
                  ?, ?
           FROM json_each(?) AS tier
           WHERE true
           ON CONFLICT(printer_id, sku) DO UPDATE SET
             blank_cost_minor = excluded.blank_cost_minor,
             print_costs_json = excluded.print_costs_json,
             updated_at = max(excluded.updated_at, printer_sku_tiers.created_at)`,
        )
        .bind(printerId, iso, iso, JSON.stringify(written)),
    );
  }
  statements.push(...suspensionStatements(db, suspensions, iso));
  const counts = (entry: KeyDiff) => ({
    added: entry.added.length,
    changed: entry.changed.length,
    removed: entry.removed.length,
  });
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, NULL, ?, ?, 'printers', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        options.action,
        printerId,
        crypto.randomUUID(),
        // Names and counts only — no prices in the audit trail.
        JSON.stringify({
          belowFloor: diff.belowFloor.count,
          ...(options.catalogSha256 === undefined ? {} : { catalogSha256: options.catalogSha256 }),
          fields,
          models: counts(diff.models),
          revision: row.revision + 1,
          skus: counts(diff.skus),
          suspendedMappings,
          tiers: counts(tierDiff),
        }),
        now,
      ),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes(PRINTER_REVISION_CONFLICT)) {
      return { code: "concurrent_edit", status: "conflict" };
    }
    throw error;
  }
  return { diff, revision: row.revision + 1, status: "ok", suspendedMappings };
}
