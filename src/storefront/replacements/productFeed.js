// src/utils/productFeed.js for the Cloudflare storefront (alias list,
// vite.storefront.config.js). The product page builds its JSON-LD with
// generateProductSchema, which is the Firebase module's function, unchanged
// (the catalogue adapter hands it the fields it reads). Left out: the product
// feed builder, which reads Firestore and no storefront page calls.

export const generateProductSchema = (product) => {
  if (!product) return null;

  const availability = product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";

  // When variants price differently, expose an AggregateOffer (low/high span);
  // equal prices or no variants keep the single Offer.
  const variantPrices = (Array.isArray(product.variants) ? product.variants : [])
    .map((v) => (typeof v?.price === 'number' ? v.price : parseFloat(v?.price)))
    .filter((n) => Number.isFinite(n) && n > 0);
  const useAggregate = variantPrices.length >= 1 && Math.min(...variantPrices) !== Math.max(...variantPrices);

  const offers = useAggregate
    ? {
        "@type": "AggregateOffer",
        "url": typeof window !== 'undefined' ? window.location.href : undefined,
        "priceCurrency": "SEK",
        "lowPrice": Math.min(...variantPrices),
        "highPrice": Math.max(...variantPrices),
        "offerCount": product.variants.length,
        "availability": availability
      }
    : {
        "@type": "Offer",
        "url": typeof window !== 'undefined' ? window.location.href : undefined,
        "priceCurrency": "SEK",
        "price": product.b2cPrice || product.basePrice,
        "priceValidUntil": new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0],
        "itemCondition": "https://schema.org/NewCondition",
        "availability": availability
      };

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": product.name,
    "description": product.descriptions?.b2c || product.description,
    "image": [
      product.b2cImageUrl || product.imageUrl,
      ...(product.b2cImageGallery || [])
    ],
    ...(product.brand ? { "brand": { "@type": "Brand", "name": product.brand } } : {}),
    ...(product.reviewCount > 0
      ? {
          "aggregateRating": {
            "@type": "AggregateRating",
            "ratingValue": (product.ratingSum / product.reviewCount).toFixed(1),
            "reviewCount": product.reviewCount
          }
        }
      : {}),
    "offers": offers,
    "sku": product.sku || product.id,
    "gtin13": product.eanCode || undefined,
    ...(product.category ? { "category": product.category } : {})
  };
}; 