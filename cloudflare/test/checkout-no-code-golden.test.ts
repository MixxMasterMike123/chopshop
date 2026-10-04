import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import { createCheckoutPayment } from "../src/commerce/payment";
import { createMapping } from "../src/pod/pod-mappings";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import { acceptTermsStatement } from "./legal-fixtures";
import { FakeMoneyStripe } from "./money-fixtures";
import { adminOf, seedArtwork, seedPrinter, seedProduct, seedProfile, TEE_S } from "./pod-fixtures";

/**
 * CP8-DC hard rule: a cart WITHOUT a code is priced exactly as before the
 * unit. The same carts, through createCheckout and then the payment route,
 * must give byte-identical checkout rows, lines, production snapshot and
 * Connect charge to the figures the code at 414e1504 (before CP8-DC) gave.
 *
 * GOLDEN was produced by running this file, unchanged, against a copy of the
 * tree at 414e1504 (docs/cf-port/CP8_DC_REPORT.md, build log step 3); ids and
 * timestamps are left out because they are fresh per run.
 */

const TENANT = "tenant-dc-golden";
const HOST = "dc-golden.test";
const ADMIN = adminOf(TENANT);
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };

const CARTS: Array<[label: string, input: Omit<CreateCheckoutInput, "email" | "idempotencyKey">]> = [
  ["a mug, collected", { deliveryMethod: "pickup", discountCode: null, items: [{ productId: "golden-mug", quantity: 1 }], shippingCountry: null }],
  ["two mugs, shipped", { deliveryMethod: "shipping", discountCode: null, items: [{ productId: "golden-mug", quantity: 2 }], shippingCountry: "SE" }],
  ["a POD tee, shipped", { deliveryMethod: "shipping", discountCode: null, items: [{ productId: "golden-tee", quantity: 1 }], shippingCountry: "SE" }],
  [
    "a mug and two tees, collected",
    {
      deliveryMethod: "pickup",
      discountCode: null,
      items: [
        { productId: "golden-mug", quantity: 1 },
        { productId: "golden-tee", quantity: 2 },
      ],
      shippingCountry: null,
    },
  ],
];

const GOLDEN: string =
  "{\"a mug, collected\":{\"charge\":{\"amount\":20000,\"applicationFeeAmount\":1000,\"currency\":\"sek\",\"metadataKeys\":[\"checkout_id\",\"tenant_id\"],\"transferDestination\":\"acct_golden\"},\"items\":[{\"item_index\":0,\"product_id\":\"golden-mug\",\"variant_id\":null,\"sku\":\"SKU-golden-mug\",\"name\":\"Product golden-mug\",\"quantity\":1,\"unit_price_minor\":20000,\"line_total_minor\":20000}],\"paymentStatus\":\"ok\",\"response\":{\"currency\":\"SEK\",\"deliveryMethod\":\"pickup\",\"discountCode\":null,\"discountMinor\":0,\"items\":[{\"itemIndex\":0,\"lineTotalMinor\":20000,\"name\":\"Product golden-mug\",\"productId\":\"golden-mug\",\"quantity\":1,\"sku\":\"SKU-golden-mug\",\"unitPriceMinor\":20000,\"variantId\":null}],\"shippingCountry\":null,\"shippingMinor\":0,\"subtotalMinor\":20000,\"totalMinor\":20000,\"vatMinor\":4000,\"vatRateBp\":2500},\"row\":{\"status\":\"open\",\"currency\":\"SEK\",\"delivery_method\":\"pickup\",\"shipping_country\":null,\"subtotal_minor\":20000,\"shipping_minor\":0,\"vat_minor\":4000,\"vat_rate_bp\":2500,\"discount_minor\":0,\"discount_code_id\":null,\"total_minor\":20000,\"production_snapshot_json\":null,\"application_fee_minor\":1000,\"withheld_minor\":0,\"connect_account_id\":\"acct_golden\"}},\"two mugs, shipped\":{\"charge\":{\"amount\":42900,\"applicationFeeAmount\":2145,\"currency\":\"sek\",\"metadataKeys\":[\"checkout_id\",\"tenant_id\"],\"transferDestination\":\"acct_golden\"},\"items\":[{\"item_index\":0,\"product_id\":\"golden-mug\",\"variant_id\":null,\"sku\":\"SKU-golden-mug\",\"name\":\"Product golden-mug\",\"quantity\":2,\"unit_price_minor\":20000,\"line_total_minor\":40000}],\"paymentStatus\":\"ok\",\"response\":{\"currency\":\"SEK\",\"deliveryMethod\":\"shipping\",\"discountCode\":null,\"discountMinor\":0,\"items\":[{\"itemIndex\":0,\"lineTotalMinor\":40000,\"name\":\"Product golden-mug\",\"productId\":\"golden-mug\",\"quantity\":2,\"sku\":\"SKU-golden-mug\",\"unitPriceMinor\":20000,\"variantId\":null}],\"shippingCountry\":\"SE\",\"shippingMinor\":2900,\"subtotalMinor\":40000,\"totalMinor\":42900,\"vatMinor\":8580,\"vatRateBp\":2500},\"row\":{\"status\":\"open\",\"currency\":\"SEK\",\"delivery_method\":\"shipping\",\"shipping_country\":\"SE\",\"subtotal_minor\":40000,\"shipping_minor\":2900,\"vat_minor\":8580,\"vat_rate_bp\":2500,\"discount_minor\":0,\"discount_code_id\":null,\"total_minor\":42900,\"production_snapshot_json\":null,\"application_fee_minor\":2145,\"withheld_minor\":0,\"connect_account_id\":\"acct_golden\"}},\"a POD tee, shipped\":{\"charge\":{\"amount\":32800,\"applicationFeeAmount\":25265,\"currency\":\"sek\",\"metadataKeys\":[\"checkout_id\",\"tenant_id\"],\"transferDestination\":\"acct_golden\"},\"items\":[{\"item_index\":0,\"product_id\":\"golden-tee\",\"variant_id\":null,\"sku\":\"SKU-golden-tee\",\"name\":\"Product golden-tee\",\"quantity\":1,\"unit_price_minor\":29900,\"line_total_minor\":29900}],\"paymentStatus\":\"ok\",\"response\":{\"currency\":\"SEK\",\"deliveryMethod\":\"shipping\",\"discountCode\":null,\"discountMinor\":0,\"items\":[{\"itemIndex\":0,\"lineTotalMinor\":29900,\"name\":\"Product golden-tee\",\"productId\":\"golden-tee\",\"quantity\":1,\"sku\":\"SKU-golden-tee\",\"unitPriceMinor\":29900,\"variantId\":null}],\"shippingCountry\":\"SE\",\"shippingMinor\":2900,\"subtotalMinor\":29900,\"totalMinor\":32800,\"vatMinor\":6560,\"vatRateBp\":2500},\"row\":{\"status\":\"open\",\"currency\":\"SEK\",\"delivery_method\":\"shipping\",\"shipping_country\":\"SE\",\"subtotal_minor\":29900,\"shipping_minor\":2900,\"vat_minor\":6560,\"vat_rate_bp\":2500,\"discount_minor\":0,\"discount_code_id\":null,\"total_minor\":32800,\"production_snapshot_json\":\"{\\\"printer\\\":\\\"fake-printer\\\",\\\"lines\\\":[{\\\"lineNo\\\":1,\\\"sku\\\":\\\"2700003\\\",\\\"quantity\\\":1,\\\"printFiles\\\":[{\\\"slot\\\":\\\"front\\\",\\\"r2Key\\\":\\\"pod/tenant-dc-golden/print/golden-front.png\\\",\\\"sha256\\\":\\\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\\",\\\"widthMm\\\":299,\\\"heightMm\\\":399,\\\"frameMm\\\":{\\\"w\\\":300,\\\"h\\\":400,\\\"offsetTopMm\\\":30},\\\"frameProvisional\\\":false,\\\"sourcePx\\\":{\\\"w\\\":3543,\\\"h\\\":4724}}],\\\"productionCostMinor\\\":14000,\\\"withholdMinor\\\":17500}],\\\"totals\\\":{\\\"productionCostMinor\\\":18900,\\\"withholdMinor\\\":23625}}\",\"application_fee_minor\":25265,\"withheld_minor\":23625,\"connect_account_id\":\"acct_golden\"}},\"a mug and two tees, collected\":{\"charge\":{\"amount\":79800,\"applicationFeeAmount\":45115,\"currency\":\"sek\",\"metadataKeys\":[\"checkout_id\",\"tenant_id\"],\"transferDestination\":\"acct_golden\"},\"items\":[{\"item_index\":0,\"product_id\":\"golden-mug\",\"variant_id\":null,\"sku\":\"SKU-golden-mug\",\"name\":\"Product golden-mug\",\"quantity\":1,\"unit_price_minor\":20000,\"line_total_minor\":20000},{\"item_index\":1,\"product_id\":\"golden-tee\",\"variant_id\":null,\"sku\":\"SKU-golden-tee\",\"name\":\"Product golden-tee\",\"quantity\":2,\"unit_price_minor\":29900,\"line_total_minor\":59800}],\"paymentStatus\":\"ok\",\"response\":{\"currency\":\"SEK\",\"deliveryMethod\":\"pickup\",\"discountCode\":null,\"discountMinor\":0,\"items\":[{\"itemIndex\":0,\"lineTotalMinor\":20000,\"name\":\"Product golden-mug\",\"productId\":\"golden-mug\",\"quantity\":1,\"sku\":\"SKU-golden-mug\",\"unitPriceMinor\":20000,\"variantId\":null},{\"itemIndex\":1,\"lineTotalMinor\":59800,\"name\":\"Product golden-tee\",\"productId\":\"golden-tee\",\"quantity\":2,\"sku\":\"SKU-golden-tee\",\"unitPriceMinor\":29900,\"variantId\":null}],\"shippingCountry\":null,\"shippingMinor\":0,\"subtotalMinor\":79800,\"totalMinor\":79800,\"vatMinor\":15960,\"vatRateBp\":2500},\"row\":{\"status\":\"open\",\"currency\":\"SEK\",\"delivery_method\":\"pickup\",\"shipping_country\":null,\"subtotal_minor\":79800,\"shipping_minor\":0,\"vat_minor\":15960,\"vat_rate_bp\":2500,\"discount_minor\":0,\"discount_code_id\":null,\"total_minor\":79800,\"production_snapshot_json\":\"{\\\"printer\\\":\\\"fake-printer\\\",\\\"lines\\\":[{\\\"lineNo\\\":2,\\\"sku\\\":\\\"2700003\\\",\\\"quantity\\\":2,\\\"printFiles\\\":[{\\\"slot\\\":\\\"front\\\",\\\"r2Key\\\":\\\"pod/tenant-dc-golden/print/golden-front.png\\\",\\\"sha256\\\":\\\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\\",\\\"widthMm\\\":299,\\\"heightMm\\\":399,\\\"frameMm\\\":{\\\"w\\\":300,\\\"h\\\":400,\\\"offsetTopMm\\\":30},\\\"frameProvisional\\\":false,\\\"sourcePx\\\":{\\\"w\\\":3543,\\\"h\\\":4724}}],\\\"productionCostMinor\\\":28000,\\\"withholdMinor\\\":35000}],\\\"totals\\\":{\\\"productionCostMinor\\\":32900,\\\"withholdMinor\\\":41125}}\",\"application_fee_minor\":45115,\"withheld_minor\":41125,\"connect_account_id\":\"acct_golden\"}}}";

beforeAll(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at, stripe_account_id,
        stripe_charges_enabled, stripe_payouts_enabled, commission_bps
      ) VALUES (?, 'active', 'Golden Shop', 'ops@golden.test', 'sv-SE', 'SEK', ?, ?, 'acct_golden', 1, 1, NULL)`,
    ).bind(TENANT, now, now),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${TENANT}`, TENANT, HOST, now, now),
    acceptTermsStatement(env.DB, TENANT),
  ]);
  await seedProfile();
  await seedPrinter();
  await seedArtwork(TENANT, { artworkId: "golden-front" });
  // Past D8's first-N (test/screening.test.ts owns that rule).
  await seedProduct(TENANT, { productId: "golden-live-1", published: true });
  await seedProduct(TENANT, { productId: "golden-live-2", published: true });
  await seedProduct(TENANT, { productId: "golden-mug", priceMinor: 20_000, published: true });
  await seedProduct(TENANT, { productId: "golden-tee", priceMinor: 29_900 });
  const mapped = await createMapping(env.DB, ADMIN, {
    artworkId: "golden-front",
    printerId: "fake-printer",
    productId: "golden-tee",
    sku: TEE_S,
    slots: ["front"],
    variantId: null,
  }, Date.now());
  expect(mapped.status).toBe("ok");
  expect((await publishAdminProduct(env.DB, ADMIN, "golden-tee", Date.now())).status).toBe("ok");
  // Both may be collected (0009's default is shipping only).
  await env.DB.prepare("UPDATE products SET allow_pickup = 1 WHERE tenant_id = ?").bind(TENANT).run();
});

async function frozenFacts(index: number, input: Omit<CreateCheckoutInput, "email" | "idempotencyKey">) {
  const result = await createCheckout(
    env.DB,
    CONTEXT,
    { ...input, email: `golden-${index}@buyer.test`, idempotencyKey: `golden-key-${index}-${crypto.randomUUID()}` },
    Date.now(),
    { dispatchTarget: "fake-printer" },
  );
  if (result.status !== "ok") {
    throw new Error(`checkout ${index}: ${result.status}`);
  }
  const { checkoutId, expiresAt: _expiresAt, ...response } = result.checkout;
  const stripe = new FakeMoneyStripe();
  const payment = await createCheckoutPayment(env.DB, stripe, CONTEXT, checkoutId, Date.now());
  const row = await env.DB.prepare(
    `SELECT status, currency, delivery_method, shipping_country, subtotal_minor,
            shipping_minor, vat_minor, vat_rate_bp, discount_minor, discount_code_id,
            total_minor, production_snapshot_json, application_fee_minor,
            withheld_minor, connect_account_id
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first();
  const items = await env.DB.prepare(
    `SELECT item_index, product_id, variant_id, sku, name, quantity,
            unit_price_minor, line_total_minor
     FROM checkout_items WHERE checkout_id = ? ORDER BY item_index`,
  )
    .bind(checkoutId)
    .all();
  const call = stripe.createCalls[0];
  return {
    charge:
      call === undefined
        ? null
        : {
            amount: call.amount,
            applicationFeeAmount: call.applicationFeeAmount,
            currency: call.currency,
            metadataKeys: Object.keys(call.metadata).sort(),
            transferDestination: call.transferDestination,
          },
    items: items.results,
    paymentStatus: payment.status,
    response,
    row,
  };
}

describe("CP8-DC: a cart without a code is frozen and charged exactly as before", () => {
  it("gives the pre-unit rows, lines, snapshot and Connect charge, byte for byte", async () => {
    const facts: Record<string, unknown> = {};
    for (const [index, [label, input]] of CARTS.entries()) {
      facts[label] = await frozenFacts(index, input);
    }
    const actual = JSON.stringify(facts);
    expect(actual).toBe(GOLDEN);
  });

  it("writes no discount hold for a cart without a code", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'discount_code_holds'").first<{ n: number }>();
    if (before?.n === 1) {
      const holds = await env.DB.prepare("SELECT COUNT(*) AS n FROM discount_code_holds WHERE tenant_id = ?").bind(TENANT).first<{ n: number }>();
      expect(holds?.n).toBe(0);
    }
  });
});
