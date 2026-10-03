import { auditMetadataJson } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import { routeNotFoundResponse } from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { mintPreviewGrant } from "../storefront/preview";

/**
 * CP4-D2 — the preview of an unpublished shop (D57): the grant.
 *
 *   POST /v1/admin/preview          (no body is read)
 *        200 { preview: { grant, expiresAt } }
 *            grant      "v1.<expiresAtMs>.<signature>" (src/storefront/preview.ts),
 *                       bound to THIS shop, valid 30 minutes
 *            expiresAt  ISO-8601
 *
 *   404 (opaque) for everyone but the shop's admin (or a platform user with a
 *   live acting-as grant on it), for another method, for a cross-origin or
 *   origin-less POST (checked before anything else is done), and while the
 *   Worker has no auth secret to derive the key from.
 *
 * The admin opens the storefront at `<root>/#preview=<grant>`: the grant
 * rides in the address's FRAGMENT, which a browser never sends to a server
 * nor puts in a Referer. The API builds no storefront address (the address
 * grammar of CP4_BRIEFS.md); the admin page puts the root in front.
 *
 * Each grant is audited (`storefront.preview_granted`, with its expiry and,
 * under acting-as, the grant id) before it is handed out; the grant itself is
 * never stored.
 */

export const ADMIN_PREVIEW_PATH = "/v1/admin/preview";

export async function handleAdminPreviewRoute(
  env: Env,
  request: Request,
  // Tests pin the clock; the mounted route always uses the server's.
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const now = options.now ?? Date.now();
  const minted = await mintPreviewGrant(env, principal.tenantId, now);
  if (minted === null) {
    return routeNotFoundResponse();
  }
  const expiresAt = new Date(minted.expiresAt).toISOString();

  await env.DB.prepare(
    `INSERT INTO audit_events (
       event_id, tenant_id, actor_user_id, action, resource_type,
       resource_id, request_id, metadata_json, created_at
     ) VALUES (?, ?, ?, 'storefront.preview_granted', 'tenant', ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      principal.tenantId,
      crypto.randomUUID(),
      auditMetadataJson(principal, { expiresAt }),
      now,
    )
    .run();

  return jsonResponse({ preview: { expiresAt, grant: minted.grant } });
}
