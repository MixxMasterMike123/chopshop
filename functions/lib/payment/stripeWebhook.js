"use strict";
/**
 * Stripe Webhook Handler for B2C Order Recovery
 * Handles payment_intent.succeeded events to create orders from Stripe metadata
 * This serves as a backup mechanism when client-side order creation fails
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeWebhookV2 = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_functions_1 = require("firebase-functions");
const stripe_1 = __importDefault(require("stripe"));
const app_urls_1 = require("../config/app-urls");
const firestore_1 = require("firebase-admin/firestore");
const tenancy_1 = require("../config/tenancy");
const connectOnboarding_1 = require("./connectOnboarding");
const platformConfig_1 = require("./platformConfig");
const connectParams_1 = require("./connectParams");
// CORS not needed for webhooks - server-to-server communication
// Initialize Firestore with named database
const db = (0, firestore_1.getFirestore)('b8s-reseller-db');
// Resolve the order doc for a dispute. order id == payment_intent id, so we use
// the dispute's payment_intent (string or expanded object). Returns null when
// the PI is absent or no matching order exists.
async function loadOrderForDispute(dispute) {
    const pi = dispute?.payment_intent;
    const piId = typeof pi === 'string' ? pi : pi?.id;
    if (!piId)
        return null;
    const ref = db.collection('orders').doc(piId);
    const snap = await ref.get();
    if (!snap.exists)
        return null;
    return { ref, order: snap.data() };
}
// Recover the disputed funds from the connected account by reversing the
// destination-charge transfer. Returns a patch to stamp on the order. NEVER
// throws — a failed reversal (already reversed, insufficient balance on the
// connected account, etc.) is caught, logged, and stamped as a shortfall so the
// platform can reconcile out of band. SE/EU connected accounts do NOT auto-debit
// the seller's bank, so a negative balance can simply sit there → we alert.
async function recoverDisputedTransfer(stripe, order, disputeId) {
    const reversal = (0, connectParams_1.buildDisputeReversalParams)(order);
    if (!reversal) {
        // Nothing to reverse: legacy charge (platform always bore it), or no
        // transferId recorded, or already reversed. Distinguish for the admin.
        const connect = order?.connect;
        if (connect?.isDestinationCharge === true && connect?.transferReversed !== true && !connect?.transferId) {
            firebase_functions_1.logger.warn('💸 dispute: Connect order has NO transferId — cannot auto-recover, manual reconcile needed', {
                orderId: order?.payment?.paymentIntentId,
            });
            return { 'connect.disputeRecoveryStatus': 'no_transfer_id' };
        }
        return {}; // legacy or already reversed → nothing to do
    }
    try {
        // Idempotency key keyed on the dispute → concurrent/duplicate webhook
        // deliveries collapse to ONE Stripe reversal (Stripe returns the original
        // result for a repeated key) instead of two concurrent createReversal calls
        // racing the Firestore guard. This is the cross-instance-safe guard.
        const result = await stripe.transfers.createReversal(reversal.transferId, reversal.params, { idempotencyKey: `dispute-reversal:${disputeId || reversal.transferId}` });
        firebase_functions_1.logger.info('💸 dispute: transfer reversed (funds recovered from shop)', {
            orderId: order?.payment?.paymentIntentId,
            transferId: reversal.transferId,
            reversalId: result.id,
            amount: result.amount,
        });
        return {
            'connect.transferReversed': true,
            'connect.disputeReversalId': result.id,
            // The amount Stripe actually reversed (öre) — authoritative; used to
            // re-transfer exactly this much back if the dispute is later won.
            'connect.disputeReversedAmount': result.amount,
            'connect.disputeRecoveryStatus': 'recovered',
        };
    }
    catch (e) {
        // A negative balance on the connected account, an already-reversed transfer,
        // or any Stripe error: do NOT crash the webhook (Stripe would retry-storm).
        // Stamp a shortfall + alert so the platform reconciles manually.
        firebase_functions_1.logger.error('🚨 dispute: transfer reversal FAILED — possible shortfall, manual reconcile needed', {
            orderId: order?.payment?.paymentIntentId,
            transferId: reversal.transferId,
            connectedAccountId: order?.connect?.connectedAccountId,
            error: e?.message,
            code: e?.code,
        });
        return {
            'connect.disputeRecoveryStatus': 'shortfall',
            'connect.disputeRecoveryError': (e?.message || 'reversal_failed').slice(0, 300),
        };
    }
}
// Load a shop's name for naming it in platform alert emails (best-effort).
async function loadShopName(shopId) {
    if (!shopId)
        return undefined;
    try {
        const snap = await db.collection('shops').doc(shopId).get();
        const si = snap.data()?.storeIdentity || {};
        return typeof si.shopName === 'string' && si.shopName.trim() ? si.shopName.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
// Platform-admin alert for a dispute / shortfall. Best-effort: any failure is
// swallowed so it can NEVER crash the webhook (Stripe would retry-storm).
async function sendDisputeAlert(params) {
    try {
        const shopName = await loadShopName(params.shopId);
        const { EmailOrchestrator } = require('../email-orchestrator/core/EmailOrchestrator');
        const orchestrator = new EmailOrchestrator();
        await orchestrator.sendEmail({
            emailType: 'DISPUTE_ALERT_ADMIN',
            // Admin-only mail: `to` is overridden by the platform recipients; supply a
            // synthetic customerInfo so the user resolver succeeds.
            customerInfo: { email: 'platform@internal', name: 'Platform' },
            language: 'sv-SE',
            adminEmail: true,
            shopId: params.shopId,
            additionalData: {
                shopId: params.shopId,
                shopName,
                orderId: params.order?.payment?.paymentIntentId || params.order?.orderNumber,
                orderNumber: params.order?.orderNumber,
                disputeId: params.disputeId,
                reason: params.reason,
                amount: params.amount,
                status: params.status,
                alertKind: params.alertKind,
                recoveryStatus: params.recoveryStatus,
            },
        });
    }
    catch (e) {
        firebase_functions_1.logger.warn('⚠️ dispute alert email failed (best-effort)', { error: e?.message });
    }
}
// Shop-owner alert: their Connect account status changed meaningfully. Recipient
// is the shop's supportEmail (via the orchestrator's admin path with shopId).
// Best-effort — never crashes the webhook.
async function sendConnectStatusChange(shopId, changes) {
    try {
        const { EmailOrchestrator } = require('../email-orchestrator/core/EmailOrchestrator');
        const orchestrator = new EmailOrchestrator();
        await orchestrator.sendEmail({
            emailType: 'CONNECT_STATUS_CHANGE',
            // Route to the shop's supportEmail via the admin path (FIX 4). Synthetic
            // customerInfo satisfies the resolver; `to` is replaced by the recipients.
            customerInfo: { email: 'platform@internal', name: 'Platform' },
            language: 'sv-SE',
            adminEmail: true,
            shopId,
            additionalData: { changes },
        });
    }
    catch (e) {
        firebase_functions_1.logger.warn('⚠️ connect status-change email failed (best-effort)', { shopId, error: e?.message });
    }
}
exports.stripeWebhookV2 = (0, https_1.onRequest)({
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY'],
    invoker: 'public', // Allow Stripe to call this webhook
}, async (request, response) => {
    try {
        firebase_functions_1.logger.info('🔍 Webhook received', {
            method: request.method,
            headers: Object.keys(request.headers),
            hasSignature: !!request.headers['stripe-signature']
        });
        // Webhooks are server-to-server - no CORS needed
        // Authentication is handled via Stripe signature verification
        // Only allow POST requests
        if (request.method !== 'POST') {
            response.status(405).json({ error: 'Method not allowed' });
            return;
        }
        // Get Stripe webhook secret
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!webhookSecret) {
            firebase_functions_1.logger.error('❌ STRIPE_WEBHOOK_SECRET not found in environment');
            response.status(500).json({ error: 'Webhook configuration error' });
            return;
        }
        // Initialize Stripe
        const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
        if (!stripeSecretKey) {
            firebase_functions_1.logger.error('❌ STRIPE_SECRET_KEY not found in environment');
            response.status(500).json({ error: 'Stripe configuration error' });
            return;
        }
        const stripe = new stripe_1.default(stripeSecretKey, {
            apiVersion: '2023-10-16',
        });
        // Verify webhook signature
        const sig = request.headers['stripe-signature'];
        if (!sig) {
            firebase_functions_1.logger.error('❌ Missing Stripe signature');
            response.status(400).json({ error: 'Missing signature' });
            return;
        }
        let event;
        try {
            event = stripe.webhooks.constructEvent(request.rawBody || request.body, sig, webhookSecret);
        }
        catch (err) {
            firebase_functions_1.logger.error('❌ Webhook signature verification failed', { error: err.message });
            response.status(400).json({ error: `Webhook Error: ${err.message}` });
            return;
        }
        firebase_functions_1.logger.info('🔔 Stripe webhook received', {
            type: event.type,
            id: event.id,
            paymentIntentId: event.data.object.id
        });
        // Handle payment_intent.succeeded events
        if (event.type === 'payment_intent.succeeded') {
            let paymentIntent = event.data.object;
            // Check if this is a B2C order (has our enhanced metadata)
            if (!paymentIntent.metadata?.source || paymentIntent.metadata.source !== 'b2c_shop') {
                firebase_functions_1.logger.info('⏭️ Skipping non-B2C payment intent', { paymentIntentId: paymentIntent.id });
                response.status(200).json({ received: true, skipped: 'not_b2c' });
                return;
            }
            // Idempotency: the order doc ID IS the payment intent ID, created
            // atomically with create() below. A second delivery (Stripe retry or
            // a concurrent execution) fails with ALREADY_EXISTS instead of racing
            // the old query-then-add pattern.
            const orderRef = db.collection('orders').doc(paymentIntent.id);
            // Expand payment_method so card/Klarna details are actually present
            // (the event payload only carries the payment_method ID as a string).
            // Also expand latest_charge so a Connect destination charge exposes its
            // transfer + application_fee ids for reconciliation (order.connect).
            try {
                paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
                    expand: ['payment_method', 'latest_charge']
                });
            }
            catch (expandError) {
                firebase_functions_1.logger.warn('⚠️ Could not expand payment_method, continuing without details', {
                    paymentIntentId: paymentIntent.id
                });
            }
            // Extract order data from enhanced metadata
            const metadata = paymentIntent.metadata;
            // itemDetails may be chunked across itemDetails, itemDetails1… by
            // createPaymentIntent (Stripe's 500-char metadata-value cap) —
            // reassemble before parsing.
            let itemDetailsJson = metadata.itemDetails || '';
            for (let i = 1; metadata[`itemDetails${i}`]; i++) {
                itemDetailsJson += metadata[`itemDetails${i}`];
            }
            // Log metadata sizes to detect Stripe truncation issues
            firebase_functions_1.logger.info('📊 Webhook: Metadata size check', {
                paymentIntentId: paymentIntent.id,
                itemDetailsLength: itemDetailsJson.length,
                totalMetadataKeys: Object.keys(metadata).length,
                largeFields: Object.entries(metadata)
                    .filter(([_, value]) => value && value.length > 400)
                    .map(([key, value]) => ({ key, length: value?.length || 0 })),
                possibleTruncation: false
            });
            // Validate required metadata
            if (!metadata.customerEmail || !itemDetailsJson) {
                firebase_functions_1.logger.error('❌ Missing required metadata for order creation', {
                    paymentIntentId: paymentIntent.id,
                    hasEmail: !!metadata.customerEmail,
                    hasItems: !!metadata.itemDetails,
                    allMetadataKeys: Object.keys(metadata)
                });
                response.status(400).json({ error: 'Insufficient metadata' });
                return;
            }
            // Parse item details from JSON
            let cartItems;
            try {
                cartItems = JSON.parse(itemDetailsJson);
            }
            catch (err) {
                firebase_functions_1.logger.error('❌ Failed to parse itemDetails JSON', {
                    paymentIntentId: paymentIntent.id,
                    // Truncated (P1-05): enough to diagnose a chunking bug, not the
                    // whole snapshot.
                    itemDetailsHead: String(itemDetailsJson).slice(0, 200),
                    itemDetailsLength: String(itemDetailsJson).length
                });
                response.status(400).json({ error: 'Invalid itemDetails format' });
                return;
            }
            // Generate order number
            const orderNumber = `${app_urls_1.commerceConfig.orderNumberPrefix}-${Date.now().toString().slice(-6)}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
            // Create order data from Stripe metadata
            // Structure MUST match frontend order creation in Checkout.jsx for consistency
            const orderData = {
                orderNumber,
                status: 'confirmed',
                source: 'b2c',
                // Tenant id — multi-tenant scoping key. Carried from the storefront
                // through the PaymentIntent metadata; falls back to the default shop
                // so an order can never be created untagged. (Phase 1.)
                shopId: metadata.shopId || tenancy_1.DEFAULT_SHOP_ID,
                // Customer information from metadata
                customerInfo: {
                    email: metadata.customerEmail,
                    // ✅ Construct name from first+last to match frontend
                    name: `${metadata.shippingFirstName || metadata.customerFirstName || ''} ${metadata.shippingLastName || metadata.customerLastName || ''}`.trim(),
                    firstName: metadata.shippingFirstName || metadata.customerFirstName || '',
                    lastName: metadata.shippingLastName || metadata.customerLastName || '',
                    marketingOptIn: metadata.customerMarketing === 'true',
                    preferredLang: metadata.customerLang || 'sv-SE'
                },
                // Shipping information from metadata
                shippingInfo: {
                    address: metadata.shippingAddress || '',
                    apartment: metadata.shippingApartment || '',
                    city: metadata.shippingCity || '',
                    postalCode: metadata.shippingPostalCode || '',
                    country: metadata.shippingCountry || 'SE'
                },
                // Delivery method (Click & Collect). AdminOrderDetail renders
                // order.deliveryMethod; pickupLocation is set only for pickup orders.
                deliveryMethod: metadata.deliveryMethod || 'home',
                ...(metadata.deliveryMethod === 'pickup' && {
                    pickupLocation: {
                        id: metadata.pickupLocationId || '',
                        name: metadata.pickupLocationName || '',
                        address: metadata.pickupLocationAddress || '',
                        // Chosen pickup date (ISO YYYY-MM-DD), '' when the location has no
                        // specific dates. Shown in admin + order confirmation (Slice 6).
                        date: metadata.pickupLocationDate || ''
                    }
                }),
                // Order items from parsed JSON
                items: cartItems,
                // Financial data from metadata (flat structure to match frontend)
                subtotal: parseFloat(metadata.subtotal || '0'),
                shipping: parseFloat(metadata.shipping || '0'),
                vat: parseFloat(metadata.vat || '0'),
                discountAmount: parseFloat(metadata.discountAmount || '0'),
                total: parseFloat(metadata.total || '0'),
                // Payment information
                payment: {
                    method: 'stripe',
                    paymentIntentId: paymentIntent.id,
                    amount: paymentIntent.amount / 100,
                    currency: paymentIntent.currency,
                    status: paymentIntent.status,
                    // ✅ Conditionally add paymentMethodType to match frontend
                    ...(paymentIntent.payment_method && typeof paymentIntent.payment_method === 'object' && {
                        paymentMethodType: paymentIntent.payment_method.type
                    }),
                    // ✅ Add payment method details if available (card/klarna)
                    ...(paymentIntent.payment_method && typeof paymentIntent.payment_method === 'object' && paymentIntent.payment_method.card && {
                        paymentMethodDetails: {
                            brand: paymentIntent.payment_method.card.brand,
                            last4: paymentIntent.payment_method.card.last4,
                            ...(paymentIntent.payment_method.card.wallet?.type && {
                                wallet: paymentIntent.payment_method.card.wallet.type
                            })
                        }
                    }),
                    ...(paymentIntent.payment_method && typeof paymentIntent.payment_method === 'object' && paymentIntent.payment_method.klarna && {
                        paymentMethodDetails: { type: 'klarna' }
                    })
                },
                // ✅ Affiliate information - structure matches frontend (null when absent, no discountAmount field)
                affiliate: metadata.affiliateCode ? {
                    code: metadata.affiliateCode,
                    discountPercentage: parseFloat(metadata.discountPercentage || '0'),
                    clickId: metadata.affiliateClickId || ''
                } : null,
                // Campaign discount code ("Rabattkoder" add-on). Stamped only when the
                // applied code was a campaign code (metadata.discountSource==='campaign').
                // The flat discountAmount field above already carries the SEK amount;
                // this records WHICH code applied (for reporting + the usedCount bump).
                ...(metadata.discountSource === 'campaign' && metadata.discountCode && {
                    discount: {
                        source: 'campaign',
                        code: metadata.discountCode,
                        codeId: metadata.discountCodeId || ''
                    }
                }),
                // 📝 Right-of-withdrawal (POD) proof — stamped only when the cart had a
                // personalized item (server set withdrawalRequired in PI metadata).
                // Records what the buyer accepted: the notice version + a fingerprint
                // of the exact wording shown, plus the consent timestamp. Standard-
                // options orders never get this field (normal 14-day withdrawal).
                ...(metadata.withdrawalRequired === 'true' && {
                    withdrawal: {
                        required: true,
                        consent: metadata.withdrawalConsent === 'true',
                        noticeVersion: metadata.withdrawalNoticeVersion || '',
                        noticeFingerprint: metadata.withdrawalNoticeFingerprint || '',
                        consentAt: metadata.withdrawalConsentAt || ''
                    }
                }),
                // ✅ B2C customer account linkage (from metadata, set at payment time)
                ...(metadata.b2cCustomerId && {
                    b2cCustomerId: metadata.b2cCustomerId,
                    b2cCustomerAuthId: metadata.b2cCustomerAuthId || '',
                    hasAccount: true
                }),
                // 💸 Stripe Connect (destination charge) — recorded for reconciliation
                // ONLY when this was a destination charge (metadata carries the
                // connected account). Legacy single-account orders never get this
                // field. This is the PLATFORM cut; it is INDEPENDENT of any affiliate
                // commission (processOrderCompletion below) — never net one vs the
                // other. transfer/fee ids come from the expanded latest_charge.
                ...(metadata.connectedAccountId && {
                    connect: {
                        isDestinationCharge: true,
                        connectedAccountId: metadata.connectedAccountId,
                        applicationFeeAmount: parseInt(metadata.applicationFeeAmount || '0', 10),
                        applicationFeeId: (paymentIntent.latest_charge?.application_fee) || null,
                        transferId: (paymentIntent.latest_charge?.transfer) || null,
                        commissionBps: parseInt(metadata.commissionBps || '0', 10),
                        transferReversed: false
                    }
                }),
                // ✅ Timestamps using FieldValue for consistency with frontend
                createdAt: new Date(),
                updatedAt: new Date(),
                // ✅ Webhook tracking flags
                webhookProcessed: true,
                webhookEventId: event.id
            };
            // Reconciliation hardening (2026-07-01 audit): the PI's `amount` is what
            // the buyer was actually CHARGED — authoritative over the metadata copy
            // of the server total. Identical by construction today (metadata.total
            // is set from the same computeOrderTotalsSek result the charge uses);
            // this guards future drift between the two write points. On mismatch:
            // alert + stamp the charged amount so refunds/reports reconcile against
            // money reality, never a stale copy.
            const chargedSek = paymentIntent.amount / 100;
            if (Math.abs(chargedSek - orderData.total) > 0.1) {
                firebase_functions_1.logger.error('⚠️ Order total mismatch vs charged PI amount — stamping charged amount as authoritative', {
                    paymentIntentId: paymentIntent.id,
                    metadataTotal: orderData.total,
                    chargedSek,
                });
                orderData.total = chargedSek;
            }
            // Create order in Firestore with the deterministic ID; a duplicate
            // delivery fails here atomically and is treated as success
            try {
                await orderRef.create(orderData);
            }
            catch (createError) {
                if (createError.code === 6 /* ALREADY_EXISTS */) {
                    firebase_functions_1.logger.info('✅ Order already exists for payment intent', {
                        paymentIntentId: paymentIntent.id
                    });
                    response.status(200).json({ received: true, existing: true });
                    return;
                }
                throw createError;
            }
            // P1-05: no customer PII (email) in logs — ids reconcile fine.
            firebase_functions_1.logger.info('✅ Order created from Stripe webhook', {
                paymentIntentId: paymentIntent.id,
                orderId: orderRef.id,
                orderNumber,
                total: metadata.total,
                hasAffiliate: !!metadata.affiliateCode
            });
            // Abandoned-checkout recovery: the checkout completed → mark its
            // checkouts/{piId} doc so the sweep never sends a reminder for a paid
            // order. Best-effort — a failure here must not fail the webhook (the
            // order is already created; the sweep's own race guard re-checks the
            // order anyway).
            try {
                await db.collection('checkouts').doc(paymentIntent.id).set({ status: 'completed', completedAt: new Date() }, { merge: true });
            }
            catch (recoveryError) {
                firebase_functions_1.logger.warn('⚠️ checkout-recovery: failed to mark checkout completed', {
                    paymentIntentId: paymentIntent.id,
                    error: recoveryError?.message,
                });
            }
            // Campaign discount code usage: bump usedCount by 1 on the PAID order,
            // exactly once (this runs after orderRef.create SUCCEEDED — a duplicate
            // webhook delivery hits the ALREADY_EXISTS path above and returns before
            // here, so it never double-counts). Best-effort: an increment failure
            // must NOT fail the webhook (the order is already created). usedCount is
            // written ONLY here (server, Admin SDK) — never client-side.
            if (metadata.discountSource === 'campaign' && metadata.discountCodeId) {
                try {
                    await db.collection('discountCodes').doc(metadata.discountCodeId).update({
                        usedCount: firestore_1.FieldValue.increment(1)
                    });
                }
                catch (incrError) {
                    firebase_functions_1.logger.error('⚠️ Failed to increment discount code usedCount (order already created)', {
                        paymentIntentId: paymentIntent.id,
                        discountCodeId: metadata.discountCodeId,
                        error: incrError?.message
                    });
                }
            }
            // ⚠️ CRITICAL: Do NOT process affiliate commission here!
            // The processB2COrderCompletionHttp function handles ALL affiliate processing
            // to avoid duplicate commission credits. The order data contains the affiliate
            // structure, so the processing function will handle it correctly.
            // Trigger emails, customer stats and affiliate commission via the
            // shared core function (direct call — no mock req/res)
            try {
                const { processOrderCompletion } = require('../order-processing/functions');
                const result = await processOrderCompletion(orderRef.id);
                firebase_functions_1.logger.info('✅ Webhook: Order processing completed', {
                    orderId: orderRef.id,
                    statusCode: result.statusCode,
                    result: result.body
                });
            }
            catch (emailError) {
                firebase_functions_1.logger.error('❌ Webhook: Failed to trigger order processing', {
                    error: emailError,
                    orderId: orderRef.id,
                    orderNumber
                });
                // Don't fail the webhook - order is already created
                // Admin can manually trigger emails if needed
            }
            // 🖨️ POD printer notification: if this order has ≥1 POD line, notify the
            // shop's assigned printers ("Ny POD-order"). Fire-and-forget with catch —
            // it must NEVER delay or fail the webhook (mirrors the email calls in
            // processOrderCompletion). Reuses the print projection's slot-aware
            // resolution (loadShopMappings + resolveSlots via toPrintNotificationLines)
            // — no duplication. If no printer is assigned, the orchestrator SKIPS the
            // send (no platform fallback). RESEND_API_KEY is already bound to this fn.
            try {
                const { loadShopMappings, orderHasPodLine, toPrintNotificationLines } = require('../print/printProjection');
                const podShopId = orderData.shopId || tenancy_1.DEFAULT_SHOP_ID;
                const mappings = await loadShopMappings(podShopId);
                if (mappings.size > 0 && orderHasPodLine(orderData, mappings)) {
                    const lines = toPrintNotificationLines(orderData, mappings);
                    const { EmailOrchestrator } = require('../email-orchestrator/core/EmailOrchestrator');
                    const orchestrator = new EmailOrchestrator();
                    // TRULY fire-and-forget: no await — the 200 must not wait on the
                    // printer query + Resend HTTP call. The surrounding try/catch covers
                    // synchronous throws; .catch covers async failures.
                    orchestrator.sendEmail({
                        emailType: 'PRINT_ORDER_NOTIFICATION',
                        orderId: orderRef.id,
                        shopId: podShopId,
                        orderData: {
                            orderNumber: orderData.orderNumber || orderNumber,
                            deliveryMethod: orderData.deliveryMethod,
                        },
                        additionalData: { lines },
                    }).then(() => {
                        firebase_functions_1.logger.info('🖨️ PRINT_ORDER_NOTIFICATION dispatched', { orderId: orderRef.id, podLines: lines.length });
                    }).catch((e) => {
                        firebase_functions_1.logger.warn('⚠️ PRINT_ORDER_NOTIFICATION send failed (best-effort)', { orderId: orderRef.id, error: e?.message });
                    });
                }
            }
            catch (printNotifyError) {
                firebase_functions_1.logger.warn('⚠️ PRINT_ORDER_NOTIFICATION failed (best-effort, order unaffected)', {
                    orderId: orderRef.id,
                    error: printNotifyError?.message,
                });
            }
            response.status(200).json({
                received: true,
                orderCreated: true,
                orderId: orderRef.id,
                orderNumber,
                emailsTriggered: true
            });
        }
        else if (event.type === 'payment_intent.payment_failed') {
            // Abandoned-checkout recovery: a B2C payment attempt failed. Mark the
            // checkouts/{piId} doc 'failed' so the sweep skips it (a failed attempt
            // is not an abandoned-but-recoverable cart in the reminder sense). Only
            // our own storefront intents carry source==='b2c_shop'. Best-effort,
            // always returns 200 so Stripe doesn't retry-storm.
            const failedPi = event.data.object;
            if (failedPi.metadata?.source === 'b2c_shop') {
                try {
                    await db.collection('checkouts').doc(failedPi.id).set({ status: 'failed', failedAt: new Date() }, { merge: true });
                }
                catch (recoveryError) {
                    firebase_functions_1.logger.warn('⚠️ checkout-recovery: failed to mark checkout failed', {
                        paymentIntentId: failedPi.id,
                        error: recoveryError?.message,
                    });
                }
            }
            response.status(200).json({ received: true, paymentFailed: true });
        }
        else if (event.type === 'account.updated') {
            // 💸 Stripe Connect: a connected account's KYC/capabilities changed
            // (can happen long after the admin closed the onboarding tab). Mirror
            // the fresh status onto shops/{shopId}.payments. The shopId is on the
            // account metadata we set at creation. Idempotent — writes derived state.
            const acct = event.data.object;
            const shopId = acct?.metadata?.shopId;
            if (shopId) {
                try {
                    const snap = await db.collection('shops').doc(shopId).get();
                    const existing = snap.data()?.payments || {};
                    const patch = (0, connectOnboarding_1.statusPatch)(acct, existing);
                    await db.collection('shops').doc(shopId).update(patch);
                    firebase_functions_1.logger.info('💸 account.updated synced', { shopId, chargesEnabled: acct.charges_enabled });
                    // FIX 9: notify the shop owner ONLY on meaningful transitions —
                    // payouts turned off, status became 'restricted', or requirements
                    // newly appeared. Compared against the shop's PREVIOUS values.
                    const prevPayoutsEnabled = existing.payoutsEnabled === true;
                    const newPayoutsEnabled = patch['payments.payoutsEnabled'] === true;
                    const prevChargesEnabled = existing.chargesEnabled === true;
                    const newChargesEnabled = patch['payments.chargesEnabled'] === true;
                    const newStatus = patch['payments.connectStatus'];
                    const prevReqDue = Array.isArray(existing.requirementsDue) ? existing.requirementsDue : [];
                    const newReqDue = patch['payments.requirementsDue'] || [];
                    // Was the account past initial onboarding before this event? During
                    // first-time onboarding requirements are EXPECTED to be due — only
                    // an account that already submitted (or was active) should be told
                    // "Stripe needs more from you" when requirements (re)appear.
                    const wasPastOnboarding = existing.detailsSubmitted === true || prevChargesEnabled;
                    const changes = [];
                    if (!prevChargesEnabled && newChargesEnabled) {
                        changes.push('Ditt konto är verifierat — din butik kan nu ta emot betalningar och pengarna betalas ut till ditt bankkonto.');
                    }
                    if (prevPayoutsEnabled && !newPayoutsEnabled) {
                        changes.push('Utbetalningar har pausats för ditt konto.');
                    }
                    if (newStatus === 'restricted' && existing.connectStatus !== 'restricted') {
                        changes.push('Ditt konto har begränsats och kräver åtgärd.');
                    }
                    if (prevReqDue.length === 0 && newReqDue.length > 0 && wasPastOnboarding) {
                        changes.push('Stripe behöver ytterligare uppgifter från dig för att fortsätta.');
                    }
                    if (changes.length > 0) {
                        await sendConnectStatusChange(shopId, changes);
                    }
                }
                catch (e) {
                    firebase_functions_1.logger.warn('⚠️ account.updated sync failed', { shopId, error: e?.message });
                }
            }
            response.status(200).json({ received: true, accountUpdated: true });
        }
        else if (event.type === 'charge.dispute.created') {
            // 💸 A dispute opened. For destination charges the platform is merchant
            // of record, so Stripe debits the PLATFORM balance for the full charge.
            // The principal already left for the shop as the transfer → recover it
            // by reversing that transfer (protect the platform). Reverse-on-created
            // is the documented default (settings/platform.reverseDisputeOnCreated);
            // set it false to only stamp + wait for the outcome. We always stamp the
            // dispute; the recovery is best-effort and never crashes the webhook.
            const dispute = event.data.object;
            try {
                const found = await loadOrderForDispute(dispute);
                if (found) {
                    const cfg = await (0, platformConfig_1.readPlatformConfig)();
                    const patch = {
                        disputeStatus: dispute.status || 'open',
                        disputedAt: new Date(),
                        disputeId: dispute.id || null,
                    };
                    if (cfg.reverseDisputeOnCreated) {
                        const recovery = await recoverDisputedTransfer(stripe, found.order, dispute.id);
                        Object.assign(patch, recovery);
                    }
                    else {
                        // Wait-for-outcome: stamp only; reversal deferred to dispute.closed(lost).
                        patch['connect.disputeRecoveryStatus'] = 'pending_outcome';
                        firebase_functions_1.logger.info('💸 dispute: reverse-on-created OFF — stamping only, will recover if lost', {
                            orderId: found.ref.id,
                        });
                    }
                    await found.ref.update(patch);
                    firebase_functions_1.logger.info('💸 dispute stamped on order', { orderId: found.ref.id, status: dispute.status });
                    // Platform-admin alert (best-effort). If the recovery hit a
                    // shortfall, flag that; otherwise it's a plain new-dispute alert.
                    const recStatus = patch['connect.disputeRecoveryStatus'] || undefined;
                    await sendDisputeAlert({
                        order: found.order,
                        shopId: found.order?.shopId,
                        disputeId: dispute.id,
                        reason: dispute.reason,
                        amount: dispute.amount,
                        status: dispute.status,
                        alertKind: recStatus === 'shortfall' ? 'shortfall' : 'dispute',
                        recoveryStatus: recStatus,
                    });
                }
            }
            catch (e) {
                // Never fail the webhook on a dispute-stamp error (Stripe retries).
                firebase_functions_1.logger.warn('⚠️ dispute.created handling failed', { error: e?.message });
            }
            response.status(200).json({ received: true, disputeRecorded: true });
        }
        else if (event.type === 'charge.dispute.closed') {
            // 💸 A dispute resolved. WON → send the reversed funds back to the shop
            // (a fresh transfer of exactly what we reversed). LOST → finalize; if we
            // were in wait-for-outcome mode and never reversed, recover now. Both
            // paths are idempotent and never crash the webhook.
            const dispute = event.data.object;
            try {
                const found = await loadOrderForDispute(dispute);
                if (found) {
                    const patch = {
                        disputeStatus: dispute.status || 'closed',
                        disputeClosedAt: new Date(),
                    };
                    if (dispute.status === 'won') {
                        // Re-transfer the reversed amount back to the connected account.
                        const reTransfer = (0, connectParams_1.buildDisputeReTransferParams)(found.order);
                        if (reTransfer) {
                            try {
                                // Idempotency key keyed on the dispute → concurrent/duplicate
                                // won deliveries collapse to ONE transfer (no double-send of
                                // real money to the shop). Cross-instance safe.
                                const t = await stripe.transfers.create(reTransfer.params, { idempotencyKey: `dispute-retransfer:${dispute.id || found.ref.id}` });
                                patch['connect.disputeReTransferId'] = t.id;
                                patch['connect.transferReversed'] = false; // funds are back with the shop
                                patch['connect.disputeRecoveryStatus'] = 'returned_won';
                                firebase_functions_1.logger.info('💸 dispute WON: funds re-transferred to shop', { orderId: found.ref.id, transferId: t.id, amount: t.amount });
                            }
                            catch (e) {
                                patch['connect.disputeRecoveryStatus'] = 'retransfer_failed';
                                patch['connect.disputeRecoveryError'] = (e?.message || 'retransfer_failed').slice(0, 300);
                                firebase_functions_1.logger.error('🚨 dispute WON but re-transfer FAILED — manual reconcile', { orderId: found.ref.id, error: e?.message });
                            }
                        }
                        else {
                            // Won but nothing was reversed (e.g. wait-for-outcome, never reversed) → nothing to return.
                            patch['connect.disputeRecoveryStatus'] = 'won_no_reversal';
                            firebase_functions_1.logger.info('💸 dispute WON, no prior reversal — nothing to return', { orderId: found.ref.id });
                        }
                    }
                    else if (dispute.status === 'lost' || dispute.status === 'warning_closed') {
                        // LOST (or warning_closed = an early-fraud warning that closed
                        // without escalating). If we never reversed (wait-for-outcome
                        // mode), recover now that it's terminal so funds don't sit
                        // unrecovered. reverseDisputeOnCreated isn't re-checked: once a
                        // dispute is terminal the platform has definitively paid (lost) or
                        // the warning closed, so claw back regardless of created-time mode.
                        // The createReversal idempotency key (dispute id) means a prior
                        // created-time reversal won't double-fire here.
                        if (found.order?.connect?.isDestinationCharge === true && found.order?.connect?.transferReversed !== true) {
                            const recovery = await recoverDisputedTransfer(stripe, found.order, dispute.id);
                            Object.assign(patch, recovery);
                        }
                        patch['connect.disputeRecoveryStatus'] = patch['connect.disputeRecoveryStatus'] || 'lost_final';
                        firebase_functions_1.logger.info('💸 dispute LOST: finalized', { orderId: found.ref.id });
                        // Platform-admin alert on the terminal-lost / shortfall path.
                        const recStatus = patch['connect.disputeRecoveryStatus'] || undefined;
                        await sendDisputeAlert({
                            order: found.order,
                            shopId: found.order?.shopId,
                            disputeId: dispute.id,
                            reason: dispute.reason,
                            amount: dispute.amount,
                            status: dispute.status,
                            alertKind: recStatus === 'shortfall' ? 'shortfall' : 'dispute',
                            recoveryStatus: recStatus,
                        });
                    }
                    await found.ref.update(patch);
                }
            }
            catch (e) {
                firebase_functions_1.logger.warn('⚠️ dispute.closed handling failed', { error: e?.message });
            }
            response.status(200).json({ received: true, disputeClosed: true });
        }
        else {
            // Handle other webhook events if needed
            firebase_functions_1.logger.info('⏭️ Unhandled webhook event type', { type: event.type });
            response.status(200).json({ received: true, handled: false });
        }
    }
    catch (error) {
        firebase_functions_1.logger.error('❌ Webhook processing error', error);
        response.status(500).json({ error: 'Webhook processing failed' });
    }
});
//# sourceMappingURL=stripeWebhook.js.map