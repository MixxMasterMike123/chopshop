import { handleFakePrinterRoute } from "../routes/fake-printer";
import { FAKE_PRINTER_JOBS_PATH, isFakePrinterEnabled } from "./fake-printer";
import type { PrintLocation, SnapwearJobBody } from "./snapwear-wire";
import { SNAPWEAR_DUPLICATE_JOB_MESSAGE, snapwearShippingAddress } from "./snapwear-wire";
import type { ShipTo } from "../commerce/recipient";

/**
 * The printer seam the CP2 dispatch consumer will call (PLAN §2.3).
 *
 * `submit` answers with what the PRINTER decided, as a closed union:
 *
 *   accepted   the printer took the job; `printerJobId` is its reference
 *   duplicate  the printer already has this job id — a previous submission
 *              whose response was lost WAS accepted (SnapWear: duplicate
 *              `job_id` → 400). The dispatcher records it as accepted.
 *   rejected   the printer refused this job (SnapWear 422, or another 4xx).
 *              Resubmitting cannot help; a human must look.
 *   unknown    the outcome was not determined: network failure, timeout,
 *              5xx/408/429, an auth/config error on OUR side (3xx/401/403/404),
 *              or a success body we cannot read. The job may or may not have been
 *              taken, so the only safe move is to resubmit the SAME job id
 *              later — the printer's duplicate check makes that idempotent —
 *              and to alert when it stays unknown (PLAN §2.3: 30 min).
 *
 * `unknown` is a fourth variant beyond the three the printer can answer: a
 * transport failure is an outcome the dispatcher must handle explicitly, so it
 * is part of the type rather than a thrown error a caller could forget.
 */

export interface PrinterJob {
  artworks: Array<{ location: PrintLocation; url: string }>;
  items: Array<{ quantity: number; sku: string }>;
  /** Stable: printerJobId(orderId, lineNo). The printer's dedupe key. */
  jobId: string;
  mockupUrls: string[];
  /**
   * Where the parcel goes (D98): the recipient of a SHIPPED order; null or
   * absent for a collected order and for an order made before 0045.
   */
  shipTo?: ShipTo | null;
}

export type PrinterSubmitResult =
  | { printerJobId: string; status: "accepted" }
  | { status: "duplicate" }
  | { code: string; status: "rejected" }
  | { reason: string; status: "unknown" };

export interface PrinterClient {
  submit(job: PrinterJob): Promise<PrinterSubmitResult>;
}

export function toSnapwearJobBody(job: PrinterJob): SnapwearJobBody {
  const body: SnapwearJobBody = {
    artworks: job.artworks.map((artwork) => ({ url: artwork.url })),
    items: job.items.map((item) => ({ quantity: item.quantity, sku: item.sku })),
    job_id: job.jobId,
    layouts: job.artworks.map((artwork) => ({ location: artwork.location })),
    mockups: job.mockupUrls.map((url) => ({ url })),
  };
  if (job.shipTo !== undefined && job.shipTo !== null) {
    body.shipping_address = snapwearShippingAddress(job.shipTo);
  }
  return body;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A SnapWear-shaped HTTP answer → PrinterSubmitResult. Written against the
 * fake's responses, which mirror what is known of SnapWear's; the real client
 * (A6) reuses it once the provisional parts of snapwear-wire.ts are confirmed.
 */
export async function classifyPrinterResponse(
  response: Response,
): Promise<PrinterSubmitResult> {
  let body: unknown = null;
  try {
    body = await response.json<unknown>();
  } catch {
    body = null;
  }
  const record = isPlainObject(body) ? body : {};

  if (response.ok) {
    return typeof record.id === "string" &&
      record.id.length > 0 &&
      record.status === "accepted"
      ? { printerJobId: record.id, status: "accepted" }
      : { reason: "malformed_response", status: "unknown" };
  }

  const status = response.status;
  if (status === 400 && record.message === SNAPWEAR_DUPLICATE_JOB_MESSAGE) {
    return { status: "duplicate" };
  }
  if (status === 422) {
    return { code: "validation_failed", status: "rejected" };
  }
  if (
    (status >= 300 && status < 400) ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  ) {
    return { reason: `http_${status}`, status: "unknown" };
  }

  return { code: status === 400 ? "bad_request" : `http_${status}`, status: "rejected" };
}

/**
 * The HTTP seam, same convention as RESEND_FETCH_OVERRIDE: a plain Symbol, so
 * only code that imports it can inject a fetch, and a deployed worker never
 * does.
 */
export const FAKE_PRINTER_FETCH_OVERRIDE: unique symbol = Symbol(
  "meteorshop.test.fakePrinterFetch",
);

export type PrinterFetch = (request: Request) => Promise<Response>;

const SUBMIT_TIMEOUT_MS = 30_000;

/**
 * The DEFAULT transport hands the request straight to the fake printer's own
 * route handler in this isolate — still a full Request/Response round trip
 * through the route's auth, validation and status codes, but without leaving
 * the Worker. A `fetch` from a Worker to its own hostname is not a dependable
 * transport (Cloudflare treats same-zone Worker-to-Worker subrequests specially
 * and points to service bindings for them; not verified here), and the fake
 * exists to exercise the dispatcher, not the network. Tests also inject a fetch
 * that goes through the public entrypoint.
 */
function resolveFakePrinterFetch(env: Env): PrinterFetch {
  const override = (env as unknown as Record<PropertyKey, unknown>)[
    FAKE_PRINTER_FETCH_OVERRIDE
  ];
  return typeof override === "function"
    ? (override as PrinterFetch)
    : (request) => handleFakePrinterRoute(env, request);
}

export function createFakePrinterClient(env: Env): PrinterClient {
  if (!isFakePrinterEnabled(env)) {
    // resolvePrinterClient gates first; a caller that skips it fails loudly.
    throw new Error("fake printer is not enabled");
  }

  const send = resolveFakePrinterFetch(env);
  const url = new URL(FAKE_PRINTER_JOBS_PATH, env.AUTH_BASE_URL).toString();
  const token = env.FAKE_PRINTER_TOKEN as string;

  return {
    async submit(job: PrinterJob): Promise<PrinterSubmitResult> {
      let response: Response;
      try {
        response = await send(
          new Request(url, {
            body: JSON.stringify(toSnapwearJobBody(job)),
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            method: "POST",
            // Never follow a redirect with the bearer attached. ("error" is not
            // supported by workerd; a 3xx comes back and is classified.)
            redirect: "manual",
            signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
          }),
        );
      } catch {
        return { reason: "network", status: "unknown" };
      }

      return classifyPrinterResponse(response);
    },
  };
}

/**
 * SnapWear itself — NOT BUILT (LAUNCH_TODO A5/A6, PLAN CP6: "never a stub in
 * production" — this stub can only throw, so a production dispatcher that
 * reached it fails loudly instead of pretending to submit).
 */
export const snapwearClient: PrinterClient = {
  submit(): Promise<PrinterSubmitResult> {
    return Promise.reject(new Error("not_implemented"));
  },
};

/**
 * The client for this environment's DISPATCH_TARGET, or null when none can be
 * built (unset or unknown target, or the fake outside staging / without its
 * token) — the dispatcher then holds its work rather than guessing.
 */
export function resolvePrinterClient(env: Env): PrinterClient | null {
  switch (env.DISPATCH_TARGET) {
    case "fake-printer":
      return isFakePrinterEnabled(env) ? createFakePrinterClient(env) : null;
    case "snapwear":
      return snapwearClient;
    default:
      return null;
  }
}
