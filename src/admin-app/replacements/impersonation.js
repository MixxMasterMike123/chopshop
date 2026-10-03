// src/config/impersonation.js for the admin build (alias list,
// vite.admin.config.js). The Firebase build kept a client-written
// impersonation session per tab (sessionStorage) and an audit document. Here
// the session IS the server's acting-as grant (cloudflare/src/routes/
// acting-as.ts): `/v1/me` lists the open grants, the ActiveShop provider
// publishes them with the tab's active shop while it renders
// (publishActingAs), and `getImpersonation()` answers the grant of the active
// shop in the old shape, or null. The banner, the shell's nav offset, the
// terms gate and the dialog read it unedited.
//
// Nothing here grants anything: the server checks the grant on every admin
// request (`X-Shop-Id`), and refuses what a platform user may not do while
// acting (sign the seller's terms, adopt legal pages, the Connect login link).

import { ACTING_AS_TTL_MS, sessionOfGrant } from '../../api/admin/actingAs.js';
import { setChosenShopId } from '../providers/activeShopStore.js';

/** The dialog's "Sessionen upphör automatiskt efter … minuter": the server's TTL. */
export const IMPERSONATION_TTL_MS = ACTING_AS_TTL_MS;

let grants = [];
let activeShopId = null;

/** Called by the ActiveShop provider while it renders: the open grants (`/v1/me`) and the tab's shop. */
export function publishActingAs({ grants: next, shopId }) {
  grants = Array.isArray(next) ? next : [];
  activeShopId = typeof shopId === 'string' && shopId !== '' ? shopId : null;
}

/** The acting-as session of the tab's active shop, or null (none, or run out). */
export function getImpersonation() {
  return sessionOfGrant(grants, activeShopId);
}

export function getImpersonationShopId() {
  return getImpersonation()?.shopId ?? null;
}

/** A grant is opened by the server (ImpersonateShopModal → writeImpersonationStart); nothing to store here. */
export function setImpersonation() {
  return getImpersonation();
}

/**
 * The banner calls this first when a session ends. "Avsluta": the grant is
 * still live, and writeImpersonationEnd (replacements/impersonationAudit.js)
 * ends it, lets go of the tab's shop and leaves for the console. Run out: the
 * banner has no session left to end and only reloads /admin, so the tab lets
 * go of the shop here and leaves the console its notice; the admin tree then
 * sends the platform user to the console (it has no grant).
 */
export function clearImpersonation() {
  const ran = grants
    .filter((g) => g && g.tenantId === activeShopId)
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
  if (!ran || Date.parse(ran.expiresAt) > Date.now()) return;
  setChosenShopId(null);
  leaveActingAsNotice({ shopName: ran.shopName || ran.tenantId, reason: 'expired' });
}

const NOTICE_KEY = 'admin.actingAsNotice';

/** Kept for the console to say once (impersonationAudit.js takeActingAsNotice). */
export function leaveActingAsNotice(notice) {
  try {
    globalThis.sessionStorage?.setItem(NOTICE_KEY, JSON.stringify(notice));
  } catch {
    /* storage refused: no notice */
  }
}

/** The notice of an acting-as session that ended in this tab, once; or null. */
export function takeActingAsNotice() {
  try {
    const s = globalThis.sessionStorage;
    const raw = s?.getItem(NOTICE_KEY);
    if (!raw) return null;
    s.removeItem(NOTICE_KEY);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
