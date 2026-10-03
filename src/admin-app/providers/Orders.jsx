// The admin build's replacement for src/contexts/OrderContext.jsx (alias list,
// vite.admin.config.js): `useOrder()` with the members the order pages read,
// on the order routes (CP5 unit FD; src/api/admin/orders.js).
//
// The members are bound to the tab's active shop (ordersForShop.js): a new
// shop gives new functions, so the pages' effects that depend on them load
// again, and an answer of the previous shop is dropped, never shown.

import React, { createContext, useContext, useMemo } from 'react';
import { useShopId } from './ActiveShop.jsx';
import { ordersForShop } from './ordersForShop.js';

export { CANCEL_REASON, withUserMessage } from './ordersForShop.js';

const OrderContext = createContext(ordersForShop(null));

export function OrderProvider({ children }) {
  const shopId = useShopId();
  const value = useMemo(() => ordersForShop(shopId), [shopId]);
  return <OrderContext.Provider value={value}>{children}</OrderContext.Provider>;
}

export const useOrder = () => useContext(OrderContext);
