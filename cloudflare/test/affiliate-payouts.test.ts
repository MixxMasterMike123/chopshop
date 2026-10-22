import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { recordPayout } from "../src/affiliate/payouts";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import { readBuyerOrder } from "../src/commerce/receipts";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  ADMIN_HOST,
  BUYER_FIELD_DENYLIST,
  count,
  featureStatement,
  hostRequest,
  keysOf,
  nextId,
  type Person,
  portalAffiliateOf,
  shopAdminOf,
} from "./affiliate-fixtures";
import { seedPlainProduct, seedShop } from "./discount-fixtures";
import { payCheckout } from "./money-fixtures";

/**
 * CP13 — the manual payout rail (design §6.1–§6.2) through its routes: the
 * affiliate's request reserves (guarded inside the batch), one open request,
 * the shop's paid / void / record, the negative balance, the invoice (a PDF,
 * the affiliate's own, frozen once attached), and the affiliate's
 * projections walked against the buyer-field denylist.
 */

const SHOP = "aff-pay";
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: "aff-pay.test", tenantId: SHOP };

type Affiliate = Person & { affiliateId: string };
let admin: Person;

function call(request: Request): Promise<Response> {
  return worker.fetch(request, env);
}

function asAdmin(method: string, path: string, body?: unknown) {
  return call(hostRequest(method, path, { body, cookie: admin.cookie, shopId: SHOP }));
}

function asAffiliate(person: Affiliate, method: string, path: string, body?: unknown) {
  return call(hostRequest(method, path, { body, cookie: person.cookie, shopId: SHOP }));
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json<{ error: { code: string } }>()).error.code;
}

/** An affiliate whose profile can carry an invoice (name + postal address). */
async function payableAffiliate(code: string): Promise<Affiliate> {
  const person = await portalAffiliateOf(SHOP, code);
  const response = await asAffiliate(person, "PATCH", "/v1/affiliate/profile", {
    addressLine1: "Storgatan 1",
    city: "Malmö",
    postalCode: "211 22",
  });
  expect(response.status).toBe(200);
  return person;
}

async function fund(person: Affiliate, amountMinor: number): Promise<void> {
  const response = await asAdmin("POST", `/v1/admin/affiliates/${person.affiliateId}/adjustments`, {
    amountMinor,
    reason: "Test",
  });
  expect(response.status).toBe(201);
}

interface Balance {
  heldMinor: number;
  payableMinor: number;
  requestedMinor: number;
}

async function balanceOf(person: Affiliate): Promise<Balance> {
  const me = await (await asAffiliate(person, "GET", "/v1/affiliate/me")).json<{ affiliate: { balance: Balance } }>();
  return me.affiliate.balance;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");

function upload(person: Affiliate, objectId: string, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  return call(
    new Request(`${ADMIN_HOST}/v1/affiliate/objects/${objectId}/content`, {
      body: bytes,
      headers: {
        "content-length": String(bytes.length),
        "content-type": "application/pdf",
        cookie: person.cookie,
        origin: ADMIN_HOST,
        "x-shop-id": SHOP,
      },
      method: "PUT",
    }),
  );
}

async function invoiceOf(person: Affiliate, bytes: Uint8Array<ArrayBuffer> = PDF): Promise<string> {
  const reserved = await asAffiliate(person, "POST", "/v1/affiliate/objects", {
    contentType: "application/pdf",
    fileName: "faktura.pdf",
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.length,
  });
  expect(reserved.status).toBe(201);
  return (await reserved.json<{ object: { objectId: string } }>()).object.objectId;
}

/** A document the SHOP stored (not an affiliate's upload): active, private, with its bytes. */
async function shopDocument(bytes: Uint8Array<ArrayBuffer> = PDF): Promise<string> {
  const objectId = crypto.randomUUID();
  const key = `shops/${SHOP}/document/${objectId}/v1/kvitto.pdf`;
  await env.PRIVATE_BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind, content_type, size_bytes, sha256,
       status, immutable, created_at, updated_at)
     VALUES (?, ?, 'private', ?, 'document', 'application/pdf', ?, ?, 'active', 0, ?, ?)`,
  )
    .bind(objectId, SHOP, key, bytes.length, await sha256Hex(bytes), now, now)
    .run();
  return objectId;
}

beforeAll(async () => {
  await seedShop(SHOP, "aff-pay.test", { discountCodes: false });
  await seedPlainProduct(SHOP, `${SHOP}-goods`, 50_000);
  await featureStatement(SHOP, "affiliate", true).run();
  admin = await shopAdminOf(SHOP);
});

describe("the affiliate's request (reserve-first)", () => {
  it("refuses without a complete profile, then reserves the whole payable: one payout row, one ledger row", async () => {
    const person = await portalAffiliateOf(SHOP, "PROFILE1");
    await fund(person, 10_000);
    expect(await errorCode(await asAffiliate(person, "POST", "/v1/affiliate/payouts", {}))).toBe("profile_incomplete");
    await asAffiliate(person, "PATCH", "/v1/affiliate/profile", { addressLine1: "Gatan 2", city: "Lund", postalCode: "222 22" });
    expect(await errorCode(await asAffiliate(person, "POST", "/v1/affiliate/payouts", { amountMinor: 10_001 }))).toBe(
      "insufficient_balance",
    );
    const response = await asAffiliate(person, "POST", "/v1/affiliate/payouts", {});
    expect(response.status).toBe(201);
    const { payout } = await response.json<{ payout: { amountMinor: number; payoutId: string; status: string } }>();
    expect(payout).toMatchObject({ amountMinor: 10_000, status: "requested" });
    expect(
      await count("SELECT COUNT(*) AS n FROM affiliate_ledger WHERE kind = 'payout' AND ref = ? AND amount_minor = -10000", payout.payoutId),
    ).toBe(1);
    expect(await balanceOf(person)).toMatchObject({ payableMinor: 0, requestedMinor: 10_000 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.payout_request' AND resource_id = ?", payout.payoutId)).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND payload_json LIKE '%affiliate_payout_requested%'", payout.payoutId),
    ).toBe(1);
  });

  it("refuses without accepted current terms", async () => {
    const person = await portalAffiliateOf(SHOP, "NOTERMS", { termsAccepted: false });
    await asAffiliate(person, "PATCH", "/v1/affiliate/profile", { addressLine1: "Gatan 2", city: "Lund", postalCode: "222 22" });
    await fund(person, 5_000);
    expect(await errorCode(await asAffiliate(person, "POST", "/v1/affiliate/payouts", {}))).toBe("terms_required");
  });

  it("one open request: a second is payout_open; two racing requests land exactly one", async () => {
    const person = await payableAffiliate("RACE1");
    await fund(person, 20_000);
    const responses = await Promise.all([
      asAffiliate(person, "POST", "/v1/affiliate/payouts", { amountMinor: 5_000 }),
      asAffiliate(person, "POST", "/v1/affiliate/payouts", { amountMinor: 5_000 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_payouts WHERE affiliate_id = ?", person.affiliateId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_ledger WHERE affiliate_id = ? AND kind = 'payout'", person.affiliateId)).toBe(1);
    expect(await errorCode(await asAffiliate(person, "POST", "/v1/affiliate/payouts", { amountMinor: 1_000 }))).toBe("payout_open");
    // The shop cannot record a payment beside an open request either.
    expect(
      await errorCode(await asAdmin("POST", `/v1/admin/affiliates/${person.affiliateId}/payouts`, { amountMinor: 1_000 })),
    ).toBe("payout_open");
  });

  it("a negative balance (a paid commission later reversed) makes the payable 0: nothing lands", async () => {
    const person = await payableAffiliate("NEGATIVE");
    await fund(person, -5_000);
    expect(await balanceOf(person)).toMatchObject({ payableMinor: 0 });
    expect(await errorCode(await asAffiliate(person, "POST", "/v1/affiliate/payouts", {}))).toBe("insufficient_balance");
    await fund(person, 7_000);
    expect(await balanceOf(person)).toMatchObject({ payableMinor: 2_000 });
  });
});

describe("the shop's decisions: paid, void, record", () => {
  it("paid records the evidence and mails; a second decision is payout_not_open", async () => {
    const person = await payableAffiliate("PAIDONE");
    await fund(person, 3_000);
    const { payout } = await (await asAffiliate(person, "POST", "/v1/affiliate/payouts", {})).json<{ payout: { payoutId: string } }>();
    const paid = await asAdmin("POST", `/v1/admin/affiliates/payouts/${payout.payoutId}/paid`, { reference: "Swish 123" });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ payout: { reference: "Swish 123", status: "paid" } });
    expect(await balanceOf(person)).toMatchObject({ payableMinor: 0, requestedMinor: 0 });
    expect(await errorCode(await asAdmin("POST", `/v1/admin/affiliates/payouts/${payout.payoutId}/paid`, {}))).toBe("payout_not_open");
    expect(await errorCode(await asAdmin("POST", `/v1/admin/affiliates/payouts/${payout.payoutId}/void`, { reason: "x" }))).toBe(
      "payout_not_open",
    );
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.payout_paid' AND resource_id = ?", payout.payoutId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ?", payout.payoutId)).toBe(2);
  });

  it("void releases the reservation by a compensating row, never a delete", async () => {
    const person = await payableAffiliate("VOIDONE");
    await fund(person, 4_000);
    const { payout } = await (await asAffiliate(person, "POST", "/v1/affiliate/payouts", {})).json<{ payout: { payoutId: string } }>();
    expect((await asAdmin("POST", `/v1/admin/affiliates/payouts/${payout.payoutId}/void`, {})).status).toBe(400);
    const voided = await asAdmin("POST", `/v1/admin/affiliates/payouts/${payout.payoutId}/void`, { reason: "Fel konto" });
    expect(await voided.json()).toMatchObject({ payout: { status: "void", voidReason: "Fel konto" } });
    expect(await balanceOf(person)).toMatchObject({ payableMinor: 4_000, requestedMinor: 0 });
    const rows = await env.DB.prepare("SELECT kind, amount_minor FROM affiliate_ledger WHERE ref = ? ORDER BY created_at, rowid")
      .bind(payout.payoutId)
      .all();
    expect(rows.results).toEqual([
      { amount_minor: -4_000, kind: "payout" },
      { amount_minor: 4_000, kind: "payout_void" },
    ]);
    // And a fresh request lands again.
    expect((await asAffiliate(person, "POST", "/v1/affiliate/payouts", {})).status).toBe(201);
  });

  it("the shop records a payment it made (requested and paid at once), within the payable", async () => {
    const person = await payableAffiliate("RECORD1");
    await fund(person, 6_000);
    expect(
      await errorCode(await asAdmin("POST", `/v1/admin/affiliates/${person.affiliateId}/payouts`, { amountMinor: 6_001 })),
    ).toBe("insufficient_balance");
    const recorded = await asAdmin("POST", `/v1/admin/affiliates/${person.affiliateId}/payouts`, {
      amountMinor: 6_000,
      reference: "Bank 2026-10-22",
    });
    expect(recorded.status).toBe(201);
    expect(await recorded.json()).toMatchObject({ payout: { amountMinor: 6_000, status: "paid" } });
    const list = await (await asAdmin("GET", `/v1/admin/affiliates/${person.affiliateId}/payouts`)).json<{
      balances: Array<{ paidMinor: number; payableMinor: number }>;
      payouts: unknown[];
    }>();
    expect(list.balances[0]).toMatchObject({ paidMinor: 6_000, payableMinor: 0 });
    expect(list.payouts).toHaveLength(1);
  });
});

describe("the invoice (design §6.1, R2-12)", () => {
  it("is a PDF of at most 10 MB: other types and sizes are refused at reserve, other bytes at upload", async () => {
    const person = await payableAffiliate("INVTYPE");
    for (const body of [
      { contentType: "image/png", sha256: "a".repeat(64), sizeBytes: 10 },
      { contentType: "application/pdf", sha256: "a".repeat(64), sizeBytes: 10 * 1024 * 1024 + 1 },
      { contentType: "application/pdf", kind: "document", sha256: "a".repeat(64), sizeBytes: 10 },
    ]) {
      expect((await asAffiliate(person, "POST", "/v1/affiliate/objects", body)).status, JSON.stringify(body)).toBe(400);
    }
    const png = new TextEncoder().encode("\x89PNG not a pdf at all");
    const objectId = await invoiceOf(person, png);
    const refused = await upload(person, objectId, png);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { reason: "type_not_as_stated" } });
  });

  it("attaches to the request, is frozen, and is read back only by its affiliate", async () => {
    const person = await payableAffiliate("INVOK");
    const other = await payableAffiliate("INVOTHER");
    await fund(person, 2_500);
    await fund(other, 2_500);
    const objectId = await invoiceOf(person);
    // Another affiliate of the same shop cannot upload into it, nor attach it.
    expect((await upload(other, objectId, PDF)).status).toBe(404);
    expect((await upload(person, objectId, PDF)).status).toBe(200);
    expect(
      await errorCode(await asAffiliate(other, "POST", "/v1/affiliate/payouts", { invoiceNumber: "F-1", invoiceObjectId: objectId })),
    ).toBe("invalid_invoice");
    const response = await asAffiliate(person, "POST", "/v1/affiliate/payouts", { invoiceNumber: "F-1", invoiceObjectId: objectId });
    expect(response.status).toBe(201);
    const { payout } = await response.json<{ payout: { hasInvoice: boolean; payoutId: string } }>();
    expect(payout.hasInvoice).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM stored_objects WHERE object_id = ? AND immutable = 1", objectId)).toBe(1);
    const download = await asAffiliate(person, "GET", `/v1/affiliate/payouts/${payout.payoutId}/invoice`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition") ?? "").toContain("attachment");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF);
    expect((await asAffiliate(other, "GET", `/v1/affiliate/payouts/${payout.payoutId}/invoice`)).status).toBe(404);
    // A re-upload of an active (attached) invoice is a conflict.
    expect((await upload(person, objectId, PDF)).status).toBe(409);
  });

  it("an invoice not yet uploaded cannot be attached", async () => {
    const person = await payableAffiliate("INVPEND");
    await fund(person, 1_000);
    const objectId = await invoiceOf(person);
    expect(await errorCode(await asAffiliate(person, "POST", "/v1/affiliate/payouts", { invoiceObjectId: objectId }))).toBe(
      "invalid_invoice",
    );
  });
});

describe("round 1: the invoice limits, the shop's own document, the grant", () => {
  it("at most 5 loose invoices (pending or attached to no payout): the 6th is too_many_pending_invoices and writes nothing", async () => {
    const person = await payableAffiliate("LOOSE5");
    await fund(person, 1_000);
    // One attached to a payout does not count.
    const attached = await invoiceOf(person);
    expect((await upload(person, attached, PDF)).status).toBe(200);
    expect((await asAffiliate(person, "POST", "/v1/affiliate/payouts", { invoiceObjectId: attached })).status).toBe(201);
    for (let index = 0; index < 5; index += 1) {
      await invoiceOf(person);
    }
    const objects = await count("SELECT COUNT(*) AS n FROM stored_objects WHERE tenant_id = ?", SHOP);
    const audits = await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'object.reserve'");
    const sixth = await asAffiliate(person, "POST", "/v1/affiliate/objects", {
      contentType: "application/pdf",
      sha256: await sha256Hex(PDF),
      sizeBytes: PDF.length,
    });
    expect(sixth.status).toBe(409);
    expect(await errorCode(sixth)).toBe("too_many_pending_invoices");
    expect(await count("SELECT COUNT(*) AS n FROM stored_objects WHERE tenant_id = ?", SHOP)).toBe(objects);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'object.reserve'")).toBe(audits);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_invoice_objects WHERE affiliate_id = ?", person.affiliateId)).toBe(6);
    // Another affiliate's cap is its own.
    const other = await payableAffiliate("LOOSE5B");
    await invoiceOf(other);
  });

  it("20 reservations a day per affiliate, refused ones included; the 21st is rate_limited", async () => {
    const person = await payableAffiliate("DAILY20");
    const body = { contentType: "application/pdf", sha256: "b".repeat(64), sizeBytes: 10 };
    const statuses: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      statuses.push((await asAffiliate(person, "POST", "/v1/affiliate/objects", body)).status);
    }
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses.slice(5).every((status) => status === 409)).toBe(true);
    const limited = await asAffiliate(person, "POST", "/v1/affiliate/objects", body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("a payout the shop recorded with ITS OWN document: the affiliate downloads it (payout → affiliate is the ownership)", async () => {
    const person = await payableAffiliate("SHOPDOC");
    await fund(person, 2_000);
    const objectId = await shopDocument();
    const recorded = await asAdmin("POST", `/v1/admin/affiliates/${person.affiliateId}/payouts`, {
      amountMinor: 2_000,
      invoiceObjectId: objectId,
      reference: "Bank",
    });
    expect(recorded.status).toBe(201);
    const { payout } = await recorded.json<{ payout: { payoutId: string } }>();
    const listed = await (await asAffiliate(person, "GET", "/v1/affiliate/payouts")).json<{ payouts: Array<{ hasInvoice: boolean }> }>();
    expect(listed.payouts[0]?.hasInvoice).toBe(true);
    const download = await asAffiliate(person, "GET", `/v1/affiliate/payouts/${payout.payoutId}/invoice`);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF);
    // Still not another affiliate's to read, nor to attach to a request.
    const other = await payableAffiliate("SHOPDOC2");
    await fund(other, 1_000);
    expect((await asAffiliate(other, "GET", `/v1/affiliate/payouts/${payout.payoutId}/invoice`)).status).toBe(404);
    const loose = await shopDocument();
    expect(await errorCode(await asAffiliate(other, "POST", "/v1/affiliate/payouts", { invoiceObjectId: loose }))).toBe("invalid_invoice");
  });

  it("a platform user acting as the shop records a payout: the invoice freeze's audit row names the grant", async () => {
    const person = await payableAffiliate("GRANTED");
    await fund(person, 1_500);
    const objectId = await shopDocument();
    const result = await recordPayout(
      env.DB,
      { accountType: "tenant_admin", actingAs: { grantId: "grant-round1" }, role: "admin", tenantId: SHOP, userId: admin.userId },
      person.affiliateId,
      { amountMinor: 1_500, invoiceNumber: null, invoiceObjectId: objectId, notes: null, reference: null },
      Date.now(),
    );
    expect(result.status).toBe("ok");
    const freeze = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE action = 'object.freeze' AND resource_id = ?")
      .bind(objectId)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(freeze?.metadata_json ?? "{}")).toMatchObject({ actingAsGrantId: "grant-round1" });
    // The affiliate's own request freezes with no grant.
    const own = await payableAffiliate("OWNFREEZE");
    await fund(own, 500);
    const ownObject = await invoiceOf(own);
    await upload(own, ownObject, PDF);
    expect((await asAffiliate(own, "POST", "/v1/affiliate/payouts", { invoiceObjectId: ownObject })).status).toBe(201);
    const ownFreeze = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE action = 'object.freeze' AND resource_id = ?")
      .bind(ownObject)
      .first<{ metadata_json: string }>();
    expect(ownFreeze?.metadata_json ?? "").not.toContain("actingAsGrantId");
  });
});

describe("the projections (design §7.1, §8.9)", () => {
  function input(overrides: Partial<CreateCheckoutInput>): CreateCheckoutInput {
    return {
      deliveryMethod: "pickup",
      discountCode: null,
      email: `${nextId("buyer")}@buyer.test`,
      idempotencyKey: nextId("idem"),
      items: [{ productId: `${SHOP}-goods`, quantity: 1 }],
      refCode: null,
      shippingCountry: null,
      ...overrides,
    };
  }

  async function paidOrder(overrides: Partial<CreateCheckoutInput>): Promise<string> {
    const created = await createCheckout(env.DB, CONTEXT, input(overrides), Date.now());
    if (created.status !== "ok") {
      throw new Error(created.status);
    }
    const intent = `pi_pay_${created.checkout.checkoutId.replaceAll("-", "")}`;
    await env.DB.prepare("UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?")
      .bind(intent, created.checkout.checkoutId)
      .run();
    return payCheckout(
      { checkoutId: created.checkout.checkoutId, paymentIntentId: intent, totalMinor: created.checkout.totalMinor },
      SHOP,
    );
  }

  function walk(value: unknown, label: string): void {
    const keys = keysOf(value).map((key) => key.toLowerCase());
    for (const denied of BUYER_FIELD_DENYLIST) {
      expect(keys.filter((key) => key.includes(denied)), `${label}: ${denied}`).toEqual([]);
    }
  }

  it("the portal's orders, ledger and payouts carry no buyer field; a self-referral stays out of the portal", async () => {
    const person = await payableAffiliate("PROJ10");
    const orderId = await paidOrder({ refCode: "PROJ10" });
    await paidOrder({ email: person.email, refCode: "PROJ10" });
    await fund(person, 1_000);
    await asAffiliate(person, "POST", "/v1/affiliate/payouts", {});

    const orders = await (await asAffiliate(person, "GET", "/v1/affiliate/orders")).json<{ orders: Array<{ commissionMinor: number; state: string }> }>();
    expect(orders.orders).toHaveLength(1);
    expect(orders.orders[0]).toMatchObject({ commissionMinor: 5_400, state: "held" });
    walk(orders, "orders");
    const ledger = await (await asAffiliate(person, "GET", "/v1/affiliate/ledger")).json<{ entries: unknown[] }>();
    expect(ledger.entries.length).toBeGreaterThanOrEqual(3);
    walk(ledger, "ledger");
    const payouts = await (await asAffiliate(person, "GET", "/v1/affiliate/payouts")).json<{ payouts: unknown[] }>();
    expect(payouts.payouts).toHaveLength(1);
    walk(payouts, "payouts");
    expect(JSON.stringify([orders, ledger, payouts])).not.toContain(orderId);
    expect(JSON.stringify([orders, ledger, payouts])).not.toContain("@buyer.test");

    // The shop sees both orders, the self-referral flagged and earning nothing.
    const admin = await (await asAdmin("GET", `/v1/admin/affiliates/${person.affiliateId}/orders`)).json<{
      orders: Array<{ affiliateCommissionMinor: number; selfReferral: boolean }>;
    }>();
    expect(admin.orders.map((order) => [order.selfReferral, order.affiliateCommissionMinor]).sort()).toEqual([
      [false, 5_400],
      [true, 0],
    ]);
    // The shop's order detail carries the attribution, never a platform figure in it.
    const detail = await (await asAdmin("GET", `/v1/admin/orders/${orderId}`)).json<{ order: { affiliate: unknown } }>();
    expect(detail.order.affiliate).toMatchObject({ attribution: "link", code: "PROJ10", affiliateCommissionMinor: 5_400 });
    walk(detail.order.affiliate, "admin order affiliate");
  });

  it("/v1/affiliate/me: exactly its keys, the profile is the affiliate's own, nothing else names a buyer (round 1)", async () => {
    const person = await payableAffiliate("MEWALK");
    await paidOrder({ email: "me-walk-buyer@buyer.test", refCode: "MEWALK" });
    const me = await (await asAffiliate(person, "GET", "/v1/affiliate/me")).json<{ affiliate: Record<string, unknown> }>();
    // The affiliate's OWN profile and the shop's contact are the only names,
    // addresses and e-mails it carries; the key set is pinned so no new key
    // can arrive unwalked.
    const OWN_PROFILE = ["address", "email", "name", "phone", "shop", "socials"];
    expect(Object.keys(me.affiliate).sort()).toEqual(
      [
        "affiliateId",
        "balance",
        "clicksByDay",
        "code",
        "commissionBp",
        "currency",
        "discountBp",
        "links",
        "payoutBlockers",
        "preferredLang",
        "programActive",
        "status",
        "terms",
        ...OWN_PROFILE,
      ].sort(),
    );
    expect(me.affiliate.email).toBe(person.email);
    const rest = Object.fromEntries(Object.entries(me.affiliate).filter(([key]) => !OWN_PROFILE.includes(key)));
    walk(rest, "me");
    expect(JSON.stringify(me)).not.toContain("me-walk-buyer");
    expect(JSON.stringify(me)).not.toContain("@buyer.test");
  });

  it("a 0-öre affiliate attribution shows no discount label on the receipt or the admin order (round 1)", async () => {
    await portalAffiliateOf(SHOP, "ZEROOFF", { discountBp: 0 });
    const zeroId = await paidOrder({ refCode: "ZEROOFF" });
    const discountedId = await paidOrder({ refCode: "PROJ10" });
    const receipt = async (orderId: string) => {
      const handoff = await env.DB.prepare("SELECT receipt_token FROM order_receipt_handoffs WHERE order_id = ?")
        .bind(orderId)
        .first<{ receipt_token: string }>();
      return readBuyerOrder(env.DB, SHOP, orderId, handoff?.receipt_token ?? "", Date.now());
    };
    const zero = await receipt(zeroId);
    expect(zero).toMatchObject({ totals: { discountCode: null, discountMinor: 0 } });
    expect(await receipt(discountedId)).toMatchObject({ totals: { discountCode: "PROJ10" } });
    const detail = await (await asAdmin("GET", `/v1/admin/orders/${zeroId}`)).json<{ order: { affiliate: { code: string }; totals: { discountCode: string | null } } }>();
    expect(detail.order.totals.discountCode).toBeNull();
    // The attribution itself is still shown, as the affiliate's.
    expect(detail.order.affiliate.code).toBe("ZEROOFF");
  });
});
