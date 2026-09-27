import type { PlatformPrincipal } from "../auth/live-authorization";
import type {
  EditPrinterResult,
  PrintArea,
  PrinterCapabilities,
  PrinterModel,
  PrinterTierInput,
  PrintSlot,
  TierEdit,
} from "./printers";
import {
  editPrinter,
  isGarment,
  isLabel,
  isModelKey,
  isPrintSlot,
  isSkuKey,
  MAX_COST_MINOR,
  MAX_PRINTER_MODELS,
  MAX_PRINTER_SKUS,
  parsePrintArea,
  parsePrinterCapabilities,
  parseTierEntry,
  PRINT_SLOTS,
} from "./printers";

/**
 * The supplier catalogue of a printer (CP3; migration 0035 `printer_catalog`,
 * Firebase `printerCatalog/{printerId}`) and the route that turns it into the
 * printer's capabilities and SKU tiers — what scripts/cf-port/seed-staging-slice.mjs
 * `printerDocument()` and scripts/seed-snapwear-printer.cjs did on the
 * operator's machine, now a Worker route with a dry run.
 *
 * PLATFORM-ONLY (A13, "never show our hand"): the catalogue is the supplier's
 * own sheet and the pricing basis is the supplier's list prices + our FX
 * assumptions. No tenant route reads this table; the tenant printer view is an
 * allowlist over the printer's capability document only.
 *
 * APPLY SEMANTICS: the selection REPLACES the printer's capability document
 * (the selected SKUs, and the models they point at, become the whole list) and
 * — unless `pricing.basis` is `keep` — its tier list. It runs through
 * editPrinter, the same code path as PATCH, so the environment policy and the
 * suspension of mappings the new document can no longer honour hold exactly as
 * for any other edit. `apply: true` writes; anything else is a dry run.
 */

/**
 * 1 MiB of UTF-8. The SnapWear catalogue is 48 KB as stored (JSON.stringify;
 * 77 KB pretty-printed on disk) for 47 models / 323 SKUs: >20× headroom,
 * inside D1's 2 MB value limit, and small enough to parse whole in one
 * request. The table CHECK enforces the same number.
 */
export const CATALOG_MAX_BYTES = 1_048_576;
export const PRICING_BASIS_MAX_BYTES = 16_384;
const SOURCE_MAX_LENGTH = 500;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ── store / read ────────────────────────────────────────────────────────────

export interface CatalogPutInput {
  /** JSON.stringify of the parsed `catalog` — exactly the stored (and hashed) text. */
  catalogJson: string;
  modelCount: number;
  pricingBasisJson: string | null;
  sizeBytes: number;
  skuCount: number;
  source: string | null;
}

export type ParseCatalogPutResult =
  | { input: CatalogPutInput; status: "ok" }
  | { problems: string[]; status: "invalid" }
  | { status: "too_large" };

/**
 * `PUT …/catalog` body: `{ catalog: {models:{…}, skus:{…}, …}, source?: string|null,
 * pricingBasis?: object|null }`. The document itself is carried as is (the
 * supplier's sheet has many fields the Worker never reads); only the shape the
 * apply depends on is checked here, and the apply checks each selected entry.
 */
export function parseCatalogPutInput(body: unknown): ParseCatalogPutResult {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["catalog", "pricingBasis", "source"])) {
    return { problems: ["the body is { catalog, source?, pricingBasis? }"], status: "invalid" };
  }
  const problems: string[] = [];
  const { catalog } = body;
  if (!isPlainObject(catalog) || !isPlainObject(catalog.models) || !isPlainObject(catalog.skus)) {
    return { problems: ["catalog must be an object with `models` and `skus` objects"], status: "invalid" };
  }
  for (const [sku, entry] of Object.entries(catalog.skus)) {
    if (!isPlainObject(entry) || typeof entry.model !== "string") {
      problems.push(`catalog.skus.${sku} must be an object naming its \`model\``);
      if (problems.length >= 20) break;
    }
  }
  const source = body.source ?? null;
  if (source !== null && (typeof source !== "string" || source.length < 1 || source.length > SOURCE_MAX_LENGTH)) {
    problems.push(`source must be a string of 1..${SOURCE_MAX_LENGTH} characters, or null`);
  }
  const basis = body.pricingBasis ?? null;
  let pricingBasisJson: string | null = null;
  if (basis !== null) {
    if (!isPlainObject(basis)) {
      problems.push("pricingBasis must be an object, or null");
    } else {
      pricingBasisJson = JSON.stringify(basis);
      if (encoder.encode(pricingBasisJson).length > PRICING_BASIS_MAX_BYTES) {
        problems.push(`pricingBasis must be at most ${PRICING_BASIS_MAX_BYTES} bytes of JSON`);
      }
    }
  }
  if (problems.length > 0) {
    return { problems, status: "invalid" };
  }
  const catalogJson = JSON.stringify(catalog);
  const sizeBytes = encoder.encode(catalogJson).length;
  if (sizeBytes > CATALOG_MAX_BYTES) {
    return { status: "too_large" };
  }
  return {
    input: {
      catalogJson,
      modelCount: Object.keys(catalog.models).length,
      pricingBasisJson,
      sizeBytes,
      skuCount: Object.keys(catalog.skus).length,
      source: source as string | null,
    },
    status: "ok",
  };
}

export interface CatalogMeta {
  contentSha256: string;
  importedAt: string;
  importedBy: string | null;
  modelCount: number;
  pricingBasis: unknown;
  printerId: string;
  sizeBytes: number;
  skuCount: number;
  source: string | null;
}

export interface CatalogView extends CatalogMeta {
  catalog: unknown;
}

export type StoreCatalogResult =
  | { catalog: CatalogMeta; status: "ok" }
  | { status: "not_found" | "tenant_printer" };

export async function storeCatalog(
  db: D1Database,
  principal: PlatformPrincipal,
  printerId: string,
  input: CatalogPutInput,
  now: number,
): Promise<StoreCatalogResult> {
  const printer = await db
    .prepare("SELECT tenant_id FROM printers WHERE id = ?")
    .bind(printerId)
    .first<{ tenant_id: string | null }>();
  if (printer === null) {
    return { status: "not_found" };
  }
  if (printer.tenant_id !== null) {
    return { status: "tenant_printer" };
  }
  const iso = new Date(now).toISOString();
  const contentSha256 = await sha256Hex(input.catalogJson);
  await db.batch([
    db
      .prepare(
        `INSERT INTO printer_catalog (
           printer_id, catalog_json, source, pricing_basis_json, content_sha256,
           imported_at, imported_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(printer_id) DO UPDATE SET
           catalog_json = excluded.catalog_json,
           source = excluded.source,
           pricing_basis_json = excluded.pricing_basis_json,
           content_sha256 = excluded.content_sha256,
           imported_at = excluded.imported_at,
           imported_by = excluded.imported_by`,
      )
      .bind(
        printerId,
        input.catalogJson,
        input.source,
        input.pricingBasisJson,
        contentSha256,
        iso,
        principal.userId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, NULL, ?, 'pod.printers.catalog.put', 'printer_catalog', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        printerId,
        crypto.randomUUID(),
        // The fingerprint and counts — never the supplier's prices.
        JSON.stringify({
          contentSha256,
          modelCount: input.modelCount,
          sizeBytes: input.sizeBytes,
          skuCount: input.skuCount,
        }),
        now,
      ),
  ]);
  return {
    catalog: {
      contentSha256,
      importedAt: iso,
      importedBy: principal.userId,
      modelCount: input.modelCount,
      pricingBasis: input.pricingBasisJson === null ? null : (JSON.parse(input.pricingBasisJson) as unknown),
      printerId,
      sizeBytes: input.sizeBytes,
      skuCount: input.skuCount,
      source: input.source,
    },
    status: "ok",
  };
}

interface CatalogRow {
  catalog_json: string;
  content_sha256: string;
  imported_at: string;
  imported_by: string | null;
  pricing_basis_json: string | null;
  source: string | null;
}

function countKeys(value: unknown): number {
  return isPlainObject(value) ? Object.keys(value).length : 0;
}

export async function readCatalog(db: D1Database, printerId: string): Promise<CatalogView | null> {
  const row = await db
    .prepare(
      `SELECT catalog_json, content_sha256, imported_at, imported_by, pricing_basis_json, source
       FROM printer_catalog WHERE printer_id = ?`,
    )
    .bind(printerId)
    .first<CatalogRow>();
  if (row === null) {
    return null;
  }
  const catalog = JSON.parse(row.catalog_json) as Record<string, unknown>;
  return {
    catalog,
    contentSha256: row.content_sha256,
    importedAt: row.imported_at,
    importedBy: row.imported_by,
    modelCount: countKeys(catalog.models),
    pricingBasis: row.pricing_basis_json === null ? null : (JSON.parse(row.pricing_basis_json) as unknown),
    printerId,
    sizeBytes: encoder.encode(row.catalog_json).length,
    skuCount: countKeys(catalog.skus),
    source: row.source,
  };
}

// ── pricing (exact integer arithmetic) ──────────────────────────────────────

/**
 * SnapWear quotes a garment in EUR INCLUDING its first print; each further
 * print location is `extraPrintEur` (scripts/seed-snapwear-printer.cjs
 * buildPricing). The tier splits that into its two axes, converted at
 * `rate × (1 + buffer)` and ROUNDED HALF UP TO WHOLE KRONOR (the Firebase
 * seed's `Math.round`, the POD money path's whole-kronor convention), stored
 * in öre:
 *
 *   blankCostMinor = 100 × round((P − X) × R × (10000 + B) / 10¹⁰)
 *   printCostMinor = 100 × round(      X × R × (10000 + B) / 10¹⁰)
 *
 *   P = the garment's price in euro CENTS, X = the extra-print price in euro
 *   cents, R = EUR→SEK rate × 10⁴ (11.20 → 112000), B = buffer in basis
 *   points (3 % → 300). All integers, evaluated in BigInt: no float ever
 *   touches the amount. Firebase evaluated the same formula in floats, which
 *   can land on the wrong side of an exact half krona (e.g. P = 4.35 € at
 *   rate 10.00, no buffer: exactly 10.50 kr → 11 kr here; the float
 *   expression gives 10.499999999999998 → 10 kr); everywhere else the two
 *   agree (test/printer-catalog.test.ts sweeps it).
 */
export function eurCentsToWholeKronorMinor(
  eurCents: number,
  rateE4: number,
  bufferBp: number,
): number {
  const numerator = BigInt(eurCents) * BigInt(rateE4) * BigInt(10_000 + bufferBp);
  const denominator = 10_000_000_000n;
  // round half up for a non-negative numerator: floor((2n + d) / 2d)
  const kronor = (2n * numerator + denominator) / (2n * denominator);
  return Number(kronor) * 100;
}

const RATE_PATTERN = /^(\d{1,2})(?:\.(\d{1,4}))?$/;

/**
 * The EUR→SEK rate as an exact integer × 10⁴. A number is read through its
 * shortest decimal string (11.2 → "11.2"), so anything with more than four
 * decimals or an exponent is refused rather than rounded. Bounds are the
 * Firebase seed's plausibility check (5 < rate < 20).
 */
export function parseRateE4(value: unknown): number | null {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : null;
  const match = text === null ? null : RATE_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const rateE4 = Number(match[1]) * 10_000 + Number((match[2] ?? "").padEnd(4, "0"));
  return rateE4 > 50_000 && rateE4 < 200_000 ? rateE4 : null;
}

// ── the apply input ─────────────────────────────────────────────────────────

export type CatalogPricing =
  /** Keep the printer's tiers for the SKUs that stay; new SKUs are unpriced. */
  | { basis: "keep" }
  /** Öre per selected MODEL, applied to every selected SKU of that model. */
  | {
      basis: "sek";
      models: Record<string, { blankCostMinor: number; printCostsMinor: Partial<Record<PrintSlot, number>> }>;
    }
  /** The Firebase seed's EUR basis, per selected MODEL. */
  | {
      basis: "eur";
      bufferBp: number;
      extraPrintEurCents: number;
      models: Record<string, { baseEurCents: number }>;
      printSlots: PrintSlot[];
      rateE4: number;
    };

export interface FrameOverride {
  fromModel?: string;
  printAreasMm?: Partial<Record<PrintSlot, PrintArea>>;
  provisional: boolean;
}

export interface CatalogApplyInput {
  apply: boolean;
  expectedCatalogSha256?: string;
  expectedRevision?: number;
  frames: Record<string, FrameOverride>;
  models: string[];
  pricing: CatalogPricing;
  skus: string[];
}

const MAX_BASE_EUR_CENTS = 1_000_000;
const MAX_EXTRA_PRINT_EUR_CENTS = 100_000;
const MAX_BUFFER_BP = 4_999;

function parseKeyList(value: unknown, isKey: (key: unknown) => key is string, max: number): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }
  const seen = new Set<string>();
  for (const key of value) {
    if (!isKey(key) || seen.has(key)) {
      return null;
    }
    seen.add(key);
  }
  return [...seen];
}

function parseFrames(value: unknown): Record<string, FrameOverride> | null {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value) || Object.keys(value).length > MAX_PRINTER_MODELS) {
    return null;
  }
  const frames: Record<string, FrameOverride> = {};
  for (const [model, raw] of Object.entries(value)) {
    if (
      !isModelKey(model) ||
      !isPlainObject(raw) ||
      !hasOnlyKeys(raw, ["fromModel", "printAreasMm", "provisional"]) ||
      (raw.fromModel === undefined) === (raw.printAreasMm === undefined) ||
      (raw.provisional !== undefined && typeof raw.provisional !== "boolean")
    ) {
      return null;
    }
    const provisional = raw.provisional !== false;
    if (raw.fromModel !== undefined) {
      if (!isModelKey(raw.fromModel)) {
        return null;
      }
      frames[model] = { fromModel: raw.fromModel, provisional };
      continue;
    }
    if (!isPlainObject(raw.printAreasMm) || Object.keys(raw.printAreasMm).length === 0) {
      return null;
    }
    const areas: Partial<Record<PrintSlot, PrintArea>> = {};
    for (const [slot, area] of Object.entries(raw.printAreasMm)) {
      const parsed = parsePrintArea(area);
      if (!isPrintSlot(slot) || parsed === null) {
        return null;
      }
      areas[slot] = parsed;
    }
    frames[model] = { printAreasMm: areas, provisional };
  }
  return frames;
}

function parsePricing(value: unknown): CatalogPricing | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (value.basis === "keep") {
    return hasOnlyKeys(value, ["basis"]) ? { basis: "keep" } : null;
  }
  if (!isPlainObject(value.models) || Object.keys(value.models).length > MAX_PRINTER_MODELS) {
    return null;
  }
  if (value.basis === "sek") {
    if (!hasOnlyKeys(value, ["basis", "models"])) {
      return null;
    }
    const models: Extract<CatalogPricing, { basis: "sek" }>["models"] = {};
    for (const [model, raw] of Object.entries(value.models)) {
      if (!isModelKey(model) || !isPlainObject(raw) || !hasOnlyKeys(raw, ["blankCostMinor", "printCostsMinor"])) {
        return null;
      }
      const tier = parseTierEntry({ ...raw, sku: "model" });
      if (tier === null) {
        return null;
      }
      models[model] = { blankCostMinor: tier.blankCostMinor, printCostsMinor: tier.printCostsMinor };
    }
    return { basis: "sek", models };
  }
  if (value.basis !== "eur") {
    return null;
  }
  if (!hasOnlyKeys(value, ["basis", "bufferBp", "eurSek", "extraPrintEurCents", "models", "printSlots"])) {
    return null;
  }
  const rateE4 = parseRateE4(value.eurSek);
  if (
    rateE4 === null ||
    !isBoundedInt(value.bufferBp, 0, MAX_BUFFER_BP) ||
    !isBoundedInt(value.extraPrintEurCents, 0, MAX_EXTRA_PRINT_EUR_CENTS) ||
    !Array.isArray(value.printSlots) ||
    value.printSlots.length === 0
  ) {
    return null;
  }
  const printSlots: PrintSlot[] = [];
  for (const slot of value.printSlots) {
    if (!isPrintSlot(slot) || printSlots.includes(slot)) {
      return null;
    }
    printSlots.push(slot);
  }
  const models: Record<string, { baseEurCents: number }> = {};
  for (const [model, raw] of Object.entries(value.models)) {
    if (
      !isModelKey(model) ||
      !isPlainObject(raw) ||
      !hasOnlyKeys(raw, ["baseEurCents"]) ||
      !isBoundedInt(raw.baseEurCents, 0, MAX_BASE_EUR_CENTS)
    ) {
      return null;
    }
    models[model] = { baseEurCents: raw.baseEurCents };
  }
  return {
    basis: "eur",
    bufferBp: value.bufferBp,
    extraPrintEurCents: value.extraPrintEurCents,
    models,
    printSlots,
    rateE4,
  };
}

const APPLY_KEYS = [
  "apply",
  "expectedCatalogSha256",
  "expectedRevision",
  "frames",
  "models",
  "pricing",
  "skus",
] as const;

/**
 * `POST …/catalog/apply` body:
 *   { apply?: boolean (default false = DRY RUN),
 *     models?: [model], skus?: [sku]          — at least one; the selection is
 *                                              every SKU of the listed models
 *                                              plus the listed SKUs,
 *     frames?: { <model>: { fromModel } | { printAreasMm }, provisional? } —
 *                                              stand-in frames (provisional
 *                                              unless `provisional: false`),
 *     pricing: { basis: "keep" }
 *            | { basis: "sek", models: { <model>: { blankCostMinor, printCostsMinor } } }
 *            | { basis: "eur", eurSek, bufferBp, extraPrintEurCents, printSlots,
 *                models: { <model>: { baseEurCents } } },
 *     expectedRevision?: n, expectedCatalogSha256?: hex }
 */
export function parseCatalogApplyInput(body: unknown): CatalogApplyInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, APPLY_KEYS)) {
    return null;
  }
  if (body.apply !== undefined && typeof body.apply !== "boolean") {
    return null;
  }
  const models = parseKeyList(body.models, isModelKey, MAX_PRINTER_MODELS);
  const skus = parseKeyList(body.skus, isSkuKey, MAX_PRINTER_SKUS);
  const frames = parseFrames(body.frames);
  const pricing = parsePricing(body.pricing);
  if (models === null || skus === null || frames === null || pricing === null) {
    return null;
  }
  const input: CatalogApplyInput = { apply: body.apply === true, frames, models, pricing, skus };
  if (body.expectedRevision !== undefined) {
    if (!isBoundedInt(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    input.expectedRevision = body.expectedRevision;
  }
  if (body.expectedCatalogSha256 !== undefined) {
    if (typeof body.expectedCatalogSha256 !== "string" || !SHA256_PATTERN.test(body.expectedCatalogSha256)) {
      return null;
    }
    input.expectedCatalogSha256 = body.expectedCatalogSha256;
  }
  return input;
}

// ── the builder (pure) ──────────────────────────────────────────────────────

export interface BuiltPrinterDocument {
  capabilities: PrinterCapabilities;
  /** undefined = keep the current tiers (basis `keep`). */
  tiers: TierEdit | undefined;
}

/**
 * The catalogue frame for one slot, as the slice seed's `frame()` builds it:
 * `{ h, w }` plus `offsetTopMm` when it is an integer. null when the catalogue
 * has no frame there; "invalid" when it has one the capability schema refuses.
 */
function catalogFrame(model: Record<string, unknown>, slot: "back" | "front"): PrintArea | null | "invalid" {
  const raw = model[slot];
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!isPlainObject(raw)) {
    return "invalid";
  }
  const area = parsePrintArea({
    h: raw.h,
    w: raw.w,
    ...(Number.isInteger(raw.offsetTopMm) ? { offsetTopMm: raw.offsetTopMm } : {}),
  });
  return area ?? "invalid";
}

/** front/back frames of a catalogue model (SnapWear prints no sleeves). */
function catalogFrames(
  model: Record<string, unknown>,
  name: string,
  problems: string[],
): Partial<Record<PrintSlot, PrintArea>> {
  const areas: Partial<Record<PrintSlot, PrintArea>> = {};
  for (const slot of ["back", "front"] as const) {
    const frame = catalogFrame(model, slot);
    if (frame === "invalid") {
      problems.push(`model ${name}: the catalogue's ${slot} frame is not a valid frame`);
    } else if (frame !== null) {
      areas[slot] = frame;
    }
  }
  return areas;
}

function skuLabel(entry: Record<string, unknown>): string | undefined | null {
  const parts = [entry.colour, entry.size].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (parts.length === 0) {
    return undefined;
  }
  const label = parts.join(" / ");
  return isLabel(label) ? label : null;
}

/**
 * The printer document a selection of the catalogue produces — the slice
 * seed's printerDocument() generalised: each selected SKU becomes
 * `{ model, label: "<colour> / <size>" }`, each model it points at becomes
 * `{ garment, name, printAreasMm: { front, back } }` from the catalogue's
 * frames (or a stand-in, marked provisional), and the tiers follow `pricing`.
 */
export function buildFromCatalog(
  catalog: unknown,
  input: CatalogApplyInput,
): { built: BuiltPrinterDocument; status: "ok" } | { problems: string[]; status: "invalid" } {
  const problems: string[] = [];
  if (!isPlainObject(catalog) || !isPlainObject(catalog.models) || !isPlainObject(catalog.skus)) {
    return { problems: ["the stored catalogue has no `models` / `skus` objects"], status: "invalid" };
  }
  const catalogModels = catalog.models;
  const catalogSkus = catalog.skus;
  const modelOf = (sku: string): string | null => {
    const entry = catalogSkus[sku];
    return isPlainObject(entry) && typeof entry.model === "string" ? entry.model : null;
  };

  const selected = new Set<string>();
  for (const model of input.models) {
    if (!Object.hasOwn(catalogModels, model)) {
      problems.push(`models: ${model} is not in the catalogue`);
      continue;
    }
    const ofModel = Object.keys(catalogSkus).filter((sku) => modelOf(sku) === model);
    if (ofModel.length === 0) {
      problems.push(`models: ${model} has no SKUs in the catalogue`);
    }
    for (const sku of ofModel) {
      selected.add(sku);
    }
  }
  for (const sku of input.skus) {
    if (!Object.hasOwn(catalogSkus, sku)) {
      problems.push(`skus: ${sku} is not in the catalogue`);
      continue;
    }
    selected.add(sku);
  }
  if (selected.size === 0 && problems.length === 0) {
    problems.push("select at least one model or SKU");
  }
  if (selected.size > MAX_PRINTER_SKUS) {
    problems.push(`the selection has ${selected.size} SKUs; a printer lists at most ${MAX_PRINTER_SKUS}`);
  }

  const skus: PrinterCapabilities["skus"] = {};
  const usedModels = new Set<string>();
  for (const sku of [...selected].sort()) {
    const entry = catalogSkus[sku];
    const model = modelOf(sku);
    if (!isSkuKey(sku) || !isPlainObject(entry) || model === null) {
      problems.push(`skus: ${sku} is not a usable catalogue SKU`);
      continue;
    }
    if (!isPlainObject(catalogModels[model])) {
      problems.push(`skus: ${sku} points at model ${model}, which the catalogue does not describe`);
      continue;
    }
    const label = skuLabel(entry);
    if (label === null) {
      problems.push(`skus: ${sku} has a colour/size label longer than 200 characters`);
      continue;
    }
    skus[sku] = label === undefined ? { model } : { label, model };
    usedModels.add(model);
  }

  for (const model of Object.keys(input.frames)) {
    if (!usedModels.has(model)) {
      problems.push(`frames: model ${model} is not in the selection`);
    }
  }

  const models: PrinterCapabilities["models"] = {};
  for (const model of [...usedModels].sort()) {
    const source = catalogModels[model] as Record<string, unknown>;
    if (!isModelKey(model)) {
      problems.push(`model ${model} is not a usable model key`);
      continue;
    }
    const override = input.frames[model];
    let areas: Partial<Record<PrintSlot, PrintArea>>;
    let provisional = false;
    if (override?.printAreasMm !== undefined) {
      areas = override.printAreasMm;
      provisional = override.provisional;
    } else if (override?.fromModel !== undefined) {
      const standIn = catalogModels[override.fromModel];
      if (!isPlainObject(standIn)) {
        problems.push(`frames.${model}.fromModel: ${override.fromModel} is not in the catalogue`);
        continue;
      }
      areas = catalogFrames(standIn, override.fromModel, problems);
      if (Object.keys(areas).length === 0) {
        problems.push(`frames.${model}.fromModel: ${override.fromModel} has no print frames either`);
      }
      provisional = override.provisional;
    } else {
      areas = catalogFrames(source, model, problems);
      if (Object.keys(areas).length === 0) {
        problems.push(
          `model ${model} has no print frames in the catalogue; give frames.${model} ({ fromModel } or { printAreasMm })`,
        );
      }
    }
    const entry: PrinterModel = {
      garment: isGarment(source.garment) ? source.garment : null,
      ...(isLabel(source.name) ? { name: source.name } : {}),
      printAreasMm: areas,
      ...(provisional ? { provisional: true as const } : {}),
    };
    models[model] = entry;
  }

  let tiers: TierEdit | undefined;
  const { pricing } = input;
  if (pricing.basis !== "keep") {
    for (const model of Object.keys(pricing.models)) {
      if (!usedModels.has(model)) {
        problems.push(`pricing.models: model ${model} is not in the selection`);
      }
    }
    const perModel = new Map<string, Omit<PrinterTierInput, "sku">>();
    if (pricing.basis === "sek") {
      for (const [model, price] of Object.entries(pricing.models)) {
        perModel.set(model, price);
      }
    } else {
      for (const [model, price] of Object.entries(pricing.models)) {
        if (price.baseEurCents < pricing.extraPrintEurCents) {
          problems.push(
            `pricing.models.${model}: baseEurCents is below extraPrintEurCents (the base price includes the first print)`,
          );
          continue;
        }
        const blankCostMinor = eurCentsToWholeKronorMinor(
          price.baseEurCents - pricing.extraPrintEurCents,
          pricing.rateE4,
          pricing.bufferBp,
        );
        const printMinor = eurCentsToWholeKronorMinor(
          pricing.extraPrintEurCents,
          pricing.rateE4,
          pricing.bufferBp,
        );
        if (blankCostMinor > MAX_COST_MINOR || printMinor > MAX_COST_MINOR) {
          problems.push(`pricing.models.${model}: the converted price exceeds ${MAX_COST_MINOR} öre`);
          continue;
        }
        const printCostsMinor: Partial<Record<PrintSlot, number>> = {};
        for (const slot of PRINT_SLOTS) {
          if (pricing.printSlots.includes(slot)) {
            printCostsMinor[slot] = printMinor;
          }
        }
        perModel.set(model, { blankCostMinor, printCostsMinor });
      }
    }
    const list: PrinterTierInput[] = [];
    for (const [sku, entry] of Object.entries(skus)) {
      const price = perModel.get(entry.model);
      if (price !== undefined) {
        list.push({ blankCostMinor: price.blankCostMinor, printCostsMinor: { ...price.printCostsMinor }, sku });
      }
    }
    tiers = { kind: "replace", tiers: list };
  }

  if (problems.length > 0) {
    return { problems, status: "invalid" };
  }
  const capabilities = parsePrinterCapabilities({ models, skus });
  if (capabilities === null) {
    return { problems: ["the built capability document does not validate"], status: "invalid" };
  }
  return { built: { capabilities, tiers }, status: "ok" };
}

// ── apply ───────────────────────────────────────────────────────────────────

/** The currency both pricing bases (`sek`, `eur`) produce amounts in. */
export const CATALOG_PRICING_CURRENCY = "SEK";

export type ApplyCatalogResult =
  | (Extract<EditPrinterResult, { status: "ok" }> & { catalogSha256: string })
  | Exclude<EditPrinterResult, { status: "ok" }>
  | { code: "catalog_changed" | "no_catalog"; status: "conflict" }
  | { code: "invalid_selection"; problems: string[]; status: "invalid" };

/**
 * Read the stored catalogue, build the printer document from the selection,
 * and hand it to editPrinter — the PATCH code path — as a dry run unless
 * `apply: true`. The write is fenced on the catalogue's sha: a catalogue
 * replaced between this read and the batch aborts the batch (409
 * concurrent_edit) instead of applying a document built from the old one.
 */
export async function applyCatalog(
  db: D1Database,
  principal: PlatformPrincipal,
  printerId: string,
  input: CatalogApplyInput,
  now: number,
  target: "fake-printer" | "snapwear",
): Promise<ApplyCatalogResult> {
  const row = await db
    .prepare(
      `SELECT p.id, p.currency, c.catalog_json, c.content_sha256
       FROM printers AS p
       LEFT JOIN printer_catalog AS c ON c.printer_id = p.id
       WHERE p.id = ?`,
    )
    .bind(printerId)
    .first<{ catalog_json: string | null; content_sha256: string | null; currency: string; id: string }>();
  if (row === null) {
    return { status: "not_found" };
  }
  if (row.catalog_json === null || row.content_sha256 === null) {
    return { code: "no_catalog", status: "conflict" };
  }
  if (input.expectedCatalogSha256 !== undefined && input.expectedCatalogSha256 !== row.content_sha256) {
    return { code: "catalog_changed", status: "conflict" };
  }
  // Both pricing bases produce amounts in SEK öre (`sek` by definition, `eur`
  // by converting to SEK), and the edit keeps the printer's own currency. On a
  // printer priced in anything else they would be stored as that currency's
  // minor units and corrupt every quote and price floor after it (Codex P2 on
  // CP3-C). `keep` writes no price and stays currency-independent.
  if (input.pricing.basis !== "keep" && row.currency !== CATALOG_PRICING_CURRENCY) {
    return {
      code: "invalid_selection",
      problems: [
        `pricing basis "${input.pricing.basis}" produces ${CATALOG_PRICING_CURRENCY} amounts, but the printer is priced in ${row.currency}`,
      ],
      status: "invalid",
    };
  }
  const built = buildFromCatalog(JSON.parse(row.catalog_json) as unknown, input);
  if (built.status === "invalid") {
    return { code: "invalid_selection", problems: built.problems, status: "invalid" };
  }
  const result = await editPrinter(
    db,
    principal,
    printerId,
    {
      capabilities: built.built.capabilities,
      ...(built.built.tiers === undefined ? {} : { tiers: built.built.tiers }),
    },
    now,
    {
      action: "pod.printers.catalog.apply",
      catalogSha256: row.content_sha256,
      dryRun: !input.apply,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      target,
    },
  );
  return result.status === "ok" ? { ...result, catalogSha256: row.content_sha256 } : result;
}
