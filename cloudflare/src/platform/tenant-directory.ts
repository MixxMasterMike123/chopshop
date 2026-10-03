import type { PlatformPrincipal } from "../auth/live-authorization";
import { readTenantLegalView, type TenantLegalView } from "../legal/legal-pages";
import { MAX_DEFAULT_COMMISSION_BPS } from "./platform-settings";
import {
  type FeatureView,
  guardedPlatformAudit,
  hasOnlyKeys,
  isoFromMs,
  isPlainObject,
  readSettingsSummary,
  readTenantFeatures,
  readTenantStatus,
  TENANT_OPEN_GUARD,
  type TenantStatus,
} from "./tenant-config";
import { type DomainView, listTenantDomains } from "./tenant-domains";

/**
 * CP3-A — the platform's tenant directory: list, detail, edit, the go-live
 * gate (publish / unpublish) and close. PLATFORM principal only (the routes
 * check), so these views may carry what no seller surface may: the Connect
 * facts and the per-shop commission override.
 */

export const TENANT_LIST_LIMIT = 50;
const MAX_TENANT_LIST_LIMIT = 100;
/** Domains shown per tenant in the LIST (the detail and the domain route show all). */
const LIST_DOMAINS_PER_TENANT = 20;
/** D1 bound-parameter budget (PLAN §2.7): IN (…) lists are chunked. */
const IN_CHUNK = 90;
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TENANT_STATUSES: readonly TenantStatus[] = ["active", "closed", "provisioning", "suspended"];

const SHOP_NAME_MAX_LENGTH = 200;
const EMAIL_MAX_LENGTH = 254;
// The bootstrap / checkout / provision-users address rule: whitespace and
// C0/C1 control bytes refused rather than trimmed, one '@', both halves set.
const EMAIL_FORBIDDEN_PATTERN = /[\s\u0000-\u001f\u007f-\u009f]/;
const BPS_MAX = 10_000;
const CLOSE_REASON_MAX_LENGTH = 500;

export interface TenantListQuery {
  /** Keyset cursor: the last tenant id of the previous page. */
  cursor: string | null;
  limit: number;
  status: TenantStatus | null;
}

export function parseTenantListQuery(url: URL): TenantListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "limit", "status"].includes(key)) {
      return null;
    }
  }
  const limitRaw = params.get("limit");
  if (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) {
    return null;
  }
  const limit = limitRaw === null ? TENANT_LIST_LIMIT : Number(limitRaw);
  if (limit < 1 || limit > MAX_TENANT_LIST_LIMIT) {
    return null;
  }
  const cursor = params.get("cursor");
  if (cursor !== null && !TENANT_ID_PATTERN.test(cursor)) {
    return null;
  }
  const status = params.get("status");
  if (status !== null && !(TENANT_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  return { cursor, limit, status: status as TenantStatus | null };
}

export interface TenantListItem {
  domainCount: number;
  /** At most LIST_DOMAINS_PER_TENANT, ordered by hostname. */
  domains: Array<{ hostname: string; kind: string; status: string }>;
  published: boolean;
  shopName: string | null;
  status: TenantStatus;
  tenantId: string;
}

interface TenantListRow {
  published: number;
  shop_name: string | null;
  status: TenantStatus;
  tenant_id: string;
}

export async function listTenants(
  db: D1Database,
  query: TenantListQuery,
): Promise<{ nextCursor: string | null; tenants: TenantListItem[] }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (query.status !== null) {
    where.push("status = ?");
    binds.push(query.status);
  }
  if (query.cursor !== null) {
    where.push("tenant_id > ?");
    binds.push(query.cursor);
  }
  const rows = await db
    .prepare(
      `SELECT tenant_id, shop_name, status, published
       FROM tenants
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY tenant_id
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<TenantListRow>();

  const page = rows.results.slice(0, query.limit);
  const domains = new Map<string, TenantListItem["domains"]>();
  const counts = new Map<string, number>();
  for (let start = 0; start < page.length; start += IN_CHUNK) {
    const ids = page.slice(start, start + IN_CHUNK).map((row) => row.tenant_id);
    const domainRows = await db
      .prepare(
        `SELECT tenant_id, hostname, kind, status, total
         FROM (
           SELECT tenant_id, hostname, kind, status,
                  ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY hostname) AS position,
                  COUNT(*) OVER (PARTITION BY tenant_id) AS total
           FROM tenant_domains
           WHERE tenant_id IN (${ids.map(() => "?").join(", ")})
         )
         WHERE position <= ?
         ORDER BY tenant_id, hostname`,
      )
      .bind(...ids, LIST_DOMAINS_PER_TENANT)
      .all<{ hostname: string; kind: string; status: string; tenant_id: string; total: number }>();
    for (const row of domainRows.results) {
      const list = domains.get(row.tenant_id) ?? [];
      list.push({ hostname: row.hostname, kind: row.kind, status: row.status });
      domains.set(row.tenant_id, list);
      counts.set(row.tenant_id, row.total);
    }
  }

  const last = page.at(-1);
  return {
    nextCursor: rows.results.length > query.limit && last !== undefined ? last.tenant_id : null,
    tenants: page.map((row) => ({
      domainCount: counts.get(row.tenant_id) ?? 0,
      domains: domains.get(row.tenant_id) ?? [],
      published: row.published === 1,
      shopName: row.shop_name,
      status: row.status,
      tenantId: row.tenant_id,
    })),
  };
}

export interface TenantDetail {
  domains: DomainView[];
  /** True when the tenant has more domains than `domains` shows (use the domain route). */
  domainsTruncated: boolean;
  features: FeatureView[];
  /**
   * CP5-WJ: the shop's legal readiness — the checkout's own legal gate
   * (legal-pages.ts readLegalCheckoutGate: `checkoutOpen`, `readiness`, the
   * terms gate) plus who adopted the pages and accepted the terms, and when.
   */
  legal: TenantLegalView;
  settings: { returnAddressSet: boolean; vatAnswered: boolean };
  tenant: {
    catalogVersion: number;
    /** null = no override; the platform default applies. */
    commissionBps: number | null;
    connect: {
      accountId: string | null;
      chargesEnabled: boolean;
      detailsSubmitted: boolean;
      payoutsEnabled: boolean;
      syncedAt: string | null;
    };
    createdAt: string;
    defaultCurrency: string;
    defaultLocale: string;
    published: boolean;
    shopName: string | null;
    status: TenantStatus;
    supportEmail: string | null;
    tenantId: string;
    updatedAt: string;
    vatRateBp: number;
  };
}

interface TenantRow {
  catalog_version: number;
  commission_bps: number | null;
  created_at: number;
  default_currency: string;
  default_locale: string;
  published: number;
  shop_name: string | null;
  status: TenantStatus;
  stripe_account_id: string | null;
  stripe_account_synced_at: number | null;
  stripe_charges_enabled: number;
  stripe_details_submitted: number;
  stripe_payouts_enabled: number;
  support_email: string | null;
  tenant_id: string;
  updated_at: number;
  vat_rate_bp: number;
}

/** The platform's full view of one tenant, or null when it does not exist. */
export async function readTenantDetail(
  db: D1Database,
  tenantId: string,
  now: number = Date.now(),
): Promise<TenantDetail | null> {
  const row = await db
    .prepare(
      `SELECT tenant_id, status, shop_name, support_email, default_locale,
              default_currency, vat_rate_bp, commission_bps, published,
              catalog_version, stripe_account_id, stripe_charges_enabled,
              stripe_payouts_enabled, stripe_details_submitted,
              stripe_account_synced_at, created_at, updated_at
       FROM tenants
       WHERE tenant_id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantRow>();
  if (row === null) {
    return null;
  }

  const domainPage = await listTenantDomains(db, tenantId);
  return {
    domains: domainPage?.domains ?? [],
    domainsTruncated: domainPage?.nextCursor !== null && domainPage?.nextCursor !== undefined,
    features: await readTenantFeatures(db, tenantId),
    legal: await readTenantLegalView(db, tenantId, now),
    settings: await readSettingsSummary(db, tenantId),
    tenant: {
      catalogVersion: row.catalog_version,
      commissionBps: row.commission_bps,
      connect: {
        accountId: row.stripe_account_id,
        chargesEnabled: row.stripe_charges_enabled === 1,
        detailsSubmitted: row.stripe_details_submitted === 1,
        payoutsEnabled: row.stripe_payouts_enabled === 1,
        syncedAt: isoFromMs(row.stripe_account_synced_at),
      },
      createdAt: isoFromMs(row.created_at) as string,
      defaultCurrency: row.default_currency,
      defaultLocale: row.default_locale,
      published: row.published === 1,
      shopName: row.shop_name,
      status: row.status,
      supportEmail: row.support_email,
      tenantId: row.tenant_id,
      updatedAt: isoFromMs(row.updated_at) as string,
      vatRateBp: row.vat_rate_bp,
    },
  };
}

// ── edit ────────────────────────────────────────────────────────────────────

/** Present fields are written; `commissionBps: null` / `supportEmail: null` clear. */
export interface TenantPatch {
  commissionBps?: number | null;
  shopName?: string;
  supportEmail?: string | null;
  vatRateBp?: number;
}

const PATCH_KEYS = ["commissionBps", "shopName", "supportEmail", "vatRateBp"] as const;

function parseBps(value: unknown, max: number = BPS_MAX): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

function parseEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > EMAIL_MAX_LENGTH) {
    return null;
  }
  const email = value.toLowerCase();
  if (EMAIL_FORBIDDEN_PATTERN.test(email)) {
    return null;
  }
  const [local, domain, ...rest] = email.split("@");
  if (rest.length > 0 || local === undefined || domain === undefined) {
    return null;
  }
  return local.length > 0 && domain.length > 0 ? email : null;
}

/**
 * PATCH body: a non-empty subset of
 *   shopName       string, 1–200 characters, not only whitespace
 *   supportEmail   address | null (null clears)
 *   vatRateBp      integer 0–10000 (the 0009 CHECK); never null — the column
 *                  is NOT NULL with its own default and has no "override"
 *   commissionBps  integer 0–800 (D45; the 0019 CHECK allows more) | null
 *                  (null clears the override so the platform default applies)
 */
export function parseTenantPatch(body: unknown): TenantPatch | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, PATCH_KEYS) || Object.keys(body).length === 0) {
    return null;
  }

  const patch: TenantPatch = {};
  if (Object.hasOwn(body, "shopName")) {
    const value = body.shopName;
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > SHOP_NAME_MAX_LENGTH ||
      value.trim().length === 0
    ) {
      return null;
    }
    patch.shopName = value;
  }
  if (Object.hasOwn(body, "supportEmail")) {
    if (body.supportEmail === null) {
      patch.supportEmail = null;
    } else {
      const email = parseEmail(body.supportEmail);
      if (email === null) {
        return null;
      }
      patch.supportEmail = email;
    }
  }
  if (Object.hasOwn(body, "vatRateBp")) {
    const bps = parseBps(body.vatRateBp);
    if (bps === null) {
      return null;
    }
    patch.vatRateBp = bps;
  }
  if (Object.hasOwn(body, "commissionBps")) {
    if (body.commissionBps === null) {
      patch.commissionBps = null;
    } else {
      // The same cap as the platform default (D45): the price floor assumes
      // the fee is at most the 8 % BAS rate, so a shop's own commission above
      // it could make a floor-priced product impossible to check out.
      const bps = parseBps(body.commissionBps, MAX_DEFAULT_COMMISSION_BPS);
      if (bps === null) {
        return null;
      }
      patch.commissionBps = bps;
    }
  }
  return patch;
}

export type TenantWriteResult =
  | { detail: TenantDetail; status: "ok" }
  | { status: "conflict" | "not_found" };

/** Patch field → `tenants` column. Column names come only from here, never the request. */
const PATCH_COLUMNS: Record<keyof TenantPatch, string> = {
  commissionBps: "commission_bps",
  shopName: "shop_name",
  supportEmail: "support_email",
  vatRateBp: "vat_rate_bp",
};

/**
 * Writes the present fields, audited with each field's before and after. A
 * closed tenant is refused (409). A shop-name change bumps catalog_version by
 * the 0025 trigger (the storefront serves the name).
 */
export async function updateTenant(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  patch: TenantPatch,
  now: number,
): Promise<TenantWriteResult> {
  const fields = (Object.keys(PATCH_COLUMNS) as Array<keyof TenantPatch>).filter(
    (field) => patch[field] !== undefined,
  );

  const before = await db
    .prepare(
      `SELECT status, ${fields.map((field) => PATCH_COLUMNS[field]).join(", ")}
       FROM tenants WHERE tenant_id = ? LIMIT 1`,
    )
    .bind(tenantId)
    .first<Record<string, unknown> & { status: TenantStatus }>();
  if (before === null) {
    return { status: "not_found" };
  }
  if (before.status === "closed") {
    return { status: "conflict" };
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    changes[field] = { from: before[PATCH_COLUMNS[field]] ?? null, to: patch[field] };
  }

  const results = await db.batch([
    guardedPlatformAudit(
      db,
      principal,
      {
        action: "tenant.update",
        metadata: { changes },
        resourceId: tenantId,
        resourceType: "tenant",
        tenantId,
      },
      now,
      TENANT_OPEN_GUARD,
      [tenantId],
    ),
    db
      .prepare(
        `UPDATE tenants
         SET ${fields.map((field) => `${PATCH_COLUMNS[field]} = ?`).join(", ")},
             updated_at = MAX(?, created_at)
         WHERE tenant_id = ? AND status <> 'closed'`,
      )
      .bind(...fields.map((field) => patch[field]), now, tenantId),
  ]);
  if ((results[1]?.meta.changes ?? 0) === 0) {
    return { status: "conflict" };
  }

  const detail = await readTenantDetail(db, tenantId, now);
  return detail === null ? { status: "not_found" } : { detail, status: "ok" };
}

// ── the go-live gate ────────────────────────────────────────────────────────

/**
 * Writes `tenants.published`. The 0025 trigger `catalog_version_tenants_update`
 * bumps `catalog_version` INSIDE this UPDATE statement (it fires on every
 * UPDATE OF published, changed value or not), so the bump commits with the
 * flag by construction and every public read after it answers from the new
 * state: an unpublished shop's products 404 on the next request (the §2.4
 * predicate requires tenant.published = 1; D57 — Cloudflare hides the
 * catalogue, where Firebase only added noindex). Refused on a closed tenant.
 */
export async function setTenantPublished(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  published: boolean,
  now: number,
): Promise<TenantWriteResult> {
  const status = await readTenantStatus(db, tenantId);
  if (status === null) {
    return { status: "not_found" };
  }
  if (status === "closed") {
    return { status: "conflict" };
  }

  const results = await db.batch([
    guardedPlatformAudit(
      db,
      principal,
      {
        action: published ? "tenant.publish" : "tenant.unpublish",
        metadata: null,
        resourceId: tenantId,
        resourceType: "tenant",
        tenantId,
      },
      now,
      TENANT_OPEN_GUARD,
      [tenantId],
    ),
    db
      .prepare(
        `UPDATE tenants
         SET published = ?, updated_at = MAX(?, created_at)
         WHERE tenant_id = ? AND status <> 'closed'`,
      )
      .bind(published ? 1 : 0, now, tenantId),
  ]);
  if ((results[1]?.meta.changes ?? 0) === 0) {
    return { status: "conflict" };
  }

  const detail = await readTenantDetail(db, tenantId, now);
  return detail === null ? { status: "not_found" } : { detail, status: "ok" };
}

// ── close ───────────────────────────────────────────────────────────────────

/** Body: none, `{}`, or `{ "reason": "…" }` (1–500 characters, kept on the audit row). */
export function parseCloseInput(body: unknown): { reason: string | null } | null {
  if (body === undefined) {
    return { reason: null };
  }
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["reason"])) {
    return null;
  }
  if (body.reason === undefined) {
    return { reason: null };
  }
  const reason = body.reason;
  return typeof reason === "string" &&
    reason.trim().length >= 1 &&
    reason.length <= CLOSE_REASON_MAX_LENGTH
    ? { reason }
    : null;
}

/**
 * "This tenant has an order whose money could still come back into play" —
 * the close guard. One bind: the tenant id.
 *
 * DELIBERATELY STRICTER than the refund rule in src/commerce/refunds.ts
 * (requestRefund, refunds.ts:598-610, which asks "may a refund be reserved
 * NOW"). A refund decision can be retried later; a close cannot be undone —
 * after it no seller session exists and the platform has no refund route. So
 * close waits for every order that could become refundable again, not only
 * the ones refundable this minute (review round 2):
 *
 *   charged_minor − refund_succeeded_minor > 0      (columns: 0019_money.sql)
 *
 *     refund_reserved_minor is NOT subtracted: a reserved refund that has not
 *     settled can still fail at Stripe, and its reservation is then released
 *     and the balance is refundable again. Only a SUCCEEDED refund settles.
 *
 *   AND dispute_status IS NOT 'lost'                 (SQLite's null-safe
 *                                                     IS DISTINCT FROM)
 *
 *     dispute_status is Stripe's value stored as given (0019: a shape CHECK,
 *     no allowlist; no later migration changes it). Each value, decided:
 *       NULL                         no dispute: the balance is live — blocks
 *       warning_needs_response,
 *       warning_under_review         an inquiry: refundable now — blocks
 *       warning_closed               inquiry ended, no chargeback — blocks
 *       needs_response, under_review a chargeback in progress: not refundable
 *                                    now, but refundable again if the shop
 *                                    wins — blocks
 *       won, prevented               the money is back with the shop:
 *                                    refundable — blocks
 *       lost                         THE ONLY RELEASE: the chargeback returned
 *                                    the money to the buyer through the card
 *                                    network; it is gone from the shop and
 *                                    cannot be refunded (refunds.ts refuses
 *                                    it for good via disputeBlocksRefund), so
 *                                    nothing can be stranded
 *       any other (future) status    unknown — blocks (fail closed, the
 *                                    0019 / payouts.ts convention)
 */
const TENANT_HAS_REFUNDABLE_ORDER = `EXISTS (
  SELECT 1 FROM orders AS live
  WHERE live.tenant_id = ?
    AND live.charged_minor - live.refund_succeeded_minor > 0
    AND live.dispute_status IS NOT 'lost'
)`;

/**
 * A payment that can still become an order (Codex P1 on CP3-A). A buyer who
 * holds a PaymentIntent can pay it — and its success webhook can arrive — AFTER
 * the shop was closed: the webhook makes the order whatever the tenant's
 * status, and that order's refund would be stranded exactly like the ones the
 * order rule protects. So close also waits for every checkout that has an
 * intent which is not Stripe-terminal and has not become an order yet:
 *
 *   payment_intent_status   (0019; NULL = created, never heard of since)
 *     'canceled'            terminal, can never be paid — releases
 *     'succeeded'           paid; blocks until its order exists (then the
 *                           order rule takes over)
 *     anything else, NULL   payable — blocks
 *
 * The retention sweep cancels an abandoned intent after the checkout expired,
 * so a SUSPENDED shop (no new checkout can open) becomes closable on its own.
 */
const TENANT_HAS_OPEN_PAYMENT = `EXISTS (
  SELECT 1 FROM checkouts AS paying
  WHERE paying.tenant_id = ?
    AND paying.payment_intent_id IS NOT NULL
    AND paying.payment_intent_status IS NOT 'canceled'
    AND NOT EXISTS (SELECT 1 FROM orders AS made WHERE made.checkout_id = paying.checkout_id)
)`;

/** Both reasons close waits for, each taking the tenant id once. */
const TENANT_NOT_CLOSABLE = `(${TENANT_HAS_REFUNDABLE_ORDER} OR ${TENANT_HAS_OPEN_PAYMENT})`;

export type CloseTenantResult =
  | TenantWriteResult
  | { status: "open_payments" }
  | { status: "refundable_orders" };

/**
 * provisioning | active | suspended → closed, audited. `closed` is FINAL: the
 * 0032 trigger `tenants_closed_is_final` refuses any status change out of it,
 * whichever route or statement attempts it. Closing an already closed tenant
 * answers 200 with nothing written.
 *
 * Because it is final, close REFUSES (`refundable_orders`) while the tenant
 * has an order whose money could still come back into play
 * (TENANT_HAS_REFUNDABLE_ORDER: stricter than the refund rule — an open
 * dispute or an unsettled reserved refund blocks too): after close no seller
 * session exists, and the platform has no refund route of its own, so the
 * refund would be stranded. The check is inside the batch — in the audit
 * row's guard and in the UPDATE's WHERE — so an order paid between any
 * earlier read and the commit cannot slip through. A shop with live orders is
 * SUSPENDED instead (reversible; the seller can still refund once
 * reactivated). For the same reason it refuses (`open_payments`) while a
 * payment can still become an order (TENANT_HAS_OPEN_PAYMENT).
 *
 * Closing stops the storefront (resolution needs an active tenant), every
 * tenant-admin session and every acting-as grant on the next request, and
 * bumps catalog_version (0025 trigger on status). Hostnames stay held by the
 * closed tenant until the platform moves or deletes them.
 */
export async function closeTenant(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  input: { reason: string | null },
  now: number,
): Promise<CloseTenantResult> {
  const status = await readTenantStatus(db, tenantId);
  if (status === null) {
    return { status: "not_found" };
  }

  if (status !== "closed") {
    const results = await db.batch([
      guardedPlatformAudit(
        db,
        principal,
        {
          action: "tenant.close",
          metadata: { from: status },
          reason: input.reason,
          resourceId: tenantId,
          resourceType: "tenant",
          tenantId,
        },
        now,
        `EXISTS (SELECT 1 FROM tenants WHERE tenant_id = ? AND status = ?)
         AND NOT ${TENANT_NOT_CLOSABLE}`,
        [tenantId, status, tenantId, tenantId],
      ),
      db
        .prepare(
          `UPDATE tenants
           SET status = 'closed', updated_at = MAX(?, created_at)
           WHERE tenant_id = ? AND status = ?
             AND NOT ${TENANT_NOT_CLOSABLE}`,
        )
        .bind(now, tenantId, status, tenantId, tenantId),
    ]);
    if ((results[1]?.meta.changes ?? 0) === 0) {
      // Nothing was written. Name the reason: a refundable order, or a status
      // that changed under us.
      const why = await db
        .prepare(
          `SELECT ${TENANT_HAS_REFUNDABLE_ORDER} AS refundable,
                  ${TENANT_HAS_OPEN_PAYMENT} AS paying`,
        )
        .bind(tenantId, tenantId)
        .first<{ paying: number; refundable: number }>();
      if (why?.refundable === 1) {
        return { status: "refundable_orders" };
      }
      return why?.paying === 1 ? { status: "open_payments" } : { status: "conflict" };
    }
  }

  const detail = await readTenantDetail(db, tenantId, now);
  return detail === null ? { status: "not_found" } : { detail, status: "ok" };
}
