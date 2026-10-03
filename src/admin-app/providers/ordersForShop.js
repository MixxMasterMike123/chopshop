// The members of `useOrder()` for ONE shop (the Orders provider's pure part,
// tested under Node in ordersForShop.test.mjs). The provider makes a new set
// whenever the tab's active shop changes, so a page's effect that depends on
// `getAllOrders` or `getOrderById` runs again for the new shop (CP5-FX,
// finding 1). Each read:
//   - asks the shop it was made for, on every page of the list walk, whatever
//     shop is active by the time a later page is asked;
//   - with no shop (the picker is up) asks nothing and never settles: there is
//     nothing to show, and no "no shop" error is left behind for the page to
//     show once a shop is chosen;
//   - never settles either when its answer (or its failure) arrives after the
//     tab moved to another shop: the previous shop's orders are dropped, never
//     shown under the new one.
// A write (a fulfilment step, a cancellation) goes to the shop it was made in
// and reports its outcome as it is.
//
// `deleteOrder` is NOT provided: an order is permanent evidence (D68), and the
// detail page shows its delete button only when the context has the function.
// A refusal of the API rejects with an Error whose `userMessage` is the Swedish
// sentence the pages show (adapters/order.js refusalMessage).

import { AdminApiError, getRequestShopId, notAvailable } from '../../api/admin/client.js';
import { cancelOrder, changeFulfilment, getOrder, listAllOrders } from '../../api/admin/orders.js';
import { isUnresolvedShopId } from '../../config/tenancy.js';
import { orderFromDetail, orderFromListRow, refusalMessage } from '../adapters/order.js';

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

/** A promise that never settles: the answer it stood for is dropped. */
const dropped = () => new Promise(() => {});

/**
 * `read(shopId)` for one shop, as described above: nothing is asked without a
 * shop, and an outcome that arrives once another shop is active is dropped.
 */
export async function readForShop(shopId, read) {
  if (isUnresolvedShopId(shopId)) return dropped();
  let outcome;
  try {
    outcome = { value: await read(shopId) };
  } catch (error) {
    outcome = { error };
  }
  if (getRequestShopId() !== shopId) return dropped();
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

const unavailable = (what) => async () => {
  throw notAvailable(what);
};

/**
 * The context value for `shopId` (null or the unresolved sentinel: no shop).
 *   getAllOrders()                  the whole list, walked page by page (the
 *                                   page has always loaded every order and
 *                                   filters, counts and searches in memory)
 *   getOrderById(id)                the detail, or null (the route's 404)
 *   updateOrderStatus(id, step, x)  a fulfilment step (POST …/fulfilment, with
 *                                   x.trackingNumber on 'shipped'), or
 *                                   'cancelled' (POST …/cancel)
 */
export function ordersForShop(shopId) {
  const shop = isUnresolvedShopId(shopId) ? null : shopId;

  const getAllOrders = () =>
    readForShop(shop, async (id) => {
      const { orders, truncated } = await listAllOrders({}, { shopId: id });
      if (truncated) console.warn('Orderlistan: bara de senaste ordrarna visas (gränsen för en hämtning nåddes).');
      return orders.map(orderFromListRow);
    });

  const getOrderById = (orderId) =>
    readForShop(shop, async (id) => {
      const order = await getOrder(orderId, { shopId: id });
      return order === null ? null : orderFromDetail(order);
    });

  const updateOrderStatus = async (orderId, newStatus, additionalData = {}) => {
    try {
      if (shop === null) throw new AdminApiError({ status: 0, code: 'no_shop', message: 'Ingen butik är vald' });
      if (newStatus === 'cancelled') {
        await cancelOrder(orderId, { reason: CANCEL_REASON }, { shopId: shop });
      } else {
        await changeFulfilment(orderId, { to: newStatus, trackingNumber: additionalData.trackingNumber }, { shopId: shop });
      }
      return true;
    } catch (error) {
      throw withUserMessage(error);
    }
  };

  return Object.freeze({
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
}
