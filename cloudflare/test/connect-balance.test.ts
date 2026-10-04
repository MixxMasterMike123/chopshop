import { env } from "cloudflare:workers";
import type Stripe from "stripe";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  balanceAmountsFrom,
  ConnectGatewayError,
  createV1ConnectGateway,
  createV2ConnectGateway,
  MAX_BALANCE_CURRENCIES,
  payoutScheduleFrom,
  type V1ConnectClient,
  type V2ConnectClient,
} from "../src/commerce/connect-gateway";
import { CONNECT_TENANT_LIMIT, CONNECT_TENANT_SCOPE } from "../src/routes/connect-admin";
import {
  type Caller,
  callAs,
  type ConnectShop,
  connectEnv,
  createShop,
  enableConnect,
  FakeConnectStripe,
  jsonOf,
  keysDeep,
  openActingAs,
  tenantConnectRow,
} from "./connect-fixtures";
import { expectNoCostKeys } from "./pod-fixtures";
import { bootstrapPlatform, platformCall, SliceWorld, unique } from "./slice-harness";

/**
 * CP5-WK, unit WF — GET /v1/admin/payments/connect/balance: the connected
 * account's own balance per currency and its payout schedule, read from
 * Stripe (the fake) through the Connect gateway. Refusals first, then the
 * answer, the one-number walk, Stripe failures, the limiter, and the two
 * adapters' reads.
 */

const BALANCE = "/v1/admin/payments/connect/balance";
const ACCOUNT = "/v1/admin/payments/connect/account";
const REFRESH = "/v1/admin/payments/connect/refresh";
const NOT_FOUND = { error: { code: "not_found", message: "Route not found" } };
const OWN: Caller = { kind: "own_admin" };

const world = new SliceWorld();
let fake: FakeConnectStripe;
let E: Env;

async function resetLimiter(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limit_windows WHERE scope = ?").bind(CONNECT_TENANT_SCOPE).run();
}

function get(caller: Caller, shop: ConnectShop, targetEnv: Env = E, method = "GET"): Promise<Response> {
  return callAs(world, caller, shop, method, BALANCE, { env: targetEnv });
}

/** A shop the platform opted in, whose account was created through the route. */
async function shopWithAccount(label: string): Promise<{ accountId: string; shop: ConnectShop }> {
  const shop = await createShop(world, unique(label));
  await enableConnect(world, shop, E);
  await jsonOf(await callAs(world, OWN, shop, "POST", ACCOUNT, { env: E }), 201, "create account");
  const row = await tenantConnectRow(shop.tenantId);
  return { accountId: row?.stripe_account_id as string, shop };
}

beforeAll(async () => {
  await bootstrapPlatform(world);
  world.reset();
  fake = new FakeConnectStripe();
  E = connectEnv(world, fake);
}, 60_000);

beforeEach(async () => {
  await resetLimiter();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("who may read it, and when it is dark", () => {
  let shop: ConnectShop;
  let accountId: string;
  let stranger: ConnectShop;

  beforeAll(async () => {
    ({ accountId, shop } = await shopWithAccount("wf-access"));
    stranger = await createShop(world, unique("wf-stranger"));
  }, 60_000);

  it("no session, another shop's admin, a platform session without a grant: the opaque 404, Stripe not called", async () => {
    const before = fake.callsOf("retrieveBalance").length;
    for (const caller of [{ kind: "none" }, { kind: "other_admin", shop: stranger }, { kind: "platform" }] as Caller[]) {
      expect(await jsonOf(await get(caller, shop), 404, caller.kind)).toEqual(NOT_FOUND);
    }
    expect(fake.callsOf("retrieveBalance").length).toBe(before);
  });

  it("only GET: every other method is a 404", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await get(OWN, shop, E, method);
      expect(response.status, method).toBe(404);
      await response.body?.cancel();
    }
  });

  it("a platform user acting as the shop is admitted (a balance opens nothing of the seller's account)", async () => {
    await openActingAs(world, shop);
    const body = await jsonOf<{ balance: { available: unknown[] } }>(await get({ kind: "acting_as" }, shop), 200, "acting-as");
    expect(body.balance.available).toEqual([{ amountMinor: 0, currency: "sek" }]);
    expect(fake.callsOf("retrieveBalance").at(-1)?.params).toBe(accountId);
  });

  it("dark while the platform has not enabled Connect for the shop, even with an account", async () => {
    const { shop: disabled } = await shopWithAccount("wf-disabled");
    await jsonOf(await platformCall(world, "POST", `/v1/platform/tenants/${disabled.tenantId}/connect/disable`, undefined, E), 200, "disable");
    const before = fake.callsOf("retrieveBalance").length;
    expect(await jsonOf(await get(OWN, disabled), 404, "disabled")).toEqual(NOT_FOUND);
    expect(fake.callsOf("retrieveBalance").length).toBe(before);
  });

  it("dark without a Connect gateway (no Stripe configured, or a test env that did not opt in)", async () => {
    expect(await jsonOf(await get(OWN, shop, world.env), 404, "no gateway")).toEqual(NOT_FOUND);
  });

  it("409 connect_account_missing before the account exists; Stripe is not called", async () => {
    const fresh = await createShop(world, unique("wf-noaccount"));
    await enableConnect(world, fresh, E);
    const before = fake.callsOf("retrieveBalance").length;
    expect(await jsonOf(await get(OWN, fresh), 409, "no account")).toEqual({
      error: { code: "connect_account_missing", message: "Create the payment account first" },
    });
    expect(fake.callsOf("retrieveBalance").length).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the answer", () => {
  it("is the account's available and pending per currency and its payout schedule, uncached, nothing else", async () => {
    const { accountId, shop } = await shopWithAccount("wf-answer");
    fake.balances.set(accountId, {
      available: [
        { amountMinor: 1_234_500, currency: "sek" },
        { amountMinor: -2_000, currency: "eur" },
      ],
      pending: [{ amountMinor: 49_900, currency: "sek" }],
    });
    fake.setAccount(accountId, { payoutDelayDays: 14 });

    const response = await get(OWN, shop);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = JSON.parse(text) as { balance: Record<string, unknown> };
    expect(body).toEqual({
      balance: {
        available: [
          { amountMinor: 1_234_500, currency: "sek" },
          { amountMinor: -2_000, currency: "eur" },
        ],
        payoutSchedule: { delayDays: 14, interval: "monthly", monthlyAnchor: 1, weeklyAnchor: null },
        pending: [{ amountMinor: 49_900, currency: "sek" }],
        retrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    });
    expect(fake.callsOf("retrieveBalance").at(-1)?.params).toBe(accountId);

    // The seller sees ONE number: no cost, fee, commission, printer, platform or account key, and no account id.
    expectNoCostKeys(body);
    for (const key of keysDeep(body)) {
      for (const denied of ["commission", "bps", "fee", "application", "transfer", "printer", "withh", "platform", "account", "reserve", "source", "stripe"]) {
        expect(key.toLowerCase(), key).not.toContain(denied);
      }
    }
    expect(text).not.toContain(accountId);
    expect(text).not.toContain("acct_");
  });

  it("a Stripe failure is a 502 connect_unavailable the page can show, never a 500", async () => {
    const { shop } = await shopWithAccount("wf-fail");
    for (const fault of ["unknown", "rejected"] as const) {
      fake.failNext.retrieveBalance = fault;
      expect(await jsonOf(await get(OWN, shop), 502, fault)).toEqual({
        error: { code: "connect_unavailable", message: "The payment provider could not be reached" },
      });
    }
    // An account Stripe no longer knows (the fake refuses it) is the same 502.
    await env.DB.prepare("UPDATE tenants SET stripe_account_id = ? WHERE tenant_id = ?")
      .bind(`acct_gone${Date.now()}`, shop.tenantId)
      .run();
    await jsonOf(await get(OWN, shop), 502, "unknown account");
  });

  it("shares the per-shop limiter with the Stripe-calling POSTs: 429 with Retry-After, Stripe not called", async () => {
    const { shop } = await shopWithAccount("wf-limit");
    await resetLimiter();
    for (let index = 0; index < CONNECT_TENANT_LIMIT; index += 1) {
      await jsonOf(await get(OWN, shop), 200, `read ${index}`);
    }
    const before = fake.callsOf("retrieveBalance").length;
    const limited = await get(OWN, shop);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    await limited.body?.cancel();
    expect(fake.callsOf("retrieveBalance").length).toBe(before);
    // The same bucket: a refresh POST is limited too.
    const refresh = await callAs(world, OWN, shop, "POST", REFRESH, { env: E });
    expect(refresh.status).toBe(429);
    await refresh.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the adapters' reads (Stripe stubbed)", () => {
  const ACCOUNT_ID = "acct_test_balance1";

  function stripeBalance(overrides: Record<string, unknown> = {}): Stripe.Balance {
    return {
      available: [{ amount: 12_345, currency: "sek", source_types: { card: 12_345 } }],
      connect_reserved: [{ amount: 999, currency: "sek" }],
      instant_available: [{ amount: 1, currency: "sek" }],
      livemode: false,
      object: "balance",
      pending: [{ amount: 500, currency: "SEK", source_types: { card: 500 } }],
      ...overrides,
    } as unknown as Stripe.Balance;
  }

  function stripeAccount(overrides: Record<string, unknown> = {}): Stripe.Account {
    return {
      id: ACCOUNT_ID,
      object: "account",
      settings: { payouts: { schedule: { delay_days: 7, interval: "monthly", monthly_anchor: 1 } } },
      ...overrides,
    } as unknown as Stripe.Account;
  }

  function stub(options: { account?: Stripe.Account; balance?: Stripe.Balance; fail?: unknown } = {}) {
    const recorded: Array<{ args: unknown[]; method: string }> = [];
    const answer = async <T>(method: string, args: unknown[], value: T): Promise<T> => {
      recorded.push({ args, method });
      if (options.fail !== undefined) {
        throw options.fail;
      }
      return value;
    };
    const balance = {
      retrieve: (params: Stripe.BalanceRetrieveParams, requestOptions: Stripe.RequestOptions) =>
        answer("balance.retrieve", [params, requestOptions], options.balance ?? stripeBalance()),
    };
    const retrieve = (id: string) => answer("accounts.retrieve", [id], options.account ?? stripeAccount());
    return {
      recorded,
      v1: { accountLinks: {}, accounts: { retrieve }, balance } as unknown as V1ConnectClient,
      v2: { accounts: { retrieve }, balance, v2: { core: {} } } as unknown as V2ConnectClient,
    };
  }

  it("v1: GET /v1/balance AS the connected account + the account for its schedule; keeps available and pending only", async () => {
    const { recorded, v1 } = stub();
    expect(await createV1ConnectGateway(v1).retrieveBalance(ACCOUNT_ID)).toEqual({
      available: [{ amountMinor: 12_345, currency: "sek" }],
      payoutSchedule: { delayDays: 7, interval: "monthly", monthlyAnchor: 1, weeklyAnchor: null },
      pending: [{ amountMinor: 500, currency: "sek" }],
    });
    expect(recorded).toEqual([
      { args: [{}, { stripeAccount: ACCOUNT_ID }], method: "balance.retrieve" },
      { args: [ACCOUNT_ID], method: "accounts.retrieve" },
    ]);
  });

  it("v2: the same two v1 interop reads", async () => {
    const { recorded, v2 } = stub();
    const balance = await createV2ConnectGateway(v2).retrieveBalance(ACCOUNT_ID);
    expect(balance.available).toEqual([{ amountMinor: 12_345, currency: "sek" }]);
    expect(recorded.map((entry) => entry.method)).toEqual(["balance.retrieve", "accounts.retrieve"]);
    expect(recorded[0]?.args[1]).toEqual({ stripeAccount: ACCOUNT_ID });
  });

  it("a refusal is a rejected gateway error; an unreadable answer or another account is an unknown one", async () => {
    const refused = await createV1ConnectGateway(stub({ fail: { code: "account_invalid", statusCode: 400 } }).v1)
      .retrieveBalance(ACCOUNT_ID)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectGatewayError);
    expect(refused).toMatchObject({ code: "account_invalid", rejected: true });

    for (const options of [
      { balance: stripeBalance({ available: null }) },
      { balance: stripeBalance({ pending: [{ amount: "12", currency: "sek" }] }) },
      { account: stripeAccount({ id: "acct_someone_else" }) },
    ]) {
      const failure = await createV1ConnectGateway(stub(options).v1)
        .retrieveBalance(ACCOUNT_ID)
        .catch((error: unknown) => error);
      expect(failure, JSON.stringify(options)).toBeInstanceOf(ConnectGatewayError);
      expect(failure).toMatchObject({ rejected: false });
    }
  });

  it("balanceAmountsFrom: one entry per currency (a repeat summed), lower-case, sorted, capped; a bad entry is unreadable", () => {
    expect(
      balanceAmountsFrom([
        { amount: 100, currency: "SEK" },
        { amount: -30, currency: "eur" },
        { amount: 5, currency: "sek" },
      ]),
    ).toEqual([
      { amountMinor: -30, currency: "eur" },
      { amountMinor: 105, currency: "sek" },
    ]);
    expect(balanceAmountsFrom([])).toEqual([]);
    const many = Array.from({ length: MAX_BALANCE_CURRENCIES + 5 }, (_unused, index) => ({
      amount: index,
      currency: `a${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
    }));
    expect(balanceAmountsFrom(many)).toHaveLength(MAX_BALANCE_CURRENCIES);
    for (const bad of [
      null,
      "x",
      [{ amount: 1.5, currency: "sek" }],
      [{ amount: 1, currency: "kronor" }],
      [{ amount: 1 }],
      [{ amount: Number.MAX_SAFE_INTEGER, currency: "sek" }, { amount: 1, currency: "sek" }],
    ]) {
      expect(() => balanceAmountsFrom(bad), JSON.stringify(bad)).toThrow(ConnectGatewayError);
    }
  });

  it("payoutScheduleFrom: the schedule as Stripe gives it, or null when there is none to read", () => {
    expect(payoutScheduleFrom({ delay_days: 2, interval: "weekly", weekly_anchor: "friday" })).toEqual({
      delayDays: 2,
      interval: "weekly",
      monthlyAnchor: null,
      weeklyAnchor: "friday",
    });
    expect(payoutScheduleFrom({ delay_days: -1, interval: "daily", monthly_anchor: 40 })).toEqual({
      delayDays: null,
      interval: "daily",
      monthlyAnchor: null,
      weeklyAnchor: null,
    });
    for (const none of [null, undefined, "monthly", {}, { interval: "Monthly!" }, { interval: 3 }]) {
      expect(payoutScheduleFrom(none), JSON.stringify(none)).toBeNull();
    }
  });
});
