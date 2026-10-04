import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { type PrintJobListQuery, printJobListSql } from "../src/dispatch/print-job-list";
import { printerJobId } from "../src/dispatch/snapwear-wire";
import {
  grantAccess,
  grantMembership,
  seedOrder,
  seedTenant,
  sessionRequest,
  signUp,
  SKU,
  type SignedUpUser,
} from "./dispatch-fixtures";

/**
 * CP5-WK — the platform's list of print jobs: GET /v1/platform/print-jobs
 * (src/dispatch/print-job-list.ts). Platform-only, so tenancy is not what is
 * tested here; instead: who is refused (exactly as on the other platform
 * reads), the row's exact key set (nothing of the printer's cost, the
 * production snapshot or the buyer), every filter, a cursor walk that visits
 * each job once, the 400 on every malformed query, and the index each filter
 * path uses (the query plan, pinned).
 */

const SHOP_A = "pjl-shop-a";
const SHOP_B = "pjl-shop-b";
const MINE = new Set([SHOP_A, SHOP_B]);
const HOST = "https://platform.pjl.test";
const BUYER = "pjl-buyer@example.test";
const ROW_KEYS = [
  "carrier",
  "createdAt",
  "dispatchState",
  "dispatchedAt",
  "exception",
  "exceptionResolvedAt",
  "jobId",
  "lineNo",
  "name",
  "orderId",
  "orderNumber",
  "orderStatus",
  "printerId",
  "printerJobRef",
  "quantity",
  "shopName",
  "sku",
  "state",
  "tenantId",
  "trackingNumber",
  "trackingUrl",
  "updatedAt",
  "variantLabel",
];

interface JobRow {
  carrier: string | null;
  createdAt: string;
  dispatchState: string | null;
  dispatchedAt: string | null;
  exception: string | null;
  exceptionResolvedAt: string | null;
  jobId: string;
  lineNo: number;
  name: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  printerId: string | null;
  printerJobRef: string | null;
  quantity: number;
  shopName: string | null;
  sku: string;
  state: string | null;
  tenantId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  updatedAt: string;
  variantLabel: string | null;
}

interface Page {
  jobs: JobRow[];
  nextCursor: string | null;
}

let platform: SignedUpUser;
let shopAdmin: SignedUpUser;
let printOperator: SignedUpUser;

/** Every seeded job, by what the tests filter on. */
const jobs = {
  aAcceptedNone: "",
  aInProduction: "",
  aShipped: "",
  aQueued: "",
  aVariant: "",
  aUnknown: "",
  aFailed: "",
  aProduced: "",
  bAcceptedSnapwear: "",
  bCancelled: "",
  bPending: "",
  bSubmitting: "",
};
let multiLineOrder = "";
let shippedCreatedAt = 0;

async function setLine(
  orderId: string,
  lineNo: number,
  set: { dispatchState?: string | null; production?: string; tracking?: [string, string, string] },
): Promise<void> {
  const accepted = set.dispatchState === "accepted";
  await env.DB.prepare(
    `UPDATE order_items
     SET dispatch_state = ?,
         printer_job_ref = ?,
         dispatched_at = ?,
         production_state = ?,
         printer_tracking_number = ?,
         printer_carrier = ?,
         printer_tracking_url = ?
     WHERE order_id = ? AND item_index = ?`,
  )
    .bind(
      set.dispatchState ?? null,
      accepted ? `SW-${orderId.slice(0, 8)}-${lineNo}` : null,
      accepted ? "2026-10-04T08:00:00.000Z" : null,
      set.production ?? null,
      set.tracking?.[0] ?? null,
      set.tracking?.[1] ?? null,
      set.tracking?.[2] ?? null,
      orderId,
      lineNo - 1,
    )
    .run();
}

/** A further printer line on `orderId`, sold as a catalogue variant (seedOrder writes none). */
async function addVariantLine(orderId: string, tenantId: string): Promise<number> {
  const line = await env.DB.prepare(
    `SELECT product_id, COUNT(*) AS lines FROM order_items WHERE order_id = ? GROUP BY product_id`,
  )
    .bind(orderId)
    .first<{ lines: number; product_id: string }>();
  if (line === null) {
    throw new Error("no line");
  }
  const variantId = `variant-${orderId.slice(0, 8)}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO product_variants (variant_id, tenant_id, product_id, sku, label, price_minor, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Svart / M', 29900, 1, ?, ?)`,
    ).bind(variantId, tenantId, line.product_id, `sku-${variantId}`, now, now),
    env.DB.prepare(
      `INSERT INTO order_items (
         order_item_id, order_id, tenant_id, item_index, product_id, variant_id,
         sku, name, quantity, unit_price_minor, line_total_minor, created_at,
         updated_at, production_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Hoodie', 2, 29900, 59800, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      orderId,
      tenantId,
      line.lines,
      line.product_id,
      variantId,
      `sku-${variantId}`,
      now,
      now,
      JSON.stringify({ lineNo: line.lines + 1, productionCostMinor: 9_000, quantity: 2, sku: SKU, withholdMinor: 9_000 }),
    ),
  ]);
  return line.lines + 1;
}

beforeAll(async () => {
  await seedTenant(SHOP_A, "Butik A");
  await seedTenant(SHOP_B, "Butik B");
  platform = await signUp("pjl-platform@example.test");
  await grantAccess(platform.userId, "platform_admin");
  shopAdmin = await signUp("pjl-admin@example.test");
  await grantAccess(shopAdmin.userId, "tenant_admin");
  await grantMembership(shopAdmin.userId, SHOP_A);
  printOperator = await signUp("pjl-print@example.test");
  await grantAccess(printOperator.userId, "print_operator");

  // Shop A: one order of three printer lines and a line the shop sends itself.
  shippedCreatedAt = Date.parse("2026-10-01T10:00:00.000Z");
  const multi = await seedOrder(SHOP_A, {
    createdAt: shippedCreatedAt,
    customerEmail: BUYER,
    lines: [{ name: "Tröja Ett" }, { name: "Tröja Två", quantity: 3 }, { name: "Tröja Tre" }, { production: "none" }],
  });
  multiLineOrder = multi.orderId;
  await setLine(multi.orderId, 1, { dispatchState: "accepted" });
  await setLine(multi.orderId, 2, { dispatchState: "accepted", production: "in_production" });
  await setLine(multi.orderId, 3, {
    dispatchState: "accepted",
    production: "shipped",
    tracking: ["RR123SE", "PostNord", "https://track.test/RR123SE"],
  });
  jobs.aAcceptedNone = printerJobId(multi.orderId, 1);
  jobs.aInProduction = printerJobId(multi.orderId, 2);
  jobs.aShipped = printerJobId(multi.orderId, 3);

  const queued = await seedOrder(SHOP_A, { customerEmail: BUYER });
  jobs.aQueued = printerJobId(queued.orderId, 1);
  jobs.aVariant = printerJobId(queued.orderId, await addVariantLine(queued.orderId, SHOP_A));

  const unknown = await seedOrder(SHOP_A);
  await setLine(unknown.orderId, 1, { dispatchState: "unknown" });
  jobs.aUnknown = printerJobId(unknown.orderId, 1);
  const failed = await seedOrder(SHOP_A);
  await setLine(failed.orderId, 1, { dispatchState: "failed" });
  jobs.aFailed = printerJobId(failed.orderId, 1);
  const produced = await seedOrder(SHOP_A);
  await setLine(produced.orderId, 1, { dispatchState: "accepted", production: "produced" });
  jobs.aProduced = printerJobId(produced.orderId, 1);

  // Shop B: another printer, and the remaining dispatch states.
  const snapwear = await seedOrder(SHOP_B, { printer: "snapwear" });
  await setLine(snapwear.orderId, 1, { dispatchState: "accepted" });
  jobs.bAcceptedSnapwear = printerJobId(snapwear.orderId, 1);
  const cancelled = await seedOrder(SHOP_B);
  await setLine(cancelled.orderId, 1, { dispatchState: "cancelled" });
  jobs.bCancelled = printerJobId(cancelled.orderId, 1);
  const pending = await seedOrder(SHOP_B);
  await setLine(pending.orderId, 1, { dispatchState: "pending" });
  jobs.bPending = printerJobId(pending.orderId, 1);
  const submitting = await seedOrder(SHOP_B);
  await setLine(submitting.orderId, 1, { dispatchState: "submitting" });
  jobs.bSubmitting = printerJobId(submitting.orderId, 1);
});

// ── helpers ────────────────────────────────────────────────────────────────

function get(
  query: string,
  options: { cookie?: string | null; method?: string; origin?: string | null; shopId?: string } = {},
  path = "/v1/platform/print-jobs",
): Promise<Response> {
  const method = options.method ?? "GET";
  return worker.fetch(
    sessionRequest(`${HOST}${path}${query}`, method, {
      cookie: options.cookie === null ? undefined : (options.cookie ?? platform.cookie),
      // A same-origin GET carries no Origin header; a write would.
      origin: options.origin === undefined ? (method === "GET" ? null : HOST) : options.origin,
      shopId: options.shopId,
    }),
    env,
  );
}

async function page(query: string): Promise<Page> {
  const response = await get(query);
  expect(response.status, query).toBe(200);
  return response.json<Page>();
}

/** The seeded jobs a page holds (other suites' rows, if any shared the database, are left out). */
function mine(body: Page): string[] {
  return body.jobs.filter((job) => MINE.has(job.tenantId)).map((job) => job.jobId);
}

async function ids(query: string): Promise<string[]> {
  return mine(await page(query)).sort();
}

/** Every page of `query`, following nextCursor; each job id in the order served. */
async function walk(query: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 100; pages += 1) {
    const separator = query === "" ? "?" : "&";
    const body: Page = await page(
      `${query}${separator}limit=${limit}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    expect(body.jobs.length).toBeLessThanOrEqual(limit);
    seen.push(...body.jobs.map((job) => job.jobId));
    if (body.nextCursor === null) {
      return seen;
    }
    expect(body.nextCursor).toBe(body.jobs.at(-1)?.jobId);
    cursor = body.nextCursor;
  }
  throw new Error("the walk did not end");
}

/** The list's order: by order id, then line number (not the job id as text: line 10 follows 9). */
function compareJobs(left: string, right: string): number {
  const leftAt = left.lastIndexOf("-");
  const rightAt = right.lastIndexOf("-");
  const leftOrder = left.slice(0, leftAt);
  const rightOrder = right.slice(0, rightAt);
  if (leftOrder !== rightOrder) {
    return leftOrder < rightOrder ? -1 : 1;
  }
  return Number(left.slice(leftAt + 1)) - Number(right.slice(rightAt + 1));
}

function byJobOrder(list: string[]): string[] {
  return [...list].sort(compareJobs);
}

const shopAJobs = () => [
  jobs.aAcceptedNone,
  jobs.aInProduction,
  jobs.aShipped,
  jobs.aQueued,
  jobs.aVariant,
  jobs.aUnknown,
  jobs.aFailed,
  jobs.aProduced,
];
const shopBJobs = () => [jobs.bAcceptedSnapwear, jobs.bCancelled, jobs.bPending, jobs.bSubmitting];

const sorted = (...list: string[]) => [...list].sort();

// ═══════════════════════════════════════════════════════════════════════════
describe("who may read it", () => {
  it("refuses an anonymous caller, a shop's admin, a print operator and an X-Shop-Id exactly as the other platform reads", async () => {
    const callers: Array<[string, { cookie?: string | null; shopId?: string }]> = [
      ["anonymous", { cookie: null }],
      ["a shop's admin", { cookie: shopAdmin.cookie }],
      ["a shop's admin naming its shop", { cookie: shopAdmin.cookie, shopId: SHOP_A }],
      ["a print operator", { cookie: printOperator.cookie }],
      ["a platform user naming a shop", { shopId: SHOP_A }],
    ];
    for (const [label, caller] of callers) {
      const ours = await get("", caller);
      const theirs = await get("?state=unknown", caller, "/v1/platform/dispatch");
      const tenants = await get("", caller, "/v1/platform/tenants");
      expect(ours.status, label).toBe(404);
      const body = await ours.text();
      expect(body, label).toBe(await theirs.text());
      expect(body, label).toBe(await tenants.text());
      expect(JSON.parse(body)).toEqual({ error: { code: "not_found", message: "Route not found" } });
    }
  });

  it("refuses before the query is looked at: a malformed query from a refused caller is the 404, not the 400", async () => {
    expect((await get("?state=bogus", { cookie: null })).status).toBe(404);
    expect((await get("?nope=1", { cookie: shopAdmin.cookie })).status).toBe(404);
  });

  it("answers only GET; every other method is the opaque 404", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await get("", { method });
      expect(response.status, method).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "not_found", message: "Route not found" },
      });
    }
  });

  it("is a read: no Origin is needed, and a cross-site Origin does not change the answer", async () => {
    expect((await get("", { origin: null })).status).toBe(200);
    expect((await get("", { origin: "https://evil.test" })).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the row", () => {
  it("carries exactly the named fields: what the status route needs and what a person recognises the line by", async () => {
    const body = await page(`?tenantId=${SHOP_A}&state=shipped`);
    expect(Object.keys(body).sort()).toEqual(["jobs", "nextCursor"]);
    expect(body.nextCursor).toBeNull();
    expect(body.jobs).toHaveLength(1);
    const [row] = body.jobs as [JobRow];
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);

    const line = await env.DB.prepare(
      `SELECT o.order_number, o.status, i.sku, i.updated_at FROM order_items AS i
       JOIN orders AS o ON o.order_id = i.order_id
       WHERE i.order_id = ? AND i.item_index = 2`,
    )
      .bind(multiLineOrder)
      .first<{ order_number: string; sku: string; status: string; updated_at: number }>();
    expect(line?.status).toMatch(/^[a-z_]+$/);
    expect(row).toStrictEqual({
      carrier: "PostNord",
      createdAt: new Date(shippedCreatedAt).toISOString(),
      dispatchState: "accepted",
      dispatchedAt: "2026-10-04T08:00:00.000Z",
      exception: null,
      exceptionResolvedAt: null,
      jobId: jobs.aShipped,
      lineNo: 3,
      name: "Tröja Tre",
      orderId: multiLineOrder,
      orderNumber: line?.order_number,
      orderStatus: line?.status,
      printerId: "fake-printer",
      printerJobRef: `SW-${multiLineOrder.slice(0, 8)}-3`,
      quantity: 1,
      shopName: "Butik A",
      sku: line?.sku,
      state: "shipped",
      tenantId: SHOP_A,
      trackingNumber: "RR123SE",
      trackingUrl: "https://track.test/RR123SE",
      updatedAt: new Date(line?.updated_at as number).toISOString(),
      variantLabel: null,
    });
  });

  it("names nothing of the printer's cost, the production snapshot or the buyer, on any row", async () => {
    const response = await get("?limit=100");
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as Page;
    expect(mine(body).length).toBeGreaterThan(0);
    for (const row of body.jobs) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    }
    for (const forbidden of [
      "productionCost",
      "withhold",
      "Minor",
      "price",
      "commission",
      "tier",
      "margin",
      "printFiles",
      "r2Key",
      "pod/",
      SKU, // the printer's SKU lives only in the production snapshot
      BUYER,
      "buyer-",
      "@",
      "recipient",
      "address",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("lists printer lines only; the line the shop sends itself is not a job", async () => {
    const all = await ids("?limit=100");
    expect(all).toContain(jobs.aShipped);
    expect(all).not.toContain(printerJobId(multiLineOrder, 4));
  });

  it("gives the product and quantity as frozen on the line and the variant's label from the catalogue", async () => {
    const row = (await page(`?tenantId=${SHOP_A}&limit=100`)).jobs.find((job) => job.jobId === jobs.aVariant);
    expect(row).toMatchObject({ name: "Hoodie", quantity: 2, variantLabel: "Svart / M" });
    expect(row?.sku).toMatch(/^sku-variant-/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the filters", () => {
  it("state: each production state, and `none` for a line the printer has reported nothing on", async () => {
    expect(await ids("?state=shipped")).toEqual([jobs.aShipped]);
    expect(await ids("?state=produced")).toEqual([jobs.aProduced]);
    expect(await ids("?state=in_production")).toEqual([jobs.aInProduction]);
    expect(await ids("?state=none&limit=100")).toEqual(
      sorted(
        jobs.aAcceptedNone,
        jobs.aQueued,
        jobs.aVariant,
        jobs.aUnknown,
        jobs.aFailed,
        jobs.bAcceptedSnapwear,
        jobs.bCancelled,
        jobs.bPending,
        jobs.bSubmitting,
      ),
    );
  });

  it("dispatchState: each of 0022's states, and `none` for a line with no dispatch recorded", async () => {
    expect(await ids("?dispatchState=accepted")).toEqual(
      sorted(jobs.aAcceptedNone, jobs.aInProduction, jobs.aShipped, jobs.aProduced, jobs.bAcceptedSnapwear),
    );
    expect(await ids("?dispatchState=unknown")).toEqual([jobs.aUnknown]);
    expect(await ids("?dispatchState=failed")).toEqual([jobs.aFailed]);
    expect(await ids("?dispatchState=cancelled")).toEqual([jobs.bCancelled]);
    expect(await ids("?dispatchState=pending")).toEqual([jobs.bPending]);
    expect(await ids("?dispatchState=submitting")).toEqual([jobs.bSubmitting]);
    expect(await ids("?dispatchState=none")).toEqual(sorted(jobs.aQueued, jobs.aVariant));
  });

  it("tenantId: one shop's jobs; a shop with none (or none at all) is an empty page", async () => {
    const shopB = await page(`?tenantId=${SHOP_B}`);
    expect(shopB.jobs.every((job) => job.tenantId === SHOP_B && job.shopName === "Butik B")).toBe(true);
    expect(shopB.jobs.map((job) => job.jobId).sort()).toEqual(
      sorted(jobs.bAcceptedSnapwear, jobs.bCancelled, jobs.bPending, jobs.bSubmitting),
    );
    await expect(page("?tenantId=pjl-no-such-shop")).resolves.toEqual({ jobs: [], nextCursor: null });
  });

  it("printerId: the order's printer, from its snapshot", async () => {
    expect(await ids("?printerId=snapwear")).toEqual([jobs.bAcceptedSnapwear]);
    const fake = await ids("?printerId=fake-printer&limit=100");
    expect(fake).toHaveLength(11);
    expect(fake).not.toContain(jobs.bAcceptedSnapwear);
    expect(await ids("?printerId=no-such-printer")).toEqual([]);
  });

  it("combined: the jobs a human acts on with the status route (accepted, not shipped), per shop and printer", async () => {
    expect(await ids("?dispatchState=accepted&state=none")).toEqual(sorted(jobs.aAcceptedNone, jobs.bAcceptedSnapwear));
    expect(await ids(`?dispatchState=accepted&state=none&tenantId=${SHOP_A}`)).toEqual([jobs.aAcceptedNone]);
    expect(await ids(`?dispatchState=accepted&state=in_production&tenantId=${SHOP_A}&printerId=fake-printer`)).toEqual([
      jobs.aInProduction,
    ]);
    expect(await ids(`?dispatchState=accepted&tenantId=${SHOP_B}&printerId=fake-printer`)).toEqual([]);
    expect(await ids(`?dispatchState=none&state=none&tenantId=${SHOP_A}`)).toEqual(sorted(jobs.aQueued, jobs.aVariant));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the cursor", () => {
  it("walks every job once, in job order, on every index path (page boundaries inside a three-line order too)", async () => {
    const all = [...shopAJobs(), ...shopBJobs()];
    const cases: Array<[string, string[]]> = [
      ["", all],
      [`?tenantId=${SHOP_A}`, shopAJobs()],
      [
        `?tenantId=${SHOP_A}&dispatchState=accepted`,
        [jobs.aAcceptedNone, jobs.aInProduction, jobs.aShipped, jobs.aProduced],
      ],
      [
        "?dispatchState=accepted",
        [jobs.aAcceptedNone, jobs.aInProduction, jobs.aShipped, jobs.aProduced, jobs.bAcceptedSnapwear],
      ],
      ["?state=none", all.filter((job) => ![jobs.aInProduction, jobs.aShipped, jobs.aProduced].includes(job))],
    ];
    for (const [query, expected] of cases) {
      for (const limit of [1, 2, 3]) {
        const seen = await walk(query, limit);
        const label = `${query || "(no filter)"} / limit ${limit}`;
        expect(new Set(seen).size, `${label}: no duplicates`).toBe(seen.length);
        expect(seen, `${label}: served in job order`).toEqual(byJobOrder(seen));
        expect(
          seen.filter((jobId) => all.includes(jobId)),
          label,
        ).toEqual(byJobOrder(expected));
      }
    }
  });

  it("starts after the cursor's line, within its order: never again at line 1", async () => {
    const afterFirst = await page(
      `?cursor=${printerJobId(multiLineOrder, 1)}&tenantId=${SHOP_A}&dispatchState=accepted&limit=2`,
    );
    expect(afterFirst.jobs.map((job) => job.jobId)).toEqual([jobs.aInProduction, jobs.aShipped]);

    const afterLast = mine(await page(`?cursor=${jobs.aShipped}&limit=100`));
    const all = [...shopAJobs(), ...shopBJobs()];
    expect(afterLast).toEqual(byJobOrder(all).filter((jobId) => compareJobs(jobId, jobs.aShipped) > 0));
    expect(afterLast).not.toContain(jobs.aAcceptedNone);
  });

  it("takes a job id that was never listed: the walk resumes from where it would sort", async () => {
    const cursor = "00000000-0000-4000-8000-000000000000-1";
    const all = [...shopAJobs(), ...shopBJobs()];
    expect(mine(await page(`?cursor=${cursor}&limit=100`))).toEqual(byJobOrder(all));
    expect(mine(await page("?cursor=ffffffff-ffff-4fff-bfff-ffffffffffff-9999&limit=100"))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a malformed query is a 400, never ignored", () => {
  it("refuses unknown keys, repeated keys and every malformed value", async () => {
    for (const query of [
      "?nope=1",
      "?State=shipped",
      "?status=shipped",
      "?state=shipped&state=produced",
      "?tenantId=a&tenantId=b",
      "?limit=5&limit=5",
      "?state=",
      "?state=bogus",
      "?state=SHIPPED",
      "?state=printed",
      "?state=null",
      "?dispatchState=",
      "?dispatchState=done",
      "?dispatchState=Accepted",
      "?dispatchState=superseded",
      "?tenantId=",
      "?tenantId=Pjl-Shop-A",
      "?tenantId=pjl_shop",
      `?tenantId=${"a".repeat(65)}`,
      "?printerId=",
      "?printerId=default",
      "?printerId=Fake-Printer",
      "?printerId=fake printer",
      "?cursor=",
      "?cursor=nope",
      `?cursor=${multiLineOrder}`,
      `?cursor=${multiLineOrder}-0`,
      `?cursor=${multiLineOrder}-01`,
      `?cursor=${multiLineOrder.toUpperCase()}-1`,
      "?limit=",
      "?limit=0",
      "?limit=101",
      "?limit=1000",
      "?limit=-1",
      "?limit=1.5",
      "?limit=abc",
      "?limit=%201",
    ]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "invalid_request", message: "Request is not valid" },
      });
    }
  });

  it("accepts the bounds", async () => {
    expect((await get("?limit=1")).status).toBe(200);
    expect((await get("?limit=100")).status).toBe(200);
    expect((await page("?limit=1")).jobs).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the index each filter path uses", () => {
  const base: PrintJobListQuery = {
    cursor: null,
    dispatchState: null,
    exception: null,
    limit: 50,
    printerId: null,
    state: null,
    tenantId: null,
  };

  async function plan(patch: Partial<PrintJobListQuery>): Promise<string[]> {
    const { binds, sql } = printJobListSql({ ...base, ...patch });
    const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    return rows.results.map((row) => row.detail);
  }

  const cursor = { lineNo: 2, orderId: "00000000-0000-4000-8000-000000000000" };

  it("without a shop: the (order_id, item_index) index in order, from the cursor; no sort, no table scan", async () => {
    for (const patch of [
      {},
      { dispatchState: "accepted" as const },
      { dispatchState: "none" as const },
      { state: "none" as const },
      { printerId: "fake-printer" },
    ]) {
      const details = await plan(patch);
      expect(details[0], JSON.stringify(patch)).toMatch(/^SCAN i USING INDEX sqlite_autoindex_order_items_\d$/);
      expect(details.join(" | ")).not.toMatch(/TEMP B-TREE/);
    }
    const seek = await plan({ cursor, dispatchState: "accepted" });
    expect(seek[0]).toMatch(/^SEARCH i USING INDEX sqlite_autoindex_order_items_\d \(order_id>\?\)$/);
    expect(seek.join(" | ")).not.toMatch(/TEMP B-TREE/);
  });

  it("a shop and a dispatch state: order_items_tenant_dispatch_idx, two equality probes and the cursor's range", async () => {
    for (const dispatchState of ["accepted", "none"] as const) {
      const details = await plan({ dispatchState, state: "none", tenantId: SHOP_A });
      expect(details[0]).toBe(
        "SEARCH i USING INDEX order_items_tenant_dispatch_idx (tenant_id=? AND dispatch_state=?)",
      );
      // Only the line number within one order is sorted; never the page.
      expect(details.join(" | ")).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    }
    const seek = await plan({ cursor, dispatchState: "accepted", tenantId: SHOP_A });
    expect(seek[0]).toBe(
      "SEARCH i USING INDEX order_items_tenant_dispatch_idx (tenant_id=? AND dispatch_state=? AND order_id>?)",
    );
  });

  it("a shop alone: the same index on its tenant prefix, the shop's lines then sorted", async () => {
    const details = await plan({ tenantId: SHOP_A });
    expect(details[0]).toBe("SEARCH i USING INDEX order_items_tenant_dispatch_idx (tenant_id=?)");
    expect(details).toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("the order, the shop and the variant are primary-key lookups inside the line loop", async () => {
    const details = await plan({ printerId: "fake-printer", tenantId: SHOP_A });
    expect(details.slice(1, 4)).toEqual([
      "SEARCH o USING INDEX sqlite_autoindex_orders_1 (order_id=?)",
      "SEARCH t USING INDEX sqlite_autoindex_tenants_1 (tenant_id=?)",
      "SEARCH v USING INDEX sqlite_autoindex_product_variants_1 (variant_id=?) LEFT-JOIN",
    ]);
  });
});
