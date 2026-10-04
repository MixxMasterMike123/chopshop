import { handleFakePrinterRoute } from "../routes/fake-printer";
import { FAKE_PRINTER_JOBS_PATH, isFakePrinterEnabled } from "./fake-printer";
import type { PrintLocation, SnapwearJobBody } from "./snapwear-wire";
import {
  SNAPWEAR_DUPLICATE_JOB_MESSAGE,
  SNAPWEAR_ORDER_ADD_PATH,
  SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO,
  SNAPWEAR_TOKEN_HEADER,
  snapwearAcceptedJobRef,
  snapwearShippingAddress,
} from "./snapwear-wire";
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
  /**
   * Always empty today (the dispatcher sends none). PROVISIONAL: SnapWear's
   * `mockups[]` is assumed optional. What would fill it: the line's product
   * mockup images (public `product_media` objects the studio's publish made,
   * CP5-FN2), frozen by object id into the line's production snapshot at
   * checkout and turned into addresses here — the snapshot carries none yet.
   */
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

/**
 * THE ONE PLACE the job body is built (the fake and SnapWear receive the same
 * bytes). PROVISIONAL (to be replaced by A6's API documentation):
 *   - one `items[]` entry per job (one order line = one job), `{ sku, quantity }`;
 *   - `artworks[i]` is printed at `layouts[i].location`: the two arrays are
 *     parallel, front before back;
 *   - C5: SnapWear's `design` field and its neck-label key are optional and
 *     are NOT sent (no keys beyond the ones below);
 *   - `mockups[]` is optional (sent empty, see PrinterJob.mockupUrls);
 *   - `shipping_address` only when the order ships (snapwear-wire.ts).
 */
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
 * (createSnapwearClient) uses it too, so the provisional readings live in ONE
 * place (snapwear-wire.ts: snapwearAcceptedJobRef, SNAPWEAR_DUPLICATE_JOB_MESSAGE).
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
    const printerJobRef = snapwearAcceptedJobRef(body);
    return printerJobRef !== null
      ? { printerJobId: printerJobRef, status: "accepted" }
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

// ── SnapWear (LAUNCH_TODO A6, CP6-PS1) ──────────────────────────────────────

/**
 * The SnapWear transport seam, same convention as FAKE_PRINTER_FETCH_OVERRIDE:
 * only code that imports the symbol can inject a fetch; a deployed worker
 * never does and uses the global fetch.
 */
export const SNAPWEAR_FETCH_OVERRIDE: unique symbol = Symbol("meteorshop.test.snapwearFetch");

/** The explicit switch's one accepted value (wrangler vars are strings). */
export const SNAPWEAR_SUBMIT_ENABLED_VALUE = "true";

export interface SnapwearSubmitConfig {
  /** A bare https origin; the path is SNAPWEAR_ORDER_ADD_PATH. */
  origin: string;
  token: string;
}

/**
 * A bare https origin and nothing else: no credentials, port, path, query or
 * fragment (`https://host` or `https://host/`). Anything else is refused, never
 * repaired, so the token can only ever travel to the host the operator named.
 */
function snapwearOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    return null;
  }
  return url.origin;
}

/**
 * Printable ASCII without spaces, 16–512 characters: a value a header can
 * carry unchanged, and long enough that a placeholder ("x", "changeme") is
 * not mistaken for a credential. SnapWear's own format is not known.
 */
const SNAPWEAR_TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/;

/**
 * THE GATE. The real client exists only when ALL of these hold, each on its
 * own (test/snapwear-client.test.ts removes them one by one):
 *   1. DISPATCH_TARGET is "snapwear";
 *   2. APP_ENV is "production" — staging can never build it, whatever else
 *      it is given;
 *   3. SNAPWEAR_SUBMIT_ENABLED is exactly "true" — the explicit switch, unset
 *      until SnapWear confirms the open answers (LAUNCH_TODO A6, C4–C6);
 *   4. SNAPWEAR_API_BASE_URL is a bare https origin;
 *   5. SNAPWEAR_API_TOKEN (a secret) is present and well-formed.
 * Otherwise null: resolvePrinterClient answers null and the dispatcher HOLDS
 * the job (dispatch-effect.ts parkForPrinter) — never a stub, never a guess.
 */
export function snapwearSubmitConfig(env: Env): SnapwearSubmitConfig | null {
  if (
    env.DISPATCH_TARGET !== "snapwear" ||
    env.APP_ENV !== "production" ||
    env.SNAPWEAR_SUBMIT_ENABLED !== SNAPWEAR_SUBMIT_ENABLED_VALUE
  ) {
    return null;
  }
  const origin = snapwearOrigin(env.SNAPWEAR_API_BASE_URL);
  const token = env.SNAPWEAR_API_TOKEN;
  if (origin === null || typeof token !== "string" || !SNAPWEAR_TOKEN_PATTERN.test(token)) {
    return null;
  }
  return { origin, token };
}

function resolveSnapwearFetch(env: Env): PrinterFetch {
  const override = (env as unknown as Record<PropertyKey, unknown>)[SNAPWEAR_FETCH_OVERRIDE];
  return typeof override === "function"
    ? (override as PrinterFetch)
    : (request) => fetch(request);
}

/**
 * `POST <origin>/api/order/add` with `x-api-token`, the body from
 * toSnapwearJobBody, a 30-second timeout, and the answer classified by
 * classifyPrinterResponse (accepted / duplicate / rejected / unknown).
 *
 * Nothing here logs, and no result carries the address, the token or the
 * body: a transport failure is `unknown` "network", whatever its message said
 * (the dispatcher writes the reason into last_error and alert texts).
 */
export function createSnapwearClient(env: Env, config: SnapwearSubmitConfig): PrinterClient {
  const send = resolveSnapwearFetch(env);
  const url = `${config.origin}${SNAPWEAR_ORDER_ADD_PATH}`;

  return {
    async submit(job: PrinterJob): Promise<PrinterSubmitResult> {
      if ((job.shipTo === undefined || job.shipTo === null) && !SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO) {
        // A collected order (or one without a recipient): where SnapWear
        // would send its parcel is not agreed (snapwear-wire.ts). Never sent.
        return { code: "ship_to_missing", status: "rejected" };
      }

      let response: Response;
      try {
        response = await send(
          new Request(url, {
            body: JSON.stringify(toSnapwearJobBody(job)),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              [SNAPWEAR_TOKEN_HEADER]: config.token,
            },
            method: "POST",
            // Never follow a redirect with the token attached: a 3xx comes
            // back and is classified `unknown` (our configuration).
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
 * The client for this environment's DISPATCH_TARGET, or null when none can be
 * built (unset or unknown target, the fake outside staging / without its
 * token, SnapWear without every condition of snapwearSubmitConfig) — the
 * dispatcher then holds its work rather than guessing.
 */
export function resolvePrinterClient(env: Env): PrinterClient | null {
  switch (env.DISPATCH_TARGET) {
    case "fake-printer":
      return isFakePrinterEnabled(env) ? createFakePrinterClient(env) : null;
    case "snapwear": {
      const config = snapwearSubmitConfig(env);
      return config === null ? null : createSnapwearClient(env, config);
    }
    default:
      return null;
  }
}
