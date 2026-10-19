import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit, visitorRateKey } from "../lib/rate-limit";
import { rateLimitedResponse, readJsonBodyWithin, routeNotFoundResponse } from "../lib/responses";
import { alertStatement } from "../outbox/outbox";
import { PRODIGI_ORDER_REF_PATTERN, prodigiSubmitConfig, readProdigiOrder } from "./prodigi-client";
import { PRODIGI_CALLBACK_PATH } from "./prodigi-wire";
import {
  parseProductionStatusInput,
  type ProductionStatusInput,
  recordProductionStatus,
} from "./production-status";
import { printerJobId } from "./snapwear-wire";

/**
 * POST /v1/webhooks/prodigi — Prodigi's order callbacks (CP11 unit U3).
 *
 * Prodigi posts a CloudEvent to the `callbackUrl` every order we submit
 * carries (prodigi-wire.ts toProdigiOrderBody): `com.prodigi.order.status.
 * stage.changed#<Stage>`, shipment events, … Prodigi documents NO signature
 * scheme, so the payload proves nothing. What this route takes from it is ONE
 * thing: which order to look at. It then re-reads that order with OUR key
 * (`GET /v4.0/orders/{id}`, prodigi-client.ts readProdigiOrder) and acts only
 * on what that answer says. A forged callback can at most make us read an
 * order of ours a little earlier than the next real callback would.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 *   404  the opaque "Route not found" for everything this route does not
 *        accept, so a probe learns nothing it would not learn of a path that
 *        was never written: the Prodigi gate off (prodigiSubmitConfig null —
 *        no client, no route), another method, a content type other than
 *        application/json or application/cloudevents+json, a body over
 *        64 KiB or not JSON, not a Prodigi CloudEvent (`type` must start with
 *        `com.prodigi.`), no `ord_…` id in `subject` / `data.id` /
 *        `data.order.id` (or two different ones), an id Prodigi does not know
 *        under our key, an order that names no order of ours, or one of ours
 *        none of whose lines carries that `ord_…` reference.
 *   429  more than 60 requests a minute from one address (Retry-After).
 *   503  the re-read failed (network, timeout, 5xx, 401/403/429, a redirect,
 *        an unreadable answer), or a line's write lost its race twice: nothing
 *        was decided, so Prodigi should send it again.
 *   200  `{ received: true }` whenever the re-read succeeded and every line
 *        was decided — whatever each line's verdict (moved, unchanged,
 *        refused as backwards, …). Replays are safe: recordProductionStatus
 *        no-ops a repeat and refuses a backwards move.
 *
 * ── THE MAPPING (per line of ours whose printer_job_ref is the order id) ────
 * The line's item is the one whose `merchantReference` is its line number
 * (we sent it). In this order:
 *   1. a shipment whose `status` is Shipped (any case) lists the item's `id`
 *      (`ori_…`) among its `items[].itemId` → `shipped`, with the tracking
 *      number, the tracking URL and `carrier.name` (each dropped alone when
 *      0051's rules would refuse it);
 *   2. the order's `status.stage` is Cancelled → no state change; if the line
 *      is accepted here, in an order neither cancelled nor refunded, ONE
 *      critical alert per line (`printer_order_cancelled`, see below);
 *   3. `status.details.inProduction` is InProgress or Complete, or
 *      `status.stage` is Complete → `in_production`;
 *   4. anything else → nothing.
 * Cancelled comes before in production on purpose: a cancelled order's
 * details may still say a step was in progress when it stopped.
 * Every write goes through recordProductionStatus — the ONLY writer of a
 * line's production state — with actorUserId = null (the printer).
 *
 * ── THE CANCELLED ALERT ─────────────────────────────────────────────────────
 * None of the existing kinds says what happened. `printer_cancellation_needed`
 * (dispatch-effect.ts) tells a human to CANCEL a job at the printer because
 * WE cancelled — the opposite direction; `print_job_out_of_stock`
 * (production-status.ts) records an exception the printer reported and
 * changes the line. Here the PRINTER cancelled an order we still consider
 * live, and a human must find out why and re-place or refund the line. So
 * this is its own kind, `printer_order_cancelled` (0017's CHECK allows any
 * lower-case kind; no migration), shaped like the other two: critical, ids
 * only, its id the dedupe (`printer-order-cancelled:{jobId}`), the resource
 * the print job.
 *
 * NOTHING IS LOGGED: not the payload, not the order, not an address. The
 * alert carries ids only.
 */

export const PRODIGI_WEBHOOK_PATH = PRODIGI_CALLBACK_PATH;

/** U3 rule 1: a callback is read under this many bytes. */
export const PRODIGI_WEBHOOK_BODY_MAX_BYTES = 65_536;

/** U3 rule 3: per address, its own scope. */
export const PRODIGI_WEBHOOK_IP_SCOPE = "prodigi-webhook-ip";
export const PRODIGI_WEBHOOK_IP_LIMIT = 60;
export const PRODIGI_WEBHOOK_IP_WINDOW_MS = 60_000;

export const PRINTER_ORDER_CANCELLED_ALERT_KIND = "printer_order_cancelled";

export function printerOrderCancelledAlertId(jobId: string): string {
  return `printer-order-cancelled:${jobId}`;
}

const ACCEPTED_MEDIA_TYPES = new Set(["application/json", "application/cloudevents+json"]);

const PRODIGI_EVENT_TYPE_PREFIX = "com.prodigi.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The media type alone, lower case, parameters (charset) dropped. */
export function isAcceptedContentType(header: string | null): boolean {
  if (header === null) {
    return false;
  }
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ACCEPTED_MEDIA_TYPES.has(mediaType);
}

/**
 * The Prodigi order id a callback names, or null. Only the id is read:
 * `type` must be a string starting `com.prodigi.` (at most 200 characters),
 * and the id is taken from `subject`, `data.id` or `data.order.id` — every one
 * of them that is an `ord_…` id must be the SAME id. Nothing else of the
 * payload (its status, its shipments) is ever looked at.
 */
export function prodigiOrderIdOfEvent(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const type = body.type;
  if (typeof type !== "string" || type.length > 200 || !type.startsWith(PRODIGI_EVENT_TYPE_PREFIX)) {
    return null;
  }
  const data = isRecord(body.data) ? body.data : null;
  const order = data !== null && isRecord(data.order) ? data.order : null;
  const ids = new Set(
    [body.subject, data?.id, order?.id].filter(
      (value): value is string => typeof value === "string" && PRODIGI_ORDER_REF_PATTERN.test(value),
    ),
  );
  if (ids.size !== 1) {
    return null;
  }
  const [id] = ids;
  return id ?? null;
}

// ── the mapping (pure) ──────────────────────────────────────────────────────

export type ProdigiLineFact =
  | { input: ProductionStatusInput; kind: "shipped" }
  | { kind: "cancelled" }
  | { kind: "in_production" }
  | { kind: "none" };

function lower(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * `shipped` with whatever tracking 0051 accepts: each field is checked on its
 * own by the status parser, and one it would refuse is dropped (null) rather
 * than costing the line its `shipped`.
 */
function shippedInput(shipment: Record<string, unknown>): ProductionStatusInput {
  const tracking = isRecord(shipment.tracking) ? shipment.tracking : {};
  const carrier = isRecord(shipment.carrier) ? shipment.carrier : {};
  const keep = (field: "carrier" | "trackingNumber" | "trackingUrl", value: string | null): string | null => {
    if (value === null) {
      return null;
    }
    const parsed = parseProductionStatusInput({ [field]: value, state: "shipped" });
    return parsed !== null && !("exception" in parsed) ? parsed[field] : null;
  };
  return {
    carrier: keep("carrier", text(carrier.name)),
    state: "shipped",
    trackingNumber: keep("trackingNumber", text(tracking.number)),
    trackingUrl: keep("trackingUrl", text(tracking.url)),
  };
}

/** What the re-read order says about line `lineNo` (see the header's mapping). */
export function prodigiLineFact(order: Record<string, unknown>, lineNo: number): ProdigiLineFact {
  const items = Array.isArray(order.items) ? order.items : [];
  const item = items.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.merchantReference === String(lineNo),
  );
  if (item === undefined) {
    return { kind: "none" };
  }

  const itemId = text(item.id);
  if (itemId !== null && Array.isArray(order.shipments)) {
    for (const shipment of order.shipments) {
      if (
        isRecord(shipment) &&
        lower(shipment.status) === "shipped" &&
        Array.isArray(shipment.items) &&
        shipment.items.some((entry) => isRecord(entry) && entry.itemId === itemId)
      ) {
        return { input: shippedInput(shipment), kind: "shipped" };
      }
    }
  }

  const status = isRecord(order.status) ? order.status : {};
  const stage = lower(status.stage);
  if (stage === "cancelled") {
    return { kind: "cancelled" };
  }
  const details = isRecord(status.details) ? status.details : {};
  const inProduction = lower(details.inProduction);
  if (inProduction === "inprogress" || inProduction === "complete" || stage === "complete") {
    return { kind: "in_production" };
  }
  return { kind: "none" };
}

// ── the intake ──────────────────────────────────────────────────────────────

interface IntakeLine {
  cancelled: number;
  dispatch_state: string | null;
  item_index: number;
  refunded: number;
  tenant_id: string;
}

const IN_PRODUCTION: ProductionStatusInput = {
  carrier: null,
  state: "in_production",
  trackingNumber: null,
  trackingUrl: null,
};

/** The order is refunded to its charge (production-status.ts refundedSql). Alias `o`. */
const REFUNDED_SQL = `(o.status = 'refunded'
  OR (o.charged_minor > 0 AND o.refund_succeeded_minor >= o.charged_minor))`;

const CANCELLED_SQL = `(o.cancelled_at IS NOT NULL OR o.status = 'cancelled'
  OR i.dispatch_state IS 'cancelled')`;

export type ProdigiIntakeResult = "not_found" | "ok" | "retry";

/**
 * Re-read Prodigi order `prodigiOrderId` and record what it says on our
 * lines. `not_found`: Prodigi or we know no such order (or no line of ours
 * carries the reference); `retry`: the re-read failed, or a line's write lost
 * its race twice; `ok`: every line decided.
 */
export async function intakeProdigiOrder(
  env: Env,
  prodigiOrderId: string,
  nowMs: number,
): Promise<ProdigiIntakeResult> {
  const config = prodigiSubmitConfig(env);
  if (config === null) {
    return "not_found";
  }
  const read = await readProdigiOrder(env, config, prodigiOrderId);
  if (read.status === "failed") {
    return "retry";
  }
  if (read.status === "not_found") {
    return "not_found";
  }
  const order = read.order;
  // Our order id: we sent it as merchantReference (D4.5), and it comes back
  // in OUR read, not in the callback.
  const orderId = order.merchantReference;
  if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 200) {
    return "not_found";
  }

  const rows = await env.DB.prepare(
    `SELECT i.item_index, i.tenant_id, i.dispatch_state,
            ${CANCELLED_SQL} AS cancelled,
            ${REFUNDED_SQL} AS refunded
     FROM order_items AS i
     JOIN orders AS o ON o.order_id = i.order_id AND o.tenant_id = i.tenant_id
     WHERE i.order_id = ? AND i.printer_job_ref = ? AND i.production_json IS NOT NULL
     ORDER BY i.item_index
     LIMIT 200`,
  )
    .bind(orderId, prodigiOrderId)
    .all<IntakeLine>();
  const lines = rows.results;
  if (lines.length === 0) {
    return "not_found";
  }

  let retry = false;
  // One line at a time, in line order: a 'shipped' write decides whether the
  // whole order is now shipped (printerShippedOrderStatements), so the last
  // line of an all-printer parcel order is the one that sends its one mail.
  for (const line of lines) {
    const lineNo = line.item_index + 1;
    const jobId = printerJobId(orderId, lineNo);
    const fact = prodigiLineFact(order, lineNo);
    switch (fact.kind) {
      case "shipped":
      case "in_production": {
        const result = await recordProductionStatus(
          env.DB,
          null,
          jobId,
          fact.kind === "shipped" ? fact.input : IN_PRODUCTION,
          nowMs,
        );
        if (result.status === "conflict") {
          retry = true;
        }
        break;
      }
      case "cancelled": {
        if (line.dispatch_state !== "accepted" || line.cancelled === 1 || line.refunded === 1) {
          break;
        }
        // Conditioned on the line still being accepted under this reference,
        // in an order still neither cancelled nor refunded; a repeat is a
        // no-op (the id is the dedupe).
        await alertStatement(
          env.DB,
          {
            id: printerOrderCancelledAlertId(jobId),
            kind: PRINTER_ORDER_CANCELLED_ALERT_KIND,
            message: `Print job ${jobId} (order ${orderId}, line ${lineNo}): the printer reports its order ${prodigiOrderId} cancelled, while the line is accepted here and the order is neither cancelled nor refunded. Nothing was changed. Find out why with the printer, then place the line again or refund it.`,
            nowMs,
            resourceId: jobId,
            resourceType: "print_job",
            severity: "critical",
            tenantId: line.tenant_id,
          },
          {
            binds: [orderId, line.item_index, line.tenant_id, prodigiOrderId],
            sql: `EXISTS (
                SELECT 1 FROM order_items AS i
                JOIN orders AS o ON o.order_id = i.order_id AND o.tenant_id = i.tenant_id
                WHERE i.order_id = ? AND i.item_index = ? AND i.tenant_id = ?
                  AND i.printer_job_ref = ? AND i.dispatch_state = 'accepted'
                  AND NOT ${CANCELLED_SQL} AND NOT ${REFUNDED_SQL}
              )`,
          },
        ).run();
        break;
      }
      case "none":
        break;
    }
  }
  return retry ? "retry" : "ok";
}

function unavailableResponse(): Response {
  return jsonResponse({ error: { code: "unavailable", message: "Try again later" } }, 503);
}

/** The route (registered in app.ts on the exact path, POST only). */
export async function handleProdigiWebhookRoute(env: Env, request: Request): Promise<Response> {
  // The gate FIRST, before the body or D1: with Prodigi off this path is
  // indistinguishable from one that was never written (U3 rule 4).
  if (prodigiSubmitConfig(env) === null || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  if (!isAcceptedContentType(request.headers.get("content-type"))) {
    return routeNotFoundResponse();
  }

  const now = Date.now();
  const byIp = await enforceRateLimit(env.DB, {
    key: visitorRateKey(clientIp(request)),
    limit: PRODIGI_WEBHOOK_IP_LIMIT,
    now,
    scope: PRODIGI_WEBHOOK_IP_SCOPE,
    windowMs: PRODIGI_WEBHOOK_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const body = await readJsonBodyWithin(request, PRODIGI_WEBHOOK_BODY_MAX_BYTES);
  if (body.status === "too_large") {
    return routeNotFoundResponse();
  }
  const prodigiOrderId = prodigiOrderIdOfEvent(body.value);
  if (prodigiOrderId === null) {
    return routeNotFoundResponse();
  }

  switch (await intakeProdigiOrder(env, prodigiOrderId, now)) {
    case "ok":
      return jsonResponse({ received: true }, 200);
    case "retry":
      return unavailableResponse();
    case "not_found":
      return routeNotFoundResponse();
  }
}
