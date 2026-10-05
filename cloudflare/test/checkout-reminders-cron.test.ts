import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  queueReminder,
  REMINDER_BATCH,
  runCheckoutReminders,
} from "../src/commerce/checkout-reminders";
import { STRIPE_GATEWAY_OVERRIDE, StripeGatewayError } from "../src/commerce/stripe-client";
import { hashEmailRecipient } from "../src/email/auth-email-job";
import { CP9_STEPS } from "../src/outbox/scheduled";
import { recordingQueue } from "./dispatch-fixtures";
import { FakeMoneyStripe } from "./money-fixtures";
import {
  consentJson,
  count,
  DAY_MS,
  HOUR_MS,
  nextId,
  type SeededCheckout,
  seedCheckout,
  seedOrderFor,
  seedProduct,
  seedReminderShop,
  setAddOn,
  setSellerSwitch,
} from "./reminder-fixtures";

/**
 * CP9-AC build step 6: the cron step's decisions (checkout-reminders.ts
 * runCheckoutReminders) — one test per check of §4.3, their order, the time
 * window, the batch, the races, and what it never touches.
 *
 * Writes persist across the tests of this file, so every test has its own
 * shop and every checkout left open is closed after it (afterEach): no test's
 * candidate is another test's.
 */

const NOW = Date.now() - 60_000;
const DUE = NOW - 2 * HOUR_MS;

class Stripe extends FakeMoneyStripe {
  readonly retrieveCalls: string[] = [];
  unreachable = false;

  override async retrievePaymentIntent(id: string) {
    this.retrieveCalls.push(id);
    if (this.unreachable) {
      throw new StripeGatewayError(false);
    }
    return super.retrievePaymentIntent(id);
  }
}

function cronEnv(stripe: Stripe, overrides: Record<PropertyKey, unknown> = {}) {
  const nudges = recordingQueue();
  return {
    env: {
      ...env,
      OUTBOX_QUEUE: nudges.queue,
      [STRIPE_GATEWAY_OVERRIDE]: stripe,
      ...overrides,
    } as unknown as Env,
    nudges,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("UPDATE checkouts SET status = 'abandoned' WHERE status = 'open'").run();
});

interface World {
  shop: string;
  stripe: Stripe;
}

async function world(options: Parameters<typeof seedReminderShop>[1] = {}): Promise<World> {
  const shop = nextId("acc").toLowerCase();
  await seedReminderShop(shop, options);
  await seedProduct(shop, `${shop}-mug`, { name: "Mugg" });
  return { shop, stripe: new Stripe() };
}

async function checkout(w: World, options: Partial<Parameters<typeof seedCheckout>[1]> = {}, intent = "requires_payment_method"): Promise<SeededCheckout> {
  const seeded = await seedCheckout(w.shop, {
    createdAt: DUE,
    lines: [{ productId: `${w.shop}-mug` }],
    ...options,
  });
  if (seeded.paymentIntentId !== null) {
    w.stripe.addIntent({ amount: 10_000, id: seeded.paymentIntentId, status: intent });
  }
  return seeded;
}

async function decisionOf(checkoutId: string) {
  return env.DB.prepare("SELECT state, reason FROM checkout_reminders WHERE checkout_id = ?")
    .bind(checkoutId)
    .first<{ reason: string | null; state: string }>();
}

async function run(w: World, now = NOW, overrides: Record<PropertyKey, unknown> = {}) {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { env: testEnv, nudges } = cronEnv(w.stripe, overrides);
  return { nudges, summary: await runCheckoutReminders(testEnv, now) };
}

describe("a due checkout with consent is queued, once", () => {
  it("queues ONE reminder with ONE outbox row that holds the reminder id only, and nudges it", async () => {
    const w = await world();
    const c = await checkout(w);
    const { nudges, summary } = await run(w);
    expect(summary).toMatchObject({ examined: 1, queued: 1, raced: 0, retried: 0, skipped: {} });
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: null, state: "queued" });
    const reminder = await env.DB.prepare(
      "SELECT reminder_id, buyer_hash, decided_at, link_expires_at FROM checkout_reminders WHERE checkout_id = ?",
    )
      .bind(c.checkoutId)
      .first<{ buyer_hash: string; decided_at: number; link_expires_at: number; reminder_id: string }>();
    expect(reminder?.buyer_hash).toBe(await hashEmailRecipient(c.email));
    expect(reminder?.decided_at).toBe(NOW);
    expect(reminder?.link_expires_at).toBe(NOW + 7 * DAY_MS);
    const outbox = await env.DB.prepare(
      "SELECT outbox_id, event_type, aggregate_type, aggregate_id, dedupe_key, payload_json, status FROM outbox_events WHERE aggregate_id = ?",
    )
      .bind(reminder?.reminder_id)
      .first<Record<string, string>>();
    expect(outbox).toMatchObject({
      aggregate_type: "checkout_reminder",
      dedupe_key: `email.checkout_reminder:${reminder?.reminder_id}`,
      event_type: "email.checkout_reminder",
      status: "pending",
    });
    expect(JSON.parse(outbox?.payload_json ?? "")).toEqual({ reminderId: reminder?.reminder_id });
    expect(outbox?.payload_json).not.toContain("@");
    expect(nudges.sent).toEqual([{ outboxId: outbox?.outbox_id }]);
    // A second tick decides nothing more.
    expect((await run(w)).summary.examined).toBe(0);
  });

  it("writes nothing to the checkout: its updated_at and intent clock stay as they were", async () => {
    const w = await world();
    const c = await checkout(w);
    const before = await env.DB.prepare("SELECT * FROM checkouts WHERE checkout_id = ?").bind(c.checkoutId).first();
    await run(w);
    expect(await decisionOf(c.checkoutId)).toMatchObject({ state: "queued" });
    expect(await env.DB.prepare("SELECT * FROM checkouts WHERE checkout_id = ?").bind(c.checkoutId).first()).toEqual(before);
  });
});

describe("the checks of §4.3, each with its reason", () => {
  it("1 paid: an order exists (a late success), or the intent succeeded", async () => {
    const w = await world();
    const ordered = await checkout(w);
    await seedOrderFor(w.shop, ordered);
    const succeeded = await checkout(w, { paymentIntentStatus: "succeeded" });
    await run(w);
    expect(await decisionOf(ordered.checkoutId)).toEqual({ reason: "paid", state: "skipped" });
    expect(await decisionOf(succeeded.checkoutId)).toEqual({ reason: "paid", state: "skipped" });
  });

  it("2 feature_off: the platform's add-on is off, or was never turned on (opt-in, AC2)", async () => {
    const w = await world({ addOn: false });
    const c = await checkout(w);
    const never = { ...(await world({ addOn: null })), stripe: w.stripe };
    const d = await checkout(never);
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "feature_off", state: "skipped" });
    expect(await decisionOf(d.checkoutId)).toEqual({ reason: "feature_off", state: "skipped" });
  });

  it("4 orders_closed: an unpublished shop, or an account that takes no charge", async () => {
    const unpublished = await world();
    await env.DB.prepare("UPDATE tenants SET published = 0 WHERE tenant_id = ?").bind(unpublished.shop).run();
    const a = await checkout(unpublished);
    await run(unpublished);
    expect(await decisionOf(a.checkoutId)).toEqual({ reason: "orders_closed", state: "skipped" });

    const noCharges = await world();
    await env.DB.prepare("UPDATE tenants SET stripe_charges_enabled = 0 WHERE tenant_id = ?").bind(noCharges.shop).run();
    const b = await checkout(noCharges);
    await run(noCharges);
    expect(await decisionOf(b.checkoutId)).toEqual({ reason: "orders_closed", state: "skipped" });
  });

  it("5 no_consent: terms alone, no frozen consent, or an unreadable one", async () => {
    const w = await world();
    const termsOnly = await checkout(w, { consent: consentJson() });
    const none = await checkout(w, { consent: null });
    const marketing = await checkout(w, { consent: consentJson({ marketing: true }) });
    await run(w);
    expect(await decisionOf(termsOnly.checkoutId)).toEqual({ reason: "no_consent", state: "skipped" });
    expect(await decisionOf(none.checkoutId)).toEqual({ reason: "no_consent", state: "skipped" });
    // The marketing box is consent too (AC4).
    expect(await decisionOf(marketing.checkoutId)).toEqual({ reason: null, state: "queued" });
  });

  it("6 undeliverable: an address the checkout accepted but no mail can go to (F9)", async () => {
    const w = await world();
    const c = await checkout(w, { email: "anna@localhost" });
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "undeliverable", state: "skipped" });
  });

  it("7 unsubscribed: the address unsubscribed from THIS shop (another shop's does not count)", async () => {
    const w = await world();
    // One tick decides every shop's candidates: one Stripe for both.
    const other = { ...(await world()), stripe: w.stripe };
    const c = await checkout(w);
    const d = await checkout(other);
    await env.DB.prepare(
      "INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at) VALUES (?, ?, 'unsubscribe', ?)",
    )
      .bind(w.shop, await hashEmailRecipient(c.email), NOW - DAY_MS)
      .run();
    await env.DB.prepare(
      "INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at) VALUES (?, ?, 'unsubscribe', ?)",
    )
      .bind(w.shop, await hashEmailRecipient(d.email), NOW - DAY_MS)
      .run();
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "unsubscribed", state: "skipped" });
    expect(await decisionOf(d.checkoutId)).toEqual({ reason: null, state: "queued" });
  });

  it("8 superseded: a later checkout of the address, whatever its state, even a paid one (F3)", async () => {
    const w = await world();
    const email = `${nextId("sup")}@buyer.test`;
    const older = await checkout(w, { createdAt: DUE - HOUR_MS, email });
    const paidLater = await checkout(w, { createdAt: DUE, email, status: "completed" });
    await seedOrderFor(w.shop, paidLater);
    await run(w);
    expect(await decisionOf(older.checkoutId)).toEqual({ reason: "superseded", state: "skipped" });
    expect(await decisionOf(paidLater.checkoutId)).toBeNull();
  });

  it("8 superseded: of two open checkouts of one buyer the later one is reminded (ties by id)", async () => {
    const w = await world();
    const email = `${nextId("two")}@buyer.test`;
    const first = await checkout(w, { createdAt: DUE, email });
    const second = await checkout(w, { createdAt: DUE, email });
    await run(w);
    const [loser, winner] = first.checkoutId < second.checkoutId ? [first, second] : [second, first];
    expect(await decisionOf(loser.checkoutId)).toEqual({ reason: "superseded", state: "skipped" });
    expect(await decisionOf(winner.checkoutId)).toEqual({ reason: null, state: "queued" });
  });

  it("9 frequency_cap: a queued reminder to the address within 7 days, not one 8 days old", async () => {
    const w = await world();
    const email = `${nextId("cap")}@buyer.test`;
    const hash = await hashEmailRecipient(email);
    const reminded = await seedCheckout(w.shop, { createdAt: NOW - 3 * DAY_MS, email, status: "abandoned" });
    await env.DB.prepare(
      `INSERT INTO checkout_reminders (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
         decided_at, link_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), w.shop, reminded.checkoutId, hash, NOW - 3 * DAY_MS, NOW + 4 * DAY_MS, NOW - 3 * DAY_MS, NOW - 3 * DAY_MS)
      .run();
    const c = await checkout(w, { email });
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "frequency_cap", state: "skipped" });

    const w2 = await world();
    const email2 = `${nextId("cap8")}@buyer.test`;
    const old = await seedCheckout(w2.shop, { createdAt: NOW - 9 * DAY_MS, email: email2, status: "abandoned" });
    await env.DB.prepare(
      `INSERT INTO checkout_reminders (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
         decided_at, link_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), w2.shop, old.checkoutId, await hashEmailRecipient(email2), NOW - 8 * DAY_MS, NOW - DAY_MS, NOW - 8 * DAY_MS, NOW - 8 * DAY_MS)
      .run();
    const e = await checkout(w2, { email: email2 });
    await run(w2);
    expect(await decisionOf(e.checkoutId)).toEqual({ reason: null, state: "queued" });
  });

  it("10 payment_failed: a declined card on the intent (AC9)", async () => {
    const w = await world();
    const c = await checkout(w);
    await env.DB.prepare(
      `INSERT INTO payment_events (event_id, tenant_id, provider, event_type, object_id, outcome, reason_code, received_at, created_at)
       VALUES (?, ?, 'stripe', 'payment_intent.payment_failed', ?, 'processed', NULL, ?, ?)`,
    )
      .bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, w.shop, c.paymentIntentId, NOW - HOUR_MS, NOW - HOUR_MS)
      .run();
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "payment_failed", state: "skipped" });
  });

  it("11 unavailable: no line is buyable now; one buyable line is enough", async () => {
    const w = await world();
    await seedProduct(w.shop, `${w.shop}-gone`, { published: false });
    await seedProduct(w.shop, `${w.shop}-tee`, { variant: { active: false, label: "M", variantId: `${w.shop}-tee-m` } });
    const none = await checkout(w, {
      lines: [{ productId: `${w.shop}-gone` }, { productId: `${w.shop}-tee`, variantId: `${w.shop}-tee-m` }],
    });
    const some = await checkout(w, { lines: [{ productId: `${w.shop}-gone` }, { productId: `${w.shop}-mug` }] });
    await run(w);
    expect(await decisionOf(none.checkoutId)).toEqual({ reason: "unavailable", state: "skipped" });
    expect(await decisionOf(some.checkoutId)).toEqual({ reason: null, state: "queued" });
  });

  it.each([
    ["requires_payment_method", { reason: null, state: "queued" }],
    ["requires_confirmation", { reason: null, state: "queued" }],
    ["succeeded", { reason: "paid", state: "skipped" }],
    ["processing", { reason: "payment_in_progress", state: "skipped" }],
    ["requires_capture", { reason: "payment_in_progress", state: "skipped" }],
    ["requires_action", { reason: "payment_in_progress", state: "skipped" }],
    ["canceled", { reason: "intent_gone", state: "skipped" }],
  ])("12 the intent at Stripe: %s → %j", async (status, expected) => {
    const w = await world();
    const c = await checkout(w, {}, status);
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual(expected);
    expect(w.stripe.retrieveCalls).toEqual([c.paymentIntentId]);
  });

  it("12 an intent Stripe does not have is intent_gone", async () => {
    const w = await world();
    const c = await seedCheckout(w.shop, { createdAt: DUE, lines: [{ productId: `${w.shop}-mug` }] });
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "intent_gone", state: "skipped" });
  });

  it("12 Stripe unreachable: no row, no further Stripe call this tick, decided on the next", async () => {
    const w = await world();
    const a = await checkout(w, { createdAt: DUE - 2 * HOUR_MS });
    const b = await checkout(w, { createdAt: DUE - HOUR_MS });
    const noConsent = await checkout(w, { consent: consentJson(), createdAt: DUE });
    w.stripe.unreachable = true;
    const first = await run(w);
    expect(first.summary).toMatchObject({ examined: 3, queued: 0, retried: 2, skipped: { no_consent: 1 } });
    expect(w.stripe.retrieveCalls).toEqual([a.paymentIntentId]);
    expect(await decisionOf(a.checkoutId)).toBeNull();
    expect(await decisionOf(b.checkoutId)).toBeNull();
    // A check before Stripe still decides.
    expect(await decisionOf(noConsent.checkoutId)).toEqual({ reason: "no_consent", state: "skipped" });
    w.stripe.unreachable = false;
    await run(w);
    expect(await decisionOf(a.checkoutId)).toEqual({ reason: null, state: "queued" });
    expect(await decisionOf(b.checkoutId)).toEqual({ reason: null, state: "queued" });
  });

  it("decides in the fixed order: a paid AND non-consenting checkout is `paid`", async () => {
    const w = await world({ addOn: false });
    const c = await checkout(w, { consent: null, email: "anna@localhost" });
    await seedOrderFor(w.shop, c);
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "paid", state: "skipped" });
    // And Stripe is asked only when everything else passed.
    expect(w.stripe.retrieveCalls).toEqual([]);
  });
});

describe("which checkouts are candidates at all", () => {
  it("due after the delay; never before; never more than 24 hours late (no row)", async () => {
    const w = await world({ seller: { delayHours: 3, enabled: true, enabledAt: 1 } });
    const early = await checkout(w, { createdAt: NOW - 2 * HOUR_MS });
    const due = await checkout(w, { createdAt: NOW - 3 * HOUR_MS });
    const late = await checkout(w, { createdAt: NOW - 3 * HOUR_MS - DAY_MS - 1 });
    const justInTime = await checkout(w, { createdAt: NOW - 3 * HOUR_MS - DAY_MS + 60_000 });
    await run(w);
    expect(await decisionOf(early.checkoutId)).toBeNull();
    expect(await decisionOf(due.checkoutId)).toMatchObject({ state: "queued" });
    expect(await decisionOf(late.checkoutId)).toBeNull();
    // One buyer each: no supersede between them.
    expect(await decisionOf(justInTime.checkoutId)).toMatchObject({ state: "queued" });
  });

  it("only checkouts made while the seller's switch was on (AC3); none while it is off", async () => {
    const w = await world({ seller: { enabled: true, enabledAt: DUE } });
    const before = await checkout(w, { createdAt: DUE - 1 });
    const after = await checkout(w, { createdAt: DUE });
    await run(w);
    expect(await decisionOf(before.checkoutId)).toBeNull();
    expect(await decisionOf(after.checkoutId)).toMatchObject({ state: "queued" });

    const off = await world({ seller: { enabled: false, enabledAt: 1 } });
    const c = await checkout(off);
    await run(off);
    expect(await decisionOf(c.checkoutId)).toBeNull();
    const none = await world({ seller: null });
    const d = await checkout(none);
    await run(none);
    expect(await decisionOf(d.checkoutId)).toBeNull();
  });

  it("only open checkouts with an intent (the buyer saw the payment form)", async () => {
    const w = await world();
    const noIntent = await checkout(w, { paymentIntentId: null });
    const completed = await checkout(w, { status: "completed" });
    await run(w);
    expect(await decisionOf(noIntent.checkoutId)).toBeNull();
    expect(await decisionOf(completed.checkoutId)).toBeNull();
  });

  it(`decides at most ${REMINDER_BATCH} per tick, oldest first; the next ones on the next tick`, async () => {
    const w = await world();
    const seeded: SeededCheckout[] = [];
    for (let index = 0; index < REMINDER_BATCH + 1; index += 1) {
      seeded.push(await checkout(w, { createdAt: DUE - (REMINDER_BATCH + 1 - index) * 60_000 }));
    }
    const first = await run(w);
    expect(first.summary.examined).toBe(REMINDER_BATCH);
    expect(await decisionOf(seeded[REMINDER_BATCH]!.checkoutId)).toBeNull();
    expect(await decisionOf(seeded[0]!.checkoutId)).toMatchObject({ state: "queued" });
    expect(await decisionOf(seeded[REMINDER_BATCH - 1]!.checkoutId)).toMatchObject({ state: "queued" });
    const second = await run(w);
    expect(second.summary.examined).toBe(1);
    expect(await decisionOf(seeded[REMINDER_BATCH]!.checkoutId)).toMatchObject({ state: "queued" });
  });
});

describe("the races at the write", () => {
  it("the cap trigger decides two runs racing for one buyer: one queued, one frequency_cap", async () => {
    const w = await world();
    const email = `${nextId("race")}@buyer.test`;
    const hash = await hashEmailRecipient(email);
    const a = await seedCheckout(w.shop, { createdAt: DUE - HOUR_MS, email });
    const b = await seedCheckout(w.shop, { createdAt: DUE, email });
    const first = await queueReminder(env.DB, { checkout_id: a.checkoutId, tenant_id: w.shop }, hash, NOW);
    const second = await queueReminder(env.DB, { checkout_id: b.checkoutId, tenant_id: w.shop }, hash, NOW + 1);
    expect(first.kind).toBe("queued");
    expect(second).toEqual({ kind: "capped" });
    expect(await decisionOf(a.checkoutId)).toEqual({ reason: null, state: "queued" });
    expect(await decisionOf(b.checkoutId)).toEqual({ reason: "frequency_cap", state: "skipped" });
    // The refused batch left no outbox row behind.
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE tenant_id = ?", w.shop)).toBe(1);
  });

  it("a decision another run already wrote is tolerated (the UNIQUE)", async () => {
    const w = await world();
    const c = await seedCheckout(w.shop, { createdAt: DUE });
    const hash = await hashEmailRecipient(c.email);
    await env.DB.prepare(
      `INSERT INTO checkout_reminders (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
         decided_at, link_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'skipped', 'no_consent', ?, NULL, ?, ?)`,
    )
      .bind(crypto.randomUUID(), w.shop, c.checkoutId, hash, NOW, NOW, NOW)
      .run();
    expect(await queueReminder(env.DB, { checkout_id: c.checkoutId, tenant_id: w.shop }, "0".repeat(64), NOW)).toEqual({
      kind: "raced",
    });
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE tenant_id = ?", w.shop)).toBe(0);
  });
});

describe("does nothing at all without what a reminder needs", () => {
  it.each([
    ["no secret", { BETTER_AUTH_SECRET: undefined }, "no_secret"],
    ["no web origin", { CANONICAL_ORIGINS: { admin: "https://admin.test.invalid", api: "https://api.test.invalid" } }, "no_web_origin"],
    ["no Stripe", { STRIPE_SECRET_KEY: undefined }, "no_stripe"],
  ])("%s: no row, one log line", async (_label, overrides, reason) => {
    const w = await world();
    const c = await checkout(w);
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env: testEnv } = cronEnv(w.stripe, overrides);
    expect(await runCheckoutReminders(testEnv, NOW)).toEqual({
      disabled: reason,
      examined: 0,
      queued: 0,
      raced: 0,
      retried: 0,
      skipped: {},
    });
    expect(await decisionOf(c.checkoutId)).toBeNull();
    expect(logged).toHaveBeenCalledOnce();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("@");
  });
});

describe("the step", () => {
  it("is a cron step of its own, after the CP3 steps", () => {
    expect(CP9_STEPS.map(([name]) => name)).toEqual(["checkout_reminders"]);
  });

  it("logs counts and never an address", async () => {
    const w = await world();
    await checkout(w);
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env: testEnv } = cronEnv(w.stripe);
    await runCheckoutReminders(testEnv, NOW);
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/@|buyer\.test/);
  });
});

describe("the add-on and the seller's switch, flipped", () => {
  it("decides nothing once the switch is off; feature_off once the add-on is off", async () => {
    const w = await world();
    const c = await checkout(w);
    await setSellerSwitch(w.shop, { enabled: false, enabledAt: 1 });
    await run(w);
    expect(await decisionOf(c.checkoutId)).toBeNull();
    await setSellerSwitch(w.shop, { enabled: true, enabledAt: 1 });
    await setAddOn(w.shop, false);
    await run(w);
    expect(await decisionOf(c.checkoutId)).toEqual({ reason: "feature_off", state: "skipped" });
  });
});
