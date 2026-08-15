"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setPrintJobStatus = void 0;
// setPrintJobStatus — the print shop pushes a POD order forward: 'printed'
// (internal production milestone, no customer email) or 'shipped' (fulfilment —
// sends the customer status email + lets the reviews trigger fire).
//
// Same callable-projection auth as getPrintJob: role==='print_shop' && active
// (read from the LIVE user doc → instant revoke), and a per-order assert that the
// order's shop is one this printer may fulfil. The order must also be a POD order
// for that shop (at least one line's sku is mapped) — the printer only ever
// touches orders it can actually see in its queue.
//
// The write MIRRORS OrderContext.updateOrderStatus's shape: status + a
// statusHistory entry { from, to, changedBy, changedAt, displayName } appended to
// the existing array (a JS Date in the array item — serverTimestamp is illegal
// inside array elements; OrderContext uses `new Date()` for the same reason) +
// updatedAt serverTimestamp + trackingNumber when supplied. On 'shipped' it ALSO
// invokes the order-status email server-side via the EmailOrchestrator (the client
// admin path normally does this; a bare status write sends NOTHING to the
// customer). Email failure is swallowed — it must never fail the status write.
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const database_1 = require("../config/database");
const app_urls_1 = require("../config/app-urls");
const printGuard_1 = require("./printGuard");
const printProjection_1 = require("./printProjection");
// Allowlist of FROM-statuses per action (not a terminal denylist — an allowlist
// also blocks statuses we didn't anticipate). Deliberately EXCLUDES:
//  - 'pending'/'invoiced': an unpaid B2B invoice order must not be produced or
//    shipped before payment ('paid' is the B2B post-payment status).
//  - 'ready_for_pickup': pickup orders are handed over by the shop, never
//    "shipped" by the printer (the printer may still mark them 'printed' earlier).
// INCLUDES 'partially_refunded' (P1-08): a partial goodwill refund does not
// cancel the order — the remaining goods still get produced and shipped.
const ALLOWED_FROM = {
    printed: ['confirmed', 'processing', 'paid', 'partially_refunded'],
    shipped: ['confirmed', 'processing', 'paid', 'printed', 'partially_refunded'],
};
// Best-effort customer order-status email, sent under the SHOP's identity (shopId
// threaded → the orchestrator resolves from-name + logo + reply-to). Swallows every
// error: a mail failure must never roll back the status write the printer just made.
async function sendCustomerStatusEmail(orderId, order, previousStatus, newStatus, trackingNumber) {
    try {
        // Lazy require mirrors the webhook: keep the mailer off the callable's cold
        // path unless we actually ship.
        const { EmailOrchestrator } = require('../email-orchestrator/core/EmailOrchestrator');
        const orchestrator = new EmailOrchestrator();
        await orchestrator.sendEmail({
            emailType: 'ORDER_STATUS_UPDATE',
            // Recipient resolution mirrors OrderContext: userId → b2cCustomerId → guest
            // email. Passing all three lets the UserResolver pick the right one.
            userId: order.userId,
            b2cCustomerId: order.b2cCustomerId,
            customerInfo: order.customerInfo || undefined,
            source: order.source,
            orderId,
            shopId: order.shopId,
            orderData: {
                orderNumber: order.orderNumber || orderId,
                status: newStatus,
                totalAmount: order.totalAmount || order.total || 0,
                items: Array.isArray(order.items) ? order.items : [],
            },
            additionalData: {
                newStatus,
                previousStatus,
                ...(trackingNumber ? { trackingNumber } : {}),
            },
            adminEmail: false,
        });
        firebase_functions_1.logger.info('print: customer status email sent', { orderId, newStatus });
    }
    catch (e) {
        // Best-effort ONLY. Do not rethrow.
        firebase_functions_1.logger.warn('print: customer status email failed (best-effort)', {
            orderId,
            newStatus,
            error: e?.message,
        });
    }
}
// The email path needs the Resend key — declared inline so the secret is bound to
// THIS function (mirrors stripeWebhook / sendOrderStatusUpdateEmail).
exports.setPrintJobStatus = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 120,
    secrets: ['RESEND_API_KEY'],
    cors: app_urls_1.appUrls.CORS_ORIGINS,
}, async (request) => {
    const ctx = await (0, printGuard_1.getPrintShopContext)(request.auth?.uid);
    const orderId = String(request.data?.orderId || '').trim();
    const action = String(request.data?.action || '').trim();
    const trackingNumber = String(request.data?.trackingNumber || '').trim().slice(0, 100);
    if (!orderId)
        throw new https_1.HttpsError('invalid-argument', 'orderId is required');
    if (action !== 'printed' && action !== 'shipped') {
        throw new https_1.HttpsError('invalid-argument', 'action must be "printed" or "shipped"');
    }
    const snap = await database_1.db.collection('orders').doc(orderId).get();
    if (!snap.exists)
        throw new https_1.HttpsError('not-found', 'Order not found');
    const order = snap.data();
    // CRUX: the order's shop must be one this printer may fulfil.
    (0, printGuard_1.assertShopAllowed)(ctx, order.shopId);
    // ...and it must actually be a POD order for that shop (a mapped line) — the
    // printer only ever operates on orders it can see in its own queue.
    const mappings = await (0, printProjection_1.loadShopMappings)(order.shopId);
    if ((0, printProjection_1.productionSnapshotPending)(order)) {
        throw new https_1.HttpsError('unavailable', 'Produktionsunderlaget låses just nu — försök igen om en liten stund.');
    }
    if (!(0, printProjection_1.orderHasPodLine)(order, mappings)) {
        throw new https_1.HttpsError('permission-denied', 'This order has no POD lines you can fulfil');
    }
    const previousStatus = order.status || 'pending';
    // Fast pre-check (nice error before any further reads); the TRANSACTION
    // below re-checks authoritatively against the then-current status (P1-14).
    if (!ALLOWED_FROM[action].includes(previousStatus)) {
        throw new https_1.HttpsError('failed-precondition', `Ordern har status "${previousStatus}" och kan inte markeras som ${action === 'printed' ? 'tryckt' : 'skickad'}.`);
    }
    // P1-13: EVERY POD production line (item × slot) must resolve a deliverable
    // artwork before the order may advance. One resolvable line must not carry an
    // order whose OTHER line would ship without its print — that triggers customer
    // "skickad" email for a physically incomplete parcel.
    //
    // EXCEPTION: 'shipped' from 'printed' skips the gate — production is already
    // DONE, and a shop deleting/replacing an artwork after printing must not
    // strand a physically shipped parcel un-shippable (verifier finding, 2026-08-15).
    const productionAlreadyDone = action === 'shipped' && previousStatus === 'printed';
    if (!productionAlreadyDone) {
        const unresolvedLines = await (0, printProjection_1.findUnresolvedPodLines)(order, mappings, database_1.db);
        if (unresolvedLines.length > 0) {
            throw new https_1.HttpsError('failed-precondition', `Ordern har olösta tryckrader och kan inte markeras som ${action === 'printed' ? 'tryckt' : 'skickad'}: ${unresolvedLines.join('; ')}`);
        }
    }
    // Pickup orders are handed over by the shop — the printer never "ships" them.
    if (action === 'shipped' && order.deliveryMethod === 'pickup') {
        throw new https_1.HttpsError('failed-precondition', 'Detta är en upphämtningsorder — den lämnas ut av butiken och ska inte markeras som skickad.');
    }
    // Printer display name — the printer's user displayName, else a neutral label.
    let displayName = 'Tryckeri';
    try {
        const userSnap = await database_1.db.collection('users').doc(ctx.uid).get();
        const ud = userSnap.exists ? userSnap.data() : null;
        const dn = ud?.contactPerson || ud?.displayName || ud?.name;
        if (typeof dn === 'string' && dn.trim())
            displayName = dn.trim();
    }
    catch {
        // keep the fallback label
    }
    // P1-14 (TOCTOU): the transition is a TRANSACTION — re-read the order and
    // re-check the from-status against the CURRENT value, then write once. Two
    // concurrent operators can both pass the pre-check above, but only ONE
    // commits here; the loser gets a clean failed-precondition instead of
    // duplicating the history entry and the customer shipment email.
    const orderRef = database_1.db.collection('orders').doc(orderId);
    let committedFrom = previousStatus;
    await database_1.db.runTransaction(async (tx) => {
        const fresh = await tx.get(orderRef);
        if (!fresh.exists)
            throw new https_1.HttpsError('not-found', 'Order not found');
        const cur = fresh.data();
        const curStatus = cur.status || 'pending';
        if (!ALLOWED_FROM[action].includes(curStatus)) {
            throw new https_1.HttpsError('failed-precondition', `Ordern har status "${curStatus}" och kan inte markeras som ${action === 'printed' ? 'tryckt' : 'skickad'}.`);
        }
        committedFrom = curStatus;
        // Mirror OrderContext.updateOrderStatus: a plain-object statusHistory entry
        // with a JS Date (arrays can't hold serverTimestamp), appended to the array.
        const statusChange = {
            from: curStatus,
            to: action,
            changedBy: ctx.uid,
            changedAt: new Date(),
            displayName,
            via: 'setPrintJobStatus',
        };
        const update = {
            status: action,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
            statusHistory: [...(Array.isArray(cur.statusHistory) ? cur.statusHistory : []), statusChange],
        };
        if (action === 'shipped' && trackingNumber) {
            update.trackingNumber = trackingNumber;
        }
        tx.update(orderRef, update);
    });
    // 'shipped' → send the customer status email (best-effort), AFTER the commit —
    // only the transaction winner reaches this line, so the email fires exactly
    // once. 'printed' is an internal milestone: NO customer email. The reviews
    // onDocumentUpdated trigger fires automatically on the 'shipped' write.
    if (action === 'shipped') {
        await sendCustomerStatusEmail(orderId, order, committedFrom, action, trackingNumber || undefined);
    }
    return { success: true, orderId, status: action, from: committedFrom };
});
//# sourceMappingURL=setPrintJobStatus.js.map