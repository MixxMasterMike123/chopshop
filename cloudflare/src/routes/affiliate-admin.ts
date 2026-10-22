import {
  parseAdjustmentInput,
  parseIdSegment,
  parseUpdateAffiliateInput,
  recordAdjustment,
  updateAffiliate,
} from "../affiliate/affiliates";
import {
  type ApplicationRow,
  denyApplication,
  listApplications,
  parseApplicationListQuery,
  parseDenyInput,
  readApplication,
} from "../affiliate/applications";
import {
  type AdmitResult,
  approveApplication,
  inviteAffiliate,
  parseApproveInput,
  parseInviteAffiliateInput,
  resendAffiliateInvite,
} from "../affiliate/approval";
import { readBalances } from "../affiliate/ledger";
import {
  listPayouts,
  markPayoutPaid,
  parseMarkPaidInput,
  parsePageQuery,
  parseRecordPayoutInput,
  parseVoidInput,
  type PayoutResult,
  readPayout,
  recordPayout,
  voidPayout,
} from "../affiliate/payouts";
import {
  adminAffiliateAnalytics,
  adminAffiliateDetail,
  adminAffiliateList,
  adminAffiliateOrders,
  ledgerEntries,
  parseAffiliateListQuery,
  parseAnalyticsSince,
  payoutView,
} from "../affiliate/projections";
import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
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
import { isInviteConfigured, isInviteMailConfigured } from "../platform/invites";
import { isFeatureEnabled } from "../platform/tenant-config";
import { revokeAffiliateMembership } from "../platform/user-lifecycle";

/**
 * CP13 — the shop admin's affiliate routes (design §5, §6.2, §7.1, §7.2).
 * Tenant admin of the shop X-Shop-Id names — or a platform user acting as it,
 * audited with the grant (auditMetadataJson) — and the opaque 404 to anyone
 * else, an affiliate's session included. Every state change is same-origin,
 * checked before the body is read.
 *
 * THE ADD-ON (A12, R2-17): the routes marked [gated] answer the opaque 404
 * while the shop's `affiliate` add-on is OFF (no list page, no approvals, no
 * invites, no analytics); the others stay reachable so liabilities can still
 * be settled — an affiliate's detail, edit and removal, its ledger and
 * adjustments, its orders, its payouts (list, record, paid, void).
 *
 * Rates are whole percent in a body (`commissionPercent`, `discountPercent`,
 * 0–100) and basis points in an answer (`commissionBp`, `discountBp`).
 * Money is öre. Every list is bounded and paged (`cursor`, `limit` 1–100).
 *
 *   GET    /v1/admin/affiliates?status=&cursor=&limit=                 [gated]
 *          200 { affiliates: [AdminAffiliateListRow], nextCursor }
 *   POST   /v1/admin/affiliates                                         [gated]
 *          { name, email, code?, commissionPercent?, discountPercent?, preferredLang? }
 *          201 { affiliate: AdminAffiliateDetail, invited, inviteError?, mailConfigured }
 *          (inviteError "email_unavailable" | "not_invitable": the admission
 *          committed but its invite could not be queued — re-send it)
 *   GET    /v1/admin/affiliates/applications?status=&cursor=&limit=    [gated]
 *          200 { applications: [ApplicationView], nextCursor }  (pending first, newest first)
 *   GET    /v1/admin/affiliates/applications/:applicationId            [gated]
 *          200 { application: ApplicationView }
 *   POST   /v1/admin/affiliates/applications/:applicationId/approve    [gated]
 *          { code?, commissionPercent?, discountPercent? }   (defaults 15 / 10)
 *          201 { affiliate: AdminAffiliateDetail, application, invited, inviteError?, mailConfigured }
 *   POST   /v1/admin/affiliates/applications/:applicationId/deny       [gated]
 *          { reason }   200 { application }
 *   GET    /v1/admin/affiliates/analytics?since=                       [gated]
 *          200 { analytics: AffiliateAnalytics }
 *   GET    /v1/admin/affiliates/:affiliateId        200 { affiliate: AdminAffiliateDetail }
 *   PATCH  /v1/admin/affiliates/:affiliateId
 *          { status?, code?, commissionPercent?, discountPercent?, name?, phone?,
 *            addressLine1?, addressLine2?, postalCode?, city?, country?, socials?,
 *            promotionMethod?, preferredLang? }   200 { affiliate }
 *   POST   /v1/admin/affiliates/:affiliateId/invite                    [gated]
 *          202 { mailConfigured }   a new link for a person without a password
 *   POST   /v1/admin/affiliates/:affiliateId/revoke  ("Ta bort")
 *          200 { affiliate }   inactive + the membership revoked; nothing deleted
 *   POST   /v1/admin/affiliates/:affiliateId/adjustments  { amountMinor (≠ 0), reason }
 *          201 { entry: LedgerEntryView }
 *   GET    /v1/admin/affiliates/:affiliateId/ledger?cursor=&limit=
 *          200 { entries: [LedgerEntryView], nextCursor }
 *   GET    /v1/admin/affiliates/:affiliateId/orders?cursor=&limit=
 *          200 { orders: [AdminAffiliateOrder], nextCursor }
 *   GET    /v1/admin/affiliates/:affiliateId/payouts?cursor=&limit=
 *          200 { balances: [AffiliateBalance], payouts: [PayoutView], nextCursor }
 *   POST   /v1/admin/affiliates/:affiliateId/payouts
 *          { amountMinor, invoiceNumber?, invoiceObjectId?, reference?, notes? }
 *          201 { payout: PayoutView }   recorded requested AND paid
 *   POST   /v1/admin/affiliates/payouts/:payoutId/paid  { reference?, notes? }
 *          200 { payout }
 *   POST   /v1/admin/affiliates/payouts/:payoutId/void  { reason }
 *          200 { payout }
 *
 *   400 invalid_request (a code: with `reason` "code_invalid" | "code_reserved")
 *   404 the opaque one
 *   409 { error: { code } }: code_taken | not_addable | already_affiliate |
 *       already_decided | not_invited | not_invitable | payout_open |
 *       insufficient_balance | invalid_invoice | payout_not_open
 *   429 rate_limited (invites: 20 per shop and 3 per address an hour, the
 *       members' buckets' rule)
 *   503 email_unavailable
 */

export const ADMIN_AFFILIATES_PATH = "/v1/admin/affiliates";
export const ADMIN_AFFILIATE_APPLICATIONS_PATH = "/v1/admin/affiliates/applications";
export const ADMIN_AFFILIATE_ANALYTICS_PATH = "/v1/admin/affiliates/analytics";
export const ADMIN_AFFILIATE_APPLICATION_ROUTE = "/v1/admin/affiliates/applications/:applicationId";
export const ADMIN_AFFILIATE_APPROVE_ROUTE = "/v1/admin/affiliates/applications/:applicationId/approve";
export const ADMIN_AFFILIATE_DENY_ROUTE = "/v1/admin/affiliates/applications/:applicationId/deny";
export const ADMIN_AFFILIATE_PAYOUT_PAID_ROUTE = "/v1/admin/affiliates/payouts/:payoutId/paid";
export const ADMIN_AFFILIATE_PAYOUT_VOID_ROUTE = "/v1/admin/affiliates/payouts/:payoutId/void";
export const ADMIN_AFFILIATE_ROUTE = "/v1/admin/affiliates/:affiliateId";
export const ADMIN_AFFILIATE_INVITE_ROUTE = "/v1/admin/affiliates/:affiliateId/invite";
export const ADMIN_AFFILIATE_REVOKE_ROUTE = "/v1/admin/affiliates/:affiliateId/revoke";
export const ADMIN_AFFILIATE_ADJUSTMENTS_ROUTE = "/v1/admin/affiliates/:affiliateId/adjustments";
export const ADMIN_AFFILIATE_LEDGER_ROUTE = "/v1/admin/affiliates/:affiliateId/ledger";
export const ADMIN_AFFILIATE_ORDERS_ROUTE = "/v1/admin/affiliates/:affiliateId/orders";
export const ADMIN_AFFILIATE_PAYOUTS_ROUTE = "/v1/admin/affiliates/:affiliateId/payouts";

const HOUR_MS = 60 * 60 * 1_000;
export const AFFILIATE_INVITE_TENANT_SCOPE = "affiliate-invite-tenant";
export const AFFILIATE_INVITE_TENANT_LIMIT = 20;
export const AFFILIATE_INVITE_EMAIL_SCOPE = "affiliate-invite-email";
export const AFFILIATE_INVITE_EMAIL_LIMIT = 3;

type Handler = (env: Env, request: Request, segment: string) => Promise<Response>;

/** The route table app.ts mounts (CP13-ROUTES-A1): exact patterns, literal paths before `:affiliateId`. */
export const AFFILIATE_ADMIN_ROUTES: ReadonlyArray<{
  handler: Handler;
  methods: readonly string[];
  path: string;
  /** The raw path segment the handler reads its id from (index after splitting on "/"). */
  segment: number;
}> = [
  { handler: (env, request) => handleList(env, request), methods: ["GET", "POST"], path: ADMIN_AFFILIATES_PATH, segment: 0 },
  { handler: (env, request) => handleApplications(env, request), methods: ["GET"], path: ADMIN_AFFILIATE_APPLICATIONS_PATH, segment: 0 },
  { handler: (env, request) => handleAnalytics(env, request), methods: ["GET"], path: ADMIN_AFFILIATE_ANALYTICS_PATH, segment: 0 },
  { handler: handleApplication, methods: ["GET"], path: ADMIN_AFFILIATE_APPLICATION_ROUTE, segment: 5 },
  { handler: handleApprove, methods: ["POST"], path: ADMIN_AFFILIATE_APPROVE_ROUTE, segment: 5 },
  { handler: handleDeny, methods: ["POST"], path: ADMIN_AFFILIATE_DENY_ROUTE, segment: 5 },
  { handler: handlePaid, methods: ["POST"], path: ADMIN_AFFILIATE_PAYOUT_PAID_ROUTE, segment: 5 },
  { handler: handleVoid, methods: ["POST"], path: ADMIN_AFFILIATE_PAYOUT_VOID_ROUTE, segment: 5 },
  { handler: handleAffiliate, methods: ["GET", "PATCH"], path: ADMIN_AFFILIATE_ROUTE, segment: 4 },
  { handler: handleResend, methods: ["POST"], path: ADMIN_AFFILIATE_INVITE_ROUTE, segment: 4 },
  { handler: handleRevoke, methods: ["POST"], path: ADMIN_AFFILIATE_REVOKE_ROUTE, segment: 4 },
  { handler: handleAdjustment, methods: ["POST"], path: ADMIN_AFFILIATE_ADJUSTMENTS_ROUTE, segment: 4 },
  { handler: handleLedger, methods: ["GET"], path: ADMIN_AFFILIATE_LEDGER_ROUTE, segment: 4 },
  { handler: handleOrders, methods: ["GET"], path: ADMIN_AFFILIATE_ORDERS_ROUTE, segment: 4 },
  { handler: handlePayouts, methods: ["GET", "POST"], path: ADMIN_AFFILIATE_PAYOUTS_ROUTE, segment: 4 },
];

const MESSAGES: Record<string, string> = {
  already_affiliate: "The address is already an active affiliate of this shop",
  already_decided: "The application has already been decided",
  code_taken: "The code is taken by an affiliate or a discount code of this shop",
  insufficient_balance: "The amount exceeds what is payable",
  invalid_invoice: "The invoice cannot be attached",
  not_addable: "Adressen används redan av ett annat konto på plattformen.",
  not_invitable: "The affiliate cannot be invited",
  not_invited: "The affiliate has already set a password",
  payout_not_open: "The payout is not an open request",
  payout_open: "An open payout request exists",
};

function refused(code: string): Response {
  return jsonResponse({ error: { code, message: MESSAGES[code] ?? "The request was refused" } }, 409);
}

function emailUnavailable(): Response {
  return jsonResponse({ error: { code: "email_unavailable", message: "The invite email could not be queued" } }, 503);
}

function codeRefused(reason: string): Response {
  return jsonResponse({ error: { code: "invalid_request", message: "Request is not valid", reason } }, 400);
}

/** Authorization, then the origin of a state change, then (when `gated`) the add-on. */
async function guard(env: Env, request: Request, gated: boolean): Promise<TenantAdminPrincipal | null> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return null;
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return null;
  }
  if (gated && !(await isFeatureEnabled(env.DB, principal.tenantId, "affiliate"))) {
    return null;
  }
  return principal;
}

/** The two invite buckets (per shop before the body, per address after it). */
async function inviteLimit(env: Env, key: string, scope: "email" | "tenant", now: number): Promise<Response | null> {
  const decision = await enforceRateLimit(env.DB, {
    key,
    limit: scope === "tenant" ? AFFILIATE_INVITE_TENANT_LIMIT : AFFILIATE_INVITE_EMAIL_LIMIT,
    now,
    scope: scope === "tenant" ? AFFILIATE_INVITE_TENANT_SCOPE : AFFILIATE_INVITE_EMAIL_SCOPE,
    windowMs: HOUR_MS,
  });
  return decision.allowed ? null : rateLimitedResponse(decision.retryAfterSeconds);
}

export interface ApplicationView {
  affiliateId: string | null;
  applicationId: string;
  createdAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  email: string;
  message: string | null;
  name: string;
  phone: string | null;
  preferredLang: string;
  promotionMethod: string;
  socials: Record<string, string>;
  status: string;
  termsAcceptedAt: string;
  termsVersion: string;
}

function applicationView(row: ApplicationRow): ApplicationView {
  let socials: Record<string, string> = {};
  try {
    const parsed: unknown = row.socials_json === null ? {} : JSON.parse(row.socials_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      socials = Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
  } catch {
    socials = {};
  }
  return {
    affiliateId: row.affiliate_id,
    applicationId: row.application_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    email: row.email,
    message: row.message,
    name: row.name,
    phone: row.phone,
    preferredLang: row.preferred_lang,
    promotionMethod: row.promotion_method,
    socials,
    status: row.status,
    termsAcceptedAt: row.terms_accepted_at,
    termsVersion: row.terms_version,
  };
}

/** An admission's answer (approve and invite). */
async function admitted(env: Env, principal: TenantAdminPrincipal, result: AdmitResult, extra: Record<string, unknown>): Promise<Response> {
  switch (result.status) {
    case "ok": {
      await nudgeOutbox(env, result.outboxIds);
      const affiliate = await adminAffiliateDetail(env, principal.tenantId, result.affiliateId, Date.now());
      return jsonResponse(
        {
          ...extra,
          affiliate,
          invited: result.invited,
          ...(result.inviteError === undefined ? {} : { inviteError: result.inviteError }),
          mailConfigured: isInviteMailConfigured(env),
        },
        201,
      );
    }
    case "refused":
      return refused(result.reason);
    case "email_unavailable":
      return emailUnavailable();
    case "invalid":
      return invalidRequestResponse();
    case "not_found":
      return routeNotFoundResponse();
  }
}

async function handleList(env: Env, request: Request): Promise<Response> {
  if (request.method === "POST" && !isInviteConfigured(env)) {
    return routeNotFoundResponse();
  }
  const principal = await guard(env, request, true);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const now = Date.now();
  if (request.method === "GET") {
    const query = parseAffiliateListQuery(new URL(request.url));
    return query === null ? invalidRequestResponse() : jsonResponse(await adminAffiliateList(env.DB, principal.tenantId, query, now));
  }
  const byShop = await inviteLimit(env, principal.tenantId, "tenant", now);
  if (byShop !== null) {
    return byShop;
  }
  const parsed = parseInviteAffiliateInput(await readJsonBody(request), principal.tenantId);
  if (parsed === null) {
    return invalidRequestResponse();
  }
  if ("refusal" in parsed) {
    return codeRefused(parsed.refusal);
  }
  const byAddress = await inviteLimit(env, parsed.input.email, "email", now);
  if (byAddress !== null) {
    return byAddress;
  }
  return admitted(env, principal, await inviteAffiliate(env, principal, parsed.input, now), {});
}

async function handleApplications(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request, true);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const query = parseApplicationListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  const list = await listApplications(env.DB, principal.tenantId, query);
  return jsonResponse({ applications: list.applications.map(applicationView), nextCursor: list.nextCursor });
}

async function handleAnalytics(env: Env, request: Request): Promise<Response> {
  const principal = await guard(env, request, true);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const now = Date.now();
  const since = parseAnalyticsSince(new URL(request.url), now);
  if (since === null) {
    return invalidRequestResponse();
  }
  return jsonResponse({ analytics: await adminAffiliateAnalytics(env.DB, principal.tenantId, since, now) });
}

async function handleApplication(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, true);
  const applicationId = parseIdSegment(raw);
  if (principal === null || applicationId === null) {
    return routeNotFoundResponse();
  }
  const row = await readApplication(env.DB, principal.tenantId, applicationId);
  return row === null ? routeNotFoundResponse() : jsonResponse({ application: applicationView(row) });
}

async function handleApprove(env: Env, request: Request, raw: string): Promise<Response> {
  if (!isInviteConfigured(env)) {
    return routeNotFoundResponse();
  }
  const principal = await guard(env, request, true);
  const applicationId = parseIdSegment(raw);
  if (principal === null || applicationId === null) {
    return routeNotFoundResponse();
  }
  const now = Date.now();
  const byShop = await inviteLimit(env, principal.tenantId, "tenant", now);
  if (byShop !== null) {
    return byShop;
  }
  const parsed = parseApproveInput(await readJsonBody(request), principal.tenantId);
  if (parsed === null) {
    return invalidRequestResponse();
  }
  if ("refusal" in parsed) {
    return codeRefused(parsed.refusal);
  }
  const result = await approveApplication(env, principal, applicationId, parsed.terms, now);
  const application = await readApplication(env.DB, principal.tenantId, applicationId);
  return admitted(env, principal, result, { application: application === null ? null : applicationView(application) });
}

async function handleDeny(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, true);
  const applicationId = parseIdSegment(raw);
  if (principal === null || applicationId === null) {
    return routeNotFoundResponse();
  }
  const input = parseDenyInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await denyApplication(env.DB, principal, applicationId, input.reason, Date.now());
  if (result.status !== "ok") {
    return result.status === "not_found" ? routeNotFoundResponse() : refused("already_decided");
  }
  await nudgeOutbox(env, [result.outboxId]);
  const row = await readApplication(env.DB, principal.tenantId, applicationId);
  return row === null ? routeNotFoundResponse() : jsonResponse({ application: applicationView(row) });
}

async function affiliateAnswer(env: Env, principal: TenantAdminPrincipal, affiliateId: string): Promise<Response> {
  const affiliate = await adminAffiliateDetail(env, principal.tenantId, affiliateId, Date.now());
  return affiliate === null ? routeNotFoundResponse() : jsonResponse({ affiliate });
}

async function handleAffiliate(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const affiliateId = parseIdSegment(raw);
  if (principal === null || affiliateId === null) {
    return routeNotFoundResponse();
  }
  if (request.method === "GET") {
    return affiliateAnswer(env, principal, affiliateId);
  }
  const parsed = parseUpdateAffiliateInput(await readJsonBody(request), principal.tenantId);
  if (parsed === null) {
    return invalidRequestResponse();
  }
  if ("refusal" in parsed) {
    return codeRefused(parsed.refusal);
  }
  const result = await updateAffiliate(env.DB, principal, affiliateId, parsed.input, Date.now());
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status !== "ok") {
    return refused(result.status);
  }
  return affiliateAnswer(env, principal, affiliateId);
}

async function handleResend(env: Env, request: Request, raw: string): Promise<Response> {
  if (!isInviteConfigured(env)) {
    return routeNotFoundResponse();
  }
  const principal = await guard(env, request, true);
  const affiliateId = parseIdSegment(raw);
  if (principal === null || affiliateId === null) {
    return routeNotFoundResponse();
  }
  const now = Date.now();
  const byShop = await inviteLimit(env, principal.tenantId, "tenant", now);
  if (byShop !== null) {
    return byShop;
  }
  const email = await env.DB
    .prepare(
      `SELECT u."email" AS email FROM affiliates AS a INNER JOIN "user" AS u ON u."id" = a.user_id
       WHERE a.affiliate_id = ? AND a.tenant_id = ? LIMIT 1`,
    )
    .bind(affiliateId, principal.tenantId)
    .first<{ email: string }>();
  if (email === null) {
    return routeNotFoundResponse();
  }
  const byAddress = await inviteLimit(env, email.email, "email", now);
  if (byAddress !== null) {
    return byAddress;
  }
  const result = await resendAffiliateInvite(env, principal, affiliateId, now);
  switch (result.status) {
    case "ok":
      return jsonResponse({ mailConfigured: isInviteMailConfigured(env) }, 202);
    case "refused":
      return refused(result.reason);
    case "email_unavailable":
      return emailUnavailable();
    case "not_found":
      return routeNotFoundResponse();
  }
}

async function handleRevoke(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const affiliateId = parseIdSegment(raw);
  if (principal === null || affiliateId === null) {
    return routeNotFoundResponse();
  }
  const result = await revokeAffiliateMembership(env.DB, principal, affiliateId, Date.now());
  return result.status === "ok" ? affiliateAnswer(env, principal, affiliateId) : routeNotFoundResponse();
}

async function handleAdjustment(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const affiliateId = parseIdSegment(raw);
  if (principal === null || affiliateId === null) {
    return routeNotFoundResponse();
  }
  const input = parseAdjustmentInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await recordAdjustment(env.DB, principal, affiliateId, input, Date.now());
  if (result.status !== "ok") {
    return routeNotFoundResponse();
  }
  const { entries } = await ledgerEntries(env.DB, principal.tenantId, affiliateId, { cursor: null, limit: 100 });
  const entry = entries.find((row) => row.entryId === result.entryId);
  return entry === undefined ? routeNotFoundResponse() : jsonResponse({ entry }, 201);
}

async function existingAffiliate(env: Env, principal: TenantAdminPrincipal, affiliateId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT 1 AS present FROM affiliates WHERE affiliate_id = ? AND tenant_id = ? LIMIT 1")
    .bind(affiliateId, principal.tenantId)
    .first<{ present: number }>();
  return row !== null;
}

async function handleLedger(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const affiliateId = parseIdSegment(raw);
  if (principal === null || affiliateId === null || !(await existingAffiliate(env, principal, affiliateId))) {
    return routeNotFoundResponse();
  }
  const page = parsePageQuery(new URL(request.url));
  return page === null ? invalidRequestResponse() : jsonResponse(await ledgerEntries(env.DB, principal.tenantId, affiliateId, page));
}

async function handleOrders(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const affiliateId = parseIdSegment(raw);
  if (principal === null || affiliateId === null || !(await existingAffiliate(env, principal, affiliateId))) {
    return routeNotFoundResponse();
  }
  const page = parsePageQuery(new URL(request.url));
  return page === null
    ? invalidRequestResponse()
    : jsonResponse(await adminAffiliateOrders(env.DB, principal.tenantId, affiliateId, page, Date.now()));
}

async function payoutAnswer(env: Env, principal: TenantAdminPrincipal, result: PayoutResult, status: number): Promise<Response> {
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "refused") {
    return refused(result.reason);
  }
  await nudgeOutbox(env, result.outboxIds);
  const payout = await readPayout(env.DB, principal.tenantId, result.payoutId);
  return payout === null ? routeNotFoundResponse() : jsonResponse({ payout: payoutView(payout) }, status);
}

async function handlePayouts(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const affiliateId = parseIdSegment(raw);
  if (principal === null || affiliateId === null) {
    return routeNotFoundResponse();
  }
  const now = Date.now();
  if (request.method === "GET") {
    const currency = await env.DB
      .prepare("SELECT currency FROM affiliates WHERE affiliate_id = ? AND tenant_id = ? LIMIT 1")
      .bind(affiliateId, principal.tenantId)
      .first<{ currency: string }>();
    if (currency === null) {
      return routeNotFoundResponse();
    }
    const page = parsePageQuery(new URL(request.url));
    if (page === null) {
      return invalidRequestResponse();
    }
    const list = await listPayouts(env.DB, principal.tenantId, affiliateId, page);
    return jsonResponse({
      balances: await readBalances(env.DB, principal.tenantId, affiliateId, currency.currency, now),
      nextCursor: list.nextCursor,
      payouts: list.payouts.map(payoutView),
    });
  }
  const input = parseRecordPayoutInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return payoutAnswer(env, principal, await recordPayout(env.DB, principal, affiliateId, input, now), 201);
}

async function handlePaid(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const payoutId = parseIdSegment(raw);
  if (principal === null || payoutId === null) {
    return routeNotFoundResponse();
  }
  const input = parseMarkPaidInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return payoutAnswer(env, principal, await markPayoutPaid(env.DB, principal, payoutId, input, Date.now()), 200);
}

async function handleVoid(env: Env, request: Request, raw: string): Promise<Response> {
  const principal = await guard(env, request, false);
  const payoutId = parseIdSegment(raw);
  if (principal === null || payoutId === null) {
    return routeNotFoundResponse();
  }
  const input = parseVoidInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return payoutAnswer(env, principal, await voidPayout(env.DB, principal, payoutId, input.reason, Date.now()), 200);
}
