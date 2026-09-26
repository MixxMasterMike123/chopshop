import type { PlatformPrincipal } from "../auth/live-authorization";
import { SNAPWEAR_SKUS } from "../dispatch/snapwear-skus";

/**
 * Printers, their capabilities and their price tiers (LAUNCH_TODO A2–A4, A13).
 *
 * Ported from functions/src/print/printRouting.ts (resolvePrinterUid,
 * isSlotPrintableInAreas) and the SnapWear seed (scripts/seed-snapwear-printer.cjs).
 * Firebase routed by GARMENT through settings/printRouting; here the mapping
 * names the printer and the printer's SKU directly, so "routing" is the
 * printer set itself: one platform printer per environment (`fake-printer` in
 * staging, `snapwear` in production — the env's DISPATCH_TARGET), replaced
 * wholesale by PUT /v1/platform/printers.
 *
 * MONEY IS PLATFORM-ONLY (A13, "seller sees ONE number"). `printer_sku_tiers`
 * and `printers.shipping_cost_minor` are read by quotePodCost and the checkout
 * snapshot, never by a tenant projection; tenantPrinterView below is the only
 * tenant-facing shape and it carries capabilities alone.
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

interface PrinterRow {
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

const PRINTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SKU_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_PRINTERS = 10;
const MAX_MODELS = 500;
const MAX_SKUS = 5_000;
const MAX_AREA_MM = 2_000;
const MAX_COST_MINOR = 10_000_000;
const LABEL_MAX_LENGTH = 200;

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

function isPrintSlot(value: unknown): value is PrintSlot {
  return typeof value === "string" && (PRINT_SLOTS as readonly string[]).includes(value);
}

function parseArea(value: unknown): PrintArea | null {
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
  return typeof value === "string" && value.length >= 1 && value.length <= LABEL_MAX_LENGTH
    ? value
    : null;
}

function parseCapabilities(value: unknown): PrinterCapabilities | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["models", "skus"])) {
    return null;
  }
  const { models, skus } = value;
  if (!isPlainObject(models) || !isPlainObject(skus)) {
    return null;
  }
  const modelKeys = Object.keys(models);
  const skuKeys = Object.keys(skus);
  if (modelKeys.length > MAX_MODELS || skuKeys.length > MAX_SKUS) {
    return null;
  }

  const parsedModels: Record<string, PrinterModel> = {};
  for (const key of modelKeys) {
    const model = models[key];
    if (
      !MODEL_KEY_PATTERN.test(key) ||
      !isPlainObject(model) ||
      !hasOnlyKeys(model, ["garment", "name", "printAreasMm"])
    ) {
      return null;
    }
    const garment = model.garment;
    if (garment !== null && (typeof garment !== "string" || garment.length < 1 || garment.length > 40)) {
      return null;
    }
    const name = parseLabel(model.name);
    if (name === null || !isPlainObject(model.printAreasMm)) {
      return null;
    }
    const areas: Partial<Record<PrintSlot, PrintArea>> = {};
    for (const [slot, rawArea] of Object.entries(model.printAreasMm)) {
      const area = parseArea(rawArea);
      if (!isPrintSlot(slot) || area === null) {
        return null;
      }
      areas[slot] = area;
    }
    parsedModels[key] = {
      garment: garment as string | null,
      ...(name === undefined ? {} : { name }),
      printAreasMm: areas,
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

function parseTiers(value: unknown, capabilities: PrinterCapabilities): PrinterTierInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_SKUS) {
    return null;
  }
  const tiers: PrinterTierInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["blankCostMinor", "printCostsMinor", "sku"])) {
      return null;
    }
    const { blankCostMinor, printCostsMinor, sku } = raw;
    // A tier for a SKU the printer does not list could never be reached and
    // would only hide a typo in the operator's document.
    if (
      typeof sku !== "string" ||
      capabilities.skus[sku] === undefined ||
      seen.has(sku) ||
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
    seen.add(sku);
    tiers.push({ blankCostMinor, printCostsMinor: prints, sku });
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
    typeof printerId !== "string" ||
    !PRINTER_ID_PATTERN.test(printerId) ||
    (type !== "api" && type !== "manual") ||
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > LABEL_MAX_LENGTH ||
    (status !== "active" && status !== "inactive") ||
    typeof currency !== "string" ||
    !CURRENCY_PATTERN.test(currency) ||
    !isBoundedInt(shippingCostMinor, 0, MAX_COST_MINOR)
  ) {
    return null;
  }
  const capabilities = parseCapabilities(value.capabilities);
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

function toPrinter(row: PrinterRow): Printer | null {
  let capabilities: PrinterCapabilities | null;
  try {
    capabilities = parseCapabilities(JSON.parse(row.capabilities_json));
  } catch {
    capabilities = null;
  }
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

/** What a tenant admin may see of the printers it can map to: capability only. */
export interface TenantPrinterView {
  capabilities: PrinterCapabilities;
  name: string;
  printerId: string;
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
    .map((printer) => ({
      capabilities: printer.capabilities,
      name: printer.name,
      printerId: printer.printerId,
    }));
}

// ── the platform replace ────────────────────────────────────────────────────

export type SuspendReason = "slot_not_printable" | "sku_unavailable" | "unpriced";

interface MappingCheckRow {
  id: string;
  sku: string;
  slots_json: string;
}

function mappingSuspendReason(
  printer: PrinterInput,
  row: MappingCheckRow,
): SuspendReason | null {
  if (printer.capabilities.skus[row.sku] === undefined) {
    return "sku_unavailable";
  }
  let slots: Array<{ heightMm: number; slot: PrintSlot; widthMm: number }>;
  try {
    slots = JSON.parse(row.slots_json) as typeof slots;
  } catch {
    return "slot_not_printable";
  }
  for (const slot of slots) {
    const frame = slotFrame(printer.capabilities, row.sku, slot.slot);
    // A frame that shrank below the print it was sized for no longer holds it.
    if (frame === null || frame.w < slot.widthMm || frame.h < slot.heightMm) {
      return "slot_not_printable";
    }
  }
  const tier = printer.tiers.find((candidate) => candidate.sku === row.sku);
  if (tier === undefined || slots.some((slot) => tier.printCostsMinor[slot.slot] === undefined)) {
    return "unpriced";
  }
  return null;
}

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

/** D1 caps bound parameters at 100 per statement. */
const IN_CHUNK = 90;

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
    const active = await db
      .prepare(
        `SELECT id, sku, slots_json FROM pod_mappings
         WHERE printer_id = ? AND status = 'active'
         LIMIT 10000`,
      )
      .bind(printer.printerId)
      .all<MappingCheckRow>();
    for (const row of active.results) {
      const reason = mappingSuspendReason(printer, row);
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
             updated_at = excluded.updated_at
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
        `UPDATE printers SET status = 'inactive', updated_at = ?
         WHERE tenant_id IS NULL
           AND status = 'active'
           AND id NOT IN (SELECT value FROM json_each(?))`,
      )
      .bind(iso, JSON.stringify(ids)),
  );

  let suspendedMappings = 0;
  for (const [reason, mappingIds] of suspensions) {
    suspendedMappings += mappingIds.length;
    for (let start = 0; start < mappingIds.length; start += IN_CHUNK) {
      const chunk = mappingIds.slice(start, start + IN_CHUNK);
      statements.push(
        db
          .prepare(
            `UPDATE pod_mappings
             SET status = 'suspended', suspended_reason = ?, updated_at = ?
             WHERE status = 'active'
               AND id IN (${chunk.map(() => "?").join(", ")})`,
          )
          .bind(reason, iso, ...chunk),
      );
    }
  }

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
