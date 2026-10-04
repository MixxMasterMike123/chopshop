import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DISPATCH_HOLD_UNTIL_MS, releaseDispatchHolds } from "../src/commerce/dispatch-hold";
import { runReconciliation } from "../src/commerce/crons";
import {
  afterLostAnswer,
  DISPATCH_PRINT_URL_TTL_SECONDS,
  PRINTER_HOLD_UNTIL_MS,
} from "../src/dispatch/dispatch-effect";
import { FAKE_PRINTER_JOBS_PATH } from "../src/dispatch/fake-printer";
import {
  classifyPrinterResponse,
  createSnapwearClient,
  FAKE_PRINTER_FETCH_OVERRIDE,
  type PrinterJob,
  resolvePrinterClient,
  SNAPWEAR_FETCH_OVERRIDE,
  snapwearSubmitConfig,
  toSnapwearJobBody,
} from "../src/dispatch/printer-client";
import {
  printerJobId,
  SNAPWEAR_DUPLICATE_JOB_MESSAGE,
  SNAPWEAR_ORDER_ADD_PATH,
  SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO,
  SNAPWEAR_TOKEN_HEADER,
  snapwearAcceptedJobRef,
  snapwearShippingAddress,
} from "../src/dispatch/snapwear-wire";
import { processOutboxRowById } from "../src/outbox/effects";
import { runOutboxSweep } from "../src/outbox/sweeper";
import { setCommerceCronsLoader } from "../src/outbox/scheduled";
import {
  alertsFor,
  envWith,
  lineRow,
  outboxRow,
  printerJobs,
  quietEnv,
  seedOrder,
  seedTenant,
  SKU,
} from "./dispatch-fixtures";
import { FakeMoneyStripe, moneyEnv, openAlerts } from "./money-fixtures";

/**
 * CP6-PS1 part 1 — the real SnapWear submit client (LAUNCH_TODO A6), built on
 * written assumptions and OFF unless explicitly switched on.
 *
 *   - the gate: five independent conditions, each removed on its own;
 *   - the wire: path, header, body, no redirect, no secret anywhere it could
 *     leak;
 *   - one test per assumption still waiting on SnapWear (the report's "To
 *     confirm with SnapWear" table names the test for each);
 *   - holding: an environment without a client parks the job, spends no
 *     attempt, is alerted by reconciliation after 30 minutes and sends the
 *     job at the first sweep once the client exists.
 *
 * No test reaches the network: every SnapWear answer comes from a fetch
 * injected through SNAPWEAR_FETCH_OVERRIDE (and vitest.config.ts's
 * outboundService refuses anything that would escape it).
 */

const TENANT = "tenant-snapwear-client";
const ORIGIN = "https://api.snapwear.test.invalid";
const TOKEN = "test-only-snapwear-api-token-0123456789";
const MIN = 60 * 1_000;

/** Every SnapWear condition met, in production. */
const PRODUCTION_SNAPWEAR: Record<PropertyKey, unknown> = {
  APP_ENV: "production",
  DISPATCH_TARGET: "snapwear",
  SNAPWEAR_API_BASE_URL: ORIGIN,
  SNAPWEAR_API_TOKEN: TOKEN,
  SNAPWEAR_SUBMIT_ENABLED: "true",
};

interface Recorded {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  redirect: string;
  signal: boolean;
  url: string;
}

/** A fake SnapWear: records each request, answers from the script in order. */
function fakeSnapwear(answers: Array<(() => Response) | Error>) {
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

const accepted = (id = "SW-1001") => () =>
  Response.json({ id, status: "accepted" }, { status: 201 });

function productionEnv(
  fetcher: ((request: Request) => Promise<Response>) | null,
  overrides: Record<PropertyKey, unknown> = {},
): Env {
  return quietEnv({
    ...PRODUCTION_SNAPWEAR,
    ...(fetcher === null ? {} : { [SNAPWEAR_FETCH_OVERRIDE]: fetcher }),
    ...overrides,
  }).env;
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

function job(overrides: Partial<PrinterJob> = {}): PrinterJob {
  const orderId = crypto.randomUUID();
  return {
    artworks: [{ location: "front", url: "https://r2.test.invalid/pod/print/front.png?X-Amz-Signature=abc" }],
    items: [{ quantity: 1, sku: SKU }],
    jobId: printerJobId(orderId, 1),
    mockupUrls: [],
    shipTo: SHIP_TO,
    ...overrides,
  };
}

/** A shipped POD order with its frozen recipient, routed to `printer`. */
async function shippedOrder(printer = "snapwear") {
  const order = await seedOrder(TENANT, { deliveryMethod: "shipping", printer });
  await env.DB.prepare(
    `INSERT INTO order_recipients (
       order_id, tenant_id, delivery_method, name, phone, address_line1,
       address_line2, postal_code, city, country, created_at
     ) VALUES (?, ?, 'shipping', 'Test Köpare', NULL, 'Storgatan 1', NULL, '264 33', 'Klippan', 'SE', ?)`,
  )
    .bind(order.orderId, TENANT, new Date().toISOString())
    .run();
  return order;
}

beforeAll(async () => {
  await seedTenant(TENANT);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM outbox_events").run();
});

afterEach(() => {
  setCommerceCronsLoader(null);
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the gate: the client exists only when every condition holds", () => {
  it("is built with all five, and posts to the named origin", async () => {
    const snapwear = fakeSnapwear([accepted()]);
    const client = resolvePrinterClient(productionEnv(snapwear.fetcher));
    expect(client).not.toBeNull();

    expect(await client?.submit(job())).toStrictEqual({ printerJobId: "SW-1001", status: "accepted" });
    expect(snapwear.calls.map((call) => call.url)).toEqual([`${ORIGIN}${SNAPWEAR_ORDER_ADD_PATH}`]);
    expect(snapwearSubmitConfig(productionEnv(null))).toStrictEqual({ origin: ORIGIN, token: TOKEN });
    // A trailing slash on the origin is the same origin.
    expect(snapwearSubmitConfig(productionEnv(null, { SNAPWEAR_API_BASE_URL: `${ORIGIN}/` }))).toStrictEqual({
      origin: ORIGIN,
      token: TOKEN,
    });
  });

  const MISSING: Array<[string, Record<PropertyKey, unknown>]> = [
    ["staging", { APP_ENV: "staging" }],
    ["no APP_ENV", { APP_ENV: undefined }],
    ["APP_ENV mis-cased", { APP_ENV: "Production" }],
    ["the fake printer as target", { DISPATCH_TARGET: "fake-printer" }],
    ["no DISPATCH_TARGET", { DISPATCH_TARGET: undefined }],
    ["DISPATCH_TARGET mis-cased", { DISPATCH_TARGET: "SnapWear" }],
    ["no switch", { SNAPWEAR_SUBMIT_ENABLED: undefined }],
    ["switch false", { SNAPWEAR_SUBMIT_ENABLED: "false" }],
    ["switch TRUE", { SNAPWEAR_SUBMIT_ENABLED: "TRUE" }],
    ["switch 1", { SNAPWEAR_SUBMIT_ENABLED: "1" }],
    ["switch with a space", { SNAPWEAR_SUBMIT_ENABLED: " true" }],
    ["no base URL", { SNAPWEAR_API_BASE_URL: undefined }],
    ["an http base URL", { SNAPWEAR_API_BASE_URL: "http://api.snapwear.test.invalid" }],
    ["a base URL with a path", { SNAPWEAR_API_BASE_URL: `${ORIGIN}/api` }],
    ["a base URL with a query", { SNAPWEAR_API_BASE_URL: `${ORIGIN}/?x=1` }],
    ["a base URL with a fragment", { SNAPWEAR_API_BASE_URL: `${ORIGIN}/#x` }],
    ["a base URL with credentials", { SNAPWEAR_API_BASE_URL: "https://user:pw@api.snapwear.test.invalid" }],
    ["a base URL with a port", { SNAPWEAR_API_BASE_URL: "https://api.snapwear.test.invalid:8443" }],
    ["a base URL that is not a URL", { SNAPWEAR_API_BASE_URL: "api.snapwear.test.invalid" }],
    ["a mis-cased base URL", { SNAPWEAR_API_BASE_URL: "https://API.snapwear.test.invalid" }],
    ["no token", { SNAPWEAR_API_TOKEN: undefined }],
    ["an empty token", { SNAPWEAR_API_TOKEN: "" }],
    ["a short token", { SNAPWEAR_API_TOKEN: "changeme" }],
    ["a token with a space", { SNAPWEAR_API_TOKEN: "test-only snapwear-api-token-0123456789" }],
    ["a token with a line break", { SNAPWEAR_API_TOKEN: "test-only-snapwear-api-token\r\nx-evil: 1" }],
  ];

  for (const [label, overrides] of MISSING) {
    it(`is null with ${label}`, () => {
      const snapwear = fakeSnapwear([accepted()]);
      const target = productionEnv(snapwear.fetcher, overrides);
      expect(snapwearSubmitConfig(target)).toBeNull();
      // No client at all (the fake exists only on staging pointed at it).
      expect(resolvePrinterClient(target)).toBeNull();
    });
  }

  it("staging NEVER builds it, even given every SnapWear value", async () => {
    const snapwear = fakeSnapwear([accepted()]);
    // Staging pointed at SnapWear: no client at all.
    expect(resolvePrinterClient(productionEnv(snapwear.fetcher, { APP_ENV: "staging" }))).toBeNull();

    // Staging pointed at the fake, with every SnapWear value set as well: the
    // fake answers, SnapWear is never called.
    const fakeCalls: string[] = [];
    const staging = envWith({
      ...PRODUCTION_SNAPWEAR,
      APP_ENV: "staging",
      DISPATCH_TARGET: "fake-printer",
      [FAKE_PRINTER_FETCH_OVERRIDE]: async (request: Request) => {
        fakeCalls.push(new URL(request.url).pathname);
        return Response.json({ id: "fake-1", status: "accepted" }, { status: 201 });
      },
      [SNAPWEAR_FETCH_OVERRIDE]: snapwear.fetcher,
    });
    expect(snapwearSubmitConfig(staging)).toBeNull();
    const client = resolvePrinterClient(staging);
    expect(await client?.submit(job())).toStrictEqual({ printerJobId: "fake-1", status: "accepted" });
    expect(fakeCalls).toEqual([FAKE_PRINTER_JOBS_PATH]);
    expect(snapwear.calls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the wire", () => {
  it("POSTs the job body with x-api-token, JSON, no redirect, a timeout", async () => {
    const snapwear = fakeSnapwear([accepted()]);
    const sent = job();
    await createSnapwearClient(productionEnv(snapwear.fetcher), { origin: ORIGIN, token: TOKEN }).submit(sent);

    expect(snapwear.calls).toHaveLength(1);
    const call = snapwear.calls[0]!;
    expect(call).toMatchObject({
      method: "POST",
      redirect: "manual",
      signal: true,
      url: `${ORIGIN}/api/order/add`,
    });
    expect(call.headers).toStrictEqual({
      accept: "application/json",
      "content-type": "application/json",
      [SNAPWEAR_TOKEN_HEADER]: TOKEN,
    });
    expect(call.body).toStrictEqual(toSnapwearJobBody(sent));
  });

  it("a redirect is never followed: the 3xx itself is classified unknown", async () => {
    const snapwear = fakeSnapwear([
      () => new Response(null, { headers: { location: "https://elsewhere.test.invalid/" }, status: 302 }),
    ]);
    const client = createSnapwearClient(productionEnv(snapwear.fetcher), { origin: ORIGIN, token: TOKEN });
    expect(await client.submit(job())).toStrictEqual({ reason: "http_302", status: "unknown" });
    expect(snapwear.calls).toHaveLength(1);
  });

  it("never puts the token, the address or the body in a result or a log line", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const leaky = new Error(`connect failed to ${ORIGIN}/api/order/add with ${TOKEN}`);
    const sent = job();
    const results = [];
    for (const answer of [leaky, () => new Response("<html>oops</html>", { status: 500 })]) {
      const snapwear = fakeSnapwear([answer]);
      results.push(
        await createSnapwearClient(productionEnv(snapwear.fetcher), { origin: ORIGIN, token: TOKEN }).submit(sent),
      );
    }

    expect(results).toStrictEqual([
      { reason: "network", status: "unknown" },
      { reason: "http_500", status: "unknown" },
    ]);
    const text = JSON.stringify(results) + logged.join("\n");
    for (const secret of [TOKEN, "snapwear.test.invalid", sent.artworks[0]!.url]) {
      expect(text).not.toContain(secret);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("to confirm with SnapWear: one test per assumption", () => {
  it("C4: the print file's address lives 7 days (R2's maximum) — SnapWear may fetch at print time", () => {
    expect(DISPATCH_PRINT_URL_TTL_SECONDS).toBe(604_800);
  });

  it("C5: a 400 is a duplicate ONLY with the assumed message; any other 400 is rejected, never accepted", async () => {
    const duplicate = fakeSnapwear([
      () => Response.json({ message: SNAPWEAR_DUPLICATE_JOB_MESSAGE, status: "error" }, { status: 400 }),
    ]);
    const other = fakeSnapwear([
      () =>
        Response.json(
          { errors: { job_id: ["The job id has already been taken."] }, message: "Bad Request", status: "error" },
          { status: 400 },
        ),
    ]);
    const config = { origin: ORIGIN, token: TOKEN };
    expect(await createSnapwearClient(productionEnv(duplicate.fetcher), config).submit(job())).toStrictEqual({
      status: "duplicate",
    });
    expect(await createSnapwearClient(productionEnv(other.fetcher), config).submit(job())).toStrictEqual({
      code: "bad_request",
      status: "rejected",
    });
  });

  it("C5: neither `design` nor a neck-label key is sent; the body has exactly the known keys", () => {
    expect(Object.keys(toSnapwearJobBody(job())).sort()).toEqual([
      "artworks",
      "items",
      "job_id",
      "layouts",
      "mockups",
      "shipping_address",
    ]);
    expect(Object.keys(toSnapwearJobBody(job({ shipTo: null }))).sort()).toEqual([
      "artworks",
      "items",
      "job_id",
      "layouts",
      "mockups",
    ]);
  });

  it("C6: accepted ONLY on 2xx { id: string, status: 'accepted' }; any other success shape is unknown", async () => {
    expect(snapwearAcceptedJobRef({ id: "SW-1", status: "accepted" })).toBe("SW-1");
    for (const body of [
      { data: { id: 5 }, status: "success" },
      { id: 42, status: "accepted" },
      { id: "", status: "accepted" },
      { id: "x".repeat(201), status: "accepted" },
      { id: "SW-1" },
      { id: "SW-1", status: "ok" },
      ["SW-1"],
      null,
    ]) {
      expect(snapwearAcceptedJobRef(body), JSON.stringify(body)).toBeNull();
    }
    expect(await classifyPrinterResponse(Response.json({ data: { id: 5 }, status: "success" }, { status: 200 })))
      .toStrictEqual({ reason: "malformed_response", status: "unknown" });
    expect(await classifyPrinterResponse(new Response("", { status: 201 }))).toStrictEqual({
      reason: "malformed_response",
      status: "unknown",
    });
  });

  it("items[] and the pairing: one item per job, artworks[i] printed at layouts[i], front before back; mockups optional", () => {
    const body = toSnapwearJobBody(
      job({
        artworks: [
          { location: "front", url: "https://r2.test.invalid/front.png" },
          { location: "back", url: "https://r2.test.invalid/back.png" },
        ],
        items: [{ quantity: 3, sku: SKU }],
      }),
    );
    expect(body.items).toStrictEqual([{ quantity: 3, sku: SKU }]);
    expect(body.artworks).toStrictEqual([
      { url: "https://r2.test.invalid/front.png" },
      { url: "https://r2.test.invalid/back.png" },
    ]);
    expect(body.layouts).toStrictEqual([{ location: "front" }, { location: "back" }]);
    expect(body.mockups).toStrictEqual([]);
  });

  it("the address: the assumed field names, the phone null when not given, no e-mail", () => {
    expect(snapwearShippingAddress({ ...SHIP_TO, addressLine2: "lgh 1102", phone: "+46 70 123" })).toStrictEqual({
      address1: "Storgatan 1",
      address2: "lgh 1102",
      city: "Klippan",
      country_code: "SE",
      name: "Test Köpare",
      phone: "+46 70 123",
      zip: "264 33",
    });
    expect(snapwearShippingAddress(SHIP_TO).phone).toBeNull();
  });

  it("a collected order (no parcel address) is never sent to SnapWear: rejected before any call", async () => {
    expect(SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO).toBe(false);
    const snapwear = fakeSnapwear([accepted()]);
    const client = createSnapwearClient(productionEnv(snapwear.fetcher), { origin: ORIGIN, token: TOKEN });
    for (const shipTo of [null, undefined]) {
      expect(await client.submit(job({ shipTo }))).toStrictEqual({ code: "ship_to_missing", status: "rejected" });
    }
    expect(snapwear.calls).toHaveLength(0);
  });

  it("a refusal after a lost answer stays unknown (it may be the duplicate in words we cannot read)", () => {
    const rejected = { code: "bad_request", status: "rejected" } as const;
    expect(afterLostAnswer({ unknown_since: null }, rejected)).toStrictEqual(rejected);
    expect(afterLostAnswer({ unknown_since: Date.now() }, rejected)).toStrictEqual({
      reason: "rejected_after_unknown_bad_request",
      status: "unknown",
    });
    const ok = { printerJobId: "SW-9", status: "accepted" } as const;
    expect(afterLostAnswer({ unknown_since: Date.now() }, ok)).toStrictEqual(ok);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("through the dispatcher, in production with the switch on", () => {
  it("submits the frozen line with the recipient and records SnapWear's reference", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    const snapwear = fakeSnapwear([accepted("SW-777")]);

    const result = await processOutboxRowById(productionEnv(snapwear.fetcher), dispatchId);

    expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(snapwear.calls).toHaveLength(1);
    const body = snapwear.calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      items: [{ quantity: 1, sku: SKU }],
      job_id: printerJobId(order.orderId, 1),
      layouts: [{ location: "front" }],
      mockups: [],
      shipping_address: snapwearShippingAddress(SHIP_TO),
    });
    const url = new URL((body.artworks as Array<{ url: string }>)[0]!.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(DISPATCH_PRINT_URL_TTL_SECONDS));
    expect(await lineRow(order.orderId)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "SW-777" });
    expect(await printerJobs(order.orderId)).toHaveLength(0); // the staging fake saw nothing
  });

  it("a lost answer, then the duplicate answer: one job, done", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    const snapwear = fakeSnapwear([
      new Error("connection reset"),
      () => Response.json({ message: SNAPWEAR_DUPLICATE_JOB_MESSAGE, status: "error" }, { status: 400 }),
    ]);
    const target = productionEnv(snapwear.fetcher);

    expect(await processOutboxRowById(target, dispatchId)).toMatchObject({ outcome: { kind: "unknown" } });
    expect(await outboxRow(dispatchId)).toMatchObject({ last_error: "unknown_network", status: "unknown" });
    expect(await processOutboxRowById(target, dispatchId, () => Date.now() + 2 * MIN)).toMatchObject({
      outcome: { kind: "done" },
    });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("accepted");
    expect(snapwear.calls.map((call) => (call.body as { job_id: string }).job_id)).toEqual([
      printerJobId(order.orderId, 1),
      printerJobId(order.orderId, 1),
    ]);
  });

  it("an unreadable refusal after a lost answer is NOT recorded failed: unknown, for a human", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    const snapwear = fakeSnapwear([
      new Error("timeout"),
      () => Response.json({ message: "Order exists", status: "error" }, { status: 400 }),
    ]);
    const target = productionEnv(snapwear.fetcher);

    await processOutboxRowById(target, dispatchId);
    const second = await processOutboxRowById(target, dispatchId, () => Date.now() + 2 * MIN);

    expect(second).toMatchObject({ outcome: { kind: "unknown" } });
    expect(await outboxRow(dispatchId)).toMatchObject({
      last_error: "unknown_rejected_after_unknown_bad_request",
      status: "unknown",
    });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("unknown");
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).not.toContain("dispatch_failed");
  });

  it("the same refusal with no earlier lost answer IS a failure, with its alert", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    const snapwear = fakeSnapwear([() => Response.json({ message: "Order exists", status: "error" }, { status: 400 })]);

    await processOutboxRowById(productionEnv(snapwear.fetcher), dispatchId);

    expect(await outboxRow(dispatchId)).toMatchObject({ last_error: "rejected_bad_request", status: "failed" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("failed");
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
  });

  it("a collected order fails with its alert, and SnapWear is never called", async () => {
    const order = await seedOrder(TENANT, { deliveryMethod: "pickup", printer: "snapwear" });
    const dispatchId = order.dispatchIds[0]!;
    const snapwear = fakeSnapwear([accepted()]);

    await processOutboxRowById(productionEnv(snapwear.fetcher), dispatchId);

    expect(snapwear.calls).toHaveLength(0);
    expect(await outboxRow(dispatchId)).toMatchObject({ last_error: "rejected_ship_to_missing", status: "failed" });
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
  });

  it("writes no token, origin or print address into the row, the alerts or the logs", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    const snapwear = fakeSnapwear([new Error(`${ORIGIN} ${TOKEN}`), () => new Response(null, { status: 503 })]);
    const target = productionEnv(snapwear.fetcher);

    await processOutboxRowById(target, dispatchId);
    await processOutboxRowById(target, dispatchId, () => Date.now() + 2 * MIN);

    const artworkUrl = (snapwear.calls[0]!.body as { artworks: Array<{ url: string }> }).artworks[0]!.url;
    const text = [
      JSON.stringify(await outboxRow(dispatchId)),
      JSON.stringify(await alertsFor(dispatchId)),
      JSON.stringify(await lineRow(order.orderId)),
      ...logged,
    ].join("\n");
    for (const secret of [TOKEN, "snapwear.test.invalid", artworkUrl]) {
      expect(text).not.toContain(secret);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("holding: no client is a hold, never a failure", () => {
  it("parks the job without spending attempts, sweep after sweep; the payment-hold release never wakes it", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    const off = productionEnv(null, { SNAPWEAR_SUBMIT_ENABLED: undefined });
    setCommerceCronsLoader(() => Promise.resolve(null));

    expect(await processOutboxRowById(off, dispatchId)).toMatchObject({ outcome: { kind: "retry" } });
    for (const hours of [1, 6, 48, 24 * 30]) {
      await runOutboxSweep(off, Date.now() + hours * 60 * MIN);
    }
    expect(await releaseDispatchHolds(env.DB, { now: Date.now(), paymentIntentId: null })).not.toContain(dispatchId);

    expect(await outboxRow(dispatchId)).toMatchObject({
      attempts: 1,
      last_error: "printer_not_configured",
      next_attempt_at: PRINTER_HOLD_UNTIL_MS,
      status: "pending",
      submitted_at: null,
    });
    expect(PRINTER_HOLD_UNTIL_MS).not.toBe(DISPATCH_HOLD_UNTIL_MS);
    expect((await lineRow(order.orderId)).dispatch_state).toBeNull();
    expect(await alertsFor(dispatchId)).toHaveLength(0);
  });

  it("reconciliation's 30-minute alert names the held job", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    const now = Date.now();
    await processOutboxRowById(productionEnv(null, { SNAPWEAR_SUBMIT_ENABLED: undefined }), dispatchId);

    const stripe = new FakeMoneyStripe();
    await runReconciliation(moneyEnv(stripe, { DISPATCH_TARGET: undefined } as Partial<Env>), now + 10 * MIN);
    expect(await openAlerts("dispatch_stranded_30m", dispatchId)).toHaveLength(0);
    await runReconciliation(moneyEnv(stripe, { DISPATCH_TARGET: undefined } as Partial<Env>), now + 31 * MIN);
    expect(await openAlerts("dispatch_stranded_30m", dispatchId)).toHaveLength(1);
  });

  it("the first sweep after the switch is on sends it, once", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    setCommerceCronsLoader(() => Promise.resolve(null));
    await processOutboxRowById(productionEnv(null, { SNAPWEAR_SUBMIT_ENABLED: undefined }), dispatchId);

    const snapwear = fakeSnapwear([accepted("SW-HELD")]);
    const summary = await runOutboxSweep(productionEnv(snapwear.fetcher), Date.now() + 3 * 60 * MIN);
    await runOutboxSweep(productionEnv(snapwear.fetcher), Date.now() + 4 * 60 * MIN);

    expect(summary.printerReleased).toBe(1);
    expect(snapwear.calls).toHaveLength(1);
    expect(await outboxRow(dispatchId)).toMatchObject({ attempts: 2, result_ref: "SW-HELD", status: "done" });
    expect(await lineRow(order.orderId)).toMatchObject({ dispatch_state: "accepted", printer_job_ref: "SW-HELD" });
  });

  it("a row on its LAST attempt cannot be parked: it fails with its alert (unchanged CP2 rule)", async () => {
    const order = await shippedOrder();
    const dispatchId = order.dispatchIds[0]!;
    await env.DB.prepare("UPDATE outbox_events SET attempts = max_attempts - 1 WHERE outbox_id = ?")
      .bind(dispatchId)
      .run();

    await processOutboxRowById(productionEnv(null, { SNAPWEAR_SUBMIT_ENABLED: undefined }), dispatchId);

    expect(await outboxRow(dispatchId)).toMatchObject({ last_error: "printer_not_configured", status: "failed" });
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
  });
});
