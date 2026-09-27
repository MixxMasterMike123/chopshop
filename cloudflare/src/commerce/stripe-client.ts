import Stripe from "stripe";

/**
 * The Stripe API version this worker speaks.
 *
 * Pinned explicitly rather than left to the SDK's default, because an SDK
 * upgrade would otherwise silently move the wire contract underneath a running
 * payment path. The value IS the SDK's own pinned version (stripe 22.5.0 ships
 * `2026-07-29.dahlia`), so the types and the wire agree today; the point of
 * writing it down is that a future upgrade becomes a deliberate edit here with
 * its own review, not a side effect of `npm update`.
 *
 * ⚠️ CUTOVER NOTE: production Firebase pins `2023-10-16` on the live Stripe
 * account (functions/src/payment/createPaymentIntent.ts), and the production
 * webhook endpoint is pinned to that same version. Staging deliberately runs
 * the current version against a TEST-mode key. Before any production cutover,
 * the account/webhook version and this constant must be reconciled as one
 * decision — a PaymentIntent created under one version and read by a webhook
 * pinned to another is exactly the kind of drift that silently changes field
 * shapes.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia";

/**
 * The PaymentIntent fields this worker actually consumes.
 *
 * Deliberately a narrow projection of Stripe's type rather than the type
 * itself: it is the whole contract a test fake must satisfy, and it documents
 * that nothing else about an intent — charges, payment method details, customer
 * — is read on this path. `client_secret` is nullable in Stripe's own type, and
 * that nullability is preserved rather than asserted away, because a null one
 * is unusable to the buyer and must be handled, not crashed on.
 */
export interface PaymentIntentView {
  amount: number;
  client_secret: string | null;
  currency: string;
  id: string;
  status: string;
}

export interface CreatePaymentIntentParams {
  amount: number;
  /**
   * The platform's cut, in the charge's minor unit: commission + the frozen
   * production withholding (src/commerce/payment.ts). Stripe's
   * `application_fee_amount`.
   */
  applicationFeeAmount: number;
  currency: string;
  /**
   * Stripe's own idempotency key. Derived deterministically from the checkout
   * id by the caller, so two racing requests for one checkout reach the SAME
   * intent at Stripe rather than minting two.
   */
  idempotencyKey: string;
  metadata: Record<string, string>;
  /**
   * `on_behalf_of`, or null to omit it. payment.ts passes null
   * (CONNECT_ON_BEHALF_OF = false): the platform stays the VAT merchant of
   * record, exactly as the Firebase "Marknadsplats" model.
   */
  onBehalfOf: string | null;
  /** Sanitised shop name, or null to omit the suffix entirely. */
  statementDescriptorSuffix: string | null;
  /** The shop's connected account: `transfer_data.destination`. */
  transferDestination: string;
}

/**
 * The payment gateway seam.
 *
 * The route depends on this interface and never on the SDK, so tests inject a
 * fake with realistic idempotent-create semantics and NO test ever reaches the
 * real Stripe API. The payment route uses exactly these two operations:
 * creating the one intent a checkout may ever have, and re-reading it. The
 * money paths that own cancel, refund and transfer transitions use the wider
 * StripeMoneyGateway below, through the same seam.
 */
export interface StripeGateway {
  createPaymentIntent(
    params: CreatePaymentIntentParams,
  ): Promise<PaymentIntentView>;
  retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentView>;
}

/**
 * A Refund, narrowed to what refund settlement reads (src/commerce/refunds.ts).
 * `status` is Stripe's: pending | requires_action | succeeded | failed |
 * canceled.
 */
export interface RefundView {
  amount: number;
  charge: string | null;
  id: string;
  metadata: Record<string, string>;
  payment_intent: string | null;
  status: string;
}

export interface CreateRefundParams {
  amount: number;
  /** = the refund operation id: one operation can never become two refunds. */
  idempotencyKey: string;
  metadata: Record<string, string>;
  paymentIntentId: string;
  /** D9: false — the platform fee is not refundable. */
  refundApplicationFee: boolean;
  /** Always true for a destination charge: claw the principal back. */
  reverseTransfer: boolean;
}

export interface ChargeView {
  id: string;
  payment_intent: string | null;
  /** The destination-charge transfer, or null when there is none. */
  transfer: string | null;
}

export interface TransferReversalView {
  amount: number;
  id: string;
}

export interface TransferView {
  amount: number;
  id: string;
}

/**
 * One PaymentIntent as the reconciliation cron sees it. `chargeCreated` is the
 * latest charge's creation time (unix seconds) when Stripe expanded it — the
 * closest thing to "when did this succeed" a PaymentIntent carries.
 */
export interface PaymentIntentSummary {
  amount: number;
  chargeCreated: number | null;
  created: number;
  currency: string;
  id: string;
  metadata: Record<string, string>;
  status: string;
}

export interface PaymentIntentPage {
  data: PaymentIntentSummary[];
  hasMore: boolean;
}

/**
 * Everything CP2's money paths call on Stripe, on top of the payment route's
 * two operations. Same seam, same symbol (STRIPE_GATEWAY_OVERRIDE): a test
 * injects ONE fake that implements whatever it exercises, and
 * resolveStripeMoneyGateway only accepts an override that implements all of
 * it. No method here ever reaches Stripe from a test.
 */
export interface StripeMoneyGateway extends StripeGateway {
  cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentView>;
  createRefund(params: CreateRefundParams): Promise<RefundView>;
  createTransfer(params: {
    amount: number;
    currency: string;
    destination: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<TransferView>;
  createTransferReversal(params: {
    idempotencyKey: string;
    metadata: Record<string, string>;
    /** false: a dispute reversal leaves the fee with the platform (Firebase). */
    refundApplicationFee: boolean;
    transferId: string;
  }): Promise<TransferReversalView>;
  listPaymentIntents(params: {
    createdGte: number;
    limit: number;
    startingAfter: string | null;
  }): Promise<PaymentIntentPage>;
  /** At most 100 — a charge with more refunds than that does not exist here. */
  listRefunds(paymentIntentId: string): Promise<RefundView[]>;
  retrieveCharge(chargeId: string): Promise<ChargeView>;
}

const MONEY_METHODS = [
  "cancelPaymentIntent",
  "createPaymentIntent",
  "createRefund",
  "createTransfer",
  "createTransferReversal",
  "listPaymentIntents",
  "listRefunds",
  "retrieveCharge",
  "retrievePaymentIntent",
] as const;

/**
 * The test seam, and deliberately the ONLY one.
 *
 * Workers has no local Stripe to point at the way miniflare provides a real R2
 * bucket, so the gateway cannot be injected through a binding. It is injected
 * through the env object instead: the existing suites already drive the worker
 * as `worker.fetch(request, envOverride)`, so a test hands in an env carrying
 * its fake and the route uses it.
 *
 * It is a symbol rather than a string key so it cannot collide with a real
 * binding name, cannot be set from wrangler.jsonc, and cannot arrive from any
 * source outside this process — a deployed worker's env is built by the runtime
 * from the config, which has no way to express a symbol-keyed JavaScript object.
 * The production path therefore always constructs the real client.
 *
 * A PLAIN Symbol, not Symbol.for: the global symbol registry would let any
 * in-process code mint an equal key from the string alone, whereas this one is
 * reachable only by importing this binding. Tests do exactly that.
 */
export const STRIPE_GATEWAY_OVERRIDE: unique symbol = Symbol(
  "meteorshop.test.stripeGateway",
);

/**
 * A Stripe event this worker has PROVEN came from Stripe.
 *
 * Narrowed to what the webhook handler reads, for the same reason
 * PaymentIntentView is narrow: it documents the whole surface a fake must
 * satisfy, and it states that nothing else about an event — `livemode`,
 * `api_version`, `request`, `account` — is consulted on this path.
 *
 * `data.object` is `unknown` on purpose. The SDK types it as a union across
 * every event type, and a handler that trusted that type would be trusting a
 * shape it received over the network; the handler narrows it structurally
 * instead. Production's equivalent interface types `data.object` as
 * `Stripe.PaymentIntent` for ALL events and then casts its way out for every
 * other branch — the casts are exactly where a wrong assumption would hide.
 */
export interface VerifiedStripeEvent {
  data: { object: unknown };
  id: string;
  type: string;
}

/**
 * Verifying a webhook request's signature — the ONLY authentication this
 * worker's webhook endpoint has, and sufficient because it proves possession of
 * a secret only Stripe and this worker hold.
 *
 * The payload is the RAW request body as a string, never a parsed object: the
 * signature is computed over the exact bytes Stripe sent, so any reserialization
 * — a re-`JSON.stringify` with different key order or spacing — breaks it.
 *
 * Verification MUST be async on this runtime. Probed under vitest-pool-workers:
 * the SDK's synchronous `constructEvent` throws
 * `"SubtleCryptoProvider cannot be used in a synchronous context"`, because
 * Web Crypto's digest is promise-returning and there is no synchronous fallback
 * in a Worker. Production calls the synchronous form, which works only because
 * it runs on Node with a synchronous crypto provider.
 */
export interface StripeWebhookVerifier {
  /**
   * Resolves with the verified event, or throws
   * StripeSignatureVerificationError when the signature does not verify, is
   * absent, or falls outside the timestamp tolerance.
   */
  constructEvent(
    payload: string,
    signatureHeader: string,
  ): Promise<VerifiedStripeEvent>;
}

/**
 * Raised for every signature failure, whatever its cause: a wrong secret, a
 * mangled body, a missing header, a replayed timestamp outside tolerance.
 *
 * Detail-free by construction, exactly like StripeGatewayError. The SDK's own
 * message is a paragraph of prose about forwarding tools and JSON formatting;
 * useful in a developer's terminal, not in a response to whoever just sent an
 * unsigned request to a public endpoint.
 */
export class StripeSignatureError extends Error {
  constructor() {
    super("stripe webhook signature verification failed");
    this.name = "StripeSignatureError";
  }
}

/**
 * The webhook verifier's test seam, and the same reasoning as
 * STRIPE_GATEWAY_OVERRIDE: a plain Symbol, unreachable except by importing this
 * binding, so a deployed worker always builds the real verifier.
 *
 * It exists so a test can drive a verifier that FAILS on demand. The success
 * path deliberately does NOT use it — the webhook suite signs its payloads with
 * the SDK's own `generateTestHeaderStringAsync` and lets the real
 * `constructEventAsync` verify them, so the production verification code is what
 * runs under test. Stubbing verification out would leave the single most
 * security-critical line in this checkpoint unexercised.
 */
export const STRIPE_WEBHOOK_VERIFIER_OVERRIDE: unique symbol = Symbol(
  "meteorshop.test.stripeWebhookVerifier",
);

const MINIMUM_KEY_LENGTH = 8;

/**
 * The minimum length of a usable webhook signing secret.
 *
 * Stripe issues `whsec_` + 32+ characters, so this is far below any real one and
 * is a typo/empty-string guard rather than a validity check — the same contract
 * isStripeConfigured states for the API key.
 */
const MINIMUM_WEBHOOK_SECRET_LENGTH = 8;

/**
 * Whether a webhook signing secret exists at all.
 *
 * The ENTIRE webhook surface answers fail-closed 404 while this is false — the
 * gate runs before the method check, before the body is read, and before D1 is
 * touched — so an unconfigured deployment is indistinguishable from one where
 * the endpoint was never written. Same contract as isAuthConfigured and
 * isStripeConfigured.
 *
 * A present-but-WRONG secret is deliberately CONFIGURED. It then fails loudly
 * at verification as a 400, which is what an operator needs to see; making the
 * route vanish instead would render a live misconfiguration indistinguishable
 * from a route that was never enabled, and the operator would be debugging the
 * wrong thing while real payments went unrecorded.
 */
export function isStripeWebhookConfigured(env: Env): boolean {
  return (
    typeof env.STRIPE_WEBHOOK_SECRET === "string" &&
    env.STRIPE_WEBHOOK_SECRET.length >= MINIMUM_WEBHOOK_SECRET_LENGTH
  );
}

export function resolveStripeWebhookVerifier(env: Env): StripeWebhookVerifier {
  const override = (env as unknown as Record<PropertyKey, unknown>)[
    STRIPE_WEBHOOK_VERIFIER_OVERRIDE
  ];

  if (
    typeof override === "object" &&
    override !== null &&
    typeof (override as StripeWebhookVerifier).constructEvent === "function"
  ) {
    return override as StripeWebhookVerifier;
  }

  return createStripeWebhookVerifier(env);
}

export function createStripeWebhookVerifier(env: Env): StripeWebhookVerifier {
  if (!isStripeWebhookConfigured(env)) {
    // Unreachable through the route, which gates on isStripeWebhookConfigured
    // first. Kept strict for the same reason createStripeGateway is: a future
    // caller that forgets the gate must fail loudly rather than verify against
    // `undefined`, which would accept nothing and look like a signature bug.
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }

  const secret = env.STRIPE_WEBHOOK_SECRET as string;

  // A client is needed only for its `webhooks` namespace; no request is ever
  // dispatched from it. The API key is not required for verification — it is
  // pure HMAC over the body — but the constructor demands one, and the webhook
  // endpoint is only reachable when both secrets exist, so passing the real one
  // costs nothing and avoids a placeholder that could confuse a stack trace.
  const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "", {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
  });

  return {
    async constructEvent(
      payload: string,
      signatureHeader: string,
    ): Promise<VerifiedStripeEvent> {
      try {
        // ASYNC, and it must be. See StripeWebhookVerifier: the synchronous
        // form throws under workerd because Web Crypto has no synchronous
        // digest. This also enforces Stripe's default 300-second timestamp
        // tolerance, probed and confirmed enforced — an old signature is
        // rejected with "Timestamp outside the tolerance zone", which is the
        // replay protection the scheme provides beyond the HMAC itself.
        const event = await stripe.webhooks.constructEventAsync(
          payload,
          signatureHeader,
          secret,
        );

        return event as unknown as VerifiedStripeEvent;
      } catch {
        // Catch-all and detail-free. See StripeSignatureError.
        throw new StripeSignatureError();
      }
    },
  };
}

/**
 * Whether a Stripe key exists at all. Mirrors isAuthConfigured: the ENTIRE
 * payment surface answers fail-closed 404 while this is false, so staging can
 * deploy dark and light up the moment the owner sets the secret.
 *
 * The length floor is a typo/empty-string guard, not a validity check. A key
 * that is present but WRONG is deliberately treated as configured — it must
 * fail loudly as a gateway error rather than making the route vanish, because a
 * vanishing route on a bad key is indistinguishable from an unconfigured one
 * and would hide a live misconfiguration from the operator.
 */
export function isStripeConfigured(env: Env): boolean {
  return (
    typeof env.STRIPE_SECRET_KEY === "string" &&
    env.STRIPE_SECRET_KEY.length >= MINIMUM_KEY_LENGTH
  );
}

/**
 * Raised for every gateway failure, whatever its cause: a network error, a
 * declined API call, an invalid key, a malformed response.
 *
 * It carries NO detail from Stripe — not the message, not the code, not the
 * request id, not the account. The caller turns it into one opaque 5xx. Stripe's
 * error text routinely names the key prefix, the account, and the exact
 * parameter at fault, and none of that belongs in a response to an anonymous
 * buyer or in a log line that a support ticket might quote verbatim.
 */
export class StripeGatewayError extends Error {
  /**
   * True when Stripe ANSWERED and refused (a 4xx other than 408/409/429): the
   * request was processed and nothing was created. False for everything whose
   * outcome is unknown — network failures, timeouts, 5xx, rate limits — where
   * the operation may or may not have happened and only an idempotent retry or
   * a later read can tell. Money paths branch on this and nothing else; it
   * still carries no Stripe text.
   */
  readonly rejected: boolean;

  constructor(rejected = false) {
    super("stripe gateway request failed");
    this.name = "StripeGatewayError";
    this.rejected = rejected;
  }
}

/** Maps an SDK failure to the detail-free error, keeping only "refused?". */
function gatewayError(error: unknown): StripeGatewayError {
  if (error instanceof StripeGatewayError) {
    return error;
  }

  const status =
    typeof error === "object" && error !== null
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  const rejected =
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429;

  return new StripeGatewayError(rejected);
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }

  return null;
}

function metadataOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) {
    return out;
  }

  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string") {
      out[key] = inner;
    }
  }

  return out;
}

function refundView(refund: {
  amount: number;
  charge?: unknown;
  id: string;
  metadata?: unknown;
  payment_intent?: unknown;
  status?: string | null;
}): RefundView {
  return {
    amount: refund.amount,
    charge: stringOrNull(refund.charge),
    id: refund.id,
    metadata: metadataOf(refund.metadata),
    payment_intent: stringOrNull(refund.payment_intent),
    status: refund.status ?? "pending",
  };
}

/**
 * Verified under workerd (vitest-pool-workers, nodejs_compat) before being
 * chosen: the SDK exposes a dedicated `workerd` export condition whose entry
 * initializes WebPlatformFunctions, `createFetchHttpClient()` dispatches through
 * the runtime's own fetch, and a probe confirmed the create call reaches
 * `https://api.stripe.com/v1/payment_intents` carrying the `Idempotency-Key` and
 * `Stripe-Version` headers. No minimal hand-rolled REST client was needed.
 *
 * A fresh client per request rather than a module-level singleton: the secret
 * arrives on `env`, which is a per-request value in Workers, and caching a
 * client across requests would pin whichever key happened to construct it
 * first. Construction is cheap — it wires objects, it opens nothing.
 */
export function resolveStripeGateway(env: Env): StripeGateway {
  // Through `unknown`: Env has no index signature, which is exactly the point —
  // the symbol key is not part of the deployed environment's declared shape.
  const override = (env as unknown as Record<PropertyKey, unknown>)[
    STRIPE_GATEWAY_OVERRIDE
  ];

  // Narrowed structurally rather than trusted: an override that is present but
  // not a usable gateway must not silently become one.
  if (
    typeof override === "object" &&
    override !== null &&
    typeof (override as StripeGateway).createPaymentIntent === "function" &&
    typeof (override as StripeGateway).retrievePaymentIntent === "function"
  ) {
    return override as StripeGateway;
  }

  return createStripeGateway(env);
}

/**
 * The money paths' gateway: refunds, dispute recovery, retention and
 * reconciliation. Reads the SAME override symbol as resolveStripeGateway and
 * accepts it only when it implements every money operation; a partial fake is
 * not silently promoted, it falls through to the real client — which, under
 * test, the outbound-network backstop refuses.
 */
export function resolveStripeMoneyGateway(env: Env): StripeMoneyGateway {
  const override = (env as unknown as Record<PropertyKey, unknown>)[
    STRIPE_GATEWAY_OVERRIDE
  ];

  if (
    typeof override === "object" &&
    override !== null &&
    MONEY_METHODS.every(
      (method) =>
        typeof (override as Record<string, unknown>)[method] === "function",
    )
  ) {
    return override as StripeMoneyGateway;
  }

  return createStripeGateway(env);
}

export function createStripeGateway(env: Env): StripeMoneyGateway {
  if (!isStripeConfigured(env)) {
    // Unreachable through the route, which gates on isStripeConfigured first.
    // Kept strict anyway, exactly like createAuth: a future caller that forgets
    // the gate must fail loudly here rather than construct a client with an
    // undefined key and produce a confusing 401 from Stripe.
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    // Retries are the caller's business, not the SDK's. This path writes the
    // returned intent id into D1 under a guarded UPDATE, and a silent retry
    // inside the SDK on a request whose response was merely slow would race
    // that write; the deterministic idempotency key means an honest client
    // retry is free and safe, which is the retry story this route wants.
    maxNetworkRetries: 0,
  });

  return {
    async createPaymentIntent(
      params: CreatePaymentIntentParams,
    ): Promise<PaymentIntentView> {
      try {
        return await stripe.paymentIntents.create(
          {
            amount: params.amount,
            // ── STRIPE CONNECT: a DESTINATION charge (PLAN §2.3) ───────────
            // The "Marknadsplats" model production runs
            // (functions/src/payment/connectParams.ts): the whole charge
            // transfers to the shop's account and the platform keeps
            // application_fee_amount, taken off the GROSS total. `on_behalf_of`
            // is omitted unless the caller passes one (payment.ts does not):
            // adding it moves the merchant of record and changes who owes the
            // VAT.
            // ───────────────────────────────────────────────────────────────
            application_fee_amount: params.applicationFeeAmount,
            // Stripe's card-present/wallet selection. Matches production, which
            // enables automatic payment methods rather than enumerating them, so
            // the method set is configured in the Stripe dashboard rather than
            // deployed in code.
            automatic_payment_methods: { enabled: true },
            currency: params.currency,
            metadata: params.metadata,
            ...(params.onBehalfOf === null
              ? {}
              : { on_behalf_of: params.onBehalfOf }),
            ...(params.statementDescriptorSuffix === null
              ? {}
              : {
                  statement_descriptor_suffix: params.statementDescriptorSuffix,
                }),
            transfer_data: { destination: params.transferDestination },
          },
          { idempotencyKey: params.idempotencyKey },
        );
      } catch (error) {
        // Detail-free. See StripeGatewayError.
        throw gatewayError(error);
      }
    },

    async retrievePaymentIntent(
      paymentIntentId: string,
    ): Promise<PaymentIntentView> {
      try {
        return await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch (error) {
        throw gatewayError(error);
      }
    },

    async cancelPaymentIntent(
      paymentIntentId: string,
      idempotencyKey: string,
    ): Promise<PaymentIntentView> {
      try {
        return await stripe.paymentIntents.cancel(
          paymentIntentId,
          { cancellation_reason: "abandoned" },
          { idempotencyKey },
        );
      } catch (error) {
        throw gatewayError(error);
      }
    },

    async createRefund(params: CreateRefundParams): Promise<RefundView> {
      try {
        return refundView(
          await stripe.refunds.create(
            {
              amount: params.amount,
              metadata: params.metadata,
              payment_intent: params.paymentIntentId,
              refund_application_fee: params.refundApplicationFee,
              reverse_transfer: params.reverseTransfer,
            },
            { idempotencyKey: params.idempotencyKey },
          ),
        );
      } catch (error) {
        throw gatewayError(error);
      }
    },

    async listRefunds(paymentIntentId: string): Promise<RefundView[]> {
      try {
        const page = await stripe.refunds.list({
          limit: 100,
          payment_intent: paymentIntentId,
        });
        return page.data.map(refundView);
      } catch (error) {
        throw gatewayError(error);
      }
    },

    async retrieveCharge(chargeId: string): Promise<ChargeView> {
      try {
        const charge = await stripe.charges.retrieve(chargeId);
        return {
          id: charge.id,
          payment_intent: stringOrNull(charge.payment_intent),
          transfer: stringOrNull(charge.transfer),
        };
      } catch (error) {
        throw gatewayError(error);
      }
    },

    async createTransferReversal(params): Promise<TransferReversalView> {
      try {
        const reversal = await stripe.transfers.createReversal(
          params.transferId,
          {
            metadata: params.metadata,
            refund_application_fee: params.refundApplicationFee,
          },
          { idempotencyKey: params.idempotencyKey },
        );
        return { amount: reversal.amount, id: reversal.id };
      } catch (error) {
        throw gatewayError(error);
      }
    },

    async createTransfer(params): Promise<TransferView> {
      try {
        const transfer = await stripe.transfers.create(
          {
            amount: params.amount,
            currency: params.currency,
            destination: params.destination,
            metadata: params.metadata,
          },
          { idempotencyKey: params.idempotencyKey },
        );
        return { amount: transfer.amount, id: transfer.id };
      } catch (error) {
        throw gatewayError(error);
      }
    },

    async listPaymentIntents(params): Promise<PaymentIntentPage> {
      try {
        const page = await stripe.paymentIntents.list({
          created: { gte: params.createdGte },
          expand: ["data.latest_charge"],
          limit: params.limit,
          ...(params.startingAfter === null
            ? {}
            : { starting_after: params.startingAfter }),
        });
        return {
          data: page.data.map((intent) => {
            const charge = intent.latest_charge;
            return {
              amount: intent.amount,
              chargeCreated:
                typeof charge === "object" && charge !== null
                  ? charge.created
                  : null,
              created: intent.created,
              currency: intent.currency,
              id: intent.id,
              metadata: metadataOf(intent.metadata),
              status: intent.status,
            };
          }),
          hasMore: page.has_more,
        };
      } catch (error) {
        throw gatewayError(error);
      }
    },
  };
}
