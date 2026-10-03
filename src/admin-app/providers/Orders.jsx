// The admin build's replacement for src/contexts/OrderContext.jsx (alias list,
// vite.admin.config.js): `useOrder()` with the members the order pages read,
// on the order routes (CP5 unit FD; src/api/admin/orders.js).
//
//   getAllOrders()                  the whole list, walked page by page (the
//                                   page has always loaded every order and
//                                   filters, counts and searches in memory)
//   getOrderById(id)                the detail, or null (the route's 404)
//   updateOrderStatus(id, step, x)  a fulfilment step (POST …/fulfilment, with
//                                   x.trackingNumber on 'shipped'), or
//                                   'cancelled' (POST …/cancel)
//
// `deleteOrder` is NOT provided: an order is permanent evidence (D68), and the
// detail page shows its delete button only when the context has the function.
// The functions are module-level (stable): the pages' effects depend on them.
// A refusal of the API rejects with an Error whose `userMessage` is the Swedish
// sentence the pages show (adapters/order.js refusalMessage).

import React, { createContext, useContext } from 'react';
import { notAvailable } from '../../api/admin/client.js';
import { cancelOrder, changeFulfilment, getOrder, listAllOrders } from '../../api/admin/orders.js';
import { orderFromDetail, orderFromListRow, refusalMessage } from '../adapters/order.js';

const unavailable = (what) => async () => {
  throw notAvailable(what);
};

/** The API's error, with the page's Swedish sentence as its message when there is one. */
export function withUserMessage(error) {
  const sentence = refusalMessage(error);
  if (sentence && error && typeof error === 'object') {
    error.userMessage = sentence;
    error.message = sentence;
  }
  return error;
}

/** Why a cancellation from the admin's status menu was made (the route requires a reason). */
export const CANCEL_REASON = 'Avbruten av butiken i admin';

async function getAllOrders() {
  const { orders, truncated } = await listAllOrders();
  if (truncated) console.warn('Orderlistan: bara de senaste ordrarna visas (gränsen för en hämtning nåddes).');
  return orders.map(orderFromListRow);
}

async function getOrderById(orderId) {
  const order = await getOrder(orderId);
  return order === null ? null : orderFromDetail(order);
}

async function updateOrderStatus(orderId, newStatus, additionalData = {}) {
  try {
    if (newStatus === 'cancelled') {
      await cancelOrder(orderId, { reason: CANCEL_REASON });
    } else {
      await changeFulfilment(orderId, { to: newStatus, trackingNumber: additionalData.trackingNumber });
    }
    return true;
  } catch (error) {
    throw withUserMessage(error);
  }
}

const VALUE = Object.freeze({
  loading: false,
  error: null,
  getOrderById,
  getAllOrders,
  updateOrderStatus,
  getUserOrders: unavailable('En användares ordrar'),
  getRecentOrders: unavailable('Senaste ordrar'),
  getOrderStats: unavailable('Orderstatistik'),
  cancelOrder: unavailable('Avbryta en order'),
  updateProductSettings: unavailable('Produktinställningar'),
  isDemoMode: false,
});

const OrderContext = createContext(VALUE);

export function OrderProvider({ children }) {
  return <OrderContext.Provider value={VALUE}>{children}</OrderContext.Provider>;
}

export const useOrder = () => useContext(OrderContext);
