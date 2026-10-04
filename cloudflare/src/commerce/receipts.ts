/**
 * The guest receipt capability (PLAN §2.1, §2.3) and the buyer order schema.
 *
 * ── THE LIFECYCLE ────────────────────────────────────────────────────────────
 * 1. MINT — the Stripe webhook, in the same D1 batch that creates the order,
 *    draws 256 random bits, stores SHA-256(token) + a 30-day expiry on the
 *    order, and parks the raw token in `order_receipt_handoffs` keyed by the
 *    checkout id (migrations/0014_receipt_tokens.sql).
 * 2. HAND OFF — the storefront's confirmation poll (`POST
 *    /v1/checkout/:checkoutId/receipt`, checkout id as the bearer capability,
 *    tenant from the hostname) takes the row with one `DELETE … RETURNING`.
 *    Exactly one poll receives the raw token; after that it exists only in the
 *    buyer's browser.
 * 3. READ — `GET /v1/orders/:orderId` with `Authorization: Bearer <token>`
 *    answers the allowlisted buyer schema below when hostname tenant, order id
 *    and token hash match and the expiry has not passed. Every miss is the same
 *    opaque 404.
 *
 * ── WHY THIS SHAPE ───────────────────────────────────────────────────────────
 * The order is created server-to-server; there is no browser response to put a
 * token in. Minting at checkout creation instead would put the only copy in a
 * response that the idempotent-replay path must re-serve unchanged — which it
 * cannot do without storing the raw token anyway. Minting in the webhook and
 * handing off once keeps the raw token at rest only until the first poll (at
 * most one hour), and never beside the hash that authorizes it.
 */

import { readOrderRecipient, type RecipientView } from "./recipient";

export const RECEIPT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const RECEIPT_HANDOFF_TTL_MS = 60 * 60 * 1_000;

// 32 bytes → 43 base64url characters, unpadded.
const RECEIPT_TOKEN_BYTES = 32;
const RECEIPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/;
const HANDOFF_SWEEP_BATCH = 50;

export interface ReceiptCapability {
  expiresAt: string;
  handoffCreatedAt: string;
  handoffExpiresAt: string;
  token: string;
  tokenHash: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hashReceiptToken(token: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}

export async function mintReceiptCapability(
  now: number,
): Promise<ReceiptCapability> {
  const token = toBase64Url(
    crypto.getRandomValues(new Uint8Array(RECEIPT_TOKEN_BYTES)),
  );

  return {
    expiresAt: new Date(now + RECEIPT_TOKEN_TTL_MS).toISOString(),
    handoffCreatedAt: new Date(now).toISOString(),
    handoffExpiresAt: new Date(now + RECEIPT_HANDOFF_TTL_MS).toISOString(),
    token,
    tokenHash: await hashReceiptToken(token),
  };
}

/**
 * The token from `Authorization: Bearer <token>`, or null. Exactly one space,
 * exactly the 43-character alphabet a minted token has: anything else is not a
 * receipt token and is refused before it is hashed or looked up.
 */
export function parseReceiptBearer(header: string | null): string | null {
  if (header === null) {
    return null;
  }

  const match = BEARER_PATTERN.exec(header);
  const token = match?.[1];
  return token !== undefined && RECEIPT_TOKEN_PATTERN.test(token) ? token : null;
}

// ── hand-off ────────────────────────────────────────────────────────────────

export type ReceiptClaim =
  | { orderId: string; receiptToken: string; status: "ready" }
  | { status: "issued" | "not_found" | "pending" };

/**
 * The confirmation poll's one read.
 *
 * The sweep and the claim run in one batch: expired handoffs (any tenant — the
 * sweep returns nothing to the caller) are deleted, bounded, and then this
 * checkout's live handoff is deleted WITH RETURNING. Two concurrent polls both
 * run that DELETE; only one of them gets the row back.
 *
 * With no row, the checkout itself says why: still `open` → the payment has not
 * produced an order yet (`pending`, keep polling); `completed` → the order
 * exists and its token was already handed out or has lapsed (`issued`); any
 * other status, another tenant, or an unknown id → `not_found`.
 */
export async function claimReceiptHandoff(
  db: D1Database,
  tenantId: string,
  checkoutId: string,
  now: number,
): Promise<ReceiptClaim> {
  const nowIso = new Date(now).toISOString();

  const [, claimed] = await db.batch<{
    order_id: string;
    receipt_token: string;
  }>([
    db
      .prepare(
        `DELETE FROM order_receipt_handoffs
         WHERE expires_at <= ?
         LIMIT ${HANDOFF_SWEEP_BATCH}`,
      )
      .bind(nowIso),
    db
      .prepare(
        `DELETE FROM order_receipt_handoffs
         WHERE checkout_id = ?
           AND tenant_id = ?
           AND expires_at > ?
         RETURNING order_id, receipt_token`,
      )
      .bind(checkoutId, tenantId, nowIso),
  ]);

  const row = claimed?.results[0];
  if (row !== undefined) {
    return {
      orderId: row.order_id,
      receiptToken: row.receipt_token,
      status: "ready",
    };
  }

  const checkout = await db
    .prepare(
      `SELECT status FROM checkouts
       WHERE checkout_id = ? AND tenant_id = ?
       LIMIT 1`,
    )
    .bind(checkoutId, tenantId)
    .first<{ status: string }>();

  if (checkout?.status === "open") {
    return { status: "pending" };
  }
  if (checkout?.status === "completed") {
    return { status: "issued" };
  }
  return { status: "not_found" };
}

// ── the buyer order schema ──────────────────────────────────────────────────

export interface BuyerOrderItem {
  lineTotalMinor: number;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

/**
 * EVERYTHING a buyer's receipt may show, and nothing else.
 *
 * Built field by field from named columns — never by spreading a row — so a
 * column added to `orders` later (cost, printer, Connect, production snapshot,
 * payout, withholding) cannot reach a buyer by accident. The suite walks the
 * serialized response for a denylist of internal key names at every depth.
 */
export interface BuyerOrder {
  createdAt: string;
  currency: string;
  delivery: { country: string | null; method: "pickup" | "shipping" };
  email: string;
  items: BuyerOrderItem[];
  orderId: string;
  orderNumber: string;
  /**
   * D98: who gets the order and where (src/commerce/recipient.ts
   * RecipientView) — the buyer's own words, shown back to the holder of the
   * receipt token. null for an order made before 0045.
   */
  recipient: RecipientView | null;
  status: string;
  totals: {
    /**
     * CP8-DC: the code the buyer typed, as the shop names it now, or null
     * without one. The receipt is token-bound (PLAN §2.1).
     */
    discountCode: string | null;
    discountMinor: number;
    shippingMinor: number;
    subtotalMinor: number;
    totalMinor: number;
    vatMinor: number;
  };
  /**
   * CP2-E: whether the buyer waived the 14-day right of withdrawal for a
   * personalised line after the disclosure (src/legal/consent.ts). false =
   * the full right applies.
   */
  withdrawal: { waived: boolean };
}

interface BuyerOrderRow {
  created_at: number;
  currency: string;
  customer_email: string;
  delivery_method: string;
  discount_code: string | null;
  discount_minor: number;
  is_personalized: number;
  order_id: string;
  order_number: string;
  shipping_country: string | null;
  shipping_minor: number;
  status: string;
  subtotal_minor: number;
  total_minor: number;
  vat_minor: number;
}

interface BuyerOrderItemRow {
  line_total_minor: number;
  name: string;
  quantity: number;
  unit_price_minor: number;
}

/**
 * `b***@example.com`. Enough for a buyer to recognise their own address, not
 * enough to harvest one from a leaked receipt link.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return "***";
  }

  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * The order behind a receipt token, or null. One query decides it: tenant from
 * the hostname, the order id from the path, the token's hash, and an unexpired
 * expiry must ALL match. Which one failed is never distinguishable.
 */
export async function readBuyerOrder(
  db: D1Database,
  tenantId: string,
  orderId: string,
  token: string,
  now: number,
): Promise<BuyerOrder | null> {
  const tokenHash = await hashReceiptToken(token);
  const order = await db
    .prepare(
      `SELECT
         o.order_id, o.order_number, o.status, o.customer_email, o.currency,
         o.delivery_method, o.shipping_country, o.subtotal_minor, o.shipping_minor,
         o.vat_minor, o.discount_minor, o.total_minor, o.created_at, o.is_personalized,
         (SELECT dc.code FROM discount_codes AS dc
          WHERE dc.discount_code_id = o.discount_code_id
            AND dc.tenant_id = o.tenant_id) AS discount_code
       FROM orders AS o
       WHERE o.tenant_id = ?
         AND o.order_id = ?
         AND o.receipt_token_hash = ?
         AND o.receipt_token_expires_at > ?
       LIMIT 1`,
    )
    .bind(tenantId, orderId, tokenHash, new Date(now).toISOString())
    .first<BuyerOrderRow>();

  if (order === null) {
    return null;
  }

  const items = await db
    .prepare(
      `SELECT name, quantity, unit_price_minor, line_total_minor
       FROM order_items
       WHERE tenant_id = ? AND order_id = ?
       ORDER BY item_index ASC`,
    )
    .bind(tenantId, orderId)
    .all<BuyerOrderItemRow>();

  return {
    createdAt: new Date(order.created_at).toISOString(),
    currency: order.currency,
    delivery: {
      country: order.shipping_country,
      method: order.delivery_method === "pickup" ? "pickup" : "shipping",
    },
    email: maskEmail(order.customer_email),
    items: items.results.map((item) => ({
      lineTotalMinor: item.line_total_minor,
      name: item.name,
      quantity: item.quantity,
      unitPriceMinor: item.unit_price_minor,
    })),
    orderId: order.order_id,
    orderNumber: order.order_number,
    recipient: await readOrderRecipient(db, tenantId, order.order_id),
    status: order.status,
    totals: {
      discountCode: order.discount_code,
      discountMinor: order.discount_minor,
      shippingMinor: order.shipping_minor,
      subtotalMinor: order.subtotal_minor,
      totalMinor: order.total_minor,
      vatMinor: order.vat_minor,
    },
    withdrawal: { waived: order.is_personalized === 1 },
  };
}
