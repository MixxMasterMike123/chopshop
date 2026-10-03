// The admin build's src/utils/shopPayout.js (alias list, vite.admin.config.js).
// THE SELLER SEES ONE NUMBER: in this build the payout on an order is the
// server's (`payout.amountMinor` of GET /v1/admin/orders/:id, carried to the
// payment card as `serverPayoutSek` by adapters/order.js). Nothing here
// computes one; a call means a page lost the server's number, and fails loudly.

import { notAvailable } from '../../api/admin/client.js';

export const shopPayoutSek = () => {
  throw notAvailable('En utbetalning räknad i webbläsaren');
};
