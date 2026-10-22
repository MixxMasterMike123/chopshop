import { parseUpdateAffiliateInput, type UpdateAffiliateInput } from "../affiliate/affiliates";
import {
  listPayouts,
  parsePageQuery,
  parseRequestPayoutInput,
  readPayout,
  requestPayout,
} from "../affiliate/payouts";
import {
  ledgerEntries,
  portalAffiliateOrders,
  portalMe,
  portalPayoutView,
} from "../affiliate/projections";
import { readCurrentAffiliateTerms, renderAffiliateTerms } from "../affiliate/terms";
import type { AffiliatePrincipal } from "../auth/live-authorization";
import { authorizeAffiliateRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import { enforceRateLimit } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  rateLimitedResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { nudgeOutbox } from "../outbox/nudge";
import {
  deliverAffiliateInvoice,
  parseAffiliateInvoiceReserveInput,
  reserveAffiliateInvoice,
  uploadAffiliateInvoice,
} from "../storage/object-routes";
import { parseIdSegment } from "../affiliate/affiliates";

/**
 * CP13 — the affiliate portal's API (design §7.1, §7.3), on the ADMIN host
 * (the admin Worker forwards `/_api/v1/affiliate/*` with the session cookie
 * and X-Shop-Id). Every route authorizes FIRST (authorizeAffiliateRequest:
 * the session's active affiliate identity, an active `affiliate` membership
 * of the shop X-Shop-Id names, the shop active) and answers the opaque 404 to
 * anyone else — a shop admin's session included; every state change also
 * demands a same-origin request, before the body is read. The portal is
 * gated on the MEMBERSHIP, never on the add-on (A12: with the program
 * paused, the affiliate still logs in, reads the ledger and requests a
 * payout). Every answer is `Cache-Control: no-store` (jsonResponse).
 *
 *   GET   /v1/affiliate/me
 *         200 { affiliate: PortalMe }
 *   GET   /v1/affiliate/orders?cursor=&limit=     (1–100, default 50)
 *         200 { orders: [{ orderNumber, paidAt, baseMinor, commissionMinor,
 *                          state: "held"|"payable"|"reversed"|"none", currency }],
 *               nextCursor }
 *   GET   /v1/affiliate/ledger?cursor=&limit=
 *         200 { entries: [LedgerEntryView], nextCursor }
 *   GET   /v1/affiliate/payouts?cursor=&limit=
 *         200 { payouts: [PortalPayoutView], nextCursor }
 *   POST  /v1/affiliate/payouts { amountMinor?, invoiceObjectId?, invoiceNumber? }
 *         201 { payout: PortalPayoutView }
 *         409 payout_open | insufficient_balance | profile_incomplete |
 *             terms_required | invalid_invoice
 *   GET   /v1/affiliate/payouts/:payoutId/invoice   the PDF (a download)
 *   PATCH /v1/affiliate/profile { name?, phone?, addressLine1?, addressLine2?,
 *                                 postalCode?, city?, country?, socials?,
 *                                 preferredLang? }
 *         200 { affiliate: PortalMe }
 *   GET   /v1/affiliate/terms
 *         200 { terms: { version, publishedAt, sha256, text, accepted } }
 *   POST  /v1/affiliate/terms/accept { version }   (the CURRENT version)
 *         200 { terms: { … accepted: true } } · 409 terms_changed (the version
 *         is not the current one: re-read and accept again)
 *   POST  /v1/affiliate/objects { contentType: "application/pdf", sha256,
 *                                 sizeBytes (≤ 10 MB), fileName? }
 *         201 { object: { objectId } } · 409 too_many_pending_invoices (5
 *         loose ones: pending, or attached to no payout) · 429 rate_limited
 *         (20 reservations a day per affiliate)
 *   PUT   /v1/affiliate/objects/:objectId/content   the PDF's bytes
 *         200 { object: { objectId, status, sizeBytes, sha256 } } · 400
 *         invalid_request (with `reason` when the bytes are not a PDF or not
 *         as declared) · 409 conflict · 413 payload_too_large
 */

export const AFFILIATE_INVOICE_RESERVE_SCOPE = "affiliate-invoice";
export const AFFILIATE_INVOICE_RESERVE_LIMIT = 20;
export const AFFILIATE_INVOICE_RESERVE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const AFFILIATE_PORTAL_ME_PATH = "/v1/affiliate/me";
export const AFFILIATE_PORTAL_ORDERS_PATH = "/v1/affiliate/orders";
export const AFFILIATE_PORTAL_LEDGER_PATH = "/v1/affiliate/ledger";
export const AFFILIATE_PORTAL_PAYOUTS_PATH = "/v1/affiliate/payouts";
export const AFFILIATE_PORTAL_PAYOUT_INVOICE_ROUTE = "/v1/affiliate/payouts/:payoutId/invoice";
export const AFFILIATE_PORTAL_PROFILE_PATH = "/v1/affiliate/profile";
export const AFFILIATE_PORTAL_TERMS_PATH = "/v1/affiliate/terms";
export const AFFILIATE_PORTAL_TERMS_ACCEPT_PATH = "/v1/affiliate/terms/accept";
export const AFFILIATE_PORTAL_OBJECTS_PATH = "/v1/affiliate/objects";
export const AFFILIATE_PORTAL_OBJECT_CONTENT_ROUTE = "/v1/affiliate/objects/:objectId/content";

function refused(code: string, status = 409): Response {
  return jsonResponse({ error: { code, message: "The request was refused" } }, status);
}

/** Authorization first; a state change also proves its origin. */
async function guard(env: Env, request: Request): Promise<AffiliatePrincipal | null> {
  const principal = await authorizeAffiliateRequest(env, request);
  if (principal === null) {
    return null;
  }
  return request.method === "GET" || isSameOriginRequest(request) ? principal : null;
}

export async function handleAffiliatePortalMeRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const me = await portalMe(env, principal, Date.now());
  return me === null ? routeNotFoundResponse() : jsonResponse({ affiliate: me });
}

export async function handleAffiliatePortalOrdersRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const page = parsePageQuery(new URL(request.url));
  if (page === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await portalAffiliateOrders(env.DB, principal, page, Date.now()));
}

export async function handleAffiliatePortalLedgerRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const page = parsePageQuery(new URL(request.url));
  if (page === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await ledgerEntries(env.DB, principal.tenantId, principal.affiliateId, page));
}

export async function handleAffiliatePortalPayoutsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  if (request.method === "GET") {
    const page = parsePageQuery(new URL(request.url));
    if (page === null) {
      return invalidRequestResponse();
    }
    const list = await listPayouts(env.DB, principal.tenantId, principal.affiliateId, page);
    return jsonResponse({ nextCursor: list.nextCursor, payouts: list.payouts.map(portalPayoutView) });
  }
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const input = parseRequestPayoutInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const now = Date.now();
  const result = await requestPayout(env.DB, principal, input, now);
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "refused") {
    return refused(result.reason);
  }
  await nudgeOutbox(env, result.outboxIds);
  const payout = await readPayout(env.DB, principal.tenantId, result.payoutId);
  return payout === null ? routeNotFoundResponse() : jsonResponse({ payout: portalPayoutView(payout) }, 201);
}

export async function handleAffiliatePortalPayoutInvoiceRoute(
  env: Env,
  request: Request,
  rawPayoutId: string,
): Promise<Response> {
  const principal = await guard(env, request);
  const payoutId = parseIdSegment(rawPayoutId);
  if (principal === null || request.method !== "GET" || payoutId === null) {
    return routeNotFoundResponse();
  }
  return (await deliverAffiliateInvoice(env, env.DB, principal, payoutId)) ?? routeNotFoundResponse();
}

/** The affiliate's own fields (never the code, rates or status: the shop's). */
const PROFILE_FIELDS: ReadonlyArray<keyof UpdateAffiliateInput> = [
  "addressLine1",
  "addressLine2",
  "city",
  "country",
  "name",
  "phone",
  "postalCode",
  "preferredLang",
  "socialsJson",
];

export async function handleAffiliatePortalProfileRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null || request.method !== "PATCH") {
    return routeNotFoundResponse();
  }
  const body = await readJsonBody(request);
  if (
    typeof body !== "object" ||
    body === null ||
    ["code", "commissionPercent", "discountPercent", "promotionMethod", "status"].some((key) => key in body)
  ) {
    return invalidRequestResponse();
  }
  const parsed = parseUpdateAffiliateInput(body, principal.tenantId);
  if (parsed === null || "refusal" in parsed) {
    return invalidRequestResponse();
  }
  const fields = PROFILE_FIELDS.filter((key) => parsed.input[key] !== undefined);
  if (fields.length === 0) {
    return invalidRequestResponse();
  }
  const columns: Record<string, string> = {
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    city: "city",
    country: "country",
    name: "name",
    phone: "phone",
    postalCode: "postal_code",
    preferredLang: "preferred_lang",
    socialsJson: "socials_json",
  };
  const now = Date.now();
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE affiliates SET ${[...fields.map((key) => `${columns[key]} = ?`), "updated_at = MAX(updated_at, ?)"].join(", ")}
         WHERE affiliate_id = ? AND tenant_id = ?`,
      )
      .bind(...fields.map((key) => parsed.input[key] ?? null), new Date(now).toISOString(), principal.affiliateId, principal.tenantId),
    // The fields named, never their values.
    env.DB
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'affiliate.profile_update', 'affiliate', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.tenantId,
        principal.userId,
        principal.affiliateId,
        crypto.randomUUID(),
        JSON.stringify({ fields: [...fields].sort() }),
        now,
      ),
  ]);
  const me = await portalMe(env, principal, now);
  return me === null ? routeNotFoundResponse() : jsonResponse({ affiliate: me });
}

async function termsAnswer(env: Env, principal: AffiliatePrincipal, now: number) {
  const terms = await readCurrentAffiliateTerms(env.DB, now);
  const row = await env.DB
    .prepare(
      `SELECT a.commission_bp, a.discount_bp, a.terms_version, t.shop_name, t.support_email
       FROM affiliates AS a INNER JOIN tenants AS t ON t.tenant_id = a.tenant_id
       WHERE a.affiliate_id = ? AND a.tenant_id = ? LIMIT 1`,
    )
    .bind(principal.affiliateId, principal.tenantId)
    .first<{
      commission_bp: number;
      discount_bp: number;
      shop_name: string | null;
      support_email: string | null;
      terms_version: string | null;
    }>();
  if (terms === null || row === null) {
    return null;
  }
  return {
    accepted: row.terms_version === terms.version,
    publishedAt: terms.publishedAt,
    sha256: terms.sha256,
    text: renderAffiliateTerms({
      commissionBp: row.commission_bp,
      discountBp: row.discount_bp,
      shopName: row.shop_name,
      supportEmail: row.support_email,
    }),
    version: terms.version,
  };
}

export async function handleAffiliatePortalTermsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const terms = await termsAnswer(env, principal, Date.now());
  return terms === null ? routeNotFoundResponse() : jsonResponse({ terms });
}

/**
 * The acceptance (design §8): the CURRENT version only, recorded on the
 * affiliate row (version, time) with an audit row per acceptance carrying the
 * hash of the accepted text. A stale version is `terms_changed`.
 */
export async function handleAffiliatePortalTermsAcceptRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const body = await readJsonBody(request);
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !Object.keys(body).every((key) => key === "version") ||
    typeof (body as { version?: unknown }).version !== "string"
  ) {
    return invalidRequestResponse();
  }
  const now = Date.now();
  const current = await readCurrentAffiliateTerms(env.DB, now);
  if (current === null || current.version !== (body as { version: string }).version) {
    return refused("terms_changed");
  }
  const nowIso = new Date(now).toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE affiliates SET terms_version = ?, terms_accepted_at = ?, updated_at = MAX(updated_at, ?)
         WHERE affiliate_id = ? AND tenant_id = ?`,
      )
      .bind(current.version, nowIso, nowIso, principal.affiliateId, principal.tenantId),
    env.DB
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'affiliate.terms_accept', 'affiliate', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.tenantId,
        principal.userId,
        principal.affiliateId,
        crypto.randomUUID(),
        JSON.stringify({ sha256: current.sha256, version: current.version }),
        now,
      ),
  ]);
  const terms = await termsAnswer(env, principal, now);
  return terms === null ? routeNotFoundResponse() : jsonResponse({ terms });
}

export async function handleAffiliatePortalObjectsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request);
  if (principal === null || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  // A1 round 1: 20 reservations a day per affiliate (durable, 0008), before
  // the body is read; the loose-invoice cap is the reservation's own guard.
  const now = Date.now();
  const limit = await enforceRateLimit(env.DB, {
    key: principal.affiliateId,
    limit: AFFILIATE_INVOICE_RESERVE_LIMIT,
    now,
    scope: AFFILIATE_INVOICE_RESERVE_SCOPE,
    windowMs: AFFILIATE_INVOICE_RESERVE_WINDOW_MS,
  });
  if (!limit.allowed) {
    return rateLimitedResponse(limit.retryAfterSeconds);
  }
  const input = parseAffiliateInvoiceReserveInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const reserved = await reserveAffiliateInvoice(env.DB, principal, input, now);
  if (reserved.status === "conflict") {
    return refused("conflict");
  }
  if (reserved.status === "too_many_pending_invoices") {
    return refused("too_many_pending_invoices");
  }
  if (reserved.status !== "ok") {
    return invalidRequestResponse();
  }
  // The key is internal addressing; the affiliate gets the id only.
  return jsonResponse({ object: { objectId: reserved.object.objectId } }, 201);
}

export async function handleAffiliatePortalObjectContentRoute(
  env: Env,
  request: Request,
  rawObjectId: string,
): Promise<Response> {
  const principal = await guard(env, request);
  const objectId = parseIdSegment(rawObjectId);
  if (principal === null || request.method !== "PUT" || objectId === null) {
    return routeNotFoundResponse();
  }
  const uploaded = await uploadAffiliateInvoice(env, env.DB, principal, objectId, request, Date.now());
  switch (uploaded.status) {
    case "ok":
      return jsonResponse({
        object: {
          objectId: uploaded.object.objectId,
          sha256: uploaded.object.sha256,
          sizeBytes: uploaded.object.sizeBytes,
          status: uploaded.object.status,
        },
      });
    case "conflict":
      return refused("conflict");
    case "too_large":
      return jsonResponse({ error: { code: "payload_too_large", message: "Upload exceeds the maximum allowed size" } }, 413);
    case "invalid":
      return uploaded.reason === undefined
        ? invalidRequestResponse()
        : jsonResponse({ error: { code: "invalid_request", message: "Request is not valid", reason: uploaded.reason } }, 400);
    default:
      return routeNotFoundResponse();
  }
}
