import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { PlatformPrincipal } from "../src/auth/live-authorization";
import {
  handleReport,
  REPORT_ALERT_KIND,
  type ReportSubmission,
  submitReport,
  takedownReportedProduct,
} from "../src/catalog/infringement-reports";
import { decideByPlatform } from "../src/catalog/screening";
import { readDigestContent } from "../src/commerce/alert-digest";
import { REPORT_IP_LIMIT } from "../src/routes/storefront-reports";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  catalogVersion,
  grantPlatformAdmin,
  grantTenantAdmin,
  PLATFORM,
  seedProduct,
  seedTenant,
  sessionRequest,
  signUp,
} from "./pod-fixtures";

/**
 * CP3-D — infringement reports (migration 0036, src/catalog/infringement-reports.ts):
 * the storefront intake, the platform queue, handling, and the takedown that
 * carries a report. Every person here is invented.
 */

const TENANT_A = "tenant-cp3d-rep-a";
const TENANT_B = "tenant-cp3d-rep-b";
const HOST_A = "rep-a.cp3d-reports.test";
const HOST_B = "rep-b.cp3d-reports.test";
const PLATFORM_HOST = "https://platform.cp3d-reports.test";
const ADMIN_HOST = "https://admin.cp3d-reports.test";

const REPORTER = {
  description: "The motif copies our registered figurative mark in full, colours included.",
  reporterEmail: "test.reporter@example.com",
  reporterName: "Test Reporter",
  reporterOrg: "Example Rights AB",
};
const REPORTER_STRINGS = [
  REPORTER.reporterEmail,
  REPORTER.reporterName,
  REPORTER.reporterOrg,
  REPORTER.description,
];

let platformSession: { cookie: string; userId: string };
let adminSession: { cookie: string; userId: string };
let actor: PlatformPrincipal;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

function fetchApp(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

function body(productId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attestation: true,
    description: REPORTER.description,
    productId,
    reporterEmail: REPORTER.reporterEmail,
    reporterName: REPORTER.reporterName,
    reporterOrg: REPORTER.reporterOrg,
    rightType: "trademark",
    website: "",
    ...overrides,
  };
}

function submit(host: string, payload: unknown, ip = nextIp()): Promise<Response> {
  return fetchApp(
    new Request(`https://${host}/v1/reports`, {
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
      headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
      method: "POST",
    }),
  );
}

function platform(
  method: string,
  path: string,
  payload?: unknown,
  extra: { cookie?: string; origin?: string | null; shopId?: string } = {},
): Promise<Response> {
  return fetchApp(
    sessionRequest(`${PLATFORM_HOST}${path}`, method, {
      body: payload,
      cookie: extra.cookie ?? platformSession.cookie,
      ...(extra.origin === undefined ? {} : { origin: extra.origin }),
      ...(extra.shopId === undefined ? {} : { shopId: extra.shopId }),
    }),
  );
}

async function expectOpaque404(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(404);
  await expect(response.json(), label).resolves.toEqual({
    error: { code: "not_found", message: "Route not found" },
  });
}

/** No key naming reporter data, and none of the reporter's strings anywhere. */
function expectNoReporterData(value: unknown, path = "$"): void {
  const text = JSON.stringify(value);
  for (const secret of REPORTER_STRINGS) {
    expect(text.includes(secret), `${path} carries "${secret}"`).toBe(false);
  }
  const walk = (entry: unknown, at: string): void => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      const lowered = key.toLowerCase();
      expect(
        ["reporter", "infringement", "righttype", "attestation"].find((part) => lowered.includes(part)),
        `${at}.${key}`,
      ).toBeUndefined();
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
}

async function reportRow(reportId: string) {
  return env.DB.prepare("SELECT * FROM infringement_reports WHERE report_id = ?")
    .bind(reportId)
    .first<Record<string, unknown>>();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

async function openAlert(reportId: string) {
  return env.DB.prepare(
    "SELECT id, tenant_id, kind, severity, message, resource_type, resource_id, resolved_at FROM alerts WHERE resource_type = 'infringement_report' AND resource_id = ?",
  )
    .bind(reportId)
    .first<{
      id: string;
      kind: string;
      message: string;
      resolved_at: string | null;
      resource_id: string;
      resource_type: string;
      severity: string;
      tenant_id: string;
    }>();
}

function contextOf(tenantId: string, hostname: string): TenantContext {
  return { domainKind: "storefront", hostname, tenantId };
}

const SUBMISSION: Omit<ReportSubmission, "productId"> = {
  attestation: true,
  description: REPORTER.description,
  productUrl: null,
  reporterEmail: REPORTER.reporterEmail,
  reporterName: REPORTER.reporterName,
  reporterOrg: REPORTER.reporterOrg,
  rightType: "trademark",
};

/** A report straight through the intake function (no limiter), at a chosen time. */
async function fileReport(tenantId: string, hostname: string, productId: string, now = Date.now()): Promise<string> {
  const result = await submitReport(env.DB, contextOf(tenantId, hostname), { ...SUBMISSION, productId }, now);
  if (result.status !== "ok") {
    throw new Error(`report on ${productId} not accepted`);
  }
  return result.reportId;
}

async function publicStatus(host: string, productId: string): Promise<number> {
  return (await fetchApp(new Request(`https://${host}/v1/products/${productId}`))).status;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A);
  await seedTenant(TENANT_B, HOST_B);
  for (const id of ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6", "a-7"]) {
    await seedProduct(TENANT_A, { name: `Poster ${id}`, productId: `rep-${id}`, published: true });
  }
  await seedProduct(TENANT_A, { name: "Draft poster", productId: "rep-a-draft", status: "draft" });
  await seedProduct(TENANT_B, { name: "Poster b-1", productId: "rep-b-1", published: true });

  platformSession = await signUp("cp3d-reports-platform@example.com");
  await grantPlatformAdmin(platformSession.userId);
  actor = { accountType: "platform_admin", userId: platformSession.userId };
  adminSession = await signUp("cp3d-reports-admin@example.com");
  await grantTenantAdmin(adminSession.userId, TENANT_A);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), platformSession.userId, TENANT_A, new Date(now).toISOString(), new Date(now + 3_600_000).toISOString())
    .run();
});

// ── intake ─────────────────────────────────────────────────────────────────

describe("POST /v1/reports — the storefront intake", () => {
  it("stores the report against the hostname shop's product and answers with the case reference only", async () => {
    const ip = "203.0.113.1";
    const response = await submit(HOST_A, body("rep-a-1", { productUrl: `https://${HOST_A}/p/rep-a-1` }), ip);
    expect(response.status).toBe(201);
    const answer = await response.json<{ report: { reportId: string } }>();
    expect(Object.keys(answer)).toEqual(["report"]);
    expect(Object.keys(answer.report)).toEqual(["reportId"]);
    const reportId = answer.report.reportId;

    const stored = await reportRow(reportId);
    expect(stored).toMatchObject({
      attestation: 1,
      description: REPORTER.description,
      handled_at: null,
      handled_by: null,
      note: null,
      product_id: "rep-a-1",
      product_name: "Poster a-1",
      product_url: `https://${HOST_A}/p/rep-a-1`,
      reporter_email: REPORTER.reporterEmail,
      reporter_name: REPORTER.reporterName,
      reporter_org: REPORTER.reporterOrg,
      right_type: "trademark",
      source: "storefront",
      status: "new",
      tenant_id: TENANT_A,
      version: 1,
    });
    // The IP is the limiter's key only: never on the report, never raw in D1.
    expect(JSON.stringify(stored)).not.toContain(ip);
    const windows = await env.DB.prepare("SELECT * FROM rate_limit_windows WHERE scope = 'report-ip'").all();
    expect(windows.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(windows.results)).not.toContain(ip);
  });

  it("raises one alert for the digest — naming the report and the shop, never the reporter", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-1");
    const alert = await openAlert(reportId);
    expect(alert).toMatchObject({
      kind: REPORT_ALERT_KIND,
      resolved_at: null,
      resource_id: reportId,
      resource_type: "infringement_report",
      severity: "warning",
      tenant_id: TENANT_A,
    });
    expect(alert?.message).toContain(reportId);
    expect(alert?.message).toContain(TENANT_A);
    expectNoReporterData(alert);

    const digest = await readDigestContent(env.DB, "", new Date().toISOString());
    const kind = digest.kinds.find((entry) => entry.kind === REPORT_ALERT_KIND);
    expect(kind).toMatchObject({ severity: "warning" });
    expect(kind?.resourceIds.length).toBeGreaterThan(0);
    expectNoReporterData(digest);
  });

  it("an empty honeypot and absent optional fields are fine", async () => {
    const response = await submit(HOST_A, body("rep-a-2", { reporterOrg: undefined, website: undefined }));
    expect(response.status).toBe(201);
    const { report } = await response.json<{ report: { reportId: string } }>();
    expect(await reportRow(report.reportId)).toMatchObject({ product_url: null, reporter_org: null });
  });

  it("accepts a product of the shop in any state (Firebase resolves any product of the shop)", async () => {
    expect((await submit(HOST_A, body("rep-a-draft"))).status).toBe(201);
  });

  it("a filled honeypot, another shop's product and an unknown product get ONE identical answer and write nothing", async () => {
    const reports = await count("SELECT COUNT(*) AS n FROM infringement_reports");
    const alerts = await count("SELECT COUNT(*) AS n FROM alerts WHERE kind = ?", REPORT_ALERT_KIND);
    const answers = await Promise.all([
      submit(HOST_A, body("rep-a-3", { website: "https://spam.example.com" })),
      submit(HOST_A, body("rep-b-1")),
      submit(HOST_A, body("rep-no-such-product")),
    ]);
    const bodies = await Promise.all(answers.map((response) => response.text()));
    expect(answers.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
    expect(new Set(answers.map((response) => [...response.headers.entries()].filter(([name]) => name !== "date").join("|"))).size).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM infringement_reports")).toBe(reports);
    expect(await count("SELECT COUNT(*) AS n FROM alerts WHERE kind = ?", REPORT_ALERT_KIND)).toBe(alerts);
  });

  it.each([
    ["no attestation", { attestation: undefined }],
    ["attestation false", { attestation: false }],
    ["attestation as a string", { attestation: "true" }],
    ["a description under 20 characters", { description: "Too short to act on" }],
    ["a description over 5000 characters", { description: "d".repeat(5_001) }],
    ["an invalid email", { reporterEmail: "not-an-address" }],
    ["no name", { reporterName: "   " }],
    ["a name over 200 characters", { reporterName: "n".repeat(201) }],
    ["an organisation over 200 characters", { reporterOrg: "o".repeat(201) }],
    ["an unknown right type", { rightType: "patent" }],
    ["a product url with a line break", { productUrl: "https://example.com/\nx" }],
    ["an unknown key", { phone: "0700000000" }],
    ["a malformed product id", { productId: "rep a 1" }],
  ])("refuses %s (400, nothing written)", async (_label, overrides) => {
    const reports = await count("SELECT COUNT(*) AS n FROM infringement_reports");
    const response = await submit(HOST_A, body("rep-a-3", overrides));
    expect(response.status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM infringement_reports")).toBe(reports);
  });

  it("refuses a body that is not a JSON object", async () => {
    expect((await submit(HOST_A, "not json")).status).toBe(400);
    expect((await submit(HOST_A, [body("rep-a-3")])).status).toBe(400);
  });

  it(`limits one IP to ${REPORT_IP_LIMIT} per hour: the sixth request is a 429, refused attempts count too`, async () => {
    const ip = "203.0.113.2";
    const statuses: number[] = [];
    for (let index = 0; index < REPORT_IP_LIMIT; index += 1) {
      const payload = index % 2 === 0 ? body("rep-a-3") : body("rep-a-3", { website: "bot" });
      statuses.push((await submit(HOST_A, payload, ip)).status);
    }
    expect(statuses).toEqual([201, 400, 201, 400, 201]);
    const sixth = await submit(HOST_A, body("rep-a-3"), ip);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(sixth.json()).resolves.toEqual({ error: { code: "rate_limited", message: "Too many requests" } });
    // Another address is unaffected.
    expect((await submit(HOST_A, body("rep-a-3"), "203.0.113.3")).status).toBe(201);
  });

  it("is a storefront route: unknown host 404, only POST, and it obeys the public-entrypoint rule", async () => {
    expect((await submit("nobody.cp3d-reports.test", body("rep-a-3"))).status).toBe(404);
    expect((await fetchApp(new Request(`https://${HOST_A}/v1/reports`))).status).toBe(404);
    const request = () =>
      new Request(`https://${HOST_A}/v1/reports`, {
        body: JSON.stringify(body("rep-a-3")),
        headers: { "cf-connecting-ip": nextIp(), "content-type": "application/json" },
        method: "POST",
      });
    const closedPublic = createApp({ publicStorefrontAllowed: false, surface: "public" });
    expect((await closedPublic.fetch(request(), env)).status).toBe(404);
    const closedInternal = createApp({ publicStorefrontAllowed: false, surface: "internal" });
    expect((await closedInternal.fetch(request(), env)).status).toBe(201);
  });
});

// ── the platform queue ─────────────────────────────────────────────────────

describe("the platform report routes — who may call", () => {
  let reportId: string;

  beforeAll(async () => {
    reportId = await fileReport(TENANT_A, HOST_A, "rep-a-4");
  });

  it("anonymous, the reported shop's admin and a platform user acting as that shop get the opaque 404 — and nothing changes", async () => {
    const routes: Array<[string, string, unknown]> = [
      ["GET", "/v1/platform/reports", undefined],
      ["GET", `/v1/platform/reports/${reportId}`, undefined],
      ["POST", `/v1/platform/reports/${reportId}/handle`, { status: "rejected" }],
      ["POST", `/v1/platform/reports/${reportId}/takedown`, { note: "x" }],
    ];
    for (const [method, path, payload] of routes) {
      const url = `${PLATFORM_HOST}${path}`;
      await expectOpaque404(
        await fetchApp(new Request(url, { body: payload === undefined ? undefined : JSON.stringify(payload), headers: { origin: PLATFORM_HOST }, method })),
        `${method} ${path} anonymous`,
      );
      const asAdmin = await platform(method, path, payload, { cookie: adminSession.cookie, shopId: TENANT_A });
      expect(asAdmin.status).toBe(404);
      const adminBody = await asAdmin.json();
      expectNoReporterData(adminBody);
      await expectOpaque404(await platform(method, path, payload, { shopId: TENANT_A }), `${method} ${path} acting as the shop`);
    }
    expect(await reportRow(reportId)).toMatchObject({ status: "new", version: 1 });
    expect(await publicStatus(HOST_A, "rep-a-4")).toBe(200);
  });

  it("a cross-origin or origin-less POST is the same 404 and changes nothing", async () => {
    for (const origin of ["https://attacker.example.com", null]) {
      await expectOpaque404(
        await platform("POST", `/v1/platform/reports/${reportId}/handle`, { status: "rejected" }, { origin }),
        `handle ${origin}`,
      );
      await expectOpaque404(
        await platform("POST", `/v1/platform/reports/${reportId}/takedown`, {}, { origin }),
        `takedown ${origin}`,
      );
    }
    expect(await reportRow(reportId)).toMatchObject({ status: "new", version: 1 });
    expect(await publicStatus(HOST_A, "rep-a-4")).toBe(200);
  });

  it("the platform session reaches the list and the report", async () => {
    expect((await platform("GET", "/v1/platform/reports")).status).toBe(200);
    const detail = await platform("GET", `/v1/platform/reports/${reportId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      report: {
        attestation: true,
        description: REPORTER.description,
        productId: "rep-a-4",
        productName: "Poster a-4",
        productTakenDown: false,
        reportId,
        reporterEmail: REPORTER.reporterEmail,
        reporterName: REPORTER.reporterName,
        reporterOrg: REPORTER.reporterOrg,
        rightType: "trademark",
        source: "storefront",
        status: "new",
        tenantId: TENANT_A,
      },
    });
    expect((await platform("GET", "/v1/platform/reports/no-such-report")).status).toBe(404);
    expect((await platform("GET", "/v1/platform/reports/a%2Fb")).status).toBe(404);
    expect((await platform("GET", `/v1/platform/reports/${"x".repeat(129)}`)).status).toBe(404);
  });
});

describe("the list: newest first, filters, cursor, the badge", () => {
  const base = Date.parse("2031-01-01T00:00:00.000Z");
  const ids: string[] = [];

  beforeAll(async () => {
    // Later than every other report in this file, so they head the list.
    ids.push(await fileReport(TENANT_A, HOST_A, "rep-a-5", base));
    ids.push(await fileReport(TENANT_B, HOST_B, "rep-b-1", base + 1_000));
    ids.push(await fileReport(TENANT_A, HOST_A, "rep-a-5", base + 2_000));
  });

  it("lists newest first with the new-count badge", async () => {
    const response = await platform("GET", "/v1/platform/reports?limit=3");
    expect(response.status).toBe(200);
    const listed = await response.json<{ newCount: number; nextCursor: string | null; reports: Array<{ reportId: string }> }>();
    expect(listed.reports.map((report) => report.reportId)).toEqual([...ids].reverse());
    expect(listed.newCount).toBe(await count("SELECT COUNT(*) AS n FROM infringement_reports WHERE status = 'new'"));
    expect(listed.nextCursor).not.toBeNull();
  });

  it("filters by status and by shop; the badge counts every shop's new reports whatever the filter", async () => {
    const newBefore = await count("SELECT COUNT(*) AS n FROM infringement_reports WHERE status = 'new'");
    expect((await handleReport(env.DB, actor, ids[0] as string, { status: "reviewing" }, Date.now())).status).toBe("ok");
    const reviewing = await (await platform("GET", "/v1/platform/reports?status=reviewing")).json<{
      newCount: number;
      reports: Array<{ reportId: string; status: string }>;
    }>();
    expect(reviewing.reports.map((report) => report.reportId)).toContain(ids[0]);
    expect(reviewing.reports.every((report) => report.status === "reviewing")).toBe(true);
    expect(reviewing.newCount).toBe(newBefore - 1);
    const shopB = await (await platform("GET", `/v1/platform/reports?tenantId=${TENANT_B}`)).json<{
      reports: Array<{ tenantId: string }>;
    }>();
    expect(shopB.reports.length).toBeGreaterThan(0);
    expect(shopB.reports.every((report) => report.tenantId === TENANT_B)).toBe(true);
  });

  it("walks every report exactly once with the cursor", async () => {
    const all = await (await platform("GET", "/v1/platform/reports?limit=100")).json<{ reports: Array<{ reportId: string }> }>();
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const response = await platform(
        "GET",
        `/v1/platform/reports?limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      const listed = await response.json<{ nextCursor: string | null; reports: Array<{ reportId: string }> }>();
      walked.push(...listed.reports.map((report) => report.reportId));
      cursor = listed.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(walked).toEqual(all.reports.map((report) => report.reportId));
  });

  it.each(["status=open", "limit=0", "limit=101", "cursor=yesterday", "tenantId=Not_A_Tenant", "sort=asc"])(
    "refuses ?%s (400)",
    async (query) => {
      expect((await platform("GET", `/v1/platform/reports?${query}`)).status).toBe(400);
    },
  );
});

// ── handling ───────────────────────────────────────────────────────────────

describe("handling: reviewing / rejected and which moves are final", () => {
  it("new → reviewing → rejected → reviewing (reopen); same-status moves are refused", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-5");
    const handle = (payload: unknown) => platform("POST", `/v1/platform/reports/${reportId}/handle`, payload);

    const reviewing = await handle({ status: "reviewing" });
    expect(reviewing.status).toBe(200);
    await expect(reviewing.json()).resolves.toMatchObject({
      report: { handledBy: platformSession.userId, note: null, status: "reviewing", version: 2 },
    });
    // The arrival alert has done its job.
    expect((await openAlert(reportId))?.resolved_at).not.toBeNull();

    const again = await handle({ status: "reviewing" });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: { code: "transition_refused" } });

    const rejected = await handle({ note: "No mark registration was supplied.", status: "rejected" });
    expect(rejected.status).toBe(200);
    await expect(rejected.json()).resolves.toMatchObject({
      report: { note: "No mark registration was supplied.", status: "rejected" },
    });
    expect((await handle({ status: "rejected" })).status).toBe(409);

    const reopened = await handle({ status: "reviewing" });
    expect(reopened.status).toBe(200);
    // An absent note keeps the stored one.
    await expect(reopened.json()).resolves.toMatchObject({
      report: { note: "No mark registration was supplied.", status: "reviewing", version: 4 },
    });

    const audits = await env.DB.prepare(
      `SELECT action, tenant_id, actor_user_id, reason, metadata_json FROM audit_events
       WHERE resource_type = 'infringement_report' AND resource_id = ? ORDER BY created_at, rowid`,
    )
      .bind(reportId)
      .all<{ action: string; actor_user_id: string; metadata_json: string; reason: string | null; tenant_id: string }>();
    expect(audits.results.map((audit) => audit.action)).toEqual([
      "report.reviewing",
      "report.rejected",
      "report.reviewing",
    ]);
    expect(audits.results.every((audit) => audit.tenant_id === TENANT_A && audit.actor_user_id === platformSession.userId)).toBe(true);
    expect(audits.results[1]?.reason).toBe("No mark registration was supplied.");
    expectNoReporterData(audits.results);
  });

  it("new → rejected directly is allowed", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-5");
    const response = await platform("POST", `/v1/platform/reports/${reportId}/handle`, { status: "rejected" });
    expect(response.status).toBe(200);
    expect(await reportRow(reportId)).toMatchObject({ handled_by: platformSession.userId, status: "rejected" });
  });

  it.each([
    ["taken_down through handle", { status: "taken_down" }],
    ["back to new", { status: "new" }],
    ["a note over 2000 characters", { note: "n".repeat(2_001), status: "rejected" }],
    ["an unknown key", { reason: "x", status: "rejected" }],
    ["no status", { note: "x" }],
  ])("refuses %s (400)", async (_label, payload) => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-5");
    expect((await platform("POST", `/v1/platform/reports/${reportId}/handle`, payload)).status).toBe(400);
    expect(await reportRow(reportId)).toMatchObject({ status: "new", version: 1 });
  });

  it("an unknown report is 404", async () => {
    expect((await platform("POST", "/v1/platform/reports/no-such-report/handle", { status: "rejected" })).status).toBe(404);
    expect((await platform("POST", "/v1/platform/reports/no-such-report/takedown", {})).status).toBe(404);
  });

  it("a handling that raced another one answers 409 and writes nothing", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-5");
    let attempt = 0;
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            attempt += 1;
            if (attempt === 1) {
              await handleReport(env.DB, actor, reportId, { status: "reviewing" }, Date.now());
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await handleReport(racing, actor, reportId, { note: "late", status: "rejected" }, Date.now());
    expect(result).toEqual({ code: "conflict", status: "conflict" });
    expect(await reportRow(reportId)).toMatchObject({ note: null, status: "reviewing", version: 2 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'report.rejected'", reportId)).toBe(0);
  });

  it("the schema holds the same rules: no way out of taken_down, facts immutable, no delete, no cross-shop product", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-5");
    await expect(
      env.DB.prepare("UPDATE infringement_reports SET status = 'new' WHERE report_id = ?").bind(reportId).run(),
    ).rejects.toThrow(/status transition refused/);
    await expect(
      env.DB.prepare("UPDATE infringement_reports SET reporter_email = 'other@example.com' WHERE report_id = ?")
        .bind(reportId)
        .run(),
    ).rejects.toThrow(/facts are immutable/);
    await expect(
      env.DB.prepare("DELETE FROM infringement_reports WHERE report_id = ?").bind(reportId).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare(
        `INSERT INTO infringement_reports (
           report_id, tenant_id, product_id, reporter_name, reporter_email, right_type,
           description, attestation, created_at
         ) VALUES ('cross-shop', ?, 'rep-b-1', 'Test Reporter', 'test.reporter@example.com',
                   'other', 'A description long enough to store.', 1, ?)`,
      )
        .bind(TENANT_A, new Date().toISOString())
        .run(),
    ).rejects.toThrow(/must match product tenant_id/);
    await expect(
      env.DB.prepare(
        `INSERT INTO infringement_reports (
           report_id, tenant_id, product_id, reporter_name, reporter_email, right_type,
           description, attestation, created_at
         ) VALUES ('no-attestation', ?, 'rep-a-5', 'Test Reporter', 'test.reporter@example.com',
                   'other', 'A description long enough to store.', 0, ?)`,
      )
        .bind(TENANT_A, new Date().toISOString())
        .run(),
    ).rejects.toThrow();
  });
});

// ── takedown with a report ─────────────────────────────────────────────────

describe("takedown with a report: the one takedown and the report in ONE batch", () => {
  it("takes the product down, closes the report, resolves its alert, audits both — and the next public read is 404", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-6");
    expect((await handleReport(env.DB, actor, reportId, { status: "reviewing" }, Date.now())).status).toBe("ok");
    expect(await publicStatus(HOST_A, "rep-a-6")).toBe(200);
    const before = await catalogVersion(TENANT_A);

    const response = await platform("POST", `/v1/platform/reports/${reportId}/takedown`, {
      note: "Registration certificate verified.",
      productId: "rep-a-6",
    });
    expect(response.status).toBe(200);
    const answer = await response.json<{ report: Record<string, unknown>; screening: Record<string, unknown> }>();
    expect(answer.report).toMatchObject({
      handledBy: platformSession.userId,
      note: "Registration certificate verified.",
      productTakenDown: true,
      status: "taken_down",
      version: 3,
    });
    expect(answer.screening).toMatchObject({ productId: "rep-a-6", reason: "takedown", status: "blocked", takenDown: true });

    expect(await publicStatus(HOST_A, "rep-a-6")).toBe(404);
    expect(await catalogVersion(TENANT_A)).toBeGreaterThan(before);
    expect((await openAlert(reportId))?.resolved_at).not.toBeNull();
    const takedownAudit = await env.DB.prepare(
      "SELECT tenant_id, actor_user_id, reason, metadata_json FROM audit_events WHERE action = 'screening.takedown' AND resource_id = 'rep-a-6'",
    ).first<{ actor_user_id: string; metadata_json: string; reason: string; tenant_id: string }>();
    expect(takedownAudit).toMatchObject({
      actor_user_id: platformSession.userId,
      reason: "Registration certificate verified.",
      tenant_id: TENANT_A,
    });
    expect(JSON.parse(takedownAudit?.metadata_json ?? "{}")).toEqual({
      decision: "blocked",
      reportId,
      source: "infringement_report",
    });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'report.taken_down' AND resource_id = ?", reportId)).toBe(1);

    // Final.
    const again = await platform("POST", `/v1/platform/reports/${reportId}/takedown`, {});
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: { code: "report_closed" } });
    expect((await platform("POST", `/v1/platform/reports/${reportId}/handle`, { status: "reviewing" })).status).toBe(409);
  });

  it("a second report on an already taken-down product closes too, keeping the first takedown stamp", async () => {
    const stamp = await env.DB.prepare("SELECT takedown_at FROM products WHERE product_id = 'rep-a-6'").first<{ takedown_at: string }>();
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-6");
    expect((await platform("POST", `/v1/platform/reports/${reportId}/takedown`, {})).status).toBe(200);
    expect(await env.DB.prepare("SELECT takedown_at FROM products WHERE product_id = 'rep-a-6'").first()).toEqual(stamp);
  });

  it("refuses to take down a product the report is not about — another shop's product included", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-7");
    const response = await platform("POST", `/v1/platform/reports/${reportId}/takedown`, { productId: "rep-b-1" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "product_mismatch" } });
    expect(await reportRow(reportId)).toMatchObject({ status: "new", version: 1 });
    expect(await publicStatus(HOST_B, "rep-b-1")).toBe(200);
    expect(await publicStatus(HOST_A, "rep-a-7")).toBe(200);
  });

  it("a report whose shop is not its product's shop (only possible by bypassing 0036's trigger) can never take that product down", async () => {
    const trigger = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'infringement_reports_tenant_matches_product'",
    ).first<{ sql: string }>();
    expect(trigger?.sql).toContain("must match product tenant_id");
    await env.DB.prepare("DROP TRIGGER infringement_reports_tenant_matches_product").run();
    try {
      await env.DB.prepare(
        `INSERT INTO infringement_reports (
           report_id, tenant_id, product_id, reporter_name, reporter_email, right_type,
           description, attestation, created_at
         ) VALUES ('forged-cross-shop', ?, 'rep-b-1', 'Test Reporter', 'test.reporter@example.com',
                   'copyright', 'A description long enough to store.', 1, ?)`,
      )
        .bind(TENANT_A, new Date().toISOString())
        .run();
    } finally {
      await env.DB.prepare(trigger?.sql ?? "").run();
    }
    const response = await platform("POST", "/v1/platform/reports/forged-cross-shop/takedown", {});
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "tenant_mismatch" } });
    expect(await publicStatus(HOST_B, "rep-b-1")).toBe(200);
    expect(await reportRow("forged-cross-shop")).toMatchObject({ status: "new", version: 1 });
    expect((await env.DB.prepare("SELECT takedown_at FROM products WHERE product_id = 'rep-b-1'").first())).toEqual({ takedown_at: null });
  });

  it("an injected failure in the batch leaves the product, its screening, the report, the alert and the audit trail untouched", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-7");
    const snapshot = async () => ({
      alert: await openAlert(reportId),
      audits: await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id IN (?, 'rep-a-7')", reportId),
      product: await env.DB.prepare("SELECT takedown_at, updated_at FROM products WHERE product_id = 'rep-a-7'").first(),
      report: await reportRow(reportId),
      screening: await env.DB.prepare("SELECT * FROM product_screening WHERE product_id = 'rep-a-7'").first(),
    });
    const before = await snapshot();
    let batches = 0;
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batches += 1;
            // The last statement of the batch fails (a NOT NULL primary key).
            return target.batch([...statements, target.prepare("INSERT INTO audit_events (event_id) VALUES (NULL)")]);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    await expect(
      takedownReportedProduct(failing, actor, reportId, { note: "Should not land." }, Date.now()),
    ).rejects.toThrow();
    expect(batches).toBe(1);
    await expect(snapshot()).resolves.toEqual(before);
    expect(before.product).toMatchObject({ takedown_at: null });
    expect(await publicStatus(HOST_A, "rep-a-7")).toBe(200);
  });

  it("a report handled between the takedown's read and its batch aborts the whole takedown (409)", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-7");
    let attempt = 0;
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            attempt += 1;
            if (attempt === 1) {
              await handleReport(env.DB, actor, reportId, { status: "rejected" }, Date.now());
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(takedownReportedProduct(racing, actor, reportId, {}, Date.now())).resolves.toEqual({
      code: "conflict",
      status: "conflict",
    });
    expect((await env.DB.prepare("SELECT takedown_at FROM products WHERE product_id = 'rep-a-7'").first())).toEqual({ takedown_at: null });
    expect(await reportRow(reportId)).toMatchObject({ status: "rejected" });
    expect(await publicStatus(HOST_A, "rep-a-7")).toBe(200);
  });

  it("decideByPlatform refuses a report on an approval; reinstating a product leaves its report closed", async () => {
    await expect(
      decideByPlatform(env.DB, PLATFORM, "rep-a-6", "approved", Date.now(), { note: null, reportId: "x", statements: [] }),
    ).rejects.toThrow(/only a takedown/);
    await decideByPlatform(env.DB, PLATFORM, "rep-a-6", "approved", Date.now());
    expect(await publicStatus(HOST_A, "rep-a-6")).toBe(200);
    const closed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM infringement_reports WHERE product_id = 'rep-a-6' AND status <> 'taken_down'",
    ).first<{ n: number }>();
    expect(closed?.n).toBe(0);
  });
});

// ── the reporter's data stays on the platform ──────────────────────────────

describe("reporter data never reaches a tenant, the storefront or a screening row", () => {
  it("the reported shop's admin responses, the public reads and the screening rows carry none of it", async () => {
    const reportId = await fileReport(TENANT_A, HOST_A, "rep-a-2");
    const edited = await fetchApp(
      sessionRequest(`${ADMIN_HOST}/v1/admin/products/rep-a-2`, "PATCH", {
        body: { name: "Poster a-2 renamed" },
        cookie: adminSession.cookie,
        shopId: TENANT_A,
      }),
    );
    expect(edited.status).toBe(200);
    expectNoReporterData(await edited.json());
    for (const path of ["/v1/products", "/v1/products/rep-a-2", "/v1/storefront"]) {
      const response = await fetchApp(new Request(`https://${HOST_A}${path}`));
      expectNoReporterData(await response.json(), path);
    }
    const screening = await env.DB.prepare("SELECT * FROM product_screening WHERE tenant_id = ?").bind(TENANT_A).all();
    expectNoReporterData(screening.results);
    const alerts = await platform("GET", `/v1/platform/alerts?tenantId=${TENANT_A}&limit=100`);
    expect(alerts.status).toBe(200);
    const alertBody = await alerts.json<{ alerts: Array<{ resourceId: string }> }>();
    expect(alertBody.alerts.map((alert) => alert.resourceId)).toContain(reportId);
    expectNoReporterData(alertBody);
  });
});
