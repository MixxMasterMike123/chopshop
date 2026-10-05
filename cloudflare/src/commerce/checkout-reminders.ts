import { ELIGIBLE_PRODUCTS_FROM, publicEligibilityPredicate } from "../catalog/eligibility";
import { printCanvasEnabled } from "../dispatch/print-canvas";
import { deliveryIdFromKey, hashEmailRecipient } from "../email/auth-email-job";
import {
  type CheckoutReminderContent,
  createCheckoutReminderEmailJob,
  isReminderSuppressed,
  linkValidUntilOf,
  MAX_REMINDER_LINES,
  REMINDER_JOB_LIFETIME_MS,
} from "../email/checkout-reminder-email";
import { mailText, realShopAddress } from "../email/order-emails";
import { reminderConsentGiven } from "../legal/consent";
import { readCanonicalOrigins } from "../lib/origins";
import { type Built, deliver, failEmail } from "../outbox/email-effect";
import { nudgeOutbox } from "../outbox/nudge";
import { complete, type EffectContext, type OutboxRunOutcome, outcomeOf, type SqlGuard } from "../outbox/outbox";
import { isFeatureEnabled } from "../platform/tenant-config";
import { shopTakesOrders } from "../storefront/public-storefront";
import { isRecoveryTokenConfigured, mintRecoveryToken } from "./checkout-recovery-token";
import { isStripeConfigured, resolveStripeMoneyGateway, StripeGatewayError } from "./stripe-client";

/**
 * Övergiven kassa on Cloudflare (CP9-AC, migration 0056,
 * docs/cf-port/CP9_AC_REPORT.md): ONE reminder mail to a buyer who reached
 * the payment step and left, only with consent, with a link that rebuilds the
 * cart through the normal path.
 *
 * ── THE DECISION (runCheckoutReminders, one cron step per 15 minutes) ───────
 * Each due checkout is decided ONCE: a `checkout_reminders` row, `queued` (an
 * outbox row in the same batch) or `skipped` with the reason of the first
 * check it failed. The checks, in this fixed order (§4.3):
 *
 *    1 paid             an order exists, or the checkout is no longer open, or
 *                       its intent succeeded
 *    2 feature_off      the platform's add-on (opt-in, AC2)
 *    3 switch_off       the seller's switch, turned on at or before the checkout
 *    4 orders_closed    the shop takes no order now (shopTakesOrders)
 *    5 no_consent       THE consent rule (consent.ts reminderConsentGiven)
 *    6 undeliverable    no mail can be sent to the address (F9)
 *    7 unsubscribed     the address unsubscribed from this shop's reminders
 *    8 superseded       a later checkout of the same address in the shop,
 *                       whatever its state (F3)
 *    9 frequency_cap    a queued reminder to the address within 7 days (AC6;
 *                       the 0056 trigger guards the insert itself)
 *   10 payment_failed   a declined card on this intent (AC9)
 *   11 unavailable      no line of the checkout is buyable now
 *   12 the intent       Stripe, asked last and read only (AC10): sendable only
 *                       while it waits for a payment method or a confirmation
 *
 * A checkout is due from `created_at + delay` (the seller's 1–24 hours) and
 * stops being due 24 hours after that (AC7): it is then never decided. Only a
 * checkout made while the switch was on is ever a candidate (AC3).
 *
 * ── THE MAIL (runCheckoutReminderEmailEffect, outbox `email.checkout_reminder`)
 * Checks 1, 2, 3, 4, 5, 7, 8 and 11 are asked AGAIN under the outbox claim,
 * just before the mail is built; the first that fails withdraws the reminder
 * (`withdrawn`, its reason) and no mail is built. The consent is asked again
 * although it is frozen: the rule is that no reminder is ever built without
 * it. After the job is queued the consumer still refuses an address that
 * unsubscribed meanwhile (email-queue-consumer.ts).
 *
 * ── WHAT NEVER MOVES ─────────────────────────────────────────────────────────
 * Nothing here writes to `checkouts`: the retention sweep's clock and every
 * frozen column stay as they were. The only Stripe call is a read. No buyer
 * address reaches a log, an alert, an outbox payload or a seller surface: the
 * tables hold the address's sha256, the outbox row the reminder id.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** THE cap (AC6): one queued reminder per shop and address per 7 days. = 0056 checkout_reminders_cap. */
export const REMINDER_CAP_MS = 7 * DAY_MS;
/** AC7: a reminder more than this late is never decided. */
export const REMINDER_LATE_LIMIT_MS = DAY_MS;
/** AC11: the resume link works this long after the decision. */
export const REMINDER_LINK_TTL_MS = 7 * DAY_MS;
/** Candidates per tick, oldest first. */
export const REMINDER_BATCH = 25;
/** The candidate read's index range: the longest delay (24 h) plus the late limit. */
const CANDIDATE_WINDOW_MS = 24 * HOUR_MS + REMINDER_LATE_LIMIT_MS;

export const CHECKOUT_REMINDER_EFFECT = "email.checkout_reminder";

export type ReminderReason =
  | "feature_off"
  | "frequency_cap"
  | "intent_gone"
  | "no_consent"
  | "orders_closed"
  | "paid"
  | "payment_failed"
  | "payment_in_progress"
  | "superseded"
  | "switch_off"
  | "unavailable"
  | "undeliverable"
  | "unsubscribed";

const CAP_REFUSAL = "checkout reminder frequency cap";
const UNIQUE_REFUSAL = "UNIQUE constraint failed: checkout_reminders.checkout_id";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The address's sha256 hex, as `hashEmailRecipient` makes it (trimmed, lower
 * case), but for EVERY address the checkout parser accepted: an undeliverable
 * one (no dot after the `@`, F9) still needs a key for its `skipped` row.
 */
async function addressHash(email: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase())));
}

async function isDeliverable(email: string): Promise<boolean> {
  try {
    await hashEmailRecipient(email);
    return true;
  } catch {
    return false;
  }
}

// ── the seller's switch ─────────────────────────────────────────────────────

export interface ReminderSettings {
  delayHours: number;
  enabled: boolean;
  enabledAt: number | null;
  updatedAt: number | null;
}

/** The seller's switch of `tenantId`; no row = off, delay 1 hour. */
export async function readReminderSettings(db: D1Database, tenantId: string): Promise<ReminderSettings> {
  const row = await db
    .prepare(
      `SELECT enabled, delay_hours, enabled_at, updated_at
       FROM checkout_reminder_settings WHERE tenant_id = ? LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ delay_hours: number; enabled: number; enabled_at: number | null; updated_at: number }>();
  return row === null
    ? { delayHours: 1, enabled: false, enabledAt: null, updatedAt: null }
    : { delayHours: row.delay_hours, enabled: row.enabled === 1, enabledAt: row.enabled_at, updatedAt: row.updated_at };
}

// ── the checks shared by the decision and the mail ──────────────────────────

interface CheckoutFacts {
  checkout_id: string;
  consent_json: string | null;
  created_at: number;
  customer_email: string;
  has_order: number;
  payment_intent_id: string | null;
  payment_intent_status: string | null;
  status: string;
}

/** The checkout as it is NOW (tenant-scoped), with whether an order exists for it. */
function readCheckoutFacts(db: D1Database, tenantId: string, checkoutId: string): Promise<CheckoutFacts | null> {
  return db
    .prepare(
      `SELECT c.checkout_id, c.customer_email, c.created_at, c.status, c.payment_intent_id,
              c.payment_intent_status, c.consent_json,
              EXISTS (SELECT 1 FROM orders AS o WHERE o.checkout_id = c.checkout_id) AS has_order
       FROM checkouts AS c
       WHERE c.checkout_id = ? AND c.tenant_id = ?
       LIMIT 1`,
    )
    .bind(checkoutId, tenantId)
    .first<CheckoutFacts>();
}

/**
 * Check 1. An order (also one paid after the sweep), a completed checkout or a
 * succeeded intent is `paid`; any other state than `open` (the sweep marked it
 * abandoned) is `intent_gone`.
 */
function paidVerdict(facts: CheckoutFacts): ReminderReason | null {
  if (facts.has_order === 1 || facts.status === "completed" || facts.payment_intent_status === "succeeded") {
    return "paid";
  }
  return facts.status === "open" ? null : "intent_gone";
}

interface ShopGate {
  addOn: boolean;
  settings: ReminderSettings;
  takesOrders: boolean;
}

async function readShopGate(db: D1Database, tenantId: string, now: number): Promise<ShopGate> {
  const [addOn, settings, takesOrders] = await Promise.all([
    isFeatureEnabled(db, tenantId, "abandonedCheckout"),
    readReminderSettings(db, tenantId),
    shopTakesOrders(db, tenantId, now),
  ]);
  return { addOn, settings, takesOrders };
}

/** Checks 2–4, for a checkout made at `createdAt`. */
function shopVerdict(gate: ShopGate, createdAt: number): ReminderReason | null {
  if (!gate.addOn) {
    return "feature_off";
  }
  if (!gate.settings.enabled || gate.settings.enabledAt === null || createdAt < gate.settings.enabledAt) {
    return "switch_off";
  }
  return gate.takesOrders ? null : "orders_closed";
}

/** Check 8: a later checkout of the same address in the shop, whatever its state or intent. */
async function isSuperseded(db: D1Database, tenantId: string, facts: CheckoutFacts): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM checkouts AS later
       WHERE later.tenant_id = ?
         AND later.customer_email = ?
         AND (later.created_at > ? OR (later.created_at = ? AND later.checkout_id > ?))
       LIMIT 1`,
    )
    .bind(tenantId, facts.customer_email, facts.created_at, facts.created_at, facts.checkout_id)
    .first<{ hit: number }>();
  return row !== null;
}

/** Check 9: a queued reminder to the address in the shop within the cap. */
async function isCapped(db: D1Database, tenantId: string, buyerHash: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM checkout_reminders
       WHERE tenant_id = ? AND buyer_hash = ? AND state = 'queued' AND decided_at > ?
       LIMIT 1`,
    )
    .bind(tenantId, buyerHash, now - REMINDER_CAP_MS)
    .first<{ hit: number }>();
  return row !== null;
}

/** Check 10 (AC9): a declined attempt on this intent (the webhook's ledger). */
async function hasDeclinedAttempt(db: D1Database, tenantId: string, paymentIntentId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM payment_events
       WHERE object_id = ? AND event_type = 'payment_intent.payment_failed'
         AND (tenant_id IS NULL OR tenant_id = ?)
       LIMIT 1`,
    )
    .bind(paymentIntentId, tenantId)
    .first<{ hit: number }>();
  return row !== null;
}

interface BuyableLine {
  item_index: number;
  label: string | null;
  name: string;
  quantity: number;
}

/**
 * Check 11: the lines of the checkout whose product passes THE public
 * predicate now (the canvas's stand-in term while the print canvas is on, as
 * checkout reads it) and whose variant, if any, is active — per line, not
 * all-or-nothing. With the live public name and the variant's label: what the
 * mail lists. No price is read.
 */
async function buyableLines(env: Env, tenantId: string, checkoutId: string): Promise<BuyableLine[]> {
  const rows = await env.DB.prepare(
    `SELECT line.item_index AS item_index, line.quantity AS quantity,
            publication.public_name AS name, variant.label AS label
     ${ELIGIBLE_PRODUCTS_FROM}
     INNER JOIN checkout_items AS line
       ON line.product_id = publication.product_id
      AND line.tenant_id = publication.tenant_id
     LEFT JOIN product_variants AS variant
       ON variant.variant_id = line.variant_id
      AND variant.tenant_id = line.tenant_id
      AND variant.product_id = line.product_id
     WHERE line.checkout_id = ?
       AND line.tenant_id = ?
       AND publication.tenant_id = ?
       AND product.tenant_id = ?
       AND ${publicEligibilityPredicate(printCanvasEnabled(env))}
       AND (line.variant_id IS NULL OR variant.active = 1)
     ORDER BY line.item_index ASC
     LIMIT ${MAX_REMINDER_LINES}`,
  )
    .bind(checkoutId, tenantId, tenantId, tenantId)
    .all<BuyableLine>();
  return rows.results;
}

// ── the decision ────────────────────────────────────────────────────────────

interface Candidate {
  checkout_id: string;
  tenant_id: string;
}

export interface CheckoutReminderSummary {
  /** Why the step did nothing at all, when it did nothing. */
  disabled?: "no_secret" | "no_stripe" | "no_web_origin";
  examined: number;
  queued: number;
  /** Decided by another run meanwhile (the UNIQUE). */
  raced: number;
  /** Left for the next tick (Stripe could not be reached). */
  retried: number;
  skipped: Partial<Record<ReminderReason, number>>;
}

function skippedStatement(
  db: D1Database,
  candidate: Candidate,
  buyerHash: string,
  reason: ReminderReason,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO checkout_reminders (
         reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
         decided_at, link_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'skipped', ?, ?, NULL, ?, ?)
       ON CONFLICT(checkout_id) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), candidate.tenant_id, candidate.checkout_id, buyerHash, reason, now, now, now);
}

/**
 * The write of a reminder (§4.4): the decision and its outbox row in ONE
 * batch. The outbox row holds the reminder id and nothing else (no address, no
 * link). The cap trigger refusing the decision aborts the batch whole; the
 * caller then records `frequency_cap`.
 */
export async function queueReminder(
  db: D1Database,
  candidate: Candidate,
  buyerHash: string,
  now: number,
): Promise<{ kind: "capped" | "raced" } | { kind: "queued"; outboxId: string }> {
  const reminderId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO checkout_reminders (
             reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
             decided_at, link_expires_at, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, ?6, ?5, ?5)`,
        )
        .bind(reminderId, candidate.tenant_id, candidate.checkout_id, buyerHash, now, now + REMINDER_LINK_TTL_MS),
      db
        .prepare(
          `INSERT INTO outbox_events (
             outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
             dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
           )
           SELECT ?1, ?2, ?3, 'checkout_reminder', ?4, ?5, json_object('reminderId', ?4), 'pending', ?6, ?6, ?6
           WHERE EXISTS (SELECT 1 FROM checkout_reminders WHERE reminder_id = ?4 AND state = 'queued')`,
        )
        .bind(outboxId, candidate.tenant_id, CHECKOUT_REMINDER_EFFECT, reminderId, `${CHECKOUT_REMINDER_EFFECT}:${reminderId}`, now),
    ]);
  } catch (error) {
    const message = errorText(error);
    if (message.includes(CAP_REFUSAL)) {
      await skippedStatement(db, candidate, buyerHash, "frequency_cap", now).run();
      return { kind: "capped" };
    }
    if (message.includes(UNIQUE_REFUSAL)) {
      return { kind: "raced" };
    }
    throw error;
  }
  return { kind: "queued", outboxId };
}

/** Stripe's status of the intent → the reason not to send, or null to send. */
function intentVerdict(status: string): ReminderReason | null {
  if (status === "requires_payment_method" || status === "requires_confirmation") {
    return null;
  }
  if (status === "succeeded") {
    return "paid";
  }
  if (status === "canceled") {
    return "intent_gone";
  }
  // processing, requires_capture, requires_action — and any status Stripe adds.
  return "payment_in_progress";
}

function log(fields: Record<string, unknown>): void {
  // Counts and codes only: never an address, a token or a link.
  console.log(JSON.stringify({ message: "checkout reminders", ...fields }));
}

/**
 * THE cron step (§4.2–4.6). At most REMINDER_BATCH candidates, oldest first;
 * every candidate examined gets a row, except while Stripe cannot be reached
 * (it then stays for the next tick and Stripe is not asked again this tick).
 * Does nothing without the secret the links are signed with, the web origin
 * they point at, or Stripe. Throws only on a D1 fault: the next tick retries.
 */
export async function runCheckoutReminders(env: Env, now: number): Promise<CheckoutReminderSummary> {
  const summary: CheckoutReminderSummary = { examined: 0, queued: 0, raced: 0, retried: 0, skipped: {} };
  const disabled = !isRecoveryTokenConfigured(env)
    ? "no_secret"
    : readCanonicalOrigins(env)?.web === undefined
      ? "no_web_origin"
      : !isStripeConfigured(env)
        ? "no_stripe"
        : null;
  if (disabled !== null) {
    summary.disabled = disabled;
    log({ disabled });
    return summary;
  }

  const db = env.DB;
  const candidates = await db
    .prepare(
      `SELECT c.checkout_id, c.tenant_id
       FROM checkouts AS c
       JOIN checkout_reminder_settings AS s ON s.tenant_id = c.tenant_id
       WHERE c.status = 'open'
         AND c.payment_intent_id IS NOT NULL
         AND c.created_at > ?1 - ?2
         AND s.enabled = 1
         AND c.created_at >= s.enabled_at
         AND c.created_at + s.delay_hours * 3600000 <= ?1
         AND c.created_at + s.delay_hours * 3600000 > ?1 - ?3
         AND NOT EXISTS (SELECT 1 FROM checkout_reminders AS r WHERE r.checkout_id = c.checkout_id)
       ORDER BY c.created_at ASC, c.checkout_id ASC
       LIMIT ?4`,
    )
    .bind(now, CANDIDATE_WINDOW_MS, REMINDER_LATE_LIMIT_MS, REMINDER_BATCH)
    .all<Candidate>();

  const gates = new Map<string, ShopGate>();
  const gateOf = async (tenantId: string): Promise<ShopGate> => {
    let gate = gates.get(tenantId);
    if (gate === undefined) {
      gate = await readShopGate(db, tenantId, now);
      gates.set(tenantId, gate);
    }
    return gate;
  };
  const gateway = resolveStripeMoneyGateway(env);
  let stripeReachable = true;
  const outboxIds: string[] = [];
  const skip = async (candidate: Candidate, buyerHash: string, reason: ReminderReason): Promise<void> => {
    await skippedStatement(db, candidate, buyerHash, reason, now).run();
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  for (const candidate of candidates.results) {
    const facts = await readCheckoutFacts(db, candidate.tenant_id, candidate.checkout_id);
    if (facts === null) {
      continue;
    }
    summary.examined += 1;
    const buyerHash = await addressHash(facts.customer_email);
    const tenantId = candidate.tenant_id;

    const paid = paidVerdict(facts);
    if (paid !== null) {
      await skip(candidate, buyerHash, paid);
      continue;
    }
    const shop = shopVerdict(await gateOf(tenantId), facts.created_at);
    if (shop !== null) {
      await skip(candidate, buyerHash, shop);
      continue;
    }
    if (!reminderConsentGiven(facts.consent_json)) {
      await skip(candidate, buyerHash, "no_consent");
      continue;
    }
    if (!(await isDeliverable(facts.customer_email))) {
      await skip(candidate, buyerHash, "undeliverable");
      continue;
    }
    if (await isReminderSuppressed(db, tenantId, buyerHash)) {
      await skip(candidate, buyerHash, "unsubscribed");
      continue;
    }
    if (await isSuperseded(db, tenantId, facts)) {
      await skip(candidate, buyerHash, "superseded");
      continue;
    }
    if (await isCapped(db, tenantId, buyerHash, now)) {
      await skip(candidate, buyerHash, "frequency_cap");
      continue;
    }
    // The candidate read requires an intent; read again, it is still set.
    const paymentIntentId = facts.payment_intent_id as string;
    if (await hasDeclinedAttempt(db, tenantId, paymentIntentId)) {
      await skip(candidate, buyerHash, "payment_failed");
      continue;
    }
    if ((await buyableLines(env, tenantId, candidate.checkout_id)).length === 0) {
      await skip(candidate, buyerHash, "unavailable");
      continue;
    }

    // Check 12, the only network call, made only when everything else passed.
    if (!stripeReachable) {
      summary.retried += 1;
      continue;
    }
    let verdict: ReminderReason | null;
    try {
      verdict = intentVerdict((await gateway.retrievePaymentIntent(paymentIntentId)).status);
    } catch (error) {
      if (error instanceof StripeGatewayError && error.rejected) {
        // Stripe answered and refused: the intent is not there (or not ours).
        verdict = "intent_gone";
      } else {
        // Unknown (network, 5xx, 429): no row, and no more Stripe this tick.
        stripeReachable = false;
        summary.retried += 1;
        continue;
      }
    }
    if (verdict !== null) {
      await skip(candidate, buyerHash, verdict);
      continue;
    }

    const written = await queueReminder(db, candidate, buyerHash, now);
    if (written.kind === "queued") {
      summary.queued += 1;
      outboxIds.push(written.outboxId);
    } else if (written.kind === "capped") {
      summary.skipped.frequency_cap = (summary.skipped.frequency_cap ?? 0) + 1;
    } else {
      summary.raced += 1;
    }
  }

  await nudgeOutbox(env, outboxIds);
  if (summary.examined > 0) {
    log({ ...summary });
  }
  return summary;
}

// ── the mail (outbox `email.checkout_reminder`) ─────────────────────────────

interface ReminderRow {
  buyer_hash: string;
  checkout_id: string;
  link_expires_at: number | null;
  reminder_id: string;
  state: "queued" | "skipped" | "withdrawn";
}

function parseReminderPayload(payloadJson: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.reminderId === "string" ? record.reminderId : null;
}

/**
 * The send-time re-checks (§4.5): 1, 2, 3, 4, 5, 7, 8 and 11, in the
 * decision's order. Returns the reason to withdraw, or the lines to mail.
 */
async function recheck(
  env: Env,
  tenantId: string,
  reminder: ReminderRow,
  facts: CheckoutFacts,
  now: number,
): Promise<{ reason: ReminderReason } | { lines: BuyableLine[] }> {
  const paid = paidVerdict(facts);
  if (paid !== null) {
    return { reason: paid };
  }
  const shop = shopVerdict(await readShopGate(env.DB, tenantId, now), facts.created_at);
  if (shop !== null) {
    return { reason: shop };
  }
  if (!reminderConsentGiven(facts.consent_json)) {
    return { reason: "no_consent" };
  }
  if (await isReminderSuppressed(env.DB, tenantId, reminder.buyer_hash)) {
    return { reason: "unsubscribed" };
  }
  if (await isSuperseded(env.DB, tenantId, facts)) {
    return { reason: "superseded" };
  }
  const lines = await buyableLines(env, tenantId, reminder.checkout_id);
  return lines.length === 0 ? { reason: "unavailable" } : { lines };
}

/**
 * Withdraws a queued reminder and closes its outbox row without a mail, in
 * one batch under the claim. A ledger row an earlier attempt recorded and no
 * consumer has claimed is closed with it, so a job that reached the queue
 * before a crash is refused by the ledger instead of sent.
 */
async function withdraw(
  ctx: EffectContext,
  tenantId: string,
  reminderId: string,
  reason: ReminderReason,
): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const now = ctx.clock();
  const deliveryId = await deliveryIdFromKey(row.dedupe_key);
  const result = await complete(env.DB, claim, {
    now,
    resultRef: null,
    withTransition: (guard: SqlGuard) => [
      env.DB.prepare(
        `UPDATE checkout_reminders
         SET state = 'withdrawn', reason = ?, updated_at = MAX(updated_at, ?)
         WHERE reminder_id = ? AND tenant_id = ? AND state = 'queued' AND ${guard.sql}`,
      ).bind(reason, now, reminderId, tenantId, ...guard.binds),
      env.DB.prepare(
        `UPDATE email_deliveries
         SET status = 'failed', resolved_at = ?, last_error_code = 'E_WITHDRAWN',
             updated_at = MAX(updated_at, ?)
         WHERE delivery_id = ? AND tenant_id = ? AND status = 'pending' AND attempts = 0 AND ${guard.sql}`,
      ).bind(now, now, deliveryId, tenantId, ...guard.binds),
    ],
  });
  return outcomeOf(result, now);
}

const FROZEN_KEY = "checkoutReminder";

function frozenContent(frozenJson: string | null | undefined): Record<string, unknown> | null | undefined {
  if (frozenJson === null || frozenJson === undefined) {
    return undefined;
  }
  try {
    const frozen = JSON.parse(frozenJson) as unknown;
    const part =
      typeof frozen === "object" && frozen !== null ? (frozen as Record<string, unknown>)[FROZEN_KEY] : undefined;
    return typeof part === "object" && part !== null && !Array.isArray(part) ? (part as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The links of a reminder, on the web origin; null when they cannot be made. */
async function linksOf(
  env: Env,
  tenantId: string,
  reminderId: string,
): Promise<Pick<CheckoutReminderContent, "oneClickUnsubscribeUrl" | "resumeUrl" | "unsubscribeUrl"> | null> {
  const web = readCanonicalOrigins(env)?.web;
  const [resume, unsubscribe] = await Promise.all([
    mintRecoveryToken(env, tenantId, reminderId, "resume"),
    mintRecoveryToken(env, tenantId, reminderId, "unsubscribe"),
  ]);
  if (web === undefined || resume === null || unsubscribe === null) {
    return null;
  }
  return {
    oneClickUnsubscribeUrl: new URL(`/_api/${tenantId}/v1/checkout-recovery/${unsubscribe}/unsubscribe`, web).href,
    resumeUrl: new URL(`/${tenantId}/aterta/${resume}`, web).href,
    unsubscribeUrl: new URL(`/${tenantId}/avregistrera/${unsubscribe}`, web).href,
  };
}

/**
 * Builds the reminder's job: frozen at the first build except the
 * recipient's name, which is read live (an outbox row carries no recipient
 * data), as the order mails do.
 */
async function buildReminder(
  ctx: EffectContext,
  tenantId: string,
  reminder: ReminderRow,
  facts: CheckoutFacts,
  lines: BuyableLine[],
): Promise<Built> {
  const { env, row } = ctx;
  const recipientName = mailText(
    (
      await env.DB.prepare("SELECT name FROM checkout_recipients WHERE checkout_id = ? AND tenant_id = ? LIMIT 1")
        .bind(reminder.checkout_id, tenantId)
        .first<{ name: string }>()
    )?.name,
  );
  const frozen = frozenContent(row.frozen_json);
  if (frozen === null) {
    return { error: "invalid_email_content", kind: "fail" };
  }
  let stored: Omit<CheckoutReminderContent, "recipientName">;
  if (frozen !== undefined) {
    stored = frozen as unknown as Omit<CheckoutReminderContent, "recipientName">;
  } else {
    const links = await linksOf(env, tenantId, reminder.reminder_id);
    if (links === null || reminder.link_expires_at === null) {
      return { error: "reminder_links_unavailable", kind: "fail" };
    }
    const shop = await env.DB.prepare("SELECT shop_name, support_email FROM tenants WHERE tenant_id = ? LIMIT 1")
      .bind(tenantId)
      .first<{ shop_name: string | null; support_email: string | null }>();
    stored = {
      items: lines.map((line) => ({
        label: mailText(line.label),
        name: mailText(line.name) ?? "–",
        quantity: line.quantity,
      })),
      linkValidUntil: linkValidUntilOf(reminder.link_expires_at),
      ...links,
      shopName: mailText(shop?.shop_name),
      supportEmail: realShopAddress(shop?.support_email),
    };
  }
  let job;
  try {
    job = createCheckoutReminderEmailJob({
      content: { ...stored, recipientName } as CheckoutReminderContent,
      createdAt: row.created_at,
      deliveryId: await deliveryIdFromKey(row.dedupe_key),
      expiresAt: row.created_at + REMINDER_JOB_LIFETIME_MS,
      recipient: facts.customer_email,
      tenantId,
    });
  } catch {
    return { error: "invalid_email_content", kind: "fail" };
  }
  if (frozen !== undefined) {
    return { freeze: null, job, kind: "built" };
  }
  const { recipientName: _live, ...toFreeze } = job.content;
  return { freeze: JSON.stringify({ [FROZEN_KEY]: toFreeze }), job, kind: "built" };
}

/** The `email.checkout_reminder` effect: re-check, then one mail through the ledger. */
export async function runCheckoutReminderEmailEffect(ctx: EffectContext): Promise<OutboxRunOutcome> {
  const { row } = ctx;
  const reminderId = parseReminderPayload(row.payload_json);
  const subject = `checkout reminder ${reminderId ?? row.aggregate_id}`;
  if (
    reminderId === null ||
    row.tenant_id === null ||
    row.aggregate_type !== "checkout_reminder" ||
    row.aggregate_id !== reminderId
  ) {
    return failEmail(ctx, "invalid_payload", true, subject);
  }
  const tenantId = row.tenant_id;
  const reminder = await ctx.env.DB.prepare(
    `SELECT reminder_id, checkout_id, buyer_hash, state, link_expires_at
     FROM checkout_reminders WHERE reminder_id = ? AND tenant_id = ? LIMIT 1`,
  )
    .bind(reminderId, tenantId)
    .first<ReminderRow>();
  const facts =
    reminder === null ? null : await readCheckoutFacts(ctx.env.DB, tenantId, reminder.checkout_id);
  if (reminder === null || facts === null) {
    return failEmail(ctx, "invalid_payload", true, subject);
  }
  if (reminder.state !== "queued") {
    // Withdrawn by an earlier attempt (or never queued): nothing to mail.
    const now = ctx.clock();
    return outcomeOf(await complete(ctx.env.DB, ctx.claim, { now, resultRef: null }), now);
  }

  const checked = await recheck(ctx.env, tenantId, reminder, facts, ctx.clock());
  if ("reason" in checked) {
    return withdraw(ctx, tenantId, reminderId, checked.reason);
  }
  return deliver(ctx, await buildReminder(ctx, tenantId, reminder, facts, checked.lines), {
    lifetimeMs: REMINDER_JOB_LIFETIME_MS,
    subject,
  });
}
