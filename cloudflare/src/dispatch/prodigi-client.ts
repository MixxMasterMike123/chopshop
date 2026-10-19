import type { PrinterClient, PrinterJob, PrinterSubmitResult } from "./printer-client";
import {
  bareHttpsOrigin,
  PRINTER_API_TOKEN_PATTERN,
  PRINTER_SUBMIT_TIMEOUT_MS,
  seamFetch,
} from "./printer-transport";
import {
  classifyProdigiResponse,
  PRODIGI_API_KEY_HEADER,
  PRODIGI_CALLBACK_PATH,
  PRODIGI_ORDERS_PATH,
  toProdigiOrderBody,
} from "./prodigi-wire";

/**
 * The Prodigi printer client (CP11, D2/D4/D6). Its unit of work is the ORDER:
 * one Prodigi order carries every dispatchable line of one order of ours
 * (shipping is charged per Prodigi order). The dispatcher assembles that job
 * (dispatch-effect.ts runOrderUnit); this module only gates, sends and
 * classifies — and, for the webhook intake (unit U3, prodigi-intake.ts),
 * reads an order back (readProdigiOrder) under the same gate and transport.
 *
 * Nothing here logs, and no result carries the address, the key or the body:
 * a transport failure is `unknown` "network", whatever its message said (the
 * dispatcher writes reasons and codes into last_error and alert texts).
 */

/** The transport seam, same convention as SNAPWEAR_FETCH_OVERRIDE. */
export const PRODIGI_FETCH_OVERRIDE: unique symbol = Symbol("meteorshop.test.prodigiFetch");

/** The explicit switch's one accepted value (wrangler vars are strings). */
export const PRODIGI_SUBMIT_ENABLED_VALUE = "true";

/** The hosts each environment may send to (D2's pairing). */
export const PRODIGI_SANDBOX_HOST = "api.sandbox.prodigi.com";
export const PRODIGI_LIVE_HOST = "api.prodigi.com";

/** Sandbox keys carry this prefix; a live key never does. */
export const PRODIGI_SANDBOX_KEY_PREFIX = "test_";

export interface ProdigiSubmitConfig {
  /** `{AUTH_BASE_URL}/v1/webhooks/prodigi`: where Prodigi reports the order. */
  callbackUrl: string;
  /** A bare https origin; the path is PRODIGI_ORDERS_PATH. */
  origin: string;
  token: string;
}

/**
 * THE GATE (D2). The client exists only when ALL of these hold, each on its
 * own (test/prodigi-client.test.ts removes them one by one):
 *   1. PRODIGI_SUBMIT_ENABLED is exactly "true";
 *   2. PRODIGI_API_BASE_URL is a bare https origin;
 *   3. PRODIGI_API_TOKEN (a secret) is present and well-formed;
 *   4. the environment pairing — on APP_ENV "staging" the host IS
 *      api.sandbox.prodigi.com and the key starts with "test_"; on
 *      "production" the host IS api.prodigi.com and the key does NOT start
 *      with "test_"; any other APP_ENV builds nothing. A live key can never
 *      reach staging's sandbox (or be sent from staging at all), and a sandbox
 *      key can never place a production order that would silently not print;
 *   5. AUTH_BASE_URL is an https URL, so the per-order callbackUrl points at
 *      this Worker and nowhere else.
 * Otherwise null: resolveProviderClient answers null and the dispatcher HOLDS
 * the job (dispatch-effect.ts parkForPrinter) — never a stub, never a guess.
 */
export function prodigiSubmitConfig(env: Env): ProdigiSubmitConfig | null {
  if (env.PRODIGI_SUBMIT_ENABLED !== PRODIGI_SUBMIT_ENABLED_VALUE) {
    return null;
  }
  const origin = bareHttpsOrigin(env.PRODIGI_API_BASE_URL);
  const token = env.PRODIGI_API_TOKEN;
  if (origin === null || typeof token !== "string" || !PRINTER_API_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const sandboxKey = token.startsWith(PRODIGI_SANDBOX_KEY_PREFIX);
  const paired =
    env.APP_ENV === "staging"
      ? origin.hostname === PRODIGI_SANDBOX_HOST && sandboxKey
      : env.APP_ENV === "production"
        ? origin.hostname === PRODIGI_LIVE_HOST && !sandboxKey
        : false;
  if (!paired) {
    return null;
  }
  let callbackUrl: string;
  try {
    const callback = new URL(PRODIGI_CALLBACK_PATH, env.AUTH_BASE_URL);
    if (callback.protocol !== "https:" || callback.username !== "" || callback.password !== "") {
      return null;
    }
    callbackUrl = callback.toString();
  } catch {
    return null;
  }
  return { callbackUrl, origin: origin.origin, token };
}

/**
 * `POST <origin>/v4.0/orders` with `X-API-Key`, the body from
 * toProdigiOrderBody, no redirect followed, a 30-second timeout, and the
 * answer classified by classifyProdigiResponse.
 */
export function createProdigiClient(env: Env, config: ProdigiSubmitConfig): PrinterClient {
  const send = seamFetch(env, PRODIGI_FETCH_OVERRIDE);
  const url = `${config.origin}${PRODIGI_ORDERS_PATH}`;

  return {
    async submit(job: PrinterJob): Promise<PrinterSubmitResult> {
      const shipTo = job.shipTo;
      if (shipTo === undefined || shipTo === null) {
        // A collected order (or one without a recipient): Prodigi ships every
        // order to an address, and where a pickup order's parcel would go is
        // not agreed. Never sent; the dispatch fails with its alert and a
        // human places it by hand (as for SnapWear).
        return { code: "ship_to_missing", status: "rejected" };
      }
      if (job.lines.length === 0) {
        return { code: "no_lines", status: "rejected" };
      }
      const body = toProdigiOrderBody({ ...job, shipTo }, config.callbackUrl);
      if (body === null) {
        // A line's SKU key is not `<prodigiSku>.<colour>.<size>`: never sent.
        return { code: "sku_invalid", status: "rejected" };
      }

      let response: Response;
      try {
        response = await send(
          new Request(url, {
            body: JSON.stringify(body),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              [PRODIGI_API_KEY_HEADER]: config.token,
            },
            method: "POST",
            // Never follow a redirect with the key attached: a 3xx comes back
            // and is classified `unknown` (our configuration).
            redirect: "manual",
            signal: AbortSignal.timeout(PRINTER_SUBMIT_TIMEOUT_MS),
          }),
        );
      } catch {
        return { reason: "network", status: "unknown" };
      }

      let answer: unknown = null;
      try {
        answer = await response.json<unknown>();
      } catch {
        answer = null;
      }
      return classifyProdigiResponse(response.status, answer);
    },
    unit: "order",
  };
}

// ── the order read-back (CP11 unit U3) ──────────────────────────────────────

/**
 * A Prodigi order id, as the intake accepts it from a callback and sends it
 * back in the read's path: `ord_` and 1–64 ASCII letters/digits (U3 rule 2).
 * The path segment is therefore never anything but those characters.
 */
export const PRODIGI_ORDER_REF_PATTERN = /^ord_[A-Za-z0-9]{1,64}$/;

/**
 * The most of a read-back answer we buffer. An order with a few items and
 * shipments is a few kilobytes; the cap only bounds what a misbehaving
 * upstream could make the Worker hold.
 */
export const PRODIGI_READ_MAX_BYTES = 1_048_576;

/**
 * What a read-back came to:
 *   ok         — 200 with an `order` object whose `id` is the one asked for;
 *   not_found  — 404 (or 400: Prodigi does not know the id under OUR key —
 *                a forged callback, or an order of another account);
 *   failed     — anything else: a network error or timeout, a redirect (never
 *                followed), 401/403 (our key), 408/429/5xx, a 200 that is not
 *                JSON, over the cap, or names another order. The caller asks
 *                Prodigi to retry; nothing was learned.
 * Never carries the key, the URL or the body of a failure.
 */
export type ProdigiOrderRead =
  | { order: Record<string, unknown>; status: "ok" }
  | { status: "failed" }
  | { status: "not_found" };

async function readJsonWithin(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) {
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `GET <origin>/v4.0/orders/{id}` with OUR key — the only source of truth the
 * webhook intake (prodigi-intake.ts) acts on; a callback's own payload is
 * never read for state. Same transport as the submission: the
 * PRODIGI_FETCH_OVERRIDE seam, the gate's config (so the pairing of host and
 * key holds for reads as well), no redirect followed, a 30-second timeout.
 */
export async function readProdigiOrder(
  env: Env,
  config: ProdigiSubmitConfig,
  prodigiOrderId: string,
): Promise<ProdigiOrderRead> {
  if (!PRODIGI_ORDER_REF_PATTERN.test(prodigiOrderId)) {
    return { status: "not_found" };
  }
  const send = seamFetch(env, PRODIGI_FETCH_OVERRIDE);
  let response: Response;
  try {
    response = await send(
      new Request(`${config.origin}${PRODIGI_ORDERS_PATH}/${prodigiOrderId}`, {
        headers: {
          accept: "application/json",
          [PRODIGI_API_KEY_HEADER]: config.token,
        },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PRINTER_SUBMIT_TIMEOUT_MS),
      }),
    );
  } catch {
    return { status: "failed" };
  }
  if (response.status === 404 || response.status === 400) {
    await response.body?.cancel();
    return { status: "not_found" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: "failed" };
  }
  let answer: unknown;
  try {
    answer = await readJsonWithin(response, PRODIGI_READ_MAX_BYTES);
  } catch {
    return { status: "failed" };
  }
  const order =
    typeof answer === "object" && answer !== null && !Array.isArray(answer)
      ? (answer as Record<string, unknown>).order
      : undefined;
  if (
    typeof order !== "object" ||
    order === null ||
    Array.isArray(order) ||
    (order as Record<string, unknown>).id !== prodigiOrderId
  ) {
    return { status: "failed" };
  }
  return { order: order as Record<string, unknown>, status: "ok" };
}
