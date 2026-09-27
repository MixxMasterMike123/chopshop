import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import {
  buildConnectCharge,
  computeCommissionMinor,
  CONNECT_ON_BEHALF_OF,
  DEFAULT_COMMISSION_BPS,
  readWithholdMinor,
  resolveCommissionBps,
  statementDescriptorSuffix,
} from "../src/commerce/payment";
import {
  FakeMoneyStripe,
  moneyEnv,
  next,
  seedCheckout,
  seedTenant,
  snapshotJson,
} from "./money-fixtures";

/**
 * PLAN §2.3 bullet 1: every PaymentIntent is a Connect destination charge —
 * transfer to the shop's account, application fee = commission + the frozen
 * production withholding (LAUNCH_TODO A1), statement suffix = the shop name —
 * and a shop without a usable connected account cannot take a payment at all.
 *
 * The pure formulas are pinned against Firebase's
 * (functions/src/payment/connectFee.ts, connectParams.ts,
 * createPaymentIntent.ts:555-569) case by case.
 */

let stripe: FakeMoneyStripe;
let ipCounter = 0;

beforeEach(() => {
  stripe = new FakeMoneyStripe();
});

async function pay(hostname: string, checkoutId: string, envOverride?: Env): Promise<Response> {
  ipCounter += 1;
  return worker.fetch(
    new Request(`https://${hostname}/v1/checkout/${checkoutId}/payment`, {
      headers: { "cf-connecting-ip": `198.51.100.${ipCounter % 250}` },
      method: "POST",
    }),
    envOverride ?? moneyEnv(stripe),
  );
}

async function frozenFacts(checkoutId: string) {
  return env.DB.prepare(
    `SELECT connect_account_id, application_fee_minor, withheld_minor,
            payment_intent_status, payment_intent_status_at
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<{
      application_fee_minor: number | null;
      connect_account_id: string | null;
      payment_intent_status: string | null;
      payment_intent_status_at: number | null;
      withheld_minor: number | null;
    }>();
}

async function shop(options: Parameters<typeof seedTenant>[1] = {}) {
  const tenantId = next("tenant-pc").toLowerCase().replace(/_/g, "-");
  const hostname = `${tenantId}.pay.test`;
  const accountId = await seedTenant(tenantId, { hostname, ...options });
  return { accountId, hostname, tenantId };
}

describe("the Firebase fee formulas, ported", () => {
  it("floors the commission to the öre, in basis points", () => {
    // connectFee.computeApplicationFeeOre
    expect(computeCommissionMinor(23_710, 500)).toBe(1_185); // 1185.5 → floor
    expect(computeCommissionMinor(19_900, 500)).toBe(995);
    expect(computeCommissionMinor(1, 500)).toBe(0);
    expect(computeCommissionMinor(10_000, 10_000)).toBe(10_000);
    expect(computeCommissionMinor(10_000, 12_000)).toBe(10_000); // clamped bps
    expect(computeCommissionMinor(10_000, -5)).toBe(0);
    expect(computeCommissionMinor(0, 500)).toBe(0);
    expect(computeCommissionMinor(-100, 500)).toBe(0);
    expect(computeCommissionMinor(10_000, Number.NaN)).toBe(0);
    expect(computeCommissionMinor(10_000, 333.9)).toBe(333); // bps floored first
  });

  it("resolves a per-shop commission over the 5 % platform default", () => {
    // connectFee.resolveCommissionBps
    expect(DEFAULT_COMMISSION_BPS).toBe(500);
    expect(resolveCommissionBps(null)).toBe(500);
    expect(resolveCommissionBps(undefined)).toBe(500);
    expect(resolveCommissionBps(250)).toBe(250);
    expect(resolveCommissionBps(0)).toBe(0);
    expect(resolveCommissionBps(20_000)).toBe(10_000);
    expect(resolveCommissionBps(-1)).toBe(0);
    expect(resolveCommissionBps(2.5)).toBe(500); // not an integer ⇒ default
  });

  it("adds the withholding to the commission and refuses a fee above the gross", () => {
    // connectParams.buildConnectChargeParams
    expect(buildConnectCharge(20_000, 500, 12_300)).toEqual({
      applicationFeeMinor: 13_300,
      commissionMinor: 1_000,
      feeExceedsGross: false,
      withheldMinor: 12_300,
    });
    expect(buildConnectCharge(20_000, 500, 0).applicationFeeMinor).toBe(1_000);
    // Equal to the gross is allowed (the shop nets 0); one öre more is not.
    expect(buildConnectCharge(20_000, 500, 19_000).feeExceedsGross).toBe(false);
    expect(buildConnectCharge(20_000, 500, 19_001).feeExceedsGross).toBe(true);
    expect(buildConnectCharge(20_000, 500, 19_000.5).withheldMinor).toBe(0);
    expect(buildConnectCharge(20_000, 500, -5).withheldMinor).toBe(0);
  });

  it("sanitises the statement suffix exactly as production does", () => {
    // createPaymentIntent.ts:555-569
    expect(statementDescriptorSuffix("Melodie MC")).toBe("MELODIE MC");
    expect(statementDescriptorSuffix("Sillmans Åkeri & Söner")).toBe("SILLMANS AKE");
    expect(statementDescriptorSuffix("  Göta   <Kanal> 'Butik' ")).toBe("GOTA KANAL B");
    expect(statementDescriptorSuffix("1234 5678")).toBeNull(); // no letter
    expect(statementDescriptorSuffix("***")).toBeNull();
    expect(statementDescriptorSuffix("ab")).toBe("AB");
  });

  it("reads the withholding from the frozen snapshot, failing closed on anything else", () => {
    expect(readWithholdMinor(null)).toBe(0);
    expect(
      readWithholdMinor(
        snapshotJson([
          { lineNo: 1, productionCostMinor: 9_840, quantity: 1, sku: "S1", withholdMinor: 12_300 },
        ]),
      ),
    ).toBe(12_300);
    expect(readWithholdMinor("{}")).toBeNull();
    expect(readWithholdMinor('{"totals":{}}')).toBeNull();
    expect(readWithholdMinor('{"totals":{"withholdMinor":1.5}}')).toBeNull();
    expect(readWithholdMinor('{"totals":{"withholdMinor":-1}}')).toBeNull();
    expect(readWithholdMinor('{"totals":{"withholdMinor":"100"}}')).toBeNull();
    expect(readWithholdMinor("[1]")).toBeNull();
    expect(readWithholdMinor("not json")).toBeNull();
  });

  it("keeps the platform the merchant of record (no on_behalf_of)", () => {
    expect(CONNECT_ON_BEHALF_OF).toBe(false);
  });
});

describe("the destination charge", () => {
  it("transfers to the shop, takes the commission, and freezes the facts", async () => {
    const { accountId, hostname, tenantId } = await shop({ shopName: "Melodie MC" });
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 19_900 });

    const response = await pay(hostname, checkout.checkoutId);

    expect(response.status).toBe(201);
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.createCalls[0]).toMatchObject({
      amount: 19_900,
      applicationFeeAmount: 995,
      onBehalfOf: null,
      statementDescriptorSuffix: "MELODIE MC",
      transferDestination: accountId,
    });
    await expect(frozenFacts(checkout.checkoutId)).resolves.toMatchObject({
      application_fee_minor: 995,
      connect_account_id: accountId,
      payment_intent_status: "requires_payment_method",
      withheld_minor: 0,
    });
  });

  it("adds the production withholding from the POD snapshot into the fee", async () => {
    const { accountId, hostname, tenantId } = await shop();
    const checkout = await seedCheckout({
      paymentIntentId: null,
      snapshot: snapshotJson([
        { lineNo: 1, productionCostMinor: 9_840, quantity: 1, sku: "2500170", withholdMinor: 12_300 },
      ]),
      tenantId,
      unitPriceMinor: 29_900,
    });

    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);

    // 5 % of 29 900 = 1 495, plus 12 300 withheld.
    expect(stripe.createCalls[0]?.applicationFeeAmount).toBe(13_795);
    expect(stripe.createCalls[0]?.transferDestination).toBe(accountId);
    await expect(frozenFacts(checkout.checkoutId)).resolves.toMatchObject({
      application_fee_minor: 13_795,
      withheld_minor: 12_300,
    });
  });

  it("uses the shop's own commission when it has one", async () => {
    const { hostname, tenantId } = await shop({ commissionBps: 250 });
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId, unitPriceMinor: 20_000 });

    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);
    expect(stripe.createCalls[0]?.applicationFeeAmount).toBe(500);
  });

  it("omits the statement suffix when the shop name leaves no letter", async () => {
    const { hostname, tenantId } = await shop({ shopName: "1234" });
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId });

    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);
    expect(stripe.createCalls[0]?.statementDescriptorSuffix).toBeNull();
  });

  it("never puts the fee's breakdown in Stripe metadata", async () => {
    const { hostname, tenantId } = await shop();
    const checkout = await seedCheckout({
      paymentIntentId: null,
      snapshot: snapshotJson([
        { lineNo: 1, productionCostMinor: 5_000, quantity: 1, sku: "S", withholdMinor: 6_250 },
      ]),
      tenantId,
    });

    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);
    expect(Object.keys(stripe.createCalls[0]?.metadata ?? {}).sort()).toEqual([
      "checkout_id",
      "tenant_id",
    ]);
  });
});

describe("failing closed before Stripe", () => {
  it.each([
    ["has no connected account", { connect: false }],
    ["has an account whose charges are disabled", { chargesEnabled: false }],
  ])("404s a shop that %s, without touching Stripe", async (_label, options) => {
    const { hostname, tenantId } = await shop(options);
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId });

    const response = await pay(hostname, checkout.checkoutId);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Checkout not found" },
    });
    expect(stripe.createCalls).toHaveLength(0);
    await expect(frozenFacts(checkout.checkoutId)).resolves.toMatchObject({
      application_fee_minor: null,
      connect_account_id: null,
    });
  });

  it("stops re-serving an existing intent once the shop's charges are disabled", async () => {
    const { hostname, tenantId } = await shop();
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId });
    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);

    await env.DB.prepare("UPDATE tenants SET stripe_charges_enabled = 0 WHERE tenant_id = ?")
      .bind(tenantId)
      .run();

    expect((await pay(hostname, checkout.checkoutId)).status).toBe(404);
  });

  it("refuses a checkout whose fee would exceed the charge (priced below the floor)", async () => {
    const { hostname, tenantId } = await shop();
    const checkout = await seedCheckout({
      paymentIntentId: null,
      snapshot: snapshotJson([
        { lineNo: 1, productionCostMinor: 15_000, quantity: 1, sku: "S", withholdMinor: 19_500 },
      ]),
      tenantId,
      unitPriceMinor: 20_000,
    });

    const response = await pay(hostname, checkout.checkoutId);

    // 1 000 commission + 19 500 withheld > 20 000: never clamped.
    expect(response.status).toBe(404);
    expect(stripe.createCalls).toHaveLength(0);
  });

  it("refuses a snapshot whose withholding cannot be read", async () => {
    const { hostname, tenantId } = await shop();
    const checkout = await seedCheckout({
      paymentIntentId: null,
      snapshot: JSON.stringify({ lines: [], printer: "fake-printer" }),
      tenantId,
    });

    expect((await pay(hostname, checkout.checkoutId)).status).toBe(404);
    expect(stripe.createCalls).toHaveLength(0);
  });
});

describe("schema: the frozen Connect facts", () => {
  it("cannot be rewritten once attached", async () => {
    const { hostname, tenantId } = await shop();
    const checkout = await seedCheckout({ paymentIntentId: null, tenantId });
    expect((await pay(hostname, checkout.checkoutId)).status).toBe(201);

    await expect(
      env.DB.prepare("UPDATE checkouts SET application_fee_minor = 1 WHERE checkout_id = ?")
        .bind(checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/frozen/);
    await expect(
      env.DB.prepare("UPDATE checkouts SET connect_account_id = 'acct_other' WHERE checkout_id = ?")
        .bind(checkout.checkoutId)
        .run(),
    ).rejects.toThrow(/frozen/);
  });

  it("refuses a capability flag without an account", async () => {
    const tenantId = next("tenant-flag").toLowerCase().replace(/_/g, "-");
    await seedTenant(tenantId, { connect: false });

    await expect(
      env.DB.prepare("UPDATE tenants SET stripe_charges_enabled = 1 WHERE tenant_id = ?")
        .bind(tenantId)
        .run(),
    ).rejects.toThrow(/require a stripe account/);
  });

  it("binds one connected account to one shop", async () => {
    const first = await shop();
    const tenantId = next("tenant-dup").toLowerCase().replace(/_/g, "-");
    await seedTenant(tenantId, { connect: false });

    await expect(
      env.DB.prepare("UPDATE tenants SET stripe_account_id = ? WHERE tenant_id = ?")
        .bind(first.accountId, tenantId)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
