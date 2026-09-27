#!/usr/bin/env node
/**
 * scripts/cf-port/reconcile-staging.mjs — CP2-D1: reconcile the staging slice TO THE ÖRE
 * (docs/cf-port/PLAN.md §10 CP2 exit: "money reconciles to the öre").
 *
 *   CHOPSHOP_API_URL=https://chopshop-api-stg.kent-ee2.workers.dev \
 *   CHOPSHOP_PLATFORM_EMAIL=… CHOPSHOP_PLATFORM_PASSWORD=… \
 *   STRIPE_SECRET_KEY=sk_test_… [FAKE_PRINTER_TOKEN=…] \
 *   node scripts/cf-port/reconcile-staging.mjs [--tenant slice-YYYYMMDD]
 *        (--orders-json <wrangler d1 --json output> | --order <orderId>:<pi_…> …)
 *        [--alerts-json <wrangler d1 --json output>]
 *
 * There is no order-listing route before CP5 and the admin order read deliberately carries no
 * Stripe ids (the seller sees ONE number), so the order ↔ PaymentIntent pairs come from D1:
 * without --orders-json/--order the script prints the exact preflight command that produces
 * them, and exits 2. The same holds for open alerts (no alerts route yet).
 *
 * Per order it reads:
 *   D1 side    GET /v1/admin/orders/:id (acting-as)   charged, refunded, pending, fee, payout
 *   Stripe     the PaymentIntent + its charge, the charge's transfer (and reversals), the
 *              application fee (and its refunds), every refund of the intent, and any further
 *              transfer to the connected account whose metadata names the order
 *   printer    GET /v1/staging/fake-printer/jobs?orderId= (with FAKE_PRINTER_TOKEN)
 * and checks:
 *   charged    = the charge's amount_captured
 *   fee        = the intent's application_fee_amount = the application fee's amount
 *   refunded   = Σ succeeded refunds at Stripe = the charge's amount_refunded
 *   pending    = Σ pending refunds at Stripe
 *   payout     = what the connected account nets at Stripe:
 *                transfer − reversed − (fee − fee refunded) + further transfers for the order
 * then prints the dispatch rows that need a human (GET /v1/platform/dispatch?state=unknown|failed)
 * and ends with ONE line: `BALANCED …` or `UNBALANCED … Δ <öre>` (exit 0 / 1).
 *
 * Read-only everywhere except the acting-as grant it opens (audited, 1 h). Credentials come only
 * from the environment variables above; nothing is written to disk and no secret is printed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PINNED = JSON.parse(readFileSync(path.join(ROOT, "cloudflare/pinned.staging.json"), "utf8"));

function die(message, code = 1) {
  console.error(`RECONCILE REFUSED: ${message}`);
  process.exit(code);
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    die(`${name} is not set`);
  }
  return value.trim();
}

// ── arguments ───────────────────────────────────────────────────────────────

const args = { alertsJson: null, orders: [], ordersJson: null, tenant: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  const value = () => process.argv[++index] ?? die(`${arg} needs a value`);
  if (arg === "--tenant") {
    args.tenant = value();
  } else if (arg === "--orders-json") {
    args.ordersJson = value();
  } else if (arg === "--alerts-json") {
    args.alertsJson = value();
  } else if (arg === "--order") {
    const [orderId, paymentIntentId] = value().split(":");
    if (!/^[0-9a-f-]{36}$/.test(orderId ?? "") || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId ?? "")) {
      die("--order needs <orderId>:<pi_…>");
    }
    args.orders.push({ order_id: orderId, payment_intent_id: paymentIntentId });
  } else {
    die(`unknown argument ${arg}`);
  }
}

const API = (() => {
  const url = new URL(requireEnv("CHOPSHOP_API_URL"));
  if (url.origin !== PINNED.origins.api) {
    die(`CHOPSHOP_API_URL ${url.origin} is not the pinned STAGING api origin ${PINNED.origins.api}`);
  }
  return url.origin;
})();
const STRIPE_KEY = requireEnv("STRIPE_SECRET_KEY");
if (!/^(sk|rk)_test_/.test(STRIPE_KEY)) {
  die("STRIPE_SECRET_KEY is not a test-mode key");
}
const PLATFORM_EMAIL = requireEnv("CHOPSHOP_PLATFORM_EMAIL");
const PLATFORM_PASSWORD = requireEnv("CHOPSHOP_PLATFORM_PASSWORD");
const FAKE_PRINTER_TOKEN = process.env.FAKE_PRINTER_TOKEN?.trim() || null;
const TENANT_ID = args.tenant ?? `slice-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(TENANT_ID)) {
  die(`tenant id ${TENANT_ID} is not a valid tenant id`);
}

/** Rows from `wrangler d1 execute --json` (an array of { results }) or a plain array. */
function readRows(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap((entry) => (Array.isArray(entry?.results) ? entry.results : [entry]));
}

const d1 = (sql) =>
  `scripts/cf-preflight.sh staging -- d1 execute ${PINNED.d1.name} --remote --json --command "${sql}"`;

if (args.ordersJson !== null) {
  args.orders.push(...readRows(args.ordersJson).filter((row) => row.tenant_id === undefined || row.tenant_id === TENANT_ID));
}
if (args.orders.length === 0) {
  console.log("No orders given. Produce them (reviewer, through the preflight) and re-run with --orders-json:");
  console.log(
    `  ${d1(`SELECT order_id, payment_intent_id, tenant_id, status FROM orders WHERE tenant_id = '${TENANT_ID}' ORDER BY created_at`)} > orders.json`,
  );
  console.log("Open alerts (optional, --alerts-json):");
  console.log(
    `  ${d1("SELECT kind, severity, resource_type, resource_id, tenant_id, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY created_at")} > alerts.json`,
  );
  process.exit(2);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

let cookie = null;

async function api(method, route, options = {}) {
  const headers = { origin: API };
  if (options.session) {
    headers.cookie = cookie;
  }
  if (options.shop) {
    headers["x-shop-id"] = TENANT_ID;
  }
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`;
  }
  let body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${API}${route}`, { body, headers, method, redirect: "manual" });
  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { json, status: response.status, text };
}

async function stripeGet(route, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => query.append(`${key}[]`, entry));
    } else {
      query.append(key, String(value));
    }
  }
  const qs = query.toString();
  const response = await fetch(`https://api.stripe.com${route}${qs.length > 0 ? `?${qs}` : ""}`, {
    headers: { authorization: `Bearer ${STRIPE_KEY}` },
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe GET ${route}: ${response.status} ${json?.error?.message ?? ""}`);
  }
  return json;
}

async function stripeList(route, params) {
  const all = [];
  let startingAfter = null;
  for (let page = 0; page < 20; page += 1) {
    const listed = await stripeGet(route, {
      limit: 100,
      ...params,
      ...(startingAfter === null ? {} : { starting_after: startingAfter }),
    });
    all.push(...listed.data);
    if (!listed.has_more || listed.data.length === 0) {
      return { complete: true, data: all };
    }
    startingAfter = listed.data[listed.data.length - 1].id;
  }
  return { complete: false, data: all };
}

// ── the run ─────────────────────────────────────────────────────────────────

const account = await stripeGet("/v1/account");
if (account.id !== PINNED.stripeAccountId) {
  die(`the Stripe key belongs to ${account.id}, not the pinned sandbox platform ${PINNED.stripeAccountId}`);
}

const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
  body: JSON.stringify({ email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD }),
  headers: { "content-type": "application/json", origin: API },
  method: "POST",
});
if (signIn.status !== 200) {
  die(`platform sign-in failed: HTTP ${signIn.status}`);
}
cookie = signIn.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
const grant = await api("POST", `/v1/platform/tenants/${TENANT_ID}/acting-as`, {
  json: { reason: "CP2 slice reconciliation (read-only)" },
  session: true,
});
if (grant.status !== 201) {
  die(`acting-as ${TENANT_ID}: HTTP ${grant.status}`);
}

const rows = [];
let totalDelta = 0;
let problems = 0;

for (const pair of args.orders) {
  const orderId = pair.order_id;
  const intentId = pair.payment_intent_id;
  const issues = [];
  const read = await api("GET", `/v1/admin/orders/${orderId}`, { session: true, shop: true });
  if (read.status !== 200) {
    rows.push({ issues: [`admin read HTTP ${read.status}`], orderId });
    problems += 1;
    continue;
  }
  const order = read.json.order;

  let stripe;
  try {
    const intent = await stripeGet(`/v1/payment_intents/${intentId}`, { expand: ["latest_charge"] });
    const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    const refunds = await stripeList("/v1/refunds", { payment_intent: intentId });
    const transfer =
      charge?.transfer === null || charge?.transfer === undefined
        ? null
        : await stripeGet(`/v1/transfers/${typeof charge.transfer === "string" ? charge.transfer : charge.transfer.id}`);
    const fee =
      charge?.application_fee === null || charge?.application_fee === undefined
        ? null
        : await stripeGet(
            `/v1/application_fees/${typeof charge.application_fee === "string" ? charge.application_fee : charge.application_fee.id}`,
          );
    const destination = intent.transfer_data?.destination ?? null;
    const further =
      destination === null
        ? { complete: true, data: [] }
        : await stripeList("/v1/transfers", { "created[gte]": intent.created, destination });
    const orderTransfers = further.data.filter(
      (candidate) => candidate.id !== transfer?.id && candidate.metadata?.order_id === orderId,
    );
    if (!refunds.complete || !further.complete) {
      issues.push("a Stripe listing was incomplete");
    }
    const sum = (list, statuses) =>
      list.filter((refund) => statuses.includes(refund.status)).reduce((total, refund) => total + refund.amount, 0);
    const feeKept = fee === null ? 0 : fee.amount - fee.amount_refunded;
    const transferred = transfer === null ? 0 : transfer.amount - transfer.amount_reversed;
    const furtherIn = orderTransfers.reduce((total, entry) => total + entry.amount - (entry.amount_reversed ?? 0), 0);
    stripe = {
      captured: charge?.amount_captured ?? 0,
      chargeRefunded: charge?.amount_refunded ?? 0,
      destination,
      fee: intent.application_fee_amount ?? 0,
      feeObject: fee?.amount ?? null,
      pending: sum(refunds.data, ["pending", "requires_action"]),
      refunded: sum(refunds.data, ["succeeded"]),
      shopNet: transferred - feeKept + furtherIn,
      status: intent.status,
    };
  } catch (error) {
    rows.push({ issues: [error.message], orderId });
    problems += 1;
    continue;
  }

  const check = (label, d1Value, stripeValue) => {
    if (d1Value !== stripeValue) {
      issues.push(`${label}: D1 ${d1Value} ≠ Stripe ${stripeValue}`);
    }
  };
  check("charged", order.money.chargedMinor, stripe.captured);
  check("fee", order.money.feeMinor, stripe.fee);
  if (stripe.feeObject !== null) {
    check("fee collected", order.money.feeMinor, stripe.feeObject);
  }
  check("refunded", order.money.refundedMinor, stripe.refunded);
  check("charge.amount_refunded", stripe.refunded, stripe.chargeRefunded);
  check("refund pending", order.money.refundPendingMinor, stripe.pending);
  const delta = order.payout.amountMinor - stripe.shopNet;
  if (delta !== 0) {
    issues.push(`payout: D1 ${order.payout.amountMinor} ≠ connected account net ${stripe.shopNet}`);
  }

  let jobs = "—";
  if (FAKE_PRINTER_TOKEN !== null) {
    const listed = await api("GET", `/v1/staging/fake-printer/jobs?orderId=${orderId}`, { bearer: FAKE_PRINTER_TOKEN });
    jobs = listed.status === 200 ? String(listed.json.jobs.length) : `HTTP ${listed.status}`;
  }

  totalDelta += Math.abs(delta);
  if (issues.length > 0) {
    problems += 1;
  }
  rows.push({
    charged: order.money.chargedMinor,
    delta,
    fee: order.money.feeMinor,
    issues,
    jobs,
    orderId,
    payout: order.payout.amountMinor,
    pending: order.money.refundPendingMinor,
    refunded: order.money.refundedMinor,
    shopNet: stripe.shopNet,
    status: order.status,
  });
}

// ── the table ───────────────────────────────────────────────────────────────

const columns = ["order", "status", "charged", "refunded", "pending", "fee", "payout(D1)", "net(Stripe)", "Δ öre", "jobs", ""];
const table = rows.map((row) => [
  row.orderId.slice(0, 8),
  row.status ?? "?",
  row.charged ?? "?",
  row.refunded ?? "?",
  row.pending ?? "?",
  row.fee ?? "?",
  row.payout ?? "?",
  row.shopNet ?? "?",
  row.delta ?? "?",
  row.jobs ?? "—",
  row.issues.length === 0 ? "✓" : "✗",
].map(String));
const widths = columns.map((column, index) => Math.max(column.length, ...table.map((cells) => cells[index].length)));
const line = (cells) => cells.map((cell, index) => cell.padStart(index < 2 ? 0 : widths[index]).padEnd(widths[index])).join("  ");
console.log(`\nTenant ${TENANT_ID} — ${rows.length} order(s), amounts in öre\n`);
console.log(line(columns));
console.log(widths.map((width) => "─".repeat(width)).join("  "));
for (const cells of table) {
  console.log(line(cells));
}
for (const row of rows.filter((candidate) => candidate.issues.length > 0)) {
  console.log(`\n✗ ${row.orderId}`);
  for (const issue of row.issues) {
    console.log(`    ${issue}`);
  }
}

// ── work that needs a human ─────────────────────────────────────────────────

for (const state of ["unknown", "failed"]) {
  const listed = await api("GET", `/v1/platform/dispatch?state=${state}`, { session: true });
  const mine = (listed.json?.dispatches ?? []).filter((dispatch) => dispatch.tenantId === TENANT_ID);
  console.log(`\nDispatch rows '${state}' for ${TENANT_ID}: ${listed.status === 200 ? mine.length : `HTTP ${listed.status}`}`);
  for (const dispatch of mine) {
    console.log(`    ${dispatch.outboxId}  order ${dispatch.orderId} line ${dispatch.lineNo}  ${dispatch.lastError ?? ""}`);
  }
}

if (args.alertsJson !== null) {
  const alerts = readRows(args.alertsJson).filter((alert) => alert.tenant_id === null || alert.tenant_id === TENANT_ID);
  console.log(`\nOpen alerts (${alerts.length}):`);
  for (const alert of alerts) {
    console.log(`    ${alert.created_at}  ${alert.severity}  ${alert.kind}  ${alert.resource_type}:${alert.resource_id}`);
  }
} else {
  console.log("\nOpen alerts: no route yet — list them through the preflight and pass --alerts-json:");
  console.log(
    `    ${d1("SELECT kind, severity, resource_type, resource_id, tenant_id, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY created_at")} > alerts.json`,
  );
}

console.log("");
if (problems === 0) {
  console.log(`BALANCED — ${rows.length} order(s), Δ 0 öre`);
  process.exit(0);
}
console.log(`UNBALANCED — ${problems} of ${rows.length} order(s) disagree, Σ|Δ payout| ${totalDelta} öre`);
process.exit(1);
