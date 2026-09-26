/**
 * The container's own HTTP surface, reachable ONLY from its Durable Object (a
 * Container has no public ingress; the Worker never forwards requests to it):
 *
 *   GET  /healthz → 200 { ok, polling, inFlight, leaseHoldMs, jobsCompleted, jobsFailed, uptimeMs }
 *                   The Durable Object reads it before letting `sleepAfter` stop the
 *                   instance: busy (polling, a job in flight, or a lease possibly
 *                   still held — leaseHoldMs > 0) ⇒ keep running.
 *   POST /wake    → 200 { ok, polling } — re-arm polling (sent on every queue nudge).
 *   anything else → 404 (the DO's start probe hits "/" and only needs AN answer).
 *
 * A pure function of (method, path, worker) so it is tested without a socket.
 */
import type { WorkerStatus } from "./worker.ts";

export interface Controllable {
  status(): WorkerStatus;
  wake(): void;
}

export function handleControl(
  method: string,
  path: string,
  worker: Controllable,
): { body: Record<string, unknown>; status: number } {
  if (path === "/healthz" && (method === "GET" || method === "HEAD")) {
    const status = worker.status();
    return {
      body: {
        inFlight: status.inFlight,
        jobsCompleted: status.jobsCompleted,
        jobsFailed: status.jobsFailed,
        leaseHoldMs: status.leaseHoldMs,
        ok: !status.stopping,
        polling: status.polling,
        uptimeMs: status.uptimeMs,
      },
      status: 200,
    };
  }
  if (path === "/wake" && method === "POST") {
    worker.wake();
    const status = worker.status();
    return { body: { ok: !status.stopping, polling: status.polling }, status: 200 };
  }
  return { body: { error: "not_found" }, status: 404 };
}
