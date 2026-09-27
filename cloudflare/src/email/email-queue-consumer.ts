import { parseAuthEmailJob, renderAuthEmail } from "./auth-email-job";
import type { AuthEmailJob } from "./auth-email-job";
import {
  claimAuthEmailDelivery,
  completeAuthEmailDelivery,
  failAuthEmailDelivery,
  retryAuthEmailDelivery,
} from "./email-delivery-store";

/**
 * The `-email` queue consumer: auth email jobs → Resend.
 *
 * Since CP2 it also carries `order_confirmation` jobs, enqueued by the outbox
 * email effect (src/outbox/email-effect.ts) with a delivery id DERIVED from the
 * outbox dedupe key, and since CP2-D2 the platform `alert_digest` (D40,
 * src/commerce/alert-digest.ts) with a delivery id derived from its 15-minute
 * bucket. They take the same path — parse, ledger claim, one send — through
 * the same functions; only the template differs (auth-email-job.ts).
 *
 * ── EXACTLY-ONCE ON TOP OF AT-LEAST-ONCE ─────────────────────────────────────
 * Queues deliver at least once, so every message first CLAIMS its ledger row
 * (email_deliveries, lease-guarded — src/email/email-delivery-store.ts). Only
 * the claimant sends. A redelivery of a message already sent finds the row
 * `sent` and is acked without a second send; a redelivery that races a live
 * claim finds `not_claimed` and backs off. The one window the ledger cannot
 * close — the provider accepted the message but the worker died before
 * recording it — is closed on the provider side: every send carries
 * `Idempotency-Key: <deliveryId>`, which Resend deduplicates for 24 hours, and
 * no job lives longer than that (auth-email-job.ts caps it at 24 h).
 *
 * ── OUTCOMES ─────────────────────────────────────────────────────────────────
 *   2xx                     → ledger `sent` (+ provider id), ack
 *   408/409/429/5xx/network → ledger `pending` again with next_attempt_at, and
 *                             message.retry({ delaySeconds }) — Retry-After when
 *                             the provider sends one, else exponential backoff
 *   any other 4xx           → ledger `failed`, ack: the provider refused THIS
 *                             message, and sending it again cannot change that
 *   malformed job           → logged and acked; it can never become valid
 *   no key / no from        → nothing is attempted: log, retryAll after 300 s
 *
 * 409 is retryable because Resend answers it for a concurrent request under the
 * same idempotency key — exactly the at-least-once overlap described above.
 *
 * Nothing logged here carries a recipient, a link, a token, or provider text.
 */

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/**
 * The HTTP seam. Same convention as STRIPE_GATEWAY_OVERRIDE: a plain Symbol,
 * reachable only by importing this binding, so a deployed worker always uses
 * the real `fetch`. Every consumer test injects a fake here, and vitest's
 * outboundService refuses anything that escapes it — no test reaches Resend.
 */
export const RESEND_FETCH_OVERRIDE: unique symbol = Symbol(
  "meteorshop.test.resendFetch",
);

export type ResendFetch = (request: Request) => Promise<Response>;

export const EMAIL_UNCONFIGURED_RETRY_SECONDS = 300;
const MIN_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 60 * 60;
const MINIMUM_KEY_LENGTH = 8;
const MAX_FROM_LENGTH = 320;
// "Display Name <addr@host>" or a bare "addr@host". No CR/LF anywhere, and no
// angle brackets inside the address.
const FROM_PATTERN =
  /^(?:[^<>\r\n]{1,200} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

interface EmailDeliveryConfig {
  apiKey: string;
  from: string;
}

/**
 * Both values, or null. Either one missing or malformed means no delivery is
 * attempted at all — a message sent from a malformed sender, or with a key that
 * is obviously not a key, would only burn an attempt and a provider error.
 */
export function readEmailDeliveryConfig(env: Env): EmailDeliveryConfig | null {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (
    typeof apiKey !== "string" ||
    apiKey.length < MINIMUM_KEY_LENGTH ||
    typeof from !== "string" ||
    from.length > MAX_FROM_LENGTH ||
    !FROM_PATTERN.test(from)
  ) {
    return null;
  }

  return { apiKey, from };
}

export function resolveResendFetch(env: Env): ResendFetch {
  const override = (env as unknown as Record<PropertyKey, unknown>)[
    RESEND_FETCH_OVERRIDE
  ];
  if (typeof override === "function") {
    return override as ResendFetch;
  }

  return (request) => fetch(request);
}

/** Exponential from 30 s, doubling per queue attempt, capped at an hour. */
export function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 12));
  return Math.min(MIN_RETRY_SECONDS * 2 ** exponent, MAX_RETRY_SECONDS);
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null || !/^\d{1,6}$/.test(header.trim())) {
    return null;
  }

  return Math.min(Math.max(Number(header.trim()), 1), MAX_RETRY_SECONDS);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

type SendOutcome =
  | { kind: "sent"; providerMessageId: string | null }
  | { delaySeconds: number; errorCode: string; kind: "retry" }
  | { errorCode: string; kind: "failed" };

async function sendThroughResend(
  send: ResendFetch,
  config: EmailDeliveryConfig,
  job: AuthEmailJob,
  attempts: number,
): Promise<SendOutcome> {
  const message = renderAuthEmail(job);

  let response: Response;
  try {
    response = await send(
      new Request(RESEND_EMAILS_URL, {
        body: JSON.stringify({
          from: config.from,
          html: message.html,
          subject: message.subject,
          text: message.text,
          to: [job.recipient],
        }),
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": job.deliveryId,
        },
        method: "POST",
      }),
    );
  } catch {
    return {
      delaySeconds: backoffSeconds(attempts),
      errorCode: "E_PROVIDER_NETWORK",
      kind: "retry",
    };
  }

  if (response.ok) {
    let providerMessageId: string | null = null;
    try {
      const body = await response.json<{ id?: unknown }>();
      if (typeof body.id === "string" && body.id.length > 0 && body.id.length <= 200) {
        providerMessageId = body.id;
      }
    } catch {
      // Accepted without a readable id. Still sent — resending would email the
      // user twice for the sake of a bookkeeping field.
    }
    return { kind: "sent", providerMessageId };
  }

  // The body is never read into a log or the ledger: provider error text can
  // echo the recipient back.
  if (isRetryableStatus(response.status)) {
    return {
      delaySeconds: retryAfterSeconds(response) ?? backoffSeconds(attempts),
      errorCode: `E_PROVIDER_${response.status}`,
      kind: "retry",
    };
  }

  return { errorCode: `E_PROVIDER_${response.status}`, kind: "failed" };
}

function log(level: "error" | "warn", fields: Record<string, unknown>): void {
  console[level](JSON.stringify(fields));
}

async function deliverMessage(
  env: Env,
  config: EmailDeliveryConfig,
  send: ResendFetch,
  message: Message<unknown>,
): Promise<void> {
  let job: AuthEmailJob;
  try {
    job = parseAuthEmailJob(message.body, env.AUTH_BASE_URL);
  } catch {
    log("error", {
      message: "email job is malformed and was dropped",
      messageId: message.id,
    });
    message.ack();
    return;
  }

  const now = Date.now();
  const claim = await claimAuthEmailDelivery(env.DB, job, now);

  if (claim.status === "not_claimed") {
    // Another consumer holds a live lease, or the row is scheduled for later.
    // Come back after the lease could have expired.
    message.retry({ delaySeconds: MIN_RETRY_SECONDS });
    return;
  }
  if (claim.status !== "claimed") {
    // sent / failed / expired / fingerprint conflict: nothing left to do, and
    // doing it again would be the duplicate send this ledger exists to stop.
    message.ack();
    return;
  }

  const outcome = await sendThroughResend(send, config, job, message.attempts);

  if (outcome.kind === "sent") {
    await completeAuthEmailDelivery(
      env.DB,
      job.deliveryId,
      claim.leaseToken,
      outcome.providerMessageId,
      Date.now(),
    );
    message.ack();
    return;
  }

  if (outcome.kind === "retry") {
    const retryNow = Date.now();
    await retryAuthEmailDelivery(
      env.DB,
      job.deliveryId,
      claim.leaseToken,
      outcome.errorCode,
      retryNow + outcome.delaySeconds * 1_000,
      retryNow,
    );
    log("warn", {
      deliveryId: job.deliveryId,
      errorCode: outcome.errorCode,
      message: "email delivery will be retried",
    });
    message.retry({ delaySeconds: outcome.delaySeconds });
    return;
  }

  await failAuthEmailDelivery(
    env.DB,
    job.deliveryId,
    claim.leaseToken,
    outcome.errorCode,
    Date.now(),
  );
  log("error", {
    deliveryId: job.deliveryId,
    errorCode: outcome.errorCode,
    message: "email delivery was refused by the provider",
  });
  message.ack();
}

export async function handleEmailQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const config = readEmailDeliveryConfig(env);
  if (config === null) {
    // Same contract as the old disabled handler: never inspect the bodies
    // (they hold recipients and links), keep every message, try again later.
    log("warn", {
      message: "email delivery is not configured",
      messageCount: batch.messages.length,
      queue: batch.queue,
    });
    batch.retryAll({ delaySeconds: EMAIL_UNCONFIGURED_RETRY_SECONDS });
    return;
  }

  const send = resolveResendFetch(env);

  for (const message of batch.messages) {
    try {
      await deliverMessage(env, config, send, message);
    } catch (error) {
      // A ledger fault on one message must not strand the others' acks.
      log("error", {
        error: error instanceof Error ? error.name : "unknown",
        message: "email delivery failed unexpectedly",
        messageId: message.id,
      });
      message.retry({ delaySeconds: MIN_RETRY_SECONDS });
    }
  }
}
