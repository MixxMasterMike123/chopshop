// The cart a reminder's resume link rebuilds (CP9-AC). A pure function: no
// React, no fetch, no storage, so it runs under Node beside the client's tests.
//
// The link answers line REFERENCES only (`{ productId, quantity, variantId? }`,
// src/api/checkoutRecovery.js). Each line is matched against the product as
// the normal public read answers it NOW (GET /v1/products/:id, which applies
// the public predicate), and the cart provider's own addToCart takes the price
// from that live product. Nothing of the old checkout's money is carried: no
// price, no total, no discount (AC8, AC12); the checkout then prices the new
// cart from scratch.

const MAX_QUANTITY = 999;

function quantityOf(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_QUANTITY ? value : null;
}

/**
 * `items`: the link's line references. `productsById`: `{ [productId]: product
 * | null }`, the live public product detail of each (null: the read answered
 * 404, the product is no longer for sale). Returns `{ lines, missing }`:
 * `lines` = `[{ product, variant, quantity }]` for addToCart, in the link's
 * order; `missing` = how many lines could not be restored (a product gone, a
 * variant gone, a malformed reference).
 */
export function recoveryPlan(items, productsById) {
  const lines = [];
  let missing = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const quantity = quantityOf(item?.quantity);
    const product = typeof item?.productId === 'string' ? productsById?.[item.productId] : null;
    if (quantity === null || !product) {
      missing += 1;
      continue;
    }
    let variant = null;
    if (item.variantId !== undefined && item.variantId !== null) {
      variant = Array.isArray(product.variants)
        ? product.variants.find((candidate) => candidate && candidate.variantId === item.variantId) || null
        : null;
      if (variant === null) {
        missing += 1;
        continue;
      }
    }
    lines.push({ product: withDelivery(product), variant, quantity });
  }
  return { lines, missing };
}

/**
 * The product as addToCart reads its delivery restriction. The public read
 * answers `allowShipping` / `allowPickup`; the cart reads
 * `delivery.{shipping,pickup}` (the product page's shape, adapters/products.js
 * toPageProduct). Without this a pickup-only or shipping-only product would
 * come back into the cart as deliverable both ways, and its checkout would be
 * refused by the server. A product that already carries `delivery` is left as
 * it is.
 */
function withDelivery(product) {
  if (product.delivery && typeof product.delivery === 'object') return product;
  return {
    ...product,
    delivery: { shipping: product.allowShipping !== false, pickup: product.allowPickup !== false },
  };
}

/** The distinct product ids of the link's lines, for the reads `recoveryPlan` needs. */
export function recoveryProductIds(items) {
  const ids = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.productId === 'string' && item.productId !== '' && !ids.includes(item.productId)) ids.push(item.productId);
  }
  return ids;
}
