// src/components/auth/AdminShopIdIntake.jsx for the admin build (alias list,
// vite.admin.config.js), mounted once in the admin tree (AdminApp.jsx).
//
// Two addresses name the shop a tab should work in:
//   ?shopId=<id>                     an e-mail or Connect return link (as before)
//   ?impersonate=<id>&audit=<id>     the platform console's "Öppna admin"
//                                    (ImpersonateShopModal), after the grant
//                                    was opened on the server
// Both make that shop the tab's choice (activeShopStore), then the params are
// stripped and the route kept. The choice is honoured only when `/v1/me`
// says the user may use the shop (a membership, or an open acting-as grant):
// this is routing, never authorization; the server checks every request.

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cleanShopId, setChosenShopId } from '../providers/activeShopStore.js';

const PARAMS = ['shopId', 'impersonate', 'audit'];

/** The shop an address names (`shopId` first), or null. Pure. */
export function shopIdOfSearch(search) {
  const params = new URLSearchParams(search);
  return cleanShopId(params.get('shopId')) ?? cleanShopId(params.get('impersonate'));
}

const AdminShopIdIntake = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!PARAMS.some((p) => params.has(p))) return;
    if (handled.current) return;
    handled.current = true;

    const shopId = shopIdOfSearch(location.search);
    if (shopId) setChosenShopId(shopId);

    for (const p of PARAMS) params.delete(p);
    const qs = params.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`, { replace: true });
  }, [location.search, location.pathname, location.hash, navigate]);

  return null;
};

export default AdminShopIdIntake;
