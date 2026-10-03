import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { jsonResponse } from "../lib/http";
import { invalidRequestResponse, readJsonBody, routeNotFoundResponse } from "../lib/responses";
import { parsePatchArtworkInput } from "../pod/artwork-routes";
import { getFailedArtwork, renameArtwork } from "../pod/artwork-store";

/**
 * CP5-WG: the two artwork-library answers `handleAdminPodRoute` (src/app.ts)
 * delegates here. Both run AFTER that handler's configuration gate, session +
 * X-Shop-Id guard and same-origin check on state changes, and after its
 * single-segment id parse; nothing here re-derives the principal or the id.
 *
 *   PATCH /v1/admin/pod/artwork/{artworkId}  { label: string | null }
 *         → 200 { artwork: ArtworkSummary }  (label, rightsConfirmedAt, createdBySelf …)
 *         → 400 invalid_request | 404 (unknown / foreign id)
 *
 *   GET   /v1/admin/pod/artwork/{artworkId}  when no artwork row exists
 *         → 200 { artwork: { artworkId, status: "failed", reason: "render_failed" }, previewUrl: null }
 *           for a render that failed (its row was removed so the same body can
 *           be posted again), else the opaque 404.
 */

export async function handleAdminArtworkPatch(
  db: D1Database,
  request: Request,
  principal: TenantAdminPrincipal,
  artworkId: string,
  now: number,
): Promise<Response> {
  const input = parsePatchArtworkInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await renameArtwork(db, principal, artworkId, input.label, now);
  return result.status === "ok"
    ? jsonResponse({ artwork: result.artwork })
    : routeNotFoundResponse();
}

/** The detail answer for an id with no artwork row: a failed render, or the opaque 404. */
export async function missingArtworkResponse(
  db: D1Database,
  principal: TenantAdminPrincipal,
  artworkId: string,
): Promise<Response> {
  const failed = await getFailedArtwork(db, principal, artworkId);
  return failed === null
    ? routeNotFoundResponse()
    : jsonResponse({ artwork: failed, previewUrl: null });
}
