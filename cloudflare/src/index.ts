import { WorkerEntrypoint } from "cloudflare:workers";

import { createApp } from "./app";
import { stripTenantHeaders } from "./lib/tenant-headers";
import { handleScheduled } from "./outbox/scheduled";
import { handleQueueBatch } from "./queues";

// The Container-backed Durable Object class wrangler.jsonc binds as RENDER_CONTAINER.
export { RenderContainer } from "./render/render-container";

// The rate-limit contract constants are part of this module's public surface:
// suites import them from here to assert against the same numbers the routes
// enforce, so they stay re-exported from the entry module.
export {
  BOOTSTRAP_IP_LIMIT,
  BOOTSTRAP_IP_SCOPE,
  BOOTSTRAP_IP_WINDOW_MS,
  CHECKOUT_EMAIL_LIMIT,
  CHECKOUT_EMAIL_SCOPE,
  CHECKOUT_EMAIL_WINDOW_MS,
  CHECKOUT_IP_LIMIT,
  CHECKOUT_IP_SCOPE,
  CHECKOUT_IP_WINDOW_MS,
  PAYMENT_IP_LIMIT,
  PAYMENT_IP_SCOPE,
  PAYMENT_IP_WINDOW_MS,
  POD_DISPATCH_IP_LIMIT,
  POD_DISPATCH_IP_SCOPE,
  POD_DISPATCH_IP_WINDOW_MS,
} from "./app";

// One router per surface, built once per isolate. The surface is baked into the
// app rather than read from the request, so nothing a caller sends can move a
// request from one to the other.
const publicApp = createApp({ surface: "public" });
const internalApp = createApp({ surface: "internal" });

/**
 * THE PUBLIC ENTRYPOINT — everything that reaches this Worker over the internet.
 *
 * Every `X-Tenant-*` header is removed before routing (PLAN §2.1). Storefront
 * tenants come from the verified hostname; admin tenants from `X-Shop-Id`
 * checked against the session's live memberships. Neither is ever taken from a
 * tenant header, and stripping the namespace here means no later handler can
 * start trusting one by accident.
 */
export default {
  fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    return Promise.resolve(
      publicApp.fetch(stripTenantHeaders(request), env, ctx),
    );
  },

  // Every queue shares this one export; src/queues.ts routes by the suffix of
  // batch.queue, never by the environment-specific full name.
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return handleQueueBatch(batch, env);
  },

  // Cron triggers (wrangler.jsonc `triggers.crons`), routed by the expression:
  // the 15-minute outbox sweeper, then CP2-A's reconciliation and retention
  // (src/outbox/scheduled.ts).
  scheduled(controller: ScheduledController, env: Env): Promise<void> {
    return handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;

/**
 * THE INTERNAL ENTRYPOINT — reachable only through a service binding.
 *
 * `chopshop-web` binds this class (`entrypoint: "Internal"`) and forwards the
 * browser's request to it unchanged, so `request.url` still carries the
 * storefront hostname and the tenant resolves from it exactly as on the public
 * entrypoint. It is not routable from the internet: a WorkerEntrypoint class is
 * only addressable by a binding that names it.
 *
 * Inbound tenant headers are stripped here too. `chopshop-web` forwards browser
 * headers, so anything a browser sent arrives here as well; the service binding
 * authenticates the CALLER, not the headers it relays.
 *
 * The request is marked `internal` by building it through the internal app,
 * which is what later checkpoints use to confine storefront routes to this
 * entrypoint (see PUBLIC_STOREFRONT_ALLOWED in src/app.ts).
 */
export class Internal extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(
      internalApp.fetch(stripTenantHeaders(request), this.env, this.ctx),
    );
  }
}
