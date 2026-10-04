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
import { isInviteConfigured } from "../platform/invites";
import type { MemberRefusal } from "../platform/tenant-members";
import {
  inviteTenantMember,
  listTenantMembers,
  parseInviteMemberInput,
  readInviteTarget,
  resendTenantMemberInvite,
  revokeTenantMember,
  TENANT_ADMIN_CAP,
} from "../platform/tenant-members";
import { parseUserIdSegment } from "../platform/user-directory";

/**
 * A shop's own admins (CP5-WC, D100). Tenant admin of the shop `X-Shop-Id`
 * names — or a platform user acting as it — and the opaque 404 to anyone else.
 * Every POST is same-origin, checked before the body is read.
 *
 *   GET  /v1/admin/members
 *        200 { members: [{ userId, email, name, status, invited, joinedAt, self }] }
 *   POST /v1/admin/members  { email, name }
 *        201 { member } · 400 invalid_request · 409 already_member |
 *        not_addable | member_limit · 429 rate_limited · 503 email_unavailable ·
 *        404 also while the invite mail is not configured (as the platform's
 *        invite route: the surface is dark)
 *   POST /v1/admin/members/:userId/revoke
 *        200 { revoked: { userId } } · 409 cannot_revoke_self | last_admin ·
 *        404 for a user who is not an active admin of this shop
 *   POST /v1/admin/members/:userId/resend-invite   (CP5-WK; no body is read)
 *        202 { invite: { userId, surface: "admin", expiresAt } } — a new link
 *        is queued and the previous unused one is dead · 409 not_invited (the
 *        person has set a password of their own: `invited` is false) |
 *        not_invitable (the platform suspended the identity) · 429
 *        rate_limited · 503 email_unavailable · 404 for a user the list does
 *        not show (unknown, another shop's, revoked — as the revoke), and
 *        while the invite mail is not configured (as the invite)
 *
 * ACTING-AS: admitted for all four, audited with the grant id. The platform
 * already invites and revokes any shop's admins on its own routes
 * (platform-users.ts); refusing it here would only send the operator who
 * helps a locked-out seller to a different page for the same change. The
 * guards still apply to it (the cap, the last admin).
 *
 * THE LIMITER. The platform's invite has none (a platform session is the
 * control there, invites.ts). A seller's invite is a mail any shop can send to
 * any address, so it is limited with the durable limiter (lib/rate-limit.ts)
 * twice: per shop before the body is read, and per recipient address after it
 * is parsed — that one across every shop, so no set of shops can mail-bomb
 * one inbox. Both count every admitted request, accepted or refused.
 * The resend is the same mail and spends from the SAME two buckets (issueInvite
 * has no throttle of its own): per shop before the person is looked up, per
 * address once a link is owed — so a colleague's inbox gets at most
 * MEMBER_INVITE_EMAIL_LIMIT invite mails an hour, adds and resends together.
 */

export const ADMIN_MEMBERS_PATH = "/v1/admin/members";
export const ADMIN_MEMBER_REVOKE_ROUTE = "/v1/admin/members/:userId/revoke";
export const ADMIN_MEMBER_RESEND_INVITE_ROUTE = "/v1/admin/members/:userId/resend-invite";

const HOUR_MS = 60 * 60 * 1_000;
export const MEMBER_INVITE_TENANT_SCOPE = "admin-member-invite-tenant";
export const MEMBER_INVITE_TENANT_LIMIT = 20;
export const MEMBER_INVITE_TENANT_WINDOW_MS = HOUR_MS;
export const MEMBER_INVITE_EMAIL_SCOPE = "admin-member-invite-email";
export const MEMBER_INVITE_EMAIL_LIMIT = 3;
export const MEMBER_INVITE_EMAIL_WINDOW_MS = HOUR_MS;

const REFUSAL_MESSAGES: Record<MemberRefusal, string> = {
  already_member: "The address already administers this shop",
  cannot_revoke_self: "An admin cannot revoke their own access",
  last_admin: "A shop must keep at least one active admin",
  member_limit: `A shop has at most ${TENANT_ADMIN_CAP} active admins`,
  not_addable: "The address cannot be added to this shop",
  not_invitable: "The identity cannot be invited",
  not_invited: "The admin has already set a password",
};

function refusalResponse(reason: MemberRefusal): Response {
  return jsonResponse({ error: { code: reason, message: REFUSAL_MESSAGES[reason] } }, 409);
}

function emailUnavailableResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "email_unavailable",
        message: "The invite email could not be queued",
      },
    },
    503,
  );
}

export async function handleAdminMembersRoute(env: Env, request: Request): Promise<Response> {
  if (request.method === "GET") {
    const principal = await authorizeTenantAdminRequest(env, request);
    if (principal === null) {
      return routeNotFoundResponse();
    }
    const response = jsonResponse({ members: await listTenantMembers(env.DB, principal) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (request.method !== "POST" || !isInviteConfigured(env)) {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const now = Date.now();
  const byShop = await enforceRateLimit(env.DB, {
    key: principal.tenantId,
    limit: MEMBER_INVITE_TENANT_LIMIT,
    now,
    scope: MEMBER_INVITE_TENANT_SCOPE,
    windowMs: MEMBER_INVITE_TENANT_WINDOW_MS,
  });
  if (!byShop.allowed) {
    return rateLimitedResponse(byShop.retryAfterSeconds);
  }

  const input = parseInviteMemberInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  // Keyed on the parsed (lowercased) address: casing cannot mint new buckets.
  const byAddress = await enforceRateLimit(env.DB, {
    key: input.email,
    limit: MEMBER_INVITE_EMAIL_LIMIT,
    now,
    scope: MEMBER_INVITE_EMAIL_SCOPE,
    windowMs: MEMBER_INVITE_EMAIL_WINDOW_MS,
  });
  if (!byAddress.allowed) {
    return rateLimitedResponse(byAddress.retryAfterSeconds);
  }

  const result = await inviteTenantMember(env, principal, input, now);
  switch (result.status) {
    case "ok":
      return jsonResponse({ member: result.member }, 201);
    case "refused":
      return refusalResponse(result.reason);
    case "invalid":
      return invalidRequestResponse();
    case "email_unavailable":
      return emailUnavailableResponse();
  }
}

export async function handleAdminMemberRevokeRoute(
  env: Env,
  request: Request,
  rawUserId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const userId = parseUserIdSegment(rawUserId);
  if (userId === null) {
    return routeNotFoundResponse();
  }

  const result = await revokeTenantMember(env.DB, principal, userId, Date.now());
  if (result.status === "ok") {
    return jsonResponse({ revoked: { userId } });
  }
  return result.status === "refused"
    ? refusalResponse(result.reason)
    : routeNotFoundResponse();
}

export async function handleAdminMemberResendInviteRoute(
  env: Env,
  request: Request,
  rawUserId: string,
): Promise<Response> {
  // Dark without a queue and an allowlist, as the invite (and issueInvite
  // must not be reached without them).
  if (request.method !== "POST" || !isInviteConfigured(env)) {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const userId = parseUserIdSegment(rawUserId);
  if (userId === null) {
    return routeNotFoundResponse();
  }

  const now = Date.now();
  // The shop's invite bucket, before anything about the person is read.
  const byShop = await enforceRateLimit(env.DB, {
    key: principal.tenantId,
    limit: MEMBER_INVITE_TENANT_LIMIT,
    now,
    scope: MEMBER_INVITE_TENANT_SCOPE,
    windowMs: MEMBER_INVITE_TENANT_WINDOW_MS,
  });
  if (!byShop.allowed) {
    return rateLimitedResponse(byShop.retryAfterSeconds);
  }

  const target = await readInviteTarget(env.DB, principal, userId);
  if (target === null) {
    // Exactly the revoke's answer: nothing says the user exists elsewhere.
    return routeNotFoundResponse();
  }
  if (!target.invited) {
    // No mail is owed, so the recipient's bucket is not spent.
    return refusalResponse("not_invited");
  }

  // The add's recipient bucket, keyed as the add keys it (the lowercased
  // address), so adds and resends of one inbox count together across shops.
  const byAddress = await enforceRateLimit(env.DB, {
    key: target.email.toLowerCase(),
    limit: MEMBER_INVITE_EMAIL_LIMIT,
    now,
    scope: MEMBER_INVITE_EMAIL_SCOPE,
    windowMs: MEMBER_INVITE_EMAIL_WINDOW_MS,
  });
  if (!byAddress.allowed) {
    return rateLimitedResponse(byAddress.retryAfterSeconds);
  }

  const result = await resendTenantMemberInvite(env, principal, userId, now);
  switch (result.status) {
    case "ok":
      // Accepted for delivery, as the platform's invite: never the token or the link.
      return jsonResponse({ invite: result.invite }, 202);
    case "refused":
      return refusalResponse(result.reason);
    case "email_unavailable":
      return emailUnavailableResponse();
    case "not_found":
      return routeNotFoundResponse();
  }
}
