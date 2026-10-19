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
 * classifies.
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
