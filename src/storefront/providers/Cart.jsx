// The cart of the Cloudflare storefront. `useCart()` returns the same value as
// CartContext.jsx, with two changes:
//
//  1. TWO CODES (CP8-DC campaign codes; CP13 the affiliate link, design §2.1,
//     §2.2, §7.4). `applyDiscountCode(raw)` asks the API's preview (POST
//     /v1/discount-codes/preview) once per call and answers `{ success,
//     message, notice? }`, the contract the shared pages read. An applying
//     typed code is kept with the cart (`cart.discountCode`). A landing with
//     `?ref=CODE` (shop with the `affiliate` add-on on) keeps the link's code
//     as `cart.refCode` + `source: 'link'` + `refAt` (the landing's time),
//     dropped after 30 days and by a completed checkout (clearCart); the
//     parameter leaves the address. Both codes go to the preview and to the
//     checkout (`refCode` beside `discountCode`); the server decides (the
//     link wins over a typed code and says so). The preview's amount is what
//     the cart shows, asked again 500 ms after the lines change. The payment
//     step shows the server's checkout, whose answer counts. A typed code is
//     dropped when neither add-on is on; with `affiliate` off the link's code
//     is kept but not sent (the hook is inert).
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
import { cartDeliveryOf, sameDelivery } from '../adapters/products.js';
import { previewDiscountCode } from '../../api/discountCodes.js';
import {
  DISCOUNT_MESSAGES,
  LINK_MESSAGES,
  currentDiscountMinor,
  currentPreview,
  discountNoticeOf,
  hasRefParameter,
  keepTypedCode,
  isDiscountCodeShape,
  normalizeDiscountCode,
  previewCodes,
  previewOutcome,
  refCodeFromSearch,
  searchWithoutRef,
  storedDiscountCode,
  storedRef,
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

const emptyCart = () => ({ items: [], shippingCountry: 'SE', discountCode: null, refCode: null, source: null, refAt: null });

// The stored shape (CP13): { items, shippingCountry, discountCode, refCode,
// source: 'link' | null, refAt: <ms> | null }. A link stamp older than 30 days
// is dropped here.
export const loadStoredCart = (root, now = Date.now()) => {
  try {
    const saved = JSON.parse(localStorage.getItem(cartStorageKey(root)) || 'null');
    return saved && Array.isArray(saved.items)
      ? {
          items: saved.items,
          shippingCountry: saved.shippingCountry || 'SE',
          discountCode: storedDiscountCode(saved.discountCode),
          ...storedRef(saved, now),
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
  // CP13: the code box serves both families; each is decided by the server
  // under its own switch.
  const affiliateOn = isEnabled('affiliate');
  const discountsOn = affiliateOn || isEnabled('discountCodes');
  const [cart, setCart] = useState(() => loadStoredCart(root));
  // The `ref` of the address the page was opened with, read before any
  // client-side move can change the address; acted on once the storefront has
  // said whether the program is on.
  const landingRef = useRef(
    typeof window === 'undefined'
      ? { code: null, present: false }
      : { code: refCodeFromSearch(window.location.search), present: hasRefParameter(window.location.search) },
  );
  // The link's code that is LIVE: stamped within 30 days, the program on.
  const linkCode = affiliateOn ? storedRef(cart).refCode : null;
  const cartRootRef = useRef(root);
  // The last preview of the cart's codes: { applies, code, discountMinor,
  // typed, ref } (`code`: the code the server answered for), or null while
  // there is none (no code, not asked yet, or no answer).
  const [discountPreview, setDiscountPreview] = useState(null);
  // The codes and lines the last preview answered for, so a press of
  // "Applicera" is not asked a second time by the effect below.
  const previewedFor = useRef(null);

  // The `?ref=` landing (design §2.1): once the storefront answered with the
  // program on, the code is stamped into this shop's cart and the parameter
  // leaves the address (history.replaceState; the router's own state is
  // kept). With the program off nothing happens.
  useEffect(() => {
    if (storefrontStatus !== 'ready' || !affiliateOn) return;
    const landing = landingRef.current;
    if (!landing.present) return;
    landingRef.current = { code: null, present: false };
    if (landing.code !== null) {
      setCart((prev) => ({ ...prev, refCode: landing.code, source: 'link', refAt: Date.now() }));
    }
    try {
      const { pathname, search, hash } = window.location;
      if (hasRefParameter(search)) {
        window.history.replaceState(window.history.state, '', `${pathname}${searchWithoutRef(search)}${hash}`);
      }
    } catch {
      // An address that cannot be rewritten keeps its parameter; the code is stored.
    }
  }, [storefrontStatus, affiliateOn]);

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
  // CP11 U7: the countries EVERY line can be shipped to (the intersection of
  // the lines' `shipsTo`), or null when no line restricts — the same rule the
  // checkout applies (it refuses any other country).
  const cartShipsTo = cart.items.reduce((allowed, item) => {
    const own = item.delivery?.shipsTo;
    if (!Array.isArray(own)) return allowed;
    return allowed === null ? [...own] : allowed.filter((code) => own.includes(code));
  }, null);

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
    // The preview's amount for the codes the cart holds; the server prices the order.
    const preview = currentPreview(discountPreview, cart.discountCode, linkCode);
    const discountAmount = currentDiscountMinor(preview) / 100;
    const total = subtotal + shipping - discountAmount;
    const vat = total - total / (1 + STORE.vatRate);
    return {
      subtotal,
      vat,
      shipping,
      total,
      discountAmount,
      discountCode: cart.discountCode,
      // CP13: the code the discount row names ("Rabatt (KOD)"): the one the
      // server applied, the link's when it won.
      appliedCode: discountAmount > 0 ? preview.code : null,
      // A preview names no percentage: the label is "Rabatt (KOD)".
      discountPercentage: 0,
      discountSource: discountAmount > 0 ? 'campaign' : null,
    };
  };

  // What the code box says (CP13): the link's code added or used instead of
  // the typed one, or the typed code not applying.
  const discountNotice = discountNoticeOf(currentPreview(discountPreview, cart.discountCode, linkCode), {
    typed: cart.discountCode,
    ref: linkCode,
  });
  const linkMessage = (notice) => {
    const words = notice ? LINK_MESSAGES[notice.kind] : null;
    if (!words) return null;
    const [key, fallback] = words;
    return t(key, fallback, { code: notice.code });
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
  // the field's text and hands only the pressed value here. With a live link
  // code both are asked for; the typed code is kept when anything applies
  // (CP13: also when the link wins, so the checkout sends both and the
  // server's answer names the winner).
  const applyDiscountCode = async (raw) => {
    const code = normalizeDiscountCode(raw);
    if (!discountsOn || cart.items.length === 0) {
      return { success: false, message: messageOf('not_applicable') };
    }
    if (!isDiscountCodeShape(code)) {
      return { success: false, message: messageOf('invalid_format') };
    }
    // The link's own code typed again: nothing new to keep.
    const typed = code === linkCode ? null : code;
    let outcome;
    let discount = null;
    try {
      discount = await previewDiscountCode({ ...previewCodes(typed, linkCode), items: checkoutItems() });
      outcome = previewOutcome({ discount });
    } catch (error) {
      if (error?.name === 'AbortError') return { success: false };
      outcome = previewOutcome({ error });
    }
    if (outcome === 'applies') {
      previewedFor.current = `${typed}\n${linkCode}\n${JSON.stringify(checkoutItems())}`;
      setCart((prev) => ({ ...prev, discountCode: typed }));
      setDiscountPreview({ applies: true, code: discount.code, discountMinor: discount.discountMinor, typed, ref: linkCode });
      if (linkCode && discount.code === linkCode) {
        const notice = typed ? { kind: 'link_overridden', code: linkCode } : { kind: 'link_added', code: linkCode };
        return { success: true, notice: true, message: linkMessage(notice) };
      }
      return { success: true, message: messageOf('applies') };
    }
    // CP13 (Codex 1): a 200 without a discount keeps a code of the affiliate
    // grammar, so a commission-only affiliate's code still reaches the
    // checkout and earns; the buyer is told, truthfully, that it gave no
    // discount now, and may take it away.
    if (typed && keepTypedCode(outcome, typed)) {
      previewedFor.current = `${typed}\n${linkCode}\n${JSON.stringify(checkoutItems())}`;
      setCart((prev) => ({ ...prev, discountCode: typed }));
      setDiscountPreview({ applies: false, code: discount.code, discountMinor: 0, typed, ref: linkCode });
      return { success: true, notice: true, message: linkMessage({ kind: 'no_discount', code: typed }) };
    }
    return { success: false, message: messageOf(outcome) };
  };

  // Takes away the typed code only; the link stamp is never touched here
  // (a notice about a typed code must not cost the affiliate its attribution).
  const removeDiscount = useCallback(() => {
    previewedFor.current = null;
    setCart((prev) => (prev.discountCode === null ? prev : { ...prev, discountCode: null }));
    setDiscountPreview(null);
  }, []);

  // CP13: the buyer's own choice to drop the link's code ("Ta bort" beside it).
  const removeLinkCode = useCallback(() => {
    previewedFor.current = null;
    setCart((prev) => (prev.refCode === null ? prev : { ...prev, refCode: null, source: null, refAt: null }));
    setDiscountPreview(null);
  }, []);

  // A shop with neither add-on on keeps no typed code, once its storefront has said so.
  useEffect(() => {
    if (storefrontStatus === 'ready' && !discountsOn && cart.discountCode !== null) {
      previewedFor.current = null;
      setCart((prev) => ({ ...prev, discountCode: null }));
      setDiscountPreview(null);
    }
  }, [storefrontStatus, discountsOn, cart.discountCode]);

  // The stored codes against the lines as they are now: asked again once the
  // lines (or a code) have stayed the same for REPREVIEW_DELAY_MS. A code
  // that stops applying stays stored (the buyer may add to reach a minimum);
  // the cart then shows no discount and says so.
  const linesKey = JSON.stringify(checkoutItems());
  useEffect(() => {
    const typed = cart.discountCode;
    const codes = previewCodes(typed, linkCode);
    if (codes === null || !discountsOn || cart.items.length === 0) {
      previewedFor.current = null;
      setDiscountPreview(null);
      return undefined;
    }
    const askedFor = `${typed}\n${linkCode}\n${linesKey}`;
    if (previewedFor.current === askedFor) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const discount = await previewDiscountCode({ ...codes, items: JSON.parse(linesKey) }, { signal: controller.signal });
        previewedFor.current = askedFor;
        setDiscountPreview({
          applies: previewOutcome({ discount }) === 'applies',
          code: discount.code,
          discountMinor: discount.discountMinor,
          typed,
          ref: linkCode,
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
  }, [linesKey, cart.discountCode, linkCode, discountsOn]);

  // `quiet` (CP9-AC): no "added to cart" modal, for the reminder link that
  // rebuilds a whole cart at once (pages/shop/CheckoutRecoveryPage.jsx).
  const addToCart = (product, quantity = 1, variant = null, { quiet = false } = {}) => {
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
      // Shipping, pickup and (CP11 U7) the countries a POD product's printer
      // ships to (the API's `shipsTo`; absent = no restriction).
      delivery: cartDeliveryOf(product),
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
      if (!quiet) setTimeout(() => showAddedToCartModal(addedItem), 100);
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
        // CP11 U7 (Codex P2): the live product's delivery restriction, so a
        // cart saved before it existed (no shipsTo, pickup still allowed)
        // never offers what checkout now refuses.
        delivery: cartDeliveryOf(product),
      };
      if (
        next.price !== item.price ||
        next.label !== item.label ||
        next.image !== item.image ||
        next.variantId !== item.variantId ||
        !sameDelivery(next.delivery, item.delivery)
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

  // `keepRef` (CP13): rebuilding a cart that is not a completed checkout (the
  // reminder's resume link) keeps the link stamp; a completed checkout drops it.
  const clearCart = ({ keepRef = false } = {}) => {
    setCart((prev) =>
      keepRef ? { ...emptyCart(), refCode: prev.refCode, source: prev.source, refAt: prev.refAt } : emptyCart(),
    );
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
    // CP13: the live link code (sent as the checkout's `refCode`), what the
    // code box says, and its words.
    linkCode,
    removeLinkCode,
    discountNotice,
    discountNoticeMessage: linkMessage(discountNotice),
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
    cartShipsTo,
    hasDeliveryConflict,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};
