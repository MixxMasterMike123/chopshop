import { verifyRecoveryToken } from "../commerce/checkout-recovery-token";
import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit, visitorRateKey } from "../lib/rate-limit";
import { decodeSegment, rateLimitedResponse, routeNotFoundResponse } from "../lib/responses";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP9-AC — the two links of an abandoned-checkout reminder (§6). Storefront
 * routes: mounted inside app.ts's `storefront(...)` wrapper, no session, the
 * tenant from the verified hostname (an active shop) and nothing else.
 *
 *   POST /v1/checkout-recovery/:token              the resume link's lines
 *     200 { recovery: { status: "open", items: [{ productId, quantity, variantId? }] } }
 *     200 { recovery: { status: "completed" } }   the reminded checkout became an order
 *   POST /v1/checkout-recovery/:token/unsubscribe  RFC 8058 one-click, and the page
 *     200 { unsubscribed: true }                   now or before (idempotent)
 *   both:
 *     404 (the opaque one, the same bytes)  a malformed, forged or foreign
 *         token, the other purpose's, an unknown reminder, a skipped or
 *         withdrawn decision (no link was ever mailed), a resume link past its
 *         7 days, no secret configured
 *     429 rate_limited                      the 31st request of one visitor
 *                                           within 10 minutes
 *
 * The body is never read: a mail provider's one-click POST carries
 * `List-Unsubscribe=One-Click`, the page sends nothing. No same-origin check,
 * as for the withdrawal intake: the surface is anonymous and carries no
 * ambient credential.
 *
 * WHAT IS NEVER ANSWERED: an address, a name or any recipient field; a price,
 * a total, a discount or a code; the checkout id, the intent, the reminder's
 * dates and reasons; whether an address is suppressed or has other checkouts.
 * The holder of a valid resume link learns the lines and, at most, that the
 * checkout became an order.
 *
 * Neither route reads the add-on or the seller's switch: a link mailed while
 * they were on never dead-ends (Firebase's rule), and unsubscribing works
 * whatever their state and however old the link (AC11).
 *
 * THE RATE LIMIT: one scope for both routes, per visitor (an IPv6 address by
 * its /64), counted before the token is parsed, so every attempt counts. A
 * flood shield only: a 256-bit signature cannot be guessed. Deliberately no
 * limit per token or reminder, which would let whoever holds a link keep its
 * buyer from unsubscribing.
 */

export const CHECKOUT_RECOVERY_ROUTE = "/v1/checkout-recovery/:token";
export const CHECKOUT_RECOVERY_UNSUBSCRIBE_ROUTE = "/v1/checkout-recovery/:token/unsubscribe";

export const RECOVERY_IP_SCOPE = "checkout-recovery-ip";
export const RECOVERY_IP_LIMIT = 30;
export const RECOVERY_IP_WINDOW_MS = 10 * 60 * 1_000;

const MAX_LINES = 50;

type Action = "resolve" | "unsubscribe";

/** `/v1/checkout-recovery/<token>` or `…/<token>/unsubscribe` of the RAW path, the token decoded once. */
function parseRecoveryPath(pathname: string): { action: Action; token: string } | null {
  const segments = pathname.split("/");
  if (segments[0] !== "" || segments[1] !== "v1" || segments[2] !== "checkout-recovery") {
    return null;
  }
  const token = decodeSegment(segments[3] ?? "");
  if (token === null) {
    return null;
  }
  if (segments.length === 4) {
    return { action: "resolve", token };
  }
  return segments.length === 5 && segments[4] === "unsubscribe" ? { action: "unsubscribe", token } : null;
}

interface ReminderRow {
  buyer_hash: string;
  checkout_id: string;
  link_expires_at: number;
}

export async function handleCheckoutRecoveryRoute(
  env: Env,
  request: Request,
  // Tests pin the clock; the mounted route always uses the server's.
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return routeNotFoundResponse();
  }

  const now = options.now ?? Date.now();
  const byVisitor = await enforceRateLimit(env.DB, {
    key: visitorRateKey(clientIp(request)),
    limit: RECOVERY_IP_LIMIT,
    now,
    scope: RECOVERY_IP_SCOPE,
    windowMs: RECOVERY_IP_WINDOW_MS,
  });
  if (!byVisitor.allowed) {
    return rateLimitedResponse(byVisitor.retryAfterSeconds);
  }

  const path = parseRecoveryPath(new URL(request.url).pathname);
  const reminderId =
    path === null
      ? null
      : await verifyRecoveryToken(env, tenant.tenantId, path.token, path.action === "resolve" ? "resume" : "unsubscribe");
  if (path === null || reminderId === null) {
    return routeNotFoundResponse();
  }

  // Only a reminder that was queued ever had a mail and so a link.
  const reminder = await env.DB.prepare(
    `SELECT checkout_id, buyer_hash, link_expires_at
     FROM checkout_reminders
     WHERE reminder_id = ? AND tenant_id = ? AND state = 'queued'
     LIMIT 1`,
  )
    .bind(reminderId, tenant.tenantId)
    .first<ReminderRow>();
  if (reminder === null) {
    return routeNotFoundResponse();
  }

  if (path.action === "unsubscribe") {
    return unsubscribe(env.DB, tenant.tenantId, reminderId, reminder, now);
  }
  if (reminder.link_expires_at <= now) {
    return routeNotFoundResponse();
  }
  return resolve(env.DB, tenant.tenantId, reminder);
}

/** The lines of the reminded checkout as references only, or `completed`. Writes nothing. */
async function resolve(db: D1Database, tenantId: string, reminder: ReminderRow): Promise<Response> {
  const order = await db
    .prepare("SELECT 1 AS hit FROM orders WHERE checkout_id = ? AND tenant_id = ? LIMIT 1")
    .bind(reminder.checkout_id, tenantId)
    .first<{ hit: number }>();
  if (order !== null) {
    return jsonResponse({ recovery: { status: "completed" } });
  }
  const lines = await db
    .prepare(
      `SELECT product_id, variant_id, quantity FROM checkout_items
       WHERE checkout_id = ? AND tenant_id = ?
       ORDER BY item_index ASC
       LIMIT ${MAX_LINES}`,
    )
    .bind(reminder.checkout_id, tenantId)
    .all<{ product_id: string; quantity: number; variant_id: string | null }>();
  return jsonResponse({
    recovery: {
      items: lines.results.map((line) =>
        line.variant_id === null
          ? { productId: line.product_id, quantity: line.quantity }
          : { productId: line.product_id, quantity: line.quantity, variantId: line.variant_id },
      ),
      status: "open",
    },
  });
}

/**
 * The address (its hash, the reminder's) leaves this shop's reminders for
 * good (AC14): the suppression and, only when it is new, an audit row with
 * the reminder as resource and no actor, in one batch. Neither holds an
 * address. Answered alike whether it was written now or before.
 */
async function unsubscribe(
  db: D1Database,
  tenantId: string,
  reminderId: string,
  reminder: ReminderRow,
  now: number,
): Promise<Response> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, ?, NULL, 'checkout_reminder.unsubscribe', 'checkout_reminder', ?, ?, NULL, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM checkout_reminder_suppressions WHERE tenant_id = ? AND email_hash = ?
         )`,
      )
      .bind(crypto.randomUUID(), tenantId, reminderId, crypto.randomUUID(), now, tenantId, reminder.buyer_hash),
    db
      .prepare(
        `INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at)
         VALUES (?, ?, 'unsubscribe', ?)
         ON CONFLICT (tenant_id, email_hash) DO NOTHING`,
      )
      .bind(tenantId, reminder.buyer_hash, now),
  ]);
  return jsonResponse({ unsubscribed: true });
}
