// Collections: an answer of GET /v1/collections or GET /v1/collections/:ref
// (CP4-B, cloudflare/src/catalog/collections.ts PublicCollection) → the
// object the pages read today (a Firestore `collections` document). Pure;
// tested under Node (adapters.test.mjs).
//
// The pages resolve a collection's products with collectionResolver.js
// (manual: `productIds` in order; smart: a tag rule over every product). The
// API answers the members itself, already filtered by the public predicate,
// in the collection's order, and does not say whether a collection is manual
// or smart. So a page collection is always `manual`, its `productIds` the
// products the API answered, in the API's order: the resolver then hands the
// page exactly those products. A card of the home is shown when that list
// holds a product, which is the source's rule (a collection with nothing to
// buy is not shown).

const addressOf = (image) => (image && typeof image.url === 'string' && image.url ? image.url : null);

/**
 * One collection. `products` are the page products (products.js) the API
 * answered for it: all of them on the collection page, the first one on the
 * home (`?limit=1`).
 */
export function toPageCollection(api, products = []) {
  if (!api || typeof api !== 'object' || typeof api.handle !== 'string') return null;
  return {
    id: api.handle,
    handle: api.handle,
    title: typeof api.title === 'string' ? api.title : '',
    description: typeof api.description === 'string' && api.description ? api.description : null,
    imageUrl: addressOf(api.image),
    featured: api.featured === true,
    sortOrder: typeof api.sortOrder === 'number' ? api.sortOrder : null,
    published: true,
    type: 'manual',
    productIds: (Array.isArray(products) ? products : [])
      .map((product) => product?.productId ?? product?.id)
      .filter((id) => typeof id === 'string' && id),
  };
}
