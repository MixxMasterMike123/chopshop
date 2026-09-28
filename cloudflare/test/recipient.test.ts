import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createCheckout } from "../src/commerce/checkout";
import { readOrderRecipient } from "../src/commerce/recipient";
import {
  activateProduct,
  adminCall,
  approveProduct,
  bootstrapPlatform,
  claimReceipt,
  createPodProduct,
  createTenant,
  deliverOutbox,
  expectJson,
  outboxRowsFor,
  payCheckout,
  platformCall,
  printerWire,
  publishProduct,
  readBuyerOrder,
  renderReadyArtwork,
  seedPrintShop,
  SLICE_PICKUP_LOCATION,
  SliceWorld,
  storefrontCall,
  succeedPayment,
  type Tenant,
  unique,
} from "./slice-harness";

/**
 * CP4-R (D98): the recipient of an order, end to end through the real routes —
 * POST /v1/checkout → frozen with the checkout → copied to the order by the
 * payment provider's confirmation → the buyer's, the seller's and the
 * platform's order reads → the printer's job. Invented data only.
 */

const PRICE_MINOR = 25_000;

/** Distinctive values: the log / audit / alert / outbox scan searches for them. */
const SHIPPED = {
  addressLine1: "Ovanliga Gränd 77",
  addressLine2: "Lgh 1203",
  city: "Sökbyn",
  country: "SE",
  name: "Ragnhild Adressdotter",
  phone: "+46 (70) 123-45 67",
  postalCode: "999 88",
};
const PII_NEEDLES = ["Ragnhild", "Adressdotter", "Ovanliga", "Lgh 1203", "Sökbyn", "999 88", "123-45 67"];

const DATED_PLACE = {
  address: "Hämtvägen 3, 111 22 Hämtby",
  dates: ["2026-10-01", "2026-10-02"],
  hours: "10–16",
  id: "dated-place",
  name: "Lördagsutlämningen",
};

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let plainA = "";
let plainB = "";
let podA = "";

async function sellable(tenant: Tenant, sku: string): Promise<string> {
  const created = await expectJson<{ product: { productId: string } }>(
    await adminCall(world, tenant, "POST", "/v1/admin/products", {
      allowPickup: true,
      allowShipping: true,
      currency: "SEK",
      name: `Mottagartröja ${sku}`,
      priceMinor: PRICE_MINOR,
      sku,
    }),
    201,
    "create product",
  );
  const productId = created.product.productId;
  await activateProduct(world, tenant, productId);
  await publishProduct(world, tenant, productId);
  await approveProduct(world, productId);
  return productId;
}

async function setPlaces(tenant: Tenant, places: unknown[]): Promise<void> {
  await expectJson(
    await adminCall(world, tenant, "PUT", "/v1/admin/settings", { storeIdentity: { pickupLocations: places } }),
    200,
    "pickup places",
  );
}

beforeAll(async () => {
  world = new SliceWorld();
  await bootstrapPlatform(world);
  shopA = await createTenant(world, { host: "a.recipient.test", shopName: "Mottagare A", tenantId: "rcp-a" });
  shopB = await createTenant(world, { host: "b.recipient.test", shopName: "Mottagare B", tenantId: "rcp-b" });
  await setPlaces(shopA, [SLICE_PICKUP_LOCATION, DATED_PLACE]);
  plainA = await sellable(shopA, "RCP-A-1");
  plainB = await sellable(shopB, "RCP-B-1");

  await seedPrintShop(world);
  const artworkId = await renderReadyArtwork(world, shopA, 7);
  const pod = await createPodProduct(world, shopA, {
    artworkId,
    name: "Mottagar-POD",
    priceMinor: 39_900,
    sku: "RCP-POD-1",
  });
  podA = pod.productId;
  await publishProduct(world, shopA, podA);
  await approveProduct(world, podA);
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

function shippedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    consent: { terms: true },
    deliveryMethod: "shipping",
    email: `${unique("buyer")}@buyers.recipient.test`,
    idempotencyKey: unique("idem-rcp"),
    items: [{ productId: plainA, quantity: 1 }],
    recipient: SHIPPED,
    shippingCountry: "SE",
    ...overrides,
  };
}

function pickupBody(recipient: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    consent: { terms: true },
    deliveryMethod: "pickup",
    email: `${unique("buyer")}@buyers.recipient.test`,
    idempotencyKey: unique("idem-rcp"),
    items: [{ productId: plainA, quantity: 1 }],
    recipient,
    ...overrides,
  };
}

function postCheckout(tenant: Tenant, body: unknown): Promise<Response> {
  return storefrontCall(world, tenant, "POST", "/v1/checkout", { body, origin: null });
}

async function checkoutCount(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function expectRefused(tenant: Tenant, body: unknown, label: string): Promise<void> {
  const before = await checkoutCount(tenant.tenantId);
  const response = await postCheckout(tenant, body);
  expect(await expectJson(response, 400, label), label).toEqual({
    error: { code: "invalid_request", message: "Request is not valid" },
  });
  expect(await checkoutCount(tenant.tenantId), `${label}: nothing written`).toBe(before);
}

/** Checkout → PaymentIntent → the signed success webhook: the order id. */
async function buy(tenant: Tenant, body: Record<string, unknown>): Promise<{ checkoutId: string; orderId: string }> {
  const checkout = (
    await expectJson<{ checkout: { checkoutId: string; totalMinor: number } }>(
      await postCheckout(tenant, body),
      201,
      "checkout",
    )
  ).checkout;
  const paymentIntentId = await payCheckout(world, tenant, checkout.checkoutId);
  const { orderId } = await succeedPayment(world, tenant, {
    checkoutId: checkout.checkoutId,
    paymentIntentId,
    totalMinor: checkout.totalMinor,
  });
  expect(orderId).not.toBeNull();
  return { checkoutId: checkout.checkoutId, orderId: orderId as string };
}

async function buyerRead(tenant: Tenant, checkoutId: string, orderId: string) {
  const claimed = await expectJson<{ receipt: { receiptToken: string } }>(
    await claimReceipt(world, tenant, checkoutId),
    200,
    "receipt",
  );
  return expectJson<{ order: { recipient: unknown } }>(
    await readBuyerOrder(world, tenant, orderId, claimed.receipt.receiptToken),
    200,
    "buyer read",
  );
}

async function sellerRead(tenant: Tenant, orderId: string) {
  return expectJson<{ order: { recipient: unknown } }>(
    await adminCall(world, tenant, "GET", `/v1/admin/orders/${orderId}`),
    200,
    "seller read",
  );
}

async function platformRead(tenantId: string, orderId: string) {
  const body = await expectJson<{ orders: Array<{ orderId: string; recipient: unknown }> }>(
    await platformCall(world, "GET", `/v1/platform/orders?tenantId=${tenantId}&limit=100`),
    200,
    "platform read",
  );
  return body.orders.find((order) => order.orderId === orderId);
}

const SHIPPED_VIEW = {
  ...SHIPPED,
  deliveryMethod: "shipping",
  pickupDate: null,
  pickupLocationAddress: null,
  pickupLocationId: null,
  pickupLocationName: null,
};

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /v1/checkout refuses a checkout without a valid recipient (400 invalid_request)", () => {
  const long = (n: number) => "x".repeat(n);

  it.each<[string, (base: typeof SHIPPED) => unknown]>([
    ["no recipient", () => undefined],
    ["a recipient that is not an object", () => "Ragnhild"],
    ["a recipient that is an array", () => [SHIPPED]],
    ["an unknown key", (base) => ({ ...base, company: "AB" })],
    ["a pickup key on a parcel", (base) => ({ ...base, pickupLocationId: SLICE_PICKUP_LOCATION.id })],
    ["no name", ({ name: _name, ...rest }) => rest],
    ["a name of spaces only", (base) => ({ ...base, name: "   " })],
    ["a name of 101 characters", (base) => ({ ...base, name: long(101) })],
    ["a name that is not a string", (base) => ({ ...base, name: 42 })],
    ["a line break in the name", (base) => ({ ...base, name: "Ragnhild\nAdressdotter" })],
    ["a trailing line break in the name", (base) => ({ ...base, name: "Ragnhild\n" })],
    ["a carriage return in the name", (base) => ({ ...base, name: "Ragnhild\rA" })],
    ["a C0 control character", (base) => ({ ...base, name: "Ragn\u0007hild" })],
    ["a DEL", (base) => ({ ...base, name: "Ragn\u007fhild" })],
    ["a C1 control character", (base) => ({ ...base, name: "Ragn\u0085hild" })],
    ["a Unicode line separator", (base) => ({ ...base, name: "Ragn\u2028hild" })],
    ["no street address", ({ addressLine1: _line, ...rest }) => rest],
    ["an empty street address", (base) => ({ ...base, addressLine1: "" })],
    ["a street address of 101 characters", (base) => ({ ...base, addressLine1: long(101) })],
    ["an empty second address line", (base) => ({ ...base, addressLine2: " " })],
    ["a second address line of 101 characters", (base) => ({ ...base, addressLine2: long(101) })],
    ["a control character in the second address line", (base) => ({ ...base, addressLine2: "a\tb" })],
    ["no postal code", ({ postalCode: _code, ...rest }) => rest],
    ["a postal code of 17 characters", (base) => ({ ...base, postalCode: long(17) })],
    ["no city", ({ city: _city, ...rest }) => rest],
    ["a city of 101 characters", (base) => ({ ...base, city: long(101) })],
    ["no country", ({ country: _country, ...rest }) => rest],
    ["a lower-case country", (base) => ({ ...base, country: "se" })],
    ["a three-letter country", (base) => ({ ...base, country: "SWE" })],
    ["a country other than the shipping country", (base) => ({ ...base, country: "NO" })],
    ["a telephone number with a letter", (base) => ({ ...base, phone: "070-ABC" })],
    ["a telephone number of 31 characters", (base) => ({ ...base, phone: "1".repeat(31) })],
    ["a telephone number that is not a string", (base) => ({ ...base, phone: 46701234567 })],
  ])("a parcel with %s", async (label, recipient) => {
    await expectRefused(shopA, shippedBody({ recipient: recipient(SHIPPED) }), label);
  });

  it.each<[string, unknown]>([
    ["no pickup place", { name: "Hämtar Hansson" }],
    ["an address key on a pickup", { addressLine1: "Gatan 1", name: "Hämtar Hansson", pickupLocationId: SLICE_PICKUP_LOCATION.id }],
    ["a pickup place that is not a string", { name: "Hämtar Hansson", pickupLocationId: 7 }],
    ["a pickup place the shop does not have", { name: "Hämtar Hansson", pickupLocationId: "no-such-place" }],
    ["a date for a place that offers none", { name: "Hämtar Hansson", pickupDate: "2026-10-01", pickupLocationId: SLICE_PICKUP_LOCATION.id }],
    ["no date for a place that offers dates", { name: "Hämtar Hansson", pickupLocationId: DATED_PLACE.id }],
    ["a date that is not one of the place's", { name: "Hämtar Hansson", pickupDate: "2026-10-03", pickupLocationId: DATED_PLACE.id }],
    ["a date that is not a date", { name: "Hämtar Hansson", pickupDate: "1 oktober", pickupLocationId: DATED_PLACE.id }],
    ["a date that does not exist", { name: "Hämtar Hansson", pickupDate: "2026-02-30", pickupLocationId: DATED_PLACE.id }],
    ["no name", { pickupLocationId: SLICE_PICKUP_LOCATION.id }],
  ])("a pickup with %s", async (label, recipient) => {
    await expectRefused(shopA, pickupBody(recipient), label);
  });

  it("a pickup place of ANOTHER shop is not this shop's", async () => {
    await expectRefused(
      shopB,
      pickupBody(
        { name: "Hämtar Hansson", pickupDate: "2026-10-01", pickupLocationId: DATED_PLACE.id },
        { items: [{ productId: plainB, quantity: 1 }] },
      ),
      "shop A's place at shop B",
    );
  });

  it("the texts are trimmed; an empty telephone number is none; the request is otherwise stored as given", async () => {
    const response = await postCheckout(
      shopA,
      shippedBody({
        recipient: { ...SHIPPED, city: "  Sökbyn ", name: " Ragnhild Adressdotter ", phone: "" },
      }),
    );
    const { checkout } = await expectJson<{ checkout: { checkoutId: string } }>(response, 201, "trimmed");
    expect(
      await env.DB.prepare("SELECT name, city, phone, address_line2 FROM checkout_recipients WHERE checkout_id = ?")
        .bind(checkout.checkoutId)
        .first(),
    ).toEqual({ address_line2: "Lgh 1203", city: "Sökbyn", name: "Ragnhild Adressdotter", phone: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the recipient is part of what the idempotency key stands for", () => {
  it("the same key and recipient replays; the same key with another recipient is 409", async () => {
    const body = shippedBody();
    const first = await expectJson<{ checkout: { checkoutId: string } }>(await postCheckout(shopA, body), 201, "first");
    const replay = await expectJson<{ checkout: { checkoutId: string } }>(await postCheckout(shopA, body), 200, "replay");
    expect(replay.checkout.checkoutId).toBe(first.checkout.checkoutId);

    for (const recipient of [
      { ...SHIPPED, name: "Någon Annan" },
      { ...SHIPPED, addressLine2: undefined },
      { ...SHIPPED, phone: "+46 70 000 00 00" },
    ]) {
      const conflict = await postCheckout(shopA, { ...body, recipient });
      expect(await expectJson(conflict, 409, "another recipient")).toEqual({
        error: { code: "conflict", message: "Idempotency key was already used for a different request" },
      });
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM checkout_recipients WHERE checkout_id = ?")
        .bind(first.checkout.checkoutId)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it("a pickup place renamed between two attempts under one key is 409, as a renamed product is", async () => {
    const shop = await createTenant(world, { host: "c.recipient.test", shopName: "Mottagare C", tenantId: "rcp-c" });
    const product = await sellable(shop, "RCP-C-1");
    const body = pickupBody(
      { name: "Hämtar Hansson", pickupLocationId: SLICE_PICKUP_LOCATION.id },
      { items: [{ productId: product, quantity: 1 }] },
    );
    await expectJson(await postCheckout(shop, body), 201, "first");
    await setPlaces(shop, [{ ...SLICE_PICKUP_LOCATION, name: "Nytt namn" }]);
    expect((await postCheckout(shop, body)).status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the recipient, copied to the order and read three ways", () => {
  it("a shipped order: the buyer (receipt token), the seller and the platform read the recipient", async () => {
    const { checkoutId, orderId } = await buy(shopA, shippedBody());

    expect(
      await env.DB.prepare("SELECT tenant_id, delivery_method, name, country FROM order_recipients WHERE order_id = ?")
        .bind(orderId)
        .first(),
    ).toEqual({ country: "SE", delivery_method: "shipping", name: SHIPPED.name, tenant_id: shopA.tenantId });

    expect((await buyerRead(shopA, checkoutId, orderId)).order.recipient).toEqual(SHIPPED_VIEW);
    expect((await sellerRead(shopA, orderId)).order.recipient).toEqual(SHIPPED_VIEW);
    expect((await platformRead(shopA.tenantId, orderId))?.recipient).toEqual(SHIPPED_VIEW);
  });

  it("a collected order keeps the place's name and address as they were when the checkout was made", async () => {
    const { checkoutId, orderId } = await buy(
      shopA,
      pickupBody({ name: "Hämtar Hansson", pickupDate: "2026-10-02", pickupLocationId: DATED_PLACE.id }),
    );
    // The shop renames and moves the place afterwards.
    await setPlaces(shopA, [SLICE_PICKUP_LOCATION, { ...DATED_PLACE, address: "Ny adress 9", name: "Nytt namn" }]);

    const expected = {
      addressLine1: null,
      addressLine2: null,
      city: null,
      country: null,
      deliveryMethod: "pickup",
      name: "Hämtar Hansson",
      phone: null,
      pickupDate: "2026-10-02",
      pickupLocationAddress: DATED_PLACE.address,
      pickupLocationId: DATED_PLACE.id,
      pickupLocationName: DATED_PLACE.name,
      postalCode: null,
    };
    expect((await buyerRead(shopA, checkoutId, orderId)).order.recipient).toEqual(expected);
    expect((await sellerRead(shopA, orderId)).order.recipient).toEqual(expected);
    expect((await platformRead(shopA.tenantId, orderId))?.recipient).toEqual(expected);
    await setPlaces(shopA, [SLICE_PICKUP_LOCATION, DATED_PLACE]);
  });

  it("an order whose checkout has no recipient row (as before 0045) is created, and read with recipient null", async () => {
    // The engine-level caller freezes no recipient; the HTTP route cannot.
    const created = await createCheckout(
      env.DB,
      { domainKind: "storefront", hostname: shopA.host, tenantId: shopA.tenantId },
      {
        consent: { disclosureVersion: null, marketing: false, terms: true, withdrawalWaiver: false },
        deliveryMethod: "pickup",
        discountCode: null,
        email: `${unique("old")}@buyers.recipient.test`,
        idempotencyKey: unique("idem-old"),
        items: [{ productId: plainA, quantity: 1 }],
        shippingCountry: null,
      },
      Date.now(),
    );
    expect(created.status).toBe("ok");
    if (created.status !== "ok") {
      return;
    }
    const checkoutId = created.checkout.checkoutId;
    const paymentIntentId = await payCheckout(world, shopA, checkoutId);
    const { orderId } = await succeedPayment(world, shopA, {
      checkoutId,
      paymentIntentId,
      totalMinor: created.checkout.totalMinor,
    });
    expect(orderId).not.toBeNull();
    const id = orderId as string;
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM order_recipients WHERE order_id = ?").bind(id).first(),
    ).toEqual({ n: 0 });
    expect((await buyerRead(shopA, checkoutId, id)).order.recipient).toBeNull();
    expect((await sellerRead(shopA, id)).order.recipient).toBeNull();
    const platform = await platformRead(shopA.tenantId, id);
    expect(platform).toBeDefined();
    expect(platform?.recipient).toBeNull();
  });

  it("another shop's order shows nothing: not to its seller, not with its token on another host, not in another shop's platform list", async () => {
    const { checkoutId, orderId } = await buy(shopA, shippedBody());
    const other = await adminCall(world, shopB, "GET", `/v1/admin/orders/${orderId}`);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain("Ragnhild");

    const claimed = await expectJson<{ receipt: { receiptToken: string } }>(
      await claimReceipt(world, shopA, checkoutId),
      200,
      "receipt",
    );
    const wrongHost = await readBuyerOrder(world, shopB, orderId, claimed.receipt.receiptToken);
    expect(wrongHost.status).toBe(404);
    expect(await wrongHost.text()).not.toContain("Ragnhild");

    expect(await platformRead(shopB.tenantId, orderId)).toBeUndefined();
    expect(await readOrderRecipient(env.DB, shopB.tenantId, orderId)).toBeNull();
    expect(await readOrderRecipient(env.DB, shopA.tenantId, orderId)).toMatchObject({ name: SHIPPED.name });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the schema: a recipient row is never updated", () => {
  it("refuses every UPDATE and every replacement of both tables; a DELETE is allowed", async () => {
    const { checkoutId, orderId } = await buy(shopA, shippedBody());

    await expect(
      env.DB.prepare("UPDATE order_recipients SET name = 'Annan' WHERE order_id = ?").bind(orderId).run(),
    ).rejects.toThrow(/order recipients are never updated/);
    await expect(
      env.DB.prepare("UPDATE order_recipients SET tenant_id = ? WHERE order_id = ?").bind(shopB.tenantId, orderId).run(),
    ).rejects.toThrow(/never updated/);
    await expect(
      env.DB.prepare("UPDATE checkout_recipients SET city = 'Annanstad' WHERE checkout_id = ?").bind(checkoutId).run(),
    ).rejects.toThrow(/checkout recipients are never updated/);
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO order_recipients (order_id, tenant_id, delivery_method, name, address_line1,
           postal_code, city, country, created_at)
         VALUES (?, ?, 'shipping', 'Annan', 'Gatan 1', '111 11', 'Stad', 'SE', '2026-09-28T00:00:00.000Z')`,
      )
        .bind(orderId, shopA.tenantId)
        .run(),
    ).rejects.toThrow(/never replaced/);
    expect(await readOrderRecipient(env.DB, shopA.tenantId, orderId)).toMatchObject({ city: SHIPPED.city, name: SHIPPED.name });

    // A row naming another shop than its checkout's is refused.
    const open = await expectJson<{ checkout: { checkoutId: string } }>(
      await postCheckout(shopA, pickupBody({ name: "Hämtar Hansson", pickupLocationId: SLICE_PICKUP_LOCATION.id })),
      201,
      "open checkout",
    );
    await expect(
      env.DB.prepare(
        `INSERT INTO order_recipients (order_id, tenant_id, delivery_method, name, pickup_location_id, created_at)
         VALUES (?, ?, 'pickup', 'Annan', 'x', '2026-09-28T00:00:00.000Z')`,
      )
        .bind(orderId, shopB.tenantId)
        .run(),
    ).rejects.toThrow();

    // D68: removable one day without touching the checkout or the order.
    await env.DB.prepare("DELETE FROM checkout_recipients WHERE checkout_id = ?").bind(open.checkout.checkoutId).run();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM checkout_recipients WHERE checkout_id = ?")
        .bind(open.checkout.checkoutId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await env.DB.prepare("SELECT status FROM checkouts WHERE checkout_id = ?").bind(open.checkout.checkoutId).first(),
    ).toEqual({ status: "open" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the printer's job", () => {
  async function dispatchedPayload(orderId: string): Promise<Record<string, unknown>> {
    const rows = await outboxRowsFor(orderId);
    const ids = rows.filter((row) => row.event_type === "dispatch" || row.event_type === "email").map((row) => row.outbox_id);
    await deliverOutbox(world, ids, world.with(printerWire(() => "deliver")));
    const job = await env.DB.prepare("SELECT payload_json FROM fake_printer_jobs WHERE order_id = ?")
      .bind(orderId)
      .first<{ payload_json: string }>();
    expect(job, "the printer received the job").not.toBeNull();
    return JSON.parse(job?.payload_json ?? "{}") as Record<string, unknown>;
  }

  it("a shipped order's job carries where the parcel goes", async () => {
    const { orderId } = await buy(shopA, shippedBody({ items: [{ productId: podA, quantity: 1 }] }));
    const payload = await dispatchedPayload(orderId);
    expect(payload.job_id).toBe(`${orderId}-1`);
    expect(payload.shipping_address).toEqual({
      address1: SHIPPED.addressLine1,
      address2: SHIPPED.addressLine2,
      city: SHIPPED.city,
      country_code: "SE",
      name: SHIPPED.name,
      phone: SHIPPED.phone,
      zip: SHIPPED.postalCode,
    });
  });

  it("a collected order's job carries no address (what the printer does with it is still to be agreed)", async () => {
    const { orderId } = await buy(
      shopA,
      pickupBody({ name: "Hämtar Hansson", pickupLocationId: SLICE_PICKUP_LOCATION.id }, { items: [{ productId: podA, quantity: 1 }] }),
    );
    const payload = await dispatchedPayload(orderId);
    expect(payload.job_id).toBe(`${orderId}-1`);
    expect("shipping_address" in payload).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("nothing of a recipient is logged, audited, alerted or queued", () => {
  it("a whole purchase — checkout, payment, order, dispatch, confirmation mail — leaves the recipient's texts nowhere but its own rows", async () => {
    const lines: string[] = [];
    for (const method of ["debug", "error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
      });
    }

    const { orderId } = await buy(shopA, shippedBody({ items: [{ productId: podA, quantity: 1 }] }));
    const rows = await outboxRowsFor(orderId);
    await deliverOutbox(world, rows.map((row) => row.outbox_id), world.with(printerWire(() => "deliver")));
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM fake_printer_jobs WHERE order_id = ?").bind(orderId).first(),
      "the purchase went all the way to the printer",
    ).toEqual({ n: 1 });

    for (const line of lines) {
      for (const needle of PII_NEEDLES) {
        expect(line, "a log line").not.toContain(needle);
      }
    }

    for (const table of ["audit_events", "alerts", "outbox_events", "payment_events", "email_deliveries", "deferred_payment_events"]) {
      const all = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      const text = JSON.stringify(all.results);
      for (const needle of PII_NEEDLES) {
        expect(text.includes(needle), `${table} holds "${needle}"`).toBe(false);
      }
    }
    // The control: the recipient's own rows DO hold it, so the search can find it.
    const own = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM order_recipients WHERE order_id = ?").bind(orderId).all()).results,
    );
    expect(own).toContain("Ragnhild");
  });
});
