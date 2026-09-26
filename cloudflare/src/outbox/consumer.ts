import { processOutboxRowById } from "./effects";
import { isOutboxId } from "./nudge";

/**
 * The `-outbox` queue consumer (PLAN §2.2: "Queue (at-least-once) + a
 * 15-minute cron sweeper").
 *
 * A message is a NUDGE, `{ outboxId }`; the row is the truth. Per message:
 *   malformed                      ack (it can never become valid), body never logged
 *   row missing / settled          ack — done, failed, superseded, an unknown
 *                                  awaiting a human, or a type this worker does
 *                                  not run: nothing a retry could change
 *   live claim elsewhere / not due retry with the delay until it could be
 *                                  claimed (≤ 12 h, the queue's ceiling); the
 *                                  sweeper covers anything longer
 *   claimed and run                the outcome decides:
 *     done / failed / superseded / lost_claim   ack
 *     retry (back to pending)                    retry after the row's backoff
 *     unknown, auto re-submit                    retry after the row's backoff
 *     unknown awaiting a human                   ack
 *   the run threw                  retry after 30 s (the claim expires and the
 *                                  row is re-claimable in 5 min either way)
 *
 * Duplicate delivery of the same nudge is harmless: the claim is atomic, so the
 * second delivery finds the row claimed (or done) and never runs the effect.
 */

const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;
const ERROR_RETRY_SECONDS = 30;

export function parseOutboxNudge(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { outboxId } = body as { outboxId?: unknown };
  return Object.keys(body).length === 1 && isOutboxId(outboxId) ? outboxId : null;
}

function delaySeconds(delayMs: number): number | null {
  const seconds = Math.max(1, Math.ceil(delayMs / 1_000));
  return seconds > MAX_QUEUE_DELAY_SECONDS ? null : seconds;
}

function retryOrAck(message: Message<unknown>, delayMs: number | null): void {
  const seconds = delayMs === null ? null : delaySeconds(delayMs);
  if (seconds === null) {
    message.ack();
  } else {
    message.retry({ delaySeconds: seconds });
  }
}

export async function handleOutboxQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const outboxId = parseOutboxNudge(message.body);
    if (outboxId === null) {
      console.warn(
        JSON.stringify({
          message: "malformed outbox nudge acked",
          messageId: message.id,
          queue: batch.queue,
        }),
      );
      message.ack();
      continue;
    }

    try {
      const result = await processOutboxRowById(env, outboxId);
      if (result.kind === "later") {
        retryOrAck(message, result.delayMs);
        continue;
      }
      if (result.kind !== "ran") {
        message.ack();
        continue;
      }
      const { outcome } = result;
      if (outcome.kind === "retry" || outcome.kind === "unknown") {
        retryOrAck(message, outcome.delayMs);
      } else {
        message.ack();
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.name : "unknown",
          message: "outbox effect failed unexpectedly; nudge retried",
          outboxId,
        }),
      );
      message.retry({ delaySeconds: ERROR_RETRY_SECONDS });
    }
  }
}
