// The session: who is signed in, and the shops they may work in (CP5 brief
// §0.2, FA.2–3). The calls, and the pure functions the Session and ActiveShop
// providers are built on (tested under Node in session.test.mjs).
//
//   GET  /v1/me                          → { user, accountType, platform, memberships[], actingAs[] } | 401
//   POST /api/auth/sign-in/email         { email, password }
//   POST /api/auth/sign-out
//   POST /api/auth/request-password-reset { email }        (the API adds where the link lands)
//   POST /api/auth/reset-password        { newPassword, token }
//   DELETE /v1/platform/tenants/:id/acting-as               (ends a platform user's grant)

import { AdminApiError, authRequest, getMeRaw, platformRequest, segment } from './client.js';

// ── calls ───────────────────────────────────────────────────────────────────

/** The signed-in user (`/v1/me`), or null. */
export function getMe(options) {
  return getMeRaw(options);
}

export async function signIn(email, password) {
  await authRequest('POST', '/api/auth/sign-in/email', { json: { email, password } });
}

export async function signOut() {
  await authRequest('POST', '/api/auth/sign-out', { json: {} });
}

/** Asks for the reset mail. The API answers the same whether the address exists or not. */
export async function requestPasswordReset(email) {
  await authRequest('POST', '/api/auth/request-password-reset', { json: { email } });
}

/** Sets the new password with the token of the mailed link. */
export async function resetPassword(token, newPassword) {
  if (typeof token !== 'string' || token === '') {
    throw new AdminApiError({ status: 0, code: 'INVALID_TOKEN', message: 'No reset token' });
  }
  await authRequest('POST', '/api/auth/reset-password', { json: { newPassword, token } });
}

/** Ends a platform user's acting-as grant on one shop. */
export async function endActingAs(tenantId) {
  await platformRequest('DELETE', `/v1/platform/tenants/${segment(tenantId)}/acting-as`);
}

// ── pure: the shape the pages read ──────────────────────────────────────────

export const ACCOUNT_TENANT_ADMIN = 'tenant_admin';
export const ACCOUNT_PLATFORM_ADMIN = 'platform_admin';

function isMe(me) {
  return me !== null && typeof me === 'object' && me.user && typeof me.user.id === 'string';
}

/**
 * What `useAuth()` hands the pages, from a `/v1/me` answer (or null). The
 * shape is AuthContext.jsx's: `currentUser {uid, email, displayName}`,
 * `userProfile {role, …}` (= `userData`), `isAdmin`, `isPlatform`. Both account
 * types the admin serves carry role 'admin', as the Firebase users did
 * (a platform user was role 'admin' + platform true), so AdminRoute passes a
 * platform user who is acting as a shop.
 */
export function authStateFromMe(me) {
  if (!isMe(me)) {
    return { currentUser: null, userProfile: null, isAdmin: false, isPlatform: false };
  }
  const isPlatform = me.accountType === ACCOUNT_PLATFORM_ADMIN && me.platform === true;
  const served = isPlatform || me.accountType === ACCOUNT_TENANT_ADMIN;
  const email = typeof me.user.email === 'string' ? me.user.email : null;
  const name = typeof me.user.name === 'string' && me.user.name !== '' ? me.user.name : null;
  const currentUser = { uid: me.user.id, email, displayName: name };
  const userProfile = {
    id: me.user.id,
    email,
    name,
    role: served ? 'admin' : null,
    platform: isPlatform,
    accountType: me.accountType,
    active: true,
  };
  return { currentUser, userProfile, isAdmin: served, isPlatform };
}

function expiresAtMillis(grant) {
  const at = Date.parse(grant?.expiresAt);
  return Number.isFinite(at) ? at : null;
}

/** The memberships of `me`, as listed (the picker shows a suspended one disabled). */
export function membershipsOf(me) {
  return isMe(me) && Array.isArray(me.memberships)
    ? me.memberships.filter((m) => m && typeof m.tenantId === 'string')
    : [];
}

/** The acting-as grants of `me` that have not run out at `now`. */
export function liveGrantsOf(me, now = Date.now()) {
  if (!isMe(me) || !Array.isArray(me.actingAs)) return [];
  return me.actingAs.filter((g) => {
    const at = expiresAtMillis(g);
    return g && typeof g.tenantId === 'string' && at !== null && at > now;
  });
}

/**
 * The shops `me` may work in at `now`: a tenant admin's ACTIVE memberships; a
 * platform user's open acting-as grants and nothing else (a platform user
 * has no shop until acting-as is opened).
 */
export function usableShopIds(me, now = Date.now()) {
  if (!isMe(me)) return [];
  if (me.accountType === ACCOUNT_PLATFORM_ADMIN) return liveGrantsOf(me, now).map((g) => g.tenantId);
  if (me.accountType !== ACCOUNT_TENANT_ADMIN) return [];
  return membershipsOf(me)
    .filter((m) => m.status === 'active')
    .map((m) => m.tenantId);
}

/**
 * The active shop, or null (no shop yet: the picker, unit FB). In order: the
 * shop asked for on arrival (`?shopId=`), the one chosen earlier in this tab,
 * the only usable one. Each only when `me` may use it.
 */
export function resolveActiveShopId(me, { requested = null, chosen = null } = {}, now = Date.now()) {
  const usable = usableShopIds(me, now);
  if (requested && usable.includes(requested)) return requested;
  if (chosen && usable.includes(chosen)) return chosen;
  if (usable.length === 1) return usable[0];
  return null;
}

/** The membership or grant entry of `shopId` in `me` (its name and status), or null. */
export function shopEntryOf(me, shopId) {
  if (!shopId) return null;
  return (
    membershipsOf(me).find((m) => m.tenantId === shopId) ??
    liveGrantsOf(me).find((g) => g.tenantId === shopId) ??
    null
  );
}
