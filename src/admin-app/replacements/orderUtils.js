// The admin build's order utilities (alias of src/utils/orderUtils.js).
//
// The original also reads order shapes of the source system's earliest days
// (a distribution map, an article-number pattern of one product line). An
// order of the API always has its lines (src/admin-app/adapters/order.js), so
// only that branch is here, and no article number is parsed.

/** Kept for the callers' imports: an article number says nothing about colour or size here. */
export const extractColorSizeFromSku = () => ({ color: null, size: null });

/** The order's lines as the pages print them. */
export const getEnhancedOrderDistribution = (order) => {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.map((item) => ({
    ...item,
    label: item.label || null,
    color: item.color || null,
    size: item.size || null,
    name: item.name || 'Produkt',
    quantity: item.quantity || 0,
    price: item.price || 0,
  }));
};

/** Format a colour name for display (a string, or a map of language → name). */
export const getDisplayColor = (color) => {
  if (!color) return '-';
  if (typeof color === 'string') return color;
  if (typeof color === 'object') {
    return color['sv-SE'] || color['en-GB'] || color['en-US'] || Object.values(color)[0] || '-';
  }
  return String(color);
};

/** Format a size for display (a string, or a map of language → name). */
export const getDisplaySize = (size) => {
  if (!size) return '-';
  if (typeof size === 'string') return size;
  if (typeof size === 'object') {
    return size['sv-SE'] || size['en-GB'] || size['en-US'] || Object.values(size)[0] || '-';
  }
  return String(size);
};
