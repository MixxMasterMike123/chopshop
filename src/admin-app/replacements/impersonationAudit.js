// src/config/impersonationAudit.js for the admin build (alias list,
// vite.admin.config.js). The Firebase build wrote a START and an END document
// from the browser; here the server writes the audit when the grant is opened
// and when it is ended (cloudflare/src/platform/acting-as.ts), so these two
// functions are the grant's two calls:
//
//   writeImpersonationStart → POST   /v1/platform/tenants/:id/acting-as {reason}
//   writeImpersonationEnd   → DELETE /v1/platform/tenants/:id/acting-as
//
// ImpersonateShopModal opens `${ADMIN_URL}/admin?impersonate=<shop>&audit=<id>`
// in a new tab with the id the start returns; the admin tree's intake
// (replacements/AdminShopIdIntake.jsx) makes that shop the tab's.

import { closeActingAs, openActingAs } from '../../api/admin/actingAs.js';
import { setChosenShopId } from '../providers/activeShopStore.js';
import { getImpersonation, leaveActingAsNotice, takeActingAsNotice } from './impersonation.js';

export { takeActingAsNotice };

/** Opens the grant. Resolves the id the dialog passes on as `audit` (the shop id). */
export async function writeImpersonationStart({ shopId, reason }) {
  const granted = await openActingAs(shopId, reason);
  return granted.tenantId;
}

/**
 * Ends the grant (`auditId` is the shop id), lets go of the tab's shop and
 * leaves for the platform console, carrying a notice the console shows once
 * (takeActingAsNotice). The banner awaits this and then navigates to /admin
 * itself; this function never settles, so that navigation does not override
 * the one to the console (with another grant still open, /admin would land
 * in THAT shop). A grant that already ran out answers 404: nothing to end.
 */
export async function writeImpersonationEnd(auditId, endReason) {
  const shopId = typeof auditId === 'string' ? auditId : '';
  const shopName = getImpersonation()?.shopName || shopId;
  try {
    if (shopId) await closeActingAs(shopId);
  } catch (error) {
    console.warn('Acting-as: could not end the grant:', error?.message);
  }
  setChosenShopId(null);
  leaveActingAsNotice({ shopName, reason: endReason === 'expired' ? 'expired' : 'manual' });
  window.location.replace('/platform/');
  return new Promise(() => {});
}

/** The notice's text (pure; Swedish, as the console's copy). */
export function actingAsNoticeText(notice) {
  if (!notice) return null;
  const name = typeof notice.shopName === 'string' && notice.shopName ? notice.shopName : 'butiken';
  return notice.reason === 'expired'
    ? `Plattformsläget för ${name} har gått ut. Öppna admin igen för att fortsätta.`
    : `Plattformsläget för ${name} är avslutat.`;
}
