/**
 * The container's client for the API's /v1/render surface.
 *
 * Authenticated by `Authorization: Bearer <RENDER_FARM_TOKEN>` over TLS to the
 * API's canonical origin — the same shared secret the API compares in constant
 * time. Nothing here ever logs the token, a URL, or a response body: the acquire
 * body carries a lease token and three capability URLs.
 */
import { ACQUIRE_PATH, reportPath } from "./contract.ts";
import type { FetchLike } from "./transfer.ts";

/** Per request. The API answers in milliseconds; a hung connection must not. */
export const API_TIMEOUT_MS = 30_000;

export type AcquireResult =
  | { body: unknown; kind: "lease" }
  | { kind: "empty" }
  | { code: string; kind: "unavailable"; retryAfterMs: number };

/** A report's outcome: the HTTP status, or "network" when none arrived. */
export type ReportStatus = number | "network";

// How long to back off when acquire cannot be answered. 404 means the surface is
// dark or the token is wrong — configuration, not load — so it waits longest.
const BACKOFF_NETWORK_MS = 10_000;
const BACKOFF_REFUSED_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

// A report is retried only when no answer arrived or the answer was "later".
// complete is idempotent (an exact replay of an accepted completion is 200) and a
// replayed fail is at worst 409, so a retry can never double-apply.
const REPORT_ATTEMPTS = 3;
const REPORT_BACKOFF_MS = [2_000, 5_000] as const;

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
    : BACKOFF_NETWORK_MS;
}

export interface RenderApiOptions {
  apiUrl: string;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  token: string;
}

export class RenderApi {
  readonly #apiUrl: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #token: string;

  constructor(options: RenderApiOptions) {
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch;
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
      response = await this.#post(ACQUIRE_PATH, undefined);
    } catch {
      return { code: "acquire_network", kind: "unavailable", retryAfterMs: BACKOFF_NETWORK_MS };
    }

    if (response.status === 204) {
      return { kind: "empty" };
    }
    if (response.status === 200) {
      try {
        return { body: await response.json(), kind: "lease" };
      } catch {
        return { code: "acquire_bad_body", kind: "unavailable", retryAfterMs: BACKOFF_NETWORK_MS };
      }
    }

    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) {
      return {
        code: "acquire_rate_limited",
        kind: "unavailable",
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      };
    }
    return {
      code: `acquire_status_${response.status}`,
      kind: "unavailable",
      retryAfterMs: response.status === 404 ? BACKOFF_REFUSED_MS : BACKOFF_NETWORK_MS,
    };
  }

  /** POST complete/fail; retried on no answer, 429 and 5xx. Returns the last status. */
  async report(jobId: string, action: "complete" | "fail", body: unknown): Promise<ReportStatus> {
    let status: ReportStatus = "network";
    for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await this.#sleep(REPORT_BACKOFF_MS[attempt - 1] ?? 5_000);
      }
      try {
        const response = await this.#post(reportPath(jobId, action), body);
        await response.body?.cancel().catch(() => undefined);
        status = response.status;
      } catch {
        status = "network";
      }
      if (status !== "network" && status !== 429 && status < 500) {
        return status;
      }
    }
    return status;
  }
}
