import { printerJobId } from "../dispatch/snapwear-wire";
import { orderConsentOf } from "../legal/consent";
import { nudgeOutbox } from "../outbox/nudge";
import { initialDispatchAttemptSql } from "./dispatch-hold";
import { raiseAlertStatement } from "./money-alerts";
import type {
  HandleWebhookEventResult,
  WebhookOutcome,
} from "./payment-events";
import {
  findRecordedEvent,
  isDuplicateDelivery,
  REASON_AMOUNT_MISMATCH,
  REASON_DEFERRED_UNTIL_ORDER,
  REASON_CHECKOUT_NOT_PAYABLE,
  REASON_METADATA_MISMATCH,
  REASON_UNKNOWN_INTENT,
  REASON_WRONG_ENDPOINT,
  recordEventStatement,
  recordOnly,
} from "./payment-events";
import { mintReceiptCapability } from "./receipts";
import {
  handleStripeEvent,
  replayDeferredPaymentEvents,
} from "./stripe-events";
import type { StripeWebhookVerifier, VerifiedStripeEvent } from "./stripe-client";

export type { HandleWebhookEventResult, WebhookOutcome };
export {
  REASON_AMOUNT_MISMATCH,
  REASON_CHECKOUT_NOT_PAYABLE,
  REASON_METADATA_MISMATCH,
  REASON_UNHANDLED_TYPE,
  REASON_UNKNOWN_INTENT,
} from "./payment-events";

/**
 * Turning a succeeded PaymentIntent into a durable order, and burning the
 * discount use that paid for it.
 *
 * ── WHAT IS AUTHORITATIVE HERE ───────────────────────────────────────────────
 * The `checkouts` row is. Nothing else.
 *
 * Production reconstructs the entire order from PaymentIntent METADATA
 * (functions/src/payment/stripeWebhook.ts: customerEmail, itemDetails chunked
 * across metadata keys because Stripe caps each value at 500 chars, subtotal,
 * vat, shipping, discount, ...). That is a deliberate divergence here and it was
 * decided one checkpoint earlier: checkpoint 24 put ONLY `{checkout_id,
 * tenant_id}` in metadata precisely so that this handler would have nothing to
 * be tempted by. The intent is found by `payment_intent_id`, which is a UNIQUE
 * column on `checkouts`, and every number written into the order is copied from
 * that row — where the server froze it at quote time under CHECK constraints
 * that make an incoherent total unstorable.
 *
 * The metadata is still compared, as an ASSERTION. If Stripe hands back an
 * intent whose metadata names a different checkout or tenant than the row the
 * intent id resolved to, something is deeply wrong — a hand-edited intent, a
 * key shared with another system, a bug — and the honest answer is to refuse
 * and record, not to pick a winner.
 *
 * ── WHY EVERY FAILURE IS STILL A 200 ─────────────────────────────────────────
 * Stripe retries any non-2xx for days. Production returns 400 when metadata is
 * missing or its item JSON will not parse, which means a buyer who has ALREADY
 * BEEN CHARGED gets no order, and Stripe retries a request that can never
 * succeed until it gives up silently. That failure mode is not imported. Past
 * signature verification, this handler answers 200 to everything it understands
 * and records what it did in `payment_events`, where an operator can find it.
 * The ONLY non-2xx answers are 400 for a signature that does not verify (Stripe's
 * own convention, and a request that failed to prove it came from Stripe is not
 * an event at all) and 500 for a database fault, which is genuinely retryable.
 */

/** The `checkouts` columns this handler needs to build an order. */
interface CheckoutOrderRow {
  /** Frozen by the payment route (0019); NULL on a row that predates it. */
  application_fee_minor: number | null;
  checkout_id: string;
  connect_account_id: string | null;
  /** The buyer's frozen consent (0031); copied onto the order. */
  consent_json: string | null;
  currency: string;
  customer_email: string;
  delivery_method: string;
  discount_code_id: string | null;
  discount_minor: number;
  /** Owned by the POD checkout (CP2-C); copied opaquely onto the order. */
  production_snapshot_json: string | null;
  shipping_country: string | null;
  shipping_minor: number;
  status: string;
  subtotal_minor: number;
  tenant_id: string;
  total_minor: number;
  vat_minor: number;
  vat_rate_bp: number;
  withheld_minor: number | null;
}

interface CheckoutItemSnapshot {
  item_index: number;
  line_total_minor: number;
  name: string;
  product_id: string;
  quantity: number;
  sku: string;
  unit_price_minor: number;
  variant_id: string | null;
}

/**
 * The event this module turns into an order. Every other event type — failed
 * and canceled intents, refunds, disputes, Connect account updates, and
 * anything unknown — is dispatched to stripe-events.ts, which records the fact
 * and never creates an order.
 */
const ORDER_EVENT_TYPE = "payment_intent.succeeded";

/**
 * Statuses a checkout may be in when its payment succeeds.
 *
 * Only 'open'. A 'completed' checkout already has its order — that is the replay
 * path, and it is detected by the order's own UNIQUE constraint rather than by
 * this set. 'expired' and 'abandoned' are interesting: an intent CAN succeed
 * against a checkout whose quote has lapsed, because the buyer held a client
 * secret and Stripe does not know about the expiry. The money is real, so the
 * order is still created — see `resolveOutcome`. What must never happen is a
 * price recomputation at this point, which is why expiry does not appear in the
 * money path at all.
 */
const PAYABLE_CHECKOUT_STATUS = "open";

/**
 * The one status an order is born in.
 *
 * Production writes 'confirmed' here. The vocabulary diverges deliberately: the
 * data model's proposed graph makes `paid` the state that means "money has
 * moved and nothing has been done about it yet", and prod's own status set uses
 * `paid` as well (the audit's `partially_refunded` work sits beside it). Naming
 * the money state after the money is what lets a later fulfilment checkpoint add
 * `processing`/`printed` without the first transition being ambiguous.
 */
const INITIAL_ORDER_STATUS = "paid";


/**
 * Order numbers.
 *
 * Production builds `${prefix}-${last 6 digits of Date.now()}-${4 random base36}`
 * with NO uniqueness check against the database. The truncated timestamp wraps
 * every ~16.7 minutes, so its collision space is really just the four random
 * characters — about 1.7 million — and nothing catches a collision if it happens.
 *
 * This generator is fully random over a much larger space AND the column is
 * `UNIQUE (tenant_id, order_number)`, so a collision is a loud failure of the
 * batch rather than two orders sharing a reference. The date component is kept
 * because merchants read these aloud to customers and a date is genuinely useful
 * to them; it is not load-bearing for uniqueness.
 *
 * Crockford-style alphabet without I/L/O/U: these are read over the phone and
 * typed back into a support form.
 */
const ORDER_NUMBER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ORDER_NUMBER_RANDOM_LENGTH = 8;

export function generateOrderNumber(now: number): string {
  const date = new Date(now);
  const year = date.getUTCFullYear().toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");

  // crypto.getRandomValues, not Math.random: this is a customer-facing reference
  // that appears in emails and support tickets, and a predictable one would let
  // an outsider guess a neighbouring order's reference.
  const bytes = crypto.getRandomValues(
    new Uint8Array(ORDER_NUMBER_RANDOM_LENGTH),
  );
  let token = "";
  for (const byte of bytes) {
    // 32-character alphabet, so the low 5 bits are used and the mapping is
    // uniform — no modulo bias.
    token += ORDER_NUMBER_ALPHABET[byte % ORDER_NUMBER_ALPHABET.length];
  }

  return `${year}${month}${day}-${token}`;
}

/**
 * Finds the checkout an intent paid for.
 *
 * By `payment_intent_id`, which is UNIQUE — so this is a point lookup that
 * cannot return the wrong row, and there is no tenant predicate to add because
 * the row itself is where the tenant comes from. That is the inversion this
 * whole handler rests on: on the buyer-facing routes the hostname decides the
 * tenant and the row must match it, whereas here Stripe is the caller, there is
 * no storefront hostname, and the row is the only thing that knows whose money
 * this is.
 */
async function loadCheckoutByIntent(
  db: D1Database,
  paymentIntentId: string,
): Promise<CheckoutOrderRow | null> {
  return db
    .prepare(
      `SELECT
         checkout_id, tenant_id, status, customer_email, currency,
         delivery_method, shipping_country, subtotal_minor, shipping_minor,
         vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
         connect_account_id, application_fee_minor, withheld_minor,
         production_snapshot_json, consent_json
       FROM checkouts
       WHERE payment_intent_id = ?
       LIMIT 1`,
    )
    .bind(paymentIntentId)
    .first<CheckoutOrderRow>();
}

async function loadCheckoutItems(
  db: D1Database,
  tenantId: string,
  checkoutId: string,
): Promise<CheckoutItemSnapshot[]> {
  const items = await db
    .prepare(
      `SELECT
         item_index, product_id, variant_id, sku, name,
         quantity, unit_price_minor, line_total_minor
       FROM checkout_items
       WHERE tenant_id = ?
         AND checkout_id = ?
       ORDER BY item_index ASC`,
    )
    .bind(tenantId, checkoutId)
    .all<CheckoutItemSnapshot>();

  return items.results;
}

/**
 * The PaymentIntent fields this handler reads off a verified event.
 *
 * Narrow on purpose, and narrowed by SHAPE rather than by trusting Stripe's
 * type: the event arrives as parsed JSON, and a field that is missing or of the
 * wrong type must be a refusal rather than a `NaN` finding its way into a money
 * column.
 */
interface WebhookIntent {
  amount: number;
  currency: string;
  id: string;
  /** The charge that paid it (`latest_charge`, an id or an expanded object). */
  latestChargeId: string | null;
  metadataCheckoutId: string | null;
  metadataTenantId: string | null;
}

/** A Stripe object id of the conventional shape, else null. */
function stripeIdOrNull(value: unknown): string | null {
  const id =
    typeof value === "object" && value !== null
      ? (value as { id?: unknown }).id
      : value;
  return typeof id === "string" && /^[A-Za-z0-9_]{3,255}$/.test(id) ? id : null;
}

function readIntent(event: VerifiedStripeEvent): WebhookIntent | null {
  const object = event.data.object;
  if (typeof object !== "object" || object === null) {
    return null;
  }

  const candidate = object as Record<string, unknown>;
  const id = candidate.id;
  const amount = candidate.amount;
  const currency = candidate.currency;

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    typeof currency !== "string"
  ) {
    return null;
  }

  const rawMetadata = candidate.metadata;
  const metadata =
    typeof rawMetadata === "object" && rawMetadata !== null
      ? (rawMetadata as Record<string, unknown>)
      : {};

  return {
    amount,
    currency,
    id,
    latestChargeId: stripeIdOrNull(candidate.latest_charge),
    metadataCheckoutId:
      typeof metadata.checkout_id === "string" ? metadata.checkout_id : null,
    metadataTenantId:
      typeof metadata.tenant_id === "string" ? metadata.tenant_id : null,
  };
}

/**
 * Handles one verified Stripe event.
 *
 * The caller has already proven the request came from Stripe; this function
 * decides what it means and makes it durable. It answers with an outcome rather
 * than a Response so the routing layer owns the HTTP shape — and so that every
 * path through here is testable without a Request.
 *
 * `env`, when given (the route always gives it), is used for ONE thing: after
 * a new order's batch has committed, its dispatch + email outbox rows are
 * nudged onto OUTBOX_QUEUE so the printer and the buyer hear within seconds
 * rather than at the next 15-minute sweep. The nudge never throws and never
 * decides anything — the rows are the truth and the sweeper the backstop.
 */
export async function handleStripeWebhookEvent(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
  env?: Env,
): Promise<HandleWebhookEventResult> {
  // The cheap replay check. An event already in the ledger has already had its
  // effects — whatever they were — and must produce none a second time.
  const recorded = await findRecordedEvent(db, event.id);
  if (recorded !== null) {
    if (event.type === ORDER_EVENT_TYPE) {
      // A redelivered success: its first delivery may have committed the
      // order and died before replaying facts parked for it.
      await replayDeferredSafely(db, readIntent(event)?.id ?? null, now);
    } else if (recorded.reason_code === REASON_DEFERRED_UNTIL_ORDER) {
      // A redelivered PARKED event (refund/dispute that came before its
      // order): Stripe retrying it is one more chance to apply it, so a
      // replay that failed elsewhere is retried here too.
      const parked = await db
        .prepare(
          "SELECT payment_intent_id FROM deferred_payment_events WHERE event_id = ? LIMIT 1",
        )
        .bind(event.id)
        .first<{ payment_intent_id: string }>();
      await replayDeferredSafely(db, parked?.payment_intent_id ?? null, now);
    }

    return {
      outcome: recorded.outcome as WebhookOutcome,
      ...(recorded.reason_code === null
        ? {}
        : { reasonCode: recorded.reason_code }),
      replayed: true,
    };
  }

  // The Connect endpoint (connect: true) exists for connected accounts'
  // `account.updated`. Anything else it delivers — a connected account's own
  // charges or refunds — is not this platform's money: acknowledged, recorded,
  // never acted on.
  if (event.endpoint === "connect" && event.type !== "account.updated") {
    return recordOnly(db, event, null, null, "ignored", REASON_WRONG_ENDPOINT, now);
  }

  if (event.type !== ORDER_EVENT_TYPE) {
    // Every other type: failed/canceled intents, refunds, disputes, Connect
    // account updates — and anything unknown, which is acknowledged and
    // recorded, never refused (a 4xx would make Stripe retry it forever).
    return handleStripeEvent(db, event, now);
  }

  const intent = readIntent(event);
  if (intent === null) {
    // A succeeded event whose payload does not carry a readable intent. Recorded
    // as REJECTED rather than ignored: this is not a shape this worker expects,
    // and an operator should see it.
    return recordOnly(
      db,
      event,
      null,
      null,
      "rejected",
      REASON_UNKNOWN_INTENT,
      now,
    );
  }

  const checkout = await loadCheckoutByIntent(db, intent.id);
  if (checkout === null) {
    // An intent nobody here claims. This is NORMAL when one Stripe account is
    // shared — another integration's intents arrive at this endpoint too — so it
    // is 'ignored' rather than 'rejected', and it is acknowledged so Stripe
    // stops delivering it.
    return recordOnly(
      db,
      event,
      null,
      intent.id,
      "ignored",
      REASON_UNKNOWN_INTENT,
      now,
    );
  }

  // ── THE MONEY CHECK ──────────────────────────────────────────────────────
  // What Stripe captured must be what the server froze. They are compared as
  // integers in the same minor units, with no tolerance.
  //
  // Production compares too, but its response is the opposite: on a difference
  // greater than 0.1 SEK it logs and then STAMPS THE CHARGED AMOUNT as the
  // order's total, leaving the subtotal/vat/shipping breakdown untouched and
  // therefore no longer summing to that total. That produces an order whose own
  // arithmetic is inconsistent — and this schema could not store one even if
  // this code tried, because the totals CHECK is a constraint.
  //
  // So the answer here is to refuse: no order, no used_count burn, and a
  // 'rejected' ledger row naming the mismatch. A disagreement between the
  // captured amount and the frozen total is not a rounding artifact — the amount
  // was sent to Stripe FROM this row and neither side rounds — so it means
  // account-level tampering, a shared idempotency key, or a version drift that
  // changed a field's shape. Every one of those needs a human, and a
  // silently-created order would deny them the signal. The buyer's money is not
  // lost: the charge exists at Stripe and is refundable from the dashboard,
  // which is the correct place to resolve a payment nobody can explain.
  const currencyMatches =
    intent.currency.toLowerCase() === checkout.currency.toLowerCase();
  if (intent.amount !== checkout.total_minor || !currencyMatches) {
    return recordOnly(
      db,
      event,
      checkout.tenant_id,
      intent.id,
      "rejected",
      REASON_AMOUNT_MISMATCH,
      now,
    );
  }

  // The metadata assertion. Checkpoint 24 wrote exactly these two keys, so a
  // disagreement means the intent is not the one this worker created for this
  // checkout. It is a consistency check and NOT a lookup — the row was already
  // found by the unique intent id — which is why it can be this strict without
  // making metadata authoritative for anything.
  if (
    intent.metadataCheckoutId !== checkout.checkout_id ||
    intent.metadataTenantId !== checkout.tenant_id
  ) {
    return recordOnly(
      db,
      event,
      checkout.tenant_id,
      intent.id,
      "rejected",
      REASON_METADATA_MISMATCH,
      now,
    );
  }

  // A checkout that is not open has either already been turned into an order —
  // in which case the ledger read above would normally have caught the replay,
  // but a DIFFERENT event id for the same intent must still not create a second
  // order — or was swept dead. Either way this delivery makes no order.
  //
  // Note what is NOT checked: `expires_at`. An intent can succeed after the
  // quote lapsed, because the buyer held a client secret the whole time and
  // Stripe never heard about the expiry. The money is real; refusing the order
  // would leave a paid buyer with nothing. The frozen total is what gets charged
  // and what gets stored, so honouring a lapsed quote costs the merchant exactly
  // the price they themselves quoted.
  if (checkout.status !== PAYABLE_CHECKOUT_STATUS) {
    return recordOnly(
      db,
      event,
      checkout.tenant_id,
      intent.id,
      "ignored",
      REASON_CHECKOUT_NOT_PAYABLE,
      now,
    );
  }

  const items = await loadCheckoutItems(
    db,
    checkout.tenant_id,
    checkout.checkout_id,
  );

  const orderId = crypto.randomUUID();
  const orderNumber = generateOrderNumber(now);

  // The frozen production snapshot, copied OPAQUELY (the shape is the POD
  // checkout's contract): the whole object onto the order, each `lines[]`
  // entry onto its order line (lineNo = item_index + 1), and one dispatch
  // outbox row per line. A snapshot this handler cannot read is NOT a reason to
  // refuse a paid order — the order is created without it and an alert in the
  // same batch tells a human the lines were not queued for the printer.
  const production = readProductionSnapshot(
    checkout.production_snapshot_json,
    new Set(items.map((item) => item.item_index + 1)),
  );

  // The buyer's receipt capability (src/commerce/receipts.ts): its hash and
  // expiry ride on the order row, and the raw token is parked for exactly one
  // hand-off to the confirmation poll. Minted here, in the order's own batch,
  // so there is never an order without a capability or a capability without
  // an order — and a rolled-back delivery leaves neither behind.
  const receipt = await mintReceiptCapability(now);

  // The buyer's consent (src/legal/consent.ts), copied from the checkout: the
  // frozen facts verbatim, and is_personalized = a withdrawal right was waived.
  const consent = orderConsentOf(checkout.consent_json);

  // ── ONE BATCH, OR NOTHING ────────────────────────────────────────────────
  // Order, receipt hand-off, lines, status history, the checkout transition,
  // the discount burn, the audit row and the event ledger row all commit
  // together.
  //
  // This is the checkpoint's central correctness claim and the one place it
  // beats production outright. There, `orderRef.create()` is followed by four
  // independent best-effort writes, and a crash between the create and the
  // discount increment loses that increment PERMANENTLY: Stripe's retry
  // short-circuits at the "order already exists" check and nothing ever
  // reconciles the counter. Folding every effect into one D1 batch makes that
  // window not merely small but nonexistent.
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO orders (
          order_id, tenant_id, checkout_id, payment_intent_id, order_number,
          status, customer_email, currency, delivery_method, shipping_country,
          subtotal_minor, shipping_minor, vat_minor, vat_rate_bp,
          discount_minor, discount_code_id, total_minor, captured_minor,
          refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at,
          receipt_token_hash, receipt_token_expires_at,
          charged_minor, application_fee_minor, withheld_minor,
          connect_account_id, stripe_charge_id, production_snapshot_json,
          payout_state, consent_json, is_personalized
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        orderId,
        checkout.tenant_id,
        checkout.checkout_id,
        intent.id,
        orderNumber,
        INITIAL_ORDER_STATUS,
        checkout.customer_email,
        checkout.currency,
        checkout.delivery_method,
        checkout.shipping_country,
        checkout.subtotal_minor,
        checkout.shipping_minor,
        checkout.vat_minor,
        checkout.vat_rate_bp,
        checkout.discount_minor,
        checkout.discount_code_id,
        checkout.total_minor,
        // Equal to the total by construction — the amount check above has
        // already proven Stripe captured exactly this. Stored separately anyway,
        // because "what we quoted" and "what was captured" are different facts
        // that a partial-capture flow would eventually separate.
        checkout.total_minor,
        event.id,
        now,
        now,
        now,
        receipt.tokenHash,
        receipt.expiresAt,
        // The money facts payouts and refunds run on, frozen here. The charge
        // equals the total (the amount check above proved it). The fee and the
        // withholding are the ones the intent was CREATED with, frozen on the
        // checkout by the payment route; a checkout that predates that (no
        // Connect facts) records 0 and no destination, which is the truth.
        checkout.total_minor,
        checkout.application_fee_minor ?? 0,
        checkout.withheld_minor ?? 0,
        checkout.connect_account_id,
        intent.latestChargeId,
        production.status === "ok" ? production.json : null,
        consent.consentJson,
        consent.isPersonalized,
      ),
    db
      .prepare(
        `INSERT INTO order_receipt_handoffs (
          checkout_id, tenant_id, order_id, receipt_token, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        checkout.checkout_id,
        checkout.tenant_id,
        orderId,
        receipt.token,
        receipt.handoffExpiresAt,
        receipt.handoffCreatedAt,
      ),
  ];

  for (const item of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO order_items (
            order_item_id, order_id, tenant_id, item_index, product_id,
            variant_id, sku, name, quantity, unit_price_minor,
            line_total_minor, created_at, updated_at, production_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          checkout.tenant_id,
          item.item_index,
          item.product_id,
          item.variant_id,
          item.sku,
          item.name,
          item.quantity,
          item.unit_price_minor,
          item.line_total_minor,
          now,
          now,
          production.status === "ok"
            ? (production.lines.get(item.item_index + 1) ?? null)
            : null,
        ),
    );
  }

  // The birth transition. from_status is NULL: the order came from nothing.
  statements.push(
    db
      .prepare(
        `INSERT INTO order_status_history (
          history_id, order_id, tenant_id, from_status, to_status,
          actor_user_id, reason, created_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, 'stripe.payment_intent.succeeded', ?)`,
      )
      .bind(
        crypto.randomUUID(),
        orderId,
        checkout.tenant_id,
        INITIAL_ORDER_STATUS,
        now,
      ),
  );

  // ── THE OUTBOX (PLAN §2.2) ───────────────────────────────────────────────
  // Every external effect this order causes is a row in the SAME batch, so an
  // order can never exist without its effects queued, nor an effect without
  // its order. The consumer (src/outbox, src/dispatch) claims them; nothing
  // here performs them.
  //   dispatch  one per production line, with the stable printer job id
  //             `{orderId}-{lineNo}` so a resubmission is deduplicated by the
  //             printer. Only when there is a snapshot.
  //   email     the order confirmation, one per order.
  // The ids of the rows this batch inserts: nudged once it has committed.
  const outboxIds: string[] = [];
  if (production.status === "ok") {
    for (const lineNo of production.lines.keys()) {
      statements.push(
        outboxStatement(db, outboxIds, {
          aggregateId: orderId,
          dedupeKey: `dispatch:${orderId}:${lineNo}`,
          eventType: "dispatch",
          // HELD (dispatch-hold.ts) when a refund or dispute for this intent
          // was parked before the order existed: the job may not go out
          // until that fact is applied, whatever runs first.
          held: { orderId },
          now,
          // Key order as the shared contract writes it.
          payload: { orderId, lineNo, jobId: printerJobId(orderId, lineNo) },
          tenantId: checkout.tenant_id,
        }),
      );
    }
  } else if (production.status === "invalid") {
    statements.push(
      raiseAlertStatement(
        db,
        {
          kind: "production_snapshot_invalid",
          message: `order ${orderId}: the checkout's production snapshot could not be read; no dispatch was queued`,
          resourceId: orderId,
          resourceType: "order",
          severity: "critical",
          tenantId: checkout.tenant_id,
        },
        now,
      ),
    );
  }

  statements.push(
    outboxStatement(db, outboxIds, {
      aggregateId: orderId,
      dedupeKey: `email:order_confirmation:${orderId}`,
      eventType: "email",
      now,
      payload: { orderId, kind: "order_confirmation" },
      tenantId: checkout.tenant_id,
    }),
  );

  // The checkout is spent. Guarded on `status = 'open'` so that if some other
  // path closed it between the read and here, this batch fails rather than
  // reopening a settled question — the same `changes === 0` discipline the
  // payment route uses, enforced here by making the whole batch depend on it.
  //
  // A guarded UPDATE inside a batch cannot report `changes` usefully, so the
  // guard is belt-and-braces behind the order's UNIQUE checkout_id, which is
  // what actually makes a second order impossible.
  //
  // The intent's terminal state is recorded with it: the retention sweep reads
  // it (a succeeded intent's checkout is never canceled, only purged once the
  // order holds its snapshot).
  statements.push(
    db
      .prepare(
        `UPDATE checkouts
         SET status = 'completed',
             payment_intent_status = 'succeeded',
             payment_intent_status_at = ?,
             updated_at = ?
         WHERE checkout_id = ?
           AND tenant_id = ?
           AND status = 'open'`,
      )
      .bind(now, now, checkout.checkout_id, checkout.tenant_id),
  );

  // ── THE DISCOUNT BURN ────────────────────────────────────────────────────
  // Against the checkout's FROZEN `discount_code_id` and nothing else. Not the
  // code string the buyer typed, not a fresh lookup — the id that was resolved
  // and frozen when the quote was made, so a merchant renaming or deleting the
  // code afterwards cannot redirect the burn.
  //
  // A checkout with no frozen id burns nothing, and that includes the case
  // checkpoint 22 pinned deliberately: a code that resolved but was worth ZERO
  // against this basket stores NO id. Production would freeze the id beside a 0
  // discount and let its webhook burn a use on a code that discounted nothing —
  // judged a latent prod bug and not imported.
  //
  // The UPDATE is unconditional in `used_count` but scoped by tenant, and it
  // deliberately does NOT re-check `max_uses`. Eligibility was decided at quote
  // time; refusing to count a use now would leave a paid order whose discount is
  // unaccounted for, which is worse than a counter that can exceed its cap when
  // several buyers hold client secrets at once. Production has the same
  // over-redemption property, for the same reason, and it is the correct
  // trade — an over-redeemed campaign is a merchant's problem, a paid order that
  // silently failed to record its redemption is an accounting one.
  if (checkout.discount_code_id !== null) {
    statements.push(
      db
        .prepare(
          `UPDATE discount_codes
           SET used_count = used_count + 1, updated_at = ?
           WHERE discount_code_id = ?
             AND tenant_id = ?`,
        )
        .bind(now, checkout.discount_code_id, checkout.tenant_id),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, request_id, metadata_json, created_at
        ) VALUES (?, ?, NULL, 'order.create', 'order', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        checkout.tenant_id,
        orderId,
        // The Stripe event id is the request identity here: it is what an
        // operator would correlate against, and it is not personal data.
        event.id,
        // Counts and the intent id only — no email, no line names, no address.
        // The order row holds all of that already, under the tenant's own
        // access controls; an audit row is not a second copy of the customer.
        JSON.stringify({ items: items.length, paymentIntentId: intent.id }),
        now,
      ),
  );

  statements.push(
    recordEventStatement(
      db,
      event,
      checkout.tenant_id,
      intent.id,
      "processed",
      null,
      now,
    ),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (!isDuplicateDelivery(error)) {
      // A real database fault. It must surface, so the route answers 500 and
      // Stripe retries — which is exactly right, because nothing was committed.
      throw error;
    }

    // Another delivery of this event, or another event for this same checkout,
    // committed first. Nothing of this batch landed — D1 batches are atomic — so
    // there is no partial state to repair, and the honest answer is a 200 that
    // says the work is already done.
    await replayDeferredSafely(db, intent.id, now);
    return { outcome: "processed", replayed: true };
  }

  // Refunds and disputes that arrived before this order (Stripe does not
  // deliver in order) were parked; they apply now, before anything else
  // happens to the order — a full refund supersedes its dispatch here.
  await replayDeferredSafely(db, intent.id, now);

  // The order is committed: tell the outbox consumer its rows exist (PLAN
  // §2.2). After the replay, so a dispatch a parked full refund superseded is
  // simply acked. nudgeOutbox never throws; a lost nudge is the sweeper's.
  if (env !== undefined) {
    await nudgeOutbox(env, outboxIds);
  }
  return { orderId, outcome: "processed", replayed: false };
}

/**
 * The order is committed whatever happens here, so a failed replay must not
 * turn the delivery into a 500: the parked facts stay unapplied and the next
 * redelivery or reconciliation run (every 15 minutes) replays them.
 */
async function replayDeferredSafely(
  db: D1Database,
  paymentIntentId: string | null,
  now: number,
): Promise<void> {
  if (paymentIntentId === null) {
    return;
  }

  try {
    await replayDeferredPaymentEvents(db, paymentIntentId, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "unknown",
        message: "deferred payment events could not be replayed yet",
      }),
    );
  }
}

type ProductionSnapshotRead =
  | { json: string; lines: Map<number, string>; status: "ok" }
  | { status: "absent" }
  | { status: "invalid" };

const MAX_SNAPSHOT_BYTES = 262_144;
const MAX_LINE_BYTES = 65_536;

/**
 * Reads the checkout's production snapshot just far enough to copy it:
 * an object with a `lines` array whose entries are objects carrying a unique
 * integer `lineNo` that names one of the order's lines (item_index + 1).
 * Everything else about a line is the POD checkout's business and is copied
 * verbatim. Bounded by the order columns' own CHECKs, so a snapshot this
 * accepts can never make the order batch abort, and every dispatch row it
 * yields points at a line that exists.
 */
function readProductionSnapshot(
  json: string | null,
  orderLineNos: ReadonlySet<number>,
): ProductionSnapshotRead {
  if (json === null) {
    return { status: "absent" };
  }

  if (json.length > MAX_SNAPSHOT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { status: "invalid" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid" };
  }

  const rawLines = (parsed as { lines?: unknown }).lines;
  if (!Array.isArray(rawLines)) {
    return { status: "invalid" };
  }

  const lines = new Map<number, string>();
  for (const line of rawLines) {
    if (typeof line !== "object" || line === null || Array.isArray(line)) {
      return { status: "invalid" };
    }

    const lineNo = (line as { lineNo?: unknown }).lineNo;
    if (
      typeof lineNo !== "number" ||
      !Number.isSafeInteger(lineNo) ||
      !orderLineNos.has(lineNo) ||
      lines.has(lineNo)
    ) {
      return { status: "invalid" };
    }

    const lineJson = JSON.stringify(line);
    if (lineJson.length > MAX_LINE_BYTES) {
      return { status: "invalid" };
    }

    lines.set(lineNo, lineJson);
  }

  return { json, lines, status: "ok" };
}

/**
 * One `outbox_events` row, in the shared column contract (0001 + 0021): the
 * consumer owns everything after `pending`.
 */
function outboxStatement(
  db: D1Database,
  /** Collects the new row's id (for the post-commit nudge). */
  ids: string[],
  row: {
    aggregateId: string;
    dedupeKey: string;
    eventType: "dispatch" | "email";
    /** Insert held when the order has unsettled payment facts. */
    held?: { orderId: string };
    now: number;
    payload: Record<string, unknown>;
    tenantId: string;
  },
): D1PreparedStatement {
  const nextAttempt = row.held === undefined ? "?" : initialDispatchAttemptSql();
  const nextAttemptBinds =
    row.held === undefined ? [row.now] : [row.held.orderId, row.held.orderId, row.now];
  const outboxId = crypto.randomUUID();
  ids.push(outboxId);
  return db
    .prepare(
      `INSERT INTO outbox_events (
        outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
        dedupe_key, payload_json, status, next_attempt_at, created_at,
        updated_at
      ) VALUES (?, ?, ?, 'order', ?, ?, ?, 'pending', ${nextAttempt}, ?, ?)`,
    )
    .bind(
      outboxId,
      row.tenantId,
      row.eventType,
      row.aggregateId,
      row.dedupeKey,
      JSON.stringify(row.payload),
      ...nextAttemptBinds,
      row.now,
      row.now,
    );
}

/**
 * The verifier seam, re-exported for the route.
 *
 * Kept as a type-only re-export so the route imports its webhook dependencies
 * from one place while the SDK stays behind stripe-client.ts.
 */
export type { StripeWebhookVerifier, VerifiedStripeEvent };
