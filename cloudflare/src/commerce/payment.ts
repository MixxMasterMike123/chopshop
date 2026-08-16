import type { TenantContext } from "../tenancy/resolve-tenant";
import type { PaymentIntentView, StripeGateway } from "./stripe-client";
import { StripeGatewayError } from "./stripe-client";

/**
 * PaymentIntent statuses from which a buyer can never complete this purchase.
 *
 * `canceled` is Stripe's terminal state; `succeeded` means the money already
 * moved and re-handing out a client secret would invite a second confirmation
 * attempt against a paid intent. Everything else — requires_payment_method,
 * requires_confirmation, requires_action, processing, requires_capture — is a
 * live intent whose client secret is exactly what the buyer needs.
 *
 * Deliberately an allowlist of DEAD states rather than of live ones: a Stripe
 * upgrade that introduces a new intermediate status should keep working, while
 * a new terminal status is a deliberate addition here.
 */
const TERMINAL_INTENT_STATUSES: ReadonlySet<string> = new Set([
  "canceled",
  "succeeded",
]);

export interface CheckoutPaymentRow {
  currency: string;
  expires_at: number;
  payment_intent_id: string | null;
  status: string;
  total_minor: number;
}

export interface PaymentIntentResult {
  clientSecret: string;
  created: boolean;
  paymentIntentId: string;
}

/**
 * Each failure is its own member rather than one arm with a union of status
 * strings, so narrowing on `status` actually narrows the shape at every call
 * site instead of only ruling one string out of a member that stays failure-
 * shaped either way.
 */
export type CreateCheckoutPaymentResult =
  | { result: PaymentIntentResult; status: "ok" }
  | { status: "gateway_error" }
  | { status: "not_available" };

/**
 * Runs one gateway call and guarantees that ANY failure it raises becomes a
 * StripeGatewayError.
 *
 * The real client already wraps its own failures, so this is belt-and-braces —
 * but the distinction the caller needs is "did the third party fail" versus
 * "did OUR database fail", and that distinction is a property of WHERE the call
 * happens, not of which error class happens to come back. Deciding it by
 * instanceof made the contract implicit: any gateway implementation that threw
 * something else — a fake, a future minimal REST client, an SDK that changed its
 * error class on upgrade — would have its failure rethrown as a worker
 * exception and answer 500 instead of the opaque 502 this path promises.
 *
 * D1 calls are deliberately OUTSIDE this wrapper, so a database fault still
 * surfaces as the real defect it is rather than being mislabelled as Stripe
 * being down.
 */
async function callGateway<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StripeGatewayError) {
      throw error;
    }

    throw new StripeGatewayError();
  }
}

/**
 * The Stripe idempotency key for a checkout's one and only PaymentIntent.
 *
 * Deterministic in the checkout id and nothing else, which is what makes the
 * race safe: two concurrent requests for the same checkout present the same key
 * to Stripe, and Stripe returns the SAME intent to both rather than minting two.
 * Without it the guarded UPDATE below would still keep D1 consistent, but the
 * loser's intent would already exist at Stripe as an orphan nobody can ever
 * cancel — a real money-state artifact, not merely a wasted call.
 *
 * The checkout id is a random UUID, so it is unguessable and carries no
 * meaning; prefixing it keeps this worker's keys distinguishable from any other
 * producer's in the same Stripe account.
 */
export function paymentIdempotencyKey(checkoutId: string): string {
  return `checkout:${checkoutId}`;
}

/**
 * Reads the checkout this payment is for, bound to the resolved tenant.
 *
 * The tenant predicate is not decoration: a checkout id is a bearer capability,
 * and without it an id leaked from tenant A would mint a PaymentIntent while
 * standing on tenant B's storefront. Every failure — unknown id, foreign
 * tenant — is one indistinguishable null.
 */
async function loadCheckout(
  db: D1Database,
  tenant: TenantContext,
  checkoutId: string,
  now: number,
): Promise<CheckoutPaymentRow | null> {
  const row = await db
    .prepare(
      `SELECT status, currency, total_minor, payment_intent_id, expires_at
       FROM checkouts
       WHERE tenant_id = ?
         AND checkout_id = ?
       LIMIT 1`,
    )
    .bind(tenant.tenantId, checkoutId)
    .first<CheckoutPaymentRow>();

  if (row === null) {
    return null;
  }

  // Expiry is checked HERE, before Stripe is ever contacted: an expired quote
  // must not cost a network round trip, and more importantly must never mint an
  // intent whose amount came from a total the buyer is no longer entitled to.
  if (row.expires_at <= now) {
    return null;
  }

  // Only an open checkout may be paid. 'completed' has its intent already and
  // is the webhook's business; 'expired'/'abandoned' are dead by definition.
  return row.status === "open" ? row : null;
}

/**
 * Attaches a freshly created intent to the checkout, or loses gracefully.
 *
 * The `payment_intent_id IS NULL` predicate is the whole point. Two concurrent
 * requests both reach Stripe, both get the same intent back (same idempotency
 * key), and both try to persist it; the predicate makes exactly one write win
 * and the loser observe `changes === 0`. It is also the guard against the
 * genuinely dangerous case — a second, DIFFERENT intent overwriting the id of
 * one that may already be confirming — which the UNIQUE column would catch as
 * an error but which must simply never be attempted.
 *
 * `changes === 0` is not an error: it means someone else attached first, and
 * the caller re-reads to serve whatever is now attached.
 */
async function attachPaymentIntent(
  db: D1Database,
  tenant: TenantContext,
  checkoutId: string,
  paymentIntentId: string,
  now: number,
): Promise<boolean> {
  const outcome = await db
    .prepare(
      `UPDATE checkouts
       SET payment_intent_id = ?, updated_at = ?
       WHERE tenant_id = ?
         AND checkout_id = ?
         AND payment_intent_id IS NULL`,
    )
    .bind(paymentIntentId, now, tenant.tenantId, checkoutId)
    .run();

  return outcome.meta.changes === 1;
}

/**
 * Turns a retrieved or created intent into the caller's answer, or refuses.
 *
 * A terminal intent is refused with the SAME opaque answer as an expired
 * checkout, and no second intent is minted for it. That refusal is deliberate
 * and it is the interesting design decision on this path: `payment_intent_id`
 * is UNIQUE and already occupied, so a replacement intent would have to either
 * overwrite the id — losing the link between the checkout and an intent that
 * may have MOVED MONEY — or live at Stripe unattached to anything in D1. Both
 * are money-state forks, and a fork is strictly worse than a dead checkout: a
 * buyer whose intent was canceled loses a cart, whereas a fork loses the
 * ability to say which intent this order was paid by. The buyer's remedy is a
 * new checkout, which costs them one round trip and costs the merchant nothing.
 */
function toResult(
  intent: PaymentIntentView,
  created: boolean,
): CreateCheckoutPaymentResult {
  if (TERMINAL_INTENT_STATUSES.has(intent.status)) {
    return { status: "not_available" };
  }

  // Stripe types client_secret as nullable. An intent without one cannot be
  // confirmed by the buyer, so it is as unusable as a terminal one; refusing is
  // honest where returning `null` under a 200 would not be.
  if (intent.client_secret === null) {
    return { status: "not_available" };
  }

  return {
    result: {
      clientSecret: intent.client_secret,
      created,
      paymentIntentId: intent.id,
    },
    status: "ok",
  };
}

/**
 * Creates — or re-serves — the one PaymentIntent a checkout may ever have.
 *
 * ── WHERE THE PI-FINGERPRINT FIX WENT ────────────────────────────────────────
 * Production's createPaymentIntent callable recomputes the whole cart on every
 * call and therefore had to grow a fingerprint (2026-08-15 audit): it reuses an
 * existing intent when the cart's fingerprint is unchanged and replaces it when
 * it changed, so that neither a keystroke-per-PI storm nor a discount applied
 * after PI creation can desync the charge from the displayed total.
 *
 * THE CHECKOUT IS THAT FINGERPRINT HERE. Totals were frozen into the row at
 * creation from server-resolved catalogue prices, the row's snapshots are
 * immutable by trigger, and the creation route's replay discipline already
 * answers 409 to a reused idempotency key whose freshly-resolved quote no longer
 * matches. So:
 *   - PI-per-keystroke cannot arise: this route reads NO body, recomputes
 *     nothing, and one checkout maps to exactly one intent forever. A client
 *     that calls it a hundred times retrieves the same intent a hundred times.
 *   - A discount applied "after PI creation" cannot desync the charge: applying
 *     a discount means creating a DIFFERENT checkout with a different total, and
 *     that checkout has its own intent. The old checkout's intent still charges
 *     the old checkout's frozen total, which is the honest thing for it to do.
 * There is deliberately no fingerprint column and no re-quote on this path;
 * adding one would reintroduce exactly the recompute-at-payment-time coupling
 * that made the production fix necessary.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The amount is the row's frozen `total_minor` and the currency is the row's,
 * both read here and neither recomputed. Nothing from the request reaches
 * Stripe except by way of the checkout the id names.
 */
export async function createCheckoutPayment(
  db: D1Database,
  gateway: StripeGateway,
  tenant: TenantContext,
  checkoutId: string,
  now: number,
): Promise<CreateCheckoutPaymentResult> {
  const checkout = await loadCheckout(db, tenant, checkoutId, now);
  if (checkout === null) {
    return { status: "not_available" };
  }

  try {
    // Already attached: re-read the live intent rather than trusting a status
    // frozen in D1. Stripe is the authority on an intent's state, and the
    // client secret is deliberately never stored here — it is a confirmation
    // capability for the amount on the row, and D1 has no business holding a
    // second copy of it.
    if (checkout.payment_intent_id !== null) {
      return toResult(
        await callGateway(async () =>
          gateway.retrievePaymentIntent(
            checkout.payment_intent_id as string,
          ),
        ),
        false,
      );
    }

    const intent = await callGateway(async () =>
      gateway.createPaymentIntent({
        amount: checkout.total_minor,
        // Stripe wants a lowercase ISO code; the column stores the catalogue's
        // uppercase one.
        currency: checkout.currency.toLowerCase(),
        idempotencyKey: paymentIdempotencyKey(checkoutId),
        // ── METADATA: JOIN KEYS ONLY ──────────────────────────────────────
        // Production stuffs the buyer's email, name, full shipping address,
        // every line item and the whole totals breakdown into metadata,
        // because its webhook reconstructs the order FROM metadata. This
        // worker diverges deliberately: the webhook (checkpoint 25) will read
        // the checkout row and its frozen items from D1, which is the
        // authoritative source anyway and the one the CHECK constraints
        // police. Metadata therefore carries only what finds that row.
        //
        // Stripe metadata is not a PII store: it is readable by every
        // dashboard user, it appears in exports, and it is retained on
        // Stripe's schedule rather than the tenant's. An address that never
        // leaves D1 cannot leak from a Stripe account.
        // ──────────────────────────────────────────────────────────────────
        metadata: {
          checkout_id: checkoutId,
          tenant_id: tenant.tenantId,
        },
      }),
    );

    const attached = await attachPaymentIntent(
      db,
      tenant,
      checkoutId,
      intent.id,
      now,
    );

    if (attached) {
      return toResult(intent, true);
    }

    // Lost the race. Someone else attached an intent between the read above and
    // this write, so re-read the row and serve whatever is actually attached
    // rather than the intent this request happens to hold. With the
    // deterministic idempotency key that is the same intent — but the row, not
    // this closure, is what the webhook will join against, so the row wins.
    const current = await loadCheckout(db, tenant, checkoutId, now);
    if (current === null || current.payment_intent_id === null) {
      return { status: "not_available" };
    }

    return toResult(
      await callGateway(async () =>
        gateway.retrievePaymentIntent(current.payment_intent_id as string),
      ),
      false,
    );
  } catch (error) {
    // Only gateway failures become the opaque 5xx, and callGateway has already
    // guaranteed every one of them arrives as a StripeGatewayError. Anything
    // else reaching here came from a D1 call outside that wrapper: a real defect
    // that must surface as a worker exception rather than be mislabelled as
    // Stripe being down.
    if (error instanceof StripeGatewayError) {
      return { status: "gateway_error" };
    }

    throw error;
  }
}
