import type { PlatformPrincipal } from "../auth/live-authorization";
import { decodeSegment } from "../lib/responses";
import { parseAddDomainInput } from "./provision-tenants";
import {
  guardedPlatformAudit,
  hasOnlyKeys,
  isoFromMs,
  isPlainObject,
  readTenantStatus,
  TENANT_OPEN_GUARD,
  type TenantStatus,
} from "./tenant-config";

/**
 * CP3-A — the platform's hostname operations on `tenant_domains` (0001):
 * list, lookup, disable / enable, delete, and move to another tenant.
 *
 * Adding a domain stays the older POST /v1/platform/tenants/:id/domains
 * (src/platform/provision-tenants.ts). Every write here is audited in the same
 * batch as the change, and every audit row is guarded by the exact pre-state
 * the route read, so a concurrent change makes the batch write nothing (409)
 * instead of recording something that did not happen.
 *
 * Resolution (src/tenancy/resolve-tenant.ts) serves a hostname only while its
 * row is `verified` AND its tenant is `active`, so `disabled` stops a hostname
 * resolving on the next request.
 */

export type DomainStatus = "disabled" | "pending" | "verified";

export interface DomainView {
  createdAt: string;
  domainId: string;
  hostname: string;
  kind: string;
  status: DomainStatus;
  updatedAt: string;
  verifiedAt: string | null;
}

export interface HostnameHolder extends DomainView {
  /** Would a storefront request for this hostname resolve right now? */
  resolves: boolean;
  tenantId: string;
  tenantStatus: TenantStatus;
}

interface DomainRow {
  created_at: number;
  domain_id: string;
  hostname: string;
  kind: string;
  status: DomainStatus;
  tenant_id: string;
  updated_at: number;
  verified_at: number | null;
}

const DOMAIN_COLUMNS =
  "domain_id, tenant_id, hostname, kind, status, verified_at, created_at, updated_at";

export const DOMAIN_LIST_LIMIT = 100;
const MAX_DOMAIN_LIST_LIMIT = 100;
const DOMAIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MOVE_KEYS = ["hostname", "toTenantId"] as const;
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function toView(row: DomainRow): DomainView {
  return {
    createdAt: isoFromMs(row.created_at) as string,
    domainId: row.domain_id,
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
    updatedAt: isoFromMs(row.updated_at) as string,
    verifiedAt: isoFromMs(row.verified_at),
  };
}

/**
 * A hostname normalised and validated by exactly the rule the add-domain route
 * stores with (lowercase, no trailing dot, label grammar), so a lookup or a
 * move can never miss a row over case or a trailing dot. Reuses that parser
 * rather than a copy that could drift.
 */
export function parseHostname(value: unknown): string | null {
  return parseAddDomainInput({ hostname: value, kind: "storefront" })?.hostname ?? null;
}

/** A domain id path segment (decoded once), or null. */
export function parseDomainIdSegment(raw: string): string | null {
  const decoded = decodeSegment(raw);
  return decoded !== null && DOMAIN_ID_PATTERN.test(decoded) ? decoded : null;
}

export interface DomainListQuery {
  /** Keyset cursor: the last hostname of the previous page. */
  cursor: string | null;
  limit: number;
}

export function parseDomainListQuery(url: URL): DomainListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (key !== "cursor" && key !== "limit") {
      return null;
    }
  }
  const limitRaw = params.get("limit");
  if (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) {
    return null;
  }
  const limit = limitRaw === null ? DOMAIN_LIST_LIMIT : Number(limitRaw);
  if (limit < 1 || limit > MAX_DOMAIN_LIST_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  let cursor: string | null = null;
  if (cursorRaw !== null) {
    cursor = parseHostname(cursorRaw);
    if (cursor === null) {
      return null;
    }
  }
  return { cursor, limit };
}

/** A tenant's domains ordered by hostname; `null` when the tenant does not exist. */
export async function listTenantDomains(
  db: D1Database,
  tenantId: string,
  query: DomainListQuery = { cursor: null, limit: DOMAIN_LIST_LIMIT },
): Promise<{ domains: DomainView[]; nextCursor: string | null } | null> {
  if ((await readTenantStatus(db, tenantId)) === null) {
    return null;
  }

  const rows = await db
    .prepare(
      `SELECT ${DOMAIN_COLUMNS}
       FROM tenant_domains
       WHERE tenant_id = ?
         AND (? IS NULL OR hostname > ?)
       ORDER BY hostname
       LIMIT ?`,
    )
    .bind(tenantId, query.cursor, query.cursor, query.limit + 1)
    .all<DomainRow>();

  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    domains: page.map(toView),
    nextCursor:
      rows.results.length > query.limit && last !== undefined ? last.hostname : null,
  };
}

/** Which tenant holds `hostname` (already normalised), or null when none does. */
export async function lookupHostname(
  db: D1Database,
  hostname: string,
): Promise<HostnameHolder | null> {
  const row = await db
    .prepare(
      `SELECT domain.domain_id, domain.tenant_id, domain.hostname, domain.kind,
              domain.status, domain.verified_at, domain.created_at, domain.updated_at,
              tenant.status AS tenant_status
       FROM tenant_domains AS domain
       INNER JOIN tenants AS tenant ON tenant.tenant_id = domain.tenant_id
       WHERE domain.hostname = ?
       LIMIT 1`,
    )
    .bind(hostname)
    .first<DomainRow & { tenant_status: TenantStatus }>();

  if (row === null) {
    return null;
  }
  return {
    ...toView(row),
    resolves: row.status === "verified" && row.tenant_status === "active",
    tenantId: row.tenant_id,
    tenantStatus: row.tenant_status,
  };
}

async function readTenantDomain(
  db: D1Database,
  tenantId: string,
  domainId: string,
): Promise<DomainRow | null> {
  return db
    .prepare(
      `SELECT ${DOMAIN_COLUMNS}
       FROM tenant_domains
       WHERE domain_id = ? AND tenant_id = ?
       LIMIT 1`,
    )
    .bind(domainId, tenantId)
    .first<DomainRow>();
}

export type DomainResult =
  | { domain: DomainView; status: "ok" }
  | { status: "conflict" | "not_found" };

/**
 * `disable`: verified | pending → disabled (stops resolving next request).
 * `enable`:  disabled → verified when it was ever verified (verified_at set),
 *            else back to pending. Refused (409) on a closed tenant: nothing
 *            turns back on inside a closed shop.
 * Repeating the call on a domain already in the target state answers 200 with
 * nothing written (and no audit row, since nothing changed).
 */
export async function setDomainEnabled(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  domainId: string,
  enable: boolean,
  now: number,
): Promise<DomainResult> {
  const current = await readTenantDomain(db, tenantId, domainId);
  if (current === null) {
    return { status: "not_found" };
  }

  const alreadyThere = enable ? current.status !== "disabled" : current.status === "disabled";
  if (alreadyThere) {
    return { domain: toView(current), status: "ok" };
  }

  if (enable && (await readTenantStatus(db, tenantId)) === "closed") {
    return { status: "conflict" };
  }

  const nextStatus: DomainStatus = enable
    ? current.verified_at === null
      ? "pending"
      : "verified"
    : "disabled";
  // The row exactly as read (status included) and, for enable, a tenant that
  // is still open.
  const rowGuard = enable
    ? `EXISTS (SELECT 1 FROM tenant_domains WHERE domain_id = ? AND tenant_id = ? AND status = ?)
       AND ${TENANT_OPEN_GUARD}`
    : "EXISTS (SELECT 1 FROM tenant_domains WHERE domain_id = ? AND tenant_id = ? AND status = ?)";
  const rowGuardBinds = enable
    ? [domainId, tenantId, current.status, tenantId]
    : [domainId, tenantId, current.status];

  const results = await db.batch([
    guardedPlatformAudit(
      db,
      principal,
      {
        action: enable ? "tenant.domain_enable" : "tenant.domain_disable",
        metadata: { from: current.status, hostname: current.hostname, to: nextStatus },
        resourceId: domainId,
        resourceType: "tenant_domain",
        tenantId,
      },
      now,
      rowGuard,
      rowGuardBinds,
    ),
    db
      .prepare(
        `UPDATE tenant_domains
         SET status = ?, updated_at = MAX(?, created_at)
         WHERE domain_id = ? AND tenant_id = ? AND status = ?
           ${enable ? `AND ${TENANT_OPEN_GUARD}` : ""}`,
      )
      .bind(
        nextStatus,
        now,
        domainId,
        tenantId,
        current.status,
        ...(enable ? [tenantId] : []),
      ),
  ]);

  if ((results[1]?.meta.changes ?? 0) === 0) {
    return { status: "conflict" };
  }

  const updated = await readTenantDomain(db, tenantId, domainId);
  return updated === null ? { status: "conflict" } : { domain: toView(updated), status: "ok" };
}

/**
 * Deletes one domain row, audited (hostname, kind and status recorded). Allowed
 * on any tenant, closed included: deleting is how a closed shop's hostnames
 * are freed. Nothing references tenant_domains by foreign key.
 */
export async function deleteTenantDomain(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  domainId: string,
  now: number,
): Promise<{ status: "not_found" | "ok" }> {
  const current = await readTenantDomain(db, tenantId, domainId);
  if (current === null) {
    return { status: "not_found" };
  }

  const results = await db.batch([
    guardedPlatformAudit(
      db,
      principal,
      {
        action: "tenant.domain_delete",
        metadata: { hostname: current.hostname, kind: current.kind, status: current.status },
        resourceId: domainId,
        resourceType: "tenant_domain",
        tenantId,
      },
      now,
      "EXISTS (SELECT 1 FROM tenant_domains WHERE domain_id = ? AND tenant_id = ?)",
      [domainId, tenantId],
    ),
    db
      .prepare(
        "DELETE FROM tenant_domains WHERE domain_id = ? AND tenant_id = ? RETURNING domain_id",
      )
      .bind(domainId, tenantId),
  ]);

  return (results[1]?.results.length ?? 0) === 0 ? { status: "not_found" } : { status: "ok" };
}

export interface MoveDomainInput {
  hostname: string;
  toTenantId: string;
}

export function parseMoveDomainInput(body: unknown): MoveDomainInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, MOVE_KEYS)) {
    return null;
  }
  const hostname = parseHostname(body.hostname);
  const toTenantId =
    typeof body.toTenantId === "string" && TENANT_ID_PATTERN.test(body.toTenantId)
      ? body.toTenantId
      : null;
  return hostname === null || toTenantId === null ? null : { hostname, toTenantId };
}

export type MoveDomainResult =
  | { domain: DomainView; fromTenantId: string; moved: boolean; status: "ok"; toTenantId: string }
  | { reason: "hostname_unknown" | "race" | "target_closed"; status: "conflict" }
  | { status: "not_found" };

/**
 * Moves a hostname to another tenant. `tenant_domains.tenant_id` is immutable
 * (0001 trigger), so a move is DELETE of the old row + INSERT of a new row
 * (new domain id; kind, status and verified_at carried over) in ONE batch,
 * with an audit row under EACH tenant naming both. D1 runs a batch as one
 * transaction, so a failure of any statement — the INSERT included — rolls
 * the DELETE back and the hostname stays where it was.
 *
 * The chain is keyed on the source audit row: it is written only while the
 * old row is exactly as read AND the target is still open; the other three
 * statements are each conditional on that row existing. A concurrent move,
 * delete or close therefore makes the whole batch a no-op (409 race).
 *
 *   hostname held by nobody       → 409 hostname_unknown
 *   target tenant does not exist  → 404
 *   target tenant closed          → 409 target_closed
 *   hostname already on target    → 200, moved: false, nothing written
 */
export async function moveDomain(
  db: D1Database,
  principal: PlatformPrincipal,
  input: MoveDomainInput,
  now: number,
): Promise<MoveDomainResult> {
  const current = await db
    .prepare(`SELECT ${DOMAIN_COLUMNS} FROM tenant_domains WHERE hostname = ? LIMIT 1`)
    .bind(input.hostname)
    .first<DomainRow>();
  if (current === null) {
    return { reason: "hostname_unknown", status: "conflict" };
  }

  const targetStatus = await readTenantStatus(db, input.toTenantId);
  if (targetStatus === null) {
    return { status: "not_found" };
  }
  if (targetStatus === "closed") {
    return { reason: "target_closed", status: "conflict" };
  }

  if (current.tenant_id === input.toTenantId) {
    return {
      domain: toView(current),
      fromTenantId: current.tenant_id,
      moved: false,
      status: "ok",
      toTenantId: input.toTenantId,
    };
  }

  const newDomainId = crypto.randomUUID();
  const outEventId = crypto.randomUUID();
  const metadata = {
    fromDomainId: current.domain_id,
    fromTenantId: current.tenant_id,
    hostname: current.hostname,
    kind: current.kind,
    status: current.status,
    toDomainId: newDomainId,
    toTenantId: input.toTenantId,
  };
  const chained = "EXISTS (SELECT 1 FROM audit_events WHERE event_id = ?)";

  const results = await db.batch([
    guardedPlatformAudit(
      db,
      principal,
      {
        action: "tenant.domain_move_out",
        metadata,
        resourceId: current.domain_id,
        resourceType: "tenant_domain",
        tenantId: current.tenant_id,
      },
      now,
      `EXISTS (
         SELECT 1 FROM tenant_domains
         WHERE domain_id = ? AND tenant_id = ? AND hostname = ? AND status = ?
       )
       AND ${TENANT_OPEN_GUARD}`,
      [current.domain_id, current.tenant_id, current.hostname, current.status, input.toTenantId],
      outEventId,
    ),
    guardedPlatformAudit(
      db,
      principal,
      {
        action: "tenant.domain_move_in",
        metadata,
        resourceId: newDomainId,
        resourceType: "tenant_domain",
        tenantId: input.toTenantId,
      },
      now,
      chained,
      [outEventId],
    ),
    db
      .prepare(
        `DELETE FROM tenant_domains
         WHERE domain_id = ? AND tenant_id = ? AND ${chained}`,
      )
      .bind(current.domain_id, current.tenant_id, outEventId),
    db
      .prepare(
        `INSERT INTO tenant_domains (${DOMAIN_COLUMNS})
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${chained}
         RETURNING domain_id`,
      )
      .bind(
        newDomainId,
        input.toTenantId,
        current.hostname,
        current.kind,
        current.status,
        current.verified_at,
        now,
        now,
        outEventId,
      ),
  ]);

  if ((results[3]?.results.length ?? 0) === 0) {
    return { reason: "race", status: "conflict" };
  }

  const moved = await readTenantDomain(db, input.toTenantId, newDomainId);
  if (moved === null) {
    return { reason: "race", status: "conflict" };
  }
  return {
    domain: toView(moved),
    fromTenantId: current.tenant_id,
    moved: true,
    status: "ok",
    toTenantId: input.toTenantId,
  };
}
