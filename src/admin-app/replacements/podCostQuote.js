// src/config/podCostQuote.js for the ADMIN build (CP5 unit FN1). It COMPUTES
// NOTHING: the seller's numbers are the server's design quote for a printer,
// one of its articles and the print slots
// (GET /v1/admin/pod/design-quote → { inkopMinor, priceFloorMinor, currency }).
//
// The older studio asked a callable for (garment, slots) → one cost, and
// priced the floor itself (podPricing.js). Here a quote needs the ARTICLE (a
// colour and a size are separate articles at the printer, and may differ in
// cost), so the publish step asks one quote per chosen article (quoteDesign)
// and shows the server's floor; `quotePodCost` answers "no number" at once,
// without a request, so nothing in this build can show a figure the server
// did not give.
//
// Memo per SHOP and choice (an answer for another shop is never reused, and an
// answer that arrives after the tab moved shop is dropped: readForShop). A
// failure is never memoised and never reads as 0 kr: it rejects.

import { getRequestShopId } from '../../api/admin/client.js';
import { isUnresolvedShopId } from '../../config/tenancy.js';
import { getDesignQuote } from '../../api/admin/pod.js';
import { readForShop } from '../providers/ordersForShop.js';

const NONE = Object.freeze({ costSek: null, printerUid: null });

const memo = new Map(); // `${shop}\n${printer}\n${sku}\n${slots}` → Promise<quote>

/** The older studio's (garment, slots) quote: no number in this build (see above). */
export const quotePodCost = async () => NONE;

/**
 * quoteDesign({ printerId, sku, slots }, { shopId?, fresh?, signal? })
 *   → Promise<{ inkopMinor, priceFloorMinor, currency }>
 * Rejects with the API's error (422 printer_unavailable | sku_unavailable |
 * slot_not_printable, or any failure). `fresh` asks again (the publish step
 * re-quotes right before it writes).
 */
export function quoteDesign({ printerId, sku, slots }, { shopId, fresh = false, signal } = {}) {
  const shop = shopId ?? getRequestShopId();
  const slotList = [...slots];
  const key = `${shop}\n${printerId}\n${sku}\n${slotList.join(',')}`;
  if (isUnresolvedShopId(shop)) return readForShop(shop, () => null); // no shop: nothing is asked
  if (fresh || signal || !memo.has(key)) {
    const ask = getDesignQuote({ printerId, sku, slots: slotList }, { shopId: shop, signal })
      .then((quote) => {
        if (!Number.isSafeInteger(quote?.inkopMinor) || !Number.isSafeInteger(quote?.priceFloorMinor)) {
          throw Object.assign(new Error('The quote carries no figures'), { code: 'no_figures' });
        }
        return quote;
      });
    // An ask that can be aborted is its caller's own: never shared through the memo.
    if (signal) return readForShop(shop, () => ask);
    memo.set(key, ask);
    ask.catch(() => {
      if (memo.get(key) === ask) memo.delete(key);
    });
  }
  // The memo holds the shop's own answer; only THIS caller is dropped when the
  // tab moved shop meanwhile (a dropped promise never settles: never memoised).
  return readForShop(shop, () => memo.get(key));
}

/** Drop every memoised quote (the studio's "Försök igen"). */
export const clearPodCostQuoteCache = () => {
  memo.clear();
};

/** The older build's studio harness stubs the callable; nothing to stub here. */
export const seedPodCostQuoteForDev = () => {};
