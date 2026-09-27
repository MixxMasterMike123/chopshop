import { env } from "cloudflare:workers";
import { expect } from "vitest";

import type {
  ConnectAccountFacts,
  ConnectAccountListing,
  ConnectAccountsApi,
  ConnectGateway,
  ConnectLink,
  CreateConnectAccountParams,
} from "../src/commerce/connect-gateway";
import {
  accountMetadata,
  CONNECT_GATEWAY_OVERRIDE,
  ConnectGatewayError,
} from "../src/commerce/connect-gateway";
import {
  ADMIN,
  call,
  expectJson,
  PASSWORD,
  PLATFORM,
  platformCall,
  signIn,
  type SliceWorld,
} from "./slice-harness";

/**
 * CP3-F test fixtures: a fake Stripe Connect gateway with Stripe's idempotency
 * semantics, and shops built through the real platform routes WITHOUT a
 * Connect account (the slice harness's createTenant sets one by SQL). Not a
 * test file.
 */

// ── the fake gateway ────────────────────────────────────────────────────────

export type FakeConnectMethod =
  | "createAccount"
  | "createLoginLink"
  | "createOnboardingLink"
  | "findAccountsByTenant"
  | "retrieveAccount"
  | "updatePayoutDelay";

export interface FakeConnectCall {
  method: FakeConnectMethod;
  params: unknown;
}

export interface FakeAccount {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
  id: string;
  metadata: Record<string, string>;
  payoutDelayDays: number | "minimum" | null;
  payoutsEnabled: boolean;
  requirementsDue: string[];
}

/** What Stripe stored under an idempotency key: its FIRST answer. */
type StoredAnswer = { accountId: string } | { refusal: string | null };

/**
 * A fake of the Connect onboarding gateway that behaves like Stripe where it
 * matters here:
 *  - an idempotency key's FIRST answer — an account OR a refusal — is stored
 *    and replayed for every later call under that key (`replays` records each
 *    replay), exactly what blocked the staging run for 24 h;
 *  - `refuseNewCreates` refuses every create under a NEW key (and stores that
 *    refusal under it), like the sandbox before Accounts v1 was enabled;
 *  - `loseNextCreateAnswer` lets Stripe create the account and then loses the
 *    answer (a timeout after success);
 *  - `holdNextCreate` parks the next create until released (interleavings);
 *  - `failNext` fails the next call of a method, refused or unknown;
 *  - `onRetrieve` runs while a retrieve is "at Stripe" (an event racing it).
 * It never reaches the network.
 */
export class FakeConnectStripe implements ConnectGateway {
  api: ConnectAccountsApi = "v1";
  readonly accounts = new Map<string, FakeAccount>();
  readonly calls: FakeConnectCall[] = [];
  readonly idempotency = new Map<string, StoredAnswer>();
  /** Idempotency keys whose stored answer was replayed. */
  readonly replays: string[] = [];
  refuseNewCreates: false | { code: string | null } = false;
  loseNextCreateAnswer = false;
  listingComplete = true;
  failNext: Partial<Record<FakeConnectMethod, "rejected" | "unknown">> = {};
  onRetrieve: (() => Promise<void>) | null = null;
  onCreate: (() => Promise<void>) | null = null;
  private held: { entered: () => void; gate: Promise<void> } | null = null;
  private counter = 0;

  callsOf(method: FakeConnectMethod): FakeConnectCall[] {
    return this.calls.filter((entry) => entry.method === method);
  }

  createKeys(): string[] {
    return this.callsOf("createAccount").map((entry) => (entry.params as CreateConnectAccountParams).idempotencyKey);
  }

  /** Parks the next create inside "Stripe" until `release()`. */
  holdNextCreate(): { entered: Promise<void>; release: () => void } {
    let release = () => {};
    let entered = () => {};
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { entered, gate };
    return { entered: enteredPromise, release };
  }

  /** An account that already exists at Stripe (e.g. made by a lost create long ago). */
  seedAccount(metadata: Record<string, string>, overrides: Partial<FakeAccount> = {}): FakeAccount {
    this.counter += 1;
    const account: FakeAccount = {
      chargesEnabled: false,
      detailsSubmitted: false,
      disabledReason: null,
      id: `acct_test_${this.counter}${Math.floor(Math.random() * 1e6)}`,
      metadata,
      payoutDelayDays: null,
      payoutsEnabled: false,
      requirementsDue: ["external_account", "tos_acceptance.date"],
      ...overrides,
    };
    this.accounts.set(account.id, account);
    return account;
  }

  setAccount(accountId: string, patch: Partial<FakeAccount>): void {
    const account = this.accounts.get(accountId);
    if (account === undefined) {
      throw new Error(`fake: no account ${accountId}`);
    }
    Object.assign(account, patch);
  }

  private facts(account: FakeAccount): ConnectAccountFacts {
    return {
      accountId: account.id,
      chargesEnabled: account.chargesEnabled,
      detailsSubmitted: account.detailsSubmitted,
      disabledReason: account.disabledReason,
      metadata: { ...account.metadata },
      payoutsEnabled: account.payoutsEnabled,
      requirementsDue: [...account.requirementsDue],
    };
  }

  private injected(method: FakeConnectMethod): void {
    const fault = this.failNext[method];
    if (fault !== undefined) {
      delete this.failNext[method];
      throw new ConnectGatewayError(fault === "rejected", fault === "rejected" ? "invalid_request" : null);
    }
  }

  async createAccount(params: CreateConnectAccountParams): Promise<ConnectAccountFacts> {
    this.calls.push({ method: "createAccount", params });
    if (this.held !== null) {
      const held = this.held;
      this.held = null;
      held.entered();
      await held.gate;
    }
    if (this.onCreate !== null) {
      const hook = this.onCreate;
      this.onCreate = null;
      await hook();
    }
    this.injected("createAccount");

    const stored = this.idempotency.get(params.idempotencyKey);
    if (stored !== undefined) {
      this.replays.push(params.idempotencyKey);
      if ("refusal" in stored) {
        throw new ConnectGatewayError(true, stored.refusal);
      }
      return this.facts(this.accounts.get(stored.accountId) as FakeAccount);
    }

    if (this.refuseNewCreates !== false) {
      this.idempotency.set(params.idempotencyKey, { refusal: this.refuseNewCreates.code });
      throw new ConnectGatewayError(true, this.refuseNewCreates.code);
    }

    const account = this.seedAccount(accountMetadata(params));
    this.idempotency.set(params.idempotencyKey, { accountId: account.id });
    if (this.loseNextCreateAnswer) {
      this.loseNextCreateAnswer = false;
      throw new ConnectGatewayError(false);
    }
    return this.facts(account);
  }

  async createOnboardingLink(params: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<ConnectLink> {
    this.calls.push({ method: "createOnboardingLink", params });
    this.injected("createOnboardingLink");
    this.counter += 1;
    return {
      expiresAt: Date.UTC(2099, 0, 1),
      url: `https://connect.stripe.test/setup/e/${params.accountId}/link${this.counter}`,
    };
  }

  async createLoginLink(accountId: string): Promise<{ url: string }> {
    this.calls.push({ method: "createLoginLink", params: accountId });
    this.injected("createLoginLink");
    this.counter += 1;
    return { url: `https://connect.stripe.test/express/${accountId}/login${this.counter}` };
  }

  async retrieveAccount(accountId: string): Promise<ConnectAccountFacts> {
    this.calls.push({ method: "retrieveAccount", params: accountId });
    this.injected("retrieveAccount");
    const snapshot = this.accounts.get(accountId);
    if (snapshot === undefined) {
      throw new ConnectGatewayError(true, "account_invalid");
    }
    // Stripe answers with the state at the moment it read it; what happens
    // while the answer travels (the hook) is not in it.
    const facts = this.facts(snapshot);
    if (this.onRetrieve !== null) {
      const hook = this.onRetrieve;
      this.onRetrieve = null;
      await hook();
    }
    return facts;
  }

  async updatePayoutDelay(params: { accountId: string; delayDays: number | "minimum" }): Promise<void> {
    this.calls.push({ method: "updatePayoutDelay", params });
    this.injected("updatePayoutDelay");
    this.setAccount(params.accountId, { payoutDelayDays: params.delayDays });
  }

  async findAccountsByTenant(tenantId: string): Promise<ConnectAccountListing> {
    this.calls.push({ method: "findAccountsByTenant", params: tenantId });
    this.injected("findAccountsByTenant");
    return {
      accounts: [...this.accounts.values()]
        .filter((account) => account.metadata.tenant_id === tenantId)
        .map((account) => this.facts(account)),
      complete: this.listingComplete,
    };
  }
}

// ── shops, sessions and calls ───────────────────────────────────────────────

export interface ConnectShop {
  adminCookie: string;
  adminUserId: string;
  host: string;
  tenantId: string;
}

/**
 * POST /v1/platform/tenants + /v1/platform/users + …/admins, then the admin's
 * session. No Connect account, and Connect NOT enabled (the column default).
 */
export async function createShop(world: SliceWorld, tenantId: string, shopName = `Butik ${tenantId}`): Promise<ConnectShop> {
  const host = `${tenantId}.connect.test`;
  await expectJson(
    await platformCall(world, "POST", "/v1/platform/tenants", { hostname: host, shopName, tenantId }),
    201,
    `create tenant ${tenantId}`,
  );
  const email = `admin@${host}`;
  const created = await expectJson<{ user: { userId: string } }>(
    await platformCall(world, "POST", "/v1/platform/users", {
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    }),
    201,
    "create tenant admin",
  );
  await expectJson(
    await platformCall(world, "POST", `/v1/platform/tenants/${tenantId}/admins`, { userId: created.user.userId }),
    201,
    "grant tenant admin",
  );
  return { adminCookie: await signIn(world, email), adminUserId: created.user.userId, host, tenantId };
}

/** The env every Connect call in a suite runs under: the world's, plus the fake. */
export function connectEnv(world: SliceWorld, fake: FakeConnectStripe, overrides: Record<PropertyKey, unknown> = {}): Env {
  return world.with({ [CONNECT_GATEWAY_OVERRIDE]: fake, ...overrides });
}

export type Caller =
  | { kind: "acting_as" }
  | { kind: "none" }
  | { kind: "other_admin"; shop: ConnectShop }
  | { kind: "own_admin" }
  | { kind: "platform" };

/**
 * One request to an admin (`/v1/admin/...`, X-Shop-Id = `shop`) or platform
 * path as the named caller. `acting_as` = the platform user's session + the
 * shop's X-Shop-Id (the grant must already be open).
 */
export function callAs(
  world: SliceWorld,
  caller: Caller,
  shop: ConnectShop,
  method: string,
  path: string,
  options: { body?: unknown; env: Env; origin?: string | null; url?: string },
): Promise<Response> {
  const base = path.startsWith("/v1/platform/") ? PLATFORM : ADMIN;
  const url = options.url ?? `${base}${path}`;
  const common = { body: options.body, env: options.env, origin: options.origin };
  switch (caller.kind) {
    case "none":
      return call(world, method, url, { ...common, shopId: shop.tenantId });
    case "other_admin":
      return call(world, method, url, { ...common, cookie: caller.shop.adminCookie, shopId: shop.tenantId });
    case "own_admin":
      return call(world, method, url, { ...common, cookie: shop.adminCookie, shopId: shop.tenantId });
    case "acting_as":
      return call(world, method, url, { ...common, cookie: world.platformCookie, shopId: shop.tenantId });
    case "platform":
      // On an admin path: the platform session naming a shop it holds NO
      // acting-as grant on. On a platform path: a plain platform request — it
      // carries no X-Shop-Id, which the platform guard refuses (DECISIONS D70).
      return call(world, method, url, {
        ...common,
        cookie: world.platformCookie,
        ...(path.startsWith("/v1/platform/") ? {} : { shopId: shop.tenantId }),
      });
  }
}

/** POST /v1/platform/tenants/:id/acting-as (60 min). */
export async function openActingAs(world: SliceWorld, shop: ConnectShop): Promise<void> {
  await expectJson(
    await call(world, "POST", `${PLATFORM}/v1/platform/tenants/${shop.tenantId}/acting-as`, {
      body: { reason: "CP3-F connect tests" },
      cookie: world.platformCookie,
    }),
    201,
    "acting-as",
  );
}

export async function enableConnect(world: SliceWorld, shop: ConnectShop, targetEnv?: Env): Promise<void> {
  await expectJson(
    await platformCall(world, "POST", `/v1/platform/tenants/${shop.tenantId}/connect/enable`, undefined, targetEnv),
    200,
    "enable connect",
  );
}

export interface OpRowForTest {
  accounts_api: string;
  attempts: number;
  business_name: string | null;
  created_at: string;
  created_by: string;
  error_code: string | null;
  lease_expires_at: string | null;
  op_id: string;
  settled_at: string | null;
  state: string;
  stripe_account_id: string | null;
}

export async function opsOf(tenantId: string): Promise<OpRowForTest[]> {
  const rows = await env.DB.prepare(
    `SELECT op_id, state, stripe_account_id, accounts_api, business_name, attempts, lease_expires_at,
            error_code, created_by, created_at, settled_at
     FROM connect_onboarding_ops WHERE tenant_id = ? ORDER BY created_at, op_id`,
  )
    .bind(tenantId)
    .all<OpRowForTest>();
  return rows.results;
}

export async function tenantConnectRow(tenantId: string) {
  return env.DB.prepare(
    `SELECT connect_enabled, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled,
            stripe_details_submitted, stripe_account_synced_at, stripe_account_resync_needed,
            stripe_requirements_due_json, stripe_disabled_reason, payout_delay_days
     FROM tenants WHERE tenant_id = ?`,
  )
    .bind(tenantId)
    .first<{
      connect_enabled: number;
      payout_delay_days: number | null;
      stripe_account_id: string | null;
      stripe_account_resync_needed: number;
      stripe_account_synced_at: number | null;
      stripe_charges_enabled: number;
      stripe_details_submitted: number;
      stripe_disabled_reason: string | null;
      stripe_payouts_enabled: number;
      stripe_requirements_due_json: string | null;
    }>();
}

export async function auditActions(tenantId: string, prefix = "connect."): Promise<Array<{ action: string; actor_user_id: string; metadata_json: string | null }>> {
  const rows = await env.DB.prepare(
    `SELECT action, actor_user_id, metadata_json FROM audit_events
     WHERE tenant_id = ? AND action LIKE ? ORDER BY created_at, rowid`,
  )
    .bind(tenantId, `${prefix}%`)
    .all<{ action: string; actor_user_id: string; metadata_json: string | null }>();
  return rows.results;
}

export async function openAlertsOf(kind: string, tenantId: string) {
  const rows = await env.DB.prepare(
    "SELECT kind, severity, message, resource_type, resource_id FROM alerts WHERE kind = ? AND tenant_id = ? AND resolved_at IS NULL",
  )
    .bind(kind, tenantId)
    .all<{ kind: string; message: string; resource_id: string; resource_type: string; severity: string }>();
  return rows.results;
}

/** A reserved operation written directly — an operation some EARLIER request left behind. */
export async function seedReservedOp(
  shop: ConnectShop,
  options: { accountsApi?: ConnectAccountsApi; createdAtMs: number; leaseExpiresAtMs: number | null; opId?: string },
): Promise<string> {
  const opId = options.opId ?? crypto.randomUUID();
  const created = new Date(options.createdAtMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO connect_onboarding_ops (
       op_id, tenant_id, state, accounts_api, business_name, attempts, lease_expires_at,
       created_by, created_at, updated_at
     ) VALUES (?, ?, 'reserved', ?, NULL, 1, ?, ?, ?, ?)`,
  )
    .bind(
      opId,
      shop.tenantId,
      options.accountsApi ?? "v1",
      options.leaseExpiresAtMs === null ? null : new Date(options.leaseExpiresAtMs).toISOString(),
      shop.adminUserId,
      created,
      created,
    )
    .run();
  return opId;
}

/** Lets a held lease run out (what 90 s of wall clock would do). */
export async function expireLease(opId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE connect_onboarding_ops SET lease_expires_at = created_at WHERE op_id = ? AND state = 'reserved'",
  )
    .bind(opId)
    .run();
}

/** Every key, at any depth, of a JSON body. */
export function keysDeep(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => keysDeep(entry, into));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      keysDeep(entry, into);
    }
  }
  return into;
}

export async function jsonOf<T>(response: Response, status: number, label: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${label}: ${text.slice(0, 400)}`).toBe(status);
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}
