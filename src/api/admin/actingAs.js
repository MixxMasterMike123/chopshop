// Acting-as: a platform user's time-boxed, audited admin session inside one
// shop (cloudflare/src/routes/acting-as.ts, PLAN §2.1). The calls of the
// shells (CP5 brief FB.2) and the pure parts the replacements are built on
// (tested under Node in actingAs.test.mjs).
//
//   POST   /v1/platform/tenants/:id/acting-as  { reason }   → 201 { tenantId, expiresAt }
//   DELETE /v1/platform/tenants/:id/acting-as               → 204 (404: no live grant)
//   GET    /v1/platform/tenants[?status&cursor&limit]       → { tenants[], nextCursor }
//
// A grant is never a token in the browser: the admin requests of that shop
// carry `X-Shop-Id` and the server finds the grant itself. The open grants
// come back in `GET /v1/me` `actingAs` (a reload restores the banner from
// there). TTL 60 minutes (cloudflare/src/platform/acting-as.ts).

import { AdminApiError, platformRequest, segment, withQuery } from './client.js';

/** The server's grant length (acting-as.ts ACTING_AS_TTL_MS). Shown in the dialog. */
export const ACTING_AS_TTL_MS = 60 * 60 * 1000;
/** The server's bounds on `reason` (acting-as.ts parseActingAsGrantInput). */
export const REASON_MAX_LENGTH = 500;

/**
 * Opens a grant on `tenantId`. `reason` is trimmed; the server takes 1–500
 * characters. Resolves `{ tenantId, expiresAt }` (ISO). A shop that is not
 * active, or a caller who is not a platform user, gets the opaque 404.
 */
export async function openActingAs(tenantId, reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 1 || text.length > REASON_MAX_LENGTH) {
    throw new AdminApiError({
      status: 0,
      code: 'bad_request',
      message: `Anledningen ska vara 1–${REASON_MAX_LENGTH} tecken.`,
    });
  }
  const { data } = await platformRequest('POST', `/v1/platform/tenants/${segment(tenantId)}/acting-as`, {
    json: { reason: text },
  });
  return { tenantId: data?.tenantId ?? tenantId, expiresAt: data?.expiresAt ?? null };
}

/** Ends the caller's live grant(s) on `tenantId`. Resolves true (204) or false (none was live). */
export async function closeActingAs(tenantId) {
  try {
    await platformRequest('DELETE', `/v1/platform/tenants/${segment(tenantId)}/acting-as`);
    return true;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return false;
    throw error;
  }
}

/** One page of the platform's shop directory. */
export async function listTenants({ status, cursor, limit = 100, signal } = {}) {
  const { data } = await platformRequest('GET', withQuery('/v1/platform/tenants', { status, cursor, limit }), { signal });
  return {
    tenants: Array.isArray(data?.tenants) ? data.tenants : [],
    nextCursor: typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null,
  };
}

// ── pure ────────────────────────────────────────────────────────────────────

/**
 * The impersonation session the shells read (config/impersonation.js's shape:
 * `{ shopId, shopName, reason, actorUid, auditId, startedAt, expiresAt }`,
 * times in ms), for the grant of `shopId` among `grants` (`/v1/me`
 * `actingAs`), or null when that shop has no grant that is live at `now`.
 * The server keeps the reason and the grant id; `auditId` is the shop id (what
 * ending the grant needs), `reason` is empty.
 */
export function sessionOfGrant(grants, shopId, now = Date.now()) {
  if (!Array.isArray(grants) || typeof shopId !== 'string' || shopId === '') return null;
  let best = null;
  for (const grant of grants) {
    if (!grant || grant.tenantId !== shopId) continue;
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    if (!best || expiresAt > best.expiresAt) {
      best = {
        shopId,
        shopName: typeof grant.shopName === 'string' && grant.shopName ? grant.shopName : shopId,
        reason: '',
        actorUid: '',
        auditId: shopId,
        startedAt: expiresAt - ACTING_AS_TTL_MS,
        expiresAt,
      };
    }
  }
  return best;
}

/** The shop picker's rows (`{ id, name, status }`) from `/v1/me`: a tenant admin's memberships, a platform user's open grants. */
export function pickerShopsOf(me, now = Date.now()) {
  if (!me || typeof me !== 'object') return [];
  const rows =
    me.accountType === 'platform_admin'
      ? (Array.isArray(me.actingAs) ? me.actingAs : [])
          .filter((g) => g && typeof g.tenantId === 'string' && Date.parse(g.expiresAt) > now)
          .map((g) => ({ id: g.tenantId, name: g.shopName || null, status: 'active' }))
      : (Array.isArray(me.memberships) ? me.memberships : [])
          .filter((m) => m && typeof m.tenantId === 'string')
          // ShopPicker marks `disabled` as "Pausad"; a suspended or closed shop
          // is listed (the API lists it) but cannot be worked in.
          .map((m) => ({ id: m.tenantId, name: m.shopName || null, status: m.status === 'active' ? 'active' : 'disabled' }));
  const seen = new Set();
  return rows
    .filter((r) => (seen.has(r.id) ? false : seen.add(r.id)))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}
