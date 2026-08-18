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

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';
import { db } from '../config/database';
import { isShopFeatureEnabled } from '../config/shopFeatures';
import {
  shouldEnqueuePrintNotify,
  isPaidLifecycleStatus,
  isClaimablePrintNotification,
  retryDelayMs,
  MAX_ATTEMPTS,
  INITIAL_SWEEP_DELAY_MS,
  DELIVERY_LEASE_MS,
} from './outboxCore';
import {
  buildProductionSnapshotInTransaction,
  loadShopMappings,
  orderHasPodLine,
  productionSnapshotLines,
  productionSnapshotPending,
  toPrintNotificationLines,
} from './printProjection';

const SWEEP_BATCH = 50;
const PURGE_AFTER_DAYS = 60;

type OutboxDoc = {
  orderId: string;
  shopId: string;
  orderNumber: string;
  deliveryMethod: string;
  lines: Array<{ productName: string; sku: string; quantity: number; placement: string }>;
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  attempts: number;
  createdAt: Date;
  nextAttemptAt: Date;
  leaseToken?: string;
  leaseUntil?: Date;
};

type ClaimedOutboxDoc = OutboxDoc & { leaseToken: string; attempts: number };

function toMillis(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const timestamp = value as { toMillis?: () => number };
  return typeof timestamp.toMillis === 'function' ? timestamp.toMillis() : 0;
}

/**
 * Atomically claims one pending event. Both the inline trigger attempt and every
 * sweep invocation use this transaction, so overlapping functions cannot send
 * the same email concurrently. A crashed owner becomes recoverable when its
 * lease expires.
 */
async function claimPrintNotification(
  ref: FirebaseFirestore.DocumentReference,
  ignoreSchedule: boolean
): Promise<ClaimedOutboxDoc | null> {
  const leaseToken = randomUUID();
  let claimed: ClaimedOutboxDoc | null = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const data = snap.data() as OutboxDoc;
    const now = Date.now();
    const attempts = Number(data.attempts) || 0;
    const leaseUntilMs = toMillis(data.leaseUntil);

    // A function may crash after claiming its final attempt. Once that lease
    // expires, close the event rather than leaving a pending doc forever.
    if (data.status === 'pending' && attempts >= MAX_ATTEMPTS && leaseUntilMs <= now) {
      tx.update(ref, {
        status: 'failed',
        resolvedAt: new Date(now),
        lastError: 'attempts exhausted after an interrupted delivery',
        nextAttemptAt: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        leaseUntil: FieldValue.delete(),
      });
      return;
    }

    if (!isClaimablePrintNotification({
      status: data.status,
      attempts,
      nextAttemptAtMs: toMillis(data.nextAttemptAt),
      leaseUntilMs,
      nowMs: now,
      ignoreSchedule,
    })) return;

    const nextAttempts = attempts + 1;
    const leaseUntil = new Date(now + DELIVERY_LEASE_MS);
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
async function resolveClaim(
  ref: FirebaseFirestore.DocumentReference,
  leaseToken: string,
  patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
): Promise<boolean> {
  let resolved = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.leaseToken !== leaseToken) return;
    tx.update(ref, {
      ...patch,
      leaseToken: FieldValue.delete(),
      leaseUntil: FieldValue.delete(),
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
async function deliverPrintNotification(
  ref: FirebaseFirestore.DocumentReference,
  data: ClaimedOutboxDoc
): Promise<void> {
  let outcome: { ok: boolean; skipped?: boolean; error?: string };
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
  } catch (e: any) {
    outcome = { ok: false, error: String(e?.message || e) };
  }

  try {
    if (outcome.ok) {
      const resolved = await resolveClaim(ref, data.leaseToken, {
        status: outcome.skipped ? 'skipped' : 'sent',
        resolvedAt: new Date(),
        nextAttemptAt: FieldValue.delete(),
        ...(outcome.skipped ? { skipReason: 'no-printer-assigned' } : {}),
      });
      if (!resolved) return;
      logger.info('print-outbox: notification resolved', {
        orderId: data.orderId,
        shopId: data.shopId,
        outcome: outcome.skipped ? 'skipped' : 'sent',
        podLines: data.lines.length,
      });
      return;
    }

    const attempts = Number(data.attempts) || 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const resolved = await resolveClaim(ref, data.leaseToken, {
      status: exhausted ? 'failed' : 'pending',
      lastError: outcome.error?.slice(0, 300) || 'unknown',
      ...(exhausted
        ? { resolvedAt: new Date(), nextAttemptAt: FieldValue.delete() }
        : { nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)) }),
    });
    if (!resolved) return;
    (exhausted ? logger.error : logger.warn).call(logger,
      exhausted
        ? 'print-outbox: notification FAILED permanently (attempts exhausted)'
        : 'print-outbox: delivery attempt failed, will retry',
      { orderId: data.orderId, shopId: data.shopId, attempts, error: outcome.error }
    );
  } catch (stateErr: any) {
    // State write failed AFTER a send may have succeeded — the lease eventually
    // expires and the sweep retries. At-least-once by design: a duplicate
    // printer email is preferable to a lost production notification.
    logger.warn('print-outbox: failed to persist delivery outcome', {
      orderId: data.orderId,
      error: stateErr?.message,
    });
  }
}

export const onOrderProductionReady = onDocumentWritten(
  {
    document: 'orders/{orderId}',
    database: 'b8s-reseller-db',
    region: 'us-central1',
    memory: '256MiB',
    secrets: ['RESEND_API_KEY'],
  },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after) return; // deletion

    const eventShouldNotify = shouldEnqueuePrintNotify(
      before ? String(before.status || '') : null,
      String(after.status || '')
    );
    const eventNeedsSnapshot =
      after.productionSnapshotRequired === true &&
      productionSnapshotLines(after) === null &&
      isPaidLifecycleStatus(String(after.status || ''));
    if (!eventShouldNotify && !eventNeedsSnapshot) {
      return;
    }

    const orderId = event.params.orderId;
    const shopId = String(after.shopId || '').trim();
    if (!shopId) return; // untenanted/sentinel orders have no printer to notify

    // Add-on gate (default-ON): this trigger fires on EVERY shop's every order
    // write, so a pod-disabled shop must be filtered here — mirrors the sweep
    // pattern (product-reviews/checkout-recovery), same predicate everywhere.
    if (!(await isShopFeatureEnabled(shopId, 'pod'))) return;

    // Freeze B2B (and any future) orders that first become production-ready
    // without a snapshot. B2C already snapshots before order creation. The
    // print portal fails closed while productionSnapshotRequired is true and
    // this field is absent, so no printer can race this trigger.
    let productionOrder = after;
    let shouldNotifyCurrentOrder = eventShouldNotify;
    let lines: OutboxDoc['lines'];
    try {
      if (after.productionSnapshotRequired === true && productionSnapshotLines(after) === null) {
        const orderRef = event.data!.after.ref;
        // Eventarc is at-least-once. Freeze exactly once: the transaction winner
        // writes the snapshot; every duplicate uses that same stored value and
        // can never overwrite it with a later mapping/artwork graph.
        await db.runTransaction(async (tx) => {
          const current = await tx.get(orderRef);
          if (!current.exists) return;
          const currentData = current.data() as any;
          shouldNotifyCurrentOrder = shouldEnqueuePrintNotify(null, String(currentData.status || ''));
          const existing = productionSnapshotLines(currentData);
          if (existing !== null) {
            productionOrder = currentData;
            return;
          }
          // If the order left the paid lifecycle before this delayed trigger
          // ran, do not freeze or notify it.
          if (!isPaidLifecycleStatus(String(currentData.status || ''))) {
            productionOrder = currentData;
            shouldNotifyCurrentOrder = false;
            return;
          }
          const candidate = await buildProductionSnapshotInTransaction(currentData, tx);
          tx.update(orderRef, { productionSnapshot: candidate });
          productionOrder = { ...currentData, productionSnapshot: candidate };
          // A delayed paid event may find the order already printed/shipped.
          // Freeze it for historical correctness, but do not notify production
          // after production has already advanced past the notify statuses.
        });
      }
      if (productionSnapshotPending(productionOrder)) return;
      if (!shouldNotifyCurrentOrder) return;
      const mappings = await loadShopMappings(shopId);
      if (!orderHasPodLine(productionOrder, mappings)) return;
      lines = toPrintNotificationLines(productionOrder, mappings);
    } catch (e: any) {
      // Mapping load failed — we cannot even tell whether this is a POD order.
      // Throw so Eventarc retries the event (durability of the ENQUEUE step).
      logger.error('print-outbox: mapping resolution failed, retrying event', {
        orderId,
        shopId,
        error: e?.message,
      });
      throw e;
    }
    if (lines.length === 0) return;

    const ref = db.collection('printNotifications').doc(orderId);
    const outboxDoc: OutboxDoc = {
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
      nextAttemptAt: new Date(Date.now() + INITIAL_SWEEP_DELAY_MS),
    };

    // create() = atomic dedupe (doc id == orderId). ALREADY_EXISTS (code 6)
    // means a concurrent/duplicate event won — benign no-op. Any OTHER create
    // failure throws so the trigger retries: enqueue is the durable step.
    try {
      await ref.create(outboxDoc);
    } catch (createErr: any) {
      if (createErr?.code === 6) return;
      logger.error('print-outbox: enqueue failed, retrying event', {
        orderId,
        error: createErr?.message,
      });
      throw createErr;
    }

    // Inline first attempt — best-effort; the outbox owns retries from here. It
    // ignores only the five-minute schedule grace, never an active lease.
    const claimed = await claimPrintNotification(ref, true);
    if (claimed) await deliverPrintNotification(ref, claimed);
  }
);

export const sweepPrintNotifyOutbox = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 120,
    secrets: ['RESEND_API_KEY'],
  },
  async () => {
    const now = Date.now();

    // ── 1) Retry due events. Terminal resolution removes nextAttemptAt, so this
    // single-field ordered query contains only live work and cannot be starved
    // by an arbitrary first page of future events.
    try {
      const pending = await db
        .collection('printNotifications')
        .where('nextAttemptAt', '<=', new Date(now))
        .orderBy('nextAttemptAt', 'asc')
        .limit(SWEEP_BATCH)
        .get();
      for (const snap of pending.docs) {
        // Each event isolated. The transaction is the concurrency boundary:
        // overlapping sweeps simply fail to claim an already-leased event.
        try {
          // Add-on gate (default-ON), re-checked per retry: a shop's pod flag
          // may have flipped OFF after this event was enqueued (e.g. the
          // shop's original enqueue happened while pod was on). Resolve it
          // 'skipped' rather than retrying forever — mirrors the existing
          // no-printer-assigned skip outcome.
          const docShopId = String((snap.data() as OutboxDoc | undefined)?.shopId || '');
          if (docShopId && !(await isShopFeatureEnabled(docShopId, 'pod'))) {
            await snap.ref.set(
              { status: 'skipped', resolvedAt: new Date(now), skipReason: 'pod-disabled', nextAttemptAt: FieldValue.delete() },
              { merge: true }
            );
            continue;
          }
          const claimed = await claimPrintNotification(snap.ref, false);
          if (claimed) await deliverPrintNotification(snap.ref, claimed);
        } catch (eventErr: any) {
          logger.warn('print-outbox: event attempt failed unexpectedly', {
            orderId: snap.id,
            error: eventErr?.message,
          });
        }
      }
    } catch (e: any) {
      logger.error('print-outbox: sweep retry query failed', { error: e?.message });
    }

    // ── 2) Retention: purge terminal docs older than 60 days. Range on
    // createdAt only (single-field); terminal-ness filtered in code.
    try {
      const cutoff = new Date(now - PURGE_AFTER_DAYS * 86400 * 1000);
      const old = await db
        .collection('printNotifications')
        .where('createdAt', '<=', cutoff)
        .limit(200)
        .get();
      const terminal = old.docs.filter((d) => d.data().status !== 'pending');
      if (terminal.length > 0) {
        const batch = db.batch();
        terminal.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        logger.info('print-outbox: purged terminal events', { count: terminal.length });
      }
    } catch (e: any) {
      logger.warn('print-outbox: retention purge failed', { error: e?.message });
    }
  }
);
