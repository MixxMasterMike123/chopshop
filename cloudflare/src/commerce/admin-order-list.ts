import { readOrderRecipients } from "./recipient";
import type { FulfilmentState } from "./fulfilment";
import { isFulfilmentState } from "./fulfilment";

/**
 * `GET /v1/admin/orders` — the shop's own orders, newest first (CP5-WB).
 *
 * THE SELLER SEES ONE NUMBER (src/commerce/admin-orders.ts): a list row is
 * built field by field from named columns, as the detail is, and names no fee
 * at all — not the commission, not the withholding, not the connected
 * account, not the transfer, not the production snapshot. The admin-orders
 * suites walk the list against the same denylist as the detail.
 *
 * Query (every parameter optional, any other one refused):
 *   status      a value of `orders.status`, or `cancelled` (cancelled_at set)
 *   fulfilment  a value of `orders.fulfilment_status` (0046)
 *   since       ISO-8601 UTC, inclusive, on the order's creation
 *   until       ISO-8601 UTC, exclusive
 *   q           (when it holds `@`) a customer's e-mail address, exact and
 *               lower-cased (checkout stores it so); otherwise 1–100 letters,
 *               digits, spaces, `'`, `’`, `.` or `-` (NAME_QUERY_PATTERN), which
 *               match an order when EITHER its number starts with q (only when
 *               q is an order-number prefix, ASCII case-insensitive) OR its
 *               recipient's name (order_recipients, D98) CONTAINS q —
 *               case-insensitive for ASCII letters and for the letters of
 *               FOLDED_LETTERS, nothing else folded. An order without a
 *               recipient row (made before 0045) matches by its number only.
 *               The answer carries no recipient field beyond `recipientName`.
 *   cursor      the previous page's `nextCursor`
 *   limit       1..100, default 50
 * Paging is by (created_at, order_id) descending on the tenant-first index
 * (orders_tenant_created_idx), as the platform's list pages ascending.
 * `count` and `totalMinor` are the whole filter window's (cursor ignored),
 * one SQL aggregate, never a walk over pages.
 */

export const ADMIN_ORDER_LIST_LIMIT = 50;
const MAX_ADMIN_ORDER_LIST_LIMIT = 100;

const ORDER_STATUSES = [
  "paid",
  "processing",
  "printed",
  "shipped",
  "ready_for_pickup",
  "delivered",
  "completed",
  "partially_refunded",
  "refunded",
  "cancelled",
] as const;

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CURSOR_PATTERN =
  /^(\d{1,16})~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Order numbers are `YYYYMMDD-XXXXXXXX` (webhook.ts generateOrderNumber). */
const ORDER_NUMBER_PREFIX_PATTERN = /^[0-9A-Za-z-]{1,40}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
/**
 * A name query: letters, combining marks, digits, the space, the apostrophes,
 * the full stop and the hyphen. No LIKE wildcard (`%`, `_`) and no escape
 * character can reach the pattern, so it needs no ESCAPE clause.
 */
const NAME_QUERY_PATTERN = /^[\p{L}\p{M}\p{N} '’.-]{1,100}$/u;
/**
 * The upper-case letters folded to lower case on BOTH sides of the name match
 * (SQLite's LIKE folds ASCII only): the Nordic letters and a few common ones.
 */
const FOLDED_LETTERS = ["Å", "Ä", "Ö", "Æ", "Ø", "É", "È", "Ü", "Ñ"] as const;

function foldName(text: string): string {
  let folded = text;
  for (const letter of FOLDED_LETTERS) {
    folded = folded.split(letter).join(letter.toLowerCase());
  }
  return folded;
}

/** The same fold in SQL, over the column `expression`. */
function foldNameSql(expression: string): string {
  return FOLDED_LETTERS.reduce(
    (sql, letter) => `replace(${sql}, '${letter}', '${letter.toLowerCase()}')`,
    expression,
  );
}

export interface AdminOrderListQuery {
  cursor: { createdAt: number; orderId: string } | null;
  email: string | null;
  fulfilment: FulfilmentState | null;
  limit: number;
  /** A name query: matched as a part of the recipient's name, folded (foldName). */
  name: string | null;
  orderNumberPrefix: string | null;
  since: number | null;
  status: (typeof ORDER_STATUSES)[number] | null;
  until: number | null;
}

function parseIso(raw: string | null): number | null | undefined {
  if (raw === null) {
    return null;
  }
  const value = ISO_PATTERN.test(raw) ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** null = the query is not valid (400). */
export function parseAdminOrderListQuery(url: URL): AdminOrderListQuery | null {
  const params = url.searchParams;
  const allowed = ["cursor", "fulfilment", "limit", "q", "since", "status", "until"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) {
      return null;
    }
  }

  const statusRaw = params.get("status");
  if (statusRaw !== null && !(ORDER_STATUSES as readonly string[]).includes(statusRaw)) {
    return null;
  }
  const fulfilmentRaw = params.get("fulfilment");
  if (fulfilmentRaw !== null && !isFulfilmentState(fulfilmentRaw)) {
    return null;
  }

  const since = parseIso(params.get("since"));
  const until = parseIso(params.get("until"));
  if (since === undefined || until === undefined) {
    return null;
  }

  const limitRaw = params.get("limit");
  let limit = ADMIN_ORDER_LIST_LIMIT;
  if (limitRaw !== null) {
    limit = /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : 0;
    if (limit < 1 || limit > MAX_ADMIN_ORDER_LIST_LIMIT) {
      return null;
    }
  }

  const cursorRaw = params.get("cursor");
  let cursor: AdminOrderListQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const match = CURSOR_PATTERN.exec(cursorRaw);
    if (match === null) {
      return null;
    }
    cursor = { createdAt: Number(match[1]), orderId: match[2] as string };
  }

  let email: string | null = null;
  let name: string | null = null;
  let orderNumberPrefix: string | null = null;
  const qRaw = params.get("q");
  if (qRaw !== null) {
    const q = qRaw.trim();
    if (q.includes("@")) {
      if (!EMAIL_PATTERN.test(q)) {
        return null;
      }
      email = q.toLowerCase();
    } else {
      if (!NAME_QUERY_PATTERN.test(q)) {
        return null;
      }
      name = foldName(q);
      orderNumberPrefix = ORDER_NUMBER_PREFIX_PATTERN.test(q) ? q.toUpperCase() : null;
    }
  }

  return {
    cursor,
    email,
    fulfilment: fulfilmentRaw as FulfilmentState | null,
    limit,
    name,
    orderNumberPrefix,
    since,
    status: statusRaw as AdminOrderListQuery["status"],
    until,
  };
}

export interface AdminOrderListRow {
  cancelledAt: string | null;
  createdAt: string;
  currency: string;
  customerEmail: string;
  deliveryMethod: string;
  fulfilment: FulfilmentState;
  itemCount: number;
  orderId: string;
  orderNumber: string;
  paidAt: string;
  /** The pickup place's name as frozen on the order; null for a parcel. */
  pickupPlace: string | null;
  /** The recipient's name (D98); null for an order made before 0045. */
  recipientName: string | null;
  refundedMinor: number;
  status: string;
  totalMinor: number;
}

export interface AdminOrderList {
  /** Orders in the filter window (all pages). */
  count: number;
  nextCursor: string | null;
  orders: AdminOrderListRow[];
  /** Σ total_minor of the orders in the filter window (a shop has one currency). */
  totalMinor: number;
}

interface ListRow {
  cancelled_at: string | null;
  created_at: number;
  currency: string;
  customer_email: string;
  delivery_method: string;
  fulfilment_status: FulfilmentState;
  item_count: number;
  order_id: string;
  order_number: string;
  paid_at: number;
  refund_succeeded_minor: number;
  status: string;
  total_minor: number;
}

/** The filter window's WHERE (alias `o`), without the cursor. */
function windowWhere(
  tenantId: string,
  query: AdminOrderListQuery,
): { binds: unknown[]; sql: string } {
  const where = ["o.tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (query.status === "cancelled") {
    where.push("(o.status = 'cancelled' OR o.cancelled_at IS NOT NULL)");
  } else if (query.status !== null) {
    where.push("o.status = ?");
    binds.push(query.status);
  }
  if (query.fulfilment !== null) {
    where.push("o.fulfilment_status = ?");
    binds.push(query.fulfilment);
  }
  if (query.since !== null) {
    where.push("o.created_at >= ?");
    binds.push(query.since);
  }
  if (query.until !== null) {
    where.push("o.created_at < ?");
    binds.push(query.until);
  }
  if (query.email !== null) {
    where.push("o.customer_email = ?");
    binds.push(query.email);
  }
  // The prefix holds only [0-9A-Z-]: no GLOB metacharacter can reach here.
  // The name holds no LIKE wildcard (NAME_QUERY_PATTERN). The recipient row
  // is the order's own and this shop's (order_id AND tenant_id).
  const byName = `EXISTS (SELECT 1 FROM order_recipients AS r
                  WHERE r.order_id = o.order_id AND r.tenant_id = o.tenant_id
                    AND ${foldNameSql("r.name")} LIKE ?)`;
  if (query.name !== null && query.orderNumberPrefix !== null) {
    where.push(`(o.order_number GLOB ? OR ${byName})`);
    binds.push(`${query.orderNumberPrefix}*`, `%${query.name}%`);
  } else if (query.name !== null) {
    where.push(byName);
    binds.push(`%${query.name}%`);
  } else if (query.orderNumberPrefix !== null) {
    where.push("o.order_number GLOB ?");
    binds.push(`${query.orderNumberPrefix}*`);
  }
  return { binds, sql: where.join(" AND ") };
}

export async function listAdminOrders(
  db: D1Database,
  tenantId: string,
  query: AdminOrderListQuery,
): Promise<AdminOrderList> {
  const window = windowWhere(tenantId, query);
  const pageWhere = [window.sql];
  const pageBinds = [...window.binds];
  if (query.cursor !== null) {
    pageWhere.push("(o.created_at, o.order_id) < (?, ?)");
    pageBinds.push(query.cursor.createdAt, query.cursor.orderId);
  }

  const [rows, totals] = await db.batch([
    db
      .prepare(
        `SELECT o.order_id, o.order_number, o.created_at, o.paid_at, o.status,
                o.fulfilment_status, o.delivery_method, o.total_minor, o.currency,
                o.customer_email, o.refund_succeeded_minor, o.cancelled_at,
                (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items AS i
                 WHERE i.order_id = o.order_id AND i.tenant_id = o.tenant_id) AS item_count
         FROM orders AS o
         WHERE ${pageWhere.join(" AND ")}
         ORDER BY o.created_at DESC, o.order_id DESC
         LIMIT ?`,
      )
      .bind(...pageBinds, query.limit + 1),
    db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(o.total_minor), 0) AS total_minor
         FROM orders AS o
         WHERE ${window.sql}`,
      )
      .bind(...window.binds),
  ]);

  const all = (rows?.results ?? []) as ListRow[];
  const page = all.slice(0, query.limit);
  const recipients = await readOrderRecipients(
    db,
    tenantId,
    page.map((row) => row.order_id),
  );
  const aggregate = (totals?.results?.[0] ?? { count: 0, total_minor: 0 }) as {
    count: number;
    total_minor: number;
  };
  const last = page.at(-1);

  return {
    count: aggregate.count,
    nextCursor:
      all.length > query.limit && last !== undefined ? `${last.created_at}~${last.order_id}` : null,
    orders: page.map((row) => {
      const recipient = recipients.get(row.order_id) ?? null;
      return {
        cancelledAt: row.cancelled_at,
        createdAt: new Date(row.created_at).toISOString(),
        currency: row.currency,
        customerEmail: row.customer_email,
        deliveryMethod: row.delivery_method,
        fulfilment: row.fulfilment_status,
        itemCount: row.item_count,
        orderId: row.order_id,
        orderNumber: row.order_number,
        paidAt: new Date(row.paid_at).toISOString(),
        pickupPlace:
          recipient?.deliveryMethod === "pickup" ? recipient.pickupLocationName : null,
        recipientName: recipient?.name ?? null,
        refundedMinor: row.refund_succeeded_minor,
        status: row.status,
        totalMinor: row.total_minor,
      };
    }),
    totalMinor: aggregate.total_minor,
  };
}
