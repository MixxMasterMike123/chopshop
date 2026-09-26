import { handleEmailQueueBatch } from "./email/email-queue-consumer";
import { handleOutboxQueueBatch } from "./outbox/consumer";
import { handleRenderJobsQueueBatch } from "./pod/render-jobs-queue";

/**
 * The one `queue()` export, shared by every queue this Worker consumes.
 *
 * Queue names are environment-specific (`chopshop-stg-email`,
 * `chopshop-prod-email`, ...), so dispatch is on the SUFFIX of `batch.queue`
 * and never on a full name: the same build must route correctly in every
 * environment without knowing which one it is in.
 *
 *   -email        → the auth email consumer (src/email/email-queue-consumer.ts)
 *   -render-jobs  → the render-job nudge consumer (src/pod/render-jobs-queue.ts):
 *                   the row is the truth and the container pulls, so a nudge
 *                   only wakes the render container (src/render/wake.ts)
 *   -outbox       → the outbox nudge consumer (src/outbox/consumer.ts): the
 *                   message is `{ outboxId }`, the outbox_events row is the
 *                   truth; the 15-minute sweeper is the backstop
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

export type QueueRoute = "email" | "held" | "outbox" | "render_jobs";

export function routeQueue(queueName: string): QueueRoute {
  if (queueName.endsWith(QUEUE_SUFFIX_EMAIL)) {
    return "email";
  }
  if (queueName.endsWith(QUEUE_SUFFIX_OUTBOX)) {
    return "outbox";
  }
  return queueName.endsWith(QUEUE_SUFFIX_RENDER_JOBS) ? "render_jobs" : "held";
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
  const route = routeQueue(batch.queue);
  if (route === "email") {
    await handleEmailQueueBatch(batch, env);
    return;
  }

  if (route === "render_jobs") {
    await handleRenderJobsQueueBatch(batch, env);
    return;
  }

  if (route === "outbox") {
    await handleOutboxQueueBatch(batch, env);
    return;
  }

  holdBatch(batch, "unknown_queue");
}
