import {
  isWithdrawalEmailEffectRunnable,
  parseWithdrawalInput,
  submitWithdrawal,
} from "../commerce/withdrawals";
import { readJsonBodyWithin } from "../legal/legal-pages";
import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  rateLimitedResponse,
  routeNotFoundResponse,
} from "../lib/responses";
import { nudgeOutbox } from "../outbox/nudge";

/**
 * CP4-G — the withdrawal function's intake (DAL 2 kap. 10 a §; D96). A
 * storefront route: mounted inside app.ts's `storefront(...)` wrapper, no
 * session, the tenant from the verified hostname and nothing else.
 *
 *   POST /v1/withdrawals
 *     { orderNumber, statement: { name, contactEmail } }
 *     201 { withdrawal: { acknowledgement, alreadyReceived: false, eligible, reason } }
 *                                  the message is recorded now (eligible or not)
 *     200 { withdrawal: { …, alreadyReceived: true, … } }
 *                                  a message for this order is already on
 *                                  record: ITS receipt, nothing written
 *     400 invalid_request          any malformed body (one answer)
 *     404 (the opaque one)         no such order in this shop, the address is
 *                                  not the purchase address, or the hostname is
 *                                  no verified domain — one answer, same bytes
 *     429 rate_limited             the 11th request from one visitor address
 *                                  within 10 minutes
 *
 * No same-origin check, as for checkout and the report intake: the surface is
 * anonymous by design and carries no ambient credential.
 *
 * ── THE RATE LIMIT (brief rule 2: per visitor address) ─────────────────────
 * The source's 10 per 10 minutes, durable in D1 (the source's was an
 * in-memory counter per instance). It runs BEFORE the body is read, so every
 * attempt counts, the refused ones included, and a flood is refused without
 * the lookup it tries to provoke. The key is CF-Connecting-IP, which the edge
 * sets and the caller cannot (X-Forwarded-For is never read; a request without
 * it shares the one "unknown" bucket, which is stricter, not looser). An IPv6
 * address counts by its /64 — the block one subscriber holds — so rotating
 * addresses inside one's own network buys nothing. The address is the
 * limiter's key only (hashed with its scope) and never reaches the row.
 *
 * DELIBERATELY NO LIMIT PER ORDER NUMBER: any limit keyed on the order would
 * let whoever knows an order number keep its buyer out of the function
 * (10 requests an hour, for as long as they like) — the under-availability
 * the law forbids. Trying out order numbers is bounded by this limit and by
 * the number space (8 random characters of 32 per day); see the report.
 *
 * ── THE TENANT (rule 10 of the brief) ───────────────────────────────────────
 * The hostname's tenant WHATEVER its status: a verified domain of a suspended
 * or closed shop still takes a withdrawal of that shop's orders, because the
 * buyer's right does not end with the shop's state. Only the domain must be
 * verified; the order is always looked up under that one tenant, so an order
 * of another shop is never reachable here.
 */

export const STOREFRONT_WITHDRAWALS_PATH = "/v1/withdrawals";

export const WITHDRAWAL_IP_SCOPE = "withdrawal-ip";
export const WITHDRAWAL_IP_LIMIT = 10;
export const WITHDRAWAL_IP_WINDOW_MS = 10 * 60 * 1_000;

/** The body is three short strings; anything larger is not a withdrawal. */
export const WITHDRAWAL_BODY_MAX_BYTES = 4_096;

const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * The limiter's key for a visitor address: an IPv4 address (or the shared
 * "unknown") as it is, an IPv4-mapped IPv6 address as its IPv4 address, and
 * any other IPv6 address as its /64 prefix in canonical form
 * (`2001:db8:0:1::/64`), so every spelling and every address of one network
 * counts once. Anything that does not parse as IPv6 is keyed as it is.
 */
export function withdrawalRateKey(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(":")) {
    return address;
  }
  const mapped = IPV4_MAPPED.exec(address)?.[1];
  if (mapped !== undefined) {
    return mapped;
  }
  const halves = address.split("::");
  if (halves.length > 2) {
    return address;
  }
  // An embedded IPv4 tail (…:1.2.3.4) is the last 32 bits: two groups.
  const groupsOf = (part: string): string[] =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group]));
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return address;
  }
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  const prefix = groups.slice(0, 4);
  if (prefix.length !== 4 || !prefix.every((group) => IPV6_GROUP.test(group))) {
    return address;
  }
  return `${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}

function requestHostname(request: Request): string | null {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return hostname.length > 0 ? hostname : null;
}

/**
 * The tenant of a verified domain, whatever the tenant's status. The same
 * hostname rule as src/tenancy/resolve-tenant.ts, without its `active`
 * condition (see the header).
 */
export async function resolveWithdrawalTenant(
  db: D1Database,
  request: Request,
): Promise<string | null> {
  const hostname = requestHostname(request);
  if (hostname === null) {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT tenant_id FROM tenant_domains
       WHERE hostname = ? AND status = 'verified'
       LIMIT 1`,
    )
    .bind(hostname)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

export async function handleStorefrontWithdrawalRoute(
  env: Env,
  request: Request,
  // Tests pin the clock; the mounted route always uses the server's.
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const tenantId = await resolveWithdrawalTenant(env.DB, request);
  if (tenantId === null) {
    return routeNotFoundResponse();
  }

  const now = options.now ?? Date.now();
  const byVisitor = await enforceRateLimit(env.DB, {
    key: withdrawalRateKey(clientIp(request)),
    limit: WITHDRAWAL_IP_LIMIT,
    now,
    scope: WITHDRAWAL_IP_SCOPE,
    windowMs: WITHDRAWAL_IP_WINDOW_MS,
  });
  if (!byVisitor.allowed) {
    return rateLimitedResponse(byVisitor.retryAfterSeconds);
  }

  const body = await readJsonBodyWithin(request, WITHDRAWAL_BODY_MAX_BYTES);
  const input = body.status === "ok" ? parseWithdrawalInput(body.value) : null;
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await submitWithdrawal(env.DB, tenantId, input, now);
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "existing") {
    return jsonResponse({ withdrawal: result.withdrawal });
  }

  // The record is committed. The mails are the outbox's from here on: a nudge
  // makes them prompt, the 15-minute sweeper is the backstop, and nothing that
  // happens to either can change this answer. Only a type the consumer runs is
  // nudged (a nudge for any other is retried and dropped).
  if (isWithdrawalEmailEffectRunnable()) {
    await nudgeOutbox(env, result.outboxIds);
  }
  return jsonResponse({ withdrawal: result.withdrawal }, 201);
}
