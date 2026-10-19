import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configuredProviders, type PrinterJob, resolveProviderClient } from "../src/dispatch/printer-client";
import { PRINTER_SUBMIT_TIMEOUT_MS } from "../src/dispatch/printer-transport";
import {
  createProdigiClient,
  PRODIGI_FETCH_OVERRIDE,
  prodigiSubmitConfig,
  type ProdigiSubmitConfig,
} from "../src/dispatch/prodigi-client";
import {
  classifyProdigiResponse,
  prodigiRecipient,
  splitProdigiSkuKey,
  toProdigiOrderBody,
} from "../src/dispatch/prodigi-wire";

/**
 * CP11 unit U12 — the Prodigi client (D2 gate, D6 wire and classifier).
 *
 * No test reaches the network: every Prodigi answer comes from a fetch
 * injected through PRODIGI_FETCH_OVERRIDE (and vitest.config.ts's
 * outboundService refuses anything that would escape it). The keys below are
 * shaped like Prodigi's (a `test_` sandbox prefix, or none) and are not real.
 */

const SANDBOX = "https://api.sandbox.prodigi.com";
const LIVE = "https://api.prodigi.com";
const SANDBOX_KEY = "test_only-not-a-real-prodigi-key-0000";
const LIVE_KEY = "live-only-not-a-real-prodigi-key-0000";
const AUTH_BASE = "https://chopshop-api-stg.test.invalid";

const STAGING_PRODIGI: Record<PropertyKey, unknown> = {
  APP_ENV: "staging",
  AUTH_BASE_URL: AUTH_BASE,
  PRODIGI_API_BASE_URL: SANDBOX,
  PRODIGI_API_TOKEN: SANDBOX_KEY,
  PRODIGI_SUBMIT_ENABLED: "true",
};

const PRODUCTION_PRODIGI: Record<PropertyKey, unknown> = {
  ...STAGING_PRODIGI,
  APP_ENV: "production",
  PRODIGI_API_BASE_URL: LIVE,
  PRODIGI_API_TOKEN: LIVE_KEY,
};

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

const SHIP_TO = {
  addressLine1: "Storgatan 1",
  addressLine2: null,
  city: "Klippan",
  country: "SE",
  name: "Test Köpare",
  phone: null,
  postalCode: "264 33",
};

/** A two-line order job (the order unit's shape: jobId = orderId). */
function twoLineJob(overrides: Partial<PrinterJob> = {}): PrinterJob {
  const orderId = "0e3b8f0a-1111-4222-8333-444455556666";
  return {
    jobId: orderId,
    lines: [
      {
        artworks: [{ location: "front", url: "https://r2.test.invalid/l1-front.png?X-Amz-Signature=a" }],
        lineNo: 1,
        mockupUrls: [],
        quantity: 1,
        sku: "GLOBAL-TEE-GIL-64000.black.m",
      },
      {
        artworks: [
          { location: "front", url: "https://r2.test.invalid/l2-front.png?X-Amz-Signature=b" },
          { location: "back", url: "https://r2.test.invalid/l2-back.png?X-Amz-Signature=c" },
        ],
        lineNo: 3,
        mockupUrls: [],
        quantity: 2,
        sku: "GLOBAL-HOOD-GIL-18500.heather-navy.2xl",
      },
    ],
    orderId,
    shipTo: SHIP_TO,
    ...overrides,
  };
}

interface Recorded {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  redirect: string;
  signal: boolean;
  url: string;
}

function fakeProdigi(answers: Array<(() => Response) | Error>) {
  const calls: Recorded[] = [];
  let index = 0;
  const fetcher = async (request: Request): Promise<Response> => {
    calls.push({
      body: await request.clone().json(),
      headers: Object.fromEntries(request.headers),
      method: request.method,
      redirect: request.redirect,
      signal: request.signal instanceof AbortSignal,
      url: request.url,
    });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer === undefined) {
      throw new Error("no scripted answer");
    }
    return answer();
  };
  return { calls, fetcher };
}

const created = (id = "ord_1186010", outcome = "Created") => () =>
  Response.json({ order: { id, status: { stage: "InProgress" } }, outcome }, { status: 200 });

function client(fetcher: (request: Request) => Promise<Response>, overrides: Record<PropertyKey, unknown> = {}) {
  const target = envWith({ ...STAGING_PRODIGI, [PRODIGI_FETCH_OVERRIDE]: fetcher, ...overrides });
  const config = prodigiSubmitConfig(target) as ProdigiSubmitConfig;
  return createProdigiClient(target, config);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the gate (D2): every condition on its own, and the environment pairing", () => {
  it("staging builds it with the sandbox origin and a test_ key; production with the live origin and a live key", () => {
    expect(prodigiSubmitConfig(envWith(STAGING_PRODIGI))).toStrictEqual({
      callbackUrl: `${AUTH_BASE}/v1/webhooks/prodigi`,
      origin: SANDBOX,
      token: SANDBOX_KEY,
    });
    expect(prodigiSubmitConfig(envWith(PRODUCTION_PRODIGI))).toStrictEqual({
      callbackUrl: `${AUTH_BASE}/v1/webhooks/prodigi`,
      origin: LIVE,
      token: LIVE_KEY,
    });
    // A trailing slash on the origin is the same origin.
    expect(prodigiSubmitConfig(envWith({ ...STAGING_PRODIGI, PRODIGI_API_BASE_URL: `${SANDBOX}/` }))?.origin).toBe(SANDBOX);
    // The registry: an order-unit client, and the provider listed as configured.
    expect(resolveProviderClient(envWith(STAGING_PRODIGI), "prodigi")?.unit).toBe("order");
    expect(configuredProviders(envWith(STAGING_PRODIGI))).toContain("prodigi");
    expect(configuredProviders(envWith({ ...STAGING_PRODIGI, PRODIGI_SUBMIT_ENABLED: undefined }))).not.toContain("prodigi");
  });

  const REFUSED: Array<[string, Record<PropertyKey, unknown>]> = [
    // The pairing, crosswise.
    ["a LIVE key on staging", { PRODIGI_API_TOKEN: LIVE_KEY }],
    ["the LIVE host on staging", { PRODIGI_API_BASE_URL: LIVE }],
    ["the live host and a live key on staging", { PRODIGI_API_BASE_URL: LIVE, PRODIGI_API_TOKEN: LIVE_KEY }],
    ["a test_ key in production", { ...PRODUCTION_PRODIGI, PRODIGI_API_TOKEN: SANDBOX_KEY }],
    ["the sandbox host in production", { ...PRODUCTION_PRODIGI, PRODIGI_API_BASE_URL: SANDBOX }],
    ["the sandbox host and a test_ key in production", { ...PRODUCTION_PRODIGI, PRODIGI_API_BASE_URL: SANDBOX, PRODIGI_API_TOKEN: SANDBOX_KEY }],
    ["a TEST_ key (case) on staging", { PRODIGI_API_TOKEN: "TEST_only-not-a-real-prodigi-key-0000" }],
    ["another host on staging", { PRODIGI_API_BASE_URL: "https://api.sandbox.prodigi.com.evil.test" }],
    ["a look-alike host in production", { ...PRODUCTION_PRODIGI, PRODIGI_API_BASE_URL: "https://xapi.prodigi.com" }],
    // The environment.
    ["no APP_ENV", { APP_ENV: undefined }],
    ["APP_ENV mis-cased", { APP_ENV: "Staging" }],
    ["another APP_ENV", { APP_ENV: "development" }],
    // The switch.
    ["no switch", { PRODIGI_SUBMIT_ENABLED: undefined }],
    ["switch false", { PRODIGI_SUBMIT_ENABLED: "false" }],
    ["switch TRUE", { PRODIGI_SUBMIT_ENABLED: "TRUE" }],
    ["switch 1", { PRODIGI_SUBMIT_ENABLED: "1" }],
    ["switch with a space", { PRODIGI_SUBMIT_ENABLED: "true " }],
    // The origin.
    ["no base URL", { PRODIGI_API_BASE_URL: undefined }],
    ["an http base URL", { PRODIGI_API_BASE_URL: "http://api.sandbox.prodigi.com" }],
    ["a base URL with the API path", { PRODIGI_API_BASE_URL: `${SANDBOX}/v4.0` }],
    ["a base URL with a query", { PRODIGI_API_BASE_URL: `${SANDBOX}/?x=1` }],
    ["a base URL with credentials", { PRODIGI_API_BASE_URL: "https://u:p@api.sandbox.prodigi.com" }],
    ["a base URL with a port", { PRODIGI_API_BASE_URL: "https://api.sandbox.prodigi.com:8443" }],
    ["a base URL that is not a URL", { PRODIGI_API_BASE_URL: "api.sandbox.prodigi.com" }],
    // The key.
    ["no key", { PRODIGI_API_TOKEN: undefined }],
    ["an empty key", { PRODIGI_API_TOKEN: "" }],
    ["a short key", { PRODIGI_API_TOKEN: "test_short" }],
    ["a key with a space", { PRODIGI_API_TOKEN: "test_only not-a-real-prodigi-key-0000" }],
    ["a key with a line break", { PRODIGI_API_TOKEN: "test_only-not-a-real\r\nx-evil: 1" }],
    // The callback.
    ["an http AUTH_BASE_URL", { AUTH_BASE_URL: "http://chopshop-api-stg.test.invalid" }],
    ["no AUTH_BASE_URL", { AUTH_BASE_URL: undefined }],
  ];

  for (const [label, overrides] of REFUSED) {
    it(`is null with ${label}`, () => {
      const target = envWith({ ...STAGING_PRODIGI, ...overrides });
      expect(prodigiSubmitConfig(target)).toBeNull();
      expect(resolveProviderClient(target, "prodigi")).toBeNull();
    });
  }

  it("a stale DISPATCH_TARGET changes nothing (D1: the var is read by no code)", () => {
    for (const value of ["snapwear", "fake-printer", undefined]) {
      expect(prodigiSubmitConfig(envWith({ ...STAGING_PRODIGI, DISPATCH_TARGET: value }))).not.toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the wire (D6)", () => {
  it("POSTs ONE order for a two-line job: the exact body, X-API-Key, JSON, no redirect, a timeout", async () => {
    const prodigi = fakeProdigi([created()]);
    const result = await client(prodigi.fetcher).submit(twoLineJob());

    expect(result).toStrictEqual({ printerJobId: "ord_1186010", status: "accepted" });
    expect(prodigi.calls).toHaveLength(1);
    const call = prodigi.calls[0]!;
    expect(call).toMatchObject({ method: "POST", redirect: "manual", signal: true, url: `${SANDBOX}/v4.0/orders` });
    expect(call.headers).toStrictEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": SANDBOX_KEY,
    });
    expect(call.body).toStrictEqual({
      callbackUrl: `${AUTH_BASE}/v1/webhooks/prodigi`,
      idempotencyKey: "0e3b8f0a-1111-4222-8333-444455556666",
      items: [
        {
          assets: [{ printArea: "front", url: "https://r2.test.invalid/l1-front.png?X-Amz-Signature=a" }],
          attributes: { color: "black", size: "m" },
          copies: 1,
          merchantReference: "1",
          sizing: "fitPrintArea",
          sku: "GLOBAL-TEE-GIL-64000",
        },
        {
          assets: [
            { printArea: "front", url: "https://r2.test.invalid/l2-front.png?X-Amz-Signature=b" },
            { printArea: "back", url: "https://r2.test.invalid/l2-back.png?X-Amz-Signature=c" },
          ],
          attributes: { color: "heather navy", size: "2xl" },
          copies: 2,
          merchantReference: "3",
          sizing: "fitPrintArea",
          sku: "GLOBAL-HOOD-GIL-18500",
        },
      ],
      merchantReference: "0e3b8f0a-1111-4222-8333-444455556666",
      recipient: {
        address: { countryCode: "SE", line1: "Storgatan 1", postalOrZipCode: "264 33", townOrCity: "Klippan" },
        name: "Test Köpare",
      },
      shippingMethod: "Standard",
    });
    // Never sent: branding, the buyer's e-mail, metadata.
    const text = JSON.stringify(call.body);
    for (const key of ["branding", "email", "metadata", "stateOrCounty"]) {
      expect(text).not.toContain(key);
    }
  });

  it("the recipient: line2 and the phone only when given, never null", () => {
    expect(prodigiRecipient({ ...SHIP_TO, addressLine2: "lgh 1102", phone: "+46 70 123 45 67" })).toStrictEqual({
      address: { countryCode: "SE", line1: "Storgatan 1", line2: "lgh 1102", postalOrZipCode: "264 33", townOrCity: "Klippan" },
      name: "Test Köpare",
      phoneNumber: "+46 70 123 45 67",
    });
    expect(prodigiRecipient({ ...SHIP_TO, addressLine2: "  ", phone: "" })).toStrictEqual({
      address: { countryCode: "SE", line1: "Storgatan 1", postalOrZipCode: "264 33", townOrCity: "Klippan" },
      name: "Test Köpare",
    });
  });

  it("splits our SKU key into Prodigi's SKU, colour and size (U4's key)", () => {
    expect(splitProdigiSkuKey("GLOBAL-TEE-GIL-64000.heather-navy.2xl")).toStrictEqual({
      color: "heather navy",
      size: "2xl",
      sku: "GLOBAL-TEE-GIL-64000",
    });
    expect(splitProdigiSkuKey("TEE-SS-STTU755.black.m")).toStrictEqual({ color: "black", size: "m", sku: "TEE-SS-STTU755" });
    // Middle part: everything between the FIRST and the LAST dot.
    expect(splitProdigiSkuKey("A.b.c.d")).toStrictEqual({ color: "b.c", size: "d", sku: "A" });
    for (const bad of ["GLOBAL-TEE-GIL-64000", "GLOBAL-TEE-GIL-64000.black", ".black.m", "A..m", "A.black.", "A.-.m", "2700003", ""]) {
      expect(splitProdigiSkuKey(bad), bad).toBeNull();
    }
    const job = twoLineJob();
    expect(toProdigiOrderBody({ ...job, lines: [{ ...job.lines[0]!, sku: "GLOBAL-TEE-GIL-64000" }], shipTo: SHIP_TO }, "https://x.test/")).toBeNull();
  });

  it("a line whose SKU key does not split is refused sku_invalid, before any call", async () => {
    const prodigi = fakeProdigi([created()]);
    const job = twoLineJob();
    const bad = { ...job, lines: [job.lines[0]!, { ...job.lines[1]!, sku: "2700003" }] };
    expect(await client(prodigi.fetcher).submit(bad)).toStrictEqual({ code: "sku_invalid", status: "rejected" });
    expect(prodigi.calls).toHaveLength(0);
  });

  it("a collected order (no parcel address) is refused ship_to_missing, before any call", async () => {
    const prodigi = fakeProdigi([created()]);
    for (const shipTo of [null, undefined]) {
      expect(await client(prodigi.fetcher).submit(twoLineJob({ shipTo }))).toStrictEqual({
        code: "ship_to_missing",
        status: "rejected",
      });
    }
    expect(await client(prodigi.fetcher).submit(twoLineJob({ lines: [] }))).toStrictEqual({
      code: "no_lines",
      status: "rejected",
    });
    expect(prodigi.calls).toHaveLength(0);
  });

  it("never follows a redirect: the 3xx itself is classified unknown", async () => {
    const prodigi = fakeProdigi([() => new Response(null, { headers: { location: "https://elsewhere.test.invalid/" }, status: 307 })]);
    expect(await client(prodigi.fetcher).submit(twoLineJob())).toStrictEqual({ reason: "http_307", status: "unknown" });
    expect(prodigi.calls).toHaveLength(1);
    expect(prodigi.calls[0]?.redirect).toBe("manual");
  });

  it("the timeout: 30 s on the request's signal; a timed-out or failed fetch is unknown network", async () => {
    expect(PRINTER_SUBMIT_TIMEOUT_MS).toBe(30_000);
    const signals: AbortSignal[] = [];
    const timedOut = await client(async (request) => {
      signals.push(request.signal);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }).submit(twoLineJob());
    expect(timedOut).toStrictEqual({ reason: "network", status: "unknown" });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("never puts the key, the host or an asset address in a result or a log line", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const results = [];
    for (const answer of [
      new Error(`connect failed to ${SANDBOX} with ${SANDBOX_KEY}`),
      () => new Response(`<html>${SANDBOX_KEY}</html>`, { status: 500 }),
      () => Response.json({ outcome: "ValidationFailed", failures: { "recipient.name": [] } }, { status: 400 }),
    ]) {
      results.push(await client(fakeProdigi([answer]).fetcher).submit(twoLineJob()));
    }
    const text = JSON.stringify(results) + logged.join("\n");
    for (const secret of [SANDBOX_KEY, "sandbox.prodigi.com", "r2.test.invalid"]) {
      expect(text).not.toContain(secret);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the classifier (D6; outcomes read case-insensitively)", () => {
  const order = (id: unknown, outcome: string) => ({ order: { id }, outcome });
  const TABLE: Array<[string, number, unknown, unknown]> = [
    ["Created (sandbox, PascalCase)", 200, order("ord_1186010", "Created"), { printerJobId: "ord_1186010", status: "accepted" }],
    ["created (reference, camelCase)", 200, order("ord_42", "created"), { printerJobId: "ord_42", status: "accepted" }],
    ["CreatedWithIssues (the order exists)", 200, order("ord_43", "CreatedWithIssues"), { printerJobId: "ord_43", status: "accepted" }],
    ["onHold (the order exists)", 200, order("ord_44", "onHold"), { printerJobId: "ord_44", status: "accepted" }],
    ["AlreadyExists with the order", 200, order("ord_1186010", "AlreadyExists"), { printerJobId: "ord_1186010", status: "duplicate" }],
    ["alreadyExists without a readable order", 200, { outcome: "alreadyExists" }, { status: "duplicate" }],
    ["ValidationFailed on a 200", 200, { issues: [{ errorCode: "items.sku.NotFound" }], outcome: "ValidationFailed" }, { code: "items.sku.NotFound", status: "rejected" }],
    ["400 with failures", 400, { failures: { "recipient.address.countryCode": [{ code: "Invalid" }] }, outcome: "ValidationFailed" }, { code: "recipient.address.countryCode", status: "rejected" }],
    ["400 without a body we can read", 400, null, { code: "validation_failed", status: "rejected" }],
    ["422", 422, { outcome: "validationFailed" }, { code: "validation_failed", status: "rejected" }],
    ["409", 409, null, { code: "http_409", status: "rejected" }],
    ["401 (our key)", 401, null, { reason: "http_401", status: "unknown" }],
    ["403", 403, null, { reason: "http_403", status: "unknown" }],
    ["404 (our configuration)", 404, null, { reason: "http_404", status: "unknown" }],
    ["408", 408, null, { reason: "http_408", status: "unknown" }],
    ["429", 429, null, { reason: "http_429", status: "unknown" }],
    ["500", 500, null, { reason: "http_500", status: "unknown" }],
    ["503", 503, { outcome: "Created", order: { id: "ord_1" } }, { reason: "http_503", status: "unknown" }],
    ["302", 302, null, { reason: "http_302", status: "unknown" }],
    ["a 200 that is not JSON", 200, null, { reason: "malformed_response", status: "unknown" }],
    ["a 200 without an outcome", 200, { order: { id: "ord_1" } }, { reason: "malformed_response", status: "unknown" }],
    ["Created without an order id", 200, { outcome: "Created" }, { reason: "malformed_response", status: "unknown" }],
    ["Created with a numeric id", 200, order(1186010, "Created"), { reason: "malformed_response", status: "unknown" }],
    ["Created with an id that is not ord_", 200, order("1186010", "Created"), { reason: "malformed_response", status: "unknown" }],
    ["Created with an over-long id", 200, order(`ord_${"9".repeat(80)}`, "Created"), { reason: "malformed_response", status: "unknown" }],
    ["an outcome we do not know", 200, order("ord_1", "EntityNotFound"), { reason: "unexpected_outcome", status: "unknown" }],
  ];

  for (const [label, status, body, expected] of TABLE) {
    it(`classifies ${label}`, () => {
      expect(classifyProdigiResponse(status, body)).toStrictEqual(expected);
    });
  }

  it("classifies through the client, a malformed body included", async () => {
    expect(await client(fakeProdigi([() => new Response("not json", { status: 200 })]).fetcher).submit(twoLineJob())).toStrictEqual({
      reason: "malformed_response",
      status: "unknown",
    });
    expect(await client(fakeProdigi([created("ord_9", "AlreadyExists")]).fetcher).submit(twoLineJob())).toStrictEqual({
      printerJobId: "ord_9",
      status: "duplicate",
    });
    expect(await client(fakeProdigi([new TypeError("network down")]).fetcher).submit(twoLineJob())).toStrictEqual({
      reason: "network",
      status: "unknown",
    });
  });

  it("a refusal code is bounded and stored-safe, never a message", () => {
    const long = classifyProdigiResponse(400, { issues: [{ errorCode: `x y/${"z".repeat(200)}` }] });
    expect(long.status === "rejected" && long.code.length).toBeLessThanOrEqual(60);
    expect(long.status === "rejected" && /^[A-Za-z0-9_.:-]+$/.test(long.code)).toBe(true);
  });
});
