// The admin build's replacement for src/contexts/ShopContext.jsx (alias list,
// vite.admin.config.js). `useShopId()` answers as before: the active shop's id,
// or UNRESOLVED_SHOP_ID when there is none (the shells show the picker then).
//
// The active shop (src/api/admin/session.js resolveActiveShopId), only ever
// one the user may use according to `GET /v1/me`:
//   1. `?shopId=` of the address the tab was opened with (Connect return, e-mail)
//   2. the shop chosen earlier in this tab (sessionStorage, activeShopStore.js)
//   3. the only usable one: a tenant admin's one active membership, a platform
//      user's one open acting-as grant
//   else none → the picker (unit FB). A platform user has no shop until
//   acting-as is opened. The platform tree has no active shop at all.
//
// The resolved id is handed to the client synchronously while rendering
// (setRequestShopId), so a page's first effect already sends X-Shop-Id.
//
// `useActiveShop()` adds what the shells need: the memberships (a suspended
// shop is listed, `usable: false`), the grants, `setActiveShop(id)`.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { UNRESOLVED_SHOP_ID } from '../../config/tenancy';
import { setRequestShopId } from '../../api/admin/client.js';
import { resolveActiveShopId, shopEntryOf, usableShopIds } from '../../api/admin/session.js';
import { useAuth } from './Session.jsx';
import { getChosenShopId, setChosenShopId, shopIdOnArrival, subscribeChosenShopId } from './activeShopStore.js';

const ARRIVAL_SHOP_ID = shopIdOnArrival();

const ShopContext = createContext(UNRESOLVED_SHOP_ID);
const ActiveShopContext = createContext({
  shopId: null,
  shop: null,
  memberships: [],
  actingAs: [],
  usableShopIds: [],
  setActiveShop: () => {},
});

export function useShopId() {
  return useContext(ShopContext);
}

export function useActiveShop() {
  return useContext(ActiveShopContext);
}

/** `tree`: 'admin' (the default) or 'platform' (never a shop). */
export function ShopProvider({ children, tree = 'admin' }) {
  const { me, memberships, actingAs } = useAuth();
  const chosen = useSyncExternalStore(subscribeChosenShopId, getChosenShopId, () => null);

  const usable = useMemo(() => (tree === 'admin' ? usableShopIds(me) : []), [me, tree]);
  const shopId = useMemo(
    () => (tree === 'admin' ? resolveActiveShopId(me, { requested: ARRIVAL_SHOP_ID, chosen }) : null),
    [me, chosen, tree],
  );

  // The client's X-Shop-Id, before any child renders or runs an effect.
  setRequestShopId(shopId);

  // The shop in use is this tab's choice from now on (a reload keeps it after
  // the `?shopId=` of the arrival has been stripped from the address).
  useEffect(() => {
    if (shopId && shopId !== chosen) setChosenShopId(shopId);
  }, [shopId, chosen]);

  const setActiveShop = useCallback(
    (id) => {
      setChosenShopId(id && usable.includes(id) ? id : null);
    },
    [usable],
  );

  const value = useMemo(
    () => ({
      shopId,
      shop: shopEntryOf(me, shopId),
      memberships: memberships.map((m) => ({ ...m, usable: usable.includes(m.tenantId) })),
      actingAs,
      usableShopIds: usable,
      setActiveShop,
    }),
    [me, shopId, memberships, actingAs, usable, setActiveShop],
  );

  return (
    <ShopContext.Provider value={shopId ?? UNRESOLVED_SHOP_ID}>
      <ActiveShopContext.Provider value={value}>{children}</ActiveShopContext.Provider>
    </ShopContext.Provider>
  );
}

export const ActiveShopProvider = ShopProvider;
