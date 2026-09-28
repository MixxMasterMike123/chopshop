// src/utils/productPricing.js for the Cloudflare storefront (alias list,
// vite.storefront.config.js).
//
// A product card reads its price through getCardPrice: the cheapest variant
// priced above zero, "från" when the variants differ. The API computes that
// rule on the server (PublicProductSummary `lowestPriceMinor`, `isFromPrice`,
// the same rule, CP4-A §4), and a list answer carries no variant prices to
// compute it from. The catalogue adapter hands both on in kronor
// (`lowestPrice`, `isFromPrice`); a product that carries them is priced from
// them, every other product by the Firebase module's own code, which this
// module imports unchanged.

import {
  getCardPrice as cardPriceFromVariants,
  getCompareAtPrice,
} from '../../utils/productPricing.js';

export { getCompareAtPrice };

export const getCardPrice = (product) => {
  if (typeof product?.lowestPrice === 'number') {
    const price = product.lowestPrice;
    const compareAt = getCompareAtPrice(product, price);
    return { price, isFrom: product.isFromPrice === true, compareAt, onSale: compareAt != null };
  }
  return cardPriceFromVariants(product);
};
