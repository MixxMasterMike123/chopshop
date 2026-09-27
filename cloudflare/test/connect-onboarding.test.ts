import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TenantAdminPrincipal } from "../src/auth/live-authorization";
import { accountMetadata } from "../src/commerce/connect-gateway";
import type { ConnectAccountsApi } from "../src/commerce/connect-gateway";
import {
  CONNECT_ATTEMPT_LEASE_MS,
  CONNECT_KEY_RETRY_WINDOW_MS,
  CONNECT_STUCK_ALERT_KIND,
  createOrReuseConnectAccount,
  raiseStuckOnboardingAlerts,
  refreshConnectStatus,
} from "../src/commerce/connect-onboarding";
import { runReconciliation } from "../src/commerce/crons";
import { resolveAlert } from "../src/commerce/money-alerts";
import { CONNECT_TENANT_LIMIT, CONNECT_TENANT_SCOPE } from "../src/routes/connect-admin";
import {
  auditActions,
  type Caller,
  callAs,
  type ConnectShop,
  connectEnv,
  createShop,
  enableConnect,
  expireLease,
  FakeConnectStripe,
  jsonOf,
  keysDeep,
  openActingAs,
  openAlertsOf,
  opsOf,
  seedReservedOp,
  tenantConnectRow,
} from "./connect-fixtures";
import { postEvent } from "./money-fixtures";
import { bootstrapPlatform, dyingDb, opWrites, settle, SliceWorld, unique } from "./slice-harness";

/**
 * CP3-F — Stripe Connect onboarding through the real routes: who may call
 * what, the reserve-first account creation under every failure Stripe and the
 * worker can produce, the onboarding and dashboard links, the ordered status
 * refresh, and the platform's opt-in and payout delay. Stripe is the
 * FakeConnectStripe (Stripe's idempotency semantics, no network).
 */

const STATUS = "/v1/admin/payments/connect";
const ACCOUNT = "/v1/admin/payments/connect/account";
const LINK = "/v1/admin/payments/connect/onboarding-link";
const REFRESH = "/v1/admin/payments/connect/refresh";
const LOGIN = "/v1/admin/payments/connect/login-link";
const platformPath = (shop: ConnectShop, suffix = "") => `/v1/platform/tenants/${shop.tenantId}/connect${suffix}`;

const NOT_FOUND = { error: { code: "not_found", message: "Route not found" } };
const OWN: Caller = { kind: "own_admin" };
const ACTING: Caller = { kind: "acting_as" };
const HOUR_MS = 60 * 60 * 1_000;

const world = new SliceWorld();
let fake: FakeConnectStripe;
let E: Env;

/** Every body a TENANT session (own admin or acting-as) received, for the one-number walk. */
const tenantBodies: Array<{ body: unknown; path: string }> = [];

async function resetLimiter(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limit_windows WHERE scope = ?").bind(CONNECT_TENANT_SCOPE).run();
}

async function fresh(): Promise<void> {
  world.reset();
  fake = new FakeConnectStripe();
  E = connectEnv(world, fake);
  await resetLimiter();
}

/** A tenant-session call whose status is asserted and whose body is kept for the walk. */
async function seller<T = Record<string, unknown>>(
  caller: Caller,
  shop: ConnectShop,
  method: string,
  path: string,
  status: number,
  options: { env?: Env; origin?: string | null; url?: string } = {},
): Promise<T> {
  const response = await callAs(world, caller, shop, method, path, { env: options.env ?? E, ...options });
  const body = await jsonOf<T>(response, status, `${caller.kind} ${method} ${path}`);
  if (caller.kind === "own_admin" || caller.kind === "acting_as") {
    tenantBodies.push({ body, path });
  }
  return body;
}

function platformCallAs(shop: ConnectShop, method: string, suffix: string, body?: unknown, targetEnv?: Env) {
  return callAs(world, { kind: "platform" }, shop, method, platformPath(shop, suffix), { body, env: targetEnv ?? E });
}

/** A shop the platform opted in, with an account created through the route. */
async function shopWithAccount(label: string): Promise<{ accountId: string; shop: ConnectShop }> {
  const shop = await createShop(world, unique(label));
  await enableConnect(world, shop, E);
  await seller(OWN, shop, "POST", ACCOUNT, 201);
  const row = await tenantConnectRow(shop.tenantId);
  return { accountId: row?.stripe_account_id as string, shop };
}

/** …whose onboarding Stripe has completed (facts written by the refresh route). */
async function activeShop(label: string): Promise<{ accountId: string; shop: ConnectShop }> {
  const made = await shopWithAccount(label);
  fake.setAccount(made.accountId, {
    chargesEnabled: true,
    detailsSubmitted: true,
    payoutsEnabled: true,
    requirementsDue: [],
  });
  await seller(OWN, made.shop, "POST", REFRESH, 200);
  return made;
}

beforeAll(async () => {
  await bootstrapPlatform(world);
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
describe("access: every route × no session, another shop's admin, the shop's admin, acting-as, platform", () => {
  let shop: ConnectShop;
  let noGrant: ConnectShop;
  let stranger: ConnectShop;

  beforeAll(async () => {
    await fresh();
    shop = (await activeShop("mx")).shop;
    noGrant = (await activeShop("mx-nogrant")).shop;
    stranger = await createShop(world, unique("mx-stranger"));
    await openActingAs(world, shop);
  }, 60_000);

  beforeEach(async () => {
    await resetLimiter();
  });

  type Row = [string, string, string, Record<Caller["kind"], number>, unknown?];
  const table: Row[] = [
    ["GET", STATUS, "seller", { acting_as: 200, none: 404, other_admin: 404, own_admin: 200, platform: 404 }],
    ["POST", ACCOUNT, "seller", { acting_as: 200, none: 404, other_admin: 404, own_admin: 200, platform: 404 }],
    ["POST", LINK, "seller", { acting_as: 200, none: 404, other_admin: 404, own_admin: 200, platform: 404 }],
    ["POST", REFRESH, "seller", { acting_as: 200, none: 404, other_admin: 404, own_admin: 200, platform: 404 }],
    // The dashboard login link: NOT for a platform user acting as the shop.
    ["POST", LOGIN, "seller", { acting_as: 404, none: 404, other_admin: 404, own_admin: 200, platform: 404 }],
    // Platform routes: a platform user working INSIDE the shop (acting-as, X-Shop-Id)
    // is in a shop's context, never a platform request — refused (DECISIONS D70).
    ["GET", "", "platform", { acting_as: 404, none: 404, other_admin: 404, own_admin: 404, platform: 200 }],
    ["POST", "/enable", "platform", { acting_as: 404, none: 404, other_admin: 404, own_admin: 404, platform: 200 }],
    [
      "PUT",
      "/payout-delay",
      "platform",
      { acting_as: 404, none: 404, other_admin: 404, own_admin: 404, platform: 200 },
      { delayDays: 7 },
    ],
    // Last: it turns the opt-in off (re-enabled after).
    ["POST", "/disable", "platform", { acting_as: 404, none: 404, other_admin: 404, own_admin: 404, platform: 200 }],
  ];

  it.each(table)("%s %s (%s)", async (method, path, surface, expected, body) => {
    const kinds: Caller["kind"][] = ["none", "other_admin", "own_admin", "acting_as", "platform"];
    for (const kind of kinds) {
      const caller: Caller = kind === "other_admin" ? { kind, shop: stranger } : ({ kind } as Caller);
      // "platform" names a shop it holds no grant on; everyone else names `shop`.
      const target = kind === "platform" ? noGrant : shop;
      const fullPath = surface === "platform" ? platformPath(target, path) : path;
      const callsBefore = fake.calls.length;
      const response = await callAs(world, caller, target, method, fullPath, { body, env: E });
      const parsed = await jsonOf<unknown>(response, expected[kind], `${kind} ${method} ${fullPath}`);
      if (expected[kind] === 404) {
        expect(parsed, `${kind}: the opaque 404`).toEqual(NOT_FOUND);
        expect(fake.calls.length, `${kind}: Stripe untouched`).toBe(callsBefore);
      } else if (surface === "seller") {
        tenantBodies.push({ body: parsed, path });
      }
    }
    if (path === "/disable") {
      await enableConnect(world, shop, E);
      await enableConnect(world, noGrant, E);
    }
  });

  it("a cross-origin or origin-less state change is the opaque 404, before Stripe and before any write", async () => {
    const before = await tenantConnectRow(shop.tenantId);
    const auditBefore = (await auditActions(shop.tenantId)).length;
    const callsBefore = fake.calls.length;
    for (const origin of ["https://evil.example", null]) {
      for (const path of [ACCOUNT, LINK, REFRESH, LOGIN]) {
        const response = await callAs(world, OWN, shop, "POST", path, { env: E, origin });
        expect(await jsonOf(response, 404, `${origin} ${path}`)).toEqual(NOT_FOUND);
      }
      for (const [method, suffix, body] of [
        ["POST", "/enable", undefined],
        ["POST", "/disable", undefined],
        ["PUT", "/payout-delay", { delayDays: 30 }],
      ] as const) {
        const response = await callAs(world, { kind: "platform" }, shop, method, platformPath(shop, suffix), {
          body,
          env: E,
          origin,
        });
        expect(await jsonOf(response, 404, `${origin} ${suffix}`)).toEqual(NOT_FOUND);
      }
    }
    expect(fake.calls.length).toBe(callsBefore);
    expect(await tenantConnectRow(shop.tenantId)).toEqual(before);
    expect((await auditActions(shop.tenantId)).length).toBe(auditBefore);
  });

  it("other methods on these exact paths fall through to the ordinary 404", async () => {
    const callsBefore = fake.calls.length;
    for (const [method, path] of [
      ["POST", STATUS],
      ["GET", ACCOUNT],
      ["DELETE", LINK],
      ["PUT", REFRESH],
      ["GET", LOGIN],
    ] as const) {
      const response = await callAs(world, OWN, shop, method, path, { env: E });
      expect(await jsonOf(response, 404, `${method} ${path}`)).toEqual(NOT_FOUND);
    }
    for (const [method, suffix] of [
      ["PUT", ""],
      ["GET", "/enable"],
      ["POST", "/payout-delay"],
    ] as const) {
      const response = await platformCallAs(shop, method, suffix);
      expect(await jsonOf(response, 404, `${method} ${suffix}`)).toEqual(NOT_FOUND);
    }
    expect(fake.calls.length).toBe(callsBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("create or reuse the account — reserve first", () => {
  beforeEach(fresh);

  it("Connect not enabled by the platform → the opaque 404; nothing reserved, Stripe never called", async () => {
    const shop = await createShop(world, unique("cx-off"));
    const response = await callAs(world, OWN, shop, "POST", ACCOUNT, { env: E });
    expect(await jsonOf(response, 404, "not enabled")).toEqual(NOT_FOUND);
    expect(fake.calls).toEqual([]);
    expect(await opsOf(shop.tenantId)).toEqual([]);
  });

  it("creates ONE account (op_id = idempotency key, tenant in metadata); a second request answers it with zero Stripe calls", async () => {
    const shop = await createShop(world, unique("cx-one"), "Kaffe & Kopp");
    await enableConnect(world, shop, E);

    const first = await seller<{ connect: Record<string, unknown> }>(OWN, shop, "POST", ACCOUNT, 201);
    expect(first.connect).toEqual({
      chargesEnabled: false,
      detailsSubmitted: false,
      enabled: true,
      hasAccount: true,
      payoutsEnabled: false,
      requirementsDue: [],
      status: "onboarding",
      syncedAt: null,
    });

    const [op, ...none] = await opsOf(shop.tenantId);
    expect(none).toEqual([]);
    expect(op).toMatchObject({
      accounts_api: "v1",
      attempts: 1,
      business_name: "Kaffe & Kopp",
      created_by: shop.adminUserId,
      error_code: null,
      lease_expires_at: null,
      state: "succeeded",
    });
    const accountId = op?.stripe_account_id as string;
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(accountId);

    expect(fake.callsOf("createAccount").map((entry) => entry.params)).toEqual([
      { businessName: "Kaffe & Kopp", idempotencyKey: op?.op_id, opId: op?.op_id, tenantId: shop.tenantId },
    ]);
    expect(fake.accounts.get(accountId)?.metadata).toEqual(
      accountMetadata({ opId: op?.op_id as string, tenantId: shop.tenantId }),
    );
    expect((await auditActions(shop.tenantId, "connect.account.")).map((row) => [row.action, row.actor_user_id])).toEqual([
      ["connect.account.reserve", shop.adminUserId],
      ["connect.account.created", shop.adminUserId],
    ]);

    const again = await seller<{ connect: Record<string, unknown> }>(OWN, shop, "POST", ACCOUNT, 200);
    expect(again).toEqual(first);
    expect(fake.callsOf("createAccount")).toHaveLength(1);
    expect(await opsOf(shop.tenantId)).toHaveLength(1);
  });

  it("a platform user acting as the shop may create it; the audit rows carry the grant", async () => {
    const shop = await createShop(world, unique("cx-acting"));
    await enableConnect(world, shop, E);
    await openActingAs(world, shop);
    await seller(ACTING, shop, "POST", ACCOUNT, 201);
    const audit = await auditActions(shop.tenantId, "connect.account.");
    expect(audit.map((row) => row.actor_user_id)).toEqual([world.platformUserId, world.platformUserId]);
    for (const row of audit) {
      expect(JSON.parse(row.metadata_json ?? "{}")).toHaveProperty("actingAsGrantId");
    }
  });

  it("two concurrent creates: one account, ONE Stripe create call (the second waits on the lease)", async () => {
    const shop = await createShop(world, unique("cx-race"));
    await enableConnect(world, shop, E);

    const held = fake.holdNextCreate();
    const firstPromise = callAs(world, OWN, shop, "POST", ACCOUNT, { env: E });
    await held.entered;

    const second = await callAs(world, OWN, shop, "POST", ACCOUNT, { env: E });
    expect(second.headers.get("retry-after")).toBe("5");
    const waiting = await jsonOf<{ accountCreation: string; connect: { hasAccount: boolean } }>(second, 202, "second");
    expect(waiting.accountCreation).toBe("pending");
    expect(waiting.connect.hasAccount).toBe(false);
    tenantBodies.push({ body: waiting, path: ACCOUNT });

    held.release();
    await jsonOf(await firstPromise, 201, "first");
    expect(fake.callsOf("createAccount")).toHaveLength(1);
    expect(fake.accounts.size).toBe(1);
    expect((await opsOf(shop.tenantId)).map((op) => op.state)).toEqual(["succeeded"]);
  });

  it("two creates fired together (the reservation race): still one account and one Stripe call", async () => {
    const shop = await createShop(world, unique("cx-race2"));
    await enableConnect(world, shop, E);
    const statuses = (
      await Promise.all([
        callAs(world, OWN, shop, "POST", ACCOUNT, { env: E }),
        callAs(world, OWN, shop, "POST", ACCOUNT, { env: E }),
      ])
    ).map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.every((status) => [200, 201, 202].includes(status))).toBe(true);
    expect(fake.callsOf("createAccount")).toHaveLength(1);
    expect(fake.accounts.size).toBe(1);
    expect(await opsOf(shop.tenantId)).toHaveLength(1);
  });

  it("the worker dies after Stripe created the account: the next request (after the lease) recovers the SAME account", async () => {
    const shop = await createShop(world, unique("cx-crash"));
    await enableConnect(world, shop, E);

    let stripeCalled = false;
    fake.onCreate = async () => {
      stripeCalled = true;
    };
    const { db } = dyingDb(
      () => stripeCalled,
      (op) => op.kind === "batch" && opWrites(op, /state = 'succeeded'/),
    );
    expect(await settle(callAs(world, OWN, shop, "POST", ACCOUNT, { env: connectEnv(world, fake, { DB: db }) }))).toBe(
      "threw",
    );

    const [op] = await opsOf(shop.tenantId);
    expect(op?.state).toBe("reserved");
    expect(Date.parse(op?.lease_expires_at as string)).toBeGreaterThan(Date.now());
    expect(fake.accounts.size).toBe(1);
    const accountA = [...fake.accounts.keys()][0];
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBeNull();

    // While the dead request's lease lasts, nobody talks to Stripe under its key.
    await seller(OWN, shop, "POST", ACCOUNT, 202);
    expect(fake.callsOf("createAccount")).toHaveLength(1);

    await expireLease(op?.op_id as string);
    await seller(OWN, shop, "POST", ACCOUNT, 201);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(accountA);
    expect(fake.accounts.size).toBe(1);
    expect(fake.createKeys()).toEqual([op?.op_id, op?.op_id]);
    expect(fake.replays).toEqual([op?.op_id]);
    expect(await opsOf(shop.tenantId)).toMatchObject([{ attempts: 2, state: "succeeded", stripe_account_id: accountA }]);
  });

  it("the answer is lost (timeout after Stripe succeeded): the next request retries the same key, gets the same account", async () => {
    const shop = await createShop(world, unique("cx-lost"));
    await enableConnect(world, shop, E);
    fake.loseNextCreateAnswer = true;

    const lost = await seller<{ accountCreation: string }>(OWN, shop, "POST", ACCOUNT, 202);
    expect(lost.accountCreation).toBe("pending");
    const [op] = await opsOf(shop.tenantId);
    expect(op).toMatchObject({ error_code: "outcome_unknown", state: "reserved" });
    // The lease was released at once: the retry need not wait.
    expect(Date.parse(op?.lease_expires_at as string)).toBeLessThanOrEqual(Date.now());
    const accountA = [...fake.accounts.keys()][0];

    await seller(OWN, shop, "POST", ACCOUNT, 201);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(accountA);
    expect(fake.accounts.size).toBe(1);
    expect(fake.createKeys()).toEqual([op?.op_id, op?.op_id]);
    expect(await opsOf(shop.tenantId)).toMatchObject([{ error_code: null, state: "succeeded" }]);
  });

  it("a refusal ends the operation `failed`; every next attempt is a NEW op_id, the replayed refusal is never hit", async () => {
    const shop = await createShop(world, unique("cx-refused"));
    await enableConnect(world, shop, E);

    // The staging sandbox before Accounts v1 was enabled.
    fake.refuseNewCreates = { code: null };
    const refused = await seller(OWN, shop, "POST", ACCOUNT, 502);
    expect(refused).toEqual({
      error: { code: "connect_account_refused", message: "The payment provider refused to create the account" },
    });
    fake.refuseNewCreates = { code: "platform_account_required" };
    await seller(OWN, shop, "POST", ACCOUNT, 502);

    // Mikael flips the dashboard setting.
    fake.refuseNewCreates = false;
    await seller(OWN, shop, "POST", ACCOUNT, 201);
    await seller(OWN, shop, "POST", ACCOUNT, 200);

    const ops = await opsOf(shop.tenantId);
    expect(ops.map((op) => [op.state, op.error_code])).toEqual([
      ["failed", "stripe_refused"],
      ["failed", "stripe_refused:platform_account_required"],
      ["succeeded", null],
    ]);
    const keys = fake.createKeys();
    expect(keys).toEqual(ops.map((op) => op.op_id));
    expect(new Set(keys).size).toBe(3);
    // Stripe still holds both refusals under their keys — and was never asked again.
    expect(fake.replays).toEqual([]);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(ops[2]?.stripe_account_id);
    expect((await auditActions(shop.tenantId, "connect.account.")).map((row) => row.action)).toEqual([
      "connect.account.reserve",
      "connect.account.refused",
      "connect.account.reserve",
      "connect.account.refused",
      "connect.account.reserve",
      "connect.account.created",
    ]);
  });

  it("the guarded update: an account set by something else meanwhile is NOT overwritten — an alert is raised", async () => {
    const shop = await createShop(world, unique("cx-guard"));
    await enableConnect(world, shop, E);
    const elsewhere = `acct_test_elsewhere${Math.floor(Math.random() * 1e6)}`;
    fake.onCreate = async () => {
      await env.DB.prepare("UPDATE tenants SET stripe_account_id = ? WHERE tenant_id = ?")
        .bind(elsewhere, shop.tenantId)
        .run();
    };

    const conflict = await seller(OWN, shop, "POST", ACCOUNT, 409);
    expect(conflict).toEqual({
      error: {
        code: "connect_account_conflict",
        message: "The payment account could not be recorded; the platform has been notified",
      },
    });
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(elsewhere);
    const [op] = await opsOf(shop.tenantId);
    const created = [...fake.accounts.keys()][0] as string;
    expect(op).toMatchObject({ state: "succeeded", stripe_account_id: created });

    const alerts = await openAlertsOf("connect_account_conflict", shop.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      resource_id: op?.op_id,
      resource_type: "connect_onboarding_op",
      severity: "critical",
    });
    expect(alerts[0]?.message).toContain(created);
    expect(alerts[0]?.message).not.toMatch(/https?:/);

    // The shop has an account now: no second creation is ever attempted.
    await seller(OWN, shop, "POST", ACCOUNT, 200);
    expect(fake.callsOf("createAccount")).toHaveLength(1);
  });

  it("the guarded update: an account another shop already holds is never bound twice (no UNIQUE abort, an alert)", async () => {
    const holder = await shopWithAccount("cx-holder");
    const shop = await createShop(world, unique("cx-steal"));
    await enableConnect(world, shop, E);
    // An old reservation whose recovery listing finds an account this shop's
    // metadata claims — but D1 already binds it to `holder`.
    const opId = await seedReservedOp(shop, { createdAtMs: Date.now() - 21 * HOUR_MS, leaseExpiresAtMs: null });
    fake.setAccount(holder.accountId, { metadata: accountMetadata({ opId, tenantId: shop.tenantId }) });

    await seller(OWN, shop, "POST", ACCOUNT, 409);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBeNull();
    expect((await tenantConnectRow(holder.shop.tenantId))?.stripe_account_id).toBe(holder.accountId);
    expect(await openAlertsOf("connect_account_conflict", shop.tenantId)).toHaveLength(1);
  });

  it("an account Stripe returns for an operation another request already CLOSED is never orphaned silently", async () => {
    const shop = await createShop(world, unique("cx-late"));
    await enableConnect(world, shop, E);
    const opId = await seedReservedOp(shop, { createdAtMs: Date.now() - 60_000, leaseExpiresAtMs: null });
    const newer = `acct_test_newer${Math.floor(Math.random() * 1e6)}`;
    // While this request's create is at Stripe, another request closes the
    // operation and records a newer account (the 20 h boundary race).
    fake.onCreate = async () => {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE connect_onboarding_ops
           SET state = 'abandoned', error_code = 'idempotency_window_expired',
               settled_at = created_at, lease_expires_at = NULL
           WHERE op_id = ?`,
        ).bind(opId),
        env.DB.prepare("UPDATE tenants SET stripe_account_id = ? WHERE tenant_id = ?").bind(newer, shop.tenantId),
      ]);
    };

    await seller(OWN, shop, "POST", ACCOUNT, 409);
    const late = [...fake.accounts.keys()][0] as string;
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(newer);
    expect(await opsOf(shop.tenantId)).toMatchObject([{ state: "abandoned", stripe_account_id: null }]);
    const alerts = await openAlertsOf("connect_account_conflict", shop.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.message).toContain(late);
  });

  it("a live lease: 202 and Stripe is not called", async () => {
    const shop = await createShop(world, unique("cx-lease"));
    await enableConnect(world, shop, E);
    await seedReservedOp(shop, { createdAtMs: Date.now(), leaseExpiresAtMs: Date.now() + CONNECT_ATTEMPT_LEASE_MS });
    await seller(OWN, shop, "POST", ACCOUNT, 202);
    expect(fake.calls).toEqual([]);
  });

  it(`past the ${CONNECT_KEY_RETRY_WINDOW_MS / HOUR_MS} h retry window the OLD key is never retried: a complete listing with nothing → abandoned + a new operation`, async () => {
    const shop = await createShop(world, unique("cx-window"));
    await enableConnect(world, shop, E);
    const old = await seedReservedOp(shop, {
      createdAtMs: Date.now() - CONNECT_KEY_RETRY_WINDOW_MS - 60_000,
      leaseExpiresAtMs: null,
    });

    await seller(OWN, shop, "POST", ACCOUNT, 201);
    const ops = await opsOf(shop.tenantId);
    expect(ops.map((op) => [op.op_id === old, op.state, op.error_code])).toEqual([
      [true, "abandoned", "idempotency_window_expired"],
      [false, "succeeded", null],
    ]);
    expect(fake.callsOf("findAccountsByTenant")).toHaveLength(1);
    expect(fake.createKeys()).toEqual([ops[1]?.op_id]);
  });

  it("past the window, an account carrying this shop's metadata is ADOPTED (the lost create's), never duplicated", async () => {
    const shop = await createShop(world, unique("cx-adopt"));
    await enableConnect(world, shop, E);
    const old = await seedReservedOp(shop, {
      createdAtMs: Date.now() - CONNECT_KEY_RETRY_WINDOW_MS - 60_000,
      leaseExpiresAtMs: null,
    });
    const made = fake.seedAccount(accountMetadata({ opId: old, tenantId: shop.tenantId }));
    fake.seedAccount({ tenant_id: "someone-else" });

    await seller(OWN, shop, "POST", ACCOUNT, 201);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(made.id);
    expect(await opsOf(shop.tenantId)).toMatchObject([{ op_id: old, state: "succeeded", stripe_account_id: made.id }]);
    expect(fake.callsOf("createAccount")).toEqual([]);
  });

  it("past the window, an incomplete or failed listing proves nothing: 202, still reserved, no new operation", async () => {
    const shop = await createShop(world, unique("cx-incomplete"));
    await enableConnect(world, shop, E);
    await seedReservedOp(shop, { createdAtMs: Date.now() - CONNECT_KEY_RETRY_WINDOW_MS - 60_000, leaseExpiresAtMs: null });

    fake.listingComplete = false;
    await seller(OWN, shop, "POST", ACCOUNT, 202);
    expect(await opsOf(shop.tenantId)).toMatchObject([{ error_code: "recovery_listing_incomplete", state: "reserved" }]);

    fake.failNext.findAccountsByTenant = "unknown";
    await seller(OWN, shop, "POST", ACCOUNT, 202);
    expect(await opsOf(shop.tenantId)).toMatchObject([{ error_code: "recovery_listing_failed", state: "reserved" }]);
    expect(fake.callsOf("createAccount")).toEqual([]);
  });

  it("past the window, ONE match in an INCOMPLETE listing is not adopted: another may sit on an unread page (Codex P2)", async () => {
    const shop = await createShop(world, unique("cx-partial"));
    await enableConnect(world, shop, E);
    const old = await seedReservedOp(shop, {
      createdAtMs: Date.now() - CONNECT_KEY_RETRY_WINDOW_MS - 60_000,
      leaseExpiresAtMs: null,
    });
    const visible = fake.seedAccount(accountMetadata({ opId: old, tenantId: shop.tenantId }));

    fake.listingComplete = false;
    await seller(OWN, shop, "POST", ACCOUNT, 202);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBeNull();
    expect(await opsOf(shop.tenantId)).toMatchObject([
      { error_code: "recovery_listing_incomplete", op_id: old, state: "reserved" },
    ]);
    expect(fake.callsOf("createAccount")).toEqual([]);

    // The same account from a COMPLETE listing is the shop's.
    fake.listingComplete = true;
    await seller(OWN, shop, "POST", ACCOUNT, 201);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBe(visible.id);
  });

  it("past the window, TWO accounts claiming the shop: a human decides (409 + alert), nothing adopted", async () => {
    const shop = await createShop(world, unique("cx-dup"));
    await enableConnect(world, shop, E);
    const opId = await seedReservedOp(shop, {
      createdAtMs: Date.now() - CONNECT_KEY_RETRY_WINDOW_MS - 60_000,
      leaseExpiresAtMs: null,
    });
    fake.seedAccount({ tenant_id: shop.tenantId });
    fake.seedAccount({ tenant_id: shop.tenantId });

    await seller(OWN, shop, "POST", ACCOUNT, 409);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_id).toBeNull();
    expect(await openAlertsOf("connect_account_duplicate", shop.tenantId)).toMatchObject([
      { resource_id: opId, severity: "critical" },
    ]);
  });

  it("a retry goes to the API the operation was first sent to (its idempotency key lives there)", async () => {
    const shop = await createShop(world, unique("cx-api"));
    await enableConnect(world, shop, E);
    await seedReservedOp(shop, { accountsApi: "v2", createdAtMs: Date.now() - 60_000, leaseExpiresAtMs: null });

    const asked: ConnectAccountsApi[] = [];
    const principal: TenantAdminPrincipal = {
      accountType: "tenant_admin",
      role: "admin",
      tenantId: shop.tenantId,
      userId: shop.adminUserId,
    };
    const outcome = await createOrReuseConnectAccount(env.DB, principal, {
      defaultApi: "v1",
      gatewayFor: (api) => {
        asked.push(api);
        return fake;
      },
    });
    expect(outcome.status).toBe("created");
    expect(asked).toEqual(["v2"]);
  });

  it("the schema refuses a second account attempt and an operation for a shop that is not opted in", async () => {
    const { shop } = await shopWithAccount("cx-schema");
    await expect(
      seedReservedOp(shop, { createdAtMs: Date.now(), leaseExpiresAtMs: null }),
    ).rejects.toThrow(/born reserved/);
    const off = await createShop(world, unique("cx-schema-off"));
    await expect(seedReservedOp(off, { createdAtMs: Date.now(), leaseExpiresAtMs: null })).rejects.toThrow(
      /born reserved/,
    );
    const [op] = await opsOf(shop.tenantId);
    await expect(
      env.DB.prepare("UPDATE connect_onboarding_ops SET state = 'failed', error_code = 'x' WHERE op_id = ?")
        .bind(op?.op_id)
        .run(),
    ).rejects.toThrow(/final|not allowed/);
    await expect(
      env.DB.prepare("DELETE FROM connect_onboarding_ops WHERE op_id = ?").bind(op?.op_id).run(),
    ).rejects.toThrow(/append-only/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("onboarding link", () => {
  beforeEach(fresh);

  it("return and refresh URLs come from the canonical web origin and carry the shop id", async () => {
    const { accountId, shop } = await shopWithAccount("ln-ok");
    const body = await seller<{ onboarding: { expiresAt: string; url: string } }>(OWN, shop, "POST", LINK, 200);
    expect(body.onboarding.url).toMatch(/^https:\/\/connect\.stripe\.test\//);
    expect(body.onboarding.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(fake.callsOf("createOnboardingLink").map((entry) => entry.params)).toEqual([
      {
        accountId,
        refreshUrl: `https://web.test.invalid/admin/payments?refresh=1&shopId=${shop.tenantId}`,
        returnUrl: `https://web.test.invalid/admin/payments?return=1&shopId=${shop.tenantId}`,
      },
    ]);
    expect(await auditActions(shop.tenantId, "connect.onboarding_link")).toEqual([
      { action: "connect.onboarding_link", actor_user_id: shop.adminUserId, metadata_json: JSON.stringify({ accountId }) },
    ]);
  });

  it("an origin that is not on the allowlist can never appear — not the request's host, not its Origin", async () => {
    const { shop } = await shopWithAccount("ln-host");
    await seller(OWN, shop, "POST", LINK, 200, {
      origin: "https://attacker.example",
      url: `https://attacker.example${LINK}`,
    });
    const sent = JSON.stringify(fake.callsOf("createOnboardingLink"));
    expect(sent).not.toContain("attacker");
    expect(sent).not.toContain("admin.slice.test");
    const urls = fake.callsOf("createOnboardingLink").flatMap((entry) => {
      const params = entry.params as { refreshUrl: string; returnUrl: string };
      return [params.refreshUrl, params.returnUrl];
    });
    expect(urls.every((url) => new URL(url).origin === "https://web.test.invalid")).toBe(true);
  });

  it("without a valid allowlist the surface does not exist (404, Stripe untouched)", async () => {
    const { shop } = await shopWithAccount("ln-noallow");
    for (const origins of [undefined, "not json", { api: "https://api.test.invalid", web: "http://web.test.invalid" }]) {
      const response = await callAs(world, OWN, shop, "POST", LINK, {
        env: connectEnv(world, fake, { CANONICAL_ORIGINS: origins }),
      });
      expect(await jsonOf(response, 404, String(origins))).toEqual(NOT_FOUND);
    }
    expect(fake.callsOf("createOnboardingLink")).toEqual([]);
  });

  it("the link is handed over, never stored and never logged", async () => {
    const { shop } = await shopWithAccount("ln-nostore");
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
    let url: string;
    try {
      url = (await seller<{ onboarding: { url: string } }>(OWN, shop, "POST", LINK, 200)).onboarding.url;
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    expect(JSON.stringify(logged)).not.toContain(url);

    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`,
    ).all<{ name: string }>();
    expect(tables.results.length).toBeGreaterThan(20);
    for (const { name } of tables.results) {
      const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows.results), `table ${name}`).not.toContain(url);
    }
  });

  it("no account yet → 409; Connect disabled → 404; Stripe down → 502", async () => {
    const shop = await createShop(world, unique("ln-none"));
    await enableConnect(world, shop, E);
    expect(await seller(OWN, shop, "POST", LINK, 409)).toEqual({
      error: { code: "connect_account_missing", message: "Create the payment account first" },
    });

    const withAccount = await shopWithAccount("ln-down");
    fake.failNext.createOnboardingLink = "unknown";
    expect(await seller(OWN, withAccount.shop, "POST", LINK, 502)).toEqual({
      error: { code: "connect_unavailable", message: "The payment provider could not be reached" },
    });

    await jsonOf(await platformCallAs(withAccount.shop, "POST", "/disable"), 200, "disable");
    expect(await jsonOf(await callAs(world, OWN, withAccount.shop, "POST", LINK, { env: E }), 404, "disabled")).toEqual(
      NOT_FOUND,
    );
    expect(fake.callsOf("createOnboardingLink")).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("status refresh — ordered like account.updated", () => {
  beforeEach(fresh);

  it("writes Stripe's facts, the requirements and the disabled reason; the status follows Firebase's deriveStatus", async () => {
    const { accountId, shop } = await shopWithAccount("rf-facts");
    await env.DB.prepare("UPDATE tenants SET stripe_account_resync_needed = 1 WHERE tenant_id = ?")
      .bind(shop.tenantId)
      .run();

    fake.setAccount(accountId, {
      disabledReason: "requirements.past_due",
      requirementsDue: ["individual.verification.document", "external_account"],
    });
    const before = Date.now();
    const restricted = await seller<{ connect: Record<string, unknown> }>(OWN, shop, "POST", REFRESH, 200);
    const after = Date.now();
    expect(restricted.connect).toMatchObject({
      chargesEnabled: false,
      requirementsDue: ["individual.verification.document", "external_account"],
      status: "restricted",
    });
    const row = await tenantConnectRow(shop.tenantId);
    expect(row).toMatchObject({
      stripe_account_resync_needed: 0,
      stripe_disabled_reason: "requirements.past_due",
      stripe_requirements_due_json: JSON.stringify(["individual.verification.document", "external_account"]),
    });
    // The watermark is the call's START, floored to its second.
    const watermark = row?.stripe_account_synced_at as number;
    expect(watermark % 1_000).toBe(0);
    expect(watermark).toBeGreaterThanOrEqual(Math.floor(before / 1_000) * 1_000);
    expect(watermark).toBeLessThanOrEqual(after);

    fake.setAccount(accountId, { detailsSubmitted: true, disabledReason: null, requirementsDue: [] });
    expect((await seller<{ connect: { status: string } }>(OWN, shop, "POST", REFRESH, 200)).connect.status).toBe("pending");
    fake.setAccount(accountId, { chargesEnabled: true, payoutsEnabled: true });
    expect((await seller<{ connect: Record<string, unknown> }>(OWN, shop, "POST", REFRESH, 200)).connect).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      status: "active",
    });
  });

  it("NEVER downgrades facts a newer account.updated wrote while the refresh was at Stripe", async () => {
    const { accountId, shop } = await shopWithAccount("rf-race");
    // What Stripe answers the refresh with (read at the call): still off.
    const eventCreated = Math.floor(Date.now() / 1_000) + 5;
    fake.onRetrieve = async () => {
      const { response } = await postEvent(
        "account.updated",
        { charges_enabled: true, details_submitted: true, id: accountId, object: "account", payouts_enabled: true },
        { created: eventCreated },
      );
      expect(response.status).toBe(200);
    };

    const body = await seller<{ connect: Record<string, unknown> }>(OWN, shop, "POST", REFRESH, 200);
    expect(body.connect).toMatchObject({ chargesEnabled: true, payoutsEnabled: true, status: "active" });
    const row = await tenantConnectRow(shop.tenantId);
    expect(row).toMatchObject({ stripe_charges_enabled: 1, stripe_payouts_enabled: 1 });
    expect(row?.stripe_account_synced_at).toBe(eventCreated * 1_000);
  });

  it("a restrictive event in the SAME second as the stored watermark, arriving while the refresh is at Stripe, is not overwritten (Codex P1)", async () => {
    const { accountId, shop } = await shopWithAccount("rf-tie");
    fake.setAccount(accountId, { chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true });
    await seller(OWN, shop, "POST", REFRESH, 200);
    const stored = await tenantConnectRow(shop.tenantId);
    expect(stored).toMatchObject({ stripe_charges_enabled: 1, stripe_payouts_enabled: 1 });
    const watermark = stored?.stripe_account_synced_at as number;

    // Stripe restricts the account. The refresh's own read still says "on"
    // (it was taken a moment earlier); the event carries the stored second.
    fake.onRetrieve = async () => {
      const { response } = await postEvent(
        "account.updated",
        { charges_enabled: false, details_submitted: true, id: accountId, object: "account", payouts_enabled: false },
        { created: watermark / 1_000 },
      );
      expect(response.status).toBe(200);
    };
    const outcome = await refreshConnectStatus(env.DB, fake, shop.tenantId, () => watermark + 500);
    expect(outcome).toMatchObject({ applied: false, status: "ok" });

    const row = await tenantConnectRow(shop.tenantId);
    expect(row, "the fail-closed merge stands").toMatchObject({
      stripe_charges_enabled: 0,
      stripe_payouts_enabled: 0,
    });
    expect(row?.stripe_account_synced_at, "the watermark did not move").toBe(watermark);
    const marker = await env.DB.prepare("SELECT stripe_account_resync_needed AS n FROM tenants WHERE tenant_id = ?")
      .bind(shop.tenantId)
      .first<{ n: number }>();
    expect(marker?.n, "the resync is still owed").toBe(1);

    // The resync is global: leave no owed resync behind for the suites that
    // count what one reconciliation run does.
    await env.DB.prepare("UPDATE tenants SET stripe_account_resync_needed = 0 WHERE tenant_id = ?")
      .bind(shop.tenantId)
      .run();
  });

  it("the watermark is the moment BEFORE Stripe was asked, floored to its second — not when the answer arrived", async () => {
    const { shop } = await shopWithAccount("rf-clock");
    const beforeCall = Date.UTC(2031, 0, 1, 0, 0, 0, 900);
    const afterCall = Date.UTC(2031, 0, 1, 0, 0, 7, 0);
    const times = [beforeCall, afterCall];
    const outcome = await refreshConnectStatus(env.DB, fake, shop.tenantId, () => times.shift() ?? afterCall);
    expect(outcome.status).toBe("ok");
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_synced_at).toBe(Date.UTC(2031, 0, 1, 0, 0, 0, 0));
  });

  it("after a refresh, an OLDER event is stale and a NEWER one applies (the same watermark rule)", async () => {
    const { accountId, shop } = await shopWithAccount("rf-order");
    fake.setAccount(accountId, { chargesEnabled: true, detailsSubmitted: true, payoutsEnabled: true });
    await seller(OWN, shop, "POST", REFRESH, 200);
    const watermark = (await tenantConnectRow(shop.tenantId))?.stripe_account_synced_at as number;

    const off = { charges_enabled: false, details_submitted: true, id: accountId, object: "account", payouts_enabled: false };
    await postEvent("account.updated", off, { created: watermark / 1_000 - 10 });
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({ stripe_charges_enabled: 1, stripe_payouts_enabled: 1 });

    await postEvent("account.updated", off, { created: watermark / 1_000 + 10 });
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({ stripe_charges_enabled: 0, stripe_payouts_enabled: 0 });
  });

  it("no account: the status as stored, Stripe untouched; Stripe down: 502 and nothing written", async () => {
    const shop = await createShop(world, unique("rf-none"));
    await enableConnect(world, shop, E);
    expect((await seller<{ connect: { status: string } }>(OWN, shop, "POST", REFRESH, 200)).connect.status).toBe("none");
    expect(fake.calls).toEqual([]);

    const { shop: down } = await shopWithAccount("rf-down");
    const before = await tenantConnectRow(down.tenantId);
    fake.failNext.retrieveAccount = "unknown";
    await seller(OWN, down, "POST", REFRESH, 502);
    expect(await tenantConnectRow(down.tenantId)).toEqual(before);
  });

  it(`is rate limited per shop (${CONNECT_TENANT_LIMIT} Stripe-calling requests per minute), before Stripe`, async () => {
    const { shop } = await shopWithAccount("rf-limit");
    await resetLimiter();
    for (let index = 0; index < CONNECT_TENANT_LIMIT; index += 1) {
      await seller(OWN, shop, "POST", REFRESH, 200);
    }
    const limited = await callAs(world, OWN, shop, "POST", REFRESH, { env: E });
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await jsonOf(limited, 429, "limited")).toEqual({
      error: { code: "rate_limited", message: "Too many requests" },
    });
    expect(fake.callsOf("retrieveAccount")).toHaveLength(CONNECT_TENANT_LIMIT);

    // Another shop's allowance is its own.
    const { shop: other } = await shopWithAccount("rf-limit-other");
    await seller(OWN, other, "POST", REFRESH, 200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Express dashboard login link", () => {
  beforeEach(fresh);

  it("refused (409) until onboarding completed — no account, or charges not enabled — Stripe untouched", async () => {
    const shop = await createShop(world, unique("lg-none"));
    await enableConnect(world, shop, E);
    const incomplete = { error: { code: "connect_onboarding_incomplete", message: "The payment account is not active yet" } };
    expect(await seller(OWN, shop, "POST", LOGIN, 409)).toEqual(incomplete);
    const { shop: onboarding } = await shopWithAccount("lg-onboarding");
    expect(await seller(OWN, onboarding, "POST", LOGIN, 409)).toEqual(incomplete);
    expect(fake.callsOf("createLoginLink")).toEqual([]);
  });

  it("the shop's own admin gets it once active (audited); a platform user acting as the shop never does", async () => {
    const { accountId, shop } = await activeShop("lg-active");
    const body = await seller<{ dashboard: { url: string } }>(OWN, shop, "POST", LOGIN, 200);
    expect(body.dashboard.url).toMatch(/^https:\/\/connect\.stripe\.test\/express\//);
    expect(await auditActions(shop.tenantId, "connect.login_link")).toEqual([
      { action: "connect.login_link", actor_user_id: shop.adminUserId, metadata_json: JSON.stringify({ accountId }) },
    ]);

    await openActingAs(world, shop);
    expect(await jsonOf(await callAs(world, ACTING, shop, "POST", LOGIN, { env: E }), 404, "acting-as")).toEqual(NOT_FOUND);
    expect(fake.callsOf("createLoginLink")).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("platform: opt-in, payout delay, the full read", () => {
  beforeEach(fresh);

  it("enable / disable are audited; disabling closes onboarding only — the account, its facts and checkout's gate are untouched", async () => {
    const { accountId, shop } = await activeShop("pf-toggle");
    const beforeFacts = await tenantConnectRow(shop.tenantId);

    const disabled = await jsonOf<{ connect: Record<string, unknown> }>(
      await platformCallAs(shop, "POST", "/disable"),
      200,
      "disable",
    );
    expect(disabled.connect).toMatchObject({ accountId, chargesEnabled: true, enabled: false, status: "active" });
    expect(await tenantConnectRow(shop.tenantId)).toEqual({ ...beforeFacts, connect_enabled: 0 });
    expect(fake.calls.filter((entry) => entry.method !== "createAccount" && entry.method !== "retrieveAccount")).toEqual([]);

    // Onboarding closed; the shop's own facts and dashboard stay reachable.
    expect(await jsonOf(await callAs(world, OWN, shop, "POST", ACCOUNT, { env: E }), 404, "create")).toEqual(NOT_FOUND);
    expect(await jsonOf(await callAs(world, OWN, shop, "POST", LINK, { env: E }), 404, "link")).toEqual(NOT_FOUND);
    expect((await seller<{ connect: Record<string, unknown> }>(OWN, shop, "GET", STATUS, 200)).connect).toMatchObject({
      chargesEnabled: true,
      enabled: false,
      status: "active",
    });
    await seller(OWN, shop, "POST", REFRESH, 200);
    await seller(OWN, shop, "POST", LOGIN, 200);

    await jsonOf(await platformCallAs(shop, "POST", "/enable"), 200, "enable");
    const audit = await auditActions(shop.tenantId, "connect.");
    expect(
      audit.filter((row) => row.action === "connect.enable" || row.action === "connect.disable").map((row) => [row.action, row.actor_user_id]),
    ).toEqual([
      ["connect.enable", world.platformUserId],
      ["connect.disable", world.platformUserId],
      ["connect.enable", world.platformUserId],
    ]);
  });

  it("payout delay: Stripe first, then stored + audited; 'minimum' stores NULL", async () => {
    const { accountId, shop } = await shopWithAccount("pf-delay");
    const set = await jsonOf<{ connect: { payoutDelayDays: number | null } }>(
      await platformCallAs(shop, "PUT", "/payout-delay", { delayDays: 14 }),
      200,
      "14 days",
    );
    expect(set.connect.payoutDelayDays).toBe(14);
    expect((await tenantConnectRow(shop.tenantId))?.payout_delay_days).toBe(14);

    const reset = await jsonOf<{ connect: { payoutDelayDays: number | null } }>(
      await platformCallAs(shop, "PUT", "/payout-delay", { delayDays: "minimum" }),
      200,
      "minimum",
    );
    expect(reset.connect.payoutDelayDays).toBeNull();
    expect(fake.callsOf("updatePayoutDelay").map((entry) => entry.params)).toEqual([
      { accountId, delayDays: 14 },
      { accountId, delayDays: "minimum" },
    ]);
    expect(
      (await auditActions(shop.tenantId, "connect.payout_delay")).map((row) => [row.actor_user_id, row.metadata_json]),
    ).toEqual([
      [world.platformUserId, JSON.stringify({ accountId, delayDays: 14 })],
      [world.platformUserId, JSON.stringify({ accountId, delayDays: "minimum" })],
    ]);
  });

  it("payout delay refusals: bad input 400, no account 409, Stripe refused 422, Stripe down 502 — nothing stored", async () => {
    const { shop } = await shopWithAccount("pf-delay-bad");
    for (const body of [{ delayDays: 366 }, { delayDays: -1 }, { delayDays: 1.5 }, { delayDays: "7" }, { delayDays: 7, x: 1 }, {}, null]) {
      const response = await platformCallAs(shop, "PUT", "/payout-delay", body);
      expect(await jsonOf(response, 400, JSON.stringify(body))).toEqual({
        error: { code: "invalid_request", message: "Request is not valid" },
      });
    }

    fake.failNext.updatePayoutDelay = "rejected";
    await jsonOf(await platformCallAs(shop, "PUT", "/payout-delay", { delayDays: 1 }), 422, "refused");
    fake.failNext.updatePayoutDelay = "unknown";
    await jsonOf(await platformCallAs(shop, "PUT", "/payout-delay", { delayDays: 30 }), 502, "down");
    expect((await tenantConnectRow(shop.tenantId))?.payout_delay_days).toBeNull();
    expect(await auditActions(shop.tenantId, "connect.payout_delay")).toEqual([]);

    const bare = await createShop(world, unique("pf-delay-none"));
    await jsonOf(await platformCallAs(bare, "PUT", "/payout-delay", { delayDays: 7 }), 409, "no account");
    expect(fake.callsOf("updatePayoutDelay")).toHaveLength(2);

    const ghost = { ...bare, tenantId: "no-such-shop" };
    expect(await jsonOf(await platformCallAs(ghost, "PUT", "/payout-delay", { delayDays: 7 }), 404, "ghost")).toEqual(
      NOT_FOUND,
    );
    expect(await jsonOf(await platformCallAs(ghost, "GET", ""), 404, "ghost read")).toEqual(NOT_FOUND);
    expect(await jsonOf(await platformCallAs(ghost, "POST", "/enable"), 404, "ghost enable")).toEqual(NOT_FOUND);
  });

  it("the platform read: every Connect fact and the operations history, newest first", async () => {
    const shop = await createShop(world, unique("pf-read"));
    await enableConnect(world, shop, E);
    fake.refuseNewCreates = { code: "account_invalid" };
    await seller(OWN, shop, "POST", ACCOUNT, 502);
    fake.refuseNewCreates = false;
    await seller(OWN, shop, "POST", ACCOUNT, 201);

    const body = await jsonOf<{ connect: Record<string, unknown>; operations: Array<Record<string, unknown>> }>(
      await platformCallAs(shop, "GET", ""),
      200,
      "read",
    );
    expect(Object.keys(body.connect).sort()).toEqual([
      "accountId",
      "chargesEnabled",
      "detailsSubmitted",
      "disabledReason",
      "enabled",
      "payoutDelayDays",
      "payoutsEnabled",
      "requirementsDue",
      "resyncNeeded",
      "status",
      "syncedAt",
      "tenantId",
    ]);
    expect(body.connect).toMatchObject({ enabled: true, status: "onboarding", tenantId: shop.tenantId });
    expect(body.operations.map((op) => [op.state, op.errorCode, op.createdBy, op.accountsApi])).toEqual([
      ["succeeded", null, shop.adminUserId, "v1"],
      ["failed", "stripe_refused:account_invalid", shop.adminUserId, "v1"],
    ]);
    expect(body.operations[0]?.accountId).toBe(body.connect.accountId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("account.updated and the 0027 resync keep the requirement list and disabled reason (review round 1)", () => {
  beforeEach(fresh);

  function accountObject(
    accountId: string,
    requirements: { currently_due: string[]; disabled_reason: string | null } | null,
    flags: { charges?: boolean; details?: boolean; payouts?: boolean } = {},
  ): Record<string, unknown> {
    return {
      charges_enabled: flags.charges ?? false,
      details_submitted: flags.details ?? false,
      id: accountId,
      object: "account",
      payouts_enabled: flags.payouts ?? false,
      ...(requirements === null ? {} : { requirements }),
    };
  }

  async function deliver(object: Record<string, unknown>, created: number): Promise<void> {
    const { response } = await postEvent("account.updated", object, { created });
    expect(response.status, `account.updated @${created}`).toBe(200);
  }

  const base = () => Math.floor(Date.now() / 1_000);

  it("an event that ADDS a requirement: stored, and the seller sees it", async () => {
    const { accountId, shop } = await shopWithAccount("wh-add");
    await deliver(accountObject(accountId, { currently_due: ["external_account"], disabled_reason: null }), base() + 10);
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({
      stripe_disabled_reason: null,
      stripe_requirements_due_json: JSON.stringify(["external_account"]),
    });
    const view = await seller<{ connect: Record<string, unknown> }>(OWN, shop, "GET", STATUS, 200);
    expect(view.connect).toMatchObject({ requirementsDue: ["external_account"], status: "onboarding" });
  });

  it("an event that CLEARS the list", async () => {
    const { accountId, shop } = await shopWithAccount("wh-clear");
    const at = base();
    await deliver(accountObject(accountId, { currently_due: ["external_account", "tos_acceptance.date"], disabled_reason: null }), at + 10);
    await deliver(accountObject(accountId, { currently_due: [], disabled_reason: null }, { details: true }), at + 20);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_requirements_due_json).toBe("[]");
    expect((await seller<{ connect: Record<string, unknown> }>(OWN, shop, "GET", STATUS, 200)).connect).toMatchObject({
      requirementsDue: [],
      status: "pending",
    });
  });

  it("a disabled reason ARRIVES (status restricted) and LEAVES", async () => {
    const { accountId, shop } = await shopWithAccount("wh-reason");
    const at = base();
    await deliver(
      accountObject(accountId, { currently_due: ["individual.verification.document"], disabled_reason: "requirements.past_due" }),
      at + 10,
    );
    expect((await tenantConnectRow(shop.tenantId))?.stripe_disabled_reason).toBe("requirements.past_due");
    expect((await seller<{ connect: { status: string } }>(OWN, shop, "GET", STATUS, 200)).connect.status).toBe("restricted");

    await deliver(accountObject(accountId, { currently_due: [], disabled_reason: null }, { charges: true, details: true, payouts: true }), at + 20);
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({
      stripe_charges_enabled: 1,
      stripe_disabled_reason: null,
      stripe_requirements_due_json: "[]",
    });
    expect((await seller<{ connect: { status: string } }>(OWN, shop, "GET", STATUS, 200)).connect.status).toBe("active");
  });

  it("an OLDER event arriving after a newer one overwrites neither the list nor the reason", async () => {
    const { accountId, shop } = await shopWithAccount("wh-order");
    const at = base();
    await deliver(accountObject(accountId, { currently_due: [], disabled_reason: null }, { details: true }), at + 30);
    const before = await tenantConnectRow(shop.tenantId);
    await deliver(
      accountObject(accountId, { currently_due: ["external_account", "company.tax_id"], disabled_reason: "rejected.other" }),
      at + 20,
    );
    expect(await tenantConnectRow(shop.tenantId)).toEqual(before);
    expect(before).toMatchObject({ stripe_disabled_reason: null, stripe_requirements_due_json: "[]" });
  });

  it("an event without a requirements object leaves both facts as they are", async () => {
    const { accountId, shop } = await shopWithAccount("wh-partial");
    const at = base();
    await deliver(accountObject(accountId, { currently_due: ["external_account"], disabled_reason: "requirements.past_due" }), at + 10);
    await deliver(accountObject(accountId, null, { details: true }), at + 20);
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({
      stripe_details_submitted: 1,
      stripe_disabled_reason: "requirements.past_due",
      stripe_requirements_due_json: JSON.stringify(["external_account"]),
    });
  });

  it("a same-second tie merges fail-closed and marks the resync; the resync writes Stripe's authoritative list and reason", async () => {
    const { accountId, shop } = await shopWithAccount("wh-tie");
    const at = base() + 10;
    await deliver(accountObject(accountId, { currently_due: ["external_account"], disabled_reason: "requirements.past_due" }), at);
    await deliver(accountObject(accountId, { currently_due: ["a.one", "b.two"], disabled_reason: null }), at);
    // Fail-closed: the reason either event reported survives, the longer list is kept, and the shop is marked.
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({
      stripe_account_resync_needed: 1,
      stripe_disabled_reason: "requirements.past_due",
      stripe_requirements_due_json: JSON.stringify(["a.one", "b.two"]),
    });

    // Reconciliation's resync reads through the Connect gateway (the money fake is never asked).
    fake.setAccount(accountId, {
      chargesEnabled: true,
      detailsSubmitted: true,
      disabledReason: null,
      payoutsEnabled: true,
      requirementsDue: ["company.address.city"],
    });
    const summary = await runReconciliation(connectEnv(world, fake), (at + 60) * 1_000);
    expect(summary.accounts).toMatchObject({ errors: 0, resynced: 1 });
    expect(world.stripe.retrieveAccountCalls).toEqual([]);
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({
      stripe_account_resync_needed: 0,
      stripe_charges_enabled: 1,
      stripe_disabled_reason: null,
      stripe_requirements_due_json: JSON.stringify(["company.address.city"]),
    });
  });

  it("an identical same-second duplicate needs no resync", async () => {
    const { accountId, shop } = await shopWithAccount("wh-dup");
    const at = base() + 10;
    const object = accountObject(accountId, { currently_due: ["external_account"], disabled_reason: null });
    await deliver(object, at);
    await deliver(object, at);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_resync_needed).toBe(0);
  });

  it("without a Connect gateway (the money fake only) the resync writes the flags and leaves the two facts", async () => {
    const { accountId, shop } = await shopWithAccount("wh-fallback");
    const at = base() + 10;
    await deliver(accountObject(accountId, { currently_due: ["external_account"], disabled_reason: null }), at);
    await deliver(accountObject(accountId, { currently_due: ["external_account"], disabled_reason: null }, { charges: true }), at);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_resync_needed).toBe(1);

    world.stripe.accounts.set(accountId, {
      charges_enabled: true,
      details_submitted: true,
      id: accountId,
      payouts_enabled: true,
    });
    await runReconciliation(world.env, (at + 60) * 1_000);
    expect(world.stripe.retrieveAccountCalls).toEqual([accountId]);
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({
      stripe_account_resync_needed: 0,
      stripe_charges_enabled: 1,
      stripe_requirements_due_json: JSON.stringify(["external_account"]),
    });
  });

  it("when the Connect gateway cannot read the account, the money gateway still re-reads the FLAGS (consolidation)", async () => {
    const { accountId, shop } = await shopWithAccount("wh-degraded");
    const at = base() + 20;
    await deliver(accountObject(accountId, { currently_due: ["external_account"], disabled_reason: null }), at);
    await deliver(accountObject(accountId, { currently_due: ["external_account"], disabled_reason: null }, { charges: true }), at);
    expect((await tenantConnectRow(shop.tenantId))?.stripe_account_resync_needed).toBe(1);

    world.stripe.accounts.set(accountId, {
      charges_enabled: true,
      details_submitted: true,
      id: accountId,
      payouts_enabled: true,
    });
    fake.failNext.retrieveAccount = "unknown";
    const summary = await runReconciliation(connectEnv(world, fake), (at + 60) * 1_000);

    expect(summary.accounts, "no failed resync, no alert").toMatchObject({ errors: 0, resynced: 1 });
    expect(world.stripe.retrieveAccountCalls).toEqual([accountId]);
    expect(await tenantConnectRow(shop.tenantId)).toMatchObject({
      stripe_account_resync_needed: 0,
      stripe_charges_enabled: 1,
      stripe_payouts_enabled: 1,
      // The seller's two facts stay as the events left them.
      stripe_requirements_due_json: JSON.stringify(["external_account"]),
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("stuck reservations: one warning per operation reserved over 24 h (review round 1)", () => {
  beforeEach(fresh);

  async function stuckAlertsOf(opId: string) {
    const rows = await env.DB.prepare(
      `SELECT id, tenant_id, severity, message, resource_type, resolved_at FROM alerts
       WHERE kind = ? AND resource_id = ? ORDER BY created_at, id`,
    )
      .bind(CONNECT_STUCK_ALERT_KIND, opId)
      .all<{ id: string; message: string; resolved_at: string | null; resource_type: string; severity: string; tenant_id: string }>();
    return rows.results;
  }

  it("none at 23 h 59 min; one after 24 h; none on the next run; a new one only after the first was resolved", async () => {
    const t0 = Date.UTC(2032, 0, 1, 12, 0, 0, 0);
    // Reservations older tests left behind get theirs first, so the counts below are this operation's.
    await raiseStuckOnboardingAlerts(env.DB, t0 - 1, 10_000);

    const shop = await createShop(world, unique("st-one"));
    await enableConnect(world, shop, E);
    const opId = await seedReservedOp(shop, { createdAtMs: t0, leaseExpiresAtMs: null });

    expect(await raiseStuckOnboardingAlerts(env.DB, t0 + 24 * HOUR_MS - 60_000)).toBe(0);
    expect(await stuckAlertsOf(opId)).toEqual([]);

    expect(await raiseStuckOnboardingAlerts(env.DB, t0 + 24 * HOUR_MS + 60_000)).toBe(1);
    const [first, ...rest] = await stuckAlertsOf(opId);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      resolved_at: null,
      resource_type: "connect_onboarding_op",
      severity: "warning",
      tenant_id: shop.tenantId,
    });
    expect(first?.message).toContain(opId);
    expect(first?.message).not.toMatch(/https?:|@|\d+[.,]\d{2}\b|kr\b|sek/i);

    expect(await raiseStuckOnboardingAlerts(env.DB, t0 + 24 * HOUR_MS + 16 * 60_000)).toBe(0);
    expect(await stuckAlertsOf(opId)).toHaveLength(1);

    const resolved = await resolveAlert(env.DB, world.platformUserId, first?.id as string, { note: "looked at it" }, t0 + 25 * HOUR_MS);
    expect(resolved.status).toBe("ok");
    expect(await raiseStuckOnboardingAlerts(env.DB, t0 + 25 * HOUR_MS + 15 * 60_000)).toBe(1);
    const again = await stuckAlertsOf(opId);
    expect(again.map((row) => row.resolved_at === null)).toEqual([false, true]);
  });

  it("settled operations never alert, and a run handles at most `limit` operations (oldest first)", async () => {
    const t1 = Date.UTC(2033, 5, 1, 0, 0, 0, 0);
    await raiseStuckOnboardingAlerts(env.DB, t1 - 1, 10_000);

    const settled = await shopWithAccount("st-settled");
    const [settledOp] = await opsOf(settled.shop.tenantId);

    const opIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const shop = await createShop(world, unique(`st-bound${index}`));
      await enableConnect(world, shop, E);
      opIds.push(await seedReservedOp(shop, { createdAtMs: t1 + index * 60_000, leaseExpiresAtMs: null }));
    }
    const at = t1 + 25 * HOUR_MS;
    expect(await raiseStuckOnboardingAlerts(env.DB, at, 2)).toBe(2);
    expect((await stuckAlertsOf(opIds[0] as string)).length + (await stuckAlertsOf(opIds[1] as string)).length).toBe(2);
    expect(await stuckAlertsOf(opIds[2] as string)).toEqual([]);
    expect(await raiseStuckOnboardingAlerts(env.DB, at, 2)).toBe(1);
    expect(await raiseStuckOnboardingAlerts(env.DB, at, 2)).toBe(0);
    expect(await stuckAlertsOf(settledOp?.op_id as string)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the seller sees one number", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no tenant-session response, anywhere in this file, carries a commission or platform-internal field", () => {
    const seen = new Set(tenantBodies.map((entry) => entry.path));
    for (const path of [STATUS, ACCOUNT, LINK, REFRESH, LOGIN]) {
      expect(seen.has(path), `a tenant-session body from ${path} was walked`).toBe(true);
    }
    const allowed = new Set([
      "accountCreation",
      "chargesEnabled",
      "code",
      "connect",
      "dashboard",
      "detailsSubmitted",
      "enabled",
      "error",
      "expiresAt",
      "hasAccount",
      "message",
      "onboarding",
      "payoutsEnabled",
      "requirementsDue",
      "status",
      "syncedAt",
      "url",
    ]);
    const forbidden =
      /commission|fee|withh|bps|payout_?delay|delay|operation|op_?id|attempt|lease|created_?by|acting|grant|resync|disabled_?reason|account_?id|metadata|platform|internal|error_?code|tenant/i;
    for (const { body, path } of tenantBodies) {
      for (const key of keysDeep(body)) {
        expect(allowed.has(key), `${path}: unexpected key ${key}`).toBe(true);
        expect(forbidden.test(key), `${path}: forbidden key ${key}`).toBe(false);
      }
    }
  });
});

afterAll(() => {
  tenantBodies.length = 0;
});
