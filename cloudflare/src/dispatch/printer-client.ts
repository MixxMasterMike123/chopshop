import { handleFakePrinterRoute } from "../routes/fake-printer";
import type { PrinterProvider } from "../pod/printers";
import { FAKE_PRINTER_JOBS_PATH, isFakePrinterEnabled } from "./fake-printer";
import { createProdigiClient, prodigiSubmitConfig } from "./prodigi-client";
import {
  bareHttpsOrigin,
  PRINTER_API_TOKEN_PATTERN,
  PRINTER_SUBMIT_TIMEOUT_MS,
  type PrinterFetch,
  seamFetch,
} from "./printer-transport";
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

export type { PrinterFetch } from "./printer-transport";

/**
 * The printer seam the CP2 dispatch consumer calls (PLAN §2.3).
 *
 * `submit` answers with what the PRINTER decided, as a closed union:
 *
 *   accepted   the printer took the job; `printerJobId` is its reference
 *   duplicate  the printer already has this job id — a previous submission
 *              whose response was lost WAS accepted (SnapWear: duplicate
 *              `job_id` → 400; Prodigi: `AlreadyExists`, which also names
 *              its order, then carried as `printerJobId`). The dispatcher
 *              records it as accepted.
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

/** One order line of a job: what to print, on what, how many. */
export interface PrinterJobLine {
  artworks: Array<{ location: PrintLocation; url: string }>;
  /** item_index + 1 (the outbox payload's lineNo). */
  lineNo: number;
  /**
   * Always empty today (the dispatcher sends none). PROVISIONAL: SnapWear's
   * `mockups[]` is assumed optional. What would fill it: the line's product
   * mockup images (public `product_media` objects the studio's publish made,
   * CP5-FN2), frozen by object id into the line's production snapshot at
   * checkout and turned into addresses here — the snapshot carries none yet.
   */
  mockupUrls: string[];
  quantity: number;
  sku: string;
}

/**
 * One submission (CP11, D5: reshaped once for both units of work).
 *
 *   line-unit printers (SnapWear, the fake): exactly ONE line; `jobId` =
 *     printerJobId(orderId, lineNo), the printer's dedupe key. A job with more
 *     lines is refused `multi_line_job` before any HTTP call, never truncated.
 *   order-unit printers (Prodigi): every dispatchable line of the order;
 *     `jobId` = orderId, the printer's idempotency key (shipping is charged
 *     per printer order, so one order of ours is one order of theirs).
 */
export interface PrinterJob {
  /** Stable for the order (order unit) or the line (line unit). */
  jobId: string;
  lines: PrinterJobLine[];
  orderId: string;
  /**
   * Where the parcel goes (D98): the recipient of a SHIPPED order; null or
   * absent for a collected order and for an order made before 0045.
   */
  shipTo?: ShipTo | null;
}

export type PrinterSubmitResult =
  /**
   * `issueCodes` (CP11 U7, audit F5): the order exists but the printer
   * reported issues that need a human (Prodigi's CreatedWithIssues). The
   * dispatcher accepts it AND raises one alert per code. Absent otherwise.
   */
  | { issueCodes?: string[]; printerJobId: string; status: "accepted" }
  /** `printerJobId` when the printer's answer names the existing job (Prodigi). */
  | { printerJobId?: string; status: "duplicate" }
  | { code: string; status: "rejected" }
  | { reason: string; status: "unknown" };

/**
 * What one submission covers (CP11, D4): ONE order line (SnapWear, the fake:
 * one dispatch row ↔ one printer job), or the whole ORDER (Prodigi: one
 * printer order carries every dispatchable line of ours; the dispatcher's
 * rows stay one per line and the first to submit speaks for its siblings —
 * dispatch-effect.ts runOrderUnit).
 */
export type PrinterUnit = "line" | "order";

export interface PrinterClient {
  submit(job: PrinterJob): Promise<PrinterSubmitResult>;
  unit: PrinterUnit;
}

/** The refusal of a job a line-unit printer cannot take as one job (D5). */
export const MULTI_LINE_JOB: PrinterSubmitResult = { code: "multi_line_job", status: "rejected" };

/**
 * THE ONE PLACE the job body is built (the fake and SnapWear receive the same
 * bytes). PROVISIONAL (to be replaced by A6's API documentation):
 *   - one `items[]` entry per job (one order line = one job), `{ sku, quantity }`;
 *   - `artworks[i]` is printed at `layouts[i].location`: the two arrays are
 *     parallel, front before back;
 *   - C5: SnapWear's `design` field and its neck-label key are optional and
 *     are NOT sent (no keys beyond the ones below);
 *   - `mockups[]` is optional (sent empty, see PrinterJobLine.mockupUrls);
 *   - `shipping_address` only when the order ships (snapwear-wire.ts).
 * CP11 (D5): null unless the job has EXACTLY one line — the caller answers
 * MULTI_LINE_JOB; a second line is never dropped or merged.
 */
export function toSnapwearJobBody(job: PrinterJob): SnapwearJobBody | null {
  const [line] = job.lines;
  if (job.lines.length !== 1 || line === undefined) {
    return null;
  }
  const body: SnapwearJobBody = {
    artworks: line.artworks.map((artwork) => ({ url: artwork.url })),
    items: [{ quantity: line.quantity, sku: line.sku }],
    job_id: job.jobId,
    layouts: line.artworks.map((artwork) => ({ location: artwork.location })),
    mockups: line.mockupUrls.map((url) => ({ url })),
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
      const body = toSnapwearJobBody(job);
      if (body === null) {
        return MULTI_LINE_JOB;
      }
      let response: Response;
      try {
        response = await send(
          new Request(url, {
            body: JSON.stringify(body),
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            method: "POST",
            // Never follow a redirect with the bearer attached. ("error" is not
            // supported by workerd; a 3xx comes back and is classified.)
            redirect: "manual",
            signal: AbortSignal.timeout(PRINTER_SUBMIT_TIMEOUT_MS),
          }),
        );
      } catch {
        return { reason: "network", status: "unknown" };
      }

      return classifyPrinterResponse(response);
    },
    unit: "line",
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
 * THE GATE. The real client exists only when ALL of these hold, each on its
 * own (test/snapwear-client.test.ts removes them one by one):
 *   1. APP_ENV is "production" — staging can never build it, whatever else
 *      it is given;
 *   2. SNAPWEAR_SUBMIT_ENABLED is exactly "true" — the explicit switch, unset
 *      until SnapWear confirms the open answers (LAUNCH_TODO A6, C4–C6);
 *   3. SNAPWEAR_API_BASE_URL is a bare https origin;
 *   4. SNAPWEAR_API_TOKEN (a secret) is present and well-formed.
 * (CP11, D2: the former first condition, DISPATCH_TARGET = "snapwear", went
 * with the var: the printer row's provider now says that the order is
 * SnapWear's, and this gate says whether SnapWear may be called here.)
 * Otherwise null: resolveProviderClient answers null and the dispatcher HOLDS
 * the job (dispatch-effect.ts parkForPrinter) — never a stub, never a guess.
 */
export function snapwearSubmitConfig(env: Env): SnapwearSubmitConfig | null {
  if (env.APP_ENV !== "production" || env.SNAPWEAR_SUBMIT_ENABLED !== SNAPWEAR_SUBMIT_ENABLED_VALUE) {
    return null;
  }
  const origin = bareHttpsOrigin(env.SNAPWEAR_API_BASE_URL);
  const token = env.SNAPWEAR_API_TOKEN;
  if (origin === null || typeof token !== "string" || !PRINTER_API_TOKEN_PATTERN.test(token)) {
    return null;
  }
  return { origin: origin.origin, token };
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
  const send = seamFetch(env, SNAPWEAR_FETCH_OVERRIDE);
  const url = `${config.origin}${SNAPWEAR_ORDER_ADD_PATH}`;

  return {
    async submit(job: PrinterJob): Promise<PrinterSubmitResult> {
      const body = toSnapwearJobBody(job);
      if (body === null) {
        return MULTI_LINE_JOB;
      }
      if ((job.shipTo === undefined || job.shipTo === null) && !SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO) {
        // A collected order (or one without a recipient): where SnapWear
        // would send its parcel is not agreed (snapwear-wire.ts). Never sent.
        return { code: "ship_to_missing", status: "rejected" };
      }

      let response: Response;
      try {
        response = await send(
          new Request(url, {
            body: JSON.stringify(body),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              [SNAPWEAR_TOKEN_HEADER]: config.token,
            },
            method: "POST",
            // Never follow a redirect with the token attached: a 3xx comes
            // back and is classified `unknown` (our configuration).
            redirect: "manual",
            signal: AbortSignal.timeout(PRINTER_SUBMIT_TIMEOUT_MS),
          }),
        );
      } catch {
        return { reason: "network", status: "unknown" };
      }

      return classifyPrinterResponse(response);
    },
    unit: "line",
  };
}

// ── the provider registry (CP11, D1/D2) ─────────────────────────────────────

/**
 * The client of a printer row's PROVIDER (migration 0057), or null when none
 * can be built here — each provider behind its own fail-closed gate:
 *   fake      APP_ENV "staging" AND FAKE_PRINTER_TOKEN ≥ 32 characters
 *             (isFakePrinterEnabled, the fake route's own condition);
 *   snapwear  snapwearSubmitConfig (production only, its switch, origin, token);
 *   prodigi   prodigiSubmitConfig (its switch, origin, token, and the
 *             environment pairing: sandbox host + `test_` key on staging,
 *             live host + live key in production);
 *   manual    never (a manual printer is sent jobs by hand);
 *   anything else (an unknown string) never.
 * Null ⇒ the dispatcher HOLDS the job (dispatch-effect.ts parkForPrinter,
 * `printer_not_configured`) rather than guessing. It replaced the switch on
 * the environment's DISPATCH_TARGET: the order's printer now decides.
 */
export function resolveProviderClient(env: Env, provider: string): PrinterClient | null {
  switch (provider) {
    case "fake":
      return isFakePrinterEnabled(env) ? createFakePrinterClient(env) : null;
    case "snapwear": {
      const config = snapwearSubmitConfig(env);
      return config === null ? null : createSnapwearClient(env, config);
    }
    case "prodigi": {
      const config = prodigiSubmitConfig(env);
      return config === null ? null : createProdigiClient(env, config);
    }
    default:
      return null;
  }
}

/**
 * The providers whose client exists in this environment right now, for the
 * sweeper's release of printer-held jobs (src/outbox/sweeper.ts): a held job
 * becomes due only when ITS printer's provider resolves, never because some
 * other provider does (a release that cannot be served re-parks the row and
 * spends an attempt).
 */
export function configuredProviders(env: Env): PrinterProvider[] {
  const providers: PrinterProvider[] = [];
  for (const provider of ["fake", "snapwear", "prodigi"] as const) {
    if (resolveProviderClient(env, provider) !== null) {
      providers.push(provider);
    }
  }
  return providers;
}
