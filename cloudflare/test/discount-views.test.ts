import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { readAdminOrder } from "../src/commerce/admin-orders";
import { readBuyerOrder } from "../src/commerce/receipts";
import { createOrderConfirmationEmailJob, renderAuthEmail } from "../src/email/auth-email-job";
import type { OrderEmailJob } from "../src/email/order-emails";
import { canonicalOrderEmailContent, renderOrderEmail } from "../src/email/order-emails";
import { processOutboxRowById } from "../src/outbox/effects";
import { quietEnv } from "./dispatch-fixtures";
import { nextIntentId, seedCode, seedDiscountedCheckout, seedHeldCheckout } from "./discount-fixtures";
import { postEvent, seedTenant } from "./money-fixtures";
import { adminOf, expectNoCostKeys } from "./pod-fixtures";

/**
 * CP8-DC build step 7: the code's name reaches the views (design §4.4) by its
 * CURRENT name, from the order's frozen code id: the seller's order, the
 * buyer's receipt, the confirmation and the shop's notice. Null (views) or
 * absent (mails) on an order without a code, so those are what they were.
 */

const TENANT = "tenant-dc-views";

beforeAll(async () => {
  await seedTenant(TENANT, { shopName: "Vybutik" });
});

async function paidOrder(options: { code: boolean }): Promise<{ orderId: string }> {
  const paymentIntentId = nextIntentId();
  const checkout = options.code
    ? await seedHeldCheckout(TENANT, await seedCode({ code: "SOMMAR20", tenantId: TENANT, valueMinor: 1_000 }), {
        paymentIntentId,
        withLine: true,
      })
    : await seedDiscountedCheckout({ discountCodeId: null, paymentIntentId, tenantId: TENANT, withLine: true });
  const { response } = await postEvent("payment_intent.succeeded", {
    amount: checkout.totalMinor,
    currency: "sek",
    id: paymentIntentId,
    metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT },
    object: "payment_intent",
    status: "succeeded",
  });
  expect(response.status).toBe(200);
  const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
    .bind(checkout.checkoutId)
    .first<{ order_id: string }>();
  if (order === null) {
    throw new Error("no order");
  }
  return { orderId: order.order_id };
}

async function receiptOf(orderId: string) {
  const handoff = await env.DB.prepare("SELECT receipt_token FROM order_receipt_handoffs WHERE order_id = ?")
    .bind(orderId)
    .first<{ receipt_token: string }>();
  return readBuyerOrder(env.DB, TENANT, orderId, handoff?.receipt_token ?? "", Date.now());
}

async function emailJobs(orderId: string): Promise<Record<string, Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    "SELECT outbox_id AS id, dedupe_key FROM outbox_events WHERE aggregate_id = ? AND event_type = 'email' ORDER BY dedupe_key",
  )
    .bind(orderId)
    .all<{ dedupe_key: string; id: string }>();
  const jobs: Record<string, Record<string, unknown>> = {};
  for (const row of rows.results) {
    const { emails, env: quiet } = quietEnv();
    expect(await processOutboxRowById(quiet, row.id)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    const job = emails.sent[0] as Record<string, unknown>;
    jobs[String(job.kind)] = job;
  }
  return jobs;
}

describe("an order with a code", () => {
  it("names it on the seller's order, the receipt and both mails, with no cost key", async () => {
    const { orderId } = await paidOrder({ code: true });

    const admin = await readAdminOrder(env.DB, adminOf(TENANT), orderId, Date.now());
    expect(admin?.totals).toMatchObject({ discountCode: "SOMMAR20", discountMinor: 1_000 });
    expectNoCostKeys(admin);

    const receipt = await receiptOf(orderId);
    expect(receipt?.totals).toMatchObject({ discountCode: "SOMMAR20", discountMinor: 1_000 });
    expectNoCostKeys(receipt);

    const jobs = await emailJobs(orderId);
    const confirmation = jobs.order_confirmation as { order: Record<string, unknown> };
    expect(confirmation.order).toMatchObject({ discountCode: "SOMMAR20", discountMinor: 1_000 });
    const confirmationText = renderAuthEmail(confirmation as never).text;
    expect(confirmationText).toContain("Rabatt (SOMMAR20): -10,00");

    const notice = jobs.order_notice_shop as unknown as OrderEmailJob;
    expect((jobs.order_notice_shop as { content: Record<string, unknown> }).content).toMatchObject({ discountCode: "SOMMAR20" });
    expect(renderOrderEmail(notice).text).toContain("Rabatt (SOMMAR20): -10,00");
  });

  it("shows the code's current name (a rename before any use is allowed; after, refused)", async () => {
    const codeId = await seedCode({ code: "NAMEDLATER", tenantId: TENANT });
    await env.DB.prepare("UPDATE discount_codes SET code = 'NAMEDNOW' WHERE discount_code_id = ?").bind(codeId).run();
    const paymentIntentId = nextIntentId();
    const held = await seedHeldCheckout(TENANT, codeId, { paymentIntentId, withLine: true });
    await postEvent("payment_intent.succeeded", {
      amount: held.totalMinor,
      currency: "sek",
      id: paymentIntentId,
      metadata: { checkout_id: held.checkoutId, tenant_id: TENANT },
      object: "payment_intent",
      status: "succeeded",
    });
    const order = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?").bind(held.checkoutId).first<{ order_id: string }>();
    expect((await readAdminOrder(env.DB, adminOf(TENANT), order?.order_id ?? "", Date.now()))?.totals.discountCode).toBe("NAMEDNOW");
  });
});

describe("an order without a code", () => {
  it("says null in the views and leaves the mails as they were (no key, the plain label)", async () => {
    const { orderId } = await paidOrder({ code: false });

    expect((await readAdminOrder(env.DB, adminOf(TENANT), orderId, Date.now()))?.totals.discountCode).toBeNull();
    expect((await receiptOf(orderId))?.totals.discountCode).toBeNull();

    const jobs = await emailJobs(orderId);
    expect(Object.keys((jobs.order_confirmation as { order: Record<string, unknown> }).order)).not.toContain("discountCode");
    expect(Object.keys((jobs.order_notice_shop as { content: Record<string, unknown> }).content)).not.toContain("discountCode");
  });
});

describe("the mails' content rules", () => {
  const frame = {
    actionUrl: "" as const,
    createdAt: Date.now(),
    deliveryId: "00000000-0000-4000-8000-000000000000",
    expiresAt: Date.now() + 60_000,
    locale: "sv" as const,
    recipient: "buyer@buyer.test",
    tenantId: TENANT,
  };
  const order = {
    currency: "SEK",
    deliveryMethod: "pickup" as const,
    discountMinor: 5_980,
    items: [{ lineTotalMinor: 29_900, name: "Tröja", quantity: 1 }],
    orderNumber: "DC-1",
    shippingCountry: null,
    shippingMinor: 0,
    shopName: "Vybutik",
    subtotalMinor: 29_900,
    totalMinor: 23_920,
    vatMinor: 4_784,
  };

  it("renders the plain label without a code and the named one with it", () => {
    expect(renderAuthEmail(createOrderConfirmationEmailJob({ ...frame, order })).text).toContain("Rabatt: -59,80");
    const named = renderAuthEmail(createOrderConfirmationEmailJob({ ...frame, order: { ...order, discountCode: "SOMMAR<20>&" } }));
    expect(named.text).toContain("Rabatt (SOMMAR<20>&): -59,80");
    expect(named.html).toContain("Rabatt (SOMMAR&lt;20&gt;&amp;)");
  });

  it("refuses a code that is not one (whitespace, empty, too long, not a string)", () => {
    for (const discountCode of ["SOM MAR", "", "A".repeat(51), 7, null]) {
      expect(() =>
        createOrderConfirmationEmailJob({ ...frame, order: { ...order, discountCode: discountCode as never } }),
      ).toThrow();
    }
  });

  it("keeps an order's fingerprint content byte for byte without a code", () => {
    const notice = {
      ...frame,
      content: {
        adminUrl: null,
        currency: "SEK",
        deliveryMethod: "pickup" as const,
        discountMinor: 0,
        items: [{ lineTotalMinor: 29_900, name: "Tröja", quantity: 1 }],
        orderNumber: "DC-2",
        pickupPlaceName: null,
        shippingCountry: null,
        shippingMinor: 0,
        shopName: "Vybutik",
        subtotalMinor: 29_900,
        totalMinor: 29_900,
        vatMinor: 5_980,
      },
      kind: "order_notice_shop" as const,
      version: 1 as const,
    } as unknown as OrderEmailJob;
    expect(Object.keys(canonicalOrderEmailContent(notice))).toEqual([
      "adminUrl",
      "currency",
      "deliveryMethod",
      "discountMinor",
      "items",
      "orderNumber",
      "pickupPlaceName",
      "shippingCountry",
      "shippingMinor",
      "shopName",
      "subtotalMinor",
      "totalMinor",
      "vatMinor",
    ]);
  });
});
