#!/usr/bin/env node
/**
 * scripts/cf-port/seed-staging-slice.mjs — seed the vertical slice on STAGING
 * (docs/cf-port/PLAN.md §10 CP2, routes-only since CP3), through the deployed Worker's real
 * routes. Stripe is called directly for two things only: reading (the platform account, the
 * connected account's metadata and payout schedule) and confirming the test payment as the
 * buyer's browser would. Every write to the shop goes through a route.
 *
 *   CHOPSHOP_API_URL=https://chopshop-api-stg.kent-ee2.workers.dev \
 *   CHOPSHOP_PLATFORM_EMAIL=… CHOPSHOP_PLATFORM_PASSWORD=… \
 *   STRIPE_SECRET_KEY=sk_test_… [FAKE_PRINTER_TOKEN=…] [CHOPSHOP_SLICE_ADMIN_PASSWORD=…] \
 *   node scripts/cf-port/seed-staging-slice.mjs [--tenant slice-YYYYMMDD]
 *        [--purchase] [--refund <orderId>:<amountMinor>] [--connect-proof]
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
 *   6. printers (the fake printer, capabilities from docs/SnapWearDocs/snapwear-catalog.json),
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
 *
 * Credentials come ONLY from the environment variables above. Nothing is written to disk and no
 * secret, cookie or receipt token is printed. Never runs wrangler and needs no D1 statement.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PINNED = JSON.parse(readFileSync(path.join(ROOT, "cloudflare/pinned.staging.json"), "utf8"));
const CATALOG_PATH = path.join(ROOT, "docs/SnapWearDocs/snapwear-catalog.json");
const BENCH_PNG = path.join(ROOT, ".bench/render-bench-typical.png");

const PRINTER_ID = "fake-printer";
/** A crewneck (SnapWear model 18000), White S / M — the SKUs the worker suites use. */
const SLICE_MODEL = "18000";
const SLICE_SKUS = ["2700003", "2700004"];
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
  const out = { connectProof: false, purchase: false, refund: null, tenant: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--purchase") {
      out.purchase = true;
    } else if (arg === "--connect-proof") {
      out.connectProof = true;
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
const PLATFORM_EMAIL = requireEnv("CHOPSHOP_PLATFORM_EMAIL");
const PLATFORM_PASSWORD = requireEnv("CHOPSHOP_PLATFORM_PASSWORD");
const STRIPE_KEY = requireEnv("STRIPE_SECRET_KEY");
if (!/^(sk|rk)_test_/.test(STRIPE_KEY)) {
  die("STRIPE_SECRET_KEY is not a test-mode key (sk_test_/rk_test_)");
}
const FAKE_PRINTER_TOKEN = process.env.FAKE_PRINTER_TOKEN?.trim() || null;

const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const TENANT_ID = args.tenant ?? `slice-${today}`;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(TENANT_ID)) {
  die(`tenant id ${TENANT_ID} is not a valid tenant id`);
}
const SHOP_NAME = `Slice ${TENANT_ID.replace(/^slice-/, "")}`;
// ── the API ─────────────────────────────────────────────────────────────────

let platformCookie = null;

async function api(method, route, options = {}) {
  const headers = { origin: API };
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
  const response = await fetch(`${API}${route}`, { body, headers, method, redirect: "manual" });
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

function printerDocument() {
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
  const storefront = await api("GET", "/v1/storefront");
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
  if (others.length > 0 && process.env.SLICE_ALLOW_PRINTER_REPLACE !== "1") {
    die(
      `PUT /v1/platform/printers is replace-all and would deactivate ${others.map((p) => p.printerId).join(", ")}; ` +
        "set SLICE_ALLOW_PRINTER_REPLACE=1 to proceed",
    );
  }
  const printers = expectStatus(
    await api("PUT", "/v1/platform/printers", { json: { printers: [document] }, session: true }),
    [200],
    "PUT printers",
  );
  info("printer", `${PRINTER_ID} (${printers.json.printers[0]?.skuCount} SKUs, suspended mappings ${printers.json.suspendedMappings})`);

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
  const bytes = existsSync(BENCH_PNG) ? readFileSync(BENCH_PNG) : generatedPng();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  info("original", `${existsSync(BENCH_PNG) ? ".bench/render-bench-typical.png" : "generated 3600×3600 PNG"} (${bytes.length} bytes, sha256 ${sha256.slice(0, 12)}…)`);

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
  const sku = `SLICE-TEE-${TENANT_ID.replace(/^slice-/, "").toUpperCase()}`;
  const mappings = expectStatus(
    await api("GET", "/v1/admin/pod/mappings", { session: true, shop: true }),
    [200],
    "list mappings",
  );
  const existing = (mappings.json.mappings ?? []).find(
    (mapping) => mapping.artworkId === artworkId && mapping.status === "active",
  );
  let productId = existing?.productId ?? process.env.SLICE_PRODUCT_ID ?? null;

  if (productId === null) {
    const created = await api("POST", "/v1/admin/products", {
      json: {
        allowPickup: true,
        allowShipping: true,
        currency: "SEK",
        description: "CP2 vertical slice — tryckt på beställning (staging).",
        name: `Slice-tröja ${TENANT_ID.replace(/^slice-/, "")}`,
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
        json: { artworkId, printerId: PRINTER_ID, productId, sku: SLICE_SKUS[0], slots: ["front"] },
        session: true,
        shop: true,
      }),
      [200, 201],
      "create mapping",
    );
    info("mapping", `${mapped.json.mapping.mappingId} (${SLICE_SKUS[0]}, front ${mapped.json.mapping.slots[0]?.widthMm}×${mapped.json.mapping.slots[0]?.heightMm} mm)`);
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

  const pdp = await api("GET", `/v1/products/${productId}`);
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
      },
    }),
    [201],
    "checkout",
  );
  const checkoutId = checkout.json.checkout.checkoutId;
  info("checkout", `${checkoutId} (${checkout.json.checkout.totalMinor} öre)`);

  const payment = await api("POST", `/v1/checkout/${checkoutId}/payment`);
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
    const receipt = await api("POST", `/v1/checkout/${checkoutId}/receipt`);
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
if (orderId !== null) {
  info("order", orderId);
}
console.log(
  "\n  Next: node scripts/cf-port/reconcile-staging.mjs --tenant " +
    `${TENANT_ID} (it lists the tenant's orders through GET /v1/platform/orders)`,
);
