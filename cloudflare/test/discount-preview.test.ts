import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { DISCOUNT_PREVIEW_IP_LIMIT } from "../src/routes/storefront-discount-preview";
import {
  DAY_MS,
  seedCode,
  seedHeldCheckout,
  seedPlainProduct,
  seedShop,
} from "./discount-fixtures";

/**
 * CP8-DC build step 5: POST /v1/discount-codes/preview (design §4.1). One
 * uniform answer for every code that does not apply, nothing written, holds
 * ignored, the checkout's own 422, and a per-visitor limit read before the
 * body.
 */

const TENANT = "tenant-dc-preview";
const HOST = "dc-preview.test";
const OTHER = "tenant-dc-preview-other";
const OTHER_HOST = "dc-preview-other.test";
const OFF = "tenant-dc-preview-off";
const OFF_HOST = "dc-preview-off.test";
const PATH = "/v1/discount-codes/preview";
const ITEMS = [{ productId: "preview-mug", quantity: 1 }];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}:${ipCounter}`;
}

function preview(body: unknown, options: { host?: string; ip?: string; method?: string } = {}): Promise<Response> {
  const method = options.method ?? "POST";
  return exports.default.fetch(
    new Request(`https://${options.host ?? HOST}${PATH}`, {
      ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      headers: { "cf-connecting-ip": options.ip ?? nextIp(), "content-type": "application/json" },
      method,
    }),
  );
}

function notApplying(code: string): string {
  return JSON.stringify({ discount: { applies: false, code, discountMinor: 0 } });
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["checkouts", "discount_code_holds", "audit_events", "orders", "checkout_items"]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    counts[table] = row?.n ?? -1;
  }
  const used = await env.DB.prepare("SELECT COALESCE(SUM(used_count), 0) AS n FROM discount_codes").first<{ n: number }>();
  counts.used = used?.n ?? -1;
  return counts;
}

beforeAll(async () => {
  await seedShop(TENANT, HOST);
  await seedShop(OTHER, OTHER_HOST);
  await seedShop(OFF, OFF_HOST, { discountCodes: false });
  await seedPlainProduct(TENANT, "preview-mug", 20_000);
  await seedPlainProduct(TENANT, "preview-cap", 10_000);
  await seedPlainProduct(OFF, "preview-off-mug", 20_000);
  const now = Date.now();

  await seedCode({ code: "SOMMAR20", percentBp: 2_000, tenantId: TENANT });
  await seedCode({ code: "ONEUSE", maxUses: 1, tenantId: TENANT, valueMinor: 5_000 });
  await seedCode({ code: "THEIRS", percentBp: 2_000, tenantId: OTHER });
  await seedCode({ active: false, code: "INACTIVE", percentBp: 2_000, tenantId: TENANT });
  await seedCode({ code: "NOTYET", percentBp: 2_000, startsAt: now + DAY_MS, tenantId: TENANT });
  await seedCode({ code: "ENDED", endsAt: now - DAY_MS, percentBp: 2_000, tenantId: TENANT });
  await seedCode({ code: "FULL", maxUses: 2, percentBp: 2_000, tenantId: TENANT, usedCount: 2 });
  await seedCode({ code: "MINSPEND", minSpendMinor: 50_000, percentBp: 2_000, tenantId: TENANT });
  await seedCode({ code: "SCOPEDMISS", percentBp: 2_000, productIds: ["preview-cap"], tenantId: TENANT });
  await seedCode({ code: "WORTHZERO", tenantId: TENANT, type: "fixed", valueMinor: 0 });
  await seedCode({ code: "SWITCHOFF", percentBp: 2_000, tenantId: OFF });
});

describe("the answer", () => {
  it("says applies and how much, for the normalized code", async () => {
    const response = await preview({ code: " sommar20 ", items: ITEMS });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ discount: { applies: true, code: "SOMMAR20", discountMinor: 4_000 } }));
  });

  it("gives every code that does not apply the same body, byte for byte", async () => {
    const hit = await preview({ code: "SOMMAR20", items: ITEMS });
    const misses: Array<[string, string]> = [
      ["NOSUCHCODE", HOST],
      ["THEIRS", HOST],
      ["INACTIVE", HOST],
      ["NOTYET", HOST],
      ["ENDED", HOST],
      ["FULL", HOST],
      ["MINSPEND", HOST],
      ["SCOPEDMISS", HOST],
      ["WORTHZERO", HOST],
      ["SWITCHOFF", OFF_HOST],
    ];
    for (const [code, host] of misses) {
      const items = host === OFF_HOST ? [{ productId: "preview-off-mug", quantity: 1 }] : ITEMS;
      const response = await preview({ code, items }, { host });
      expect(response.status, code).toBe(200);
      expect(await response.text(), code).toBe(notApplying(code));
      for (const header of ["content-type", "cache-control", "x-content-type-options"]) {
        expect(response.headers.get(header), `${code} ${header}`).toBe(hit.headers.get(header));
      }
    }
  });

  it("applies another shop's code on that shop only", async () => {
    const theirs = await preview({ code: "THEIRS", items: [{ productId: "preview-mug", quantity: 1 }] }, { host: OTHER_HOST });
    // The other shop has no such product: its own 422, not the code.
    expect(theirs.status).toBe(422);
  });

  it("ignores holds: the preview counts paid uses only", async () => {
    const codeId = await env.DB.prepare("SELECT discount_code_id FROM discount_codes WHERE tenant_id = ? AND code = 'ONEUSE'")
      .bind(TENANT)
      .first<{ discount_code_id: string }>();
    await seedHeldCheckout(TENANT, codeId?.discount_code_id ?? "");
    const response = await preview({ code: "ONEUSE", items: ITEMS });
    expect(await response.json()).toEqual({ discount: { applies: true, code: "ONEUSE", discountMinor: 5_000 } });
  });

  it("does not apply the minimum charge or the fee rule: those are the checkout's", async () => {
    // A 200 kr code on a 200 kr mug: the preview says 20 000, the checkout
    // would not apply it (R3). Display-only, as the design states.
    await seedCode({ code: "WHOLEMUG", tenantId: TENANT, valueMinor: 20_000 });
    expect(await (await preview({ code: "WHOLEMUG", items: ITEMS })).json()).toEqual({
      discount: { applies: true, code: "WHOLEMUG", discountMinor: 20_000 },
    });
  });

  it("writes nothing but its rate-limit row", async () => {
    const before = await rowCounts();
    for (const code of ["SOMMAR20", "NOSUCHCODE", "ONEUSE", "FULL"]) {
      expect((await preview({ code, items: ITEMS })).status).toBe(200);
    }
    expect(await rowCounts()).toEqual(before);
  });
});

describe("the refusals", () => {
  it.each([
    ["no code", { items: ITEMS }],
    ["a code that is not a string", { code: 20, items: ITEMS }],
    ["an empty code", { code: "   ", items: ITEMS }],
    ["a code of 51 characters", { code: "A".repeat(51), items: ITEMS }],
    ["whitespace inside a code", { code: "SOM MAR", items: ITEMS }],
    ["a control character", { code: "SOM\u0007MAR", items: ITEMS }],
    ["an unknown key", { code: "SOMMAR20", items: ITEMS, price: 1 }],
    ["no items", { code: "SOMMAR20", items: [] }],
    ["51 items", { code: "SOMMAR20", items: Array.from({ length: 51 }, (_, i) => ({ productId: `p${i}`, quantity: 1 })) }],
    ["a price on a line", { code: "SOMMAR20", items: [{ priceMinor: 1, productId: "preview-mug", quantity: 1 }] }],
    ["a quantity of 0", { code: "SOMMAR20", items: [{ productId: "preview-mug", quantity: 0 }] }],
    ["not JSON", "{not json"],
  ])("400 for %s", async (_label, body) => {
    const response = await preview(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Request is not valid" } });
  });

  it("422 for a line the checkout would refuse, or a duplicate line", async () => {
    expect((await preview({ code: "SOMMAR20", items: [{ productId: "no-such-product", quantity: 1 }] })).status).toBe(422);
    expect((await preview({ code: "SOMMAR20", items: [ITEMS[0], ITEMS[0]] })).status).toBe(422);
  });

  it("404 for a hostname without a shop, a shop that takes no checkout, and any method but POST", async () => {
    const unknown = await preview({ code: "SOMMAR20", items: ITEMS }, { host: "nobody.preview.test" });
    expect(unknown.status).toBe(404);
    const closed = "tenant-dc-preview-closed";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at)
         VALUES (?, 'active', 'Closed', 'sv-SE', 'SEK', ?, ?)`,
      ).bind(closed, now, now),
      env.DB.prepare(
        `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status, created_at, updated_at)
         VALUES (?, ?, 'dc-preview-closed.test', 'storefront', 'verified', ?, ?)`,
      ).bind(`domain-${closed}`, closed, now, now),
    ]);
    const gated = await preview({ code: "SOMMAR20", items: ITEMS }, { host: "dc-preview-closed.test" });
    expect(gated.status).toBe(404);
    expect(await gated.text()).toBe(await unknown.text());
    expect((await preview(null, { method: "GET" })).status).toBe(404);
    expect((await preview({ code: "SOMMAR20", items: ITEMS }, { method: "PUT" })).status).toBe(404);
  });

  it("429 for the 31st preview from one visitor within 10 minutes, counted before the body", async () => {
    let address = 0;
    // Every address of one /64 is one visitor.
    const fromOneNetwork = (body: unknown) => {
      address += 1;
      return preview(body, { ip: `2001:db8:dc:5::${address.toString(16)}` });
    };
    for (let index = 0; index < DISCOUNT_PREVIEW_IP_LIMIT; index += 1) {
      // Malformed bodies count too: the limit runs first.
      const body = index % 3 === 0 ? "{not json" : { code: "NOSUCHCODE", items: ITEMS };
      expect((await fromOneNetwork(body)).status, `preview ${index + 1}`).not.toBe(429);
    }
    const refused = await fromOneNetwork({ code: "SOMMAR20", items: ITEMS });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(DISCOUNT_PREVIEW_IP_LIMIT).toBe(30);
    // Another visitor is not affected.
    expect((await preview({ code: "SOMMAR20", items: ITEMS })).status).toBe(200);
  });
});
