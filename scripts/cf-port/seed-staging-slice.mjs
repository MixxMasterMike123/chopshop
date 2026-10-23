#!/usr/bin/env node
/**
 * scripts/cf-port/seed-staging-slice.mjs — seed the vertical slice on STAGING
 * (docs/cf-port/PLAN.md §10 CP2, routes-only since CP3), through the deployed Worker's real
 * routes. Stripe is called directly for two things only: reading (the platform account, the
 * connected account's metadata and payout schedule) and confirming the test payment as the
 * buyer's browser would. Every write to the shop goes through a route.
 *
 *   CHOPSHOP_API_URL=https://chopshop-api-stg.kent-ee2.workers.dev \
 *   [CHOPSHOP_WEB_URL=…  (default: cloudflare/pinned.staging.json origins.web)] \
 *   CHOPSHOP_PLATFORM_EMAIL=… CHOPSHOP_PLATFORM_PASSWORD=… \
 *   STRIPE_SECRET_KEY=sk_test_… [FAKE_PRINTER_TOKEN=…] [CHOPSHOP_SLICE_ADMIN_PASSWORD=…] \
 *   [CHOPSHOP_AFFILIATE_PASSWORD=…  (--affiliate)] \
 *   node scripts/cf-port/seed-staging-slice.mjs [--tenant slice-YYYYMMDD]
 *        [--purchase [--ref-code <CODE>]] [--refund <orderId>:<amountMinor>] [--connect-proof]
 *        [--printer fake-printer|prodigi|prodigi-prints] [--affiliate]
 *
 * Steps (each idempotent; every id is printed):
 *   0. refuse unless the API origin is cloudflare/pinned.staging.json origins.api, /health says
 *      "staging", /ready is on migration 0038 or later (the CP3 Worker), the Stripe key is a
 *      TEST key and its account is the pinned sandbox account;
 *   1. sign in as the platform user;
 *   2. tenant `slice-<yyyymmdd>` (UTC) whose storefront hostname IS the API host;
 *   3. an explicit `pod` feature row for the shop (POD is opt-in: no row, no POD);
 *   4. open the shop as the platform user (acting-as, 1 h);
 *   5. Stripe Connect through the routes: the platform enables Connect for the shop, the shop's
 *      account is created by the Worker (or is already there), Stripe's status is written by
 *      the refresh route, and while Stripe has not enabled charges an onboarding link is
 *      printed. Finish the onboarding in a browser and re-run;
 *   6. printers (default `--printer fake-printer`: the fake printer, capabilities from
 *      docs/SnapWearDocs/snapwear-catalog.json. `--printer prodigi` (CP11): the slice is seeded on
 *      a Prodigi row "prodigi" — model 64000, Gildan tee, SKUs GLOBAL-TEE-GIL-64000.black.m / .l from
 *      docs/cf-port/prodigi-catalog.json, shipping 135 SEK, tiers 60 kr blank + 40 kr per print —
 *      so one --purchase makes an order the dispatcher sends to Prodigi's SANDBOX. The printer PUT is
 *      replace-all, so the body carries every platform api/manual printer the environment policy
 *      still allows, rebuilt from GET /v1/platform/printers/{id} (the script stops if a view cannot
 *      be rebuilt without loss), plus the prodigi row; a printer the policy no longer allows on
 *      staging (the inactive `snapwear` row) is left out and named. An existing prodigi row that
 *      already holds the slice's SKUs is kept as it is. After --purchase the order id and where to
 *      look (GET /v1/platform/print-jobs, the Prodigi sandbox dashboard) are printed.
 *      `--printer prodigi-prints` (CP12 F2): the same on a SECOND Prodigi row "prodigi-prints"
 *      (D4: one printer row per family, its own shipping) — model BFP-12X16, a white-framed
 *      12×16" poster (kind flat, its 3543 × 4724 px sheet, Prodigi's `default` area and fixed
 *      attributes) from docs/cf-port/prodigi-prints-catalog.json, shipping 150 SEK, tier 220 kr
 *      blank + 0 kr for its one print (placeholders); the product `SLICE-POSTER-…` is mapped to
 *      GLOBAL-BFP-12X16.white-frame.12x16 with fit `contain` on white, and --purchase ships to SE),
 *      the DTG profile, artwork (.bench/render-bench-typical.png if present, else a generated
 *      3600 × 3600 PNG — the real render container needs ≥ 300 DPI at 300 mm), wait for
 *      `ready`, product, mapping, quote, publish, platform approval, the public PDP;
 *   7. the re-screen route until no product is pending (rows older than 0034 hold no text);
 *   8. --purchase: the shop must be LEGALLY READY (the checkout gate): platform terms accepted
 *      and the legal pages adopted by the shop's OWN admin (a platform user acting-as cannot
 *      sign for the seller), a return address and the VAT answer in the store settings. What
 *      is missing is done as the slice tenant admin `slice-admin+<tenant>@example.com`
 *      (created with CHOPSHOP_SLICE_ADMIN_PASSWORD when absent). Then checkout (pickup, the
 *      buyer's terms consent) → PaymentIntent → Stripe confirm with pm_card_visa → the receipt
 *      poll until the webhook made the order;
 *   9. --refund <orderId>:<amountMinor>: a partial refund through the admin route, with an
 *      Idempotency-Key derived from (tenant, order, amount) — re-running the same command
 *      replays the first refund instead of making a second one;
 *  10. --connect-proof (docs/cf-port/CP3_F_REPORT.md, the v1 proof list): the dashboard login
 *      link as the shop's own admin and refused to the platform user acting-as, then the
 *      payout delay set to 7 days and back to the country's minimum.
 *  11. --affiliate (CP13 A4): the shop's `affiliate` add-on switched ON through the platform
 *      features route; ONE affiliate "Anna Affiliate" <anna-affiliate+<tenant>@example.com> with
 *      the code ANNA10 invited through POST /v1/admin/affiliates (as the platform user
 *      acting-as; nothing else is approved); her password SET through the staging reset-token
 *      recipe (memory platform_users_and_superadmin): a token minted here, its HASHED identifier
 *      (SHA-256 base64url of `reset-password:<token>`, Better Auth's storeIdentifier "hashed")
 *      written to D1's `verification` with ONE `wrangler d1 execute --remote` INSERT … SELECT
 *      (the user id is read from `affiliates` in that statement), then
 *      POST /api/auth/reset-password with CHOPSHOP_AFFILIATE_PASSWORD, then a sign-in and
 *      GET /v1/affiliate/me as her; and ONE pending application ("Sara Sökande") through the
 *      storefront route on the web Worker. Re-running reuses all three.
 *      --ref-code <CODE> (with --purchase): the checkout carries `refCode` as a `?ref=` landing
 *      would have left it in the cart; the script stops if the code took nothing off.
 *
 * STOREFRONT ROUTES (since the 2026-10-14 audit, F16) are served only by the WEB Worker, as
 * `<web origin>/_api/<tenant id>/v1/…` (cloudflare/web/src/routing.ts: the first segment is the
 * shop; api-allowlist.ts lists the paths; forward.ts drops Cookie and X-Tenant-* and sends no body
 * on a bodyless POST). So the tenant-exists check, the PDP, checkout, payment and the receipt poll
 * go there, with Origin = the web origin and no session; platform/admin calls stay on the API.
 *
 * Credentials come ONLY from the environment variables above. Nothing is written to disk and no
 * secret, cookie, reset token or receipt token is printed. Runs wrangler for exactly one
 * statement, and only with --affiliate (the hashed reset-token row above; the token itself never
 * leaves this process); everything else needs no D1 statement.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PINNED = JSON.parse(readFileSync(path.join(ROOT, "cloudflare/pinned.staging.json"), "utf8"));
const PRODIGI_CATALOG_PATH = path.join(ROOT, "docs/cf-port/prodigi-catalog.json");
const PRODIGI_PRINTS_CATALOG_PATH = path.join(ROOT, "docs/cf-port/prodigi-prints-catalog.json");
const CATALOG_PATH = path.join(ROOT, "docs/SnapWearDocs/snapwear-catalog.json");
const BENCH_PNG = path.join(ROOT, ".bench/render-bench-typical.png");

/** --printer, read early because the slice constants below depend on it (parseArgs validates it). */
const PRINTER_KIND = (() => {
  const at = process.argv.indexOf("--printer");
  return at === -1 ? "fake-printer" : (process.argv[at + 1] ?? "");
})();
/** CP12 F2: the posters row, a second Prodigi printer (everything PRODIGI says holds for it too). */
const PRINTS = PRINTER_KIND === "prodigi-prints";
const PRODIGI = PRINTER_KIND === "prodigi" || PRINTS;
const PRINTER_ID = PRINTS ? "prodigi-prints" : PRODIGI ? "prodigi" : "fake-printer";
/**
 * Fake printer: a crewneck (SnapWear model 18000), White S / M — the SKUs the worker suites use.
 * Prodigi: Gildan 64000 tee, Black M / L (keys `<prodigiSku>.<colour>.<size>` in prodigi-catalog.json).
 * Prodigi prints: the white-framed 12×16" poster (prodigi-prints-catalog.json; colour = the finish,
 * size = the sheet).
 */
const SLICE_MODEL = PRINTS ? "BFP-12X16" : PRODIGI ? "64000" : "18000";
const SLICE_SKUS = PRINTS
  ? ["GLOBAL-BFP-12X16.white-frame.12x16"]
  : PRODIGI
    ? ["GLOBAL-TEE-GIL-64000.black.m", "GLOBAL-TEE-GIL-64000.black.l"]
    : ["2700003", "2700004"];
/** CP12: the poster's placement, frozen on the mapping's slot (a garment mapping names none). */
const SLICE_SLOTS = PRINTS ? [{ background: "#ffffff", fit: "contain", slot: "front" }] : ["front"];
const PROFILE = {
  acceptedFormats: [{ ext: "png" }, { ext: "jpg" }],
  active: true,
  label: "Textil (DTG)",
  maxFileMb: 50,
  minDpi: 300,
  printAreaMm: { h: 400, w: 300 },
  profileId: "apparel_dtg",
  sortOrder: 0,
};
const PRICE_MINOR = 39_900;
/** The first migration of the routes this script calls (0038 = Connect onboarding). */
const REQUIRED_MIGRATION_PREFIX = "0038";
/** What the slice shop adopts as its legal pages until CP4 renders the templates. */
const LEGAL_TEMPLATE_VERSION = "2026-09-07";
const LEGAL_TEXTS = {
  angerratt: "<h1>Ångerrätt</h1><p>Testbutik på staging. Ingen verklig försäljning.</p>",
  integritetspolicy: "<h1>Integritetspolicy</h1><p>Testbutik på staging. Ingen verklig försäljning.</p>",
  kopvillkor: "<h1>Köpvillkor</h1><p>Testbutik på staging. Ingen verklig försäljning.</p>",
};
const RETURN_ADDRESS = "Slice Test AB\nTestgatan 1\n123 45 Teststad";
/** CP13 A4 (--affiliate): the seeded affiliate and the seeded pending application. */
const AFFILIATE_CODE = "ANNA10";
const AFFILIATE_NAME = "Anna Affiliate";
const APPLICANT_NAME = "Sara Sökande";
const RENDER_TIMEOUT_MS = Number(process.env.SLICE_RENDER_TIMEOUT_S ?? "600") * 1_000;

// ── plumbing ────────────────────────────────────────────────────────────────

function die(message) {
  console.error(`SEED REFUSED: ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function info(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    die(`${name} is not set`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const out = { affiliate: false, connectProof: false, purchase: false, refCode: null, refund: null, tenant: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--purchase") {
      out.purchase = true;
    } else if (arg === "--connect-proof") {
      out.connectProof = true;
    } else if (arg === "--affiliate") {
      out.affiliate = true;
    } else if (arg === "--ref-code") {
      const value = (argv[++index] ?? die("--ref-code needs a code")).trim().toUpperCase();
      if (!/^[A-Z0-9-]{3,20}$/.test(value)) {
        die("--ref-code needs a code of 3–20 letters, digits or dashes");
      }
      out.refCode = value;
    } else if (arg === "--printer") {
      const value = argv[++index] ?? die("--printer needs fake-printer, prodigi or prodigi-prints");
      if (value !== "fake-printer" && value !== "prodigi" && value !== "prodigi-prints") {
        die("--printer needs fake-printer, prodigi or prodigi-prints");
      }
    } else if (arg === "--tenant") {
      out.tenant = argv[++index] ?? die("--tenant needs a value");
    } else if (arg === "--refund") {
      const raw = argv[++index] ?? die("--refund needs <orderId>:<amountMinor>");
      const [orderId, amount] = raw.split(":");
      if (!/^[0-9a-f-]{36}$/.test(orderId ?? "") || !/^\d+$/.test(amount ?? "")) {
        die("--refund needs <orderId>:<amountMinor>");
      }
      out.refund = { amountMinor: Number(amount), orderId };
    } else {
      die(`unknown argument ${arg}`);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── configuration and the refusals ──────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.refCode !== null && !args.purchase) {
  die("--ref-code goes with --purchase");
}
const API = (() => {
  let url;
  try {
    url = new URL(requireEnv("CHOPSHOP_API_URL"));
  } catch {
    die("CHOPSHOP_API_URL is not a URL");
  }
  if (url.protocol !== "https:") {
    die("CHOPSHOP_API_URL must be https");
  }
  if (url.origin !== PINNED.origins.api) {
    die(`CHOPSHOP_API_URL ${url.origin} is not the pinned STAGING api origin ${PINNED.origins.api}`);
  }
  return url.origin;
})();
const API_HOST = new URL(API).host;
const WEB = (() => {
  let url;
  try {
    url = new URL(process.env.CHOPSHOP_WEB_URL?.trim() || PINNED.origins.web);
  } catch {
    die("CHOPSHOP_WEB_URL is not a URL");
  }
  if (url.protocol !== "https:") {
    die("CHOPSHOP_WEB_URL must be https");
  }
  if (url.origin !== PINNED.origins.web) {
    die(`CHOPSHOP_WEB_URL ${url.origin} is not the pinned STAGING web origin ${PINNED.origins.web}`);
  }
  return url.origin;
})();
const PLATFORM_EMAIL = requireEnv("CHOPSHOP_PLATFORM_EMAIL");
const PLATFORM_PASSWORD = requireEnv("CHOPSHOP_PLATFORM_PASSWORD");
const STRIPE_KEY = requireEnv("STRIPE_SECRET_KEY");
if (!/^(sk|rk)_test_/.test(STRIPE_KEY)) {
  die("STRIPE_SECRET_KEY is not a test-mode key (sk_test_/rk_test_)");
}
const FAKE_PRINTER_TOKEN = process.env.FAKE_PRINTER_TOKEN?.trim() || null;
const AFFILIATE_PASSWORD = (() => {
  if (!args.affiliate) {
    return null;
  }
  const value = process.env.CHOPSHOP_AFFILIATE_PASSWORD ?? "";
  if (value.length < 12) {
    die("--affiliate: set CHOPSHOP_AFFILIATE_PASSWORD (≥ 12 chars), the password the seeded affiliate gets");
  }
  return value;
})();

const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const TENANT_ID = args.tenant ?? `slice-${today}`;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(TENANT_ID)) {
  die(`tenant id ${TENANT_ID} is not a valid tenant id`);
}
const SHOP_NAME = `Slice ${TENANT_ID.replace(/^slice-/, "")}`;
const AFFILIATE_EMAIL = `anna-affiliate+${TENANT_ID}@example.com`;
const APPLICANT_EMAIL = `sara-applicant+${TENANT_ID}@example.com`;
// ── the API ─────────────────────────────────────────────────────────────────

let platformCookie = null;

async function api(method, route, options = {}) {
  // options.web: a storefront route, served only by the web Worker as /_api/<shop>/v1/… (F16).
  const base = options.web === true ? `${WEB}/_api/${TENANT_ID}` : API;
  const headers = { origin: options.web === true ? WEB : API };
  if (options.session === true) {
    headers.cookie = platformCookie;
  }
  Object.assign(headers, options.headers ?? {});
  if (options.shop === true) {
    headers["x-shop-id"] = TENANT_ID;
  }
  let body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.bytes !== undefined) {
    // A Buffer body has a known length, so fetch sends Content-Length itself —
    // the upload route requires it (Worker-streamed, size-checked).
    body = options.bytes;
  }
  const response = await fetch(`${base}${route}`, { body, headers, method, redirect: "manual" });
  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { headers: response.headers, json, status: response.status, text };
}

function expectStatus(result, allowed, label) {
  if (!allowed.includes(result.status)) {
    die(`${label}: HTTP ${result.status} ${result.text.slice(0, 300)}`);
  }
  return result;
}

// ── Stripe (form-encoded REST; the key never leaves this process's memory) ──

function formEncode(value, prefix, pairs = []) {
  if (value === null || value === undefined) {
    return pairs;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      formEncode(entry, prefix === null ? key : `${prefix}[${key}]`, pairs);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => formEncode(entry, `${prefix}[${index}]`, pairs));
  } else {
    pairs.push([prefix, String(value)]);
  }
  return pairs;
}

async function stripe(method, route, params = null, idempotencyKey = null) {
  const headers = { authorization: `Bearer ${STRIPE_KEY}` };
  let url = `https://api.stripe.com${route}`;
  let body;
  if (params !== null && method === "GET") {
    url += `?${new URLSearchParams(formEncode(params, null)).toString()}`;
  } else if (params !== null) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(formEncode(params, null)).toString();
  }
  if (idempotencyKey !== null) {
    headers["idempotency-key"] = idempotencyKey;
  }
  const response = await fetch(url, { body, headers, method });
  const json = await response.json();
  if (!response.ok) {
    die(`Stripe ${method} ${route}: ${response.status} ${json?.error?.message ?? ""}`);
  }
  return json;
}

// ── artwork bytes ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A 3600 × 3600 RGB PNG (a diagonal two-tone motif): 304.8 DPI at 300 mm. */
function generatedPng(size = 3_600) {
  const row = Buffer.alloc(1 + size * 3);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    row[0] = 0;
    for (let x = 0; x < size; x += 1) {
      const dark = (Math.floor(x / 300) + Math.floor(y / 300)) % 2 === 0;
      row[1 + x * 3] = dark ? 0x22 : 0xee;
      row[2 + x * 3] = dark ? 0x44 : 0xcc;
      row[3 + x * 3] = dark ? 0x88 : 0x33;
    }
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the printer document, from the SnapWear catalogue ──────────────────────

/**
 * CP12 F2: the posters row from the flat catalogue — the same document the Worker's catalogue
 * apply builds (printer-catalog.ts buildFromCatalog): kind flat, the one `front` area in mm with
 * the sheet's exact `px`, Prodigi's `default` area name and the fixed attributes.
 */
function prodigiPrintsDocument() {
  const catalog = JSON.parse(readFileSync(PRODIGI_PRINTS_CATALOG_PATH, "utf8"));
  const model = catalog.models?.[SLICE_MODEL];
  const px = model?.printAreaPx?.front;
  if (model === undefined || model.kind !== "flat" || model.front == null || px == null) {
    die(`model ${SLICE_MODEL} is not a flat model with a front area and printAreaPx in ${PRODIGI_PRINTS_CATALOG_PATH}`);
  }
  const skus = {};
  for (const sku of SLICE_SKUS) {
    const entry = catalog.skus?.[sku];
    if (entry === undefined || String(entry.model) !== SLICE_MODEL) {
      die(`SKU ${sku} is not a model-${SLICE_MODEL} SKU in ${PRODIGI_PRINTS_CATALOG_PATH}`);
    }
    skus[sku] = { label: `${entry.colour} / ${entry.size}`, model: SLICE_MODEL };
  }
  const front = {
    h: model.front.h,
    ...(Number.isInteger(model.front.offsetTopMm) ? { offsetTopMm: model.front.offsetTopMm } : {}),
    px: { h: px.h, w: px.w },
    w: model.front.w,
  };
  return {
    capabilities: {
      models: {
        [SLICE_MODEL]: {
          attributes: model.attributes,
          garment: model.garment,
          kind: "flat",
          name: model.name,
          printAreasMm: { front },
          prodigiPrintArea: model.prodigiPrintArea ?? "default",
          requiredSlots: ["front"],
        },
      },
      skus,
    },
    currency: "SEK",
    name: "Prodigi prints (sandbox)",
    printerId: PRINTER_ID,
    provider: "prodigi",
    // Staging placeholders: shipping ≈ EUR 13.95 (prodigi_eu, the posters' first item) in SEK;
    // the tier ≈ EUR 19 for the 12×16 with its one print included (extraPrintEurCents 0).
    shippingCostMinor: 15_000,
    status: "active",
    tiers: SLICE_SKUS.map((sku) => ({ blankCostMinor: 22_000, printCostsMinor: { front: 0 }, sku })),
    type: "api",
  };
}

function prodigiDocument() {
  if (PRINTS) {
    return prodigiPrintsDocument();
  }
  const catalog = JSON.parse(readFileSync(PRODIGI_CATALOG_PATH, "utf8"));
  const model = catalog.models?.[SLICE_MODEL];
  if (model === undefined || model.front == null || model.back == null) {
    die(`model ${SLICE_MODEL} has no front/back frames in ${PRODIGI_CATALOG_PATH}`);
  }
  const frame = (area) => ({ h: area.h, w: area.w, ...(Number.isInteger(area.offsetTopMm) ? { offsetTopMm: area.offsetTopMm } : {}) });
  const skus = {};
  for (const sku of SLICE_SKUS) {
    const entry = catalog.skus?.[sku];
    if (entry === undefined || String(entry.model) !== SLICE_MODEL) {
      die(`SKU ${sku} is not a model-${SLICE_MODEL} SKU in ${PRODIGI_CATALOG_PATH}`);
    }
    skus[sku] = { label: `${entry.colour} / ${entry.size}`, model: SLICE_MODEL };
  }
  return {
    capabilities: {
      models: {
        [SLICE_MODEL]: {
          garment: model.garment ?? null,
          name: model.name,
          printAreasMm: { back: frame(model.back), front: frame(model.front) },
        },
      },
      skus,
    },
    currency: "SEK",
    name: "Prodigi (sandbox)",
    printerId: PRINTER_ID,
    provider: "prodigi",
    // Staging placeholders: shipping ≈ EUR 11.85 (PL Standard) in SEK; tiers as the fake printer's.
    shippingCostMinor: 13_500,
    status: "active",
    tiers: SLICE_SKUS.map((sku) => ({
      blankCostMinor: 6_000,
      printCostsMinor: { back: 4_000, front: 4_000 },
      sku,
    })),
    type: "api",
  };
}

/** The policy of src/pod/printers.ts printersAllowedIn for STAGING, per row. */
function allowedOnStaging(printer) {
  if (printer.type === "manual") {
    return printer.provider === "manual" && printer.printerId !== "fake-printer" && printer.printerId !== "snapwear";
  }
  return printer.provider === "fake" || printer.provider === "prodigi";
}

/** Every platform-owned api/manual printer, as a PrinterInput, or die if a view cannot be rebuilt. */
async function readPlatformPrinterInputs() {
  const ids = [];
  let cursor = null;
  for (;;) {
    const page = expectStatus(
      await api("GET", `/v1/platform/printers?limit=50${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { session: true }),
      [200],
      "list platform printers",
    );
    for (const printer of page.json.printers ?? []) {
      if (printer.tenantId === null) {
        ids.push(printer.printerId);
      }
    }
    cursor = page.json.nextCursor ?? null;
    if (cursor === null) {
      break;
    }
  }
  const inputs = [];
  const dropped = [];
  for (const id of ids) {
    const view = expectStatus(await api("GET", `/v1/platform/printers/${id}`, { session: true }), [200], `get printer ${id}`).json.printer;
    const costsOk = (view.tiers ?? []).every(
      (tier) => tier.printCostsMinor !== null && typeof tier.printCostsMinor === "object" && Number.isInteger(tier.blankCostMinor),
    );
    if (view.capabilitiesValid !== true || !costsOk || (view.type !== "api" && view.type !== "manual")) {
      die(`printer ${id} cannot be rebuilt into a PrinterInput without loss (capabilitiesValid ${view.capabilitiesValid}); not guessing`);
    }
    const input = {
      capabilities: view.capabilities,
      currency: view.currency,
      name: view.name,
      printerId: view.printerId,
      provider: view.provider,
      shippingCostMinor: view.shippingCostMinor,
      status: view.status,
      tiers: view.tiers.map((tier) => ({ blankCostMinor: tier.blankCostMinor, printCostsMinor: tier.printCostsMinor, sku: tier.sku })),
      type: view.type,
    };
    if (allowedOnStaging(input)) {
      inputs.push(input);
    } else {
      dropped.push(input);
    }
  }
  return { dropped, inputs };
}

function printerDocument() {
  if (PRODIGI) {
    return prodigiDocument();
  }
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const model = catalog.models?.[SLICE_MODEL];
  if (model === undefined || model.front === null || model.back === null) {
    die(`model ${SLICE_MODEL} has no front/back frames in ${CATALOG_PATH}`);
  }
  const frame = (area) => ({ h: area.h, w: area.w, ...(Number.isInteger(area.offsetTopMm) ? { offsetTopMm: area.offsetTopMm } : {}) });
  const skus = {};
  for (const sku of SLICE_SKUS) {
    const entry = catalog.skus?.[sku];
    if (entry === undefined || String(entry.model) !== SLICE_MODEL) {
      die(`SKU ${sku} is not a model-${SLICE_MODEL} SKU in the catalogue`);
    }
    skus[sku] = { label: `${entry.colour} / ${entry.size}`, model: SLICE_MODEL };
  }
  return {
    capabilities: {
      models: {
        [SLICE_MODEL]: {
          garment: model.garment ?? null,
          name: model.name,
          printAreasMm: { back: frame(model.back), front: frame(model.front) },
        },
      },
      skus,
    },
    currency: "SEK",
    name: "Fake printer (staging)",
    printerId: PRINTER_ID,
    // CP11 (migration 0057): an api printer names its provider; the staging fake's is `fake`.
    provider: "fake",
    // Staging placeholders (Firebase printshop prices: blank 60 kr, 40 kr per large print).
    shippingCostMinor: 4_900,
    status: "active",
    tiers: SLICE_SKUS.map((sku) => ({
      blankCostMinor: 6_000,
      printCostsMinor: { back: 4_000, front: 4_000 },
      sku,
    })),
    type: "api",
  };
}

// ── the run ─────────────────────────────────────────────────────────────────

async function preflight() {
  step("preflight");
  const health = expectStatus(await api("GET", "/health"), [200], "/health");
  if (health.json?.environment !== "staging") {
    die(`/health says environment ${health.json?.environment}, not staging`);
  }
  const ready = await api("GET", "/ready");
  const migration = ready.status === 200 ? String(ready.json?.migration ?? "") : "";
  if (!/^\d{4}_/.test(migration) || migration.slice(0, 4) < REQUIRED_MIGRATION_PREFIX) {
    die(
      `/ready answers ${ready.status} ${migration || ready.json?.database || ""}: this script needs the CP3 Worker ` +
        `on migration ${REQUIRED_MIGRATION_PREFIX} or later (apply the migrations, then deploy)`,
    );
  }
  info("web", `${WEB} (storefront routes: /_api/${TENANT_ID}/v1/…)`);
  info("api", `${API} (${health.json.service}, /ready ${migration})`);
  const account = await stripe("GET", "/v1/account");
  if (account.id !== PINNED.stripeAccountId) {
    die(`the Stripe key belongs to ${account.id}, not the pinned sandbox platform ${PINNED.stripeAccountId}`);
  }
  info("stripe platform", `${account.id} (test mode)`);
  if (FAKE_PRINTER_TOKEN !== null) {
    const probe = await fetch(`${API}/v1/staging/fake-printer/jobs?orderId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${FAKE_PRINTER_TOKEN}` },
    });
    info("fake printer", probe.status === 200 ? "lit (GET 200)" : `NOT reachable (HTTP ${probe.status})`);
  }
}

async function signIn() {
  step("platform sign-in");
  const response = await fetch(`${API}/api/auth/sign-in/email`, {
    body: JSON.stringify({ email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD }),
    headers: { "content-type": "application/json", origin: API },
    method: "POST",
  });
  if (response.status !== 200) {
    die(`platform sign-in failed: HTTP ${response.status}`);
  }
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]);
  if (cookies.length === 0) {
    die("sign-in set no session cookie");
  }
  platformCookie = cookies.join("; ");
  info("platform user", PLATFORM_EMAIL);
}

async function ensureTenant() {
  step(`tenant ${TENANT_ID} (storefront host ${API_HOST})`);
  const created = await api("POST", "/v1/platform/tenants", {
    json: { hostname: API_HOST, shopName: SHOP_NAME, tenantId: TENANT_ID },
    session: true,
  });
  if (created.status === 201) {
    info("tenant", `${TENANT_ID} created`);
    return;
  }
  if (created.status !== 409) {
    expectStatus(created, [201, 409], "create tenant");
  }
  // 409: the id or the host is taken. The host's storefront says which shop holds it.
  const storefront = await api("GET", "/v1/storefront", { web: true });
  if (storefront.status === 200 && storefront.json?.storefront?.name === SHOP_NAME) {
    info("tenant", `${TENANT_ID} exists (reused)`);
    return;
  }
  die(
    `the tenant id or the host ${API_HOST} is already taken by "${storefront.json?.storefront?.name ?? "?"}". ` +
      "One tenant can hold the API host: re-run with --tenant <that slice tenant's id> to reuse it " +
      `(find it: SELECT tenant_id FROM tenant_domains WHERE hostname = '${API_HOST}').`,
  );
}

/** POD is opt-in: without an explicit `pod` row the shop has no POD routes and cannot publish. */
async function ensurePodFeature() {
  step("features (explicit pod row)");
  const route = `/v1/platform/tenants/${TENANT_ID}/features`;
  const current = expectStatus(await api("GET", route, { session: true }), [200], "read features");
  const pod = (current.json.features ?? []).find((feature) => feature.key === "pod");
  if (pod?.enabled === true && pod.source === "explicit") {
    info("pod", "enabled (explicit row present)");
    return;
  }
  const written = expectStatus(
    await api("PUT", route, { json: { features: { pod: true } }, session: true }),
    [200],
    "PUT features",
  );
  const after = (written.json.features ?? []).find((feature) => feature.key === "pod");
  if (after?.enabled !== true || after.source !== "explicit") {
    die(`the pod feature is ${JSON.stringify(after)} after the write`);
  }
  info("pod", "enabled (explicit row written)");
}

/**
 * Stripe Connect through the routes (CP3-F): nothing here writes to Stripe or to D1 itself.
 * The platform session holds the acting-as grant, which the seller's Connect routes admit
 * (the dashboard login link excepted). Returns what the purchase needs.
 *
 * Until CP3 this script created the account itself and printed a D1 UPDATE for the reviewer.
 * The two Stripe calls it made, proven on the sandbox on 2026-09-27, are kept key for key in
 * cloudflare/test/connect-gateway.test.ts (SEED_ACCOUNT_PARAMS, SEED_LINK_KEYS).
 */
async function ensureConnect() {
  step("Stripe Connect (through the routes)");
  const platformRoute = `/v1/platform/tenants/${TENANT_ID}/connect`;
  let platformView = expectStatus(await api("GET", platformRoute, { session: true }), [200], "read connect").json.connect;
  if (!platformView.enabled) {
    platformView = expectStatus(
      await api("POST", `${platformRoute}/enable`, { session: true }),
      [200],
      "enable connect",
    ).json.connect;
    info("connect", "enabled for the shop by the platform");
  }

  if (platformView.accountId === null) {
    for (let attempt = 0; ; attempt += 1) {
      const created = expectStatus(
        await api("POST", "/v1/admin/payments/connect/account", { session: true, shop: true }),
        [200, 201, 202],
        "create the connected account",
      );
      if (created.status !== 202) {
        info("account", created.status === 201 ? "created by the Worker" : "already recorded");
        break;
      }
      if (attempt >= 12) {
        die("the account creation is still pending after 60 s (GET the platform connect view: its operations list says why)");
      }
      await sleep(5_000);
    }
  }

  const refreshed = expectStatus(
    await api("POST", "/v1/admin/payments/connect/refresh", { session: true, shop: true }),
    [200],
    "refresh the Connect status",
  ).json.connect;
  platformView = expectStatus(await api("GET", platformRoute, { session: true }), [200], "read connect").json.connect;
  if (platformView.accountId === null) {
    die("the shop has no connected account after the create and refresh routes");
  }
  info("account", platformView.accountId);
  info("status", refreshed.status);
  info("charges_enabled", String(refreshed.chargesEnabled));
  info("payouts_enabled", String(refreshed.payoutsEnabled));
  info("details_submitted", String(refreshed.detailsSubmitted));
  if (refreshed.requirementsDue.length > 0) {
    info("requirements due", refreshed.requirementsDue.join(", "));
  }

  // Read-only, from Stripe itself: whose account it is and how it pays out.
  const stripeAccount = await stripe("GET", `/v1/accounts/${platformView.accountId}`);
  const schedule = stripeAccount.settings?.payouts?.schedule ?? {};
  info("stripe metadata", `tenant_id=${stripeAccount.metadata?.tenant_id ?? "(none: made before the routes)"}`);
  info("payout schedule", `${schedule.interval ?? "?"}${schedule.monthly_anchor === undefined ? "" : `, day ${schedule.monthly_anchor}`}`);
  if (stripeAccount.charges_enabled !== refreshed.chargesEnabled) {
    die(`Stripe says charges_enabled ${stripeAccount.charges_enabled}, the shop says ${refreshed.chargesEnabled} right after a refresh`);
  }

  if (!refreshed.chargesEnabled) {
    const link = expectStatus(
      await api("POST", "/v1/admin/payments/connect/onboarding-link", { session: true, shop: true }),
      [200],
      "onboarding link",
    );
    console.log(
      "\n  Stripe has not enabled charges yet. Finish the sandbox onboarding (Stripe test data) at:\n" +
        `  ${link.json.onboarding.url}\n  (valid until ${link.json.onboarding.expiresAt}) then re-run this script.`,
    );
  }
  return { chargesEnabled: refreshed.chargesEnabled, id: platformView.accountId };
}

/**
 * The rest of the v1 proof list. The login link opens the seller's own Stripe dashboard, so
 * its URL is never printed: that it was issued, and to whom it was refused, is the proof.
 */
async function connectProof(account) {
  step("Connect proof (login link, payout delay)");
  if (!account.chargesEnabled) {
    die("the proof needs an account with charges enabled (finish the onboarding, re-run)");
  }
  const refused = await api("POST", "/v1/admin/payments/connect/login-link", { session: true, shop: true });
  if (refused.status !== 404) {
    die(`the login link answered ${refused.status} to the platform user acting-as: it must be the opaque 404`);
  }
  info("login link", "refused to the platform user acting-as (404)");
  const admin = await signInSliceAdmin("the login link goes to the shop's own admin only");
  const issued = expectStatus(
    await api("POST", "/v1/admin/payments/connect/login-link", { headers: { cookie: admin.cookie }, shop: true }),
    [200],
    "login link",
  );
  let host = "?";
  try {
    host = new URL(issued.json.dashboard.url).host;
  } catch {
    die("the login link is not a URL");
  }
  info("login link", `issued to ${admin.email} (host ${host})`);

  const route = `/v1/platform/tenants/${TENANT_ID}/connect/payout-delay`;
  for (const [delayDays, stored] of [[7, 7], ["minimum", null]]) {
    const result = expectStatus(await api("PUT", route, { json: { delayDays }, session: true }), [200], `payout delay ${delayDays}`);
    if (result.json.connect.payoutDelayDays !== stored) {
      die(`payout delay ${delayDays}: stored ${result.json.connect.payoutDelayDays}, expected ${stored}`);
    }
    const schedule = (await stripe("GET", `/v1/accounts/${account.id}`)).settings?.payouts?.schedule ?? {};
    info(`payout delay ${delayDays}`, `stored ${stored}, Stripe delay_days ${schedule.delay_days}, interval ${schedule.interval}`);
  }
}

/** Rows screened before 0034 hold no text: the re-screen route converges them, 25 per call. */
async function rescreen() {
  step("re-screen (until nothing is pending)");
  for (let call = 1; call <= 40; call += 1) {
    const result = expectStatus(
      await api("POST", "/v1/platform/screening-terms/rescreen", { session: true }),
      [200],
      "rescreen",
    ).json;
    info(`call ${call}`, `rescreened ${result.rescreened}, pending ${result.pending}, unverified ${result.unverified}`);
    if (result.pending === 0) {
      return;
    }
    if (result.rescreened === 0) {
      die(`${result.pending} product(s) stay pending and a call re-screened none`);
    }
  }
  die("products are still pending after 40 re-screen calls");
}

async function openShop() {
  step("acting-as (open the shop as the platform user, 1 h)");
  const granted = expectStatus(
    await api("POST", `/v1/platform/tenants/${TENANT_ID}/acting-as`, {
      json: { reason: "CP2 slice seed (seed-staging-slice.mjs)" },
      session: true,
    }),
    [201],
    "acting-as",
  );
  info("acting-as until", granted.json.expiresAt);
}

async function ensurePrintShop() {
  step("printers + profiles");
  const document = printerDocument();
  const current = expectStatus(
    await api("GET", "/v1/admin/pod/printers", { session: true, shop: true }),
    [200],
    "list printers",
  );
  const others = (current.json.printers ?? []).filter((printer) => printer.printerId !== PRINTER_ID);
  // With --printer prodigi the other printers are carried into the PUT, not deactivated.
  if (!PRODIGI && others.length > 0 && process.env.SLICE_ALLOW_PRINTER_REPLACE !== "1") {
    die(
      `PUT /v1/platform/printers is replace-all and would deactivate ${others.map((p) => p.printerId).join(", ")}; ` +
        "set SLICE_ALLOW_PRINTER_REPLACE=1 to proceed",
    );
  }
  // The PUT is replace-all for the printer's own SKUs too. Since 2026-10-04 the fake printer may
  // hold SnapWear's whole offer (applied through the catalogue routes), with other shops' mappings
  // on it: this document would cut it back to the slice's SKUs and SUSPEND every mapping on a SKU
  // it drops (it did, once: 250 mappings of another shop). A printer that already holds the slice's
  // SKUs and more is left exactly as it is.
  const existing = await api("GET", `/v1/platform/printers/${PRINTER_ID}`, { session: true });
  const existingSkus = existing.status === 200 ? Object.keys(existing.json?.printer?.capabilities?.skus ?? {}) : [];
  const prodigiHoldsSlice =
    PRODIGI && existing.json?.printer?.status === "active" && SLICE_SKUS.every((sku) => existingSkus.includes(sku));
  if (prodigiHoldsSlice) {
    info("printer", `${PRINTER_ID} (kept as it is: ${existingSkus.length} SKUs, the slice's among them)`);
  } else if (existingSkus.length > SLICE_SKUS.length && process.env.SLICE_ALLOW_PRINTER_REPLACE !== "1") {
    const missing = SLICE_SKUS.filter((sku) => !existingSkus.includes(sku));
    if (missing.length > 0 || existing.json?.printer?.status !== "active") {
      die(
        `${PRINTER_ID} holds ${existingSkus.length} SKUs but ${missing.length > 0 ? `not the slice's ${missing.join(", ")}` : "is not active"}; ` +
          "PUT /v1/platform/printers would replace its SKUs and suspend the mappings on the dropped ones: " +
          "set SLICE_ALLOW_PRINTER_REPLACE=1 to proceed",
      );
    }
    info("printer", `${PRINTER_ID} (kept as it is: ${existingSkus.length} SKUs, the slice's among them)`);
  } else {
    let body = [document];
    if (PRODIGI) {
      const { dropped, inputs } = await readPlatformPrinterInputs();
      for (const gone of dropped) {
        info("printer dropped", `${gone.printerId} (${gone.provider}, ${gone.status}): not allowed on staging, left out of the PUT`);
        if (gone.status === "active" && process.env.SLICE_ALLOW_PRINTER_REPLACE !== "1") {
          die(`${gone.printerId} is ACTIVE and not allowed on staging; dropping it would suspend its mappings: set SLICE_ALLOW_PRINTER_REPLACE=1 to proceed`);
        }
      }
      body = [...inputs.filter((printer) => printer.printerId !== PRINTER_ID), document];
      info("printers carried", body.map((printer) => printer.printerId).join(", "));
    }
    const printers = expectStatus(
      await api("PUT", "/v1/platform/printers", { json: { printers: body }, session: true }),
      [200],
      "PUT printers",
    );
    const written = printers.json.printers.find((printer) => printer.printerId === PRINTER_ID);
    info("printer", `${PRINTER_ID} (${written?.skuCount} SKUs, suspended mappings ${printers.json.suspendedMappings})`);
  }

  const profiles = expectStatus(
    await api("GET", "/v1/admin/pod/profiles", { session: true, shop: true }),
    [200],
    "list profiles",
  );
  const active = profiles.json.profiles ?? [];
  if (active.some((profile) => profile.profileId === PROFILE.profileId)) {
    info("profile", `${PROFILE.profileId} (present)`);
    return;
  }
  // Replace-all: keep every active profile, add ours.
  expectStatus(
    await api("PUT", "/v1/platform/pod/profiles", { json: { profiles: [...active, PROFILE] }, session: true }),
    [200],
    "PUT profiles",
  );
  info("profile", `${PROFILE.profileId} (added)`);
}

async function ensureArtwork() {
  step("artwork");
  // SLICE_GENERATED_ARTWORK=1 forces the generated 3600 × 3600 PNG even when the bench file
  // exists (the bench file is 3240 px: too small for a 12 × 16" poster at 300 dpi, CP12).
  const useBench = existsSync(BENCH_PNG) && process.env.SLICE_GENERATED_ARTWORK !== "1";
  const bytes = useBench ? readFileSync(BENCH_PNG) : generatedPng();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  info("original", `${useBench ? ".bench/render-bench-typical.png" : "generated 3600×3600 PNG"} (${bytes.length} bytes, sha256 ${sha256.slice(0, 12)}…)`);

  const listed = expectStatus(
    await api("GET", "/v1/admin/pod/artwork", { session: true, shop: true }),
    [200],
    "list artwork",
  );
  let artworkId = null;
  for (const artwork of (listed.json.artwork ?? []).slice(0, 50)) {
    if (artwork.status === "rejected") {
      continue;
    }
    const object = await api("GET", `/v1/admin/objects/${artwork.originalObjectId}`, { session: true, shop: true });
    if (object.status === 200 && object.json?.object?.sha256 === sha256) {
      artworkId = artwork.artworkId;
      info("artwork", `${artworkId} (reused, ${artwork.status})`);
      break;
    }
  }

  if (artworkId === null) {
    const reserved = expectStatus(
      await api("POST", "/v1/admin/objects", {
        json: { contentType: "image/png", fileName: "slice-motif.png", kind: "artwork_original", sha256, sizeBytes: bytes.length },
        session: true,
        shop: true,
      }),
      [201],
      "reserve original",
    );
    const objectId = reserved.json.object.objectId;
    expectStatus(
      await api("PUT", `/v1/admin/objects/${objectId}/content`, { bytes, session: true, shop: true }),
      [200],
      "upload original",
    );
    info("original object", objectId);
    const created = expectStatus(
      await api("POST", "/v1/admin/pod/artwork", {
        json: { objectId, profileId: PROFILE.profileId, rightsConfirmed: true },
        session: true,
        shop: true,
      }),
      [202],
      "create artwork",
    );
    artworkId = created.json.artwork.artworkId;
    info("artwork", `${artworkId} (202, queued for the render container)`);
  }

  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  for (;;) {
    const detail = await api("GET", `/v1/admin/pod/artwork/${artworkId}`, { session: true, shop: true });
    if (detail.status === 404) {
      die(`artwork ${artworkId} disappeared: the render job failed terminally (see alerts: render-job-failed:*)`);
    }
    const status = detail.json?.artwork?.status;
    if (status === "ready") {
      info("render", `ready (${detail.json.artwork.widthPx}×${detail.json.artwork.heightPx} px, ${detail.json.artwork.effectiveDpi} DPI)`);
      return artworkId;
    }
    if (status === "rejected") {
      die(`artwork ${artworkId} was rejected: ${JSON.stringify(detail.json.artwork.reasons)}`);
    }
    if (Date.now() > deadline) {
      die(`artwork ${artworkId} still '${status}' after ${RENDER_TIMEOUT_MS / 1000} s (is the render container up?)`);
    }
    await sleep(5_000);
  }
}

async function ensureProduct(artworkId) {
  step("product, mapping, quote, publish, approval");
  // A second printer on one tenant gets its OWN product (sku/name suffixed), never the other's.
  const sku = PRINTS
    ? `SLICE-POSTER-${TENANT_ID.replace(/^slice-/, "").toUpperCase()}`
    : `SLICE-TEE-${TENANT_ID.replace(/^slice-/, "").toUpperCase()}${PRODIGI ? "-PRODIGI" : ""}`;
  const mappings = expectStatus(
    await api("GET", "/v1/admin/pod/mappings", { session: true, shop: true }),
    [200],
    "list mappings",
  );
  const existing = (mappings.json.mappings ?? []).find(
    (mapping) =>
      mapping.artworkId === artworkId &&
      mapping.status === "active" &&
      mapping.printerId === PRINTER_ID &&
      SLICE_SKUS.includes(mapping.sku),
  );
  let productId = existing?.productId ?? process.env.SLICE_PRODUCT_ID ?? null;

  if (productId === null) {
    const created = await api("POST", "/v1/admin/products", {
      json: {
        allowPickup: true,
        allowShipping: true,
        currency: "SEK",
        description: "CP2 vertical slice — tryckt på beställning (staging).",
        name: PRINTS
          ? `Slice-affisch ${TENANT_ID.replace(/^slice-/, "")} (Prodigi)`
          : `Slice-tröja ${TENANT_ID.replace(/^slice-/, "")}${PRODIGI ? " (Prodigi)" : ""}`,
        priceMinor: PRICE_MINOR,
        sku,
      },
      session: true,
      shop: true,
    });
    if (created.status === 409) {
      die(
        `product SKU ${sku} exists but has no active mapping for this artwork. Find its id ` +
          `(SELECT product_id FROM products WHERE tenant_id = '${TENANT_ID}' AND sku = '${sku}') ` +
          "and re-run with SLICE_PRODUCT_ID=<id>",
      );
    }
    expectStatus(created, [201], "create product");
    productId = created.json.product.productId;
    info("product", `${productId} (created, sku ${sku})`);
  } else {
    info("product", `${productId} (reused)`);
  }

  expectStatus(
    await api("PATCH", `/v1/admin/products/${productId}`, { json: { status: "active" }, session: true, shop: true }),
    [200],
    "activate product",
  );

  if (existing === undefined) {
    const mapped = expectStatus(
      await api("POST", "/v1/admin/pod/mappings", {
        json: { artworkId, printerId: PRINTER_ID, productId, sku: SLICE_SKUS[0], slots: SLICE_SLOTS },
        session: true,
        shop: true,
      }),
      [200, 201],
      "create mapping",
    );
    const slot = mapped.json.mapping.slots[0];
    info(
      "mapping",
      `${mapped.json.mapping.mappingId} (${SLICE_SKUS[0]}, front ${slot?.widthMm}×${slot?.heightMm} mm` +
        `${slot?.fit === undefined ? "" : `, ${slot.fit} on ${slot.background}`})`,
    );
  } else {
    info("mapping", `${existing.mappingId} (reused)`);
  }

  const quote = expectStatus(
    await api("GET", `/v1/admin/pod/quote?productId=${encodeURIComponent(productId)}`, { session: true, shop: true }),
    [200],
    "quote",
  );
  info("quote (inköp)", `${quote.json.inkopMinor} öre, floor ${quote.json.priceFloorMinor} öre`);
  if (quote.json.priceFloorMinor > PRICE_MINOR) {
    expectStatus(
      await api("PATCH", `/v1/admin/products/${productId}`, {
        json: { priceMinor: quote.json.priceFloorMinor },
        session: true,
        shop: true,
      }),
      [200],
      "raise price to the floor",
    );
    info("price", `raised to the floor ${quote.json.priceFloorMinor}`);
  }

  const published = expectStatus(
    await api("POST", `/v1/admin/products/${productId}/publish`, { session: true, shop: true }),
    [200],
    "publish",
  );
  info("screening", published.json.product.screeningStatus ?? "null");
  if (published.json.product.screeningStatus === "pending") {
    const approved = expectStatus(
      await api("POST", `/v1/platform/screening/${productId}`, { json: { decision: "approved" }, session: true }),
      [200],
      "platform approval",
    );
    info("screening", `${approved.json.screening.status} (platform decision)`);
  }

  const pdp = await api("GET", `/v1/products/${productId}`, { web: true });
  info("PDP", pdp.status === 200 ? `200, ETag ${pdp.headers.get("etag")}` : `HTTP ${pdp.status}`);
  if (pdp.status !== 200) {
    die("the published product is not on the storefront");
  }
  return productId;
}

/** Same (tenant, order, amount) → same UUID-shaped Idempotency-Key. */
function refundIdempotencyKey(target) {
  const hex = createHash("sha256")
    .update(`${TENANT_ID}:${target.orderId}:${target.amountMinor}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The slice tenant admin's session cookie; the user is created and granted when absent. */
async function signInSliceAdmin(why) {
  const password = process.env.CHOPSHOP_SLICE_ADMIN_PASSWORD?.trim() ?? "";
  if (password.length < 12) {
    die(`${why}: set CHOPSHOP_SLICE_ADMIN_PASSWORD (≥ 12 chars) so the slice tenant admin can sign`);
  }
  const email = `slice-admin+${TENANT_ID}@example.com`;
  expectStatus(
    await api("POST", "/v1/platform/users", {
      json: { accountType: "tenant_admin", email, password },
      session: true,
    }),
    [201, 409],
    "slice tenant admin",
  );
  const signedIn = await fetch(`${API}/api/auth/sign-in/email`, {
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json", origin: API },
    method: "POST",
  });
  if (signedIn.status !== 200) {
    die(`slice tenant admin sign-in failed: HTTP ${signedIn.status} (an existing ${email} with another password?)`);
  }
  const adminUser = (await signedIn.json())?.user?.id;
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  expectStatus(
    await api("POST", `/v1/platform/tenants/${TENANT_ID}/admins`, { json: { userId: adminUser }, session: true }),
    [200, 201],
    "grant tenant admin",
  );
  return { cookie, email };
}

async function readLegalStatus() {
  return expectStatus(
    await api("GET", "/v1/admin/legal/status", { session: true, shop: true }),
    [200],
    "legal status",
  ).json;
}

/**
 * The checkout gate (CP2-E terms, CP3-E readiness): the shop's own admin accepted the CURRENT
 * platform terms (or is in grace) and adopted the legal pages, and the store settings hold a
 * return address and the VAT answer. The platform user (acting-as) reads the status and may
 * write the settings, but can never sign for the seller: what is missing is done as the slice
 * tenant admin. Each step runs only when the status says it is missing (an adoption appends
 * evidence, 20 per shop per hour).
 */
async function ensureLegallyReady() {
  step("legal readiness (the checkout gate)");
  let status = await readLegalStatus();
  const termsFine = () => status.accepted === true || status.inGrace === true;
  if (termsFine() && status.readiness.ready === true) {
    info("terms", `${status.acceptedVersion} accepted at ${status.acceptedAt}`);
    info("readiness", "ready");
    return;
  }
  const admin = await signInSliceAdmin("the shop is not legally ready");
  const asSeller = { headers: { cookie: admin.cookie }, shop: true };

  if (!termsFine()) {
    if (status.currentVersion === null) {
      die("no platform terms version is published on staging");
    }
    const accepted = expectStatus(
      await api("POST", "/v1/admin/legal/accept-terms", { ...asSeller, json: { termsVersion: status.currentVersion } }),
      [200, 201],
      "accept platform terms",
    );
    info("terms", `${accepted.json.acceptance.termsVersion} accepted at ${accepted.json.acceptance.acceptedAt} by ${admin.email}`);
  }
  if (!status.readiness.returnAddress || !status.readiness.vatAnswered) {
    expectStatus(
      await api("PUT", "/v1/admin/settings", { ...asSeller, json: { returnAddress: RETURN_ADDRESS, vatRegistered: false } }),
      [200],
      "PUT settings",
    );
    info("settings", "return address + VAT answer written");
  }
  if (!status.readiness.legalPagesAccepted) {
    const adopted = expectStatus(
      await api("POST", "/v1/admin/legal/accept-pages", {
        ...asSeller,
        json: { custom: false, pod: true, templateVersion: LEGAL_TEMPLATE_VERSION, texts: LEGAL_TEXTS },
      }),
      [201],
      "adopt the legal pages",
    );
    info("legal pages", `${adopted.json.acceptance.acceptanceId} (sha256 ${adopted.json.acceptance.textsSha256.slice(0, 12)}…)`);
  }

  status = await readLegalStatus();
  if (!termsFine() || status.readiness.ready !== true) {
    const missing = Object.entries(status.readiness)
      .filter(([key, value]) => key !== "ready" && value !== true)
      .map(([key]) => key);
    die(`the shop is still not ready: terms accepted ${status.accepted}, in grace ${status.inGrace}, missing ${missing.join(", ") || "nothing"}`);
  }
  info("readiness", "ready");
}

async function purchase(productId, account) {
  await ensureLegallyReady();
  step("purchase (checkout → PaymentIntent → Stripe confirm → webhook → receipt)");
  if (!account.chargesEnabled) {
    die("the connected account cannot take charges yet (finish the onboarding, re-run)");
  }
  const checkout = expectStatus(
    await api("POST", "/v1/checkout", {
      web: true,
      json: {
        // The buyer ticked the purchase terms (required); marketing stays unticked.
        consent: { terms: true },
        // A parcel, so the printer's job carries an address (D98). Invented data.
        deliveryMethod: "shipping",
        email: `slice-buyer+${Date.now()}@example.com`,
        idempotencyKey: `slice-${randomUUID()}`,
        items: [{ productId, quantity: 1 }],
        recipient: {
          addressLine1: "Provgatan 1",
          addressLine2: "lgh 1001",
          city: "Provstad",
          country: "SE",
          name: "Prov Provsson",
          phone: "+46 70 000 00 00",
          postalCode: "852 30",
        },
        shippingCountry: "SE",
        // CP13: the code a `?ref=` landing leaves in the cart (--ref-code).
        ...(args.refCode === null ? {} : { refCode: args.refCode }),
      },
    }),
    [201],
    "checkout",
  );
  const checkoutId = checkout.json.checkout.checkoutId;
  info("checkout", `${checkoutId} (${checkout.json.checkout.totalMinor} öre)`);
  if (args.refCode !== null) {
    const discountMinor = checkout.json.checkout.discountMinor ?? 0;
    if (!(discountMinor > 0)) {
      die(
        `the link code ${args.refCode} took nothing off (discountMinor ${discountMinor}): is the shop's affiliate ` +
          "add-on ON and the affiliate active? (run with --affiliate)",
      );
    }
    info("link code", `${args.refCode} → −${discountMinor} öre (discountCode ${checkout.json.checkout.discountCode ?? "?"})`);
  }

  const payment = await api("POST", `/v1/checkout/${checkoutId}/payment`, { web: true });
  if (payment.status === 404) {
    die("payment route 404: the shop is closed for payment (legal readiness, or charges not enabled on its account)");
  }
  expectStatus(payment, [200, 201], "payment");
  const intentId = payment.json.payment.paymentIntentId;
  info("payment intent", intentId);

  const intent = await stripe("POST", `/v1/payment_intents/${intentId}/confirm`, {
    payment_method: "pm_card_visa",
    return_url: `${API}/health`,
  });
  info("stripe", `${intent.status}, fee ${intent.application_fee_amount}, destination ${intent.transfer_data?.destination}`);

  const deadline = Date.now() + 90_000;
  for (;;) {
    const receipt = await api("POST", `/v1/checkout/${checkoutId}/receipt`, { web: true });
    if (receipt.json?.receipt?.status === "ready") {
      info("order", `${receipt.json.receipt.orderId} (webhook → order in one batch)`);
      return receipt.json.receipt.orderId;
    }
    if (receipt.json?.receipt?.status === "issued") {
      info("order", "made (the receipt was already handed out)");
      return null;
    }
    if (Date.now() > deadline) {
      die(`no order 90 s after the payment (webhook delivery? SELECT * FROM payment_events WHERE object_id = '${intentId}')`);
    }
    await sleep(2_000);
  }
}

async function refund(target) {
  step(`refund ${target.amountMinor} öre of order ${target.orderId}`);
  const result = expectStatus(
    await api("POST", `/v1/admin/orders/${target.orderId}/refunds`, {
      headers: { "idempotency-key": refundIdempotencyKey(target) },
      json: { amountMinor: target.amountMinor, reason: "CP2 slice refund (staging)" },
      session: true,
      shop: true,
    }),
    [201, 202],
    "refund",
  );
  info("refund", `${result.json.refund.refundId} → ${result.json.refund.state}`);
}


// ── CP13 A4: the affiliate program (--affiliate) ────────────────────────────

/** The add-on switched ON with an explicit row (opt-in, OFF at provisioning: design A12). */
async function ensureAffiliateFeature() {
  const route = `/v1/platform/tenants/${TENANT_ID}/features`;
  const current = expectStatus(await api("GET", route, { session: true }), [200], "read features");
  const feature = (current.json.features ?? []).find((entry) => entry.key === "affiliate");
  if (feature === undefined) {
    die("the Worker names no `affiliate` feature: is the CP13 Worker (migration 0059) deployed?");
  }
  if (feature.enabled === true && feature.source === "explicit") {
    info("affiliate add-on", "ON (explicit row present)");
    return;
  }
  const written = expectStatus(
    await api("PUT", route, { json: { features: { affiliate: true } }, session: true }),
    [200],
    "PUT features (affiliate)",
  );
  const after = (written.json.features ?? []).find((entry) => entry.key === "affiliate");
  if (after?.enabled !== true || after.source !== "explicit") {
    die(`the affiliate feature is ${JSON.stringify(after)} after the write`);
  }
  info("affiliate add-on", `ON (explicit row written) — PUT ${API}${route}`);
}

/** The shop's affiliate with `code`, paging GET /v1/admin/affiliates; null when there is none. */
async function findAffiliateByCode(code) {
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: "100", ...(cursor === null ? {} : { cursor }) });
    const listed = expectStatus(
      await api("GET", `/v1/admin/affiliates?${query}`, { session: true, shop: true }),
      [200],
      "list affiliates",
    );
    const found = (listed.json.affiliates ?? []).find((entry) => entry.code === code);
    if (found !== undefined) {
      return found;
    }
    cursor = listed.json.nextCursor ?? null;
    if (cursor === null) {
      return null;
    }
  }
  return null;
}

/** "Bjud in affiliate" for Anna (POST /v1/admin/affiliates), or the existing row. */
async function ensureSeededAffiliate() {
  let affiliate = await findAffiliateByCode(AFFILIATE_CODE);
  if (affiliate === null) {
    const invited = await api("POST", "/v1/admin/affiliates", {
      json: { code: AFFILIATE_CODE, email: AFFILIATE_EMAIL, name: AFFILIATE_NAME, preferredLang: "sv" },
      session: true,
      shop: true,
    });
    if (invited.status === 503) {
      die("POST /v1/admin/affiliates answered 503 email_unavailable: the invite queue is not bound on staging");
    }
    expectStatus(invited, [201], "invite the affiliate");
    info(
      "affiliate invited",
      `${invited.json.affiliate.affiliateId} — POST ${API}/v1/admin/affiliates ` +
        `(invited ${invited.json.invited}, mailConfigured ${invited.json.mailConfigured}` +
        `${invited.json.inviteError ? `, inviteError ${invited.json.inviteError}` : ""})`,
    );
    affiliate = await findAffiliateByCode(AFFILIATE_CODE);
    if (affiliate === null) {
      die(`the invited affiliate ${AFFILIATE_CODE} is not in the list`);
    }
  } else {
    info("affiliate", `${affiliate.affiliateId} exists (reused)`);
  }
  if (affiliate.status !== "active") {
    expectStatus(
      await api("PATCH", `/v1/admin/affiliates/${affiliate.affiliateId}`, { json: { status: "active" }, session: true, shop: true }),
      [200],
      "re-activate the affiliate",
    );
    info("affiliate", `${affiliate.affiliateId} re-activated`);
  }
  info("affiliate code", `${AFFILIATE_CODE} (${affiliate.commissionBp / 100} % commission, ${affiliate.discountBp / 100} % discount)`);
  info("affiliate detail", `GET ${API}/v1/admin/affiliates/${affiliate.affiliateId}`);
  return affiliate;
}

/** SQL string literal (the values below are generated here or validated, never user input). */
function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * The staging reset-token recipe (memory platform_users_and_superadmin): Better Auth stores a
 * reset token's identifier HASHED, so a token minted here becomes usable once its hashed row is in
 * `verification` (value = the user id, one hour). The token never leaves this process; the
 * wrangler command line carries only its hash. Then the ordinary reset endpoint sets the password,
 * consuming the row (single use) and revoking her sessions.
 */
async function setAffiliatePassword() {
  const token = randomBytes(32).toString("base64url");
  const identifier = createHash("sha256").update(`reset-password:${token}`).digest("base64url");
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const sql =
    'INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") ' +
    `SELECT ${sqlText(randomUUID())}, ${sqlText(identifier)}, a.user_id, ${sqlText(expiresIso)}, ${sqlText(nowIso)}, ${sqlText(nowIso)} ` +
    `FROM affiliates AS a WHERE a.tenant_id = ${sqlText(TENANT_ID)} AND a.code = ${sqlText(AFFILIATE_CODE)}`;
  let output;
  try {
    output = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", PINNED.d1.name, "--env", "staging", "--remote", "--json", "--command", sql],
      { cwd: path.join(ROOT, "cloudflare"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    die(`wrangler d1 execute (the reset-token row) failed: ${String(error.stderr ?? error.message).slice(0, 300)}`);
  }
  let written = 0;
  try {
    written = JSON.parse(output)?.[0]?.meta?.changes ?? 0;
  } catch {
    written = 0;
  }
  if (written !== 1) {
    die(`the reset-token row was not written (changes ${written}): no affiliate ${AFFILIATE_CODE} in ${TENANT_ID}?`);
  }
  info("reset token", `hashed row written to ${PINNED.d1.name}.verification (1 h, single use)`);

  const reset = await fetch(`${API}/api/auth/reset-password`, {
    body: JSON.stringify({ newPassword: AFFILIATE_PASSWORD, token }),
    headers: { "content-type": "application/json", origin: API },
    method: "POST",
  });
  if (reset.status !== 200) {
    die(`POST ${API}/api/auth/reset-password answered HTTP ${reset.status}`);
  }
  info("affiliate password", `set — POST ${API}/api/auth/reset-password`);

  const signedIn = await fetch(`${API}/api/auth/sign-in/email`, {
    body: JSON.stringify({ email: AFFILIATE_EMAIL, password: AFFILIATE_PASSWORD }),
    headers: { "content-type": "application/json", origin: API },
    method: "POST",
  });
  if (signedIn.status !== 200) {
    die(`the affiliate's sign-in failed: HTTP ${signedIn.status}`);
  }
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const me = expectStatus(
    await api("GET", "/v1/affiliate/me", { headers: { cookie }, shop: true }),
    [200],
    "GET /v1/affiliate/me as the affiliate",
  );
  if (me.json?.affiliate?.code !== AFFILIATE_CODE) {
    die(`/v1/affiliate/me answers code ${me.json?.affiliate?.code}, not ${AFFILIATE_CODE}`);
  }
  info("portal sign-in", `${AFFILIATE_EMAIL} → GET ${API}/v1/affiliate/me 200 (blockers: ${(me.json.affiliate.payoutBlockers ?? []).join(", ") || "none"})`);
}

/** One pending application through the storefront route (web Worker), found in the admin queue. */
async function ensurePendingApplication() {
  const terms = expectStatus(await api("GET", "/v1/affiliate-terms", { web: true }), [200], "GET /v1/affiliate-terms");
  expectStatus(
    await api("POST", "/v1/affiliate-applications", {
      json: {
        email: APPLICANT_EMAIL,
        name: APPLICANT_NAME,
        preferredLang: "sv",
        promotionMethod: "instagram",
        socials: { instagram: "@sara.staging" },
        termsAccepted: true,
        termsVersion: terms.json.terms.version,
      },
      web: true,
    }),
    [202],
    "POST /v1/affiliate-applications",
  );
  info("application sent", `${WEB}/_api/${TENANT_ID}/v1/affiliate-applications → 202 (terms ${terms.json.terms.version})`);
  const queue = expectStatus(
    await api("GET", "/v1/admin/affiliates/applications?status=pending&limit=100", { session: true, shop: true }),
    [200],
    "list pending applications",
  );
  const pending = (queue.json.applications ?? []).find((entry) => entry.email === APPLICANT_EMAIL);
  if (pending === undefined) {
    die(`no pending application from ${APPLICANT_EMAIL} in GET ${API}/v1/admin/affiliates/applications?status=pending`);
  }
  info("application pending", `${pending.applicationId} — GET ${API}/v1/admin/affiliates/applications/${pending.applicationId}`);
  return pending.applicationId;
}

async function ensureAffiliateProgram() {
  step("affiliate program (--affiliate: add-on, one invited affiliate with a password, one pending application)");
  await ensureAffiliateFeature();
  const affiliate = await ensureSeededAffiliate();
  await setAffiliatePassword();
  const applicationId = await ensurePendingApplication();
  return { affiliateId: affiliate.affiliateId, applicationId };
}

await preflight();
await signIn();
await ensureTenant();
await ensurePodFeature();
await openShop();
const account = await ensureConnect();
await ensurePrintShop();
const artworkId = await ensureArtwork();
const productId = await ensureProduct(artworkId);
await rescreen();
if (args.connectProof) {
  await connectProof(account);
}
const seededAffiliate = args.affiliate ? await ensureAffiliateProgram() : null;
let orderId = null;
if (args.purchase) {
  orderId = await purchase(productId, account);
}
if (args.refund !== null) {
  await refund(args.refund);
}

step("summary");
info("tenant", TENANT_ID);
info("storefront host", API_HOST);
info("connect account", account.id);
info("printer", PRINTER_ID);
info("profile", PROFILE.profileId);
info("artwork", artworkId);
info("product", productId);
if (seededAffiliate !== null) {
  info("affiliate", `${seededAffiliate.affiliateId} (${AFFILIATE_CODE}, ${AFFILIATE_EMAIL})`);
  info("pending application", seededAffiliate.applicationId);
  info("ref link", `${WEB}/${TENANT_ID}/?ref=${AFFILIATE_CODE}`);
  info("affiliate portal", `${PINNED.origins.admin}/affiliate (sign in as ${AFFILIATE_EMAIL})`);
}
if (orderId !== null) {
  info("order", orderId);
  if (PRODIGI) {
    console.log(
      "\n  Prodigi: the dispatcher sends this order to Prodigi's SANDBOX. Look at GET /v1/platform/print-jobs " +
        `(the dispatch rows for order ${orderId}) and the Prodigi sandbox dashboard.`,
    );
  }
}
console.log(
  "\n  Next: node scripts/cf-port/reconcile-staging.mjs --tenant " +
    `${TENANT_ID} (it lists the tenant's orders through GET /v1/platform/orders)`,
);
