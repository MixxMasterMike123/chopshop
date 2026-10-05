import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { handleAdminCheckoutRemindersRoute } from "../src/routes/admin-checkout-reminders";
import { grantActingAs, OPAQUE_NOT_FOUND, signUp } from "./pod-fixtures";
import { DAY_MS, nextId, seedCheckout, seedReminderShop, setAddOn } from "./reminder-fixtures";

/**
 * CP9-AC build step 8: the seller's switch (GET/PUT /v1/admin/checkout-reminders):
 * the defaults, enabled_at (only a checkout made after the switch went on is
 * ever reminded), the strict body, the add-on gate, same origin, acting-as
 * with its grant audited, the one count, and mailConfigured.
 */

const PATH = "/v1/admin/checkout-reminders";

interface Shop {
  admin: { cookie: string; userId: string };
  origin: string;
  tenantId: string;
}

interface ViewBody {
  checkoutReminders: {
    delayHours: number;
    enabled: boolean;
    enabledAt: string | null;
    mailConfigured: boolean;
    queuedLast30Days: number;
    updatedAt: string | null;
  };
}

async function access(userId: string, accountType: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
  )
    .bind(userId, accountType, now, now)
    .run();
}

async function shop(options: { addOn?: boolean | null } = {}): Promise<Shop> {
  const tenantId = nextId("aca").toLowerCase();
  await seedReminderShop(tenantId, { addOn: options.addOn === undefined ? true : options.addOn, seller: null });
  const origin = `https://admin.${tenantId}.test`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'verified', ?, ?)`,
  )
    .bind(`admin-${tenantId}`, tenantId, new URL(origin).host, now, now)
    .run();
  const admin = await signUp(`${tenantId}@admin.test`);
  await access(admin.userId, "tenant_admin");
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(`m-${tenantId}`, tenantId, admin.userId, now, now)
    .run();
  return { admin, origin, tenantId };
}

function call(
  s: Shop,
  method: string,
  options: { body?: unknown; cookie?: string; origin?: string | null; shopId?: string } = {},
): Promise<Response> {
  const headers = new Headers({ cookie: options.cookie ?? s.admin.cookie, "x-shop-id": options.shopId ?? s.tenantId });
  const origin = options.origin === undefined ? s.origin : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return exports.default.fetch(
    new Request(`${s.origin}${PATH}`, {
      body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body),
      headers,
      method,
    }),
  );
}

async function viewOf(response: Response): Promise<ViewBody["checkoutReminders"]> {
  expect(response.status).toBe(200);
  return (await response.json<ViewBody>()).checkoutReminders;
}

async function stored(tenantId: string) {
  return env.DB.prepare("SELECT enabled, delay_hours, enabled_at, updated_by FROM checkout_reminder_settings WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ delay_hours: number; enabled: number; enabled_at: number | null; updated_by: string }>();
}

let a: Shop;

beforeAll(async () => {
  a = await shop();
});

describe("GET", () => {
  it("answers the defaults without a row: off, 1 hour, no dates, no reminders", async () => {
    const s = await shop();
    expect(await viewOf(await call(s, "GET"))).toEqual({
      delayHours: 1,
      enabled: false,
      enabledAt: null,
      mailConfigured: true,
      queuedLast30Days: 0,
      updatedAt: null,
    });
  });

  it("says when no mail can leave (no RESEND_API_KEY / EMAIL_FROM)", async () => {
    const s = await shop();
    const request = new Request(`${s.origin}${PATH}`, {
      headers: { cookie: s.admin.cookie, origin: s.origin, "x-shop-id": s.tenantId },
    });
    const response = await handleAdminCheckoutRemindersRoute({ ...env, RESEND_API_KEY: undefined } as unknown as Env, request);
    expect((await viewOf(response)).mailConfigured).toBe(false);
  });

  it("counts this shop's queued reminders of the last 30 days, nothing else", async () => {
    const s = await shop();
    const now = Date.now();
    const insert = async (tenantId: string, state: string, decidedAt: number) => {
      const checkout = await seedCheckout(tenantId, { createdAt: decidedAt - DAY_MS });
      await env.DB.prepare(
        `INSERT INTO checkout_reminders (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
           decided_at, link_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          tenantId,
          checkout.checkoutId,
          crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
          state,
          state === "queued" ? null : "no_consent",
          decidedAt,
          state === "skipped" ? null : decidedAt + 7 * DAY_MS,
          decidedAt,
          decidedAt,
        )
        .run();
    };
    await insert(s.tenantId, "queued", now - DAY_MS);
    await insert(s.tenantId, "queued", now - 29 * DAY_MS);
    await insert(s.tenantId, "queued", now - 31 * DAY_MS);
    await insert(s.tenantId, "skipped", now - DAY_MS);
    await insert(a.tenantId, "queued", now - DAY_MS);
    expect((await viewOf(await call(s, "GET"))).queuedLast30Days).toBe(2);
    const text = await (await call(s, "GET")).text();
    expect(text).not.toMatch(/@|checkout_id|buyer/);
  });
});

describe("PUT", () => {
  it("turns the switch on at now, keeps that time while it stays on or goes off, moves it on the next on", async () => {
    const s = await shop();
    const t1 = 1_790_000_000_000;
    const put = (body: unknown, now: number) =>
      handleAdminCheckoutRemindersRoute(
        env,
        new Request(`${s.origin}${PATH}`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", cookie: s.admin.cookie, origin: s.origin, "x-shop-id": s.tenantId },
          method: "PUT",
        }),
        { now },
      );
    const on = await viewOf(await put({ delayHours: 3, enabled: true }, t1));
    expect(on).toMatchObject({ delayHours: 3, enabled: true, enabledAt: new Date(t1).toISOString(), updatedAt: new Date(t1).toISOString() });
    expect(await stored(s.tenantId)).toEqual({ delay_hours: 3, enabled: 1, enabled_at: t1, updated_by: s.admin.userId });
    await put({ delayHours: 5, enabled: true }, t1 + 1_000);
    expect((await stored(s.tenantId))?.enabled_at).toBe(t1);
    await put({ delayHours: 5, enabled: false }, t1 + 2_000);
    expect(await stored(s.tenantId)).toMatchObject({ enabled: 0, enabled_at: t1 });
    await put({ delayHours: 5, enabled: true }, t1 + 3_000);
    expect((await stored(s.tenantId))?.enabled_at).toBe(t1 + 3_000);
  });

  it("a first write with the switch off stores no enabled_at", async () => {
    const s = await shop();
    expect(await viewOf(await call(s, "PUT", { body: { delayHours: 2, enabled: false } }))).toMatchObject({
      delayHours: 2,
      enabled: false,
      enabledAt: null,
    });
    expect(await stored(s.tenantId)).toMatchObject({ enabled: 0, enabled_at: null });
  });

  it.each([
    ["no body", undefined],
    ["not JSON", "{"],
    ["an array", [true, 1]],
    ["a missing key", { enabled: true }],
    ["an extra key", { delayHours: 1, enabled: true, enabledAt: 1 }],
    ["a string switch", { delayHours: 1, enabled: "true" }],
    ["delay 0", { delayHours: 0, enabled: true }],
    ["delay 25", { delayHours: 25, enabled: true }],
    ["a fractional delay", { delayHours: 1.5, enabled: true }],
    ["a string delay", { delayHours: "1", enabled: true }],
  ])("answers 400 for %s and writes nothing", async (_label, body) => {
    const s = await shop();
    const response = await call(s, "PUT", { body: body ?? "" });
    expect(response.status).toBe(400);
    expect(await stored(s.tenantId)).toBeNull();
  });

  it("audits the write: the values, never more", async () => {
    const s = await shop();
    await call(s, "PUT", { body: { delayHours: 4, enabled: true } });
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, action, resource_type, resource_id, metadata_json FROM audit_events WHERE tenant_id = ? AND action = 'checkout_reminders.settings'",
    )
      .bind(s.tenantId)
      .all<Record<string, string>>();
    expect(audit.results).toEqual([
      {
        action: "checkout_reminders.settings",
        actor_user_id: s.admin.userId,
        metadata_json: JSON.stringify({ delayHours: 4, enabled: true }),
        resource_id: s.tenantId,
        resource_type: "checkout_reminder_settings",
      },
    ]);
  });

  it("bumps the shop's catalog_version (the storefront's feature reads the switch)", async () => {
    const s = await shop();
    const version = async () =>
      (await env.DB.prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ?").bind(s.tenantId).first<{ catalog_version: number }>())
        ?.catalog_version;
    const before = await version();
    await call(s, "PUT", { body: { delayHours: 1, enabled: true } });
    expect(await version()).toBe((before ?? 0) + 1);
  });
});

describe("who may", () => {
  it("answers the opaque 404 to both methods while the platform's add-on is off, or was never on", async () => {
    for (const addOn of [false, null] as const) {
      const s = await shop({ addOn });
      for (const response of [await call(s, "GET"), await call(s, "PUT", { body: { delayHours: 1, enabled: true } })]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(OPAQUE_NOT_FOUND);
      }
      expect(await stored(s.tenantId)).toBeNull();
    }
    const s = await shop();
    await setAddOn(s.tenantId, false);
    expect((await call(s, "GET")).status).toBe(404);
  });

  it("answers 404 to a cross-origin or origin-less PUT, to no session, and to another shop's admin", async () => {
    const s = await shop();
    expect((await call(s, "PUT", { body: { delayHours: 1, enabled: true }, origin: "https://evil.test" })).status).toBe(404);
    expect((await call(s, "PUT", { body: { delayHours: 1, enabled: true }, origin: null })).status).toBe(404);
    expect((await call(s, "GET", { cookie: "" })).status).toBe(404);
    expect((await call(s, "GET", { cookie: a.admin.cookie })).status).toBe(404);
    expect((await call(s, "PUT", { body: { delayHours: 1, enabled: true }, cookie: a.admin.cookie })).status).toBe(404);
    expect(await stored(s.tenantId)).toBeNull();
    expect((await call(s, "DELETE")).status).toBe(404);
  });

  it("admits a platform user acting as the shop, and audits the grant (AC15)", async () => {
    const s = await shop();
    const platform = await signUp(`${nextId("acp")}@platform.test`);
    await access(platform.userId, "platform_admin");
    const grantId = await grantActingAs(platform.userId, s.tenantId);
    const response = await call(s, "PUT", { body: { delayHours: 2, enabled: true }, cookie: platform.cookie });
    expect((await viewOf(response)).enabled).toBe(true);
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, metadata_json FROM audit_events WHERE tenant_id = ? AND action = 'checkout_reminders.settings'",
    )
      .bind(s.tenantId)
      .first<{ actor_user_id: string; metadata_json: string }>();
    expect(audit?.actor_user_id).toBe(platform.userId);
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toEqual({ actingAsGrantId: grantId, delayHours: 2, enabled: true });
    // Without a grant on the shop: nothing.
    expect((await call(a, "GET", { cookie: platform.cookie })).status).toBe(404);
  });
});
