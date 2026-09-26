/**
 * The `-render-jobs` queue consumer.
 *
 * ── A MESSAGE IS ONLY A NUDGE ───────────────────────────────────────────────
 * Artwork creation writes the render_jobs row and THEN sends
 * `{ renderJobId }` here (src/pod/render-jobs.ts nudgeRenderJob). The row is the
 * truth; the message carries nothing a consumer could act on without reading
 * it. Today the farm PULLS (`POST /v1/render/jobs/acquire`), so there is nothing
 * to do on receipt — a queued job is picked up by the next acquire, and a job in
 * any other state is already handled — and every message is acked.
 *
 * ── WHY IT EXISTS ANYWAY ────────────────────────────────────────────────────
 * It is the hook for a PUSH-based render host (PLAN §2.6: e.g. a Container
 * reached over a private binding). Such a host would be woken here — read the
 * row, and if it is still `queued`, start a renderer — and the renderer would
 * still lease through acquire, so the fencing stays in one place. Wiring it
 * later changes no producer. Until then this consumer reads nothing: a D1 read
 * whose answer changes nothing would only be a way to fail.
 *
 * Bodies are never logged.
 */

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

export function handleRenderJobsQueueBatch(batch: MessageBatch<unknown>): void {
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
    }

    message.ack();
  }
}
