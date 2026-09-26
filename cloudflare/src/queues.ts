import { handleEmailQueueBatch } from "./email/email-queue-consumer";

/**
 * The one `queue()` export, shared by every queue this Worker consumes.
 *
 * Queue names are environment-specific (`chopshop-stg-email`,
 * `chopshop-prod-email`, ...), so dispatch is on the SUFFIX of `batch.queue`
 * and never on a full name: the same build must route correctly in every
 * environment without knowing which one it is in.
 *
 *   -email        → the auth email consumer (src/email/email-queue-consumer.ts)
 *   -outbox       → no consumer yet (CP2): held, retried later
 *   -render-jobs  → no consumer yet (CP1 render contract / CP2): held, retried
 *   anything else → held, retried later — including the legacy
 *                   `…-email-auth` queue and any dead-letter queue
 *
 * "Held" means `retryAll` with a delay and never `ack`: a message nobody can
 * process yet is kept until its consumer exists (or it reaches the queue's
 * dead-letter queue), rather than silently dropped. Bodies are never inspected
 * or logged on that path.
 */
export const QUEUE_SUFFIX_EMAIL = "-email";
export const QUEUE_SUFFIX_OUTBOX = "-outbox";
export const QUEUE_SUFFIX_RENDER_JOBS = "-render-jobs";

export const HELD_QUEUE_RETRY_SECONDS = 300;

export type QueueRoute = "email" | "held";

export function routeQueue(queueName: string): QueueRoute {
  return queueName.endsWith(QUEUE_SUFFIX_EMAIL) ? "email" : "held";
}

function holdBatch(batch: MessageBatch<unknown>, reason: string): void {
  console.warn(
    JSON.stringify({
      message: "queue batch held for later",
      messageCount: batch.messages.length,
      queue: batch.queue,
      reason,
    }),
  );
  batch.retryAll({ delaySeconds: HELD_QUEUE_RETRY_SECONDS });
}

export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  if (routeQueue(batch.queue) === "email") {
    await handleEmailQueueBatch(batch, env);
    return;
  }

  if (
    batch.queue.endsWith(QUEUE_SUFFIX_OUTBOX) ||
    batch.queue.endsWith(QUEUE_SUFFIX_RENDER_JOBS)
  ) {
    holdBatch(batch, "consumer_not_built");
    return;
  }

  holdBatch(batch, "unknown_queue");
}
