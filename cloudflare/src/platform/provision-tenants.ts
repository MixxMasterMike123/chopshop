import type { PlatformPrincipal } from "../auth/live-authorization";

export interface ProvisionedTenant {
  defaultCurrency: string;
  defaultLocale: string;
  shopName: string;
  status: TenantStatus;
  tenantId: string;
}

export interface ProvisionedDomain {
  domainId: string;
  hostname: string;
  kind: DomainKind;
  status: "verified";
}

export interface ProvisionedMembership {
  membershipId: string;
  role: "admin";
  status: "active";
  tenantId: string;
  userId: string;
}

export type TenantStatus = "active" | "suspended";
export type DomainKind = "storefront" | "admin";

export type TenantResult =
  | { status: "ok"; tenant: ProvisionedTenant }
  | { status: "conflict" | "not_found" };

export type DomainResult =
  | { domain: ProvisionedDomain; status: "ok" }
  | { status: "conflict" | "not_found" };

export type MembershipResult =
  | { membership: ProvisionedMembership; status: "ok" }
  | { status: "conflict" | "not_found" };

export interface CreateTenantInput {
  defaultCurrency: string;
  defaultLocale: string;
  hostname: string;
  shopName: string;
  tenantId: string;
}

export interface AddDomainInput {
  hostname: string;
  kind: DomainKind;
}

export interface GrantAdminInput {
  userId: string;
}

const CREATE_TENANT_KEYS = [
  "defaultCurrency",
  "defaultLocale",
  "hostname",
  "shopName",
  "tenantId",
] as const;
const ADD_DOMAIN_KEYS = ["hostname", "kind"] as const;
const GRANT_ADMIN_KEYS = ["userId"] as const;
const DOMAIN_KINDS: DomainKind[] = ["storefront", "admin"];

const TENANT_ID_MAX_LENGTH = 64;
const SHOP_NAME_MAX_LENGTH = 200;
const USER_ID_MAX_LENGTH = 128;
const HOSTNAME_MAX_LENGTH = 253;
const HOSTNAME_LABEL_MAX_LENGTH = 63;

// A tenant id is a stable storage key that ends up in URLs, audit rows and
// foreign keys, so it stays in a narrow lowercase alphabet: no dots (which
// would read as a hostname), no uppercase (which would make two ids collide
// on a case-insensitive comparison) and no leading hyphen (which reads as a
// flag to command-line tooling).
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const LOCALE_PATTERN = /^[a-z]{2}-[A-Z]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const DEFAULT_LOCALE = "sv-SE";
const DEFAULT_CURRENCY = "SEK";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function parseTenantId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= TENANT_ID_MAX_LENGTH &&
    TENANT_ID_PATTERN.test(value)
    ? value
    : null;
}

function parseShopName(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= SHOP_NAME_MAX_LENGTH
    ? value
    : null;
}

function parseUserId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= USER_ID_MAX_LENGTH
    ? value
    : null;
}

function parseLocale(value: unknown): string | null {
  if (value === undefined) {
    return DEFAULT_LOCALE;
  }
  return typeof value === "string" && LOCALE_PATTERN.test(value) ? value : null;
}

function parseCurrency(value: unknown): string | null {
  if (value === undefined) {
    return DEFAULT_CURRENCY;
  }
  return typeof value === "string" && CURRENCY_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Hostnames are normalized to lowercase with the trailing root dot removed,
 * then validated label by label. The domain table stores hostnames as a unique
 * lookup key, so a value that only differs in case or trailing dot must never
 * become a second row pointing at a different tenant.
 */
function parseHostname(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (hostname.length < 1 || hostname.length > HOSTNAME_MAX_LENGTH) {
    return null;
  }

  const labels = hostname.split(".");
  const valid = labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= HOSTNAME_LABEL_MAX_LENGTH &&
      HOSTNAME_LABEL_PATTERN.test(label),
  );

  return valid ? hostname : null;
}

function parseDomainKind(value: unknown): DomainKind | null {
  return typeof value === "string" && (DOMAIN_KINDS as string[]).includes(value)
    ? (value as DomainKind)
    : null;
}

export function parseCreateTenantInput(body: unknown): CreateTenantInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CREATE_TENANT_KEYS)) {
    return null;
  }

  const tenantId = parseTenantId(body.tenantId);
  const shopName = parseShopName(body.shopName);
  const hostname = parseHostname(body.hostname);
  const defaultLocale = parseLocale(body.defaultLocale);
  const defaultCurrency = parseCurrency(body.defaultCurrency);

  if (
    tenantId === null ||
    shopName === null ||
    hostname === null ||
    defaultLocale === null ||
    defaultCurrency === null
  ) {
    return null;
  }

  return { defaultCurrency, defaultLocale, hostname, shopName, tenantId };
}

export function parseAddDomainInput(body: unknown): AddDomainInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ADD_DOMAIN_KEYS)) {
    return null;
  }

  const hostname = parseHostname(body.hostname);
  const kind = parseDomainKind(body.kind);

  return hostname === null || kind === null ? null : { hostname, kind };
}

export function parseGrantAdminInput(body: unknown): GrantAdminInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, GRANT_ADMIN_KEYS)) {
    return null;
  }

  const userId = parseUserId(body.userId);
  return userId === null ? null : { userId };
}

export function parseTenantIdPathSegment(segment: string): string | null {
  return parseTenantId(segment);
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

function auditStatement(
  db: D1Database,
  principal: PlatformPrincipal,
  action: string,
  tenantId: string,
  resourceType: string,
  resourceId: string,
  now: number,
  metadata: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        event_id, tenant_id, actor_user_id, action, resource_type,
        resource_id, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      tenantId,
      principal.userId,
      action,
      resourceType,
      resourceId,
      crypto.randomUUID(),
      metadata === null ? null : JSON.stringify(metadata),
      now,
    );
}

function domainStatement(
  db: D1Database,
  domainId: string,
  tenantId: string,
  hostname: string,
  kind: DomainKind,
  now: number,
): D1PreparedStatement {
  // The platform operator is the verification authority at this stage: a
  // domain it provisions is trusted on creation. DNS-proof verification gets
  // its own checkpoint, and will downgrade this default to 'pending'.
  return db
    .prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, verified_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)`,
    )
    .bind(domainId, tenantId, hostname, kind, now, now, now);
}

async function loadActiveTenant(
  db: D1Database,
  tenantId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT tenant_id
       FROM tenants
       WHERE tenant_id = ?
         AND status = 'active'
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ tenant_id: string }>();

  return row !== null;
}

export async function createTenant(
  db: D1Database,
  principal: PlatformPrincipal,
  input: CreateTenantInput,
  now: number,
): Promise<TenantResult> {
  const domainId = crypto.randomUUID();

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO tenants (
            tenant_id, status, shop_name, default_locale, default_currency,
            created_at, updated_at
          ) VALUES (?, 'active', ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.tenantId,
          input.shopName,
          input.defaultLocale,
          input.defaultCurrency,
          now,
          now,
        ),
      domainStatement(
        db,
        domainId,
        input.tenantId,
        input.hostname,
        "storefront",
        now,
      ),
      auditStatement(
        db,
        principal,
        "tenant.provision",
        input.tenantId,
        "tenant",
        input.tenantId,
        now,
        { hostname: input.hostname },
      ),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    status: "ok",
    tenant: {
      defaultCurrency: input.defaultCurrency,
      defaultLocale: input.defaultLocale,
      shopName: input.shopName,
      status: "active",
      tenantId: input.tenantId,
    },
  };
}

export async function addTenantDomain(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  input: AddDomainInput,
  now: number,
): Promise<DomainResult> {
  if (!(await loadActiveTenant(db, tenantId))) {
    return { status: "not_found" };
  }

  const domainId = crypto.randomUUID();

  try {
    await db.batch([
      domainStatement(db, domainId, tenantId, input.hostname, input.kind, now),
      auditStatement(
        db,
        principal,
        "tenant.domain_add",
        tenantId,
        "tenant_domain",
        domainId,
        now,
        { hostname: input.hostname },
      ),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    domain: {
      domainId,
      hostname: input.hostname,
      kind: input.kind,
      status: "verified",
    },
    status: "ok",
  };
}

export async function setTenantStatus(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  status: TenantStatus,
  now: number,
): Promise<TenantResult> {
  const existing = await db
    .prepare(
      `SELECT tenant_id, shop_name, default_locale, default_currency
       FROM tenants
       WHERE tenant_id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{
      default_currency: string;
      default_locale: string;
      shop_name: string | null;
      tenant_id: string;
    }>();

  if (existing === null) {
    return { status: "not_found" };
  }

  // Idempotent by construction: the same status written twice is a no-op row
  // update, and the audit trail still records that the operator asked for it.
  await db.batch([
    db
      .prepare(
        `UPDATE tenants
         SET status = ?, updated_at = ?
         WHERE tenant_id = ?`,
      )
      .bind(status, now, tenantId),
    auditStatement(
      db,
      principal,
      status === "active" ? "tenant.activate" : "tenant.suspend",
      tenantId,
      "tenant",
      tenantId,
      now,
      null,
    ),
  ]);

  return {
    status: "ok",
    tenant: {
      defaultCurrency: existing.default_currency,
      defaultLocale: existing.default_locale,
      shopName: existing.shop_name ?? "",
      status,
      tenantId,
    },
  };
}

export async function grantTenantAdmin(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  input: GrantAdminInput,
  now: number,
): Promise<MembershipResult> {
  if (!(await loadActiveTenant(db, tenantId))) {
    return { status: "not_found" };
  }

  const user = await db
    .prepare('SELECT "id" FROM "user" WHERE "id" = ? LIMIT 1')
    .bind(input.userId)
    .first<{ id: string }>();

  if (user === null) {
    return { status: "not_found" };
  }

  const access = await db
    .prepare(
      `SELECT account_type, status
       FROM identity_access
       WHERE user_id = ?
       LIMIT 1`,
    )
    .bind(input.userId)
    .first<{ account_type: string; status: string }>();

  // One account kind per identity. A grant may create a tenant admin, but it
  // must never convert another kind, and it must never silently re-enable an
  // identity that was explicitly suspended or revoked.
  if (
    access !== null &&
    (access.account_type !== "tenant_admin" || access.status !== "active")
  ) {
    return { status: "conflict" };
  }

  const existingMembership = await db
    .prepare(
      `SELECT membership_id, status
       FROM tenant_memberships
       WHERE tenant_id = ?
         AND user_id = ?
         AND role = 'admin'
       LIMIT 1`,
    )
    .bind(tenantId, input.userId)
    .first<{ membership_id: string; status: string }>();

  if (existingMembership !== null) {
    if (existingMembership.status !== "active") {
      return { status: "conflict" };
    }

    return {
      membership: {
        membershipId: existingMembership.membership_id,
        role: "admin",
        status: "active",
        tenantId,
        userId: input.userId,
      },
      status: "ok",
    };
  }

  const membershipId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];

  if (access === null) {
    // Plain INSERT, never an upsert: user_id is the primary key, so a racing
    // grant makes this batch fail loudly instead of overwriting an account
    // kind that was decided somewhere else.
    statements.push(
      db
        .prepare(
          `INSERT INTO identity_access (
            user_id, account_type, status, created_at, updated_at
          ) VALUES (?, 'tenant_admin', 'active', ?, ?)`,
        )
        .bind(input.userId, now, now),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO tenant_memberships (
          membership_id, tenant_id, user_id, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
      )
      .bind(membershipId, tenantId, input.userId, now, now),
    auditStatement(
      db,
      principal,
      "tenant.admin_grant",
      tenantId,
      "tenant_membership",
      membershipId,
      now,
      null,
    ),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    membership: {
      membershipId,
      role: "admin",
      status: "active",
      tenantId,
      userId: input.userId,
    },
    status: "ok",
  };
}
