import Stripe from "stripe";

import {
  collectPages,
  isStripeConfigured,
  STRIPE_API_VERSION,
  STRIPE_GATEWAY_OVERRIDE,
} from "./stripe-client";

/**
 * The Stripe Connect ONBOARDING seam (CP3-F): creating a shop's connected
 * account, its hosted onboarding link, reading its status, the Express
 * dashboard login link and the platform's payout delay.
 *
 * A NEW seam beside stripe-client.ts's money gateway, in its style: the routes
 * depend on this interface and never on the SDK; tests inject a fake through
 * a plain Symbol on `env` (CONNECT_GATEWAY_OVERRIDE) that no deployed Worker
 * can carry; every Stripe failure becomes a detail-free ConnectGatewayError
 * that says only "did Stripe refuse" and, at most, Stripe's machine code.
 *
 * TWO ADAPTERS, chosen by the optional var `CONNECT_ACCOUNTS_API`:
 *   v1 (default, and for an absent or unknown value) — the calls proven on
 *      staging by scripts/cf-port/seed-staging-slice.mjs (`ensureConnectAccount`):
 *      an Express account (country SE, card_payments + transfers requested,
 *      metadata) and an `account_onboarding` account link.
 *   v2 — /v2/core/accounts, written from the SDK 22.5.0 type definitions only.
 *      ⚠️ UNVERIFIED: no call of it has ever reached Stripe. See
 *      createV2ConnectGateway for what staging must prove before it is used.
 */

export type ConnectAccountsApi = "v1" | "v2";

/**
 * What this worker keeps of a connected account. `metadata` is read only by
 * the recovery listing (an account is found by the tenant it names); the
 * rest are the Connect facts written onto `tenants`.
 */
export interface ConnectAccountFacts {
  accountId: string;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  /** v1 `requirements.disabled_reason` (a code), or null. */
  disabledReason: string | null;
  metadata: Record<string, string>;
  payoutsEnabled: boolean;
  /** What Stripe still needs from the seller, capped (MAX_REQUIREMENTS). */
  requirementsDue: string[];
}

export interface CreateConnectAccountParams {
  /** Sent as the account's business name; null omits it. Frozen per operation. */
  businessName: string | null;
  /** = the onboarding operation id: one operation can never become two accounts. */
  idempotencyKey: string;
  opId: string;
  tenantId: string;
}

export interface ConnectLink {
  /** Epoch ms, when Stripe says; null when it does not. */
  expiresAt: number | null;
  url: string;
}

/** A bounded listing: `complete: false` means absence proves nothing. */
export interface ConnectAccountListing {
  accounts: ConnectAccountFacts[];
  complete: boolean;
}

export interface ConnectGateway {
  readonly api: ConnectAccountsApi;
  createAccount(params: CreateConnectAccountParams): Promise<ConnectAccountFacts>;
  createLoginLink(accountId: string): Promise<{ url: string }>;
  createOnboardingLink(params: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<ConnectLink>;
  /**
   * RECOVERY ONLY: the accounts whose metadata names this tenant. Used when an
   * operation's idempotency key is too old to retry (Stripe prunes keys after
   * 24 h), so an account created by a lost answer is found, never duplicated.
   */
  findAccountsByTenant(tenantId: string): Promise<ConnectAccountListing>;
  retrieveAccount(accountId: string): Promise<ConnectAccountFacts>;
  updatePayoutDelay(params: { accountId: string; delayDays: number | "minimum" }): Promise<void>;
}

const GATEWAY_METHODS = [
  "createAccount",
  "createLoginLink",
  "createOnboardingLink",
  "findAccountsByTenant",
  "retrieveAccount",
  "updatePayoutDelay",
] as const;

/**
 * Every onboarding-gateway failure, detail-free like StripeGatewayError.
 *
 * `rejected` is true only when Stripe ANSWERED and refused THE REQUEST (a 4xx
 * other than 401/403/408/409/429 and other than an idempotency error): nothing
 * was created. Everything else — network, timeout, 5xx, rate limit, a key in
 * use, an idempotency-parameter mismatch, and a CREDENTIAL failure — is an
 * UNKNOWN outcome. 401 and 403 say nothing about an earlier attempt under the
 * same key: if that attempt created the account and its answer was lost, and
 * the retry then meets a rotated key or a changed permission, calling it a
 * refusal would close the operation and let the next request create a SECOND
 * account under a new key (Codex P1 on CP3-F). An idempotency error
 * in particular means the key already reached Stripe with other parameters,
 * so whatever that first request did stands; treating it as a refusal would
 * let a second account be created.
 *
 * `code` is Stripe's machine code (`parameter_unknown`, …) when it has the
 * shape of one, else null. Never a message, request id or account.
 */
export class ConnectGatewayError extends Error {
  readonly code: string | null;
  readonly rejected: boolean;

  constructor(rejected = false, code: string | null = null) {
    super("stripe connect request failed");
    this.name = "ConnectGatewayError";
    this.code = code;
    this.rejected = rejected;
  }
}

const STRIPE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** Maps an SDK (or any) failure to the detail-free error. */
export function connectGatewayError(error: unknown): ConnectGatewayError {
  if (error instanceof ConnectGatewayError) {
    return error;
  }
  const shape =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; rawType?: unknown; statusCode?: unknown; type?: unknown })
      : {};
  const status = shape.statusCode;
  const idempotency =
    shape.rawType === "idempotency_error" || shape.type === "StripeIdempotencyError";
  const rejected =
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429 &&
    !idempotency;
  const code =
    typeof shape.code === "string" && STRIPE_CODE_PATTERN.test(shape.code) ? shape.code : null;
  return new ConnectGatewayError(rejected, code);
}

// ── the facts' caps (0038's CHECKs are the backstop) ────────────────────────

export const MAX_REQUIREMENTS = 50;
export const MAX_REQUIREMENT_LENGTH = 120;
const MAX_REQUIREMENTS_JSON_BYTES = 8_192;
const DISABLED_REASON_PATTERN = /^[a-z0-9_.]{1,64}$/;

/**
 * A requirement list as it may be stored: strings only, control characters
 * removed, trimmed, each ≤ MAX_REQUIREMENT_LENGTH, deduplicated, at most
 * MAX_REQUIREMENTS, and ≤ 8 KiB as JSON.
 */
export function requirementsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const cleaned = entry.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_REQUIREMENT_LENGTH);
    if (cleaned.length === 0 || out.includes(cleaned)) {
      continue;
    }
    out.push(cleaned);
    if (out.length === MAX_REQUIREMENTS) {
      break;
    }
  }
  while (out.length > 0 && new TextEncoder().encode(JSON.stringify(out)).length > MAX_REQUIREMENTS_JSON_BYTES) {
    out.pop();
  }
  return out;
}

/** A disabled reason as it may be stored: Stripe's code, or "other" for any other shape. */
export function disabledReasonFrom(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return typeof value === "string" && DISABLED_REASON_PATTERN.test(value) ? value : "other";
}

function metadataOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) {
    return out;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string") {
      out[key] = inner;
    }
  }
  return out;
}

function httpsUrl(value: unknown): string {
  if (typeof value === "string") {
    try {
      if (new URL(value).protocol === "https:") {
        return value;
      }
    } catch {
      // fall through
    }
  }
  // Stripe answered 2xx with no usable link: unknown, never shown.
  throw new ConnectGatewayError(false);
}

function accountIdOf(value: unknown): string {
  if (typeof value === "string" && /^acct_[A-Za-z0-9_]{1,250}$/.test(value)) {
    return value;
  }
  // Stripe answered 2xx with something unreadable: the account may exist, so
  // the outcome is UNKNOWN (the operation stays reserved), never a refusal.
  throw new ConnectGatewayError(false);
}

/** The metadata every account this worker creates carries (the recovery listing's key). */
export function accountMetadata(params: { opId: string; tenantId: string }): Record<string, string> {
  return { onboarding_op_id: params.opId, tenant_id: params.tenantId };
}

/** Accounts scanned by the recovery listing before it gives up as incomplete. */
export const MAX_RECOVERY_ACCOUNTS = 2_000;

/**
 * The platform standard every connected account is created with (Firebase
 * functions/src/payment/connectOnboarding.ts createConnectAccount, a decided
 * business rule): MONTHLY payouts on the 1st — trivial per-payout fees, one
 * bookkeeping entry per month, "the money on the 1st of every month".
 *
 * It is part of the idempotent create request. An operation reserved before
 * this was added and retried after it would send different parameters under
 * the same key (Stripe answers an idempotency error — an UNKNOWN outcome here,
 * never a refusal). No such operation exists anywhere: this lands before the
 * create route was ever deployed (CP3-F review round 1).
 */
export const MONTHLY_PAYOUT_SCHEDULE = { interval: "monthly", monthly_anchor: 1 } as const;

// ═══════════════════════════════════════════════════════════════════════════
// v1 — the calls proven on staging (seed-staging-slice.mjs ensureConnectAccount)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The narrow SDK surface the v1 adapter calls. `new Stripe(...)` satisfies it;
 * a test hands in a stub and inspects the parameter objects, typed by the
 * SDK's own parameter types so a misspelt parameter fails to compile.
 */
export interface V1ConnectClient {
  accountLinks: {
    create(params: Stripe.AccountLinkCreateParams): Promise<Stripe.AccountLink>;
  };
  accounts: {
    create(params: Stripe.AccountCreateParams, options: Stripe.RequestOptions): Promise<Stripe.Account>;
    createLoginLink(id: string): Promise<Stripe.LoginLink>;
    list(params: Stripe.AccountListParams): Promise<Stripe.ApiList<Stripe.Account>>;
    retrieve(id: string): Promise<Stripe.Account>;
    update(id: string, params: Stripe.AccountUpdateParams): Promise<Stripe.Account>;
  };
}

function v1Facts(account: Stripe.Account): ConnectAccountFacts {
  return {
    accountId: accountIdOf(account.id),
    chargesEnabled: account.charges_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    disabledReason: disabledReasonFrom(account.requirements?.disabled_reason ?? null),
    metadata: metadataOf(account.metadata),
    payoutsEnabled: account.payouts_enabled === true,
    requirementsDue: requirementsFrom(account.requirements?.currently_due ?? []),
  };
}

/**
 * The create parameters are the staging-proven ones, key for key — `type:
 * "express"`, `country: "SE"`, `card_payments` + `transfers` requested, the
 * business name as `business_profile.name`, metadata naming the tenant (here:
 * `tenant_id` + `onboarding_op_id`), the idempotency key — PLUS Firebase's
 * payout schedule, `settings.payouts.schedule { interval: "monthly",
 * monthly_anchor: 1 }` (review round 1; not yet proven on staging).
 */
export function createV1ConnectGateway(client: V1ConnectClient): ConnectGateway {
  return {
    api: "v1",

    async createAccount(params) {
      let account: Stripe.Account;
      try {
        account = await client.accounts.create(
          {
            ...(params.businessName === null ? {} : { business_profile: { name: params.businessName } }),
            capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            country: "SE",
            metadata: accountMetadata(params),
            settings: { payouts: { schedule: { ...MONTHLY_PAYOUT_SCHEDULE } } },
            type: "express",
          },
          { idempotencyKey: params.idempotencyKey },
        );
      } catch (error) {
        throw connectGatewayError(error);
      }
      return v1Facts(account);
    },

    async createOnboardingLink(params) {
      let link: Stripe.AccountLink;
      try {
        link = await client.accountLinks.create({
          account: params.accountId,
          refresh_url: params.refreshUrl,
          return_url: params.returnUrl,
          type: "account_onboarding",
        });
      } catch (error) {
        throw connectGatewayError(error);
      }
      return {
        expiresAt: typeof link.expires_at === "number" ? link.expires_at * 1_000 : null,
        url: httpsUrl(link.url),
      };
    },

    async retrieveAccount(accountId) {
      try {
        return v1Facts(await client.accounts.retrieve(accountId));
      } catch (error) {
        throw connectGatewayError(error);
      }
    },

    async createLoginLink(accountId) {
      let link: Stripe.LoginLink;
      try {
        link = await client.accounts.createLoginLink(accountId);
      } catch (error) {
        throw connectGatewayError(error);
      }
      return { url: httpsUrl(link.url) };
    },

    async updatePayoutDelay(params) {
      // Firebase setConnectPayoutDelay, verbatim: only the hold window moves.
      try {
        await client.accounts.update(params.accountId, {
          settings: { payouts: { schedule: { delay_days: params.delayDays } } },
        });
      } catch (error) {
        throw connectGatewayError(error);
      }
    },

    async findAccountsByTenant(tenantId) {
      // The seed script's lookup: GET /v1/accounts, 100 per page, by metadata.
      try {
        const listing = await collectPages(async (startingAfter) => {
          const page = await client.accounts.list({
            limit: 100,
            ...(startingAfter === null ? {} : { starting_after: startingAfter }),
          });
          return { data: page.data, hasMore: page.has_more };
        }, MAX_RECOVERY_ACCOUNTS / 100);
        return {
          accounts: listing.data
            .filter((account) => metadataOf(account.metadata).tenant_id === tenantId)
            .map(v1Facts),
          complete: listing.complete,
        };
      } catch (error) {
        throw connectGatewayError(error);
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// v2 — ⚠️ UNVERIFIED (written from the SDK 22.5.0 types, never run against Stripe)
// ═══════════════════════════════════════════════════════════════════════════

/** The narrow SDK surface the v2 adapter calls (v2 core + two v1 interop calls). */
export interface V2ConnectClient {
  accounts: Pick<V1ConnectClient["accounts"], "createLoginLink" | "update">;
  v2: {
    core: {
      accountLinks: {
        create(params: Stripe.V2.Core.AccountLinkCreateParams): Promise<Stripe.V2.Core.AccountLink>;
      };
      accounts: {
        create(
          params: Stripe.V2.Core.AccountCreateParams,
          options: Stripe.RequestOptions,
        ): Promise<Stripe.V2.Core.Account>;
        list(params: Stripe.V2.Core.AccountListParams): AsyncIterable<Stripe.V2.Core.Account>;
        retrieve(
          id: string,
          params: Stripe.V2.Core.AccountRetrieveParams,
        ): Promise<Stripe.V2.Core.Account>;
      };
    };
  };
}

/** The configurations a retrieve must ask for: v2 omits them unless included. */
const V2_INCLUDE: Stripe.V2.Core.AccountRetrieveParams.Include[] = [
  "configuration.merchant",
  "configuration.recipient",
  "requirements",
];

/**
 * UNVERIFIED mapping of a v2 Account onto the v1-shaped facts the rest of
 * the worker (payment gate, account.updated, payouts) was built on:
 *   chargesEnabled   ← configuration.merchant.capabilities.card_payments.status === "active"
 *   payoutsEnabled   ← stripe_balance.payouts.status === "active" (recipient, else merchant)
 *   requirementsDue  ← requirements.entries awaiting the USER, currently_due or past_due
 *                      (their `description` text — v2 has no v1 field codes)
 *   detailsSubmitted ← no such v2 field: true when nothing awaits the user
 *   disabledReason   ← card_payments restricted ⇒ its first status_details code
 */
function v2Facts(account: Stripe.V2.Core.Account): ConnectAccountFacts {
  const merchant = account.configuration?.merchant;
  const recipient = account.configuration?.recipient;
  const cards = merchant?.capabilities?.card_payments;
  const payouts =
    recipient?.capabilities?.stripe_balance?.payouts ?? merchant?.capabilities?.stripe_balance?.payouts;
  const userDue = (account.requirements?.entries ?? []).filter(
    (entry) =>
      entry.awaiting_action_from === "user" &&
      (entry.minimum_deadline?.status === "currently_due" || entry.minimum_deadline?.status === "past_due"),
  );
  return {
    accountId: accountIdOf(account.id),
    chargesEnabled: cards?.status === "active",
    detailsSubmitted: userDue.length === 0,
    disabledReason:
      cards?.status === "restricted" ? disabledReasonFrom(cards.status_details?.[0]?.code ?? "other") : null,
    metadata: metadataOf(account.metadata),
    payoutsEnabled: payouts?.status === "active",
    requirementsDue: requirementsFrom(userDue.map((entry) => entry.description)),
  };
}

/**
 * ⚠️ UNVERIFIED — must not be selected on any environment until staging has
 * proven, with a sandbox account created through THIS adapter:
 *   1. the existing payment code (src/commerce/payment.ts, untouched) can make
 *      a destination charge to it: `transfer_data.destination` = the account,
 *      no `on_behalf_of` (D37), application fee collected;
 *   2. the existing `account.updated` handling (src/commerce/stripe-events.ts)
 *      still receives a v1 `account.updated` for it on the Connect endpoint
 *      and applies `charges_enabled` / `payouts_enabled`;
 *   3. the status mapping in v2Facts agrees with the v1 view of the SAME
 *      account (`GET /v1/accounts/{id}`) before, during and after onboarding;
 *   4. the two v1 interop calls work on a v2 account: `POST /v1/accounts/{id}/
 *      login_links` and `POST /v1/accounts/{id}` with `settings.payouts.
 *      schedule.delay_days`;
 *   5. `identity.country: "se"`, `dashboard: "express"` and the responsibility
 *      pair are accepted together, and `GET /v2/core/accounts` returns
 *      `metadata` (the recovery listing depends on it);
 *   6. the v1 schedule update right after the create leaves the v2 account on
 *      MONTHLY payouts anchored on the 1st (an account ADOPTED by the recovery
 *      listing does not get it re-applied — see the CP3-F report).
 *
 * Design choices, all unproven: BOTH configurations are requested — recipient
 * (`stripe_balance.stripe_transfers`, Stripe's documented choice for
 * destination charges without on_behalf_of) and merchant (`card_payments`),
 * mirroring v1's card_payments + transfers so the v1 `charges_enabled` the
 * payment gate reads can become true. `fees_collector: "application_express"`
 * + `losses_collector: "application"` + the Express dashboard is the v2
 * spelling of a v1 Express account's controller.
 */
export function createV2ConnectGateway(client: V2ConnectClient): ConnectGateway {
  return {
    api: "v2",

    async createAccount(params) {
      let account: Stripe.V2.Core.Account;
      try {
        account = await client.v2.core.accounts.create(
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
            ...(params.businessName === null ? {} : { display_name: params.businessName }),
            identity: { country: "se" },
            include: V2_INCLUDE,
            metadata: accountMetadata(params),
          },
          { idempotencyKey: params.idempotencyKey },
        );
      } catch (error) {
        throw connectGatewayError(error);
      }
      const facts = v2Facts(account);
      // Firebase's monthly payout schedule. v2 accounts have no schedule
      // parameter, so it is the v1 interop update (UNVERIFIED on a v2
      // account). The account EXISTS now: any failure here is reported as an
      // UNKNOWN outcome, never a refusal — the operation stays reserved, and
      // its retry replays the create under the same key and re-applies the
      // schedule (setting a value twice is harmless). A refusal here would
      // mark the operation failed and let a second account be created.
      try {
        await client.accounts.update(facts.accountId, {
          settings: { payouts: { schedule: { ...MONTHLY_PAYOUT_SCHEDULE } } },
        });
      } catch (error) {
        throw new ConnectGatewayError(false, connectGatewayError(error).code);
      }
      return facts;
    },

    async createOnboardingLink(params) {
      let link: Stripe.V2.Core.AccountLink;
      try {
        link = await client.v2.core.accountLinks.create({
          account: params.accountId,
          use_case: {
            account_onboarding: {
              configurations: ["merchant", "recipient"],
              refresh_url: params.refreshUrl,
              return_url: params.returnUrl,
            },
            type: "account_onboarding",
          },
        });
      } catch (error) {
        throw connectGatewayError(error);
      }
      const expiresAt = typeof link.expires_at === "string" ? Date.parse(link.expires_at) : Number.NaN;
      return { expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, url: httpsUrl(link.url) };
    },

    async retrieveAccount(accountId) {
      try {
        return v2Facts(await client.v2.core.accounts.retrieve(accountId, { include: V2_INCLUDE }));
      } catch (error) {
        throw connectGatewayError(error);
      }
    },

    async createLoginLink(accountId) {
      // v2 has no login-link resource: the v1 call (interop, unproven).
      let link: Stripe.LoginLink;
      try {
        link = await client.accounts.createLoginLink(accountId);
      } catch (error) {
        throw connectGatewayError(error);
      }
      return { url: httpsUrl(link.url) };
    },

    async updatePayoutDelay(params) {
      // v2 accounts carry no payout schedule: the v1 call (interop, unproven).
      try {
        await client.accounts.update(params.accountId, {
          settings: { payouts: { schedule: { delay_days: params.delayDays } } },
        });
      } catch (error) {
        throw connectGatewayError(error);
      }
    },

    async findAccountsByTenant(tenantId) {
      try {
        const accounts: ConnectAccountFacts[] = [];
        let scanned = 0;
        for await (const account of client.v2.core.accounts.list({ limit: 100 })) {
          scanned += 1;
          if (scanned > MAX_RECOVERY_ACCOUNTS) {
            return { accounts, complete: false };
          }
          if (metadataOf(account.metadata).tenant_id === tenantId) {
            accounts.push(v2Facts(account));
          }
        }
        return { accounts, complete: true };
      } catch (error) {
        throw connectGatewayError(error);
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// selection and the test seam
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The test seam, in STRIPE_GATEWAY_OVERRIDE's style: a plain Symbol, reachable
 * only by importing this binding, which no deployed env can carry.
 */
export const CONNECT_GATEWAY_OVERRIDE: unique symbol = Symbol("meteorshop.test.connectGateway");

/** SDK timeout per Connect call. The operation lease (connect-onboarding.ts) outlasts it. */
export const CONNECT_STRIPE_TIMEOUT_MS = 30_000;

/**
 * `CONNECT_ACCOUNTS_API` — an OPTIONAL var no config declares yet (reviewer
 * wiring). Exactly "v2" selects the unverified v2 adapter; anything else —
 * absent, "v1", a typo, a non-string — is v1.
 */
export function selectConnectAccountsApi(env: Env): ConnectAccountsApi {
  const raw = (env as unknown as Record<string, unknown>).CONNECT_ACCOUNTS_API;
  return raw === "v2" ? "v2" : "v1";
}

function isConnectGateway(value: unknown): value is ConnectGateway {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { api?: unknown }).api === "v1" || (value as { api?: unknown }).api === "v2") &&
    GATEWAY_METHODS.every((method) => typeof (value as Record<string, unknown>)[method] === "function")
  );
}

/**
 * The onboarding gateway, or null when the surface must stay dark.
 *
 *  - A test override (CONNECT_GATEWAY_OVERRIDE) is used when it implements the
 *    whole interface, and is NEVER replaced by the real client when it does
 *    not (null instead).
 *  - An env carrying the MONEY test fake (STRIPE_GATEWAY_OVERRIDE) but no
 *    Connect fake is a test env that did not opt in: null, never the real
 *    client.
 *  - Otherwise the real SDK client, when a Stripe key exists, for `api` (an
 *    operation's own API, so a retry under its idempotency key goes to the
 *    endpoint it was first sent to) or the configured one.
 */
export function resolveConnectGateway(env: Env, api?: ConnectAccountsApi): ConnectGateway | null {
  const bag = env as unknown as Record<PropertyKey, unknown>;
  const override = bag[CONNECT_GATEWAY_OVERRIDE];
  if (override !== undefined) {
    return isConnectGateway(override) ? override : null;
  }
  if (bag[STRIPE_GATEWAY_OVERRIDE] !== undefined || !isStripeConfigured(env)) {
    return null;
  }

  const client = new Stripe(env.STRIPE_SECRET_KEY as string, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    // Retries are the operation's business (same key, next request), never
    // the SDK's: a silent SDK retry would race the lease.
    maxNetworkRetries: 0,
    timeout: CONNECT_STRIPE_TIMEOUT_MS,
  });
  return (api ?? selectConnectAccountsApi(env)) === "v2"
    ? createV2ConnectGateway(client)
    : createV1ConnectGateway(client);
}
