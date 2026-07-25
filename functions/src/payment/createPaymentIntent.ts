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
import { writeAbandonedCheckoutDoc } from '../checkout-recovery/writeCheckoutDoc';

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

async function computeOrderTotalsSek(
  cartItems: Array<{ productId?: string; id?: string; variantSku?: string | null; quantity: number }>,
  shippingCountry: string,
  discountCode: string | undefined,
  shopId: string,
  deliveryMethod: string
): Promise<{ subtotal: number; discountAmount: number; discountPercentage: number; discountSource: 'affiliate' | 'campaign' | null; discountCodeId: string | null; shipping: number; vat: number; total: number; serverPrices: Record<string, number>; hasPersonalizedItem: boolean }> {
  // Product model v2: line items reference the PARENT product by productId plus
  // an optional variantSku. We load the parent doc and resolve the variant's
  // price from the embedded variants array — never trusting the client price.
  const loaded = await Promise.all(cartItems.map(async (item) => {
    const productId = item.productId || item.id; // tolerate either key
    const quantity = Math.floor(Number(item.quantity));
    if (!productId || !Number.isFinite(quantity) || quantity < 1 || quantity > 1000) {
      throw new Error(`Invalid cart item: ${productId}`);
    }
    const snap = await db.collection('products').doc(productId).get();
    if (!snap.exists) {
      throw new Error(`Unknown product: ${productId}`);
    }
    const product = snap.data() as any;
    // TENANT ISOLATION: `products` is a top-level collection with globally
    // unique ids and is world-readable, so a caller can name ANY shop's product.
    // Without this check a charge for shop A could be priced from shop B's
    // catalog and settled into shop A's connected account. Mirrors the B2B
    // guard in order-processing/createB2BOrder.ts.
    if (product.shopId !== shopId) {
      throw new Error(`Product ${productId} belongs to another shop`);
    }
    if (product.isActive === false) {
      throw new Error(`Product not available: ${productId}`);
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
    if (variantSku) {
      const variant = Array.isArray(product.variants)
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
    const lineKey = `${productId}::${variantSku || ''}`;
    return { lineKey, productId, variantSku, quantity, price, product };
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
  const hasPersonalizedItem = loaded.some(({ product }) => product?.isPersonalized === true);

  return { subtotal, discountAmount, discountPercentage, discountSource, discountCodeId, shipping, vat, total, serverPrices, hasPersonalizedItem };
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
      // client. We record what arrived (locked decision: server backstop =
      // record-what-arrived) into PI metadata; the webhook stamps order.withdrawal.
      const wc = (request.body as any)?.withdrawalConsent;
      let withdrawalMeta: Record<string, string> = {};
      if (totals.hasPersonalizedItem) {
        const accepted = wc?.accepted === true;
        if (!accepted) {
          // A personalized item with no client consent → the legitimate client
          // blocks this. Record it (don't silently drop) for evidence/audit.
          logger.warn('⚠️ POD: personalized item charged WITHOUT recorded withdrawal consent', {
            shopId: resolvedShopId,
          });
        }
        withdrawalMeta = {
          withdrawalRequired: 'true',
          withdrawalConsent: accepted ? 'true' : 'false',
          withdrawalNoticeVersion: String(wc?.noticeVersion || ''),
          withdrawalNoticeFingerprint: String(wc?.noticeFingerprint || ''),
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
      const buildItemDetailsJson = (withImages: boolean) => JSON.stringify(cartItems.map(item => {
        const productId = (item as any).productId || (item as any).id;
        const variantSku = (item as any).variantSku || '';
        const lineKey = `${productId}::${variantSku}`;
        return {
          productId,
          variantSku,
          sku: item.sku,
          name: typeof item.name === 'string' ? item.name : item.name?.['sv-SE'] || item.name?.['en-US'] || 'Product',
          label: (item as any).label || '',
          price: totals.serverPrices[lineKey] ?? item.price,
          quantity: item.quantity,
          image: withImages ? (item.image || '') : ''
        };
      }));
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

            // Delivery method (Click & Collect) — carried to the order by the webhook.
            deliveryMethod,
            ...(deliveryMethod === 'pickup' && {
              pickupLocationId: deliveryInfo?.pickupLocationId || '',
              pickupLocationName: deliveryInfo?.pickupLocationName || '',
              pickupLocationAddress: deliveryInfo?.pickupLocationAddress || '',
              pickupLocationDate: deliveryInfo?.pickupLocationDate || '',
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
            
            // Legacy compatibility (keep existing fields)
            itemIds: cartItems.map(item => String((item as any).productId || (item as any).id || '').substring(0, 8)).join(','),
            cartSummary: cartItems.map(item => `${item.quantity}x${item.sku}`).join(','),
            
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
            currency: currency.toLowerCase(),
            customerEmail: customerInfo.email
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