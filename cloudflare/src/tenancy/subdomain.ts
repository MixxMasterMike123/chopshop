import {
  auditMetadataJson,
  type PlatformPrincipal,
  type TenantAdminPrincipal,
} from "../auth/live-authorization";
import { isShopSegment } from "./shop-hostname";

/**
 * CP14 — a shop's platform subdomain, `<label>.<PLATFORM_SHOP_DOMAIN>`
 * (docs/cf-port/CP14_SUBDOMAINS_REPORT.md).
 *
 * The LABEL is the shop's own choice (tenants.subdomain_label, 0061), separate
 * from its id. The HOSTNAME it gives is an ordinary verified storefront row of
 * tenant_domains, so the API keeps ONE tenant rule: a tenant resolves only from
 * a verified hostname (resolve-tenant.ts). Changing the label writes the new
 * row and RETIRES the old one: `redirect_until` = now + SUBDOMAIN_GRACE_MS.
 * Until then the old hostname still resolves (an open tab keeps working) and
 * the web Worker 301s its pages to the canonical one; after it, the old
 * hostname resolves to nothing and another shop may claim the label.
 *
 * `PLATFORM_SHOP_DOMAIN` absent (or not a hostname) ⇒ the feature is off: no
 * label can be set, no hostname is written at creation, nothing redirects.
 */

export const SUBDOMAIN_LABEL_MAX_LENGTH = 63;
/** The hostname-label rule of src/platform/provision-tenants.ts, verbatim. */
export const SUBDOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** How long a retired platform hostname keeps resolving and redirecting. */
export const SUBDOMAIN_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

/** Labels that can never be a shop's: the platform's own hosts and the usual service names. */
export const RESERVED_SUBDOMAIN_LABELS: readonly string[] = [
  "admin",
  "api",
  "cdn",
  "dev",
  "docs",
  "ftp",
  "help",
  "imap",
  "img",
  "mail",
  "mta",
  "ns1",
  "ns2",
  "pop",
  "smtp",
  "stg",
  "staging",
  "static",
  "status",
  "support",
  "test",
  "www",
];

const RESERVED = new Set(RESERVED_SUBDOMAIN_LABELS);
const HOSTNAME_MAX_LENGTH = 253;

export type LabelCheck =
  | { label: string; status: "ok" }
  /** Not a hostname label (characters, a leading/trailing '-', length, an `xn--` label). */
  | { status: "invalid" }
  | { status: "reserved" };

/**
 * A label as typed, checked. Never lowercased or trimmed here: what is stored
 * is exactly what was sent, so the client lowercases (and says so) before it
 * sends. `xn--` (punycode) labels are refused: they spell look-alikes of other
 * names.
 */
export function checkSubdomainLabel(value: unknown): LabelCheck {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > SUBDOMAIN_LABEL_MAX_LENGTH ||
    !SUBDOMAIN_LABEL_PATTERN.test(value) ||
    value.startsWith("xn--")
  ) {
    return { status: "invalid" };
  }
  return RESERVED.has(value) ? { status: "reserved" } : { label: value, status: "ok" };
}

/** The label a new shop starts with: its id when the id passes the rules, else none. */
export function defaultSubdomainLabel(tenantId: string): string | null {
  const check = checkSubdomainLabel(tenantId);
  return check.status === "ok" ? check.label : null;
}

/**
 * `PLATFORM_SHOP_DOMAIN`, or null (the feature is off): a lowercase hostname of
 * at least two labels, each passing the label pattern. Anything else is off,
 * never a guess.
 */
export function parsePlatformShopDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 3 || value.length > 200) {
    return null;
  }
  const labels = value.split(".");
  return labels.length >= 2 &&
    labels.every(
      (label) => label.length <= SUBDOMAIN_LABEL_MAX_LENGTH && SUBDOMAIN_LABEL_PATTERN.test(label),
    )
    ? value
    : null;
}

export function readPlatformShopDomain(env: Env): string | null {
  return parsePlatformShopDomain(env.PLATFORM_SHOP_DOMAIN);
}

/** `<label>.<base>`, or null when that is longer than a hostname may be. */
export function platformHostname(label: string, base: string): string | null {
  const hostname = `${label}.${base}`;
  return hostname.length <= HOSTNAME_MAX_LENGTH ? hostname : null;
}

/** The label of `hostname` when it is exactly one label under `base`, else null. */
export function labelOfPlatformHostname(hostname: string, base: string): string | null {
  const suffix = `.${base}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const label = hostname.slice(0, -suffix.length);
  return label.length > 0 && label.length <= SUBDOMAIN_LABEL_MAX_LENGTH && SUBDOMAIN_LABEL_PATTERN.test(label)
    ? label
    : null;
}

// ── the view ────────────────────────────────────────────────────────────────

export interface SubdomainView {
  /** PLATFORM_SHOP_DOMAIN; null = the feature is off (then everything is null/empty). */
  baseDomain: string | null;
  /** `<label>.<baseDomain>`, or null. */
  hostname: string | null;
  label: string | null;
  /** Retired platform hostnames still redirecting, with the ISO time they stop. */
  previous: Array<{ hostname: string; redirectUntil: string }>;
}

const OFF_VIEW: SubdomainView = { baseDomain: null, hostname: null, label: null, previous: [] };

/** The shop's subdomain as its admin and the platform see it; null when the tenant does not exist. */
export async function readSubdomainView(
  db: D1Database,
  tenantId: string,
  base: string | null,
  now: number,
): Promise<SubdomainView | null> {
  const tenant = await db
    .prepare("SELECT subdomain_label FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ subdomain_label: string | null }>();
  if (tenant === null) {
    return null;
  }
  if (base === null) {
    return OFF_VIEW;
  }

  const retired = await db
    .prepare(
      `SELECT hostname, redirect_until
       FROM tenant_domains
       WHERE tenant_id = ? AND redirect_until IS NOT NULL AND redirect_until > ?
       ORDER BY redirect_until DESC, hostname`,
    )
    .bind(tenantId, now)
    .all<{ hostname: string; redirect_until: number }>();

  const label = tenant.subdomain_label;
  return {
    baseDomain: base,
    hostname: label === null ? null : platformHostname(label, base),
    label,
    previous: retired.results
      .filter((row) => labelOfPlatformHostname(row.hostname, base) !== null)
      .map((row) => ({
        hostname: row.hostname,
        redirectUntil: new Date(row.redirect_until).toISOString(),
      })),
  };
}

// ── the write ───────────────────────────────────────────────────────────────

export type SetSubdomainResult =
  | { changed: boolean; status: "ok"; view: SubdomainView }
  | { status: "invalid" | "reserved" }
  /** Another shop holds the label, or its hostname (a row in grace, a domain added by hand). */
  | { status: "taken" }
  | { status: "not_found" }
  /** The shop is closed, or a concurrent change moved the label first. */
  | { status: "conflict" };

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

function auditJson(
  principal: PlatformPrincipal | TenantAdminPrincipal,
  metadata: Record<string, unknown>,
): string | null {
  return principal.accountType === "tenant_admin"
    ? auditMetadataJson(principal, metadata)
    : JSON.stringify(metadata);
}

/**
 * Sets (or changes) the shop's label. `base` must be non-null (the caller
 * answers "off" before calling).
 *
 *   same label as now        the hostname row is made sure of (inserted when
 *                            missing, restored to a live verified storefront
 *                            row when retired or disabled); changed: false
 *   a new label              the new hostname becomes the shop's (inserted
 *                            verified, or restored when the shop held it
 *                            before), every other live platform hostname of
 *                            the shop is retired for SUBDOMAIN_GRACE_MS;
 *                            audited `tenant.subdomain_set`
 *   the shop's own row of the hostname is not a storefront row → conflict,
 *   nothing written (Codex P2 on b7a1112d)
 *
 * TWO STEPS (Codex P2 on b7a1112d: the follow-ups must hang on THIS request's
 * own write, not on the label they find):
 *   1. the label UPDATE alone, guarded by the label as read and an open shop.
 *      0 rows → conflict (another request moved the label first); the unique
 *      index refusing it → taken. Either way NOTHING was written.
 *   2. the batch: free ANOTHER shop's expired row of the hostname, retire this
 *      shop's other live platform hostnames, restore or insert the hostname,
 *      audit — each guarded by the label being the new one. Its INSERT failing
 *      on the unique hostname (another shop's live row appeared in between) →
 *      the label is put back (guarded) and the answer is taken.
 * Safe between the steps: a crash after step 1 leaves the label set and its
 * row missing, while the previous platform hostname is still live, so nothing
 * resolves wrongly (the shop still resolves on its old address and nothing
 * redirects to the missing one: canonicalPlatformHostname needs the row). The
 * next identical write takes the "same label, row missing" path and completes
 * it, retiring the old hostname then (step 2 retires every other live platform
 * hostname, not only the one read as previous).
 */
/** One label under the base: ends with ".<base>" and holds no other dot before it. Binds: base, base. */
const onePlatformLabel = `hostname LIKE '%.' || ? AND instr(substr(hostname, 1, length(hostname) - length(?) - 1), '.') = 0`;

export async function setSubdomainLabel(
  db: D1Database,
  principal: PlatformPrincipal | TenantAdminPrincipal,
  tenantId: string,
  value: unknown,
  base: string,
  now: number,
): Promise<SetSubdomainResult> {
  const check = checkSubdomainLabel(value);
  if (check.status !== "ok") {
    return { status: check.status };
  }
  const label = check.label;
  const hostname = platformHostname(label, base);
  if (hostname === null) {
    return { status: "invalid" };
  }

  const tenant = await db
    .prepare("SELECT status, subdomain_label FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ status: string; subdomain_label: string | null }>();
  if (tenant === null) {
    return { status: "not_found" };
  }
  if (tenant.status === "closed") {
    return { status: "conflict" };
  }

  const previous = tenant.subdomain_label;
  const previousHostname = previous === null ? null : platformHostname(previous, base);
  const holders = await db
    .prepare(
      `SELECT 'label' AS what, tenant_id, NULL AS redirect_until
       FROM tenants WHERE subdomain_label = ? AND tenant_id <> ?
       UNION ALL
       SELECT 'hostname', tenant_id, redirect_until
       FROM tenant_domains WHERE hostname = ? AND tenant_id <> ?`,
    )
    .bind(label, tenantId, hostname, tenantId)
    .all<{ redirect_until: number | null; tenant_id: string; what: string }>();
  const taken = holders.results.some(
    (row) => row.what === "label" || row.redirect_until === null || row.redirect_until > now,
  );
  if (taken) {
    return { status: "taken" };
  }

  const own = await db
    .prepare(
      "SELECT kind, status, redirect_until FROM tenant_domains WHERE hostname = ? AND tenant_id = ? LIMIT 1",
    )
    .bind(hostname, tenantId)
    .first<{ kind: string; redirect_until: number | null; status: string }>();
  if (own !== null && own.kind !== "storefront") {
    return { status: "conflict" };
  }
  const changed = previous !== label;
  const ownLive = own !== null && own.redirect_until === null && own.status === "verified";
  // The shop's OTHER live platform hostnames (one label under the base,
  // storefront, not retired). Normally none; one is left when an A→B change
  // died between its two steps while B already existed as a live alias
  // (Codex P2 on 9445da34): the label already reads B and B's row is live, so
  // only this tells that A still waits to be retired (and the change audited).
  const others = await db
    .prepare(
      `SELECT hostname FROM tenant_domains
       WHERE tenant_id = ? AND hostname <> ? AND kind = 'storefront'
         AND redirect_until IS NULL AND ${onePlatformLabel}
       ORDER BY hostname`,
    )
    .bind(tenantId, hostname, base, base)
    .all<{ hostname: string }>();
  const otherLive = others.results.map((row) => row.hostname);
  // Nothing left to do only when the row is live AND nothing else is.
  // Otherwise step 2 runs: it retires the others and audits. Its audit then
  // says `from` = the label as read (B, on such a retry) and names the
  // hostnames it retires in `retiredHostnames`.
  if (!changed && ownLive && otherLive.length === 0) {
    const view = await readSubdomainView(db, tenantId, base, now);
    return view === null ? { status: "not_found" } : { changed: false, status: "ok", view };
  }

  // ── step 1: this request's own guarded write, alone ──────────────────────
  try {
    const moved = await db
      .prepare(
        `UPDATE tenants
         SET subdomain_label = ?, updated_at = MAX(updated_at, ?)
         WHERE tenant_id = ? AND subdomain_label IS ? AND status <> 'closed'`,
      )
      .bind(label, now, tenantId, previous)
      .run();
    if ((moved.meta.changes ?? 0) === 0) {
      return { status: "conflict" };
    }
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "taken" };
    }
    throw error;
  }

  // ── step 2: the rows and the audit, guarded by the label being the new one ─
  const isNow = "EXISTS (SELECT 1 FROM tenants WHERE tenant_id = ? AND subdomain_label = ?)";
  const redirectUntil = now + SUBDOMAIN_GRACE_MS;
  const retiring = changed && previousHostname !== null ? previousHostname : null;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM tenant_domains
         WHERE hostname = ? AND tenant_id <> ?
           AND redirect_until IS NOT NULL AND redirect_until <= ?`,
      )
      .bind(hostname, tenantId, now),
    db
      .prepare(
        `UPDATE tenant_domains
         SET redirect_until = ?, updated_at = MAX(updated_at, ?)
         WHERE tenant_id = ? AND hostname <> ? AND kind = 'storefront'
           AND redirect_until IS NULL AND ${onePlatformLabel} AND ${isNow}`,
      )
      .bind(redirectUntil, now, tenantId, hostname, base, base, tenantId, label),
    db
      .prepare(
        `UPDATE tenant_domains
         SET redirect_until = NULL, status = 'verified', verified_at = COALESCE(verified_at, ?),
             updated_at = MAX(updated_at, ?)
         WHERE hostname = ? AND tenant_id = ? AND kind = 'storefront'
           AND (redirect_until IS NOT NULL OR status <> 'verified') AND ${isNow}`,
      )
      .bind(now, now, hostname, tenantId, tenantId, label),
    db
      .prepare(
        `INSERT INTO tenant_domains (
           domain_id, tenant_id, hostname, kind, status, verified_at, created_at, updated_at
         )
         SELECT ?, ?, ?, 'storefront', 'verified', ?, ?, ?
         WHERE ${isNow}
           AND NOT EXISTS (SELECT 1 FROM tenant_domains WHERE hostname = ? AND tenant_id = ?)`,
      )
      .bind(crypto.randomUUID(), tenantId, hostname, now, now, now, tenantId, label, hostname, tenantId),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 'tenant.subdomain_set', 'tenant', ?, ?, ?, ?
         WHERE ${isNow}`,
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        principal.userId,
        tenantId,
        crypto.randomUUID(),
        auditJson(principal, {
          from: previous,
          hostname,
          label,
          retiredHostname: retiring,
          retiredHostnames: otherLive,
          ...(retiring === null ? {} : { redirectUntil: new Date(redirectUntil).toISOString() }),
        }),
        now,
        tenantId,
        label,
      ),
  ];

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      // Another shop's live row of the hostname appeared after the check: the
      // batch wrote nothing; put the label back (only if it is still ours).
      await db
        .prepare(
          `UPDATE tenants SET subdomain_label = ?, updated_at = MAX(updated_at, ?)
           WHERE tenant_id = ? AND subdomain_label = ?`,
        )
        .bind(previous, now, tenantId, label)
        .run();
      return { status: "taken" };
    }
    throw error;
  }
  // The audit row is the last statement: written exactly when the label was
  // still the new one, i.e. when the batch did its work.
  if ((results[4]?.meta.changes ?? 0) === 0) {
    return { status: "conflict" };
  }

  const view = await readSubdomainView(db, tenantId, base, now);
  return view === null ? { status: "not_found" } : { changed, status: "ok", view };
}

// ── the web Worker's question (over the service binding only) ───────────────

export type CanonicalHostTarget = { hostname: string } | { shop: string };

/**
 * Where the web Worker should send a storefront page request, or null (serve
 * it where it is). Reached only through `Internal.canonicalShopHost` — a
 * browser cannot call it, and it answers a hostname, never a tenant.
 *
 *   { shop }      the shared host's `/<shop>/…`: the shop's canonical platform
 *                 hostname when it has a label whose row is verified and live
 *                 and the shop is active
 *   { hostname }  a platform hostname the shop moved away from (retired, still
 *                 in grace): the shop's canonical platform hostname, as above
 */
export async function canonicalPlatformHostname(
  db: D1Database,
  base: string | null,
  target: unknown,
  now: number,
): Promise<string | null> {
  if (base === null || typeof target !== "object" || target === null) {
    return null;
  }

  const canonicalOf = `
    SELECT tenant.subdomain_label AS label
    FROM tenants AS tenant
    INNER JOIN tenant_domains AS domain
      ON domain.tenant_id = tenant.tenant_id
     AND domain.hostname = tenant.subdomain_label || '.' || ?
    WHERE tenant.tenant_id = ?
      AND tenant.status = 'active'
      AND domain.kind = 'storefront'
      AND domain.status = 'verified'
      AND domain.redirect_until IS NULL
    LIMIT 1`;

  let tenantId: string | null = null;
  let from: string | null = null;
  if ("shop" in target && typeof target.shop === "string") {
    tenantId = isShopSegment(target.shop) ? target.shop : null;
  } else if ("hostname" in target && typeof target.hostname === "string") {
    from = target.hostname;
    if (labelOfPlatformHostname(from, base) === null) {
      return null;
    }
    const retired = await db
      .prepare(
        `SELECT tenant_id FROM tenant_domains
         WHERE hostname = ? AND status = 'verified'
           AND redirect_until IS NOT NULL AND redirect_until > ?
         LIMIT 1`,
      )
      .bind(from, now)
      .first<{ tenant_id: string }>();
    tenantId = retired?.tenant_id ?? null;
  }
  if (tenantId === null) {
    return null;
  }

  const row = await db.prepare(canonicalOf).bind(base, tenantId).first<{ label: string }>();
  const canonical = row === null ? null : platformHostname(row.label, base);
  return canonical === from ? null : canonical;
}
