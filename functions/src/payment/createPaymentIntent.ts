/**
 * Firebase Function: Create Stripe Payment Intent
 * Handles server-side payment intent creation for B2C checkout
 */

import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import Stripe from 'stripe';
import { commerceConfig } from '../config/app-urls';
import { corsHandler } from '../protection/cors/cors-handler';
import { db } from '../config/database';
import { DEFAULT_SHOP_ID } from '../config/tenancy';
import { isShopFeatureEnabled } from '../config/shopFeatures';
import { buildConnectChargeParams } from './connectParams';
import { readPlatformConfig } from './platformConfig';
import {
  writeAbandonedCheckoutDoc,
  writeCheckoutProductionSnapshot,
} from '../checkout-recovery/writeCheckoutDoc';
import { checkRateLimit, trustedClientIp } from '../protection/rate-limiting/durableRateLimit';
import { buildProductionSnapshotAtomically } from '../print/printProjection';

/**
 * Server-side price computation. NEVER trust client-supplied amounts:
 * prices come from the products collection, the discount from the affiliate
 * doc, and shipping from product shipping data (mirrors CartContext logic).
 * All amounts are SEK, VAT-inclusive.
 */
function getShippingRegion(country: string): string {
  if (country === 'SE') return 'sweden';
  if (['NO', 'DK', 'FI'].includes(country)) return 'nordic';
  const euCountries = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES'];
  return euCountries.includes(country) ? 'eu' : 'worldwide';
}

// ────────────────────────────────────────────────────────────────────────────
// P0-03 CHECKOUT INVARIANTS (2026-08-15 audit) — pure, unit-tested helpers
// (rules-tests/checkout-invariants.test.cjs runs them against functions/lib).
// ────────────────────────────────────────────────────────────────────────────

// A shop that must not be charged against: platform kill-switch (status
// 'disabled') or the GO-LIVE gate (published === false — absent means live,
// matching the storefront's live-gate semantics: existing shops stay live).
export function shopCheckoutBlockReason(shop: any): string | null {
  if (!shop) return 'unknown-shop';
  if (shop.status === 'disabled') return 'shop-disabled';
  if (shop.published === false) return 'shop-not-published';
  return null;
}

// P1-06 (2026-08-15 audit): pickup zeroes shipping, so the SERVER must verify
// the shop actually offers pickup and that the chosen location is one of the
// shop's configured points — name/address are then taken from the shop config,
// never from the client payload. Returns null when the location can't resolve.
export function resolvePickupLocation(
  shop: any,
  pickupLocationId: unknown,
  pickupLocationDate?: unknown,
  todayIso = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
): { id: string; name: string; address: string; date: string } | null {
  const locations = Array.isArray(shop?.storeIdentity?.pickupLocations)
    ? shop.storeIdentity.pickupLocations
    : [];
  const locId = String(pickupLocationId || '');
  if (!locId) return null;
  const loc = locations.find((l: any) => l && l.id === locId);
  if (!loc) return null;
  const dates = Array.isArray(loc.dates)
    ? loc.dates.map((d: unknown) => String(d || '')).filter(Boolean)
    : [];
  const requestedDate = String(pickupLocationDate || '');
  if (dates.length > 0 && (!dates.includes(requestedDate) || requestedDate < todayIso)) return null;
  return {
    id: String(loc.id),
    name: String(loc.name || ''),
    address: String(loc.address || ''),
    date: dates.length > 0 ? requestedDate : '',
  };
}

export function withdrawalConsentBlockReason(
  hasPersonalizedItem: boolean,
  consent: any
): string | null {
  if (!hasPersonalizedItem) return null;
  if (consent?.accepted !== true) return 'consent-required';
  if (!String(consent.noticeVersion || '').trim()) return 'notice-version-required';
  if (!/^h[0-9a-f]+$/i.test(String(consent.noticeFingerprint || '').trim())) {
    return 'notice-fingerprint-invalid';
  }
  return null;
}

export interface ServerCartLine {
  productId: string;
  variantSku: string | null;
  quantity: number;
  price: number;
  sku: string;
  name: string;
  label: string;
  image: string;
  isPersonalized: boolean;
  isPodProduct: boolean;
}

// Validate ONE cart line against the SERVER product doc and derive the
// authoritative line snapshot. The client contributes only (productId,
// variantSku, quantity) — tenant, availability, price, SKU, name, label and
// image all come from the product/variant doc, so a crafted cart can no longer
// cross shop, pricing or print-routing (order SKU → podMappings) boundaries.
export function validateCartLine(
  product: any,
  item: { productId?: string; id?: string; variantSku?: string | null; quantity: number },
  shopId: string,
  deliveryMethod: string
): ServerCartLine {
  const productId = item.productId || item.id; // tolerate either key
  const quantity = Math.floor(Number(item.quantity));
  if (!productId || !Number.isFinite(quantity) || quantity < 1 || quantity > 1000) {
    throw new Error(`Invalid cart item: ${productId}`);
  }
  if (!product) {
    throw new Error(`Unknown product: ${productId}`);
  }
  // TENANT (P0-03): the product must belong to the shop being charged —
  // a foreign product id must never price a line or stamp a foreign SKU.
  if (product.shopId !== shopId) {
    throw new Error(`Product not in shop: ${productId}`);
  }
  if (product.isActive === false) {
    throw new Error(`Product not available: ${productId}`);
  }
  // B2C availability (P0-03): a B2B-only product is not purchasable through
  // the public checkout. Default-ON (absent field = available), mirroring the
  // createB2BOrder b2b-availability check.
  if (product.availability?.b2c === false) {
    throw new Error(`Product not available for B2C: ${productId}`);
  }

  // Per-product delivery modes (Delivery & Pickup v2). Default-ON: a product
  // without the `delivery` field permits both methods. Reject a charge whose
  // delivery method is disabled for this product — anti-tamper backstop for the
  // client-side restriction (a tampered client could otherwise send 'pickup'
  // for a shipping-only product to zero shipping, or 'home' for a pickup-only
  // one). The legitimate client never sends a disabled method.
  if (deliveryMethod === 'pickup' && product.delivery?.pickup === false) {
    throw new Error(`Product not available for pickup: ${productId}`);
  }
  if (deliveryMethod === 'home' && product.delivery?.shipping === false) {
    throw new Error(`Product not available for home delivery: ${productId}`);
  }

  // Resolve price: a chosen variant's price (matched by sku) wins, else the
  // product price. A variantSku that doesn't match any variant is rejected.
  let price = product.b2cPrice || product.basePrice || 0;
  const variantSku = item.variantSku || null;
  let variant: any = null;
  if (variantSku) {
    variant = Array.isArray(product.variants)
      ? product.variants.find((v: any) => v && v.sku === variantSku)
      : null;
    if (!variant) {
      throw new Error(`Unknown variant ${variantSku} for product ${productId}`);
    }
    price = (variant.price ?? null) !== null ? variant.price : price;
  }
  if (!price || price <= 0) {
    throw new Error(`Product has no valid price: ${productId}`);
  }

  // SERVER-derived display/fulfilment snapshot (never the client's copy).
  // Name flattening + image priority mirror the client (CartContext), so the
  // order shows what the buyer saw — but sourced from the live product doc.
  const name = typeof product.name === 'string'
    ? product.name
    : (product.name?.['sv-SE'] || product.name?.['en-US'] || product.name?.['en-GB'] || 'Product');
  return {
    productId,
    variantSku,
    quantity,
    price,
    sku: variant?.sku || product.sku || '',
    name,
    label: variant?.label || '',
    image: variant?.image || product.b2cImageUrl || product.b2cImageGallery?.[0] || product.imageUrl || '',
    isPersonalized: product.isPersonalized === true,
    isPodProduct: product.isPodProduct === true,
  };
}

async function computeOrderTotalsSek(
  cartItems: Array<{ productId?: string; id?: string; variantSku?: string | null; quantity: number }>,
  shippingCountry: string,
  discountCode: string | undefined,
  shopId: string,
  deliveryMethod: string
): Promise<{ subtotal: number; discountAmount: number; discountPercentage: number; discountSource: 'affiliate' | 'campaign' | null; discountCodeId: string | null; shipping: number; vat: number; total: number; serverPrices: Record<string, number>; hasPersonalizedItem: boolean; serverLines: ServerCartLine[] }> {
  // Product model v2: line items reference the PARENT product by productId plus
  // an optional variantSku. We load the parent doc and resolve the variant's
  // price from the embedded variants array — never trusting the client price.
  const loaded = await Promise.all(cartItems.map(async (item) => {
    const rawId = item.productId || item.id;
    const snap = rawId ? await db.collection('products').doc(String(rawId)).get() : null;
    const product = snap && snap.exists ? (snap.data() as any) : null;
    // All P0-03 invariants (tenant, availability, delivery, variant, price)
    // live in the pure helper above — unit-tested against functions/lib.
    const line = validateCartLine(product, item, shopId, deliveryMethod);
    const lineKey = `${line.productId}::${line.variantSku || ''}`;
    return { lineKey, ...line, product };
  }));

  const serverPrices: Record<string, number> = {};
  for (const { lineKey, price } of loaded) {
    serverPrices[lineKey] = price;
  }

  const subtotal = loaded.reduce((sum, { price, quantity }) => sum + price * quantity, 0);

  // Discount from the affiliate doc (not from the client). GATED on the
  // affiliate add-on: when the shop has affiliate disabled, the code is ignored
  // and no discount applies — this MUST match the client gate in
  // CartContext.applyDiscountCode, or the charge diverges from the displayed
  // total (total-parity). Default-ON (existing shops unaffected).
  let discountAmount = 0;
  let discountPercentage = 0;
  let discountSource: 'affiliate' | 'campaign' | null = null;
  let discountCodeId: string | null = null;
  if (discountCode && await isShopFeatureEnabled(shopId, 'affiliate')) {
    const affSnap = await db.collection('affiliates')
      .where('shopId', '==', shopId)
      .where('affiliateCode', '==', discountCode.toUpperCase())
      .where('status', '==', 'active')
      .limit(1)
      .get();
    if (!affSnap.empty) {
      discountPercentage = affSnap.docs[0].data().checkoutDiscount || 0;
      // Math.ceil matches the client-side CartContext rounding
      discountAmount = Math.ceil(subtotal * (discountPercentage / 100));
      discountSource = 'affiliate';
    }
  }

  // Campaign discount codes ("Rabattkoder" add-on). Only tried when the code did
  // NOT match an affiliate (affiliate wins — mirrors the validateDiscountCode
  // callable ordering). GATED on the discountCodes add-on (default-ON). The math
  // here MUST be byte-equivalent to the client in
  // CartContext.applyDiscountCode (campaign branch), or the charge diverges from
  // the displayed total (total-parity). The server recomputes from the
  // discountCodes doc — it NEVER trusts client discount numbers.
  if (discountCode && discountSource === null && await isShopFeatureEnabled(shopId, 'discountCodes')) {
    const dcSnap = await db.collection('discountCodes')
      .where('shopId', '==', shopId)
      .where('code', '==', discountCode.toUpperCase())
      .where('active', '==', true)
      .limit(1)
      .get();
    if (!dcSnap.empty) {
      const dc = dcSnap.docs[0].data() as any;
      // Defense-in-depth window + usage re-check (a code that expired or filled
      // up between validate and pay yields 0 discount — parity holds because the
      // client will have shown it too, and the server override is authoritative).
      const now = Date.now();
      const startsAtMs = dc.startsAt?.toMillis ? dc.startsAt.toMillis() : null;
      const endsAtMs = dc.endsAt?.toMillis ? dc.endsAt.toMillis() : null;
      const maxUses = typeof dc.maxUses === 'number' ? dc.maxUses : null;
      const usedCount = typeof dc.usedCount === 'number' ? dc.usedCount : 0;
      const windowOk = (startsAtMs === null || now >= startsAtMs) && (endsAtMs === null || now <= endsAtMs);
      const usesOk = maxUses === null || usedCount < maxUses;
      // Minimum purchase amount: compared against the FULL cart subtotal (not the
      // scoped base). Matches the client CartContext campaign branch.
      const minSpend = typeof dc.minSpend === 'number' ? dc.minSpend : null;
      const minSpendOk = minSpend === null || subtotal >= minSpend;
      if (windowOk && usesOk && minSpendOk) {
        // Scope-aware discountable BASE — MUST match the client exactly:
        //   scope 'all'      → whole subtotal
        //   scope 'products' → sum of lines whose productId ∈ productIds
        const scope = dc.scope === 'products' ? 'products' : 'all';
        const productIds: string[] = Array.isArray(dc.productIds) ? dc.productIds : [];
        const base = scope === 'products'
          ? loaded.reduce((sum, { productId, price, quantity }) =>
              sum + (productIds.includes(productId) ? price * quantity : 0), 0)
          : subtotal;
        const value = Number(dc.value) || 0;
        if (dc.type === 'fixed') {
          // Math.min(value, base) clamps the fixed discount to the base — matches client
          discountAmount = Math.min(value, base);
        } else {
          // Math.ceil(base * value/100) matches the client-side rounding
          discountAmount = Math.ceil(base * (value / 100));
          discountPercentage = value; // percent only; fixed leaves this 0
        }
        discountSource = 'campaign';
        discountCodeId = dcSnap.docs[0].id;
      }
    }
  }

  // Shipping mirrors CartContext.getShippingCost: base cost from the first
  // product's shipping table for the region, multiplied by 50g weight tiers.
  // Click & Collect (pickup) has NO shipping — mirrors the client (CartContext
  // calculateTotals), so the server-computed total matches the charge.
  let shipping = 0;
  if (deliveryMethod !== 'pickup') {
    const region = getShippingRegion(shippingCountry);
    let baseShippingCost = loaded[0]?.product?.shipping?.[region]?.cost || 0;
    if (baseShippingCost === 0) {
      baseShippingCost = shippingCountry === 'SE' ? 29 : 49;
    }
    const totalWeight = loaded.reduce((sum, { product, quantity }) =>
      sum + ((product.weight?.value || 10) * quantity), 0) + 20;
    shipping = baseShippingCost * Math.ceil(totalWeight / 50);
  }

  const total = subtotal - discountAmount + shipping;
  const vat = total - (total / (1 + commerceConfig.vatRate));

  // Right-of-withdrawal (POD): derive from the LIVE product docs (never trust a
  // client flag) whether any line item is personalized → the no-withdrawal
  // consent gate was required at checkout.
  const hasPersonalizedItem = loaded.some((line) => line.isPersonalized);

  // The authoritative line snapshot (P0-03) — what the webhook persists onto
  // the order. Strip the raw product doc; only the derived fields leave here.
  const serverLines: ServerCartLine[] = loaded.map(({ lineKey: _k, product: _p, ...line }) => line);

  return { subtotal, discountAmount, discountPercentage, discountSource, discountCodeId, shipping, vat, total, serverPrices, hasPersonalizedItem, serverLines };
}

interface CreatePaymentIntentRequest {
  amount?: number; // Client display amount in SEK — logged for drift detection only; the charge is computed server-side
  currency: string; // Should be 'sek'
  b2cCustomerId?: string; // Existing/just-created customer doc id for order linkage
  b2cCustomerAuthId?: string; // Firebase Auth uid for order linkage
  shopId?: string; // Tenant id — written into metadata; webhook stamps it on the order
  cartItems: Array<{
    productId?: string;      // v2: parent product id
    id?: string;             // legacy fallback
    variantSku?: string | null; // v2: chosen variant sku (null = no variant)
    label?: string;          // v2: variant label snapshot
    name: string | { 'sv-SE'?: string; 'en-GB'?: string; 'en-US'?: string; [key: string]: string | undefined };
    price: number;
    quantity: number;
    sku: string;
    image?: string; // Product image URL
  }>;
  customerInfo: {
    email: string;
    name: string;
    firstName?: string; // For enhanced metadata
    lastName?: string;  // For enhanced metadata
    marketing?: boolean; // Marketing consent
    remindMe?: boolean; // Abandoned-checkout reminder consent (opt-in)
    preferredLang?: string; // Language preference
  };
  shippingInfo: {
    country: string;
    cost: number;
    firstName?: string;   // Shipping address details
    lastName?: string;
    address?: string;
    apartment?: string;
    city?: string;
    postalCode?: string;
  };
  discountInfo?: {
    code: string;
    amount: number;
    percentage: number;
  };
  affiliateInfo?: {
    code: string;
    clickId: string;
  };
  // Delivery method (Click & Collect). When method==='pickup', shipping is 0
  // (server-enforced) and the pickup location is carried to the order.
  deliveryInfo?: {
    method: 'home' | 'pickup';
    pickupLocationId?: string;
    pickupLocationName?: string;
    pickupLocationAddress?: string;
    pickupLocationDate?: string; // chosen pickup date, ISO YYYY-MM-DD (optional)
  };
  // Enhanced totals for complete order reconstruction
  totals?: {
    subtotal: number;
    vat: number;
    shipping: number;
    discountAmount: number;
    total: number;
  };
}

export const createPaymentIntentV2 = onRequest(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    secrets: ['STRIPE_SECRET_KEY'],
  },
  async (request, response) => {
    try {
      // Handle CORS
      if (!corsHandler(request, response)) {
        return;
      }

      // Handle preflight OPTIONS request
      if (request.method === 'OPTIONS') {
        response.status(200).send('OK');
        return;
      }

      // Only allow POST requests
      if (request.method !== 'POST') {
        response.status(405).json({ error: 'Method not allowed' });
        return;
      }

      // P1-02: durable per-IP rate limit — each call creates a Stripe
      // PaymentIntent, so an unthrottled caller is both an abuse and a cost
      // vector. 40 per 5 min leaves room for several LEGIT buyers sharing one
      // carrier CGNAT IP (each makes ~1-3 calls now that the client only
      // recreates the PI when a priced input actually changes).
      if (!(await checkRateLimit('pi', trustedClientIp(request), { limit: 40, windowSec: 300 }))) {
        response.status(429).json({ error: 'Too many requests' });
        return;
      }

      // Initialize Stripe with secret key from environment variable
      const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
      
      if (!stripeSecretKey) {
        logger.error('❌ STRIPE_SECRET_KEY not found in environment');
        response.status(500).json({ error: 'Payment service configuration error' });
        return;
      }

      const stripe = new Stripe(stripeSecretKey, {
        apiVersion: '2023-10-16',
      });

      logger.info('💳 Creating Stripe Payment Intent', {
        itemCount: request.body.cartItems?.length || 0,
        currency: request.body.currency,
        hasDiscount: !!(request.body.discountInfo?.code || request.body.affiliateInfo?.code)
      });

      // Validate request
      if (!request.body) {
        response.status(400).json({ error: 'Request body is required' });
        return;
      }

      const {
        amount,
        currency = commerceConfig.currency.toLowerCase(),
        cartItems,
        customerInfo,
        shippingInfo,
        discountInfo,
        affiliateInfo,
        deliveryInfo,
        shopId
      }: CreatePaymentIntentRequest = request.body;

      // Click & Collect: 'pickup' makes shipping free and is stamped on the order.
      const deliveryMethod = deliveryInfo?.method === 'pickup' ? 'pickup' : 'home';

      // Tenant id for the order. Phase 0/1 is single-shop, so this normalizes
      // to the default; the field is carried through metadata → webhook → order
      // so the plumbing is correct before multi-shop exists.
      const resolvedShopId = shopId || DEFAULT_SHOP_ID;

      // TENANT ISOLATION (H1): validate the (client-supplied) shopId names a real
      // shop before charging against it — reject unknown tenants. Deriving the
      // shopId from the request origin instead of trusting the payload is a
      // future hardening pass (H1, out of scope here).
      const shopSnap = await db.collection('shops').doc(resolvedShopId).get();
      if (!shopSnap.exists) {
        response.status(400).json({ error: 'Unknown shop' });
        return;
      }

      // P0-03: never charge against a killed or not-yet-published shop — the
      // storefront gate is client-side only; this is the server backstop.
      const shopBlockReason = shopCheckoutBlockReason(shopSnap.data());
      if (shopBlockReason) {
        logger.warn('⛔ Checkout blocked — shop not live', { shopId: resolvedShopId, shopBlockReason });
        response.status(403).json({ error: 'Shop is not accepting orders' });
        return;
      }

      // P1-06: a 'pickup' charge (zero shipping) requires a pickup location
      // that actually exists in THIS shop's configuration. The resolved
      // name/address (server truth) is what gets persisted — a crafted request
      // can no longer zero shipping on a shop without pickup, or stamp a
      // fabricated pickup address onto the order.
      let resolvedPickup: { id: string; name: string; address: string; date: string } | null = null;
      if (deliveryMethod === 'pickup') {
        resolvedPickup = resolvePickupLocation(
          shopSnap.data(),
          deliveryInfo?.pickupLocationId,
          deliveryInfo?.pickupLocationDate
        );
        if (!resolvedPickup) {
          logger.warn('⛔ Checkout blocked — invalid pickup location', { shopId: resolvedShopId });
          response.status(400).json({ error: 'Invalid pickup location' });
          return;
        }
      }

      // D7 (pod-shop-type-selector plan): a pod-disabled shop skips the POD
      // production-snapshot machinery entirely — orders flow as regular
      // products even if a stray isPodProduct:true doc exists. Read ONCE and
      // reuse below; default-ON until D3 flips pod to explicit opt-in. This
      // does NOT touch price/fee/transfer computation (computeOrderTotalsSek
      // below is unaffected) — the snapshot feeds the print projection only.
      const podEnabled = await isShopFeatureEnabled(resolvedShopId, 'pod');

      // Tenant display name for Stripe-visible strings (description, card-
      // statement suffix). Buyers know the SHOP, never the platform brand.
      const tenantName = String(shopSnap.data()?.storeIdentity?.shopName || resolvedShopId);
      // statement_descriptor_suffix is appended to the account's descriptor
      // prefix on card statements (e.g. "METEORPR* SILLMANS"). Stripe allows
      // letters/digits/spaces (no <>\'"*), requires at least one letter, and
      // truncates the concatenation at 22 chars — keep the suffix short and
      // OMIT it when sanitizing leaves nothing usable (an invalid suffix
      // would fail the whole charge).
      const statementSuffix = tenantName
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '') // decomposed diacritics (å→a, ö→o)
        .replace(/[^A-Za-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12)
        .trim()
        .toUpperCase();

      // Validate required fields
      if (!cartItems || cartItems.length === 0 || cartItems.length > 100) {
        response.status(400).json({ error: 'Cart items are required' });
        return;
      }

      if (!customerInfo?.email) {
        response.status(400).json({ error: 'Customer email is required' });
        return;
      }

      if (currency.toLowerCase() !== commerceConfig.currency.toLowerCase()) {
        // Payments are charged in SEK; other currencies are display-only
        response.status(400).json({ error: 'Unsupported currency' });
        return;
      }

      // 🛡️ SECURITY: compute the amount server-side from the products
      // collection. The client-sent amount is only logged for drift detection.
      const discountCode = discountInfo?.code || affiliateInfo?.code;
      let totals: Awaited<ReturnType<typeof computeOrderTotalsSek>>;
      try {
        totals = await computeOrderTotalsSek(
          cartItems,
          shippingInfo?.country || 'SE',
          discountCode,
          resolvedShopId,
          deliveryMethod
        );
      } catch (calcError: any) {
        logger.error('❌ Server-side price computation failed', { error: calcError.message });
        response.status(400).json({ error: 'Invalid cart contents' });
        return;
      }

      const amountInOre = Math.round(totals.total * 100);

      // Right-of-withdrawal (POD) proof. The server decides whether the gate was
      // REQUIRED from the live products (totals.hasPersonalizedItem) — never the
      // client. Fail closed before creating a PaymentIntent if the required
      // consent proof is absent or malformed.
      const wc = (request.body as any)?.withdrawalConsent;
      let withdrawalMeta: Record<string, string> = {};
      const consentBlockReason = withdrawalConsentBlockReason(totals.hasPersonalizedItem, wc);
      if (consentBlockReason) {
        logger.warn('⛔ Personalized checkout blocked — withdrawal consent invalid', {
          shopId: resolvedShopId,
          consentBlockReason,
        });
        response.status(400).json({ error: 'Withdrawal consent is required' });
        return;
      }
      if (totals.hasPersonalizedItem) {
        withdrawalMeta = {
          withdrawalRequired: 'true',
          withdrawalConsent: 'true',
          withdrawalNoticeVersion: String(wc.noticeVersion).trim(),
          withdrawalNoticeFingerprint: String(wc.noticeFingerprint).trim(),
          withdrawalConsentAt: new Date().toISOString(),
        };
      }

      if (typeof amount === 'number' && Math.abs(amount - totals.total) > 1) {
        logger.warn('⚠️ Client amount differs from server-computed total — charging server total', {
          clientAmount: amount,
          serverTotal: totals.total
        });
      }

      logger.info('💰 Payment details (server-computed)', {
        amountInSEK: totals.total,
        amountInOre,
        currency,
        itemCount: cartItems.length
      });

      // 💸 STRIPE CONNECT (opt-in per shop). If this shop has a usable connected
      // account, make this a DESTINATION CHARGE: the full amount transfers to
      // the shop's account minus the platform's cut (application_fee_amount).
      // A shop WITHOUT chargesEnabled stays on the legacy single-account flow —
      // connectParams/connectMeta are then empty and the create call below is
      // byte-identical to before. NO on_behalf_of → platform stays VAT merchant
      // of record. The fee is taken off the GROSS total (documented choice).
      const pay = (shopSnap.data() as any)?.payments || {};
      // Resolve the platform-default commission (I/O) once; the pure param
      // builder (connectParams.ts, unit-tested) decides the rest. Read via the
      // single platform-config reader (platformConfig.ts) — same source of
      // truth as the refund/dispute policy flags. Only read when Connect is
      // active so a legacy checkout gains no extra Firestore read.
      let platformDefaultBps = commerceConfig.defaultCommissionBps;
      if (pay.chargesEnabled === true && pay.stripeAccountId) {
        const cfg = await readPlatformConfig();
        platformDefaultBps = cfg.defaultCommissionBps;
      }
      const connectBuild = buildConnectChargeParams(pay, amountInOre, platformDefaultBps);
      const connectParams = connectBuild.params;
      const connectMeta = connectBuild.meta;
      if (connectBuild.useConnect) {
        logger.info('💸 Destination charge', { shopId: resolvedShopId, connectedAccountId: pay.stripeAccountId, fee: connectParams.application_fee_amount });
      }

      // Item snapshot for the webhook's order creation. Stripe caps each
      // metadata VALUE at 500 chars, so the JSON is chunked across
      // itemDetails, itemDetails1, itemDetails2… (webhook reassembles).
      // If even the image-less variant exceeds the chunk budget, we fail
      // loudly rather than let Stripe truncate mid-JSON.
      // P0-03: the snapshot is built ONLY from the server-derived lines
      // (validateCartLine) — client sku/name/label/image never reach the order.
      // Print later resolves order.items[].sku → podMappings, so a client-
      // controlled SKU here was a wrong-artwork fulfilment path.
      const buildItemDetailsJson = (withImages: boolean) => JSON.stringify(totals.serverLines.map(line => ({
        productId: line.productId,
        variantSku: line.variantSku || '',
        sku: line.sku,
        name: line.name,
        label: line.label,
        price: line.price,
        quantity: line.quantity,
        image: withImages ? line.image : '',
        isPodProduct: line.isPodProduct,
        isPersonalized: line.isPersonalized,
      })));
      const META_VALUE_MAX = 500;
      const META_TOTAL_KEYS = 50; // Stripe's hard cap on metadata key count
      const chunkItemDetails = (json: string, maxChunks: number): Record<string, string> | null => {
        if (Math.ceil(json.length / META_VALUE_MAX) > maxChunks) return null;
        const out: Record<string, string> = {};
        for (let i = 0; i * META_VALUE_MAX < json.length; i++) {
          out[i === 0 ? 'itemDetails' : `itemDetails${i}`] = json.slice(i * META_VALUE_MAX, (i + 1) * META_VALUE_MAX);
        }
        return out;
      };
      // Base metadata (everything except the chunked item snapshot) is
      // assembled first so the chunk budget can be derived from the real
      // key count — Stripe hard-caps metadata at 50 keys total.
      const baseMetadata = {
            // ✅ ENHANCED METADATA FOR COMPLETE ORDER RECOVERY
            
            // Customer Information (enhanced)
            customerEmail: customerInfo.email,
            customerName: customerInfo.name || '',
            customerFirstName: customerInfo.firstName || shippingInfo.firstName || '',
            customerLastName: customerInfo.lastName || shippingInfo.lastName || '',
            customerMarketing: (customerInfo.marketing || false).toString(),
            customerRemind: (customerInfo.remindMe || false).toString(),
            customerLang: customerInfo.preferredLang || 'sv-SE',
            
            // Shipping Information (complete address)
            shippingFirstName: shippingInfo.firstName || '',
            shippingLastName: shippingInfo.lastName || '',
            shippingAddress: shippingInfo.address || '',
            shippingApartment: shippingInfo.apartment || '',
            shippingCity: shippingInfo.city || '',
            shippingPostalCode: shippingInfo.postalCode || '',
            shippingCountry: shippingInfo.country || 'SE',
            shippingCost: (shippingInfo.cost || 0).toString(),

            // Delivery method (Click & Collect) — carried to the order by the
            // webhook. Location fields are the SERVER-resolved shop config
            // (P1-06), never the client's copies; only the chosen date string
            // passes through.
            deliveryMethod,
            ...(deliveryMethod === 'pickup' && resolvedPickup && {
              pickupLocationId: resolvedPickup.id,
              pickupLocationName: resolvedPickup.name,
              pickupLocationAddress: resolvedPickup.address,
              pickupLocationDate: resolvedPickup.date,
            }),
            
            // Order Totals (server-computed breakdown — single source of truth)
            subtotal: totals.subtotal.toString(),
            vat: totals.vat.toFixed(2),
            shipping: totals.shipping.toString(),
            discountAmount: totals.discountAmount.toString(),
            total: totals.total.toString(),

            // Discount Information (server-validated). discountSource tells the
            // webhook which kind of code applied ('affiliate' | 'campaign'); for
            // campaign codes discountCodeId lets the webhook bump usedCount.
            ...(discountCode && totals.discountAmount > 0 && {
              discountCode: discountCode.toUpperCase(),
              discountPercentage: totals.discountPercentage.toString(),
              ...(totals.discountSource && { discountSource: totals.discountSource }),
              ...(totals.discountSource === 'campaign' && totals.discountCodeId && {
                discountCodeId: totals.discountCodeId,
              }),
            }),
            
            // Affiliate Information (enhanced)
            ...(affiliateInfo && {
              affiliateCode: affiliateInfo.code,
              affiliateClickId: affiliateInfo.clickId,
            }),
            
            // Cart Items (detailed for recovery)
            itemCount: cartItems.length.toString(),
            totalItems: cartItems.reduce((sum, item) => sum + item.quantity, 0).toString(),
            
            // Legacy compatibility (keep existing fields) — server-derived (P0-03)
            itemIds: totals.serverLines.map(line => line.productId.substring(0, 8)).join(','),
            cartSummary: totals.serverLines.map(line => `${line.quantity}x${line.sku}`).join(','),
            
            // B2C customer account linkage (set when the buyer has/creates an account)
            ...(request.body.b2cCustomerId && {
              b2cCustomerId: request.body.b2cCustomerId,
              b2cCustomerAuthId: request.body.b2cCustomerAuthId || ''
            }),

            // System identifiers
            source: 'b2c_shop',
            platform: 'meteorpr',
            shopId: resolvedShopId, // tenant id — webhook stamps it on the order
            version: 'enhanced_v2', // server-priced metadata
            // Webhook must load the graph frozen before this PI's client secret
            // was released; old in-flight PIs lack this marker and use the
            // explicit legacy fallback there. A pod-disabled shop needs no
            // snapshot at all (D7) — 'false' short-circuits the webhook's
            // required-snapshot branch instead of falling into the legacy
            // rebuild-from-live-mappings path (which is for pre-migration PIs,
            // not this case).
            productionSnapshotRequired: podEnabled ? 'true' : 'false',

            // Right-of-withdrawal proof (empty {} for standard-options carts)
            ...withdrawalMeta,

            // Stripe Connect (empty for legacy shops → metadata unchanged)
            ...connectMeta
      };
      const chunkBudget = Math.max(1, META_TOTAL_KEYS - Object.keys(baseMetadata).length);
      // Item snapshot chunked across itemDetails, itemDetails1… within the
      // remaining key budget; images dropped first if the cart outgrows it.
      const itemDetailsMeta = chunkItemDetails(buildItemDetailsJson(true), chunkBudget)
        ?? chunkItemDetails(buildItemDetailsJson(false), chunkBudget);
      if (!itemDetailsMeta) {
        response.status(400).json({ error: 'Cart too large for payment metadata' });
        return;
      }

      // Freeze production identity before the buyer can confirm payment. This
      // prevents a mapping/artwork edit between checkout and webhook delivery
      // from changing what the print shop receives.
      //
      // D7: a pod-disabled shop skips this entirely — no snapshot to freeze,
      // no unresolved-line check, no checkout doc write below. This gate is
      // purely about the print-projection graph; it does not read or affect
      // totals/amountInOre/connectParams/baseMetadata money fields, all of
      // which were already computed above.
      let checkoutProductionSnapshot: Awaited<ReturnType<typeof buildProductionSnapshotAtomically>> | null = null;
      if (podEnabled) {
        try {
          checkoutProductionSnapshot = await buildProductionSnapshotAtomically({
            shopId: resolvedShopId,
            items: totals.serverLines,
          });
          const unresolvedLines = checkoutProductionSnapshot.lines.filter((line) => line.unresolvedReason);
          if (unresolvedLines.length > 0) {
            logger.error('⛔ Checkout blocked — POD production snapshot is unresolved', {
              shopId: resolvedShopId,
              lines: unresolvedLines.map((line) => ({
                sku: line.sku,
                placementSlot: line.placementSlot,
                reason: line.unresolvedReason,
              })),
            });
            response.status(409).json({
              error: 'A product is temporarily unavailable for production',
              success: false,
            });
            return;
          }
        } catch (snapshotError: any) {
          logger.error('❌ Could not freeze checkout production snapshot', {
            shopId: resolvedShopId,
            error: snapshotError?.message,
          });
          response.status(503).json({
            error: 'Checkout is temporarily unavailable',
            success: false,
          });
          return;
        }
      }

      // Create Payment Intent with simplified configuration for live mode
      let paymentIntent;
      try {
        paymentIntent = await stripe.paymentIntents.create({
          amount: amountInOre,
          currency: currency.toLowerCase(),
          automatic_payment_methods: {
            enabled: true,
          },
          metadata: { ...baseMetadata, ...itemDetailsMeta },
          receipt_email: customerInfo.email,
          description: `${tenantName} Order - ${cartItems.length} item${cartItems.length > 1 ? 's' : ''}`,
          // Per-shop card-statement suffix (omitted when unusable — see above).
          ...(/[A-Za-z]/.test(statementSuffix) ? { statement_descriptor_suffix: statementSuffix } : {}),

          // Stripe Connect destination-charge params (empty {} for legacy shops)
          ...connectParams
        });
      } catch (stripeError: any) {
        logger.error('❌ Stripe Payment Intent creation failed', {
          error: stripeError.message,
          type: stripeError.type,
          code: stripeError.code,
          statusCode: stripeError.statusCode,
          requestParams: {
            amount: amountInOre,
            currency: currency.toLowerCase()
            // P1-05: no customer email in error logs
          }
        });
        
        response.status(400).json({ 
          error: 'Payment intent creation failed',
          details: stripeError.message,
          success: false
        });
        return;
      }

      logger.info('✅ Payment Intent created successfully', {
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status
      });

      // This rules-locked write is REQUIRED when pod is enabled — until it
      // succeeds, the client must not receive the secret that can confirm the
      // payment. Cancel the unused PI on failure so it cannot become a paid
      // order without its snapshot. A pod-disabled shop has no snapshot to
      // persist (D7) — the checkout doc simply never gets the
      // productionSnapshotRequired/productionSnapshot fields, matching the
      // 'false' marker already in baseMetadata.
      try {
        if (checkoutProductionSnapshot) {
          await writeCheckoutProductionSnapshot(
            paymentIntent.id,
            resolvedShopId,
            checkoutProductionSnapshot
          );
        }
      } catch (snapshotWriteError: any) {
        logger.error('❌ Could not persist checkout production snapshot', {
          paymentIntentId: paymentIntent.id,
          error: snapshotWriteError?.message,
        });
        try {
          await stripe.paymentIntents.cancel(paymentIntent.id);
        } catch (cancelError: any) {
          logger.error('❌ Could not cancel PaymentIntent after snapshot write failure', {
            paymentIntentId: paymentIntent.id,
            error: cancelError?.message,
          });
        }
        response.status(503).json({
          error: 'Checkout is temporarily unavailable',
          success: false,
        });
        return;
      }

      // Abandoned-checkout recovery: record a checkouts/{piId} doc so the sweep
      // can remind the buyer if no order materializes. STRICTLY best-effort — a
      // failure here must NEVER affect the payment response (which is the whole
      // point of the charge). Uses the same server-priced item snapshot the
      // charge is built from (buildItemDetailsJson(false), image-less).
      try {
        await writeAbandonedCheckoutDoc({
          paymentIntentId: paymentIntent.id,
          shopId: resolvedShopId,
          customerInfo,
          itemsJson: buildItemDetailsJson(false),
          totals: {
            subtotal: totals.subtotal,
            vat: totals.vat,
            shipping: totals.shipping,
            discountAmount: totals.discountAmount,
            total: totals.total,
          },
        });
      } catch (recoveryError: any) {
        logger.warn('⚠️ checkout-recovery: failed to write checkout doc (payment unaffected)', {
          paymentIntentId: paymentIntent.id,
          error: recoveryError?.message,
        });
      }

      response.status(200).json({
        success: true,
        paymentIntent: {
          id: paymentIntent.id,
          client_secret: paymentIntent.client_secret,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          status: paymentIntent.status
        }
      });

    } catch (error) {
      logger.error('❌ Error creating Payment Intent', error);
      
      // Handle Stripe errors
      if (error instanceof Stripe.errors.StripeError) {
        response.status(400).json({ error: `Stripe error: ${error.message}` });
        return;
      }

      response.status(500).json({ error: 'Failed to create payment intent' });
    }
  }
);
