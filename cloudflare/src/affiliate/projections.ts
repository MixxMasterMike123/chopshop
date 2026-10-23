import type { AffiliatePrincipal } from "../auth/live-authorization";
import { isFeatureEnabled } from "../platform/tenant-config";
import { ownPasswordSql } from "../platform/user-directory";
import {
  AFFILIATE_COLUMNS,
  affiliatePortalUrl,
  affiliateRefLink,
  type AffiliateRow,
  readAffiliate,
} from "./affiliates";
import {
  type AffiliateBalance,
  balanceIn,
  commissionBaseMinor,
  HELD_ORDER_SQL,
  heldOrderBinds,
  ORDER_NET_SQL,
  readBalances,
} from "./ledger";
import { type PageQuery, profileComplete, type PayoutRow } from "./payouts";
import { readCurrentAffiliateTerms } from "./terms";

/**
 * CP13 — what each reader sees (design §7.1, §8.9, A14). EVERY answer is
 * built FIELD BY FIELD from named columns, never by spreading a row, as the
 * admin order views are (src/commerce/admin-orders.ts):
 *
 *   the SHOP ADMIN  its own affiliates: identity, rates, code, links, the
 *                   ledger, the payouts, the orders attributed to them with
 *                   the commission per order (`affiliateCommissionMinor`: the
 *                   shop's OWN cost to its affiliate, A14 — never named a
 *                   platform figure; the platform fee stays the one number of
 *                   the order view).
 *   the AFFILIATE   itself: its code, rates, links, balances, terms state; its
 *                   orders as order number, paid date, base ex VAT, commission
 *                   and a state — NEVER a buyer field (no address, name,
 *                   e-mail, phone, line, payment identifier: the suites walk
 *                   every portal answer against a denylist); its ledger and
 *                   payouts.
 *
 * Money in öre, rates in basis points (the UI shows whole percent).
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** "YYYY-MM-DD" (UTC) of `ms`. */
export function utcDay(ms: number): string {
  return iso(ms).slice(0, 10);
}

function parseSocials(json: string | null): Record<string, string> {
  if (json === null) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === "string") {
        out[key] = raw;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ── per order ───────────────────────────────────────────────────────────────

/** Where one order's commission stands (design §7.3: "held/payable/reversed"). */
export type OrderCommissionState = "held" | "none" | "payable" | "reversed";

interface OrderCommissionRow {
  accrued: number | null;
  affiliate_attribution: string;
  affiliate_id: string;
  affiliate_code: string;
  affiliate_self_referral: number;
  created_at: number;
  currency: string;
  held: number | null;
  net: number | null;
  order_id: string;
  order_number: string;
  paid_at: number;
  shipping_minor: number;
  total_minor: number;
  vat_rate_bp: number;
}

/**
 * The commission columns of orders (alias `o`) attributed to an affiliate:
 * the accrual (or null), its net after reversals, and whether it is held.
 * Binds: now, cutoff (HELD_ORDER_SQL), in that order.
 */
const ORDER_COMMISSION_COLUMNS = `o.order_id, o.order_number, o.paid_at, o.created_at, o.total_minor,
  o.shipping_minor, o.vat_rate_bp, o.currency, o.affiliate_id, o.affiliate_code, o.affiliate_attribution,
  o.affiliate_self_referral,
  a.amount_minor AS accrued,
  CASE WHEN a.entry_id IS NULL THEN NULL ELSE ${ORDER_NET_SQL} END AS net,
  CASE WHEN a.entry_id IS NULL THEN NULL WHEN ${HELD_ORDER_SQL} THEN 1 ELSE 0 END AS held`;

const ACCRUAL_JOIN = `LEFT JOIN affiliate_ledger AS a
  ON a.tenant_id = o.tenant_id AND a.order_id = o.order_id AND a.kind = 'accrual' AND a.ref = o.order_id`;

function stateOf(row: Pick<OrderCommissionRow, "accrued" | "held" | "net">): OrderCommissionState {
  if (row.accrued === null) {
    return "none";
  }
  if ((row.net ?? 0) <= 0) {
    return "reversed";
  }
  return row.held === 1 ? "held" : "payable";
}

/** The admin order views' affiliate member (A14), or null on an order without one. */
export interface OrderAffiliateView {
  /**
   * Round 2: the affiliate's id (the order pill links to
   * /admin/affiliates/:id, design §4.5). The shop's own affiliate, never a
   * buyer field; the admin views only (the portal's order row has no id).
   */
  affiliateId: string;
  /** 'link' | 'code'. */
  attribution: string;
  code: string;
  /** The commission this order owes the affiliate now (accrual + reversals); 0 without an accrual. */
  affiliateCommissionMinor: number;
  ledgerState: OrderCommissionState;
  /** The buyer was the affiliate or a shop admin: no commission (design §4.3). */
  selfReferral: boolean;
}

function orderAffiliateView(row: OrderCommissionRow): OrderAffiliateView {
  return {
    affiliateCommissionMinor: Math.max(0, row.net ?? 0),
    affiliateId: row.affiliate_id,
    attribution: row.affiliate_attribution,
    code: row.affiliate_code,
    ledgerState: stateOf(row),
    selfReferral: row.affiliate_self_referral === 1,
  };
}

/**
 * The affiliate member of the shop's order views (admin-orders.ts,
 * admin-order-list.ts), by order id, this shop's orders only; ids chunked at
 * 90. An order without an affiliate authority is absent from the map.
 */
export async function readOrderAffiliates(
  db: D1Database,
  tenantId: string,
  orderIds: readonly string[],
  now: number,
): Promise<Map<string, OrderAffiliateView>> {
  const views = new Map<string, OrderAffiliateView>();
  const unique = [...new Set(orderIds)];
  for (let start = 0; start < unique.length; start += 90) {
    const chunk = unique.slice(start, start + 90);
    const rows = await db
      .prepare(
        `SELECT ${ORDER_COMMISSION_COLUMNS}
         FROM orders AS o ${ACCRUAL_JOIN}
         WHERE o.tenant_id = ? AND o.discount_authority = 'affiliate'
           AND o.order_id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(...heldOrderBinds(now), tenantId, ...chunk)
      .all<OrderCommissionRow>();
    for (const row of rows.results) {
      views.set(row.order_id, orderAffiliateView(row));
    }
  }
  return views;
}

export interface AdminAffiliateOrder {
  affiliateCommissionMinor: number;
  attribution: string;
  currency: string;
  orderId: string;
  orderNumber: string;
  paidAt: string;
  selfReferral: boolean;
  state: OrderCommissionState;
  totalMinor: number;
}

/** The PORTAL's order row: no buyer field, no order id (design §7.1). */
export interface PortalAffiliateOrder {
  /** The commission base: the goods paid for, ex VAT and shipping. */
  baseMinor: number;
  commissionMinor: number;
  currency: string;
  orderNumber: string;
  paidAt: string;
  state: OrderCommissionState;
}

async function orderPage(
  db: D1Database,
  tenantId: string,
  affiliateId: string,
  page: PageQuery,
  now: number,
  withSelfReferrals: boolean,
): Promise<{ nextCursor: string | null; rows: OrderCommissionRow[] }> {
  const cursorMs = page.cursor === null ? null : Date.parse(page.cursor.at);
  const rows = await db
    .prepare(
      `SELECT ${ORDER_COMMISSION_COLUMNS}
       FROM orders AS o ${ACCRUAL_JOIN}
       WHERE o.tenant_id = ? AND o.affiliate_id = ?
         AND (? = 1 OR o.affiliate_self_referral = 0)
         AND (? IS NULL OR (o.created_at, o.order_id) < (?, ?))
       ORDER BY o.created_at DESC, o.order_id DESC
       LIMIT ?`,
    )
    .bind(
      ...heldOrderBinds(now),
      tenantId,
      affiliateId,
      withSelfReferrals ? 1 : 0,
      cursorMs,
      cursorMs,
      page.cursor?.id ?? null,
      page.limit + 1,
    )
    .all<OrderCommissionRow>();
  const items = rows.results.slice(0, page.limit);
  const last = items.at(-1);
  return {
    nextCursor: rows.results.length > page.limit && last !== undefined ? `${iso(last.created_at)}~${last.order_id}` : null,
    rows: items,
  };
}

export async function adminAffiliateOrders(
  db: D1Database,
  tenantId: string,
  affiliateId: string,
  page: PageQuery,
  now: number,
): Promise<{ nextCursor: string | null; orders: AdminAffiliateOrder[] }> {
  const { nextCursor, rows } = await orderPage(db, tenantId, affiliateId, page, now, true);
  return {
    nextCursor,
    orders: rows.map((row) => ({
      affiliateCommissionMinor: Math.max(0, row.net ?? 0),
      attribution: row.affiliate_attribution,
      currency: row.currency,
      orderId: row.order_id,
      orderNumber: row.order_number,
      paidAt: iso(row.paid_at),
      selfReferral: row.affiliate_self_referral === 1,
      state: stateOf(row),
      totalMinor: row.total_minor,
    })),
  };
}

export async function portalAffiliateOrders(
  db: D1Database,
  principal: AffiliatePrincipal,
  page: PageQuery,
  now: number,
): Promise<{ nextCursor: string | null; orders: PortalAffiliateOrder[] }> {
  // A self-referral earns nothing and is not the affiliate's to see.
  const { nextCursor, rows } = await orderPage(db, principal.tenantId, principal.affiliateId, page, now, false);
  return {
    nextCursor,
    orders: rows.map((row) => ({
        baseMinor: commissionBaseMinor(row.total_minor, row.shipping_minor, row.vat_rate_bp),
        commissionMinor: Math.max(0, row.net ?? 0),
        currency: row.currency,
        orderNumber: row.order_number,
      paidAt: iso(row.paid_at),
      state: stateOf(row),
    })),
  };
}

// ── the ledger ──────────────────────────────────────────────────────────────

export interface LedgerEntryView {
  amountMinor: number;
  /** accrual only: when it becomes payable (paid + 14 days). */
  availableAt: string | null;
  createdAt: string;
  currency: string;
  entryId: string;
  kind: string;
  /** The order's number for an accrual or a reversal; null otherwise. */
  orderNumber: string | null;
  /** adjustment only. */
  reason: string | null;
}

/** One affiliate's ledger, newest first. The same shape for the shop and the affiliate. */
export async function ledgerEntries(
  db: D1Database,
  tenantId: string,
  affiliateId: string,
  page: PageQuery,
): Promise<{ entries: LedgerEntryView[]; nextCursor: string | null }> {
  const rows = await db
    .prepare(
      `SELECT l.entry_id, l.kind, l.amount_minor, l.currency, l.available_at, l.reason, l.created_at,
              (SELECT o.order_number FROM orders AS o WHERE o.order_id = l.order_id AND o.tenant_id = l.tenant_id) AS order_number
       FROM affiliate_ledger AS l
       WHERE l.tenant_id = ? AND l.affiliate_id = ?
         AND (? IS NULL OR (l.created_at, l.entry_id) < (?, ?))
       ORDER BY l.created_at DESC, l.entry_id DESC
       LIMIT ?`,
    )
    .bind(tenantId, affiliateId, page.cursor?.at ?? null, page.cursor?.at ?? null, page.cursor?.id ?? null, page.limit + 1)
    .all<{
      amount_minor: number;
      available_at: string | null;
      created_at: string;
      currency: string;
      entry_id: string;
      kind: string;
      order_number: string | null;
      reason: string | null;
    }>();
  const items = rows.results.slice(0, page.limit);
  const last = items.at(-1);
  return {
    entries: items.map((row) => ({
      amountMinor: row.amount_minor,
      availableAt: row.available_at,
      createdAt: row.created_at,
      currency: row.currency,
      entryId: row.entry_id,
      kind: row.kind,
      orderNumber: row.order_number,
      reason: row.kind === "adjustment" ? row.reason : null,
    })),
    nextCursor: rows.results.length > page.limit && last !== undefined ? `${last.created_at}~${last.entry_id}` : null,
  };
}

// ── payouts ─────────────────────────────────────────────────────────────────

export interface PayoutView {
  amountMinor: number;
  currency: string;
  /** The shop admin reads the invoice through its object route; the affiliate through its own. */
  invoiceObjectId: string | null;
  invoiceNumber: string | null;
  notes: string | null;
  paidAt: string | null;
  payoutId: string;
  /** The shop's reference of the payment it made. */
  reference: string | null;
  requestedAt: string;
  status: "paid" | "requested" | "void";
  voidedAt: string | null;
  voidReason: string | null;
}

export function payoutView(row: PayoutRow): PayoutView {
  return {
    amountMinor: row.amount_minor,
    currency: row.currency,
    invoiceNumber: row.invoice_number,
    invoiceObjectId: row.invoice_object_id,
    notes: row.notes,
    paidAt: row.paid_at,
    payoutId: row.payout_id,
    reference: row.paid_reference,
    requestedAt: row.requested_at,
    status: row.status,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
  };
}

/** The affiliate's own view: whether there is an invoice, never the shop's notes. */
export function portalPayoutView(row: PayoutRow): Omit<PayoutView, "invoiceObjectId" | "notes"> & { hasInvoice: boolean } {
  const view = payoutView(row);
  return {
    amountMinor: view.amountMinor,
    currency: view.currency,
    hasInvoice: row.invoice_object_id !== null,
    invoiceNumber: view.invoiceNumber,
    paidAt: view.paidAt,
    payoutId: view.payoutId,
    reference: view.reference,
    requestedAt: view.requestedAt,
    status: view.status,
    voidedAt: view.voidedAt,
    voidReason: view.voidReason,
  };
}

// ── clicks ──────────────────────────────────────────────────────────────────

export interface ClickDay {
  count: number;
  day: string;
}

/** Link landings per UTC day of the last `days` days (days without a landing absent). */
export async function clickDays(
  db: D1Database,
  tenantId: string,
  affiliateId: string,
  now: number,
  days = 30,
): Promise<ClickDay[]> {
  const rows = await db
    .prepare(
      `SELECT day, count FROM affiliate_click_days
       WHERE tenant_id = ? AND affiliate_id = ? AND day >= ?
       ORDER BY day
       LIMIT 400`,
    )
    .bind(tenantId, affiliateId, utcDay(now - (days - 1) * DAY_MS))
    .all<ClickDay>();
  return rows.results.map((row) => ({ count: row.count, day: row.day }));
}

// ── the shop's affiliate ────────────────────────────────────────────────────

export interface AdminAffiliateListRow {
  affiliateId: string;
  /** Link landings in the last 30 days. */
  clicks30d: number;
  code: string;
  commissionBp: number;
  /** Accruals in the last 30 days. */
  conversions30d: number;
  createdAt: string;
  currency: string;
  discountBp: number;
  /** Σ accruals + Σ reversals, all time. */
  earnedMinor: number;
  name: string;
  /** What a payout request could take now. */
  payableMinor: number;
  status: string;
}

export interface AffiliateListQuery {
  cursor: { at: string; id: string } | null;
  limit: number;
  status: "active" | "inactive" | "suspended" | null;
}

const LIST_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([0-9a-f-]{36})$/;

/** `?status=&cursor=&limit=` (1–100, default 50). */
export function parseAffiliateListQuery(url: URL): AffiliateListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "limit", "status"].includes(key) || params.getAll(key).length !== 1) {
      return null;
    }
  }
  const status = params.get("status");
  if (status !== null && status !== "active" && status !== "inactive" && status !== "suspended") {
    return null;
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? 50 : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : 0;
  if (limit < 1 || limit > 100) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  let cursor: AffiliateListQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const match = LIST_CURSOR.exec(cursorRaw);
    if (match === null) {
      return null;
    }
    cursor = { at: match[1] as string, id: match[2] as string };
  }
  return { cursor, limit, status };
}

/** The shop's affiliates, newest first, each with its figures (one SQL read). */
export async function adminAffiliateList(
  db: D1Database,
  tenantId: string,
  query: AffiliateListQuery,
  now: number,
): Promise<{ affiliates: AdminAffiliateListRow[]; nextCursor: string | null }> {
  const heldPerRow = `COALESCE((
      SELECT SUM(MAX(0, ${ORDER_NET_SQL}))
      FROM affiliate_ledger AS a
      INNER JOIN orders AS o ON o.order_id = a.order_id AND o.tenant_id = a.tenant_id
      WHERE a.tenant_id = x.tenant_id AND a.affiliate_id = x.affiliate_id AND a.currency = x.currency
        AND a.kind = 'accrual' AND ${HELD_ORDER_SQL}
    ), 0)`;
  const rows = await db
    .prepare(
      `SELECT x.affiliate_id, x.code, x.name, x.status, x.commission_bp, x.discount_bp, x.currency, x.created_at,
              COALESCE((SELECT SUM(c.count) FROM affiliate_click_days AS c
                        WHERE c.tenant_id = x.tenant_id AND c.affiliate_id = x.affiliate_id AND c.day >= ?), 0) AS clicks,
              (SELECT COUNT(*) FROM affiliate_ledger AS v
               WHERE v.tenant_id = x.tenant_id AND v.affiliate_id = x.affiliate_id AND v.kind = 'accrual'
                 AND v.created_at >= ?) AS conversions,
              COALESCE((SELECT SUM(e.amount_minor) FROM affiliate_ledger AS e
                        WHERE e.tenant_id = x.tenant_id AND e.affiliate_id = x.affiliate_id
                          AND e.kind IN ('accrual', 'reversal')), 0) AS earned,
              COALESCE((SELECT SUM(b.amount_minor) FROM affiliate_ledger AS b
                        WHERE b.tenant_id = x.tenant_id AND b.affiliate_id = x.affiliate_id
                          AND b.currency = x.currency), 0) - ${heldPerRow} AS payable
       FROM affiliates AS x
       WHERE x.tenant_id = ?
         AND (? IS NULL OR x.status = ?)
         AND (? IS NULL OR (x.created_at, x.affiliate_id) < (?, ?))
       ORDER BY x.created_at DESC, x.affiliate_id DESC
       LIMIT ?`,
    )
    .bind(
      utcDay(now - 29 * DAY_MS),
      iso(now - 30 * DAY_MS),
      ...heldOrderBinds(now),
      tenantId,
      query.status,
      query.status,
      query.cursor?.at ?? null,
      query.cursor?.at ?? null,
      query.cursor?.id ?? null,
      query.limit + 1,
    )
    .all<{
      affiliate_id: string;
      clicks: number;
      code: string;
      commission_bp: number;
      conversions: number;
      created_at: string;
      currency: string;
      discount_bp: number;
      earned: number;
      name: string;
      payable: number;
      status: string;
    }>();
  const items = rows.results.slice(0, query.limit);
  const last = items.at(-1);
  return {
    affiliates: items.map((row) => ({
      affiliateId: row.affiliate_id,
      clicks30d: row.clicks,
      code: row.code,
      commissionBp: row.commission_bp,
      conversions30d: row.conversions,
      createdAt: row.created_at,
      currency: row.currency,
      discountBp: row.discount_bp,
      earnedMinor: row.earned,
      name: row.name,
      payableMinor: Math.max(0, row.payable),
      status: row.status,
    })),
    nextCursor: rows.results.length > query.limit && last !== undefined ? `${last.created_at}~${last.affiliate_id}` : null,
  };
}

export interface AffiliateAddress {
  city: string | null;
  country: string;
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
}

function addressOf(row: AffiliateRow): AffiliateAddress {
  return {
    city: row.city,
    country: row.country,
    line1: row.address_line1,
    line2: row.address_line2,
    postalCode: row.postal_code,
  };
}

export interface TermsState {
  acceptedAt: string | null;
  acceptedVersion: string | null;
  currentVersion: string | null;
  /** The person has not accepted the CURRENT version (design §8): the portal routes to the terms. */
  outdated: boolean;
}

async function termsStateOf(db: D1Database, row: AffiliateRow, now: number): Promise<TermsState> {
  const current = await readCurrentAffiliateTerms(db, now);
  return {
    acceptedAt: row.terms_accepted_at,
    acceptedVersion: row.terms_version,
    currentVersion: current?.version ?? null,
    outdated: current !== null && row.terms_version !== current.version,
  };
}

export interface AdminAffiliateDetail {
  account: {
    /** The person has not set a password of their own: the invite's link is still owed. */
    invited: boolean;
    /** Their membership of this shop (the login's gate): null if none. */
    membership: string | null;
  };
  address: AffiliateAddress;
  affiliateId: string;
  applicationId: string | null;
  balances: AffiliateBalance[];
  clicksByDay: ClickDay[];
  code: string;
  commissionBp: number;
  /** Accruals all time. */
  conversions: number;
  createdAt: string;
  currency: string;
  discountBp: number;
  /** The affiliate's login address (the shop's own affiliate: its data). */
  email: string;
  links: { portalUrl: string | null; refLink: string | null };
  name: string;
  phone: string | null;
  preferredLang: string;
  /** The shop's add-on: false shows the OFF banner (design §4.5). */
  programOn: boolean;
  promotionMethod: string | null;
  /** −Σ reversals, all time (shown as "återfört"). */
  reversedMinor: number;
  socials: Record<string, string>;
  status: string;
  terms: TermsState;
}

/** The shop's view of ONE of its affiliates, or null (never another shop's). */
export async function adminAffiliateDetail(
  env: Env,
  tenantId: string,
  affiliateId: string,
  now: number,
): Promise<AdminAffiliateDetail | null> {
  const db = env.DB;
  const row = await readAffiliate(db, tenantId, affiliateId);
  if (row === null) {
    return null;
  }
  const facts = await db
    .prepare(
      `SELECT u."email" AS email, ${ownPasswordSql("a.user_id")} AS own_password,
              (SELECT m.status FROM tenant_memberships AS m
               WHERE m.tenant_id = a.tenant_id AND m.user_id = a.user_id AND m.role = 'affiliate' LIMIT 1) AS membership,
              (SELECT COUNT(*) FROM affiliate_ledger AS l
               WHERE l.tenant_id = a.tenant_id AND l.affiliate_id = a.affiliate_id AND l.kind = 'accrual') AS conversions,
              COALESCE((SELECT -SUM(l.amount_minor) FROM affiliate_ledger AS l
                        WHERE l.tenant_id = a.tenant_id AND l.affiliate_id = a.affiliate_id AND l.kind = 'reversal'), 0) AS reversed
       FROM affiliates AS a INNER JOIN "user" AS u ON u."id" = a.user_id
       WHERE a.affiliate_id = ? AND a.tenant_id = ?`,
    )
    .bind(affiliateId, tenantId)
    .first<{ conversions: number; email: string; membership: string | null; own_password: number; reversed: number }>();
  return {
    account: { invited: facts?.own_password !== 1, membership: facts?.membership ?? null },
    address: addressOf(row),
    affiliateId: row.affiliate_id,
    applicationId: row.application_id,
    balances: await readBalances(db, tenantId, affiliateId, row.currency, now),
    clicksByDay: await clickDays(db, tenantId, affiliateId, now),
    code: row.code,
    commissionBp: row.commission_bp,
    conversions: facts?.conversions ?? 0,
    createdAt: row.created_at,
    currency: row.currency,
    discountBp: row.discount_bp,
    email: facts?.email ?? "",
    links: {
      portalUrl: affiliatePortalUrl(env, tenantId),
      refLink: affiliateRefLink(env, tenantId, row.code),
    },
    name: row.name,
    phone: row.phone,
    preferredLang: row.preferred_lang,
    programOn: await isFeatureEnabled(db, tenantId, "affiliate"),
    promotionMethod: row.promotion_method,
    reversedMinor: facts?.reversed ?? 0,
    socials: parseSocials(row.socials_json),
    status: row.status,
    terms: await termsStateOf(db, row, now),
  };
}

// ── analytics (design §7.2) ─────────────────────────────────────────────────

export interface AffiliateAnalytics {
  activeAffiliates: number;
  /** Link landings in the period ("Länkbesök", never "unika besökare"). */
  clicks: number;
  /** Σ accruals + reversals written in the period, in the shop's currency. */
  commissionMinor: number;
  /** Accruals in the period: orders per link visit is conversions / clicks (an aggregate, design §2.1). */
  conversions: number;
  currency: string;
  ranking: Array<{
    affiliateId: string;
    clicks: number;
    code: string;
    commissionMinor: number;
    conversions: number;
    name: string;
  }>;
  since: string;
  /** Σ every affiliate's balance (earned, not yet paid out or reserved), the shop's currency. */
  unpaidMinor: number;
}

/** `?since=<ISO date or date-time>`; default 30 days ago; never more than 400 days back. */
export function parseAnalyticsSince(url: URL, now: number): number | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (key !== "since" || params.getAll(key).length !== 1) {
      return null;
    }
  }
  const raw = params.get("since");
  if (raw === null) {
    return now - 30 * DAY_MS;
  }
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/.test(raw)) {
    return null;
  }
  const ms = Date.parse(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isFinite(ms) && ms <= now && ms >= now - 400 * DAY_MS ? ms : null;
}

export async function adminAffiliateAnalytics(
  db: D1Database,
  tenantId: string,
  since: number,
  now: number,
): Promise<AffiliateAnalytics> {
  const shop = await db
    .prepare("SELECT default_currency FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ default_currency: string }>();
  const currency = shop?.default_currency ?? "SEK";
  const sinceIso = iso(since);
  const sinceDay = utcDay(since);
  const ranking = await db
    .prepare(
      `SELECT x.affiliate_id, x.code, x.name,
              COALESCE((SELECT SUM(c.count) FROM affiliate_click_days AS c
                        WHERE c.tenant_id = x.tenant_id AND c.affiliate_id = x.affiliate_id AND c.day >= ?), 0) AS clicks,
              (SELECT COUNT(*) FROM affiliate_ledger AS v
               WHERE v.tenant_id = x.tenant_id AND v.affiliate_id = x.affiliate_id AND v.kind = 'accrual'
                 AND v.created_at >= ?) AS conversions,
              COALESCE((SELECT SUM(e.amount_minor) FROM affiliate_ledger AS e
                        WHERE e.tenant_id = x.tenant_id AND e.affiliate_id = x.affiliate_id AND e.currency = ?
                          AND e.kind IN ('accrual', 'reversal') AND e.created_at >= ?), 0) AS commission
       FROM affiliates AS x
       WHERE x.tenant_id = ?
       ORDER BY conversions DESC, commission DESC, clicks DESC, x.affiliate_id
       LIMIT 50`,
    )
    .bind(sinceDay, sinceIso, currency, sinceIso, tenantId)
    .all<{ affiliate_id: string; clicks: number; code: string; commission: number; conversions: number; name: string }>();
  const totals = await db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(count) FROM affiliate_click_days WHERE tenant_id = ?1 AND day >= ?2), 0) AS clicks,
         (SELECT COUNT(*) FROM affiliate_ledger WHERE tenant_id = ?1 AND kind = 'accrual' AND created_at >= ?3) AS conversions,
         COALESCE((SELECT SUM(amount_minor) FROM affiliate_ledger
                   WHERE tenant_id = ?1 AND currency = ?4 AND kind IN ('accrual', 'reversal') AND created_at >= ?3), 0) AS commission,
         COALESCE((SELECT SUM(amount_minor) FROM affiliate_ledger WHERE tenant_id = ?1 AND currency = ?4), 0) AS unpaid,
         (SELECT COUNT(*) FROM affiliates WHERE tenant_id = ?1 AND status = 'active') AS active`,
    )
    .bind(tenantId, sinceDay, sinceIso, currency)
    .first<{ active: number; clicks: number; commission: number; conversions: number; unpaid: number }>();
  return {
    activeAffiliates: totals?.active ?? 0,
    clicks: totals?.clicks ?? 0,
    commissionMinor: totals?.commission ?? 0,
    conversions: totals?.conversions ?? 0,
    currency,
    ranking: ranking.results.map((row) => ({
      affiliateId: row.affiliate_id,
      clicks: row.clicks,
      code: row.code,
      commissionMinor: row.commission,
      conversions: row.conversions,
      name: row.name,
    })),
    since: sinceIso,
    unpaidMinor: totals?.unpaid ?? 0,
  };
}

// ── the affiliate's own (the portal) ────────────────────────────────────────

export type PayoutBlocker = "nothing_payable" | "payout_open" | "profile_incomplete" | "terms_required";

export interface PortalMe {
  address: AffiliateAddress;
  affiliateId: string;
  balance: AffiliateBalance;
  clicksByDay: ClickDay[];
  code: string;
  commissionBp: number;
  currency: string;
  discountBp: number;
  email: string;
  links: { refLink: string | null };
  name: string;
  /** Why "Begär utbetalning" is disabled; empty when a request may be made. */
  payoutBlockers: PayoutBlocker[];
  phone: string | null;
  preferredLang: string;
  /** The program runs for this affiliate: the shop's add-on ON and the affiliate active. */
  programActive: boolean;
  shop: { name: string | null; supportEmail: string | null };
  socials: Record<string, string>;
  status: string;
  terms: TermsState;
}

export async function portalMe(env: Env, principal: AffiliatePrincipal, now: number): Promise<PortalMe | null> {
  const db = env.DB;
  const row = await db
    .prepare(
      `SELECT ${AFFILIATE_COLUMNS}, u."email" AS email, t.shop_name, t.support_email
       FROM affiliates AS a
       INNER JOIN "user" AS u ON u."id" = a.user_id
       INNER JOIN tenants AS t ON t.tenant_id = a.tenant_id
       WHERE a.affiliate_id = ? AND a.tenant_id = ? LIMIT 1`,
    )
    .bind(principal.affiliateId, principal.tenantId)
    .first<AffiliateRow & { email: string; shop_name: string | null; support_email: string | null }>();
  if (row === null) {
    return null;
  }
  const balance = balanceIn(await readBalances(db, principal.tenantId, principal.affiliateId, row.currency, now), row.currency);
  const terms = await termsStateOf(db, row, now);
  const blockers: PayoutBlocker[] = [];
  if (!profileComplete(row)) {
    blockers.push("profile_incomplete");
  }
  if (terms.outdated) {
    blockers.push("terms_required");
  }
  if (balance.requestedMinor > 0) {
    blockers.push("payout_open");
  }
  if (balance.payableMinor <= 0) {
    blockers.push("nothing_payable");
  }
  return {
    address: addressOf(row),
    affiliateId: row.affiliate_id,
    balance,
    clicksByDay: await clickDays(db, principal.tenantId, principal.affiliateId, now),
    code: row.code,
    commissionBp: row.commission_bp,
    currency: row.currency,
    discountBp: row.discount_bp,
    email: row.email,
    links: { refLink: affiliateRefLink(env, principal.tenantId, row.code) },
    name: row.name,
    payoutBlockers: blockers,
    phone: row.phone,
    preferredLang: row.preferred_lang,
    programActive: row.status === "active" && (await isFeatureEnabled(db, principal.tenantId, "affiliate")),
    shop: { name: row.shop_name, supportEmail: row.support_email },
    socials: parseSocials(row.socials_json),
    status: row.status,
    terms,
  };
}
