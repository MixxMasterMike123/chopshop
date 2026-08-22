import type { StripeWebhookVerifier, VerifiedStripeEvent } from "./stripe-client";

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
  checkout_id: string;
  currency: string;
  customer_email: string;
  delivery_method: string;
  discount_code_id: string | null;
  discount_minor: number;
  shipping_country: string | null;
  shipping_minor: number;
  status: string;
  subtotal_minor: number;
  tenant_id: string;
  total_minor: number;
  vat_minor: number;
  vat_rate_bp: number;
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
 * The event types this worker acts on.
 *
 * `payment_intent.payment_failed` is deliberately NOT handled and is deliberately
 * NAMED here rather than left to the default branch, because a reader deserves to
 * know it was considered. Production does something real with it: it marks the
 * `checkouts` doc `failed`, and the purpose is the opposite of what the name
 * suggests — it stops the abandoned-cart sweep from mailing a buyer whose card
 * was declined, since "a failed attempt is not an abandoned-but-recoverable cart
 * in the reminder sense". There is no checkout sweep and no abandoned-cart email
 * on this side yet, so a 'failed' transition here would be a status nothing
 * reads, written by the one handler that must stay boringly correct. It becomes
 * a one-line addition the moment the sweep lands.
 */
const HANDLED_EVENT_TYPE = "payment_intent.succeeded";

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
 * Why a delivery produced no order. Enumerated codes, never provider text.
 *
 * These land in `payment_events.reason_code` and are the only explanation an
 * operator gets. They are deliberately coarse — the detail lives in the row's
 * `object_id` and the timestamps — because this table is a ledger, not a log.
 */
export const REASON_UNHANDLED_TYPE = "unhandled_event_type";
export const REASON_UNKNOWN_INTENT = "unknown_payment_intent";
export const REASON_CHECKOUT_NOT_PAYABLE = "checkout_not_payable";
export const REASON_AMOUNT_MISMATCH = "amount_mismatch";
export const REASON_METADATA_MISMATCH = "metadata_mismatch";

export type WebhookOutcome = "processed" | "ignored" | "rejected";

export interface HandleWebhookEventResult {
  outcome: WebhookOutcome;
  /** Present only when this delivery created the order. */
  orderId?: string;
  reasonCode?: string;
  /** True when the event id had already been recorded — a clean replay. */
  replayed: boolean;
}

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
         vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor
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
 * Has this exact event already been recorded?
 *
 * The read is the FAST path, not the guarantee. `payment_events.event_id` is a
 * PRIMARY KEY and the insert rides in the same batch as every effect, so two
 * deliveries racing past this read cannot both commit: one batch wins and the
 * other fails the primary key, whereupon the caller re-reads and answers 200.
 * The read exists so the ordinary duplicate — Stripe re-delivering an event it
 * already delivered successfully — costs one SELECT instead of a failed batch.
 */
async function findRecordedEvent(
  db: D1Database,
  eventId: string,
): Promise<{ outcome: string; reason_code: string | null } | null> {
  return db
    .prepare(
      "SELECT outcome, reason_code FROM payment_events WHERE event_id = ? LIMIT 1",
    )
    .bind(eventId)
    .first<{ outcome: string; reason_code: string | null }>();
}

function recordEventStatement(
  db: D1Database,
  event: VerifiedStripeEvent,
  tenantId: string | null,
  objectId: string | null,
  outcome: WebhookOutcome,
  reasonCode: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO payment_events (
        event_id, tenant_id, provider, event_type, object_id,
        outcome, reason_code, received_at, created_at
      ) VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      tenantId,
      event.type,
      objectId,
      outcome,
      reasonCode,
      now,
      now,
    );
}

/**
 * Whether a batch failed because another delivery got there first.
 *
 * Narrowed to the two constraints that mean exactly that — the event ledger's
 * primary key and the order's one-per-checkout uniqueness — rather than matching
 * any UNIQUE violation. A broad match would swallow a genuine collision, such as
 * the order-number uniqueness this batch also relies on, and report a lost
 * order as a harmless replay. That is the failure a broad `catch` hides best and
 * costs most.
 */
function isDuplicateDelivery(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("UNIQUE constraint failed")) {
    // SQLite reports a primary-key collision on a rowid table this way.
    return message.includes("payment_events.event_id");
  }

  return (
    message.includes("payment_events.event_id") ||
    message.includes("orders.checkout_id") ||
    message.includes("orders.payment_intent_id")
  );
}

/**
 * Records a delivery that produced no order.
 *
 * Its own single-statement write rather than a batch, because there is exactly
 * one statement — and it is still guarded, since two racing duplicate deliveries
 * of an unhandled event would both try to write the ledger row.
 */
async function recordOnly(
  db: D1Database,
  event: VerifiedStripeEvent,
  tenantId: string | null,
  objectId: string | null,
  outcome: WebhookOutcome,
  reasonCode: string,
  now: number,
): Promise<HandleWebhookEventResult> {
  try {
    await recordEventStatement(
      db,
      event,
      tenantId,
      objectId,
      outcome,
      reasonCode,
      now,
    ).run();
  } catch (error) {
    if (!isDuplicateDelivery(error)) {
      throw error;
    }

    return { outcome, reasonCode, replayed: true };
  }

  return { outcome, reasonCode, replayed: false };
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
  metadataCheckoutId: string | null;
  metadataTenantId: string | null;
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
 */
export async function handleStripeWebhookEvent(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
): Promise<HandleWebhookEventResult> {
  // The cheap replay check. An event already in the ledger has already had its
  // effects — whatever they were — and must produce none a second time.
  const recorded = await findRecordedEvent(db, event.id);
  if (recorded !== null) {
    return {
      outcome: recorded.outcome as WebhookOutcome,
      ...(recorded.reason_code === null
        ? {}
        : { reasonCode: recorded.reason_code }),
      replayed: true,
    };
  }

  if (event.type !== HANDLED_EVENT_TYPE) {
    // Acknowledged and recorded, never refused. An event type this worker does
    // not act on is not an error — Stripe endpoints commonly receive more than
    // they subscribe to — and answering 4xx would make Stripe retry it forever.
    return recordOnly(
      db,
      event,
      null,
      null,
      "ignored",
      REASON_UNHANDLED_TYPE,
      now,
    );
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

  // ── ONE BATCH, OR NOTHING ────────────────────────────────────────────────
  // Order, lines, status history, the checkout transition, the discount burn,
  // the audit row and the event ledger row all commit together.
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
          refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
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
      ),
  ];

  for (const item of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO order_items (
            order_item_id, order_id, tenant_id, item_index, product_id,
            variant_id, sku, name, quantity, unit_price_minor,
            line_total_minor, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  // The checkout is spent. Guarded on `status = 'open'` so that if some other
  // path closed it between the read and here, this batch fails rather than
  // reopening a settled question — the same `changes === 0` discipline the
  // payment route uses, enforced here by making the whole batch depend on it.
  //
  // A guarded UPDATE inside a batch cannot report `changes` usefully, so the
  // guard is belt-and-braces behind the order's UNIQUE checkout_id, which is
  // what actually makes a second order impossible.
  statements.push(
    db
      .prepare(
        `UPDATE checkouts
         SET status = 'completed', updated_at = ?
         WHERE checkout_id = ?
           AND tenant_id = ?
           AND status = 'open'`,
      )
      .bind(now, checkout.checkout_id, checkout.tenant_id),
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
    return { outcome: "processed", replayed: true };
  }

  return { orderId, outcome: "processed", replayed: false };
}

/**
 * The verifier seam, re-exported for the route.
 *
 * Kept as a type-only re-export so the route imports its webhook dependencies
 * from one place while the SDK stays behind stripe-client.ts.
 */
export type { StripeWebhookVerifier, VerifiedStripeEvent };
