import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { DEFAULT_COMMISSION_BPS } from "../src/commerce/payment";
import { REFUND_APPLICATION_FEE } from "../src/commerce/refunds";
import { REVERSE_DISPUTE_ON_CREATED } from "../src/commerce/stripe-events";
import {
  MAX_DEFAULT_COMMISSION_BPS,
  readDefaultCommissionBps,
  readPlatformSettings,
  SETTINGS_DEFAULTS,
} from "../src/platform/platform-settings";
import {
  FakeMoneyStripe,
  moneyEnv,
  next,
  seedCheckout,
  seedTenant as seedMoneyTenant,
} from "./money-fixtures";
import {
  grantPlatformAdmin,
  grantTenantAdmin,
  seedTenant,
  sessionRequest,
  signUp,
} from "./pod-fixtures";

/**
 * CP3-D — platform settings (migration 0034, src/platform/platform-settings.ts,
 * GET/PATCH /v1/platform/settings) and the payment path's platform default
 * commission (src/commerce/payment.ts, the one call site).
 */

const PLATFORM_HOST = "https://platform.cp3d-settings.test";
const SETTINGS_URL = `${PLATFORM_HOST}/v1/platform/settings`;
const SHOP = "tenant-cp3d-settings";

let platformSession: { cookie: string; userId: string };
let adminSession: { cookie: string; userId: string };

/**
 * Keys no tenant-, buyer- or public-facing body may carry: the platform's
 * commission settings and every other platform-internal setting.
 */
const DENIED_KEY_PARTS = [
  "commission",
  "refundapplicationfee",
  "reversedispute",
  "reviewfirst",
  "hardblock",
  "termsversion",
  "applicationfee",
];

function expectNoPlatformSettings(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoPlatformSettings(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    expect(
      DENIED_KEY_PARTS.find((part) => lowered.includes(part)),
      `${path}.${key} is a platform setting`,
    ).toBeUndefined();
    expectNoPlatformSettings(entry, `${path}.${key}`);
  }
}

async function expectOpaque404(response: Response, label: string): Promise<void> {
  expect(response.status, label).toBe(404);
  const body = await response.json();
  expect(body, label).toEqual({ error: { code: "not_found", message: "Route not found" } });
  expectNoPlatformSettings(body);
}

function platformRequest(
  method: string,
  options: { body?: unknown; cookie?: string; origin?: string | null; shopId?: string } = {},
): Request {
  if (options.cookie === undefined) {
    const headers = new Headers({ origin: PLATFORM_HOST });
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return new Request(SETTINGS_URL, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method,
    });
  }
  return sessionRequest(SETTINGS_URL, method, {
    body: options.body,
    cookie: options.cookie,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.shopId === undefined ? {} : { shopId: options.shopId }),
  });
}

function fetchApp(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

async function patchSettings(body: unknown): Promise<Response> {
  return fetchApp(platformRequest("PATCH", { body, cookie: platformSession.cookie }));
}

async function settingsRow() {
  return env.DB.prepare(
    `SELECT default_commission_bps, refund_application_fee, reverse_dispute_on_created,
            review_first_products, screening_hard_block, screening_terms_version,
            updated_at, updated_by
     FROM platform_settings WHERE id = 1`,
  ).first<{
    default_commission_bps: number;
    refund_application_fee: number;
    reverse_dispute_on_created: number;
    review_first_products: number;
    screening_hard_block: number;
    screening_terms_version: number;
    updated_at: string;
    updated_by: string | null;
  }>();
}

beforeAll(async () => {
  await seedTenant(SHOP, "shop.cp3d-settings.test");
  platformSession = await signUp("cp3d-settings-platform@example.com");
  await grantPlatformAdmin(platformSession.userId);
  adminSession = await signUp("cp3d-settings-admin@example.com");
  await grantTenantAdmin(adminSession.userId, SHOP);
  // The platform user is ALSO acting as the shop (an active grant).
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      platformSession.userId,
      SHOP,
      new Date(now).toISOString(),
      new Date(now + 60 * 60 * 1_000).toISOString(),
    )
    .run();
});

// ── the table ──────────────────────────────────────────────────────────────

describe("platform_settings after migration 0034", () => {
  it("holds exactly one row with the Firebase defaults (D9 pinned)", async () => {
    await expect(settingsRow()).resolves.toMatchObject({
      default_commission_bps: 500,
      refund_application_fee: 0,
      reverse_dispute_on_created: 1,
      review_first_products: 2,
      screening_hard_block: 0,
      screening_terms_version: 1,
      updated_by: null,
    });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_settings").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("the defaults agree with the code constants that actually run", async () => {
    expect(SETTINGS_DEFAULTS.defaultCommissionBps).toBe(DEFAULT_COMMISSION_BPS);
    expect(SETTINGS_DEFAULTS.refundApplicationFee).toBe(REFUND_APPLICATION_FEE);
    expect(SETTINGS_DEFAULTS.reverseDisputeOnCreated).toBe(REVERSE_DISPUTE_ON_CREATED);
    const settings = await readPlatformSettings(env.DB);
    expect(settings.refundApplicationFee).toBe(REFUND_APPLICATION_FEE);
    expect(settings.reverseDisputeOnCreated).toBe(REVERSE_DISPUTE_ON_CREATED);
  });

  it.each([
    ["refund_application_fee = 1 (pinned to 0, D9/D36)", "UPDATE platform_settings SET refund_application_fee = 1"],
    ["commission above 10000 bps", "UPDATE platform_settings SET default_commission_bps = 10001"],
    ["a negative commission", "UPDATE platform_settings SET default_commission_bps = -1"],
    ["review_first_products above 100", "UPDATE platform_settings SET review_first_products = 101"],
    ["a non-boolean hard block", "UPDATE platform_settings SET screening_hard_block = 2"],
    ["a non-boolean dispute flag", "UPDATE platform_settings SET reverse_dispute_on_created = 5"],
    ["a malformed updated_at", "UPDATE platform_settings SET updated_at = 'yesterday'"],
    ["a second row", "INSERT INTO platform_settings (id, updated_at) VALUES (2, '2026-09-27T00:00:00.000Z')"],
  ])("refuses %s", async (_label, sql) => {
    await expect(env.DB.prepare(sql).run()).rejects.toThrow();
  });

  it("moves the screening terms version forward only", async () => {
    await expect(
      env.DB.prepare("UPDATE platform_settings SET screening_terms_version = screening_terms_version").run(),
    ).rejects.toThrow(/screening terms changed/);
    await expect(
      env.DB.prepare("UPDATE platform_settings SET screening_terms_version = 0").run(),
    ).rejects.toThrow();
  });
});

// ── who may call ───────────────────────────────────────────────────────────

describe("GET/PATCH /v1/platform/settings — who may call", () => {
  it.each(["GET", "PATCH"])("%s: no session, a tenant admin and a platform user acting as the shop get the opaque 404", async (method) => {
    const body = method === "PATCH" ? { defaultCommissionBps: 100 } : undefined;
    await expectOpaque404(await fetchApp(platformRequest(method, { body })), `${method} anonymous`);
    await expectOpaque404(
      await fetchApp(platformRequest(method, { body, cookie: adminSession.cookie, shopId: SHOP })),
      `${method} tenant admin`,
    );
    await expectOpaque404(
      await fetchApp(platformRequest(method, { body, cookie: adminSession.cookie })),
      `${method} tenant admin without X-Shop-Id`,
    );
    await expectOpaque404(
      await fetchApp(platformRequest(method, { body, cookie: platformSession.cookie, shopId: SHOP })),
      `${method} platform user acting as the shop`,
    );
    // Nothing was written by any of them.
    expect((await settingsRow())?.default_commission_bps).toBe(500);
  });

  it("the platform session reads every value", async () => {
    const response = await fetchApp(platformRequest("GET", { cookie: platformSession.cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      settings: {
        defaultCommissionBps: 500,
        refundApplicationFee: false,
        reverseDisputeOnCreated: true,
        reviewFirstProducts: 2,
        screeningHardBlock: false,
        screeningTermsVersion: 1,
        updatedAt: expect.any(String),
        updatedBy: null,
      },
    });
  });

  it("refuses a cross-origin or origin-less PATCH with the same 404, writing nothing", async () => {
    await expectOpaque404(
      await fetchApp(
        platformRequest("PATCH", {
          body: { defaultCommissionBps: 100 },
          cookie: platformSession.cookie,
          origin: "https://attacker.example.com",
        }),
      ),
      "cross-origin",
    );
    await expectOpaque404(
      await fetchApp(
        platformRequest("PATCH", { body: { defaultCommissionBps: 100 }, cookie: platformSession.cookie, origin: null }),
      ),
      "no origin",
    );
    expect((await settingsRow())?.default_commission_bps).toBe(500);
  });

  it("other methods are not routes", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await fetchApp(platformRequest(method, { body: {}, cookie: platformSession.cookie }));
      expect(response.status, method).toBe(404);
    }
  });
});

// ── editing ────────────────────────────────────────────────────────────────

describe("PATCH /v1/platform/settings — editing", () => {
  afterAll(async () => {
    await patchSettings({ defaultCommissionBps: 500, reviewFirstProducts: 2, screeningHardBlock: false });
  });

  it("edits the default commission, audited with before/after and the actor", async () => {
    const response = await patchSettings({ defaultCommissionBps: 300 });
    expect(response.status).toBe(200);
    const body = await response.json<{ rescreen: unknown; settings: Record<string, unknown> }>();
    expect(body.settings).toMatchObject({ defaultCommissionBps: 300, updatedBy: platformSession.userId });
    // Commission is not screening input: no re-screen, no version move.
    expect(body.rescreen).toBeNull();
    expect(body.settings.screeningTermsVersion).toBe(1);
    await expect(settingsRow()).resolves.toMatchObject({
      default_commission_bps: 300,
      updated_by: platformSession.userId,
    });
    const audit = await env.DB.prepare(
      `SELECT tenant_id, actor_user_id, resource_type, metadata_json FROM audit_events
       WHERE action = 'platform_settings.update' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).first<{ actor_user_id: string; metadata_json: string; resource_type: string; tenant_id: string | null }>();
    expect(audit).toMatchObject({
      actor_user_id: platformSession.userId,
      resource_type: "platform_settings",
      tenant_id: null,
    });
    expect(JSON.parse(audit?.metadata_json ?? "{}")).toEqual({
      defaultCommissionBps: { after: 300, before: 500 },
    });
  });

  it("edits reviewFirstProducts without touching the other fields", async () => {
    const response = await patchSettings({ reviewFirstProducts: 3 });
    expect(response.status).toBe(200);
    await expect(settingsRow()).resolves.toMatchObject({
      default_commission_bps: 300,
      review_first_products: 3,
      screening_hard_block: 0,
    });
  });

  it("edits the global hard block, which is screening input: the version moves and a re-screen summary comes back", async () => {
    const before = (await settingsRow())?.screening_terms_version ?? 0;
    const on = await patchSettings({ screeningHardBlock: true });
    expect(on.status).toBe(200);
    const body = await on.json<{ rescreen: Record<string, number>; settings: Record<string, unknown> }>();
    expect(body.settings).toMatchObject({ screeningHardBlock: true, screeningTermsVersion: before + 1 });
    expect(body.rescreen).toEqual({ blockedNow: 0, pending: expect.any(Number), unverified: expect.any(Number) });
    const off = await patchSettings({ screeningHardBlock: false });
    expect((await off.json<{ settings: Record<string, unknown> }>()).settings).toMatchObject({
      screeningHardBlock: false,
      screeningTermsVersion: before + 2,
    });
  });

  it.each([
    ["refundApplicationFee", { refundApplicationFee: false }],
    ["reverseDisputeOnCreated", { reverseDisputeOnCreated: false }],
    ["refundApplicationFee", { defaultCommissionBps: 100, refundApplicationFee: true }],
  ])("refuses a PATCH naming the pinned %s with a clear error, writing nothing", async (field, body) => {
    const before = await settingsRow();
    const response = await patchSettings(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "setting_not_editable",
        field,
        message: `${field} is fixed in code in this checkpoint and cannot be changed here`,
      },
    });
    await expect(settingsRow()).resolves.toEqual(before);
  });

  it.each([
    ["a negative commission", { defaultCommissionBps: -1 }, "defaultCommissionBps"],
    ["a commission above the 8 % BAS fee (D45)", { defaultCommissionBps: MAX_DEFAULT_COMMISSION_BPS + 1 }, "defaultCommissionBps"],
    ["a fractional commission", { defaultCommissionBps: 250.5 }, "defaultCommissionBps"],
    ["a commission as a string", { defaultCommissionBps: "300" }, "defaultCommissionBps"],
    ["a negative review count", { reviewFirstProducts: -1 }, "reviewFirstProducts"],
    ["a review count above 100", { reviewFirstProducts: 101 }, "reviewFirstProducts"],
    ["a hard block as a string", { screeningHardBlock: "true" }, "screeningHardBlock"],
    ["an unknown field", { commissionBps: 300 }, "commissionBps"],
    ["an empty patch", {}, null],
    ["an array", [1], null],
  ])("refuses %s (400, nothing written)", async (_label, body, field) => {
    const before = await settingsRow();
    const response = await patchSettings(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request", field } });
    await expect(settingsRow()).resolves.toEqual(before);
  });

  it("accepts the edges of the ranges", async () => {
    expect((await patchSettings({ defaultCommissionBps: MAX_DEFAULT_COMMISSION_BPS, reviewFirstProducts: 0 })).status).toBe(200);
    expect((await patchSettings({ defaultCommissionBps: 0, reviewFirstProducts: 100 })).status).toBe(200);
    await expect(settingsRow()).resolves.toMatchObject({ default_commission_bps: 0, review_first_products: 100 });
  });
});

// ── the payment path ───────────────────────────────────────────────────────

describe("the payment path reads the platform default commission", () => {
  let stripe: FakeMoneyStripe;
  let ipCounter = 0;

  beforeEach(() => {
    stripe = new FakeMoneyStripe();
  });

  async function shop(commissionBps: number | null = null) {
    const tenantId = next("tenant-cp3d-pay").toLowerCase().replace(/_/g, "-");
    const hostname = `${tenantId}.pay.cp3d.test`;
    await seedMoneyTenant(tenantId, { commissionBps, hostname });
    return { hostname, tenantId };
  }

  async function pay(hostname: string, checkoutId: string): Promise<Response> {
    ipCounter += 1;
    return worker.fetch(
      new Request(`https://${hostname}/v1/checkout/${checkoutId}/payment`, {
        headers: { "cf-connecting-ip": `198.51.100.${ipCounter % 250}` },
        method: "POST",
      }),
      moneyEnv(stripe),
    );
  }

  async function frozenFee(checkoutId: string): Promise<number | null> {
    const row = await env.DB.prepare("SELECT application_fee_minor FROM checkouts WHERE checkout_id = ?")
      .bind(checkoutId)
      .first<{ application_fee_minor: number | null }>();
    return row?.application_fee_minor ?? null;
  }

  async function setDefault(bps: number): Promise<void> {
    expect((await patchSettings({ defaultCommissionBps: bps })).status).toBe(200);
    expect(await readDefaultCommissionBps(env.DB)).toBe(bps);
  }

  afterAll(async () => {
    await patchSettings({ defaultCommissionBps: 500 });
  });

  it("charges the table's default (3 % of 20 000 = 600), and the buyer's answer names no fee", async () => {
    await setDefault(300);
    const { hostname, tenantId } = await shop();
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 20_000 });
    const response = await pay(hostname, checkout.checkoutId);
    expect(response.status).toBe(201);
    expect(stripe.createCalls[0]?.applicationFeeAmount).toBe(600);
    expect(await frozenFee(checkout.checkoutId)).toBe(600);
    const body = await response.json();
    expect(Object.keys((body as { payment: object }).payment).sort()).toEqual(["clientSecret", "paymentIntentId"]);
    expectNoPlatformSettings(body);
  });

  it("a shop's own commission_bps still wins over the table", async () => {
    await setDefault(300);
    const { hostname, tenantId } = await shop(250);
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 20_000 });
    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);
    expect(stripe.createCalls[0]?.applicationFeeAmount).toBe(500);
  });

  it("a shop commission of 0 wins too (an explicit 0 is not 'unset')", async () => {
    await setDefault(300);
    const { hostname, tenantId } = await shop(0);
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 20_000 });
    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);
    expect(stripe.createCalls[0]?.applicationFeeAmount).toBe(0);
  });

  it("falls back to 500 bps when the settings row is absent", async () => {
    const saved = await settingsRow();
    await env.DB.prepare("DELETE FROM platform_settings WHERE id = 1").run();
    try {
      expect(await readDefaultCommissionBps(env.DB)).toBeNull();
      await expect(readPlatformSettings(env.DB)).resolves.toMatchObject({
        ...SETTINGS_DEFAULTS,
        screeningTermsVersion: 0,
        updatedAt: null,
      });
      const { hostname, tenantId } = await shop();
      const checkout = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 20_000 });
      expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);
      expect(stripe.createCalls[0]?.applicationFeeAmount).toBe(1_000);
    } finally {
      await env.DB.prepare(
        `INSERT INTO platform_settings (
           id, default_commission_bps, review_first_products, screening_hard_block,
           screening_terms_version, updated_at, updated_by
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          saved?.default_commission_bps,
          saved?.review_first_products,
          saved?.screening_hard_block,
          saved?.screening_terms_version,
          saved?.updated_at,
          saved?.updated_by ?? null,
        )
        .run();
    }
    await expect(settingsRow()).resolves.toEqual(saved);
  });

  it("the fee is frozen when the PaymentIntent is created: a later change never reaches it", async () => {
    await setDefault(300);
    const { hostname, tenantId } = await shop();
    const paid = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 20_000 });
    expect((await pay(hostname, paid.checkoutId)).status).toBe(201);
    expect(await frozenFee(paid.checkoutId)).toBe(600);

    // Created BEFORE the change, its intent created AFTER it.
    const openedBefore = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 20_000 });

    await setDefault(700);
    // The existing intent is re-served, not re-created, and its fee stands.
    const again = await pay(hostname, paid.checkoutId);
    expect(again.status).toBe(200);
    expect(stripe.createCalls).toHaveLength(1);
    expect(await frozenFee(paid.checkoutId)).toBe(600);
    // The row itself refuses a rewrite (CP2-A trigger).
    await expect(
      env.DB.prepare("UPDATE checkouts SET application_fee_minor = 1400 WHERE checkout_id = ?")
        .bind(paid.checkoutId)
        .run(),
    ).rejects.toThrow(/frozen/);

    // What CP2 freezes is the INTENT's fee, not the checkout's: a checkout
    // opened under 3 % and paid after the change is charged at 7 %.
    expect((await pay(hostname, openedBefore.checkoutId)).status).toBe(201);
    expect(stripe.createCalls[1]?.applicationFeeAmount).toBe(1_400);
    expect(await frozenFee(openedBefore.checkoutId)).toBe(1_400);
  });
});
