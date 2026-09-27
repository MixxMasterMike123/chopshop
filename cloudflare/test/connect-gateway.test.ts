import { env } from "cloudflare:workers";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import type { V1ConnectClient, V2ConnectClient } from "../src/commerce/connect-gateway";
import {
  CONNECT_GATEWAY_OVERRIDE,
  ConnectGatewayError,
  connectGatewayError,
  createV1ConnectGateway,
  createV2ConnectGateway,
  disabledReasonFrom,
  MAX_RECOVERY_ACCOUNTS,
  MAX_REQUIREMENT_LENGTH,
  MAX_REQUIREMENTS,
  requirementsFrom,
  resolveConnectGateway,
  selectConnectAccountsApi,
} from "../src/commerce/connect-gateway";
import { STRIPE_GATEWAY_OVERRIDE } from "../src/commerce/stripe-client";
import { FakeConnectStripe } from "./connect-fixtures";
import { FakeMoneyStripe } from "./money-fixtures";

/**
 * CP3-F — the Connect onboarding seam: which adapter runs, and exactly what
 * each adapter sends to the SDK. Every client here is a stub that records the
 * parameter objects; nothing reaches the network (the pool's outbound
 * backstop would answer 599 if anything tried).
 */

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

function envWithout(key: string): Env {
  const copy = { ...env } as Record<string, unknown>;
  delete copy[key];
  return copy as unknown as Env;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("adapter selection (CONNECT_ACCOUNTS_API, optional)", () => {
  it("absent → v1", () => {
    const target = envWithout("CONNECT_ACCOUNTS_API");
    expect(selectConnectAccountsApi(target)).toBe("v1");
    expect(resolveConnectGateway(target)?.api).toBe("v1");
  });

  it.each([
    ["v1", "v1"],
    ["v2", "v2"],
    // Unknown values fall back to v1 — never to the unverified adapter.
    ["V2", "v1"],
    ["v3", "v1"],
    [" v2", "v1"],
    ["", "v1"],
    [2, "v1"],
    [null, "v1"],
    [{ api: "v2" }, "v1"],
  ])("%j → %s", (value, expected) => {
    const target = envWith({ CONNECT_ACCOUNTS_API: value });
    expect(selectConnectAccountsApi(target)).toBe(expected);
    expect(resolveConnectGateway(target)?.api).toBe(expected);
  });

  it("an explicit API (an operation's own) wins over the var", () => {
    expect(resolveConnectGateway(envWith({ CONNECT_ACCOUNTS_API: "v2" }), "v1")?.api).toBe("v1");
    expect(resolveConnectGateway(envWithout("CONNECT_ACCOUNTS_API"), "v2")?.api).toBe("v2");
  });

  it("no Stripe key → the surface is dark (null)", () => {
    expect(resolveConnectGateway(envWith({ STRIPE_SECRET_KEY: undefined }))).toBeNull();
    expect(resolveConnectGateway(envWith({ STRIPE_SECRET_KEY: "short" }))).toBeNull();
  });

  it("a test env carrying the money fake but no Connect fake never gets the real client", () => {
    expect(resolveConnectGateway(envWith({ [STRIPE_GATEWAY_OVERRIDE]: new FakeMoneyStripe() }))).toBeNull();
  });

  it("the Connect override is used whole or not at all", () => {
    const fake = new FakeConnectStripe();
    expect(resolveConnectGateway(envWith({ [CONNECT_GATEWAY_OVERRIDE]: fake, CONNECT_ACCOUNTS_API: "v2" }))).toBe(fake);

    const partial = { api: "v1", createAccount: async () => ({}) };
    expect(resolveConnectGateway(envWith({ [CONNECT_GATEWAY_OVERRIDE]: partial }))).toBeNull();
    expect(resolveConnectGateway(envWith({ [CONNECT_GATEWAY_OVERRIDE]: "not a gateway" }))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("error mapping: only a real refusal is 'rejected'", () => {
  it.each([
    [{ code: "parameter_unknown", rawType: "invalid_request_error", statusCode: 400 }, true, "parameter_unknown"],
    // A credential failure is not a refusal of the request (Codex P1): the
    // outcome of an earlier attempt under the same key stays unknown.
    [{ statusCode: 401 }, false, null],
    [{ statusCode: 403, code: "platform_api_key_expired" }, false, "platform_api_key_expired"],
    [{ statusCode: 404, code: "resource_missing" }, true, "resource_missing"],
    // A key already used with other parameters: the FIRST request stands — unknown.
    [{ rawType: "idempotency_error", statusCode: 400 }, false, null],
    [{ statusCode: 400, type: "StripeIdempotencyError" }, false, null],
    [{ statusCode: 408 }, false, null],
    [{ code: "idempotency_key_in_use", statusCode: 409 }, false, "idempotency_key_in_use"],
    [{ code: "rate_limit", statusCode: 429 }, false, "rate_limit"],
    [{ statusCode: 500 }, false, null],
    [{ statusCode: 503 }, false, null],
    [new TypeError("fetch failed"), false, null],
    ["a string", false, null],
    // Codes that do not look like Stripe's are dropped, never stored.
    [{ code: "Bad Code <script>", statusCode: 400 }, true, null],
  ])("%j → rejected %s, code %s", (error, rejected, code) => {
    const mapped = connectGatewayError(error);
    expect(mapped).toBeInstanceOf(ConnectGatewayError);
    expect(mapped.rejected).toBe(rejected);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe("stripe connect request failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the facts' caps", () => {
  it("requirements: strings only, cleaned, ≤ 120 chars each, deduplicated, ≤ 50, ≤ 8 KiB", () => {
    expect(requirementsFrom(null)).toEqual([]);
    expect(requirementsFrom(["a", 3, null, "  b\u0000\n ", "a", ""])).toEqual(["a", "b"]);
    const many = Array.from({ length: 80 }, (_, index) => `field_${index}_${"x".repeat(200)}`);
    const capped = requirementsFrom(many);
    expect(capped).toHaveLength(MAX_REQUIREMENTS);
    expect(capped.every((entry) => entry.length === MAX_REQUIREMENT_LENGTH)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(8_192);
  });

  it("disabled reason: Stripe's code, or 'other'", () => {
    expect(disabledReasonFrom(null)).toBeNull();
    expect(disabledReasonFrom(undefined)).toBeNull();
    expect(disabledReasonFrom("requirements.past_due")).toBe("requirements.past_due");
    expect(disabledReasonFrom("rejected.platform_terms_of_service")).toBe("rejected.platform_terms_of_service");
    expect(disabledReasonFrom("Not A Code")).toBe("other");
    expect(disabledReasonFrom(42)).toBe("other");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v1 — the parameters proven on staging
// ═══════════════════════════════════════════════════════════════════════════

/**
 * scripts/cf-port/seed-staging-slice.mjs, `ensureConnectAccount` — the two
 * Stripe calls that WORKED on the staging sandbox on 2026-09-27 (Express
 * account `acct_1UKHP7K39XhkqYJ0`, then its account link). Copied here
 * key for key: the v1 adapter must send exactly these, with its own
 * metadata keys in place of the seed's slice marker.
 */
const SEED_SHOP_NAME = "Slice Butik";
const SEED_ACCOUNT_PARAMS = {
  business_profile: { name: SEED_SHOP_NAME },
  capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
  country: "SE",
  metadata: { chopshop_slice_tenant: "slice-20260927" },
  type: "express",
};
const SEED_LINK_KEYS = ["account", "refresh_url", "return_url", "type"];

interface Recorded {
  args: unknown[];
  method: string;
}

function v1Account(overrides: Record<string, unknown> = {}): Stripe.Account {
  return {
    charges_enabled: false,
    details_submitted: false,
    id: "acct_test_v1one",
    metadata: { onboarding_op_id: "op-1234567890abcdef", tenant_id: "shop-a" },
    object: "account",
    payouts_enabled: false,
    requirements: { currently_due: ["external_account", "tos_acceptance.date"], disabled_reason: null },
    ...overrides,
  } as unknown as Stripe.Account;
}

function stubV1(options: {
  account?: Stripe.Account;
  fail?: unknown;
  linkUrl?: string;
  pages?: Array<{ data: Stripe.Account[]; has_more: boolean }>;
} = {}): { client: V1ConnectClient; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  let page = 0;
  const answer = async <T>(method: string, args: unknown[], value: T): Promise<T> => {
    recorded.push({ args, method });
    if (options.fail !== undefined) {
      throw options.fail;
    }
    return value;
  };
  const client: V1ConnectClient = {
    accountLinks: {
      create: (params) =>
        answer("accountLinks.create", [params], {
          expires_at: 1_900_000_000,
          url: options.linkUrl ?? "https://connect.stripe.com/setup/e/acct_test_v1one/abc",
        } as unknown as Stripe.AccountLink),
    },
    accounts: {
      create: (params, requestOptions) => answer("accounts.create", [params, requestOptions], options.account ?? v1Account()),
      createLoginLink: (id) =>
        answer("accounts.createLoginLink", [id], { url: "https://connect.stripe.com/express/abc" } as unknown as Stripe.LoginLink),
      list: (params) => {
        const next = options.pages?.[page] ?? { data: [], has_more: false };
        page += 1;
        return answer("accounts.list", [params], next as unknown as Stripe.ApiList<Stripe.Account>);
      },
      retrieve: (id) => answer("accounts.retrieve", [id], options.account ?? v1Account()),
      update: (id, params) => answer("accounts.update", [id, params], options.account ?? v1Account()),
    },
  };
  return { client, recorded };
}

/**
 * Firebase connectOnboarding.ts createConnectAccount, `settings` (a decided
 * business rule: monthly payouts on the 1st). Added to the create call in CP3-F
 * review round 1 — the ONE parameter beyond the seed script's staging-proven set.
 */
const FIREBASE_PAYOUT_SETTINGS = { payouts: { schedule: { interval: "monthly", monthly_anchor: 1 } } };

describe("v1 adapter: the staging-proven calls", () => {
  it("creates the account with the seed script's parameters PLUS Firebase's monthly payout schedule, under the operation's idempotency key", async () => {
    const { client, recorded } = stubV1();
    const gateway = createV1ConnectGateway(client);
    const facts = await gateway.createAccount({
      businessName: SEED_SHOP_NAME,
      idempotencyKey: "op-1234567890abcdef",
      opId: "op-1234567890abcdef",
      tenantId: "shop-a",
    });

    expect(recorded.map((entry) => entry.method)).toEqual(["accounts.create"]);
    const [params, requestOptions] = recorded[0]?.args as [Record<string, unknown>, unknown];
    const { metadata, ...sent } = params;
    const { metadata: seedMetadata, ...seed } = SEED_ACCOUNT_PARAMS;
    // Exactly the seed's parameters plus `settings` — nothing else added, nothing dropped.
    expect(sent).toEqual({ ...seed, settings: FIREBASE_PAYOUT_SETTINGS });
    expect(Object.keys(seedMetadata)).toHaveLength(1);
    expect(metadata).toEqual({ onboarding_op_id: "op-1234567890abcdef", tenant_id: "shop-a" });
    expect(requestOptions).toEqual({ idempotencyKey: "op-1234567890abcdef" });

    expect(facts).toEqual({
      accountId: "acct_test_v1one",
      chargesEnabled: false,
      detailsSubmitted: false,
      disabledReason: null,
      metadata: { onboarding_op_id: "op-1234567890abcdef", tenant_id: "shop-a" },
      payoutsEnabled: false,
      requirementsDue: ["external_account", "tos_acceptance.date"],
    });
  });

  it("omits business_profile when the shop has no name (nothing invented)", async () => {
    const { client, recorded } = stubV1();
    await createV1ConnectGateway(client).createAccount({
      businessName: null,
      idempotencyKey: "op-1234567890abcdef",
      opId: "op-1234567890abcdef",
      tenantId: "shop-a",
    });
    expect(Object.keys(recorded[0]?.args[0] as object).sort()).toEqual([
      "capabilities",
      "country",
      "metadata",
      "settings",
      "type",
    ]);
  });

  it("asks for the onboarding link with the seed script's keys and type", async () => {
    const { client, recorded } = stubV1();
    const link = await createV1ConnectGateway(client).createOnboardingLink({
      accountId: "acct_test_v1one",
      refreshUrl: "https://web.test.invalid/admin/payments?refresh=1&shopId=shop-a",
      returnUrl: "https://web.test.invalid/admin/payments?return=1&shopId=shop-a",
    });
    const params = recorded[0]?.args[0] as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(SEED_LINK_KEYS);
    expect(params).toEqual({
      account: "acct_test_v1one",
      refresh_url: "https://web.test.invalid/admin/payments?refresh=1&shopId=shop-a",
      return_url: "https://web.test.invalid/admin/payments?return=1&shopId=shop-a",
      type: "account_onboarding",
    });
    expect(link).toEqual({ expiresAt: 1_900_000_000_000, url: "https://connect.stripe.com/setup/e/acct_test_v1one/abc" });
  });

  it("refuses to hand on a link that is not https (an unknown outcome, never shown)", async () => {
    const { client } = stubV1({ linkUrl: "http://connect.stripe.com/setup" });
    const failure = await createV1ConnectGateway(client)
      .createOnboardingLink({ accountId: "acct_x1", refreshUrl: "https://a", returnUrl: "https://a" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectGatewayError);
    expect((failure as ConnectGatewayError).rejected).toBe(false);
  });

  it("login link, payout delay (Firebase's exact update) and retrieve", async () => {
    const { client, recorded } = stubV1({
      account: v1Account({
        charges_enabled: true,
        details_submitted: true,
        payouts_enabled: true,
        requirements: { currently_due: [], disabled_reason: "requirements.past_due" },
      }),
    });
    const gateway = createV1ConnectGateway(client);
    expect(await gateway.createLoginLink("acct_test_v1one")).toEqual({ url: "https://connect.stripe.com/express/abc" });
    await gateway.updatePayoutDelay({ accountId: "acct_test_v1one", delayDays: 14 });
    await gateway.updatePayoutDelay({ accountId: "acct_test_v1one", delayDays: "minimum" });
    const facts = await gateway.retrieveAccount("acct_test_v1one");

    expect(recorded.map((entry) => [entry.method, ...entry.args])).toEqual([
      ["accounts.createLoginLink", "acct_test_v1one"],
      ["accounts.update", "acct_test_v1one", { settings: { payouts: { schedule: { delay_days: 14 } } } }],
      ["accounts.update", "acct_test_v1one", { settings: { payouts: { schedule: { delay_days: "minimum" } } } }],
      ["accounts.retrieve", "acct_test_v1one"],
    ]);
    expect(facts).toMatchObject({
      chargesEnabled: true,
      detailsSubmitted: true,
      disabledReason: "requirements.past_due",
      payoutsEnabled: true,
      requirementsDue: [],
    });
  });

  it("the recovery listing pages like the seed script (100 per page, starting_after) and matches on metadata", async () => {
    const mine = v1Account({ id: "acct_test_mine", metadata: { onboarding_op_id: "op-x", tenant_id: "shop-a" } });
    const other = v1Account({ id: "acct_test_other", metadata: { tenant_id: "shop-b" } });
    const unmarked = v1Account({ id: "acct_test_plain", metadata: {} });
    const { client, recorded } = stubV1({
      pages: [
        { data: [other, unmarked], has_more: true },
        { data: [mine], has_more: false },
      ],
    });
    const listing = await createV1ConnectGateway(client).findAccountsByTenant("shop-a");
    expect(recorded.map((entry) => entry.args[0])).toEqual([{ limit: 100 }, { limit: 100, starting_after: "acct_test_plain" }]);
    expect(listing.complete).toBe(true);
    expect(listing.accounts.map((account) => account.accountId)).toEqual(["acct_test_mine"]);
  });

  it("a listing cut short by the page bound says so (absence proves nothing)", async () => {
    const pages = Array.from({ length: MAX_RECOVERY_ACCOUNTS / 100 + 5 }, (_, index) => ({
      data: [v1Account({ id: `acct_test_p${index}`, metadata: {} })],
      has_more: true,
    }));
    const listing = await createV1ConnectGateway(stubV1({ pages }).client).findAccountsByTenant("shop-a");
    expect(listing).toEqual({ accounts: [], complete: false });
  });

  it("every SDK failure becomes the detail-free error; a 2xx without an account id is an UNKNOWN outcome", async () => {
    const refused = await createV1ConnectGateway(stubV1({ fail: { code: "account_invalid", statusCode: 400 } }).client)
      .createAccount({ businessName: null, idempotencyKey: "k-1234567890abcdef", opId: "k-1234567890abcdef", tenantId: "t" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "account_invalid", rejected: true });
    expect((refused as Error).message).not.toMatch(/account_invalid|acct_/);

    const unreadable = await createV1ConnectGateway(stubV1({ account: v1Account({ id: 42 }) }).client)
      .createAccount({ businessName: null, idempotencyKey: "k-1234567890abcdef", opId: "k-1234567890abcdef", tenantId: "t" })
      .catch((error: unknown) => error);
    expect(unreadable).toBeInstanceOf(ConnectGatewayError);
    expect((unreadable as ConnectGatewayError).rejected).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2 — UNVERIFIED: these tests pin what the adapter SENDS and how it READS the
// SDK's documented shapes. They prove nothing about Stripe's answers.
// ═══════════════════════════════════════════════════════════════════════════

function v2Account(overrides: Record<string, unknown> = {}): Stripe.V2.Core.Account {
  return {
    applied_configurations: ["merchant", "recipient"],
    configuration: {
      merchant: {
        applied: true,
        capabilities: { card_payments: { status: "pending", status_details: [] } },
      },
      recipient: {
        applied: true,
        capabilities: {
          stripe_balance: {
            payouts: { status: "pending", status_details: [] },
            stripe_transfers: { status: "pending", status_details: [] },
          },
        },
      },
    },
    created: "2026-09-27T12:00:00.000Z",
    id: "acct_test_v2one",
    livemode: false,
    metadata: { onboarding_op_id: "op-1234567890abcdef", tenant_id: "shop-a" },
    object: "v2.core.account",
    requirements: {
      entries: [
        {
          awaiting_action_from: "user",
          description: "Provide a bank account for payouts",
          errors: [],
          impact: {},
          minimum_deadline: { status: "currently_due" },
          requested_reasons: [],
        },
        {
          awaiting_action_from: "stripe",
          description: "Stripe is reviewing",
          errors: [],
          impact: {},
          minimum_deadline: { status: "currently_due" },
          requested_reasons: [],
        },
        {
          awaiting_action_from: "user",
          description: "Later: tax id",
          errors: [],
          impact: {},
          minimum_deadline: { status: "eventually_due" },
          requested_reasons: [],
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.V2.Core.Account;
}

function stubV2(
  accounts: Stripe.V2.Core.Account[] = [v2Account()],
  options: { updateFails?: unknown } = {},
): { client: V2ConnectClient; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const client: V2ConnectClient = {
    accounts: {
      createLoginLink: async (id) => {
        recorded.push({ args: [id], method: "v1.accounts.createLoginLink" });
        return { url: "https://connect.stripe.com/express/v2" } as unknown as Stripe.LoginLink;
      },
      update: async (id, params) => {
        recorded.push({ args: [id, params], method: "v1.accounts.update" });
        if (options.updateFails !== undefined) {
          throw options.updateFails;
        }
        return {} as unknown as Stripe.Account;
      },
    },
    v2: {
      core: {
        accountLinks: {
          create: async (params) => {
            recorded.push({ args: [params], method: "v2.accountLinks.create" });
            return {
              expires_at: "2026-09-27T12:05:00.000Z",
              url: "https://connect.stripe.com/setup/v2/abc",
            } as unknown as Stripe.V2.Core.AccountLink;
          },
        },
        accounts: {
          create: async (params, options) => {
            recorded.push({ args: [params, options], method: "v2.accounts.create" });
            return accounts[0] as Stripe.V2.Core.Account;
          },
          list: (params) => {
            recorded.push({ args: [params], method: "v2.accounts.list" });
            return (async function* () {
              yield* accounts;
            })();
          },
          retrieve: async (id, params) => {
            recorded.push({ args: [id, params], method: "v2.accounts.retrieve" });
            return accounts[0] as Stripe.V2.Core.Account;
          },
        },
      },
    },
  };
  return { client, recorded };
}

describe("v2 adapter (UNVERIFIED — shapes from the SDK 22.5.0 types only)", () => {
  it("creates an Express-dashboard account with merchant + recipient configurations, metadata and the key", async () => {
    const { client, recorded } = stubV2();
    const facts = await createV2ConnectGateway(client).createAccount({
      businessName: "Butik",
      idempotencyKey: "op-1234567890abcdef",
      opId: "op-1234567890abcdef",
      tenantId: "shop-a",
    });
    expect(recorded[0]?.method).toBe("v2.accounts.create");
    expect(recorded[0]?.args).toEqual([
      {
        configuration: {
          merchant: { capabilities: { card_payments: { requested: true } } },
          recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
        },
        dashboard: "express",
        defaults: {
          currency: "sek",
          responsibilities: { fees_collector: "application_express", losses_collector: "application" },
        },
        display_name: "Butik",
        identity: { country: "se" },
        include: ["configuration.merchant", "configuration.recipient", "requirements"],
        metadata: { onboarding_op_id: "op-1234567890abcdef", tenant_id: "shop-a" },
      },
      { idempotencyKey: "op-1234567890abcdef" },
    ]);
    // Firebase's monthly schedule: v2 has no create parameter for it, so the v1 interop update follows.
    expect(recorded.slice(1)).toEqual([
      { args: ["acct_test_v2one", { settings: FIREBASE_PAYOUT_SETTINGS }], method: "v1.accounts.update" },
    ]);
    expect(facts).toEqual({
      accountId: "acct_test_v2one",
      chargesEnabled: false,
      detailsSubmitted: false,
      disabledReason: null,
      metadata: { onboarding_op_id: "op-1234567890abcdef", tenant_id: "shop-a" },
      payoutsEnabled: false,
      requirementsDue: ["Provide a bank account for payouts"],
    });
  });

  it("a failed schedule update AFTER the account exists is an unknown outcome, never a refusal (no second account)", async () => {
    const failure = await createV2ConnectGateway(
      stubV2([v2Account()], { updateFails: { code: "parameter_invalid_integer", statusCode: 400 } }).client,
    )
      .createAccount({ businessName: null, idempotencyKey: "op-1234567890abcdef", opId: "op-1234567890abcdef", tenantId: "shop-a" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectGatewayError);
    expect(failure).toMatchObject({ code: "parameter_invalid_integer", rejected: false });
  });

  it("maps active and restricted capabilities onto the v1-shaped facts", async () => {
    const active = v2Account({
      configuration: {
        merchant: { applied: true, capabilities: { card_payments: { status: "active", status_details: [] } } },
        recipient: {
          applied: true,
          capabilities: { stripe_balance: { payouts: { status: "active", status_details: [] } } },
        },
      },
      requirements: { entries: [] },
    });
    expect(await createV2ConnectGateway(stubV2([active]).client).retrieveAccount("acct_test_v2one")).toMatchObject({
      chargesEnabled: true,
      detailsSubmitted: true,
      disabledReason: null,
      payoutsEnabled: true,
      requirementsDue: [],
    });

    const restricted = v2Account({
      configuration: {
        merchant: {
          applied: true,
          capabilities: {
            card_payments: {
              status: "restricted",
              status_details: [{ code: "requirements_past_due", resolution: "provide_info" }],
            },
          },
        },
      },
    });
    expect(await createV2ConnectGateway(stubV2([restricted]).client).retrieveAccount("acct_test_v2one")).toMatchObject({
      chargesEnabled: false,
      disabledReason: "requirements_past_due",
    });
  });

  it("retrieve includes the configurations; the link uses use_case.account_onboarding", async () => {
    const { client, recorded } = stubV2();
    const gateway = createV2ConnectGateway(client);
    await gateway.retrieveAccount("acct_test_v2one");
    const link = await gateway.createOnboardingLink({
      accountId: "acct_test_v2one",
      refreshUrl: "https://web.test.invalid/r",
      returnUrl: "https://web.test.invalid/x",
    });
    expect(recorded.map((entry) => [entry.method, ...entry.args])).toEqual([
      [
        "v2.accounts.retrieve",
        "acct_test_v2one",
        { include: ["configuration.merchant", "configuration.recipient", "requirements"] },
      ],
      [
        "v2.accountLinks.create",
        {
          account: "acct_test_v2one",
          use_case: {
            account_onboarding: {
              configurations: ["merchant", "recipient"],
              refresh_url: "https://web.test.invalid/r",
              return_url: "https://web.test.invalid/x",
            },
            type: "account_onboarding",
          },
        },
      ],
    ]);
    expect(link).toEqual({ expiresAt: Date.parse("2026-09-27T12:05:00.000Z"), url: "https://connect.stripe.com/setup/v2/abc" });
  });

  it("login link and payout delay go through the v1 interop calls", async () => {
    const { client, recorded } = stubV2();
    const gateway = createV2ConnectGateway(client);
    await gateway.createLoginLink("acct_test_v2one");
    await gateway.updatePayoutDelay({ accountId: "acct_test_v2one", delayDays: 7 });
    expect(recorded.map((entry) => entry.method)).toEqual(["v1.accounts.createLoginLink", "v1.accounts.update"]);
    expect(recorded[1]?.args).toEqual(["acct_test_v2one", { settings: { payouts: { schedule: { delay_days: 7 } } } }]);
  });

  it("the recovery listing matches on metadata", async () => {
    const other = v2Account({ id: "acct_test_v2other", metadata: { tenant_id: "shop-b" } });
    const listing = await createV2ConnectGateway(stubV2([other, v2Account()]).client).findAccountsByTenant("shop-a");
    expect(listing.complete).toBe(true);
    expect(listing.accounts.map((account) => account.accountId)).toEqual(["acct_test_v2one"]);
  });
});
