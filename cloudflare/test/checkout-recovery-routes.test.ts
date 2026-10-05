import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { mintRecoveryToken } from "../src/commerce/checkout-recovery-token";
import { queueReminder } from "../src/commerce/checkout-reminders";
import { hashEmailRecipient } from "../src/email/auth-email-job";
import { handleCheckoutRecoveryRoute, RECOVERY_IP_LIMIT } from "../src/routes/storefront-checkout-recovery";
import {
  count,
  DAY_MS,
  HOUR_MS,
  nextId,
  seedCheckout,
  seedOrderFor,
  seedProduct,
  seedReminderShop,
} from "./reminder-fixtures";

/**
 * CP9-AC build step 7: the reminder's two public routes — the resume link
 * answers line references and nothing else, every refusal is one byte-equal
 * 404, the resolve writes nothing, the unsubscribe writes one suppression and
 * one audit row, works however old its link is, and both are rate limited.
 */

const SHOP = "tenant-ac-routes";
const OTHER = "tenant-ac-routes-b";
let host = "";
let otherHost = "";
const NOW = Date.now();

let ip = 0;
function nextIp(): string {
  ip += 1;
  return `192.0.2.${ip % 250}`;
}

beforeAll(async () => {
  host = (await seedReminderShop(SHOP)).host;
  otherHost = (await seedReminderShop(OTHER)).host;
  await seedProduct(SHOP, "acr-mug");
  await seedProduct(SHOP, "acr-tee", { variant: { label: "M", variantId: "acr-tee-m" } });
});

interface Reminded {
  checkoutId: string;
  email: string;
  reminderId: string;
}

async function reminded(options: { decidedAt?: number } = {}): Promise<Reminded> {
  const checkout = await seedCheckout(SHOP, {
    createdAt: NOW - 3 * HOUR_MS,
    lines: [{ productId: "acr-tee", quantity: 2, variantId: "acr-tee-m" }, { productId: "acr-mug" }],
  });
  const written = await queueReminder(
    env.DB,
    { checkout_id: checkout.checkoutId, tenant_id: SHOP },
    await hashEmailRecipient(checkout.email),
    options.decidedAt ?? NOW - HOUR_MS,
  );
  expect(written.kind).toBe("queued");
  const row = await env.DB.prepare("SELECT reminder_id FROM checkout_reminders WHERE checkout_id = ?")
    .bind(checkout.checkoutId)
    .first<{ reminder_id: string }>();
  return { checkoutId: checkout.checkoutId, email: checkout.email, reminderId: row!.reminder_id };
}

async function tokenOf(reminderId: string, purpose: "resume" | "unsubscribe", tenant = SHOP): Promise<string> {
  return (await mintRecoveryToken(env, tenant, reminderId, purpose)) as string;
}

function post(path: string, options: { body?: BodyInit; headers?: Record<string, string>; host?: string; ip?: string } = {}) {
  return exports.default.fetch(
    new Request(`https://${options.host ?? host}${path}`, {
      body: options.body ?? null,
      headers: { "cf-connecting-ip": options.ip ?? nextIp(), ...options.headers },
      method: "POST",
    }),
  );
}

const resolvePath = (token: string) => `/v1/checkout-recovery/${token}`;
const unsubscribePath = (token: string) => `/v1/checkout-recovery/${token}/unsubscribe`;

async function opaque(): Promise<{ body: string; status: number }> {
  const response = await post(resolvePath("not-a-token"));
  return { body: await response.text(), status: response.status };
}

const DENYLIST = ["email", "customerEmail", "name", "priceMinor", "unitPriceMinor", "totalMinor", "discountCode", "checkoutId", "paymentIntentId", "recipient", "reason", "decidedAt"];

describe("POST /v1/checkout-recovery/:token (the resume link)", () => {
  it("answers the lines as references, in their order, and nothing else", async () => {
    const r = await reminded();
    const response = await post(resolvePath(await tokenOf(r.reminderId, "resume")));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      recovery: {
        items: [
          { productId: "acr-tee", quantity: 2, variantId: "acr-tee-m" },
          { productId: "acr-mug", quantity: 1 },
        ],
        status: "open",
      },
    });
    for (const key of DENYLIST) {
      expect(text, key).not.toContain(`"${key}"`);
    }
    expect(text).not.toContain(r.email);
    expect(text).not.toContain(r.checkoutId);
    expect(text).not.toMatch(/10000|20000/);
  });

  it("answers `completed` once the reminded checkout became an order, also a late one", async () => {
    const r = await reminded();
    await seedOrderFor(SHOP, { checkoutId: r.checkoutId, email: r.email, paymentIntentId: null });
    const response = await post(resolvePath(await tokenOf(r.reminderId, "resume")));
    expect(await response.json()).toEqual({ recovery: { status: "completed" } });
  });

  it("writes nothing at all", async () => {
    const r = await reminded();
    const tables = ["checkouts", "checkout_items", "checkout_reminders", "checkout_reminder_suppressions", "audit_events", "outbox_events", "discount_code_holds", "orders"];
    const before = await Promise.all(tables.map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`)));
    const checkoutBefore = await env.DB.prepare("SELECT * FROM checkouts WHERE checkout_id = ?").bind(r.checkoutId).first();
    expect((await post(resolvePath(await tokenOf(r.reminderId, "resume")))).status).toBe(200);
    expect(await Promise.all(tables.map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`)))).toEqual(before);
    expect(await env.DB.prepare("SELECT * FROM checkouts WHERE checkout_id = ?").bind(r.checkoutId).first()).toEqual(checkoutBefore);
  });

  it("answers ONE 404, byte for byte, for every refusal", async () => {
    const reference = await opaque();
    expect(reference.status).toBe(404);
    const r = await reminded();
    const resume = await tokenOf(r.reminderId, "resume");
    const expired = await reminded({ decidedAt: NOW - 8 * DAY_MS });
    const skipped = await seedCheckout(SHOP, { createdAt: NOW - 3 * HOUR_MS });
    const skippedId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO checkout_reminders (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
         decided_at, link_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'skipped', 'no_consent', ?, NULL, ?, ?)`,
    )
      .bind(skippedId, SHOP, skipped.checkoutId, "1".repeat(64), NOW, NOW, NOW)
      .run();
    const withdrawn = await reminded();
    await env.DB.prepare("UPDATE checkout_reminders SET state = 'withdrawn', reason = 'paid', updated_at = ? WHERE reminder_id = ?")
      .bind(NOW, withdrawn.reminderId)
      .run();
    const flipped = `${resume.slice(0, -1)}${resume.endsWith("A") ? "B" : "A"}`;
    const cases: Array<[string, Promise<Response>]> = [
      ["a malformed token", post(resolvePath("v1.x.y"))],
      ["a forged signature", post(resolvePath(flipped))],
      ["another shop's token on this host", post(resolvePath(await tokenOf(r.reminderId, "resume", OTHER)))],
      ["this shop's token on another shop's host", post(resolvePath(resume), { host: otherHost })],
      ["the unsubscribe purpose", post(resolvePath(await tokenOf(r.reminderId, "unsubscribe")))],
      ["an unknown reminder", post(resolvePath(await tokenOf(crypto.randomUUID(), "resume")))],
      ["a skipped decision", post(resolvePath(await tokenOf(skippedId, "resume")))],
      ["a withdrawn decision", post(resolvePath(await tokenOf(withdrawn.reminderId, "resume")))],
      ["a link past its 7 days", post(resolvePath(await tokenOf(expired.reminderId, "resume")))],
      ["an unknown host", post(resolvePath(resume), { host: "nobody.reminders.test" })],
      ["a path past the token", post(`${resolvePath(resume)}/x`)],
    ];
    for (const [label, pending] of cases) {
      const response = await pending;
      expect({ label, status: response.status, body: await response.text() }).toEqual({ label, ...reference });
    }
    // No secret: nothing verifies.
    const unconfigured = { ...env, BETTER_AUTH_SECRET: undefined } as unknown as Env;
    const response = await handleCheckoutRecoveryRoute(
      unconfigured,
      new Request(`https://${host}${resolvePath(resume)}`, { headers: { "cf-connecting-ip": nextIp() }, method: "POST" }),
    );
    expect({ body: await response.text(), status: response.status }).toEqual(reference);
  });

  it("is POST only", async () => {
    const r = await reminded();
    const response = await exports.default.fetch(
      new Request(`https://${host}${resolvePath(await tokenOf(r.reminderId, "resume"))}`, {
        headers: { "cf-connecting-ip": nextIp() },
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /v1/checkout-recovery/:token/unsubscribe", () => {
  async function suppressed(email: string, tenant = SHOP): Promise<number> {
    return count(
      "SELECT COUNT(*) AS n FROM checkout_reminder_suppressions WHERE tenant_id = ? AND email_hash = ?",
      tenant,
      await hashEmailRecipient(email),
    );
  }

  it("writes one suppression and one audit row, neither with an address; a second call writes nothing", async () => {
    const r = await reminded();
    const token = await tokenOf(r.reminderId, "unsubscribe");
    const first = await post(unsubscribePath(token));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ unsubscribed: true });
    expect(await suppressed(r.email)).toBe(1);
    expect(await suppressed(r.email, OTHER)).toBe(0);
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, action, resource_type, resource_id, metadata_json FROM audit_events WHERE resource_id = ?",
    )
      .bind(r.reminderId)
      .all();
    expect(audit.results).toEqual([
      { action: "checkout_reminder.unsubscribe", actor_user_id: null, metadata_json: null, resource_id: r.reminderId, resource_type: "checkout_reminder" },
    ]);
    const second = await post(unsubscribePath(token));
    expect(await second.json()).toEqual({ unsubscribed: true });
    expect(await suppressed(r.email)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ?", r.reminderId)).toBe(1);
    const stored = await env.DB.prepare("SELECT * FROM checkout_reminder_suppressions WHERE tenant_id = ?").bind(SHOP).all();
    expect(JSON.stringify(stored.results)).not.toContain("@");
  });

  it("accepts a mail provider's RFC 8058 one-click form body", async () => {
    const r = await reminded();
    const response = await post(unsubscribePath(await tokenOf(r.reminderId, "unsubscribe")), {
      body: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.status).toBe(200);
    expect(await suppressed(r.email)).toBe(1);
  });

  it("still works with a link 8 days old (no expiry, AC11)", async () => {
    const r = await reminded({ decidedAt: NOW - 8 * DAY_MS });
    expect((await post(resolvePath(await tokenOf(r.reminderId, "resume")))).status).toBe(404);
    const response = await post(unsubscribePath(await tokenOf(r.reminderId, "unsubscribe")));
    expect(response.status).toBe(200);
    expect(await suppressed(r.email)).toBe(1);
  });

  it("refuses the resume purpose, a withdrawn decision and another shop's host with the one 404", async () => {
    const reference = await opaque();
    const r = await reminded();
    const withdrawn = await reminded();
    await env.DB.prepare("UPDATE checkout_reminders SET state = 'withdrawn', reason = 'unavailable', updated_at = ? WHERE reminder_id = ?")
      .bind(NOW, withdrawn.reminderId)
      .run();
    for (const pending of [
      post(unsubscribePath(await tokenOf(r.reminderId, "resume"))),
      post(unsubscribePath(await tokenOf(withdrawn.reminderId, "unsubscribe"))),
      post(unsubscribePath(await tokenOf(r.reminderId, "unsubscribe")), { host: otherHost }),
    ]) {
      const response = await pending;
      expect({ body: await response.text(), status: response.status }).toEqual(reference);
    }
    expect(await suppressed(r.email)).toBe(0);
    expect(await suppressed(withdrawn.email)).toBe(0);
  });
});

describe("the rate limit (one scope for both routes)", () => {
  it(`answers 429 to the ${RECOVERY_IP_LIMIT + 1}st request of one visitor within 10 minutes, counted before the token`, async () => {
    const visitor = `198.18.${nextId("x").length}.7`;
    const r = await reminded();
    const resume = resolvePath(await tokenOf(r.reminderId, "resume"));
    for (let index = 0; index < RECOVERY_IP_LIMIT; index += 1) {
      const path = index % 2 === 0 ? resolvePath("garbage") : unsubscribePath("garbage");
      expect((await post(path, { ip: visitor })).status).toBe(404);
    }
    const limited = await post(resume, { ip: visitor });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    // Another visitor is not affected.
    expect((await post(resume)).status).toBe(200);
  });
});
