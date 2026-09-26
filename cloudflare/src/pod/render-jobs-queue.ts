import { wakeRenderContainer } from "../render/wake";

/**
 * The `-render-jobs` queue consumer.
 *
 * ── A MESSAGE IS ONLY A NUDGE ───────────────────────────────────────────────
 * Artwork creation writes the render_jobs row and THEN sends
 * `{ renderJobId }` here (src/pod/render-jobs.ts nudgeRenderJob). The row is the
 * truth; the message carries nothing a consumer could act on without reading
 * it. The render container PULLS (`POST /v1/render/jobs/acquire`), so a nudge
 * has exactly one job: make sure the container is awake to pull
 * (src/render/wake.ts). The fencing stays in one place — the container leases
 * through acquire like any other farm.
 *
 * ── PER BATCH ───────────────────────────────────────────────────────────────
 *   malformed messages   acked (they can never become valid), never logged
 *   valid nudges         ONE wake for the batch (one singleton container), then:
 *     woken              acked
 *     not_bound          acked + `container_not_bound` — an environment without
 *                        the RENDER_CONTAINER binding behaves as before CP1-D
 *     not_configured     acked + `render_not_configured` — /v1/render is dark
 *                        here, a container could only be refused
 *     wake threw         (start failed, or the container is draining and
 *                        answered /wake with polling:false) each nudge retried
 *                        after WAKE_RETRY_DELAY_SECONDS; if the queue's retries
 *                        run out the row stays `queued` and the next nudge (or
 *                        the CP2 15-minute sweeper, PLAN §2.2) wakes it
 *
 * The queue consumer reads no D1 row: a wake for a job already done costs one
 * empty acquire and the container's idle window.
 *
 * Bodies are never logged.
 */

export const WAKE_RETRY_DELAY_SECONDS = 30;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRenderJobNudge(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const { renderJobId } = body as { renderJobId?: unknown };
  return Object.keys(body).length === 1 &&
    typeof renderJobId === "string" &&
    UUID_PATTERN.test(renderJobId)
    ? renderJobId
    : null;
}

export async function handleRenderJobsQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const nudges: Message<unknown>[] = [];
  for (const message of batch.messages) {
    if (parseRenderJobNudge(message.body) === null) {
      // It can never become valid; acking is the only useful answer.
      console.warn(
        JSON.stringify({
          message: "malformed render job nudge acked",
          messageId: message.id,
          queue: batch.queue,
        }),
      );
      message.ack();
      continue;
    }
    nudges.push(message);
  }

  if (nudges.length === 0) {
    return;
  }

  let outcome: Awaited<ReturnType<typeof wakeRenderContainer>>;
  try {
    outcome = await wakeRenderContainer(env);
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "unknown",
        message: "render container wake failed; nudges retried",
        nudges: nudges.length,
        queue: batch.queue,
      }),
    );
    for (const message of nudges) {
      message.retry({ delaySeconds: WAKE_RETRY_DELAY_SECONDS });
    }
    return;
  }

  if (outcome !== "woken") {
    console.warn(
      JSON.stringify({
        message:
          outcome === "not_bound" ? "container_not_bound" : "render_not_configured",
        nudges: nudges.length,
        queue: batch.queue,
      }),
    );
  }
  for (const message of nudges) {
    message.ack();
  }
}
