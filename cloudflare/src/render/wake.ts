import { isRenderJobsConfigured } from "../pod/render-jobs";
import { RENDER_CONTAINER_INSTANCE } from "./render-container";

/**
 * Wake the render container for a queue nudge (src/pod/render-jobs-queue.ts).
 *
 *   not_bound       no RENDER_CONTAINER binding in this environment: nothing to
 *                   wake; the surface keeps working exactly as before (a farm
 *                   that pulls on its own still gets the job).
 *   not_configured  /v1/render itself is dark here (isRenderJobsConfigured), so
 *                   a started container could only be refused; not started.
 *   woken           the container is running and polling.
 *
 * Throws when the wake itself fails (start timeout, no instance available): the
 * caller retries the nudge later. One singleton instance, so a whole batch of
 * nudges is one wake.
 */
export type WakeOutcome = "not_bound" | "not_configured" | "woken";

export async function wakeRenderContainer(env: Env): Promise<WakeOutcome> {
  const namespace = env.RENDER_CONTAINER;
  if (namespace === undefined) {
    return "not_bound";
  }
  if (!isRenderJobsConfigured(env)) {
    return "not_configured";
  }

  // Exactly what @cloudflare/containers' getContainer(namespace, name) does
  // (idFromName + get); called directly because its `T extends Container`
  // constraint is typed against Cloudflare.Env, not this Worker's Env, and
  // would erase RenderContainer's RPC surface from the stub.
  const stub = namespace.get(namespace.idFromName(RENDER_CONTAINER_INSTANCE));
  await stub.wake();
  return "woken";
}
