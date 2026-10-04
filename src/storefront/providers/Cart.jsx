// The cart of the Cloudflare storefront. `useCart()` returns the same value as
// CartContext.jsx, with two changes:
//
//  1. CAMPAIGN CODES ONLY (CP8-DC; the affiliate program is not ported, D81).
//     `applyDiscountCode(raw)` asks the API's preview (POST
//     /v1/discount-codes/preview) once per call and answers `{ success,
//     message }`, the contract the shared pages read. An applying code is
//     kept with the cart (`cart.discountCode`) and sent with the checkout;
//     the preview's amount is what the cart shows, and it is asked again
//     500 ms after the lines change. The payment step shows the server's
//     checkout, whose answer counts. A shop with the add-on off keeps no code.
//  2. A line carries the API's ids: `productId` and `variantId` (money is keyed
//     on the variant's sku, the line id stays `productId::variantSku`).
//     `checkoutItems()` gives the lines as POST /v1/checkout takes them.
//
// `addToCart` takes the API's product and variant shapes (`productId`,
// `priceMinor`, `image.url`) and, until every page is swapped, the Firebase
// ones (`id`, `b2cPrice`, `price`, `b2cImageUrl`). Prices in a line stay in
// kronor, as every page displays them; the server prices the order.
//
// The cart is kept per shop root (one origin serves every shop on the shared
// host), under a key of its own: nothing of the Firebase cart is read.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { STORE } from '../../config/store';
import { previewDiscountCode } from '../../api/discountCodes.js';
import {
  DISCOUNT_MESSAGES,
  isDiscountCodeShape,
  normalizeDiscountCode,
  previewedDiscountMinor,
  previewOutcome,
  storedDiscountCode,
} from '../adapters/discount.js';
import { useShopFeatures } from './ShopFeatures.jsx';
import { useStorefront } from './Storefront.jsx';
import { useStorefrontRoot } from './ShopRoot.jsx';
import { useTranslation } from './Translation.jsx';

// Shipping constants, as CartContext.jsx exports them (pages import them).
export const SHIPPING_COSTS = {
  NORDIC: {
    cost: 19,
    countries: ['SE', 'NO', 'DK', 'FI', 'IS'],
    label: 'Norden',
  },
  INTERNATIONAL: {
    cost: 59,
    label: 'Internationellt',
  },
};

const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES'];

/** How long the lines must stay still before the stored code is previewed again. */
const REPREVIEW_DELAY_MS = 500;

export const cartStorageKey = (root) => `storefront-cart:${root ?? ''}`;

const emptyCart = () => ({ items: [], shippingCountry: 'SE', discountCode: null });

export const loadStoredCart = (root) => {
  try {
    const saved = JSON.parse(localStorage.getItem(cartStorageKey(root)) || 'null');
    return saved && Array.isArray(saved.items)
      ? {
          items: saved.items,
          shippingCountry: saved.shippingCountry || 'SE',
          discountCode: storedDiscountCode(saved.discountCode),
        }
      : emptyCart();
  } catch {
    return emptyCart();
  }
};

function saveCart(root, cart) {
  try {
    localStorage.setItem(cartStorageKey(root), JSON.stringify(cart));
  } catch {
    // Storage refused: the cart lives for this page only.
  }
}

/** A unit price in kronor: the API's minor units first, then the Firebase fields. */
function unitPriceOf(product, variant) {
  if (variant && typeof variant.priceMinor === 'number') return variant.priceMinor / 100;
  if (variant && (variant.price ?? null) !== null) return variant.price;
  if (typeof product.priceMinor === 'number') return product.priceMinor / 100;
  return product.b2cPrice || product.basePrice;
}

function imageOf(product, variant) {
  const pick = (image) => (typeof image === 'string' ? image : image?.url) || null;
  return (
    pick(variant?.image) ||
    pick(product.image) ||
    product.b2cImageUrl ||
    (Array.isArray(product.b2cImageGallery) ? product.b2cImageGallery[0] : null) ||
    null
  );
}

const CartContext = createContext(null);

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};

export const CartProvider = ({ children }) => {
  const root = useStorefrontRoot();
  const { t } = useTranslation();
  const { status: storefrontStatus } = useStorefront();
  const { isEnabled } = useShopFeatures();
  const discountsOn = isEnabled('discountCodes');
  const [cart, setCart] = useState(() => loadStoredCart(root));
  const cartRootRef = useRef(root);
  // The last preview of the stored code: { code, applies, discountMinor }, or
  // null while there is none (no code, not asked yet, or no answer).
  const [discountPreview, setDiscountPreview] = useState(null);
  // The code and lines the last preview answered for, so a press of
  // "Applicera" is not asked a second time by the effect below.
  const previewedFor = useRef(null);

  const [isAddedToCartModalVisible, setIsAddedToCartModalVisible] = useState(false);
  const [lastAddedItem, setLastAddedItem] = useState(null);

  // Delivery (Click & Collect): session-only, as in CartContext.jsx.
  const [deliveryMethod, setDeliveryMethod] = useState('home');
  const [pickupLocation, setPickupLocation] = useState(null);
  const [pickupDate, setPickupDate] = useState('');

  const selectHomeDelivery = useCallback(() => {
    setDeliveryMethod('home');
    setPickupLocation(null);
    setPickupDate('');
  }, []);
  const selectPickup = useCallback((location) => {
    setDeliveryMethod('pickup');
    setPickupLocation((prev) => {
      if (!location || prev?.id !== location.id) setPickupDate('');
      return location || null;
    });
  }, []);

  const cartAllowsHome = cart.items.length > 0 && cart.items.every((i) => i.delivery?.shipping !== false);
  const cartAllowsPickup = cart.items.length > 0 && cart.items.every((i) => i.delivery?.pickup !== false);
  const hasDeliveryConflict = cart.items.length > 0 && !cartAllowsHome && !cartAllowsPickup;

  useEffect(() => {
    if (cart.items.length === 0 || hasDeliveryConflict) return;
    if (deliveryMethod === 'pickup' && !cartAllowsPickup) {
      setDeliveryMethod('home');
      setPickupLocation(null);
    } else if (deliveryMethod === 'home' && !cartAllowsHome && cartAllowsPickup) {
      setDeliveryMethod('pickup');
    }
  }, [cartAllowsHome, cartAllowsPickup, hasDeliveryConflict, deliveryMethod, cart.items.length]);

  // Save under the ACTIVE root; declared before the swap so a move between
  // shops never writes one shop's cart under the other's key (CartContext.jsx).
  useEffect(() => {
    if (cartRootRef.current !== root) return;
    saveCart(root, cart);
  }, [cart, root]);

  useEffect(() => {
    if (cartRootRef.current === root) return;
    cartRootRef.current = root;
    setCart(loadStoredCart(root));
  }, [root]);

  const getShippingRegion = (country) => {
    if (country === 'SE') return 'Sverige';
    if (SHIPPING_COSTS.NORDIC.countries.includes(country)) return 'Norden';
    return EU_COUNTRIES.includes(country) ? 'EU' : 'Världen';
  };

  // The display estimate of CartContext.jsx; the server prices the order.
  const shippingRegionKey = (country) => {
    if (country === 'SE') return 'sweden';
    if (['NO', 'DK', 'FI'].includes(country)) return 'nordic';
    if (EU_COUNTRIES.includes(country)) return 'eu';
    return 'worldwide';
  };

  const getShippingCost = (country) => {
    if (!cart.items || cart.items.length === 0) return 0;
    const region = shippingRegionKey(country);
    let baseShippingCost = cart.items[0]?.shipping?.[region]?.cost || 0;
    if (baseShippingCost === 0) {
      baseShippingCost = country === 'SE' ? 29 : 49;
    }
    const totalProductWeight = cart.items.reduce(
      (sum, item) => sum + (item.weight?.value || 10) * item.quantity,
      0,
    );
    return baseShippingCost * Math.ceil((totalProductWeight + 20) / 50);
  };

  const getTotalItems = () => cart.items.reduce((total, item) => total + item.quantity, 0);

  const getShippingTierInfo = (country) => {
    if (!cart.items || cart.items.length === 0) {
      return { totalQuantity: 0, totalShippingCost: 0, explanation: 'Ingen frakt - tom varukorg' };
    }
    return {
      totalQuantity: getTotalItems(),
      totalShippingCost: getShippingCost(country),
      explanation: `Frakt (${shippingRegionKey(country)})`,
    };
  };

  const showAddedToCartModal = (item) => {
    setLastAddedItem(item);
    setIsAddedToCartModalVisible(true);
  };

  const hideAddedToCartModal = () => {
    setIsAddedToCartModalVisible(false);
    setLastAddedItem(null);
  };

  const calculateTotals = () => {
    const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = deliveryMethod === 'pickup' ? 0 : getShippingCost(cart.shippingCountry);
    // The preview's amount for the code the cart holds; the server prices the order.
    const discountAmount = previewedDiscountMinor(discountPreview, cart.discountCode) / 100;
    const total = subtotal + shipping - discountAmount;
    const vat = total - total / (1 + STORE.vatRate);
    return {
      subtotal,
      vat,
      shipping,
      total,
      discountAmount,
      discountCode: cart.discountCode,
      // A preview names no percentage: the label is "Rabatt".
      discountPercentage: 0,
      discountSource: discountAmount > 0 ? 'campaign' : null,
    };
  };

  const messageOf = (outcome) => {
    const [key, fallback] = DISCOUNT_MESSAGES[outcome];
    return t(key, fallback);
  };

  /** The lines as POST /v1/checkout and the preview take them. */
  const checkoutItems = () =>
    cart.items.map(({ productId, quantity, variantId }) =>
      variantId ? { productId, quantity, variantId } : { productId, quantity },
    );

  // One preview per press of "Applicera", never per keystroke: the page keeps
  // the field's text and hands only the pressed value here.
  const applyDiscountCode = async (raw) => {
    const code = normalizeDiscountCode(raw);
    if (!discountsOn || cart.items.length === 0) {
      return { success: false, message: messageOf('not_applicable') };
    }
    if (!isDiscountCodeShape(code)) {
      return { success: false, message: messageOf('invalid_format') };
    }
    let outcome;
    let discount = null;
    try {
      discount = await previewDiscountCode({ code, items: checkoutItems() });
      outcome = previewOutcome({ discount });
    } catch (error) {
      if (error?.name === 'AbortError') return { success: false };
      outcome = previewOutcome({ error });
    }
    if (outcome === 'applies') {
      previewedFor.current = `${discount.code}\n${JSON.stringify(checkoutItems())}`;
      setCart((prev) => ({ ...prev, discountCode: discount.code }));
      setDiscountPreview({ applies: true, code: discount.code, discountMinor: discount.discountMinor });
      return { success: true, message: messageOf('applies') };
    }
    return { success: false, message: messageOf(outcome) };
  };

  const removeDiscount = useCallback(() => {
    previewedFor.current = null;
    setCart((prev) => (prev.discountCode === null ? prev : { ...prev, discountCode: null }));
    setDiscountPreview(null);
  }, []);

  // A shop with the add-on off keeps no code, once its storefront has said so.
  useEffect(() => {
    if (storefrontStatus === 'ready' && !discountsOn && cart.discountCode !== null) removeDiscount();
  }, [storefrontStatus, discountsOn, cart.discountCode, removeDiscount]);

  // The stored code against the lines as they are now: asked again once the
  // lines (or the code) have stayed the same for REPREVIEW_DELAY_MS. A code
  // that stops applying stays stored (the buyer may add to reach a minimum);
  // the cart then shows no discount and says so.
  const linesKey = JSON.stringify(checkoutItems());
  useEffect(() => {
    const code = cart.discountCode;
    if (code === null || !discountsOn || cart.items.length === 0) {
      previewedFor.current = null;
      setDiscountPreview(null);
      return undefined;
    }
    const askedFor = `${code}\n${linesKey}`;
    if (previewedFor.current === askedFor) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const discount = await previewDiscountCode({ code, items: JSON.parse(linesKey) }, { signal: controller.signal });
        previewedFor.current = askedFor;
        setDiscountPreview({
          applies: previewOutcome({ discount }) === 'applies',
          code,
          discountMinor: discount.discountMinor,
        });
      } catch (error) {
        if (error?.name !== 'AbortError') setDiscountPreview(null);
      }
    }, REPREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, cart.discountCode, discountsOn]);

  const addToCart = (product, quantity = 1, variant = null) => {
    const productId = product.productId ?? product.id;
    const variantSku = variant?.sku || null;
    const lineId = `${productId}::${variantSku || ''}`;
    const unitPrice = unitPriceOf(product, variant);

    const buildItem = (qty) => ({
      lineId,
      productId,
      variantId: variant?.variantId ?? null,
      variantSku,
      label: variant?.label || null,
      name: product.name,
      price: unitPrice,
      image: imageOf(product, variant),
      sku: variant?.sku || product.sku,
      weight: product.weight,
      shipping: product.shipping,
      delivery: {
        shipping: product.delivery?.shipping !== false,
        pickup: product.delivery?.pickup !== false,
      },
      isPersonalized: product.isPersonalized === true,
      quantity: qty,
    });

    setCart((prevCart) => {
      const idx = prevCart.items.findIndex((item) => item.lineId === lineId);
      const newItems = [...prevCart.items];
      let addedItem;
      if (idx > -1) {
        const merged = buildItem(newItems[idx].quantity + quantity);
        newItems[idx] = merged;
        addedItem = { ...merged, quantity, formattedPrice: `${unitPrice} kr` };
      } else {
        const item = buildItem(quantity);
        newItems.push(item);
        addedItem = { ...item, formattedPrice: `${unitPrice} kr` };
      }
      setTimeout(() => showAddedToCartModal(addedItem), 100);
      return { ...prevCart, items: newItems };
    });
  };

  const updateQuantity = (lineId, newQuantity) => {
    setCart((prevCart) => ({
      ...prevCart,
      items: prevCart.items
        .map((item) => (item.lineId === lineId ? { ...item, quantity: Math.max(0, newQuantity) } : item))
        .filter((item) => item.quantity > 0),
    }));
  };

  const removeFromCart = (lineId) => {
    setCart((prevCart) => ({ ...prevCart, items: prevCart.items.filter((item) => item.lineId !== lineId) }));
  };

  /**
   * Drops lines whose product or variant is no longer public and refreshes
   * price, label and image of the rest. `productsById[productId]` is the API's
   * product detail, null when the API answered 404, undefined when not fetched.
   * Returns the display names of the removed lines.
   */
  const reconcileCart = (productsById) => {
    const removed = [];
    let mutated = false;
    const items = [];
    for (const item of cart.items) {
      const product = productsById[item.productId];
      if (product === undefined) {
        items.push(item);
        continue;
      }
      const displayName = item.label ? `${item.name} (${item.label})` : item.name || item.sku || '';
      if (!product) {
        removed.push(displayName);
        mutated = true;
        continue;
      }
      const row = item.variantSku && Array.isArray(product.variants)
        ? product.variants.find((v) => v && v.sku === item.variantSku)
        : null;
      if (item.variantSku && !row) {
        removed.push(displayName);
        mutated = true;
        continue;
      }
      const livePrice = unitPriceOf(product, row);
      const next = {
        ...item,
        variantId: row?.variantId ?? item.variantId ?? null,
        price: livePrice > 0 ? livePrice : item.price,
        label: row ? row.label || item.label : item.label,
        image: imageOf(product, row) || item.image,
      };
      if (
        next.price !== item.price ||
        next.label !== item.label ||
        next.image !== item.image ||
        next.variantId !== item.variantId
      ) {
        mutated = true;
      }
      items.push(next);
    }
    if (mutated) setCart((prev) => ({ ...prev, items }));
    return removed;
  };

  const updateShippingCountry = (country) => {
    setCart((prevCart) => ({ ...prevCart, shippingCountry: country }));
  };

  const clearCart = () => {
    setCart(emptyCart());
    setDeliveryMethod('home');
    setPickupLocation(null);
    setPickupDate('');
  };

  const value = {
    cart,
    addToCart,
    updateQuantity,
    removeFromCart,
    updateShippingCountry,
    reconcileCart,
    clearCart,
    calculateTotals,
    checkoutItems,
    applyDiscountCode,
    removeDiscount,
    discountPreview,
    getTotalItems,
    getShippingRegion,
    getShippingTierInfo,
    SHIPPING_COSTS,
    isAddedToCartModalVisible,
    showAddedToCartModal,
    hideAddedToCartModal,
    lastAddedItem,
    deliveryMethod,
    pickupLocation,
    pickupDate,
    setPickupDate,
    selectHomeDelivery,
    selectPickup,
    cartAllowsHome,
    cartAllowsPickup,
    hasDeliveryConflict,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};
