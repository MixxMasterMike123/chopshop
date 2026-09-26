/**
 * The render container's wake and sleep decisions, apart from the Durable Object
 * that runs them (src/render/render-container.ts) so they can be tested against a
 * fake container: a Container DO cannot be constructed without the Containers
 * runtime, which the test pool does not have.
 *
 * ── WAKE ────────────────────────────────────────────────────────────────────
 * Start the container if it is asleep, then POST /wake. Only an answer of
 * `polling: true` is a wake. A container that is DRAINING (it received SIGTERM
 * and stops asking for work) answers 200 with `polling: false`: reporting that as
 * "woken" would ack the nudge while nothing will ever pull the job, so it is a
 * failure — the consumer retries the nudge, by which time the old instance has
 * exited and the retry starts a new one.
 *
 * ── SLEEP ───────────────────────────────────────────────────────────────────
 * `sleepAfter` cannot see the container's own work, so on expiry the container is
 * asked (/healthz) and kept while it is busy: polling, a job in flight, or a lease
 * possibly still held (`leaseHoldMs` > 0, see render/src/worker.ts). The ANSWER
 * CAN BE STALE: a wake may run while the question is in flight and re-arm the loop
 * after /healthz replied "idle". So every wake bumps a generation and counts
 * itself in flight; an observation taken across ANY part of a wake is discarded
 * (keep, and ask again next expiry). Between that check and the stop signal there
 * is no `await` — Container.stop() / destroy() send the signal synchronously — so
 * nothing can interleave with the decision.
 */

export type ContainerHealth = "busy" | "idle" | "unanswered";
export type ExpiryAction = "destroy" | "keep" | "stop";

const MAX_UNANSWERED_HEALTH_CHECKS = 2;

export class RenderWakeError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "RenderWakeError";
  }
}

/** The container's /healthz answer → the sleep decision's input. */
export function classifyHealth(ok: boolean, body: unknown): ContainerHealth {
  if (!ok || typeof body !== "object" || body === null || Array.isArray(body)) {
    return "unanswered";
  }
  const { inFlight, leaseHoldMs, polling } = body as Record<string, unknown>;
  return polling === true ||
    (typeof inFlight === "number" && inFlight > 0) ||
    (typeof leaseHoldMs === "number" && leaseHoldMs > 0)
    ? "busy"
    : "idle";
}

export class RenderLifecycle {
  #generation = 0;
  #unanswered = 0;
  #wakesInFlight = 0;

  async wake(ops: {
    postWake(): Promise<Response>;
    start(): Promise<void>;
  }): Promise<{ polling: true; startMs: number }> {
    this.#generation += 1;
    this.#wakesInFlight += 1;
    try {
      const started = Date.now();
      await ops.start();
      const startMs = Date.now() - started;

      const response = await ops.postWake();
      if (!response.ok) {
        await response.body?.cancel();
        throw new RenderWakeError(`render_wake_status_${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new RenderWakeError("render_wake_bad_body");
      }
      if (
        typeof body !== "object" ||
        body === null ||
        (body as { polling?: unknown }).polling !== true
      ) {
        throw new RenderWakeError("render_wake_not_polling");
      }
      return { polling: true, startMs };
    } finally {
      this.#wakesInFlight -= 1;
    }
  }

  async expire(ops: {
    destroy(): Promise<void>;
    health(): Promise<ContainerHealth>;
    stop(): Promise<void>;
  }): Promise<ExpiryAction> {
    const generation = this.#generation;
    const wakeRunningBefore = this.#wakesInFlight > 0;
    const health = await ops.health();

    // ── no await from here to the signal ──
    if (
      wakeRunningBefore ||
      this.#wakesInFlight > 0 ||
      generation !== this.#generation
    ) {
      // A wake overlapped the question: the answer may predate its re-arm.
      this.#unanswered = 0;
      return "keep";
    }
    if (health === "busy") {
      this.#unanswered = 0;
      return "keep";
    }
    if (health === "idle") {
      this.#unanswered = 0;
      await ops.stop();
      return "stop";
    }

    this.#unanswered += 1;
    if (this.#unanswered >= MAX_UNANSWERED_HEALTH_CHECKS) {
      // A wedged process must not bill forever; its lease expiry hands the job on.
      this.#unanswered = 0;
      await ops.destroy();
      return "destroy";
    }
    await ops.stop();
    return "stop";
  }
}
