import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  next,
  openAlerts,
  orderMoney,
  payCheckout,
  postEvent,
  seedCheckout,
  seedTenant,
  snapshotJson,
} from "./money-fixtures";

/**
 * PLAN §2.3 bullet 2 + the CP2 shared contract: the order batch the webhook
 * writes carries, atomically with the order,
 *  - the frozen Connect facts (charge, fee, withholding, destination) and the
 *    charge id,
 *  - the checkout's production snapshot copied opaquely onto the order and
 *    each `lines[]` entry onto its order line (lineNo = item_index + 1),
 *  - one `dispatch` outbox row per production line and one `email` row.
 */

const TENANT = "tenant-whm";
let accountId: string;

beforeAll(async () => {
  accountId = (await seedTenant(TENANT)) as string;
});

async function outboxFor(orderId: string) {
  const rows = await env.DB.prepare(
    `SELECT tenant_id, event_type, aggregate_type, aggregate_id, dedupe_key,
            payload_json, status, next_attempt_at
     FROM outbox_events WHERE aggregate_id = ? ORDER BY dedupe_key`,
  )
    .bind(orderId)
    .all<{
      aggregate_id: string;
      aggregate_type: string;
      dedupe_key: string;
      event_type: string;
      next_attempt_at: number;
      payload_json: string;
      status: string;
      tenant_id: string;
    }>();
  return rows.results;
}

async function lines(orderId: string) {
  const rows = await env.DB.prepare(
    "SELECT item_index, production_json FROM order_items WHERE order_id = ? ORDER BY item_index",
  )
    .bind(orderId)
    .all<{ item_index: number; production_json: string | null }>();
  return rows.results;
}

function podCheckout(itemCount: number, overrides: Partial<Parameters<typeof seedCheckout>[0]> = {}) {
  const snapshotLines = Array.from({ length: itemCount }, (_, index) => ({
    lineNo: index + 1,
    productionCostMinor: 9_840,
    quantity: 1,
    sku: `25001${index}0`,
    withholdMinor: 12_300,
  }));
  const withheld = 12_300 * itemCount;
  return seedCheckout({
    connect: { accountId, feeMinor: 1_000 * itemCount + withheld, withheldMinor: withheld },
    itemCount,
    snapshot: snapshotJson(snapshotLines),
    tenantId: TENANT,
    unitPriceMinor: 20_000,
    ...overrides,
  });
}

describe("frozen money facts on the order", () => {
  it("copies charge, fee, withholding, destination and the charge id", async () => {
    const checkout = await podCheckout(1);
    const orderId = await payCheckout(checkout, TENANT, { latestCharge: "ch_whm_1" });

    await expect(orderMoney(orderId)).resolves.toMatchObject({
      application_fee_minor: 13_300,
      charged_minor: 20_000,
      connect_account_id: accountId,
      payout_state: "pending",
      refund_reserved_minor: 0,
      refund_succeeded_minor: 0,
      refunded_total_minor: 0,
      stripe_charge_id: "ch_whm_1",
      withheld_minor: 12_300,
    });
  });

  it("records the intent as succeeded and the checkout as completed", async () => {
    const checkout = await podCheckout(1);
    await payCheckout(checkout, TENANT);

    const row = await env.DB.prepare(
      "SELECT status, payment_intent_status, payment_intent_status_at FROM checkouts WHERE checkout_id = ?",
    )
      .bind(checkout.checkoutId)
      .first<{ payment_intent_status: string; payment_intent_status_at: number; status: string }>();
    expect(row).toMatchObject({ payment_intent_status: "succeeded", status: "completed" });
    expect(row?.payment_intent_status_at).toBeGreaterThan(0);
  });

  it("records 0 and no destination for a checkout that predates the Connect facts", async () => {
    const checkout = await seedCheckout({ tenantId: TENANT });
    const orderId = await payCheckout(checkout, TENANT);

    await expect(orderMoney(orderId)).resolves.toMatchObject({
      application_fee_minor: 0,
      charged_minor: 20_000,
      connect_account_id: null,
      withheld_minor: 0,
    });
  });

  it("freezes those facts against later edits", async () => {
    const checkout = await podCheckout(1);
    const orderId = await payCheckout(checkout, TENANT);

    for (const column of ["charged_minor", "application_fee_minor", "withheld_minor"]) {
      await expect(
        env.DB.prepare(`UPDATE orders SET ${column} = ${column} + 1 WHERE order_id = ?`)
          .bind(orderId)
          .run(),
      ).rejects.toThrow(/immutable/);
    }
    await expect(
      env.DB.prepare("UPDATE orders SET production_snapshot_json = '{}' WHERE order_id = ?")
        .bind(orderId)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare("UPDATE order_items SET production_json = NULL WHERE order_id = ?")
        .bind(orderId)
        .run(),
    ).rejects.toThrow(/immutable/);
  });
});

describe("the production snapshot, copied opaquely", () => {
  it("copies the whole snapshot onto the order and each line onto its order line", async () => {
    const checkout = await podCheckout(2);
    const source = await env.DB.prepare(
      "SELECT production_snapshot_json FROM checkouts WHERE checkout_id = ?",
    )
      .bind(checkout.checkoutId)
      .first<{ production_snapshot_json: string }>();
    const orderId = await payCheckout(checkout, TENANT);

    const order = await env.DB.prepare(
      "SELECT production_snapshot_json FROM orders WHERE order_id = ?",
    )
      .bind(orderId)
      .first<{ production_snapshot_json: string }>();
    expect(order?.production_snapshot_json).toBe(source?.production_snapshot_json);

    const parsed = JSON.parse(source?.production_snapshot_json ?? "{}") as {
      lines: Array<{ lineNo: number }>;
    };
    const orderLines = await lines(orderId);
    expect(orderLines).toHaveLength(2);
    for (const line of orderLines) {
      const expected = parsed.lines.find((l) => l.lineNo === line.item_index + 1);
      expect(JSON.parse(line.production_json ?? "null")).toEqual(expected);
    }
  });

  it("leaves a non-POD order without a snapshot", async () => {
    const checkout = await seedCheckout({
      connect: { accountId, feeMinor: 1_000, withheldMinor: 0 },
      tenantId: TENANT,
    });
    const orderId = await payCheckout(checkout, TENANT);

    const order = await env.DB.prepare(
      "SELECT production_snapshot_json FROM orders WHERE order_id = ?",
    )
      .bind(orderId)
      .first<{ production_snapshot_json: string | null }>();
    expect(order?.production_snapshot_json).toBeNull();
    expect((await lines(orderId)).map((l) => l.production_json)).toEqual([null]);
  });
});

describe("the outbox rows in the order batch", () => {
  it("queues one dispatch per production line, one confirmation and one shop notice", async () => {
    const checkout = await podCheckout(2);
    const orderId = await payCheckout(checkout, TENANT);

    const rows = await outboxFor(orderId);
    expect(rows.map((r) => [r.event_type, r.dedupe_key])).toEqual([
      ["dispatch", `dispatch:${orderId}:1`],
      ["dispatch", `dispatch:${orderId}:2`],
      ["email", `email:order_confirmation:${orderId}`],
      // CP5-WE: the shop's new-order notice, in the same batch.
      ["email", `email:order_notice_shop:${orderId}`],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        aggregate_id: orderId,
        aggregate_type: "order",
        status: "pending",
        tenant_id: TENANT,
      });
      expect(row.next_attempt_at).toBeGreaterThan(0);
    }

    // The payloads are the shared contract, byte for byte.
    expect(rows[0]?.payload_json).toBe(
      `{"orderId":"${orderId}","lineNo":1,"jobId":"${orderId}-1"}`,
    );
    expect(rows[1]?.payload_json).toBe(
      `{"orderId":"${orderId}","lineNo":2,"jobId":"${orderId}-2"}`,
    );
    expect(rows[2]?.payload_json).toBe(
      `{"orderId":"${orderId}","kind":"order_confirmation"}`,
    );
    expect(rows[3]?.payload_json).toBe(
      `{"orderId":"${orderId}","kind":"order_notice_shop"}`,
    );
  });

  it("queues only the two mails for an order without a snapshot", async () => {
    const checkout = await seedCheckout({ tenantId: TENANT });
    const orderId = await payCheckout(checkout, TENANT);

    expect((await outboxFor(orderId)).map((r) => r.event_type)).toEqual(["email", "email"]);
  });

  it("writes the rows exactly once however often the event arrives", async () => {
    const checkout = await podCheckout(1);
    const payload = {
      amount: checkout.totalMinor,
      currency: "sek",
      id: checkout.paymentIntentId,
      metadata: { checkout_id: checkout.checkoutId, tenant_id: TENANT },
      object: "payment_intent",
      status: "succeeded",
    };
    const eventId = next("evt_whm");

    const first = await Promise.all([
      postEvent("payment_intent.succeeded", payload, { eventId }),
      postEvent("payment_intent.succeeded", payload, { eventId }),
      postEvent("payment_intent.succeeded", payload),
    ]);
    for (const { response } of first) {
      expect(response.status).toBe(200);
    }

    const orders = await env.DB.prepare("SELECT order_id FROM orders WHERE checkout_id = ?")
      .bind(checkout.checkoutId)
      .all<{ order_id: string }>();
    expect(orders.results).toHaveLength(1);
    const orderId = orders.results[0]?.order_id as string;
    expect(await outboxFor(orderId)).toHaveLength(3);

    // No orphaned rows from a losing batch: every outbox row for any order of
    // this checkout belongs to the one order that exists.
    const orphans = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox_events
       WHERE aggregate_type = 'order'
         AND aggregate_id NOT IN (SELECT order_id FROM orders)`,
    ).first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});

describe("a snapshot the webhook cannot read", () => {
  it.each([
    ["a duplicate lineNo", JSON.stringify({ lines: [{ lineNo: 1 }, { lineNo: 1 }], totals: { withholdMinor: 0 } })],
    ["no lines array", JSON.stringify({ totals: { withholdMinor: 0 } })],
    ["a line without lineNo", JSON.stringify({ lines: [{ sku: "x" }], totals: { withholdMinor: 0 } })],
    ["lineNo 0", JSON.stringify({ lines: [{ lineNo: 0 }], totals: { withholdMinor: 0 } })],
    ["a lineNo naming no order line", JSON.stringify({ lines: [{ lineNo: 2 }], totals: { withholdMinor: 0 } })],
  ])("still creates the paid order, queues no dispatch, and alerts (%s)", async (_label, snapshot) => {
    const checkout = await seedCheckout({ snapshot, tenantId: TENANT });
    const orderId = await payCheckout(checkout, TENANT);

    const order = await env.DB.prepare(
      "SELECT production_snapshot_json FROM orders WHERE order_id = ?",
    )
      .bind(orderId)
      .first<{ production_snapshot_json: string | null }>();
    expect(order?.production_snapshot_json).toBeNull();
    expect((await outboxFor(orderId)).map((r) => r.event_type)).toEqual(["email", "email"]);

    const alerts = await openAlerts("production_snapshot_invalid", orderId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ resource_type: "order", severity: "critical", tenant_id: TENANT });
  });
});
