import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import catalog from "../../docs/SnapWearDocs/snapwear-catalog.json";
import worker from "../src/index";
import {
  classifyPrinterResponse,
  createFakePrinterClient,
  FAKE_PRINTER_FETCH_OVERRIDE,
  resolvePrinterClient,
  toSnapwearJobBody,
  type PrinterJob,
} from "../src/dispatch/printer-client";
import { SNAPWEAR_SKUS } from "../src/dispatch/snapwear-skus";
import {
  parsePrinterJobId,
  printerJobId,
  SNAPWEAR_DUPLICATE_JOB_MESSAGE,
} from "../src/dispatch/snapwear-wire";

/**
 * The staging fake printer (PLAN §2.6 last sentence, §2.3 dispatch) and the
 * printer client the CP2 dispatcher will call.
 *
 * Orders are seeded directly (checkout + order rows) — the fake only needs an
 * order to exist so it can file the job under the order's tenant.
 */

const HOST = "https://api.fakeprinter.test";
const PATH = "/v1/staging/fake-printer/jobs";
const TENANT_A = "tenant-fakeprinter-a";
const TENANT_B = "tenant-fakeprinter-b";
const DAY_MS = 24 * 60 * 60 * 1_000;
const SKU = [...SNAPWEAR_SKUS][0] as string;

let counter = 0;

async function seedTenant(tenantId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tenants (tenant_id, status, shop_name, default_locale,
       default_currency, created_at, updated_at)
     VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, `Shop ${tenantId}`, now, now)
    .run();
}

/** A paid pickup order; returns its (UUID) order id. */
async function seedOrder(tenantId = TENANT_A): Promise<string> {
  counter += 1;
  const now = Date.now();
  const checkoutId = `ck-fakeprinter-${counter}`;
  const orderId = crypto.randomUUID();
  const intentId = `pi_fakeprinter_${counter}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO checkouts (
         checkout_id, tenant_id, status, customer_email, currency,
         delivery_method, shipping_country, subtotal_minor, shipping_minor,
         vat_minor, vat_rate_bp, discount_minor, discount_code_id, total_minor,
         payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at
       ) VALUES (?, ?, 'completed', ?, 'SEK', 'pickup', NULL, 19900, 0, 0, 2500, 0,
                 NULL, 19900, ?, ?, ?, ?, ?)`,
    ).bind(
      checkoutId,
      tenantId,
      `buyer-${counter}@example.test`,
      intentId,
      `hash-${checkoutId}`,
      now + DAY_MS,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO orders (
         order_id, tenant_id, checkout_id, payment_intent_id, order_number,
         status, customer_email, currency, delivery_method, shipping_country,
         subtotal_minor, shipping_minor, vat_minor, vat_rate_bp,
         discount_minor, discount_code_id, total_minor, captured_minor,
         refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'paid', ?, 'SEK', 'pickup', NULL, 19900, 0, 0,
                 2500, 0, NULL, 19900, 19900, 0, ?, ?, ?, ?)`,
    ).bind(
      orderId,
      tenantId,
      checkoutId,
      intentId,
      `FP-${counter}`,
      `buyer-${counter}@example.test`,
      `evt_fakeprinter_${counter}`,
      now,
      now,
      now,
    ),
  ]);
  return orderId;
}

function jobBody(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    artworks: [{ url: "https://files.test.invalid/print/line-1.png" }],
    items: [{ quantity: 2, sku: SKU }],
    job_id: printerJobId(orderId, 1),
    layouts: [{ location: "front" }],
    mockups: [{ url: "https://files.test.invalid/mockup/line-1.webp" }],
    ...overrides,
  };
}

function printerRequest(
  options: {
    authorization?: string | null;
    body?: unknown;
    method?: string;
    path?: string;
    rawBody?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  const authorization =
    options.authorization === undefined
      ? `Bearer ${env.FAKE_PRINTER_TOKEN}`
      : options.authorization;
  if (authorization !== null) {
    headers.authorization = authorization;
  }
  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return new Request(`${HOST}${options.path ?? PATH}`, {
    body,
    headers,
    method: options.method ?? (body === undefined ? "GET" : "POST"),
  });
}

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

function submit(body: unknown, targetEnv: Env = env as unknown as Env) {
  return worker.fetch(printerRequest({ body }), targetEnv);
}

async function jobCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM fake_printer_jobs").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

function printerJob(orderId: string, overrides: Partial<PrinterJob> = {}): PrinterJob {
  return {
    artworks: [{ location: "front", url: "https://files.test.invalid/print/line-1.png" }],
    items: [{ quantity: 1, sku: SKU }],
    jobId: printerJobId(orderId, 1),
    mockupUrls: ["https://files.test.invalid/mockup/line-1.webp"],
    ...overrides,
  };
}

beforeAll(async () => {
  await seedTenant(TENANT_A);
  await seedTenant(TENANT_B);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fake_printer_jobs").run();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the route is dark unless staging + fake-printer + token", () => {
  const DARK: Array<[string, Record<string, unknown>]> = [
    ["in production", { APP_ENV: "production" }],
    ["on staging pointed at SnapWear", { DISPATCH_TARGET: "snapwear" }],
    ["on staging with no dispatch target", { DISPATCH_TARGET: undefined }],
    ["with a mis-cased target", { DISPATCH_TARGET: "Fake-Printer" }],
    ["without the token", { FAKE_PRINTER_TOKEN: undefined }],
    ["with a 31-character token", { FAKE_PRINTER_TOKEN: "t".repeat(31) }],
  ];

  for (const [label, overrides] of DARK) {
    it(`404s POST and GET ${label}, writing nothing`, async () => {
      const orderId = await seedOrder();
      const token =
        typeof overrides.FAKE_PRINTER_TOKEN === "string"
          ? overrides.FAKE_PRINTER_TOKEN
          : env.FAKE_PRINTER_TOKEN;
      const targetEnv = envWith(overrides);

      const posted = await worker.fetch(
        printerRequest({ authorization: `Bearer ${token}`, body: jobBody(orderId) }),
        targetEnv,
      );
      const listed = await worker.fetch(
        printerRequest({ authorization: `Bearer ${token}`, path: `${PATH}?orderId=${orderId}` }),
        targetEnv,
      );

      for (const response of [posted, listed]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toStrictEqual({
          error: { code: "not_found", message: "Route not found" },
        });
      }
      expect(await jobCount()).toBe(0);
    });
  }

  const BAD_CREDENTIALS: Array<[string, string | null]> = [
    ["no Authorization header", null],
    ["a wrong token", `Bearer ${"w".repeat(40)}`],
    ["a lowercase scheme", `bearer ${env.FAKE_PRINTER_TOKEN}`],
    ["the render farm's token", `Bearer ${env.RENDER_FARM_TOKEN}`],
  ];

  for (const [label, authorization] of BAD_CREDENTIALS) {
    it(`404s ${label}`, async () => {
      const orderId = await seedOrder();
      const response = await worker.fetch(
        printerRequest({ authorization, body: jobBody(orderId) }),
        env,
      );
      expect(response.status).toBe(404);
      expect(await jobCount()).toBe(0);
    });
  }

  it("wrong methods and neighbouring paths are 404s", async () => {
    for (const request of [
      printerRequest({ body: {}, method: "PUT" }),
      printerRequest({ method: "DELETE" }),
      printerRequest({ body: {}, path: `${PATH}/extra` }),
      printerRequest({ body: {}, path: "/v1/staging/fake-printer" }),
    ]) {
      expect((await worker.fetch(request, env)).status).toBe(404);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("submissions — SnapWear-shaped answers", () => {
  it("accepts a new job: 201 { id, status: accepted }, filed under the order's tenant", async () => {
    const orderId = await seedOrder(TENANT_B);
    const body = jobBody(orderId, { shipping_address: { city: "Umeå" } });

    const response = await submit(body);
    expect(response.status).toBe(201);
    const answer = await response.json<{ id: string; status: string }>();
    expect(answer.status).toBe("accepted");
    expect(answer.id).toMatch(/^[0-9a-f-]{36}$/);

    const row = await env.DB.prepare("SELECT * FROM fake_printer_jobs WHERE id = ?")
      .bind(answer.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      job_id: `${orderId}-1`,
      order_id: orderId,
      tenant_id: TENANT_B,
    });
    // Unknown fields (e.g. a shipping address CP2 will add) are kept verbatim.
    expect(JSON.parse(String(row?.payload_json))).toStrictEqual(body);
    expect(String(row?.received_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("a duplicate job_id answers 400 with the duplicate message and records nothing new", async () => {
    const orderId = await seedOrder();
    expect((await submit(jobBody(orderId))).status).toBe(201);

    const duplicate = await submit(jobBody(orderId));
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toStrictEqual({
      message: SNAPWEAR_DUPLICATE_JOB_MESSAGE,
      status: "error",
    });
    expect(await jobCount()).toBe(1);
  });

  it("a duplicate is recognised before validation: resubmitting an accepted id is always 'already have it'", async () => {
    const orderId = await seedOrder();
    await submit(jobBody(orderId));
    const changed = await submit(jobBody(orderId, { items: [{ quantity: 0, sku: "nope" }] }));
    expect(changed.status).toBe(400);
  });

  it("concurrent submissions of one job id: exactly one is accepted", async () => {
    const orderId = await seedOrder();
    const statuses = (
      await Promise.all(Array.from({ length: 5 }, () => submit(jobBody(orderId))))
    ).map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(4);
    expect(await jobCount()).toBe(1);
  });

  it("each order line is its own job", async () => {
    const orderId = await seedOrder();
    expect((await submit(jobBody(orderId))).status).toBe(201);
    expect((await submit(jobBody(orderId, { job_id: printerJobId(orderId, 2) }))).status).toBe(201);
    expect(await jobCount()).toBe(2);
  });

  const INVALID: Array<[string, (orderId: string) => unknown, string]> = [
    ["a missing artwork URL", (id) => jobBody(id, { artworks: [{}] }), "artworks.0.url"],
    ["an empty artwork URL", (id) => jobBody(id, { artworks: [{ url: "" }] }), "artworks.0.url"],
    ["a non-https artwork URL", (id) => jobBody(id, { artworks: [{ url: "http://x.test/a.png" }] }), "artworks.0.url"],
    ["no artworks at all", (id) => jobBody(id, { artworks: [], layouts: [] }), "artworks"],
    ["an unknown SKU", (id) => jobBody(id, { items: [{ quantity: 1, sku: "9999999" }] }), "items.0.sku"],
    ["a quantity below 1", (id) => jobBody(id, { items: [{ quantity: 0, sku: SKU }] }), "items.0.quantity"],
    ["a negative quantity", (id) => jobBody(id, { items: [{ quantity: -2, sku: SKU }] }), "items.0.quantity"],
    ["a fractional quantity", (id) => jobBody(id, { items: [{ quantity: 1.5, sku: SKU }] }), "items.0.quantity"],
    ["a string quantity", (id) => jobBody(id, { items: [{ quantity: "1", sku: SKU }] }), "items.0.quantity"],
    ["no items", (id) => jobBody(id, { items: [] }), "items"],
    ["a sleeve placement", (id) => jobBody(id, { layouts: [{ location: "sleeve" }] }), "layouts.0.location"],
    ["layouts that do not pair with the artworks", (id) => jobBody(id, { layouts: [] }), "layouts"],
    ["a bad mockup URL", (id) => jobBody(id, { mockups: [{ url: "javascript:alert(1)" }] }), "mockups.0.url"],
    ["a missing job id", (id) => ({ ...jobBody(id), job_id: undefined }), "job_id"],
    ["a job id without a line", (id) => jobBody(id, { job_id: id }), "job_id"],
    ["a job id with line 0", (id) => jobBody(id, { job_id: `${id}-0` }), "job_id"],
    ["a job id for an order that does not exist", (id) => jobBody(id, { job_id: printerJobId(crypto.randomUUID(), 1) }), "job_id"],
    ["an array body", () => [], "body"],
  ];

  for (const [label, makeBody, field] of INVALID) {
    it(`422 Validation Failed for ${label}`, async () => {
      const orderId = await seedOrder();
      const response = await submit(makeBody(orderId));
      expect(response.status).toBe(422);
      const answer = await response.json<{
        errors: Record<string, string[]>;
        message: string;
        status: string;
      }>();
      expect(answer.status).toBe("error");
      expect(answer.message).toBe("Validation Failed");
      expect(Object.keys(answer.errors)).toContain(field);
      expect(await jobCount()).toBe(0);
    });
  }

  it("422 for a body that is not JSON", async () => {
    const response = await worker.fetch(printerRequest({ rawBody: "{not json" }), env);
    expect(response.status).toBe(422);
  });

  it("422 for an oversized body", async () => {
    const orderId = await seedOrder();
    const response = await submit(jobBody(orderId, { note: "x".repeat(70_000) }));
    expect(response.status).toBe(422);
    expect(await jobCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("listing what was received", () => {
  it("GET ?orderId lists that order's jobs only, in arrival order", async () => {
    const orderA = await seedOrder(TENANT_A);
    const orderB = await seedOrder(TENANT_B);
    await submit(jobBody(orderA));
    await submit(jobBody(orderB));
    await submit(jobBody(orderA, { job_id: printerJobId(orderA, 2) }));

    const response = await worker.fetch(printerRequest({ path: `${PATH}?orderId=${orderA}` }), env);
    expect(response.status).toBe(200);
    const { jobs } = await response.json<{
      jobs: Array<{ jobId: string; orderId: string; payload: { items: unknown }; tenantId: string }>;
    }>();
    expect(jobs.map((job) => job.jobId)).toStrictEqual([`${orderA}-1`, `${orderA}-2`]);
    expect(jobs.every((job) => job.orderId === orderA && job.tenantId === TENANT_A)).toBe(true);
    expect(jobs[0]?.payload.items).toStrictEqual([{ quantity: 2, sku: SKU }]);
  });

  it("400 without a well-formed orderId", async () => {
    for (const query of ["", "?orderId=", "?orderId=nope", "?order=x"]) {
      const response = await worker.fetch(printerRequest({ path: `${PATH}${query}` }), env);
      expect(response.status, query).toBe(400);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the printer client", () => {
  it("resolves by DISPATCH_TARGET, and never to the fake outside staging", async () => {
    expect(resolvePrinterClient(env)).not.toBeNull();
    expect(resolvePrinterClient(envWith({ APP_ENV: "production" }))).toBeNull();
    expect(resolvePrinterClient(envWith({ FAKE_PRINTER_TOKEN: undefined }))).toBeNull();
    expect(resolvePrinterClient(envWith({ DISPATCH_TARGET: undefined }))).toBeNull();
    expect(resolvePrinterClient(envWith({ DISPATCH_TARGET: "SnapWear" }))).toBeNull();
    // SnapWear without its switch, address and token is no client at all
    // (the full gate: test/snapwear-client.test.ts).
    expect(
      resolvePrinterClient(envWith({ APP_ENV: "production", DISPATCH_TARGET: "snapwear" })),
    ).toBeNull();
    expect(() => createFakePrinterClient(envWith({ APP_ENV: "production" }))).toThrow(
      /not enabled/,
    );
  });

  it("submits in-process by default: accepted, with the fake's id as the printer reference", async () => {
    const orderId = await seedOrder();
    const client = resolvePrinterClient(env);
    const result = await client?.submit(printerJob(orderId));

    expect(result?.status).toBe("accepted");
    const row = await env.DB.prepare("SELECT id, job_id FROM fake_printer_jobs").first<{
      id: string;
      job_id: string;
    }>();
    expect(result).toStrictEqual({ printerJobId: row?.id, status: "accepted" });
    expect(row?.job_id).toBe(`${orderId}-1`);
  });

  it("through the public entrypoint: accepted, then duplicate on retry, rejected on a bad SKU", async () => {
    const orderId = await seedOrder();
    const calls: Array<{ authorization: string | null; body: unknown; path: string }> = [];
    const targetEnv = envWith({});
    (targetEnv as unknown as Record<PropertyKey, unknown>)[FAKE_PRINTER_FETCH_OVERRIDE] = async (
      request: Request,
    ) => {
      calls.push({
        authorization: request.headers.get("authorization"),
        body: await request.clone().json(),
        path: new URL(request.url).pathname,
      });
      return worker.fetch(request, targetEnv);
    };
    const client = createFakePrinterClient(targetEnv);

    expect((await client.submit(printerJob(orderId))).status).toBe("accepted");
    // A resubmit after a lost response is recognised as already accepted.
    expect(await client.submit(printerJob(orderId))).toStrictEqual({ status: "duplicate" });
    expect(
      await client.submit(
        printerJob(orderId, {
          items: [{ quantity: 1, sku: "0000000" }],
          jobId: printerJobId(orderId, 2),
        }),
      ),
    ).toStrictEqual({ code: "validation_failed", status: "rejected" });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toStrictEqual({
      authorization: `Bearer ${env.FAKE_PRINTER_TOKEN}`,
      body: toSnapwearJobBody(printerJob(orderId)),
      path: PATH,
    });
    expect(await jobCount()).toBe(1);
  });

  it("an unreachable printer is 'unknown', never a guess", async () => {
    const orderId = await seedOrder();
    const targetEnv = envWith({
      [FAKE_PRINTER_FETCH_OVERRIDE]: async () => {
        throw new TypeError("network down");
      },
    });
    expect(await createFakePrinterClient(targetEnv).submit(printerJob(orderId))).toStrictEqual({
      reason: "network",
      status: "unknown",
    });
  });

  const CLASSIFIED: Array<[string, Response, unknown]> = [
    ["201 accepted", Response.json({ id: "p-1", status: "accepted" }, { status: 201 }), { printerJobId: "p-1", status: "accepted" }],
    ["201 with an unreadable body", new Response("ok", { status: 201 }), { reason: "malformed_response", status: "unknown" }],
    ["201 without an id", Response.json({ status: "accepted" }, { status: 201 }), { reason: "malformed_response", status: "unknown" }],
    ["400 duplicate", Response.json({ message: SNAPWEAR_DUPLICATE_JOB_MESSAGE, status: "error" }, { status: 400 }), { status: "duplicate" }],
    ["400 of any other kind", Response.json({ message: "Bad", status: "error" }, { status: 400 }), { code: "bad_request", status: "rejected" }],
    ["422", Response.json({ errors: {}, message: "Validation Failed", status: "error" }, { status: 422 }), { code: "validation_failed", status: "rejected" }],
    ["409", new Response(null, { status: 409 }), { code: "http_409", status: "rejected" }],
    ["a redirect (never followed)", new Response(null, { headers: { location: "https://elsewhere.test/" }, status: 302 }), { reason: "http_302", status: "unknown" }],
    ["401 (our credential)", new Response(null, { status: 401 }), { reason: "http_401", status: "unknown" }],
    ["404 (our configuration)", new Response(null, { status: 404 }), { reason: "http_404", status: "unknown" }],
    ["429", new Response(null, { status: 429 }), { reason: "http_429", status: "unknown" }],
    ["503", new Response(null, { status: 503 }), { reason: "http_503", status: "unknown" }],
  ];

  for (const [label, response, expected] of CLASSIFIED) {
    it(`classifies ${label}`, async () => {
      expect(await classifyPrinterResponse(response)).toStrictEqual(expected);
    });
  }

  it("pairs each artwork with its placement on the wire", () => {
    const orderId = crypto.randomUUID();
    expect(
      toSnapwearJobBody(
        printerJob(orderId, {
          artworks: [
            { location: "front", url: "https://f.test/front.png" },
            { location: "back", url: "https://f.test/back.png" },
          ],
          mockupUrls: [],
        }),
      ),
    ).toStrictEqual({
      artworks: [{ url: "https://f.test/front.png" }, { url: "https://f.test/back.png" }],
      items: [{ quantity: 1, sku: SKU }],
      job_id: `${orderId}-1`,
      layouts: [{ location: "front" }, { location: "back" }],
      mockups: [],
    });
  });

  it("builds and parses the stable job id", () => {
    const orderId = crypto.randomUUID();
    expect(parsePrinterJobId(printerJobId(orderId, 12))).toStrictEqual({ lineNo: 12, orderId });
    for (const bad of [orderId, `${orderId}-0`, `${orderId}-01`, `${orderId}-x`, `x-1`, `${orderId.toUpperCase()}-1`]) {
      expect(parsePrinterJobId(bad), bad).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the fake's catalogue and schema", () => {
  it("knows exactly SnapWear's catalogue SKUs (drift guard)", () => {
    const fromCatalog = Object.keys((catalog as { skus: Record<string, unknown> }).skus).sort();
    expect([...SNAPWEAR_SKUS].sort()).toStrictEqual(fromCatalog);
  });

  it("keeps received jobs write-once and on their order's tenant", async () => {
    const orderId = await seedOrder(TENANT_A);
    const { id } = await (await submit(jobBody(orderId))).json<{ id: string }>();

    await expect(
      env.DB.prepare("UPDATE fake_printer_jobs SET payload_json = '{}' WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/write-once/);
    await expect(
      env.DB.prepare(
        `INSERT INTO fake_printer_jobs (id, tenant_id, job_id, order_id, payload_json, received_at)
         VALUES (?, ?, ?, ?, '{}', ?)`,
      )
        .bind(crypto.randomUUID(), TENANT_B, `${orderId}-9`, orderId, new Date().toISOString())
        .run(),
    ).rejects.toThrow(/order tenant/);
  });
});
