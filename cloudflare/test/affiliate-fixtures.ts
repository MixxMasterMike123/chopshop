import { env } from "cloudflare:workers";

import { createAuth } from "../src/auth/create-auth";
import worker from "../src/index";

/**
 * Shared fixtures for the CP13 affiliate suites (test/affiliate-*.test.ts).
 * Not a test file (no `.test.`), so vitest never runs it alone.
 *
 * Rows are written directly where a suite is about the schema or a money
 * path; the identity and route suites build their people through the real
 * routes instead (slice-harness).
 */

let counter = 0;
/** Unique across a file's whole run: D1 persists between the tests of a file. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.floor(Math.random() * 1e6)}`;
}

export function iso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

/** A Better Auth "user" row (no credential), lower-case address. */
export async function seedUser(email: string, name = "Aff Person"): Promise<string> {
  const id = nextId("user").replaceAll("-", "");
  const at = iso();
  await env.DB.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 0, NULL, ?, ?)`,
  )
    .bind(id, name, email.toLowerCase(), at, at)
    .run();
  return id;
}

export async function seedAccess(userId: string, accountType: string, status = "active"): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(userId, accountType, status, now, now)
    .run();
}

export interface AffiliateSeed {
  code: string;
  commissionBp?: number;
  currency?: string;
  discountBp?: number;
  name?: string;
  status?: string;
  tenantId: string;
  termsAccepted?: boolean;
  userId?: string;
}

/** An affiliates row (and, without `userId`, its affiliate identity). Returns its id. */
export async function seedAffiliate(seed: AffiliateSeed): Promise<{ affiliateId: string; userId: string }> {
  const userId = seed.userId ?? (await seedUser(`${nextId("aff")}@affiliate.test`));
  if (seed.userId === undefined) {
    await seedAccess(userId, "affiliate");
  }
  const affiliateId = crypto.randomUUID();
  const at = iso();
  const accepted = seed.termsAccepted ?? true;
  await env.DB.prepare(
    `INSERT INTO affiliates (
       affiliate_id, tenant_id, user_id, code, status, commission_bp, discount_bp,
       name, preferred_lang, terms_version, terms_accepted_at, currency,
       created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sv', ?, ?, ?, 'fixture', ?, ?)`,
  )
    .bind(
      affiliateId,
      seed.tenantId,
      userId,
      seed.code,
      seed.status ?? "active",
      seed.commissionBp ?? 1_500,
      seed.discountBp ?? 1_000,
      seed.name ?? "Aff Person",
      accepted ? "2026-10-22" : null,
      accepted ? at : null,
      seed.currency ?? "SEK",
      at,
      at,
    )
    .run();
  return { affiliateId, userId };
}

/** The affiliate's membership of a shop (the login's gate, design §1.1). */
export async function seedAffiliateMembership(
  tenantId: string,
  userId: string,
  status = "active",
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'affiliate', ?, ?, ?)`,
  )
    .bind(nextId("m"), tenantId, userId, status, now, now)
    .run();
}

export function featureStatement(tenantId: string, key: string, enabled: boolean): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO tenant_features (tenant_id, feature_key, enabled, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 'fixture')
     ON CONFLICT (tenant_id, feature_key) DO UPDATE SET enabled = excluded.enabled`,
  ).bind(tenantId, key, enabled ? 1 : 0, iso());
}

export async function setFeature(tenantId: string, key: string, enabled: boolean): Promise<void> {
  await featureStatement(tenantId, key, enabled).run();
}

/** The message a refused statement aborted with, or null when it ran. */
export async function refusal(statement: D1PreparedStatement): Promise<string | null> {
  try {
    await statement.run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface LedgerRow {
  affiliate_id: string;
  amount_minor: number;
  available_at: string | null;
  created_by: string;
  currency: string;
  entry_id: string;
  formula_version: number | null;
  kind: string;
  order_id: string | null;
  reason: string | null;
  ref: string;
  tenant_id: string;
}

export async function ledgerOf(affiliateId: string): Promise<LedgerRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM affiliate_ledger WHERE affiliate_id = ? ORDER BY created_at, rowid",
  )
    .bind(affiliateId)
    .all<LedgerRow>();
  return rows.results;
}

export async function ledgerOfOrder(orderId: string): Promise<LedgerRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM affiliate_ledger WHERE order_id = ? ORDER BY created_at, rowid",
  )
    .bind(orderId)
    .all<LedgerRow>();
  return rows.results;
}

export async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The buyer-field denylist an affiliate projection is walked against (design
 * §7.1, §8.9): no key anywhere may name the buyer, their contact or their
 * address, the payment's identifiers, or a platform figure.
 */
export const BUYER_FIELD_DENYLIST = [
  "email",
  "customer",
  "buyer",
  "recipient",
  "address",
  "phone",
  "name",
  "payment",
  "intent",
  "charge",
  "stripe",
  "receipt",
  "token",
  "items",
  "line",
  "sku",
  "fee",
  "withh",
  "production",
  "printer",
  "connect",
  "transfer",
] as const;

/** Every key of a JSON value, recursively. */
export function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => keysOf(entry, into));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      into.push(key);
      keysOf(inner, into);
    }
  }
  return into;
}

// ── sessions and requests (the route suites) ────────────────────────────────


export const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
export const ADMIN_HOST = "https://admin.affiliate.test";
const FIXTURE_PASSWORD = "affiliate-fixture-password-long";

export interface Person {
  cookie: string;
  email: string;
  userId: string;
}

async function drainAuthLimiter(): Promise<void> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
}

export async function signInCookie(email: string, password = FIXTURE_PASSWORD): Promise<string> {
  await drainAuthLimiter();
  const response = await worker.fetch(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
    env,
  );
  if (response.status !== 200) {
    throw new Error(`sign-in ${response.status}`);
  }
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] as string;
}

/** A signed-in person with a password and (unless null) an identity of `accountType`. */
export async function signUpPerson(email: string, accountType: string | null): Promise<Person> {
  await drainAuthLimiter();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  if (response.status !== 200) {
    throw new Error(`sign-up ${response.status}`);
  }
  const userId = (await response.json<{ user: { id: string } }>()).user.id;
  if (accountType !== null) {
    await seedAccess(userId, accountType);
  }
  return { cookie: await signInCookie(email), email, userId };
}

export async function adminMembership(tenantId: string, userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(nextId("m"), tenantId, userId, now, now)
    .run();
}

/** A shop admin of `tenantId`, signed in. */
export async function shopAdminOf(tenantId: string): Promise<Person> {
  const person = await signUpPerson(`${nextId("admin")}@shop.test`, "tenant_admin");
  await adminMembership(tenantId, person.userId);
  return person;
}

/** An affiliate of `tenantId` with a password and a portal session. */
export async function portalAffiliateOf(
  tenantId: string,
  code: string,
  options: Partial<AffiliateSeed> = {},
): Promise<Person & { affiliateId: string }> {
  const person = await signUpPerson(`${nextId("aff")}@affiliate.test`, "affiliate");
  const { affiliateId } = await seedAffiliate({ code, tenantId, userId: person.userId, ...options });
  await seedAffiliateMembership(tenantId, person.userId);
  return { ...person, affiliateId };
}

/** A request on the admin host, as `person` (or nobody), naming `shopId`. */
export function hostRequest(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; origin?: string | null; shopId?: string | null; host?: string } = {},
): Request {
  const host = options.host ?? ADMIN_HOST;
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (options.shopId !== undefined && options.shopId !== null) {
    headers.set("x-shop-id", options.shopId);
  }
  const origin = options.origin === undefined ? host : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  // GET/HEAD carry no body, whatever the caller passed (the auth-matrix loops).
  const body = method === "GET" || method === "HEAD" ? undefined : options.body;
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`${host}${path}`, {
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers,
    method,
  });
}

export interface CapturedQueue {
  queue: Queue;
  sent: unknown[];
}

export function captureQueue(): CapturedQueue {
  const sent: unknown[] = [];
  return {
    queue: {
      async send(body: unknown) {
        sent.push(body);
      },
      async sendBatch(messages: Array<{ body: unknown }>) {
        for (const message of messages) {
          sent.push(message.body);
        }
      },
    } as unknown as Queue,
    sent,
  };
}

export function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

/** A public (active, published, named) shop on a verified storefront host, its add-on as given. */
export async function seedPublicShop(tenantId: string, hostname: string, affiliateOn = true): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (tenant_id, status, published, shop_name, support_email, default_locale,
         default_currency, created_at, updated_at)
       VALUES (?, 'active', 1, ?, ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Butik ${tenantId}`, `hej@${hostname}`, now, now),
    env.DB.prepare(
      `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, now, now),
    featureStatement(tenantId, "affiliate", affiliateOn),
  ]);
}
