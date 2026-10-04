#!/usr/bin/env node
/**
 * scripts/cf-port/reconcile-staging.mjs — CP2-D1: reconcile the staging slice TO THE ÖRE
 * (docs/cf-port/PLAN.md §10 CP2 exit: "money reconciles to the öre"); CP7-T2: the same
 * reconciliation of a production shop, READ-ONLY (runbook §7.5).
 *
 *   CHOPSHOP_API_URL=https://chopshop-api-stg.kent-ee2.workers.dev \
 *   CHOPSHOP_PLATFORM_EMAIL=… CHOPSHOP_PLATFORM_PASSWORD=… \
 *   STRIPE_SECRET_KEY=sk_test_… [FAKE_PRINTER_TOKEN=…] \
 *   node scripts/cf-port/reconcile-staging.mjs [--tenant slice-YYYYMMDD] [--order <orderId> …]
 *
 *   node scripts/cf-port/reconcile-staging.mjs --env production --confirm production \
 *        --tenant <shop> [--order <orderId> …]
 *
 * The order ↔ PaymentIntent pairs come from the platform's order list (CP2-E):
 *   GET /v1/platform/orders?tenantId=…   paginated, followed to exhaustion (nextCursor)
 * — the platform-only view with the Stripe ids, the GROSS application fee and the withholding
 * released from it (D36). `--order` narrows the run to the named orders. No D1 export needed.
 *
 * Per order it reads:
 *   platform   the order list row                      intent id, gross fee, released
 *   seller     GET /v1/admin/orders/:id (acting-as)    charged, refunded, pending, fee (NET), payout
 *              — STAGING only; production reads the same figures from the platform row
 *   Stripe     the PaymentIntent + its charge, the charge's transfer (and reversals), the
 *              application fee (and its refunds), every refund of the intent, and any further
 *              transfer to the connected account whose metadata names the order
 *   printer    GET /v1/staging/fake-printer/jobs?orderId= (with FAKE_PRINTER_TOKEN) — staging only
 * and checks:
 *   charged    = the charge's amount_captured
 *   fee gross  = the platform row's applicationFeeMinor = the intent's application_fee_amount
 *                = the application fee object's amount (Stripe never changes the gross)
 *   fee net    = the seller's ONE fee figure = gross − released (D1) = the fee object's
 *                amount − amount_refunded (Stripe's net: a D36 release is a fee refund)
 *   refunded   = Σ succeeded refunds at Stripe = the charge's amount_refunded
 *   pending    = Σ pending refunds at Stripe
 *   payout     = what the connected account nets at Stripe:
 *                transfer − reversed − (fee − fee refunded) + further transfers for the order
 * then prints the dispatch rows that need a human (GET /v1/platform/dispatch?state=unknown|failed)
 * and the tenant's open alerts (GET /v1/platform/alerts?state=open) — every list followed to
 * exhaustion — and ends with ONE line: `BALANCED …` or `UNBALANCED … Δ <öre>` (exit 0 / 1).
 *
 * STAGING (unchanged): read-only everywhere except the acting-as grant it opens (audited, 1 h).
 * The API origin must be the pinned staging one, the key a test-mode key (a live key is
 * refused), the account the pinned sandbox platform. Credentials come only from the
 * environment variables above. A refusal exits 1.
 *
 * PRODUCTION (CP7-T2) writes NOTHING, anywhere:
 *   - `--env production --confirm production` (lib/api-session.mjs confirmationProblem) and an
 *     explicit `--tenant`;
 *   - the API origin of cloudflare/pinned.production.json (refused while it is null; an explicit
 *     CHOPSHOP_API_URL must equal it), whose /health must say production;
 *   - the platform user's credentials from the environment or ~/.config/chopshop/secrets.production.env
 *     only (productionCredentials: mode 600, never the staging file);
 *   - the Stripe key from ~/.config/chopshop/stripe.production.env only — where the preflight
 *     reads it (mode 600, never the staging file, never STRIPE_SECRET_KEY of the environment,
 *     never printed) — and a live key (sk_live_ / rk_live_); a test key is refused. Its account
 *     must be the pinned stripeAccountId, refused while that pin is null;
 *   - every API request is a GET; the ONE exception is the sign-in
 *     (POST /api/auth/sign-in/email), without which no read is possible: it creates the session
 *     the reads carry (a session row, Better Auth's own). No acting-as grant is opened, so the
 *     seller's order page is not read (its figures are the same D1 columns the platform row
 *     carries); FAKE_PRINTER_TOKEN is refused (production has no fake printer); every Stripe
 *     call is a GET.
 *   A refusal exits 2, before any request where it can be decided without one.
 *
 * Prints amounts, counts, ids and reasons only — never an address, a cookie, a key or a body.
 * Nothing is written to disk.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RefusedError,
  confirmationProblem,
  createApiSession,
  parseEnvFile,
  productionCredentials,
  productionTarget,
} from "./migrate/lib/api-session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function requireEnv(environment, name) {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new RefusedError(`${name} is not set`);
  }
  return value.trim();
}

// ── arguments ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { confirm: null, env: "staging", orders: [], tenant: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new RefusedError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--tenant") {
      args.tenant = value();
    } else if (arg === "--env") {
      args.env = value();
    } else if (arg === "--confirm") {
      args.confirm = value();
    } else if (arg === "--order") {
      const orderId = value();
      if (!/^[0-9a-f-]{36}$/.test(orderId)) {
        throw new RefusedError("--order needs an order id");
      }
      args.orders.push(orderId);
    } else {
      throw new RefusedError(`unknown argument ${arg}`);
    }
  }
  if (args.env !== "staging" && args.env !== "production") {
    throw new RefusedError("--env must be staging or production");
  }
  return args;
}

// ── the production Stripe key: where the preflight reads it ─────────────────

/**
 * STRIPE_SECRET_KEY of ~/.config/chopshop/stripe.production.env (scripts/cf-preflight.sh
 * check 7's file), and from nowhere else. Never printed.
 */
export function productionStripeKey({ environment, stripeFile, stagingStripeFile }) {
  const shown = stripeFile.startsWith(`${homedir()}${path.sep}`) ? `~${stripeFile.slice(homedir().length)}` : stripeFile;
  if (environment.STRIPE_SECRET_KEY !== undefined) {
    throw new RefusedError(`STRIPE_SECRET_KEY is set in the environment: production reads its Stripe key only from ${shown}`);
  }
  if (!existsSync(stripeFile)) {
    throw new RefusedError(`${shown} does not exist: production reads its Stripe key only from there`);
  }
  if (existsSync(stagingStripeFile) && realpathSync(stripeFile) === realpathSync(stagingStripeFile)) {
    throw new RefusedError(`${shown} is the staging Stripe file: production never reads staging's key`);
  }
  const mode = statSync(stripeFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new RefusedError(`${shown} can be read by others (mode ${mode.toString(8)}): chmod 600 it`);
  }
  const key = parseEnvFile(readFileSync(stripeFile, "utf8")).STRIPE_SECRET_KEY?.trim() ?? "";
  if (key === "") {
    throw new RefusedError(`${shown} defines no STRIPE_SECRET_KEY`);
  }
  if (!/^(sk|rk)_live_/.test(key)) {
    throw new RefusedError(`the key in ${shown} is not a live key (sk_live_ or rk_live_): production reconciles live money`);
  }
  return key;
}

// ── the target ──────────────────────────────────────────────────────────────

/**
 * Everything the run needs, decided before any request. `homeDir` and `repoRoot` are
 * injectable for the tests (a scratch HOME, a scratch pinned file).
 */
export function reconcileTarget(args, { environment = process.env, homeDir = homedir(), repoRoot = ROOT, today = new Date() } = {}) {
  const config = path.join(homeDir, ".config", "chopshop");
  if (args.env !== "production") {
    const refusal = confirmationProblem(args.env, args.confirm);
    if (refusal !== null) throw new RefusedError(refusal);
    const pinned = JSON.parse(readFileSync(path.join(repoRoot, "cloudflare/pinned.staging.json"), "utf8"));
    const url = new URL(requireEnv(environment, "CHOPSHOP_API_URL"));
    if (url.origin !== pinned.origins.api) {
      throw new RefusedError(`CHOPSHOP_API_URL ${url.origin} is not the pinned STAGING api origin ${pinned.origins.api}`);
    }
    const stripeKey = requireEnv(environment, "STRIPE_SECRET_KEY");
    if (!/^(sk|rk)_test_/.test(stripeKey)) {
      throw new RefusedError("STRIPE_SECRET_KEY is not a test-mode key");
    }
    const credentials = { email: requireEnv(environment, "CHOPSHOP_PLATFORM_EMAIL"), password: requireEnv(environment, "CHOPSHOP_PLATFORM_PASSWORD") };
    const tenantId = args.tenant ?? `slice-${today.toISOString().slice(0, 10).replaceAll("-", "")}`;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenantId)) {
      throw new RefusedError(`tenant id ${tenantId} is not a valid tenant id`);
    }
    return {
      apiOrigin: url.origin,
      credentials,
      env: "staging",
      fakePrinterToken: environment.FAKE_PRINTER_TOKEN?.trim() || null,
      orders: args.orders,
      stripeAccountId: pinned.stripeAccountId,
      stripeKey,
      tenantId,
    };
  }

  // Production: the confirmation first, then everything else before any request.
  const { apiOrigin, pinned } = productionTarget({ confirm: args.confirm, environment, repoRoot });
  if (args.tenant === null) {
    throw new RefusedError("--tenant is required for --env production: name the shop to reconcile");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.tenant)) {
    throw new RefusedError(`tenant id ${args.tenant} is not a valid tenant id`);
  }
  if (environment.FAKE_PRINTER_TOKEN !== undefined) {
    throw new RefusedError("FAKE_PRINTER_TOKEN is staging's: production has no fake printer");
  }
  if (typeof pinned.stripeAccountId !== "string" || !pinned.stripeAccountId.startsWith("acct_")) {
    throw new RefusedError("cloudflare/pinned.production.json stripeAccountId is null: the key cannot be proven to be the live platform's");
  }
  const stripeKey = productionStripeKey({
    environment,
    stagingStripeFile: path.join(config, "stripe.staging.env"),
    stripeFile: path.join(config, "stripe.production.env"),
  });
  const credentials = productionCredentials({
    environment,
    secretsFile: path.join(config, "secrets.production.env"),
    stagingSecretsFile: path.join(config, "secrets.staging.env"),
  });
  return {
    apiOrigin,
    credentials,
    env: "production",
    fakePrinterToken: null,
    orders: args.orders,
    stripeAccountId: pinned.stripeAccountId,
    stripeKey,
    tenantId: args.tenant,
  };
}

/**
 * Production's ONLY way to the API: a GET. Anything else is refused before it is sent, so
 * no code path of the production run can write (the sign-in is createApiSession's own).
 */
export function readOnlyRequest(session) {
  return async (method, route, options = {}) => {
    if (method !== "GET") {
      throw new RefusedError(`production is read-only: ${method} ${route.split("?")[0]} refused`);
    }
    if (options.shop || options.bearer) {
      throw new RefusedError(`production is read-only: ${route.split("?")[0]} would need a grant or a token`);
    }
    return session.request("GET", route);
  };
}

/** Stripe's REST API, GET only, the key in the Authorization header (never printed). */
function stripeClient(stripeKey, fetchImpl) {
  return async function stripeGet(route, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        value.forEach((entry) => query.append(`${key}[]`, entry));
      } else {
        query.append(key, String(value));
      }
    }
    const qs = query.toString();
    const response = await fetchImpl(`https://api.stripe.com${route}${qs.length > 0 ? `?${qs}` : ""}`, {
      headers: { authorization: `Bearer ${stripeKey}` },
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(`Stripe GET ${route}: ${response.status} ${json?.error?.message ?? ""}`);
    }
    return json;
  };
}

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * Reconciles `target.tenantId`. `fetchImpl` reaches the API (and Stripe, unless `stripeGet`
 * is given: the tests inject a fake Stripe client). Lines go to `log`. → the exit code.
 */
export async function runReconcile(target, { fetchImpl = globalThis.fetch, log = console.log, stripeGet = stripeClient(target.stripeKey, fetchImpl) } = {}) {
  const TENANT_ID = target.tenantId;
  const production = target.env === "production";
  let api;

  const account = await stripeGet("/v1/account");
  if (account.id !== target.stripeAccountId) {
    throw new RefusedError(`the Stripe key belongs to ${account.id}, not the pinned ${production ? "live" : "sandbox"} platform ${target.stripeAccountId}`);
  }

  if (production) {
    const session = createApiSession({ apiOrigin: target.apiOrigin, fetchImpl });
    const health = await session.request("GET", "/health", { anonymous: true });
    if (health.status !== 200 || health.json?.environment !== "production") {
      throw new RefusedError(`/health does not say production (HTTP ${health.status})`);
    }
    await session.signIn(target.credentials);
    api = readOnlyRequest(session);
  } else {
    let cookie = null;
    api = async (method, route, options = {}) => {
      const headers = { origin: target.apiOrigin };
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
      const response = await fetchImpl(`${target.apiOrigin}${route}`, { body, headers, method, redirect: "manual" });
      const text = await response.text();
      let json = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { json, status: response.status, text };
    };
    const signIn = await fetchImpl(`${target.apiOrigin}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: target.credentials.email, password: target.credentials.password }),
      headers: { "content-type": "application/json", origin: target.apiOrigin },
      method: "POST",
    });
    if (signIn.status !== 200) {
      throw new RefusedError(`platform sign-in failed: HTTP ${signIn.status}`);
    }
    cookie = signIn.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const grant = await api("POST", `/v1/platform/tenants/${TENANT_ID}/acting-as`, {
      json: { reason: "CP2 slice reconciliation (read-only)" },
      session: true,
    });
    if (grant.status !== 201) {
      throw new RefusedError(`acting-as ${TENANT_ID}: HTTP ${grant.status}`);
    }
  }

  /**
   * Every row of a paginated platform list: follows `nextCursor` to exhaustion (Codex P2 on
   * CP2-D1 — filtering only the FIRST page reported zero rows for a tenant whose rows sat on a
   * later one). `key` names the array in the body; a non-200 page stops with its status.
   */
  async function listAll(route, key) {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 1_000; page += 1) {
      const separator = route.includes("?") ? "&" : "?";
      const listed = await api(
        "GET",
        `${route}${separator}limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        { session: true },
      );
      if (listed.status !== 200) {
        return { rows, status: listed.status };
      }
      rows.push(...(listed.json?.[key] ?? []));
      cursor = listed.json?.nextCursor ?? null;
      if (cursor === null) {
        return { rows, status: 200 };
      }
    }
    return { rows, status: "unterminated" };
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

  const platformOrders = await listAll(`/v1/platform/orders?tenantId=${TENANT_ID}`, "orders");
  if (platformOrders.status !== 200) {
    throw new RefusedError(`GET /v1/platform/orders: ${platformOrders.status}`);
  }
  const selected =
    target.orders.length === 0
      ? platformOrders.rows
      : platformOrders.rows.filter((order) => target.orders.includes(order.orderId));
  for (const orderId of target.orders) {
    if (!selected.some((order) => order.orderId === orderId)) {
      throw new RefusedError(`--order ${orderId} is not an order of ${TENANT_ID}`);
    }
  }
  if (selected.length === 0) {
    log(production ? `Tenant ${TENANT_ID} has no orders yet.` : `Tenant ${TENANT_ID} has no orders yet (run seed-staging-slice.mjs --purchase).`);
    return 2;
  }

  const rows = [];
  let totalDelta = 0;
  let problems = 0;

  for (const platformOrder of selected) {
    const orderId = platformOrder.orderId;
    const intentId = platformOrder.paymentIntentId;
    const issues = [];
    let order;
    if (production) {
      // No acting-as in production: the seller's figures are the platform row's (the same columns).
      order = {
        money: {
          chargedMinor: platformOrder.money.chargedMinor,
          feeMinor: platformOrder.money.applicationFeeMinor - platformOrder.money.withholdingReleasedMinor,
          refundPendingMinor: platformOrder.money.refundPendingMinor,
          refundedMinor: platformOrder.money.refundedMinor,
        },
        payout: platformOrder.payout,
        status: platformOrder.status,
      };
    } else {
      const read = await api("GET", `/v1/admin/orders/${orderId}`, { session: true, shop: true });
      if (read.status !== 200) {
        rows.push({ issues: [`admin read HTTP ${read.status}`], orderId });
        problems += 1;
        continue;
      }
      order = read.json.order;
    }

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
        // Stripe's NET fee: a D36 withholding release is an application-fee refund.
        feeNet: fee === null ? null : fee.amount - fee.amount_refunded,
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
    // Codex P2 on CP2-D1: after a D36 release the seller's fee is NET (gross − released) while
    // the intent's application_fee_amount and the fee object's amount stay GROSS. Gross is
    // checked against gross, net against net — a correct release is BALANCED.
    check("fee gross (platform row vs intent)", platformOrder.money.applicationFeeMinor, stripe.fee);
    if (stripe.feeObject !== null) {
      check("fee gross (intent vs application fee)", stripe.fee, stripe.feeObject);
    }
    const d1Net = platformOrder.money.applicationFeeMinor - platformOrder.money.withholdingReleasedMinor;
    if (order.money.feeMinor !== d1Net) {
      issues.push(`fee net: the seller's figure ${order.money.feeMinor} ≠ D1 gross − released ${d1Net}`);
    }
    check(
      "fee net (seller's figure vs Stripe's amount − amount_refunded)",
      order.money.feeMinor,
      stripe.feeNet ?? stripe.fee,
    );
    check("refunded", order.money.refundedMinor, stripe.refunded);
    check("charge.amount_refunded", stripe.refunded, stripe.chargeRefunded);
    check("refund pending", order.money.refundPendingMinor, stripe.pending);
    const delta = order.payout.amountMinor - stripe.shopNet;
    if (delta !== 0) {
      issues.push(`payout: D1 ${order.payout.amountMinor} ≠ connected account net ${stripe.shopNet}`);
    }

    let jobs = "—";
    if (target.fakePrinterToken !== null) {
      const listed = await api("GET", `/v1/staging/fake-printer/jobs?orderId=${orderId}`, { bearer: target.fakePrinterToken });
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

  // ── the table ─────────────────────────────────────────────────────────────

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
  log(`\nTenant ${TENANT_ID} — ${rows.length} order(s), amounts in öre\n`);
  log(line(columns));
  log(widths.map((width) => "─".repeat(width)).join("  "));
  for (const cells of table) {
    log(line(cells));
  }
  for (const row of rows.filter((candidate) => candidate.issues.length > 0)) {
    log(`\n✗ ${row.orderId}`);
    for (const issue of row.issues) {
      log(`    ${issue}`);
    }
  }

  // ── work that needs a human ───────────────────────────────────────────────

  for (const state of ["unknown", "failed"]) {
    // Every page (Codex P2 on CP2-D1): the list is cross-tenant and paginated.
    const listed = await listAll(`/v1/platform/dispatch?state=${state}`, "dispatches");
    const mine = listed.rows.filter((dispatch) => dispatch.tenantId === TENANT_ID);
    log(`\nDispatch rows '${state}' for ${TENANT_ID}: ${listed.status === 200 ? mine.length : `HTTP ${listed.status}`}`);
    for (const dispatch of mine) {
      log(`    ${dispatch.outboxId}  order ${dispatch.orderId} line ${dispatch.lineNo}  ${dispatch.lastError ?? ""}`);
    }
  }

  // The tenant's own open alerts and the platform-wide ones (tenant null), every page.
  const openAlerts = await listAll("/v1/platform/alerts?state=open", "alerts");
  const alerts = openAlerts.rows.filter((alert) => alert.tenantId === null || alert.tenantId === TENANT_ID);
  log(`\nOpen alerts (${openAlerts.status === 200 ? alerts.length : `HTTP ${openAlerts.status}`}):`);
  for (const alert of alerts) {
    log(`    ${alert.createdAt}  ${alert.severity}  ${alert.kind}  ${alert.resourceType}:${alert.resourceId}`);
  }

  log("");
  if (problems === 0) {
    log(`BALANCED — ${rows.length} order(s), Δ 0 öre`);
    return 0;
  }
  log(`UNBALANCED — ${problems} of ${rows.length} order(s) disagree, Σ|Δ payout| ${totalDelta} öre`);
  return 1;
}

async function main() {
  const argv = process.argv.slice(2);
  // A production refusal exits 2 (refused to run); staging keeps its 1.
  const refusedCode = argv[argv.indexOf("--env") + 1] === "production" && argv.includes("--env") ? 2 : 1;
  try {
    const target = reconcileTarget(parseArgs(argv));
    process.exit(await runReconcile(target));
  } catch (error) {
    if (error instanceof RefusedError) {
      console.error(`RECONCILE REFUSED: ${error.message}`);
      process.exit(refusedCode);
    }
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
