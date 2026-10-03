// The admin build's replacement for src/contexts/OrderContext.jsx (alias list,
// vite.admin.config.js): the shell of `useOrder()` with the same members, so
// the order pages resolve while they are stand-ins. Unit FD fills each
// function from the order routes (WB: GET /v1/admin/orders, the detail,
// POST …/status, …/refunds, …/cancel). Until then every function rejects
// with `not_available`.
//
// `deleteOrder` stays a refusal for good: an order is permanent evidence
// (D68). `PRODUCT_SETTINGS` (a price table of the earlier wholesale era) is not
// carried; no launch-scope page reads it.

import React, { createContext, useContext } from 'react';
import { notAvailable } from '../../api/admin/client.js';

const unavailable = (what) => async () => {
  throw notAvailable(what);
};

const VALUE = Object.freeze({
  loading: false,
  error: null,
  getOrderById: unavailable('Ordern'),
  getUserOrders: unavailable('En användares ordrar'),
  getRecentOrders: unavailable('Senaste ordrar'),
  getAllOrders: unavailable('Orderlistan'),
  updateOrderStatus: unavailable('Ändra orderstatus'),
  getOrderStats: unavailable('Orderstatistik'),
  deleteOrder: unavailable('Radera en order'),
  cancelOrder: unavailable('Avbryta en order'),
  updateProductSettings: unavailable('Produktinställningar'),
  isDemoMode: false,
});

const OrderContext = createContext(VALUE);

export function OrderProvider({ children }) {
  return <OrderContext.Provider value={VALUE}>{children}</OrderContext.Provider>;
}

export const useOrder = () => useContext(OrderContext);
