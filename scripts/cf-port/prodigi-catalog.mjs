#!/usr/bin/env node
/**
 * CP11-U4: Prodigi catalogue importer. Mirrors scripts/snapwear-xlsx-to-json.py.
 *
 * Pulls GET /products/{sku} and POST /quotes (SE, Standard) from Prodigi's
 * SANDBOX for the blanks we offer and writes
 *   docs/cf-port/prodigi-catalog.json          the `catalog` document of PUT
 *                                              /v1/platform/printers/:id/catalog
 *                                              ({ models, skus, ... } + `pricingBasis`)
 *   docs/cf-port/prodigi-pricing-<date>.json   the EUR facts + the `eur` apply fragment
 *   docs/cf-port/prodigi-api-samples/*.json    the raw responses (fixtures for the tests)
 *
 *   PRODIGI_API_TOKEN=test_… node scripts/cf-port/prodigi-catalog.mjs          # fetch + build
 *   node scripts/cf-port/prodigi-catalog.mjs --offline                         # rebuild from saved samples
 *   PRODIGI_API_TOKEN=test_… node scripts/cf-port/prodigi-catalog.mjs --only=STTU169,JH001   # re-fetch only these models
 *
 * The key is read from the environment only, must start with `test_` (unless
 * --live, which this script's default run never uses), and is never logged or
 * written. At most 2 requests per second; a 429 is retried once after Retry-After.
 *
 * KEY FACTS THE DOCUMENT ENCODES (see docs/cf-port/CP11_U4_REPORT.md):
 *  - A Prodigi SKU is a PRODUCT; colour and size are `attributes` of an order
 *    item. The catalogue key of a colour x size is therefore
 *        <prodigiSku>.<colour-slug>.<size>          e.g. GLOBAL-TEE-GIL-64000.black.m
 *    (fits the Worker's SKU grammar [A-Za-z0-9._-]{1,64}); the adapter splits
 *    it back: sku = before the first ".", colour = slug with "-" -> " ", size = last part.
 *  - offsetTopMm is 0 for every frame: Prodigi places the file with
 *    sizing "fitPrintArea" inside the print area; there is no collar offset.
 *  - Frames: integer mm = round(px / 300 * 25.4) of the print-area pixel size.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SANDBOX_BASE = "https://api.sandbox.prodigi.com/v4.0";
export const LIVE_BASE = "https://api.prodigi.com/v4.0";
export const DPI = 300;
export const DESTINATION = "SE";
export const SKU_KEY_MAX = 64;
/** The EU labs we price against; a quote naming any other lab (uk*, au*, us*) is flagged, not priced into the model figure. */
export const EU_LABS = ["pl1", "nl2"];

/** Our garment code -> Prodigi product SKU (each confirmed by GET /products/{sku} = 200, 2026-10-19). */
export const MODELS = [
  { model: "64000", sku: "GLOBAL-TEE-GIL-64000", garment: "tee" },
  { model: "5000", sku: "GLOBAL-TEE-GIL-5000", garment: "tee" },
  { model: "2000", sku: "GLOBAL-TEE-GIL-2000", garment: "tee" },
  { model: "64V00", sku: "GLOBAL-TEE-GIL-64V00", garment: "tee" },
  { model: "18500", sku: "GLOBAL-HOOD-GIL-18500", garment: "hoodie" },
  { model: "STTU169", sku: "TEE-SS-STTU755", garment: "tee" },
  { model: "JH001", sku: "GLOBAL-HOOD-AWD-JH001", garment: "hoodie" },
  { model: "JH030", sku: "GLOBAL-SWEAT-AWD-JH030", garment: "sweatshirt" },
  { model: "BC3001", sku: "GLOBAL-TEE-BC-3001", garment: "tee" },
  // CP11-U4B (2026-10-20): Kent's list. Each string confirmed by GET /products/{sku} = 200 (docs/cf-port/CP11_U4B_REPORT.md).
  { model: "64000L", sku: "GLOBAL-TEE-GIL-64000L", garment: "tee" },
  { model: "18600", sku: "GLOBAL-HOOD-GIL-18600", garment: "hoodie" }, // zip hoodie: no zip value exists, hoodie is the closest
  { model: "64200", sku: "GLOBAL-TT-GIL-64200", garment: "tank" },
  { model: "JH001F", sku: "HOOD-AWD-JH001F", garment: "hoodie" },
  { model: "STAU773", sku: "H-BAG-LTOTE", garment: "tote" },
];

// ── pure functions (tested on saved fixtures) ──────────────────────────────

export function pxToMm(px, dpi = DPI) {
  return Math.round((px / dpi) * 25.4);
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The inverse of slug() for the colours Prodigi lists: only valid when colourOfSlug(slug(c)) === c. */
export function colourOfSlug(s) {
  return s.replace(/-/g, " ");
}

export function skuKey(prodigiSku, color, size) {
  return `${prodigiSku}.${slug(color)}.${slug(size)}`;
}

export function splitSkuKey(key) {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0 || last === first) return null;
  return { sku: key.slice(0, first), color: colourOfSlug(key.slice(first + 1, last)), size: key.slice(last + 1) };
}

export function normSize(size) {
  const s = String(size).toLowerCase();
  return /^\d+xl$/.test(s) ? s.toUpperCase() : s === "one size" || s === "onesize" ? "One Size" : s.toUpperCase();
}

export function titleCase(text) {
  return String(text).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Variants of a product that Prodigi ships to the destination. */
export function variantsFor(product, country = DESTINATION) {
  return (product.variants ?? []).filter((v) => Array.isArray(v.shipsTo) && v.shipsTo.includes(country));
}

/**
 * The print-area pixel size of a variant for one slot, or null.
 */
export function areaPx(variant, slot) {
  const a = variant.printAreaSizes?.[slot];
  return a && a.horizontalResolution > 0 && a.verticalResolution > 0
    ? { w: a.horizontalResolution, h: a.verticalResolution }
    : null;
}

/**
 * The frame (mm) of a slot for a model. Several variants of one colour x size
 * may differ (Prodigi lists regional variants); the model's frame is the
 * SMALLEST area over the variants that ship to the destination, so a canvas
 * built to it never exceeds any variant's print area (fitPrintArea then only
 * ever places it, never shrinks it). Ties on area take the smaller width.
 */
export function modelFrame(variants, slot) {
  let best = null;
  for (const v of variants) {
    const a = areaPx(v, slot);
    if (a === null) continue;
    if (best === null || a.w * a.h < best.w * best.h || (a.w * a.h === best.w * best.h && a.w < best.w)) best = a;
  }
  return best === null ? null : { px: best, mm: { h: pxToMm(best.h), offsetTopMm: 0, w: pxToMm(best.w) } };
}

/** Distinct print-area sizes (per slot) over the shipping variants, for the report. */
export function areaVariants(variants, slot) {
  const seen = new Map();
  for (const v of variants) {
    const a = areaPx(v, slot);
    if (a) seen.set(`${a.w}x${a.h}`, (seen.get(`${a.w}x${a.h}`) ?? 0) + 1);
  }
  return Object.fromEntries(seen);
}

/** colour x size pairs the destination can receive, sorted. */
export function colourSizes(product, country = DESTINATION) {
  const pairs = new Map();
  // `edge` is a required quote/order attribute where a product lists more than one value (18600: Zip for white, Drawstring for the rest)
  const edges = new Set((product.variants ?? []).map((v) => v.attributes?.edge).filter((e) => typeof e === "string"));
  for (const v of variantsFor(product, country)) {
    const { color, size, edge } = v.attributes ?? {};
    if (typeof color === "string" && typeof size === "string") {
      const extra = edges.size > 1 && typeof edge === "string" ? { edge } : {};
      pairs.set(`${color}\u0000${size}`, { color, size, ...extra });
    }
    // a product without a size attribute (the tote): one pair per colour, size "one size", flagged so no size is ever sent to Prodigi
    else if (typeof color === "string" && size === undefined) pairs.set(`${color}\u0000`, { color, size: "one size", sizeless: true });
  }
  return [...pairs.values()].sort((a, b) => a.color.localeCompare(b.color) || sizeOrder(a.size) - sizeOrder(b.size));
}

const SIZE_ORDER = ["xs", "s", "m", "l", "xl", "2xl", "3xl", "4xl", "5xl"];
function sizeOrder(size) {
  const i = SIZE_ORDER.indexOf(String(size).toLowerCase());
  return i < 0 ? 99 : i;
}

export function eurToMinor(amount) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!m) throw new Error(`not a money amount: ${amount}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/**
 * Read one quote response. Returns { items: { "<id>": { unitMinor, lab } }, shipments: [{ lab, shippingMinor, itemIds }] }
 * or null when the response is not a usable quote (outcome != Created, no Standard quote).
 */
export function readQuote(body) {
  if (!body || body.outcome !== "Created" || !Array.isArray(body.quotes)) return null;
  const q = body.quotes.find((x) => x.shipmentMethod === "Standard") ?? body.quotes[0];
  if (!q || !Array.isArray(q.items) || !Array.isArray(q.shipments)) return null;
  const labOf = {};
  const shipments = q.shipments.map((s) => {
    const lab = s.fulfillmentLocation?.labCode ?? null;
    for (const id of s.items ?? []) labOf[id] = lab;
    return { itemIds: s.items ?? [], lab, shippingMinor: eurToMinor(s.cost?.amount ?? "0"), service: s.carrier?.service ?? null };
  });
  const items = {};
  for (const it of q.items) {
    if (it.unitCost?.currency !== "EUR") return null;
    items[it.id] = { unitMinor: eurToMinor(it.unitCost.amount), lab: labOf[it.id] ?? null };
  }
  return { items, shipments };
}

/** Build the catalogue document. products: { [model]: productResponse }, quotes: { [skuKey]: { unitMinor, lab } }. */
export function buildCatalog({ products, quotes, quoteDate, shipping, generatedAt }) {
  const models = {};
  const skus = {};
  const warnings = [];
  const unquoted = [];
  for (const def of MODELS) {
    const product = products[def.model]?.product;
    if (!product) {
      warnings.push(`model ${def.model}: no product response`);
      continue;
    }
    const vs = variantsFor(product);
    const front = modelFrame(vs, "front") ?? modelFrame(vs, "default");
    const back = modelFrame(vs, "back");
    const attrs = product.attributes ?? {};
    models[def.model] = {
      brand: attrs.brand?.[0] ?? null,
      name: product.description ?? null,
      garment: def.garment,
      prodigiSku: def.sku,
      front: front?.mm ?? null,
      back: back?.mm ?? null,
      printAreaPx: { front: front?.px ?? null, back: back?.px ?? null },
      printAreaVariants: { front: areaVariants(vs, "front"), back: areaVariants(vs, "back") },
      framesMissing: front === null,
    };
    if (front === null) warnings.push(`model ${def.model}: no front print area for ${DESTINATION}`);
    for (const { color, size, sizeless, edge } of colourSizes(product)) {
      const key = skuKey(def.sku, color, size);
      if (key.length > SKU_KEY_MAX) {
        warnings.push(`sku key too long (${key.length}): ${key}`);
        continue;
      }
      if (colourOfSlug(slug(color)) !== color.toLowerCase()) {
        warnings.push(`model ${def.model}: colour "${color}" does not survive slug/unslug`);
      }
      if (skus[key]) {
        warnings.push(`duplicate key ${key}`);
        continue;
      }
      const q = quotes[key];
      if (!q) unquoted.push(key);
      skus[key] = {
        model: def.model,
        garment: def.garment,
        colour: titleCase(color),
        size: normSize(size),
        prodigiSku: def.sku,
        attributes: sizeless ? { color } : { color, size, ...(edge !== undefined ? { edge } : {}) },
        ...(q ? { unitCostMinor: q.unitMinor, lab: q.lab } : {}),
      };
    }
  }
  const nonEu = Object.entries(skus).filter(([, v]) => v.lab && !EU_LABS.includes(v.lab));
  if (nonEu.length > 0) {
    const labs = [...new Set(nonEu.map(([, v]) => v.lab))].sort().join(", ");
    warnings.push(`${nonEu.length} SKUs were quoted from a non-EU lab (${labs}): customs/duty and a different shipping charge apply; they are in the catalogue with their lab named`);
  }
  return {
    document: {
      generatedAt,
      generator: "scripts/cf-port/prodigi-catalog.mjs",
      source: { api: SANDBOX_BASE, destination: DESTINATION, shippingMethod: "Standard", quoteDate },
      models,
      skus,
      unquoted,
      warnings,
    },
    shipping,
  };
}

/** The opaque `pricingBasis` of PUT .../catalog (<= 16 KiB) and the `eur` apply fragment. */
export function buildPricing({ document, shipping, quoteDate, extraItemMinor }) {
  const perModel = {};
  for (const [key, sku] of Object.entries(document.skus)) {
    if (sku.unitCostMinor === undefined) continue;
    if (!EU_LABS.includes(sku.lab)) {
      (perModel[sku.model] ??= { minMinor: Infinity, maxMinor: 0, labs: {}, quoted: 0 }).nonEuQuoted = ((perModel[sku.model]?.nonEuQuoted) ?? 0) + 1;
      continue;
    }
    const m = (perModel[sku.model] ??= { minMinor: Infinity, maxMinor: 0, labs: {}, quoted: 0 });
    m.minMinor = Math.min(m.minMinor, sku.unitCostMinor);
    m.maxMinor = Math.max(m.maxMinor, sku.unitCostMinor);
    const l = (m.labs[sku.lab] ??= { count: 0, minMinor: Infinity, maxMinor: 0 });
    l.count++;
    l.minMinor = Math.min(l.minMinor, sku.unitCostMinor);
    l.maxMinor = Math.max(l.maxMinor, sku.unitCostMinor);
    m.quoted++;
  }
  const plShipping = shipping?.pl1?.firstMinor ?? null;
  const pricingBasis = {
    currency: "EUR",
    unit: "minor (cents), ex VAT, one print incl., back print free",
    quoteDate,
    destination: DESTINATION,
    shippingMethod: "Standard",
    shippingCostMinor: plShipping,
    shippingByLab: shipping ?? {},
    extraItemMinor,
    vat: "Swedish VAT is added on top by Prodigi and is reclaimable; amounts here exclude it.",
    statsCoverEuLabsOnly: EU_LABS,
    perSkuIn: "catalog.skus[key].unitCostMinor / .lab",
    models: perModel,
  };
  const applyEur = {
    basis: "eur",
    note: "Fragment of POST .../catalog/apply `pricing`. eurSek and bufferBp are the platform's decision. baseEurCents is the HIGHEST unit cost quoted from an EU lab (pl1, nl2) for the model (applyCatalog prices a MODEL, not a SKU); extraPrintEurCents 0 because the back print is free.",
    extraPrintEurCents: 0,
    printSlots: ["front", "back"],
    // a model whose every quote came from a non-EU lab (JH001F, STAU773: uk9) has no EU price and is left out, not priced at 0
    models: Object.fromEntries(Object.entries(perModel).filter(([, v]) => v.quoted > 0).map(([m, v]) => [m, { baseEurCents: v.maxMinor }])),
  };
  return { pricingBasis, applyEur };
}

// ── network (only in main) ─────────────────────────────────────────────────

export function assertKey(key, live = false) {
  if (typeof key !== "string" || key.length < 8) throw new Error("PRODIGI_API_TOKEN is not set");
  if (!live && !key.startsWith("test_")) throw new Error("refusing a key that does not start with test_ (pass --live to override)");
}

function makeClient({ key, base, minGapMs = 500 }) {
  let last = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function call(method, path, body, retried = false) {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(base + path, {
      method,
      headers: { "X-API-Key": key, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && !retried) {
      const after = Number(res.headers.get("retry-after"));
      await sleep((Number.isFinite(after) && after > 0 ? after : 2) * 1000);
      return call(method, path, body, true);
    }
    console.error(`  ${method} ${path} -> ${res.status}`);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep null */
    }
    return { status: res.status, body: json, text };
  }
  return call;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
function writeJson(p, v, pretty = true) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, pretty ? 2 : 0) + "\n");
}

/**
 * One item per lab seen in a model's quote log (not already probed): quoted alone with 1 and with 2
 * copies it shows that lab's first-item shipping and the per-extra-item charge.
 */
export function pickProbes(log) {
  const probed = new Set(log.filter((e) => e.shippingProbe).map((e) => e.shippingProbe.lab));
  const picks = new Map();
  for (const e of log) {
    if (e.shippingProbe) continue;
    const q = readQuote(e.body);
    if (!q) continue;
    e.request.items.forEach((item, i) => {
      const lab = q.items[String(i + 1)]?.lab;
      if (lab && !probed.has(lab) && !picks.has(lab)) picks.set(lab, item);
    });
  }
  return [...picks].map(([lab, item]) => ({ lab, item }));
}

/** Quote jobs: one request per product x colour with every shippable size as an item. */
export function quoteJobs(def, product) {
  const byColour = new Map();
  const sizeless = new Set();
  const hasFront = variantsFor(product).some((v) => areaPx(v, "front") !== null);
  const extraOf = new Map();
  for (const { color, size, sizeless: sl, edge } of colourSizes(product)) {
    if (!byColour.has(color)) byColour.set(color, []);
    byColour.get(color).push(size);
    if (edge !== undefined) extraOf.set(`${color}\u0000${size}`, { edge });
    if (sl) sizeless.add(color);
  }
  return [...byColour].map(([color, sizes]) => ({
    model: def.model,
    color,
    sizes,
    request: {
      shippingMethod: "Standard",
      destinationCountryCode: DESTINATION,
      items: sizes.map((size) => ({
        sku: def.sku,
        copies: 1,
        attributes: sizeless.has(color) ? { color } : { color, size, ...(extraOf.get(`${color}\u0000${size}`) ?? {}) },
        assets: [{ printArea: hasFront ? "front" : "default" }],
      })),
    },
  }));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const offline = args.has("--offline");
  const live = args.has("--live");
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
  const samples = join(REPO, "docs/cf-port/prodigi-api-samples");
  const quoteDate = process.env.PRODIGI_QUOTE_DATE ?? new Date().toISOString().slice(0, 10);
  const products = {};
  const quotes = {};
  const shipping = {};
  let extraItemMinor = null;
  const quoteLog = {};

  if (args.has("--probe")) {
    // add the shipping probes to the saved quote logs (network), then rebuild offline
    const key = process.env.PRODIGI_API_TOKEN;
    assertKey(key, live);
    const call = makeClient({ key, base: live ? LIVE_BASE : SANDBOX_BASE });
    for (const def of MODELS) {
      const f = join(samples, `quotes-${def.sku}.json`);
      const log = readJson(f);
      for (const probe of pickProbes(log)) {
        for (const copies of [1, 2]) {
          const request = { shippingMethod: "Standard", destinationCountryCode: DESTINATION, items: [{ ...probe.item, copies }] };
          const res = await call("POST", "/quotes", request);
          log.push({ request, status: res.status, body: res.body, shippingProbe: { lab: probe.lab, copies } });
        }
      }
      writeJson(f, log, false);
      console.error(`probes ${def.model} done`);
    }
  }

  if (offline || args.has("--probe")) {
    for (const def of MODELS) products[def.model] = readJson(join(samples, `product-${def.sku}.json`));
    for (const def of MODELS) {
      const f = join(samples, `quotes-${def.sku}.json`);
      if (existsSync(f)) quoteLog[def.model] = readJson(f);
    }
  } else {
    const key = process.env.PRODIGI_API_TOKEN;
    assertKey(key, live);
    const call = makeClient({ key, base: live ? LIVE_BASE : SANDBOX_BASE });
    for (const def of MODELS) {
      if (only && !only.has(def.model)) {
        products[def.model] = readJson(join(samples, `product-${def.sku}.json`));
        quoteLog[def.model] = readJson(join(samples, `quotes-${def.sku}.json`));
        continue;
      }
      const r = await call("GET", `/products/${def.sku}`);
      console.error(`GET /products/${def.sku} -> ${r.status}`);
      if (r.status !== 200) throw new Error(`product ${def.sku} answered ${r.status}`);
      products[def.model] = r.body;
      writeJson(join(samples, `product-${def.sku}.json`), r.body, false);
      const log = [];
      for (const job of quoteJobs(def, r.body.product)) {
        let res = await call("POST", "/quotes", job.request);
        log.push({ request: job.request, status: res.status, body: res.body });
        if (readQuote(res.body) === null) {
          // one bad size must not hide the others: retry item by item
          for (const item of job.request.items) {
            const single = { ...job.request, items: [item] };
            res = await call("POST", "/quotes", single);
            log.push({ request: single, status: res.status, body: res.body });
          }
        }
      }
      for (const probe of pickProbes(log)) {
        for (const copies of [1, 2]) {
          const request = { shippingMethod: "Standard", destinationCountryCode: DESTINATION, items: [{ ...probe.item, copies }] };
          const res = await call("POST", "/quotes", request);
          log.push({ request, status: res.status, body: res.body, shippingProbe: { lab: probe.lab, copies } });
        }
      }
      writeJson(join(samples, `quotes-${def.sku}.json`), log, false);
      quoteLog[def.model] = log;
      console.error(`quotes ${def.model}: ${log.length} requests`);
    }
  }

  // fold the saved quote log into per-key prices and per-lab shipping
  for (const def of MODELS) {
    for (const e of quoteLog[def.model] ?? []) {
      const q = readQuote(e.body);
      if (!q) continue;
      if (e.shippingProbe) {
        const s = q.shipments.length === 1 ? q.shipments[0] : null;
        if (!s) continue;
        const slot = (shipping[e.shippingProbe.lab] ??= {});
        if (e.shippingProbe.copies === 1) slot.firstMinor = s.shippingMinor;
        else slot.twoCopiesMinor = s.shippingMinor;
        continue;
      }
      e.request.items.forEach((item, i) => {
        const hit = q.items[String(i + 1)];
        if (hit) quotes[skuKey(item.sku, item.attributes.color, item.attributes.size ?? "one size")] = hit;
      });
    }
  }
  for (const slot of Object.values(shipping)) {
    if (slot.firstMinor !== undefined && slot.twoCopiesMinor !== undefined) {
      const extra = slot.twoCopiesMinor - slot.firstMinor;
      slot.extraItemMinor = extra;
      if (extraItemMinor === null) extraItemMinor = extra;
    }
  }

  const generatedAt = process.env.PRODIGI_GENERATED_AT ?? new Date().toISOString();
  const { document } = buildCatalog({ products, quotes, quoteDate, shipping, generatedAt });
  const { pricingBasis, applyEur } = buildPricing({ document, shipping, quoteDate, extraItemMinor });
  document.pricingBasis = pricingBasis;
  writeJson(join(REPO, "docs/cf-port/prodigi-catalog.json"), document);
  writeJson(join(REPO, `docs/cf-port/prodigi-pricing-${quoteDate}.json`), { quoteDate, pricingBasis, applyPricingEur: applyEur });
  console.error(
    `models ${Object.keys(document.models).length}, skus ${Object.keys(document.skus).length}, unquoted ${document.unquoted.length}, warnings ${document.warnings.length}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(String(e?.message ?? e).replace(/test_[0-9a-f-]{36}/g, "test_…"));
    process.exit(1);
  });
}
