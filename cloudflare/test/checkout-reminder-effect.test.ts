import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { mintRecoveryToken } from "../src/commerce/checkout-recovery-token";
import { queueReminder } from "../src/commerce/checkout-reminders";
import { deliveryIdFromKey, hashEmailRecipient } from "../src/email/auth-email-job";
import type { CheckoutReminderEmailJob } from "../src/email/checkout-reminder-email";
import { fingerprintAuthEmailJob } from "../src/email/email-delivery-store";
import { processOutboxRowById } from "../src/outbox/effects";
import { alertsFor, outboxRow, quietEnv, recordingQueue } from "./dispatch-fixtures";
import {
  consentJson,
  count,
  HOUR_MS,
  nextId,
  seedCheckout,
  seedOrderFor,
  seedProduct,
  seedReminderShop,
  setAddOn,
  setSellerSwitch,
} from "./reminder-fixtures";

/**
 * CP9-AC build step 5: the `email.checkout_reminder` effect — every
 * send-time re-check withdraws the reminder and builds no mail; the happy
 * path builds ONE deterministic job through the ledger, frozen at the first
 * build except the recipient's name; another shop's reminder is never read.
 */

const NOW = Date.now() - 60_000;
const WEB = "https://web.test.invalid";

interface Queued {
  checkoutId: string;
  email: string;
  outboxId: string;
  reminderId: string;
  shop: string;
}

async function queued(
  options: { consent?: string | null; lines?: Array<{ productId: string; variantId?: string }>; shop?: string } = {},
): Promise<Queued> {
  const shop = options.shop ?? nextId("ace").toLowerCase();
  if (options.shop === undefined) {
    await seedReminderShop(shop, { shopName: "Fjällboden", supportEmail: "hej@fjallboden.test" });
    await seedProduct(shop, `${shop}-mug`, { name: "Mugg" });
    await seedProduct(shop, `${shop}-tee`, { name: "T-shirt Fjäll", variant: { label: "Svart, M", variantId: `${shop}-tee-m` } });
  }
  const checkout = await seedCheckout(shop, {
    consent: options.consent,
    createdAt: NOW - 2 * HOUR_MS,
    lines: options.lines ?? [
      { productId: `${shop}-tee`, variantId: `${shop}-tee-m` },
      { productId: `${shop}-mug` },
    ],
  });
  const written = await queueReminder(
    env.DB,
    { checkout_id: checkout.checkoutId, tenant_id: shop },
    await hashEmailRecipient(checkout.email),
    NOW,
  );
  if (written.kind !== "queued") {
    throw new Error(written.kind);
  }
  const reminder = await env.DB.prepare("SELECT reminder_id FROM checkout_reminders WHERE checkout_id = ?")
    .bind(checkout.checkoutId)
    .first<{ reminder_id: string }>();
  return { checkoutId: checkout.checkoutId, email: checkout.email, outboxId: written.outboxId, reminderId: reminder!.reminder_id, shop };
}

async function reminderOf(reminderId: string) {
  return env.DB.prepare("SELECT state, reason FROM checkout_reminders WHERE reminder_id = ?")
    .bind(reminderId)
    .first<{ reason: string | null; state: string }>();
}

async function ledgerOf(q: Queued) {
  return env.DB.prepare("SELECT kind, status, tenant_id, last_error_code, job_fingerprint FROM email_deliveries WHERE delivery_id = ?")
    .bind(await deliveryIdFromKey(`email.checkout_reminder:${q.reminderId}`))
    .first<{ job_fingerprint: string; kind: string; last_error_code: string | null; status: string; tenant_id: string }>();
}

const clock = (offset = 60_000) => () => NOW + offset;

describe("the happy path", () => {
  it("builds ONE job: the shop, the live recipient name, the buyable lines, the links, no price", async () => {
    const q = await queued();
    const { emails, env: quiet } = quietEnv();
    const result = await processOutboxRowById(quiet, q.outboxId, clock());
    expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(emails.sent).toHaveLength(1);
    const job = emails.sent[0] as CheckoutReminderEmailJob;
    const resume = await mintRecoveryToken(env, q.shop, q.reminderId, "resume");
    const unsubscribe = await mintRecoveryToken(env, q.shop, q.reminderId, "unsubscribe");
    const row = await outboxRow(q.outboxId);
    expect(job).toEqual({
      actionUrl: "",
      content: {
        items: [
          { label: "Svart, M", name: "T-shirt Fjäll", quantity: 1 },
          { label: null, name: "Mugg", quantity: 1 },
        ],
        linkValidUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        oneClickUnsubscribeUrl: `${WEB}/_api/${q.shop}/v1/checkout-recovery/${unsubscribe}/unsubscribe`,
        recipientName: "Anna Andersson",
        resumeUrl: `${WEB}/${q.shop}/aterta/${resume}`,
        shopName: "Fjällboden",
        supportEmail: "hej@fjallboden.test",
        unsubscribeUrl: `${WEB}/${q.shop}/avregistrera/${unsubscribe}`,
      },
      createdAt: row.created_at,
      deliveryId: await deliveryIdFromKey(`email.checkout_reminder:${q.reminderId}`),
      expiresAt: row.created_at + 2 * HOUR_MS,
      kind: "checkout_reminder",
      locale: "sv",
      recipient: q.email,
      tenantId: q.shop,
      version: 1,
    });
    expect(row).toMatchObject({ result_ref: job.deliveryId, status: "done" });
    expect(await ledgerOf(q)).toMatchObject({ kind: "checkout_reminder", status: "pending", tenant_id: q.shop });
    // Frozen without the recipient's name (read live) and without the address.
    const frozen = JSON.parse(row.frozen_json ?? "{}") as { checkoutReminder: Record<string, unknown> };
    expect(frozen.checkoutReminder).not.toHaveProperty("recipientName");
    expect(row.frozen_json).not.toContain(q.email);
    expect(row.payload_json).toBe(JSON.stringify({ reminderId: q.reminderId }));
    expect(await reminderOf(q.reminderId)).toEqual({ reason: null, state: "queued" });
  });

  it("lists only the lines still buyable", async () => {
    const q = await queued();
    await env.DB.prepare("UPDATE product_publications SET published = 0 WHERE product_id = ?").bind(`${q.shop}-tee`).run();
    const { emails, env: quiet } = quietEnv();
    await processOutboxRowById(quiet, q.outboxId, clock());
    expect((emails.sent[0] as CheckoutReminderEmailJob).content.items).toEqual([{ label: null, name: "Mugg", quantity: 1 }]);
  });

  it("a retry builds the identical job from the frozen part (a renamed shop changes nothing)", async () => {
    const q = await queued();
    const failing = quietEnv({ EMAIL_QUEUE: recordingQueue({ fail: true }).queue });
    expect(await processOutboxRowById(failing.env, q.outboxId, clock())).toMatchObject({ outcome: { kind: "retry" } });
    const recorded = await ledgerOf(q);
    expect(recorded).toMatchObject({ status: "pending" });
    await env.DB.prepare("UPDATE tenants SET shop_name = 'Nytt namn' WHERE tenant_id = ?").bind(q.shop).run();
    const { emails, env: quiet } = quietEnv();
    expect(await processOutboxRowById(quiet, q.outboxId, clock(10 * 60_000))).toEqual({ kind: "ran", outcome: { kind: "done" } });
    const job = emails.sent[0] as CheckoutReminderEmailJob;
    expect(job.content.shopName).toBe("Fjällboden");
    expect(await fingerprintAuthEmailJob(job)).toBe(recorded?.job_fingerprint);
  });
});

describe("every send-time re-check withdraws the reminder and builds no mail", () => {
  async function expectWithdrawn(q: Queued, reason: string) {
    const { emails, env: quiet } = quietEnv();
    expect(await processOutboxRowById(quiet, q.outboxId, clock())).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(emails.sent).toHaveLength(0);
    expect(await reminderOf(q.reminderId)).toEqual({ reason, state: "withdrawn" });
    expect(await outboxRow(q.outboxId)).toMatchObject({ result_ref: null, status: "done" });
    expect(await ledgerOf(q)).toBeNull();
  }

  it("1 paid: an order appeared after the decision", async () => {
    const q = await queued();
    await seedOrderFor(q.shop, { checkoutId: q.checkoutId, email: q.email, paymentIntentId: null });
    await expectWithdrawn(q, "paid");
  });

  it("2 feature_off: the platform turned the add-on off", async () => {
    const q = await queued();
    await setAddOn(q.shop, false);
    await expectWithdrawn(q, "feature_off");
  });

  it("3 switch_off: the seller turned the switch off", async () => {
    const q = await queued();
    await setSellerSwitch(q.shop, { enabled: false, enabledAt: 1 });
    await expectWithdrawn(q, "switch_off");
  });

  it("3 switch_off: turned off and on again after the checkout was made", async () => {
    const q = await queued();
    await setSellerSwitch(q.shop, { enabled: true, enabledAt: NOW });
    await expectWithdrawn(q, "switch_off");
  });

  it("4 orders_closed: the shop was unpublished", async () => {
    const q = await queued();
    await env.DB.prepare("UPDATE tenants SET published = 0 WHERE tenant_id = ?").bind(q.shop).run();
    await expectWithdrawn(q, "orders_closed");
  });

  it("5 no_consent: a reminder queued for a checkout without consent is never built", async () => {
    for (const consent of [consentJson(), null, JSON.stringify({ marketing: true })]) {
      const q = await queued({ consent });
      await expectWithdrawn(q, "no_consent");
    }
  });

  it("7 unsubscribed: the address unsubscribed after the decision", async () => {
    const q = await queued();
    await env.DB.prepare(
      "INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at) VALUES (?, ?, 'unsubscribe', ?)",
    )
      .bind(q.shop, await hashEmailRecipient(q.email), NOW)
      .run();
    await expectWithdrawn(q, "unsubscribed");
  });

  it("8 superseded: the buyer started a new checkout after the decision", async () => {
    const q = await queued();
    await seedCheckout(q.shop, { createdAt: NOW - HOUR_MS, email: q.email });
    await expectWithdrawn(q, "superseded");
  });

  it("11 unavailable: nothing of the cart is buyable any more", async () => {
    const q = await queued();
    await env.DB.prepare("UPDATE product_publications SET published = 0 WHERE tenant_id = ?").bind(q.shop).run();
    await expectWithdrawn(q, "unavailable");
  });

  it("closes the ledger row an earlier attempt recorded, so a job already in the queue is refused", async () => {
    const q = await queued();
    const failing = quietEnv({ EMAIL_QUEUE: recordingQueue({ fail: true }).queue });
    await processOutboxRowById(failing.env, q.outboxId, clock());
    expect(await ledgerOf(q)).toMatchObject({ status: "pending" });
    await seedOrderFor(q.shop, { checkoutId: q.checkoutId, email: q.email, paymentIntentId: null });
    const { emails, env: quiet } = quietEnv();
    await processOutboxRowById(quiet, q.outboxId, clock(10 * 60_000));
    expect(emails.sent).toHaveLength(0);
    expect(await reminderOf(q.reminderId)).toEqual({ reason: "paid", state: "withdrawn" });
    expect(await ledgerOf(q)).toMatchObject({ last_error_code: "E_WITHDRAWN", status: "failed" });
  });
});

describe("tenancy, lifetime, and what an alert says", () => {
  it("never reads another shop's reminder: an outbox row naming one fails, with no mail", async () => {
    const theirs = await queued();
    const mine = nextId("ace-mine").toLowerCase();
    await seedReminderShop(mine);
    const outboxId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO outbox_events (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id, dedupe_key,
         payload_json, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'email.checkout_reminder', 'checkout_reminder', ?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(outboxId, mine, theirs.reminderId, `email.checkout_reminder:${theirs.reminderId}:x`, JSON.stringify({ reminderId: theirs.reminderId }), NOW, NOW, NOW)
      .run();
    const { emails, env: quiet } = quietEnv();
    expect(await processOutboxRowById(quiet, outboxId, clock())).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(emails.sent).toHaveLength(0);
    expect(await reminderOf(theirs.reminderId)).toEqual({ reason: null, state: "queued" });
    expect((await outboxRow(outboxId)).last_error).toBe("invalid_payload");
  });

  it("past its 2 hours: a terminal failure whose alert names the reminder, never an address", async () => {
    const q = await queued();
    const { emails, env: quiet } = quietEnv();
    expect(await processOutboxRowById(quiet, q.outboxId, clock(2 * HOUR_MS))).toEqual({ kind: "ran", outcome: { kind: "failed" } });
    expect(emails.sent).toHaveLength(0);
    const [alert] = await alertsFor(q.outboxId);
    expect(alert).toMatchObject({ kind: "outbox_failed", severity: "warning" });
    expect(alert?.message).toContain(`checkout reminder ${q.reminderId}`);
    expect(alert?.message).toContain("email_expired");
    expect(alert?.message).not.toContain("@");
    expect(alert?.message).not.toContain(q.checkoutId);
  });

  it("a withdrawn reminder's row completes without a mail", async () => {
    const q = await queued();
    await env.DB.prepare("UPDATE checkout_reminders SET state = 'withdrawn', reason = 'paid', updated_at = ? WHERE reminder_id = ?")
      .bind(NOW, q.reminderId)
      .run();
    const { emails, env: quiet } = quietEnv();
    expect(await processOutboxRowById(quiet, q.outboxId, clock())).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(emails.sent).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_deliveries WHERE tenant_id = ?", q.shop)).toBe(0);
  });
});
