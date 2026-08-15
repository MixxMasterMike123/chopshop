"use strict";
// P1-15 — durable print-notify outbox (decision core in ./outboxCore).
//
// Before this, the Stripe webhook fired PRINT_ORDER_NOTIFICATION as a raw
// fire-and-forget promise (a Resend hiccup or instance teardown lost it
// silently), and the B2B path had NO notification at all when an invoice order
// was marked 'paid'. Now:
//
//   1. onOrderProductionReady (orders/{id} write trigger, ANY writer) enqueues
//      ONE printNotifications/{orderId} outbox doc the first time a POD order
//      enters the paid lifecycle, then attempts delivery inline. Enqueue is the
//      durable step: if it fails, the trigger throws so Eventarc retries it.
//   2. sweepPrintNotifyOutbox re-delivers 'pending' events with capped
//      exponential backoff (outboxCore.retryDelayMs) and marks MAX_ATTEMPTS
//      overruns 'failed' — never silently dropped. It also purges terminal
//      docs after 60 days.
//
// Trigger events are at-least-once and unordered; the outbox doc id IS the
// orderId, so a duplicate/late event dies on create() (ALREADY_EXISTS). The
// doc snapshots the notification lines at enqueue time — no PII beyond what
// the email itself carries (product/sku/qty/placement).
//
// printNotifications is server-only: no firestore.rules match → default deny.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweepPrintNotifyOutbox = exports.onOrderProductionReady = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_functions_1 = require("firebase-functions");
const firestore_2 = require("firebase-admin/firestore");
const crypto_1 = require("crypto");
const database_1 = require("../config/database");
const outboxCore_1 = require("./outboxCore");
const printProjection_1 = require("./printProjection");
const SWEEP_BATCH = 50;
const PURGE_AFTER_DAYS = 60;
function toMillis(value) {
    if (!value)
        return 0;
    if (value instanceof Date)
        return value.getTime();
    const timestamp = value;
    return typeof timestamp.toMillis === 'function' ? timestamp.toMillis() : 0;
}
/**
 * Atomically claims one pending event. Both the inline trigger attempt and every
 * sweep invocation use this transaction, so overlapping functions cannot send
 * the same email concurrently. A crashed owner becomes recoverable when its
 * lease expires.
 */
async function claimPrintNotification(ref, ignoreSchedule) {
    const leaseToken = (0, crypto_1.randomUUID)();
    let claimed = null;
    await database_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists)
            return;
        const data = snap.data();
        const now = Date.now();
        const attempts = Number(data.attempts) || 0;
        const leaseUntilMs = toMillis(data.leaseUntil);
        // A function may crash after claiming its final attempt. Once that lease
        // expires, close the event rather than leaving a pending doc forever.
        if (data.status === 'pending' && attempts >= outboxCore_1.MAX_ATTEMPTS && leaseUntilMs <= now) {
            tx.update(ref, {
                status: 'failed',
                resolvedAt: new Date(now),
                lastError: 'attempts exhausted after an interrupted delivery',
                nextAttemptAt: firestore_2.FieldValue.delete(),
                leaseToken: firestore_2.FieldValue.delete(),
                leaseUntil: firestore_2.FieldValue.delete(),
            });
            return;
        }
        if (!(0, outboxCore_1.isClaimablePrintNotification)({
            status: data.status,
            attempts,
            nextAttemptAtMs: toMillis(data.nextAttemptAt),
            leaseUntilMs,
            nowMs: now,
            ignoreSchedule,
        }))
            return;
        const nextAttempts = attempts + 1;
        const leaseUntil = new Date(now + outboxCore_1.DELIVERY_LEASE_MS);
        tx.update(ref, {
            attempts: nextAttempts,
            leaseToken,
            leaseUntil,
            lastAttemptAt: new Date(now),
        });
        claimed = { ...data, attempts: nextAttempts, leaseToken, leaseUntil };
    });
    return claimed;
}
/** Apply an outcome only if this invocation still owns the delivery lease. */
async function resolveClaim(ref, leaseToken, patch) {
    let resolved = false;
    await database_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data()?.leaseToken !== leaseToken)
            return;
        tx.update(ref, {
            ...patch,
            leaseToken: firestore_2.FieldValue.delete(),
            leaseUntil: firestore_2.FieldValue.delete(),
        });
        resolved = true;
    });
    return resolved;
}
// One already-claimed delivery attempt. Resolves the doc to a terminal state
// on success ('sent', or 'skipped' when the shop has no assigned printer — the
// print-portal queue remains the source of truth, so we do NOT retry-until-
// assigned), or advances attempts/backoff on failure. Swallows every error:
// retry policy lives in the outbox state, never in thrown exceptions.
async function deliverPrintNotification(ref, data) {
    let outcome;
    try {
        // Lazy require keeps the mailer off the trigger's cold path for the vast
        // majority of order writes that never reach delivery.
        const { EmailOrchestrator } = require('../email-orchestrator/core/EmailOrchestrator');
        const orchestrator = new EmailOrchestrator();
        const res = await orchestrator.sendEmail({
            emailType: 'PRINT_ORDER_NOTIFICATION',
            orderId: data.orderId,
            shopId: data.shopId,
            orderData: {
                orderNumber: data.orderNumber,
                deliveryMethod: data.deliveryMethod,
            },
            additionalData: { lines: data.lines },
        });
        outcome = res?.success
            ? { ok: true, skipped: res?.details?.skipped === true }
            : { ok: false, error: String(res?.error || 'sendEmail returned success:false') };
    }
    catch (e) {
        outcome = { ok: false, error: String(e?.message || e) };
    }
    try {
        if (outcome.ok) {
            const resolved = await resolveClaim(ref, data.leaseToken, {
                status: outcome.skipped ? 'skipped' : 'sent',
                resolvedAt: new Date(),
                nextAttemptAt: firestore_2.FieldValue.delete(),
                ...(outcome.skipped ? { skipReason: 'no-printer-assigned' } : {}),
            });
            if (!resolved)
                return;
            firebase_functions_1.logger.info('print-outbox: notification resolved', {
                orderId: data.orderId,
                shopId: data.shopId,
                outcome: outcome.skipped ? 'skipped' : 'sent',
                podLines: data.lines.length,
            });
            return;
        }
        const attempts = Number(data.attempts) || 1;
        const exhausted = attempts >= outboxCore_1.MAX_ATTEMPTS;
        const resolved = await resolveClaim(ref, data.leaseToken, {
            status: exhausted ? 'failed' : 'pending',
            lastError: outcome.error?.slice(0, 300) || 'unknown',
            ...(exhausted
                ? { resolvedAt: new Date(), nextAttemptAt: firestore_2.FieldValue.delete() }
                : { nextAttemptAt: new Date(Date.now() + (0, outboxCore_1.retryDelayMs)(attempts)) }),
        });
        if (!resolved)
            return;
        (exhausted ? firebase_functions_1.logger.error : firebase_functions_1.logger.warn).call(firebase_functions_1.logger, exhausted
            ? 'print-outbox: notification FAILED permanently (attempts exhausted)'
            : 'print-outbox: delivery attempt failed, will retry', { orderId: data.orderId, shopId: data.shopId, attempts, error: outcome.error });
    }
    catch (stateErr) {
        // State write failed AFTER a send may have succeeded — the lease eventually
        // expires and the sweep retries. At-least-once by design: a duplicate
        // printer email is preferable to a lost production notification.
        firebase_functions_1.logger.warn('print-outbox: failed to persist delivery outcome', {
            orderId: data.orderId,
            error: stateErr?.message,
        });
    }
}
exports.onOrderProductionReady = (0, firestore_1.onDocumentWritten)({
    document: 'orders/{orderId}',
    database: 'b8s-reseller-db',
    region: 'us-central1',
    memory: '256MiB',
    secrets: ['RESEND_API_KEY'],
}, async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after)
        return; // deletion
    const eventShouldNotify = (0, outboxCore_1.shouldEnqueuePrintNotify)(before ? String(before.status || '') : null, String(after.status || ''));
    const eventNeedsSnapshot = after.productionSnapshotRequired === true &&
        (0, printProjection_1.productionSnapshotLines)(after) === null &&
        (0, outboxCore_1.isPaidLifecycleStatus)(String(after.status || ''));
    if (!eventShouldNotify && !eventNeedsSnapshot) {
        return;
    }
    const orderId = event.params.orderId;
    const shopId = String(after.shopId || '').trim();
    if (!shopId)
        return; // untenanted/sentinel orders have no printer to notify
    // Freeze B2B (and any future) orders that first become production-ready
    // without a snapshot. B2C already snapshots before order creation. The
    // print portal fails closed while productionSnapshotRequired is true and
    // this field is absent, so no printer can race this trigger.
    let productionOrder = after;
    let shouldNotifyCurrentOrder = eventShouldNotify;
    let lines;
    try {
        if (after.productionSnapshotRequired === true && (0, printProjection_1.productionSnapshotLines)(after) === null) {
            const orderRef = event.data.after.ref;
            // Eventarc is at-least-once. Freeze exactly once: the transaction winner
            // writes the snapshot; every duplicate uses that same stored value and
            // can never overwrite it with a later mapping/artwork graph.
            await database_1.db.runTransaction(async (tx) => {
                const current = await tx.get(orderRef);
                if (!current.exists)
                    return;
                const currentData = current.data();
                shouldNotifyCurrentOrder = (0, outboxCore_1.shouldEnqueuePrintNotify)(null, String(currentData.status || ''));
                const existing = (0, printProjection_1.productionSnapshotLines)(currentData);
                if (existing !== null) {
                    productionOrder = currentData;
                    return;
                }
                // If the order left the paid lifecycle before this delayed trigger
                // ran, do not freeze or notify it.
                if (!(0, outboxCore_1.isPaidLifecycleStatus)(String(currentData.status || ''))) {
                    productionOrder = currentData;
                    shouldNotifyCurrentOrder = false;
                    return;
                }
                const candidate = await (0, printProjection_1.buildProductionSnapshotInTransaction)(currentData, tx);
                tx.update(orderRef, { productionSnapshot: candidate });
                productionOrder = { ...currentData, productionSnapshot: candidate };
                // A delayed paid event may find the order already printed/shipped.
                // Freeze it for historical correctness, but do not notify production
                // after production has already advanced past the notify statuses.
            });
        }
        if ((0, printProjection_1.productionSnapshotPending)(productionOrder))
            return;
        if (!shouldNotifyCurrentOrder)
            return;
        const mappings = await (0, printProjection_1.loadShopMappings)(shopId);
        if (!(0, printProjection_1.orderHasPodLine)(productionOrder, mappings))
            return;
        lines = (0, printProjection_1.toPrintNotificationLines)(productionOrder, mappings);
    }
    catch (e) {
        // Mapping load failed — we cannot even tell whether this is a POD order.
        // Throw so Eventarc retries the event (durability of the ENQUEUE step).
        firebase_functions_1.logger.error('print-outbox: mapping resolution failed, retrying event', {
            orderId,
            shopId,
            error: e?.message,
        });
        throw e;
    }
    if (lines.length === 0)
        return;
    const ref = database_1.db.collection('printNotifications').doc(orderId);
    const outboxDoc = {
        orderId,
        shopId,
        orderNumber: String(after.orderNumber || orderId),
        deliveryMethod: after.deliveryMethod === 'pickup' ? 'pickup' : 'home',
        lines,
        status: 'pending',
        attempts: 0,
        createdAt: new Date(),
        // The sweep leaves fresh events alone for a grace window — the inline
        // attempt below normally resolves them, and the gap avoids double-sends.
        nextAttemptAt: new Date(Date.now() + outboxCore_1.INITIAL_SWEEP_DELAY_MS),
    };
    // create() = atomic dedupe (doc id == orderId). ALREADY_EXISTS (code 6)
    // means a concurrent/duplicate event won — benign no-op. Any OTHER create
    // failure throws so the trigger retries: enqueue is the durable step.
    try {
        await ref.create(outboxDoc);
    }
    catch (createErr) {
        if (createErr?.code === 6)
            return;
        firebase_functions_1.logger.error('print-outbox: enqueue failed, retrying event', {
            orderId,
            error: createErr?.message,
        });
        throw createErr;
    }
    // Inline first attempt — best-effort; the outbox owns retries from here. It
    // ignores only the five-minute schedule grace, never an active lease.
    const claimed = await claimPrintNotification(ref, true);
    if (claimed)
        await deliverPrintNotification(ref, claimed);
});
exports.sweepPrintNotifyOutbox = (0, scheduler_1.onSchedule)({
    schedule: 'every 10 minutes',
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 120,
    secrets: ['RESEND_API_KEY'],
}, async () => {
    const now = Date.now();
    // ── 1) Retry due events. Terminal resolution removes nextAttemptAt, so this
    // single-field ordered query contains only live work and cannot be starved
    // by an arbitrary first page of future events.
    try {
        const pending = await database_1.db
            .collection('printNotifications')
            .where('nextAttemptAt', '<=', new Date(now))
            .orderBy('nextAttemptAt', 'asc')
            .limit(SWEEP_BATCH)
            .get();
        for (const snap of pending.docs) {
            // Each event isolated. The transaction is the concurrency boundary:
            // overlapping sweeps simply fail to claim an already-leased event.
            try {
                const claimed = await claimPrintNotification(snap.ref, false);
                if (claimed)
                    await deliverPrintNotification(snap.ref, claimed);
            }
            catch (eventErr) {
                firebase_functions_1.logger.warn('print-outbox: event attempt failed unexpectedly', {
                    orderId: snap.id,
                    error: eventErr?.message,
                });
            }
        }
    }
    catch (e) {
        firebase_functions_1.logger.error('print-outbox: sweep retry query failed', { error: e?.message });
    }
    // ── 2) Retention: purge terminal docs older than 60 days. Range on
    // createdAt only (single-field); terminal-ness filtered in code.
    try {
        const cutoff = new Date(now - PURGE_AFTER_DAYS * 86400 * 1000);
        const old = await database_1.db
            .collection('printNotifications')
            .where('createdAt', '<=', cutoff)
            .limit(200)
            .get();
        const terminal = old.docs.filter((d) => d.data().status !== 'pending');
        if (terminal.length > 0) {
            const batch = database_1.db.batch();
            terminal.forEach((d) => batch.delete(d.ref));
            await batch.commit();
            firebase_functions_1.logger.info('print-outbox: purged terminal events', { count: terminal.length });
        }
    }
    catch (e) {
        firebase_functions_1.logger.warn('print-outbox: retention purge failed', { error: e?.message });
    }
});
//# sourceMappingURL=notifyOutbox.js.map