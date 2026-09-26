import { Container, type StopParams } from "@cloudflare/containers";

import { readCanonicalOrigins } from "../lib/origins";
import { MINIMUM_FARM_TOKEN_LENGTH } from "../pod/render-jobs";
import {
  classifyHealth,
  type ContainerHealth,
  RenderLifecycle,
} from "./lifecycle";

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
 * Instead the container is asked (/healthz) and kept while it is polling, has a
 * job in flight, or may still hold a lease; an answer taken while a wake ran is
 * discarded as stale; two unanswered checks in a row destroy it. The decisions
 * live in src/render/lifecycle.ts (tested there with a fake container).
 */

export const RENDER_CONTAINER_PORT = 8080;
export const RENDER_CONTAINER_SLEEP_AFTER = "5m";
/** One singleton instance for now (`max_instances: 1` in wrangler.jsonc). */
export const RENDER_CONTAINER_INSTANCE = "render";
/** Handed to the container; the defaults in its own config, stated once here. */
export const RENDER_CONTAINER_IDLE_EXIT_SECONDS = "120";
export const RENDER_CONTAINER_MAX_CONCURRENT_JOBS = "1";

const CONTROL_TIMEOUT_MS = 5_000;

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

  readonly #lifecycle = new RenderLifecycle();

  /**
   * RPC, called by the -render-jobs queue consumer on a nudge: start the
   * container if it is asleep (cold start waits for its port), then re-arm its
   * polling. Throws unless the container answers `polling: true` — a draining
   * one does not, and the consumer must then retry rather than ack.
   */
  async wake(): Promise<{ polling: true; startMs: number }> {
    const envVars = renderContainerEnvVars(this.env);
    if (envVars === null) {
      throw new RenderContainerNotConfiguredError();
    }

    const result = await this.#lifecycle.wake({
      postWake: () =>
        this.containerFetch(
          new Request("http://render.container/wake", {
            method: "POST",
            signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
          }),
        ),
      start: () => this.startAndWaitForPorts({ startOptions: { envVars } }),
    });
    console.log(
      JSON.stringify({ message: "render container woken", startMs: result.startMs }),
    );
    return result;
  }

  override async onActivityExpired(): Promise<void> {
    const action = await this.#lifecycle.expire({
      destroy: () => this.destroy(),
      health: () => this.#health(),
      stop: () => this.stop(),
    });
    if (action === "destroy") {
      console.warn(
        JSON.stringify({ message: "render container unresponsive; destroyed" }),
      );
    }
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

  async #health(): Promise<ContainerHealth> {
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
      return classifyHealth(true, await response.json());
    } catch {
      return "unanswered";
    }
  }
}
