/**
 * The container's client for the API's /v1/render surface.
 *
 * Authenticated by `Authorization: Bearer <RENDER_FARM_TOKEN>` over TLS to the
 * API's canonical origin — the same shared secret the API compares in constant
 * time. Nothing here ever logs the token, a URL, or a response body: the acquire
 * body carries a lease token and three capability URLs.
 */
import { ACQUIRE_BODY, ACQUIRE_PATH, canvasReportPath, reportPath } from "./contract.ts";
import type { FetchLike } from "./transfer.ts";

/** Per request. The API answers in milliseconds; a hung connection must not. */
export const API_TIMEOUT_MS = 30_000;

/**
 * `mayHaveLeased`: the API may have leased a job to this container although no
 * lease reached it — the request went out and no usable answer came back (no
 * answer, an unreadable 200, a 5xx after the lease batch committed). The loop then
 * keeps polling until such a lease must have expired (worker.ts, the lease hold).
 * A 429 / 404 / other 4xx is decided before acquire touches D1: nothing leased.
 */
export type AcquireResult =
  | { body: unknown; kind: "lease" }
  | { kind: "empty" }
  | { code: string; kind: "unavailable"; mayHaveLeased: boolean; retryAfterMs: number };

/** A report's outcome: the HTTP status, or "network" when none arrived. */
export type ReportStatus = number | "network";

/**
 * Failures that happen while CONNECTING — DNS, a refused or unreachable host, a
 * TLS handshake the client rejects, undici's connect timeout — happen before a
 * byte of the request is sent, so an acquire that failed this way cannot have
 * leased anything. Every other failure (a reset or timeout after sending) may
 * have. Codes as Node's fetch reports them on `error.cause.code` (probed: a
 * refused connection → ECONNREFUSED, also on the AggregateError of a dual-stack
 * host; DNS → ENOTFOUND; a socket dropped after the request → UND_ERR_SOCKET).
 */
const NEVER_SENT_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function mayHaveBeenSent(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const code =
    typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return !(typeof code === "string" && NEVER_SENT_CODES.has(code));
}

/** No answer, "later" (429) or a server error: the report did not land (yet). */
export function isUnsettled(status: ReportStatus): boolean {
  return status === "network" || status === 429 || status >= 500;
}

// How long to back off when acquire cannot be answered. 404 means the surface is
// dark or the token is wrong — configuration, not load — so it waits longest.
const BACKOFF_NETWORK_MS = 10_000;
const BACKOFF_REFUSED_MS = 30_000;
/** A Retry-After longer than this is not believed (the API's window is 60 s). */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Between report attempts when the answer carried no Retry-After: 2 s, 5 s, then
 * 10 s for as long as the lease lasts. complete is idempotent (an exact replay of
 * an accepted completion is 200) and a replayed fail is at worst 409, so a retry
 * can never double-apply.
 */
export const REPORT_BACKOFF_MS = [2_000, 5_000, 10_000] as const;

function retryAfterMs(header: string | null, fallback: number): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
    : fallback;
}

export interface RenderApiOptions {
  apiUrl: string;
  fetch: FetchLike;
  now?: () => number;
  sleep: (ms: number) => Promise<void>;
  token: string;
}

export class RenderApi {
  readonly #apiUrl: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #token: string;

  constructor(options: RenderApiOptions) {
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep;
    this.#token = options.token;
  }

  async #post(path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return this.#fetch(`${this.#apiUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  }

  async acquire(): Promise<AcquireResult> {
    let response: Response;
    try {
      // CP6-PS2: names the kinds this image renders; an API before CP6-PS2
      // ignores the body and serves artwork jobs as it always has.
      response = await this.#post(ACQUIRE_PATH, ACQUIRE_BODY);
    } catch (error) {
      const sent = mayHaveBeenSent(error);
      return {
        // `unreachable`: never sent, so a misconfigured or down API still lets the
        // loop disarm on its idle clock instead of holding forever.
        code: sent ? "acquire_network" : "acquire_unreachable",
        kind: "unavailable",
        mayHaveLeased: sent,
        retryAfterMs: BACKOFF_NETWORK_MS,
      };
    }

    if (response.status === 204) {
      return { kind: "empty" };
    }
    if (response.status === 200) {
      try {
        return { body: await response.json(), kind: "lease" };
      } catch {
        return {
          code: "acquire_bad_body",
          kind: "unavailable",
          mayHaveLeased: true,
          retryAfterMs: BACKOFF_NETWORK_MS,
        };
      }
    }

    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) {
      return {
        code: "acquire_rate_limited",
        kind: "unavailable",
        mayHaveLeased: false,
        retryAfterMs: retryAfterMs(response.headers.get("retry-after"), BACKOFF_NETWORK_MS),
      };
    }
    return {
      code: `acquire_status_${response.status}`,
      kind: "unavailable",
      mayHaveLeased: response.status >= 500,
      retryAfterMs: response.status === 404 ? BACKOFF_REFUSED_MS : BACKOFF_NETWORK_MS,
    };
  }

  /**
   * POST complete/fail. Always one attempt; then retried on no answer, 429 (after
   * its Retry-After, capped) and 5xx for as long as the next attempt would still
   * start before `deadlineMs` — the lease's end less a margin, after which the API
   * refuses the report anyway. Returns the last status; an unsettled one means the
   * report was abandoned and the job stays leased until its lease expires.
   */
  async report(
    jobId: string,
    action: "complete" | "fail",
    body: unknown,
    deadlineMs: number,
    kind: "artwork" | "canvas" = "artwork",
  ): Promise<ReportStatus> {
    const path = kind === "canvas" ? canvasReportPath(jobId, action) : reportPath(jobId, action);
    for (let attempt = 0; ; attempt += 1) {
      const backoff = REPORT_BACKOFF_MS[Math.min(attempt, REPORT_BACKOFF_MS.length - 1)] as number;
      let status: ReportStatus;
      let waitMs = backoff;
      try {
        const response = await this.#post(path, body);
        await response.body?.cancel().catch(() => undefined);
        status = response.status;
        if (status === 429) {
          waitMs = retryAfterMs(response.headers.get("retry-after"), backoff);
        }
      } catch {
        status = "network";
      }

      if (!isUnsettled(status) || this.#now() + waitMs >= deadlineMs) {
        return status;
      }
      await this.#sleep(waitMs);
    }
  }
}
