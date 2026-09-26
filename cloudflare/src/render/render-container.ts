import { Container, type StopParams } from "@cloudflare/containers";

import { readCanonicalOrigins } from "../lib/origins";
import { MINIMUM_FARM_TOKEN_LENGTH } from "../pod/render-jobs";

/**
 * The render container's Durable Object (DECISIONS D6: Cloudflare Containers).
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * Owns ONE container instance (the image in cloudflare/render/, built from its
 * Dockerfile at deploy). The container PULLS work from this API's
 * /v1/render/jobs/* surface; this object only starts it (wake, on a queue
 * nudge), re-arms its polling, and decides when it may sleep. It never sees a
 * job: the lease fencing stays in src/pod/render-jobs.ts, in one place.
 *
 * ── THE TWO DIRECTIONS, AND WHY THEY DIFFER ────────────────────────────────
 *   DO → container: the private channel (`containerFetch` on the instance's
 *   port). The container has no public ingress, and its /healthz and /wake are
 *   reachable only from here.
 *   container → API: the bearer RENDER_FARM_TOKEN over TLS to the API's
 *   canonical origin — the same shared-secret contract the Firebase farm used,
 *   and the same constant-time check on /v1/render. It is handed to the
 *   container as an env var at start. The alternative (the container calling a
 *   fake host that an `outboundByHost` handler forwards to the API in-process,
 *   so /v1/render needs no public route and the token never enters the
 *   container) exists in @cloudflare/containers and is the upgrade path; it is
 *   not used yet because it needs a `ContainerProxy` export from the entry
 *   module and changes the /v1/render trust boundary. See CP1_D_REPORT.md.
 *
 * ── SLEEP ───────────────────────────────────────────────────────────────────
 * `sleepAfter` counts only requests THIS object proxies. The container's own
 * outbound work (acquire, the R2 transfers, sharp) is invisible to it, so the
 * default onActivityExpired would stop a container in the middle of a job.
 * Instead the container is asked (/healthz) and kept while it is polling or has
 * a job in flight; the timer then renews and the question is asked again next
 * expiry. A container that cannot answer twice in a row is destroyed (SIGKILL):
 * a wedged process must not bill forever, and its lease expiry hands the job to
 * the next attempt.
 */

export const RENDER_CONTAINER_PORT = 8080;
export const RENDER_CONTAINER_SLEEP_AFTER = "5m";
/** One singleton instance for now (`max_instances: 1` in wrangler.jsonc). */
export const RENDER_CONTAINER_INSTANCE = "render";
/** Handed to the container; the defaults in its own config, stated once here. */
export const RENDER_CONTAINER_IDLE_EXIT_SECONDS = "120";
export const RENDER_CONTAINER_MAX_CONCURRENT_JOBS = "1";

const CONTROL_TIMEOUT_MS = 5_000;
const MAX_UNANSWERED_HEALTH_CHECKS = 2;

/**
 * The container's environment, or null when this Worker cannot give it a
 * working one (no valid canonical API origin, or a farm token under the
 * /v1/render floor) — then the container is never started.
 */
export function renderContainerEnvVars(env: Env): Record<string, string> | null {
  const origins = readCanonicalOrigins(env);
  const token = env.RENDER_FARM_TOKEN;
  if (
    origins === null ||
    typeof token !== "string" ||
    token.length < MINIMUM_FARM_TOKEN_LENGTH
  ) {
    return null;
  }
  return {
    IDLE_EXIT_SECONDS: RENDER_CONTAINER_IDLE_EXIT_SECONDS,
    MAX_CONCURRENT_JOBS: RENDER_CONTAINER_MAX_CONCURRENT_JOBS,
    RENDER_API_URL: origins.api,
    RENDER_FARM_TOKEN: token,
  };
}

export class RenderContainerNotConfiguredError extends Error {
  constructor() {
    super("render_not_configured");
    this.name = "RenderContainerNotConfiguredError";
  }
}

export class RenderContainer extends Container<Env> {
  override defaultPort = RENDER_CONTAINER_PORT;
  override sleepAfter = RENDER_CONTAINER_SLEEP_AFTER;
  // Also used by a start triggered by anything other than wake(). Field
  // initializers run after the base constructor has set `this.env`.
  override envVars = renderContainerEnvVars(this.env) ?? {};

  #unansweredHealthChecks = 0;

  /**
   * RPC, called by the -render-jobs queue consumer on a nudge: start the
   * container if it is asleep (cold start waits for its port), then re-arm its
   * polling — a running container whose loop went idle would otherwise not see
   * the new job until its next start.
   */
  async wake(): Promise<{ polling: boolean; startMs: number }> {
    const envVars = renderContainerEnvVars(this.env);
    if (envVars === null) {
      throw new RenderContainerNotConfiguredError();
    }

    const started = Date.now();
    await this.startAndWaitForPorts({ startOptions: { envVars } });
    const startMs = Date.now() - started;

    const response = await this.containerFetch(
      new Request("http://render.container/wake", {
        method: "POST",
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`render_wake_status_${response.status}`);
    }
    const body = await response.json<{ polling?: unknown }>();
    const polling = body.polling === true;

    console.log(
      JSON.stringify({ message: "render container woken", polling, startMs }),
    );
    return { polling, startMs };
  }

  override async onActivityExpired(): Promise<void> {
    const health = await this.#health();
    if (health === "busy") {
      this.#unansweredHealthChecks = 0;
      return;
    }
    if (health === "idle") {
      await this.stop();
      return;
    }

    this.#unansweredHealthChecks += 1;
    if (this.#unansweredHealthChecks >= MAX_UNANSWERED_HEALTH_CHECKS) {
      console.warn(
        JSON.stringify({ message: "render container unresponsive; destroying" }),
      );
      this.#unansweredHealthChecks = 0;
      await this.destroy();
      return;
    }
    await this.stop();
  }

  override onStop(params: StopParams): void {
    console.log(
      JSON.stringify({
        exitCode: params.exitCode,
        message: "render container stopped",
        reason: params.reason,
      }),
    );
  }

  async #health(): Promise<"busy" | "idle" | "unanswered"> {
    try {
      const response = await this.containerFetch(
        new Request("http://render.container/healthz", {
          signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        return "unanswered";
      }
      const body = await response.json<{ inFlight?: unknown; polling?: unknown }>();
      return body.polling === true ||
        (typeof body.inFlight === "number" && body.inFlight > 0)
        ? "busy"
        : "idle";
    } catch {
      return "unanswered";
    }
  }
}
