// Server-only checkout persistence. The immutable production snapshot is a
// REQUIRED payment invariant; abandoned-checkout recovery fields are layered
// onto the same rules-locked doc on a best-effort basis. The sweep (sweep.ts)
// later reminds the buyer if no order materialized.

import { logger } from 'firebase-functions';
import { db } from '../config/database';
import { generateToken } from './tokens';
import type { ProductionSnapshot } from '../print/printProjection';

// Clamp the per-shop reminder delay to a sane window.
const DEFAULT_DELAY_HOURS = 1;
const MIN_DELAY_HOURS = 1;
const MAX_DELAY_HOURS = 24;
const EXPIRY_DAYS = 7;
const PRODUCTION_SNAPSHOT_RETENTION_DAYS = 30;

interface CheckoutItem {
  productId?: string;
  variantSku?: string;
  sku?: string;
  name?: string;
  label?: string;
  price?: number;
  quantity?: number;
}

interface CheckoutTotals {
  subtotal?: number;
  vat?: number;
  shipping?: number;
  discountAmount?: number;
  total?: number;
}

export interface WriteAbandonedCheckoutParams {
  paymentIntentId: string;
  shopId: string;
  customerInfo: {
    email: string;
    name?: string;
    firstName?: string;
    marketing?: boolean;
    remindMe?: boolean;
    preferredLang?: string;
  };
  /** JSON string from createPaymentIntent.buildItemDetailsJson(false). */
  itemsJson: string;
  totals?: CheckoutTotals;
}

/**
 * Persist the immutable production graph before the PaymentIntent client secret
 * is returned. This write is part of payment correctness (not recovery), so its
 * caller must fail checkout if it cannot complete.
 */
export async function writeCheckoutProductionSnapshot(
  paymentIntentId: string,
  shopId: string,
  productionSnapshot: ProductionSnapshot
): Promise<void> {
  const now = new Date();
  await db.collection('checkouts').doc(paymentIntentId).set({
    shopId,
    paymentIntentId,
    productionSnapshotRequired: true,
    productionSnapshot,
    createdAt: now,
    productionSnapshotCreatedAt: now,
    retentionNextAttemptAt: new Date(
      now.getTime() + PRODUCTION_SNAPSHOT_RETENTION_DAYS * 86400 * 1000
    ),
    expiresAt: new Date(now.getTime() + EXPIRY_DAYS * 86400 * 1000),
  }, { merge: true });
}

/**
 * Read a shop's cart-recovery reminder delay (hours), clamped to [1, 24]. Fails
 * open to the default so a transient read error never breaks checkout doc writes.
 */
async function resolveDelayHours(shopId: string): Promise<number> {
  try {
    const snap = await db.collection('shops').doc(shopId).get();
    const raw = (snap.data() as any)?.cartRecovery?.delayHours;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_DELAY_HOURS;
    return Math.min(MAX_DELAY_HOURS, Math.max(MIN_DELAY_HOURS, Math.round(n)));
  } catch {
    return DEFAULT_DELAY_HOURS;
  }
}

/**
 * Write (or overwrite) the abandoned-checkout doc for this PaymentIntent. Keyed
 * on the paymentIntentId so a retried checkout naturally supersedes its own doc.
 */
export async function writeAbandonedCheckoutDoc(params: WriteAbandonedCheckoutParams): Promise<void> {
  const { paymentIntentId, shopId, customerInfo, itemsJson, totals } = params;

  const email = String(customerInfo?.email || '').trim();
  if (!email) {
    logger.warn('checkout-recovery: no email, skipping checkout doc', { paymentIntentId });
    return;
  }
  // emailNorm is REQUIRED — all dedupe/cap/suppression logic keys on it.
  const emailNorm = email.toLowerCase();

  let items: CheckoutItem[] = [];
  try {
    const parsed = JSON.parse(itemsJson);
    if (Array.isArray(parsed)) {
      items = parsed.map((it: any) => ({
        productId: it?.productId || '',
        variantSku: it?.variantSku || '',
        sku: it?.sku || '',
        name: typeof it?.name === 'string' ? it.name : '',
        label: it?.label || '',
        price: Number(it?.price) || 0,
        quantity: Number(it?.quantity) || 1,
      }));
    }
  } catch (e: any) {
    logger.warn('checkout-recovery: could not parse itemsJson', { paymentIntentId, error: e?.message });
  }

  const delayHours = await resolveDelayHours(shopId);
  const now = new Date();
  const remindAt = new Date(now.getTime() + delayHours * 3600 * 1000);
  const expiresAt = new Date(now.getTime() + EXPIRY_DAYS * 86400 * 1000);

  const firstName = String(customerInfo?.firstName || '').trim();
  const language = customerInfo?.preferredLang || 'sv-SE';

  await db.collection('checkouts').doc(paymentIntentId).set({
    shopId,
    paymentIntentId,
    customerEmail: email,
    emailNorm,
    customerName: String(customerInfo?.name || '').trim(),
    customerFirstName: firstName,
    language,
    consent: {
      marketing: customerInfo?.marketing === true,
      remindMe: customerInfo?.remindMe === true,
    },
    items,
    totals: {
      subtotal: Number(totals?.subtotal) || 0,
      vat: Number(totals?.vat) || 0,
      shipping: Number(totals?.shipping) || 0,
      discountAmount: Number(totals?.discountAmount) || 0,
      total: Number(totals?.total) || 0,
    },
    recoveryToken: generateToken(),
    createdAt: now,
    remindAt,
    expiresAt,
    status: 'open',
  }, { merge: true });
}
