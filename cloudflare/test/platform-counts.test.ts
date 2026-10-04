import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminCall,
  approveProduct,
  bootstrapPlatform,
  buyProduct,
  call,
  createPlainProduct,
  createTenant,
  expectJson,
  instrumentedDb,
  PLATFORM,
  platformCall,
  publishProduct,
  SliceWorld,
  type Tenant,
} from "./slice-harness";

/**
 * CP5-WK, unit WI — the per-shop counts of the platform console's directory
 * (`?counts=1`) and detail: products the seller's list shows, products a
 * visitor can see now (THE public predicate), and orders. One counting query
 * per page of the list, never one per shop.
 */

interface Counts {
  orders: number;
  products: number;
  publishedProducts: number;
}

interface ListBody {
  nextCursor: string | null;
  tenants: Array<{ counts?: Counts; tenantId: string }>;
}

const world = new SliceWorld();
let selling: Tenant;
let hidden: Tenant;
let empty: Tenant;
let soldProductId = "";

async function list(query: string, targetEnv?: Env): Promise<ListBody> {
  return expectJson<ListBody>(
    await platformCall(world, "GET", `/v1/platform/tenants${query}`, undefined, targetEnv),
    200,
    `list ${query}`,
  );
}

async function detailCounts(tenantId: string): Promise<Counts> {
  return (
    await expectJson<{ counts: Counts }>(
      await platformCall(world, "GET", `/v1/platform/tenants/${tenantId}`),
      200,
      "detail",
    )
  ).counts;
}

/** What a visitor's product list shows: the predicate's own answer. */
async function publicProductCount(tenant: Tenant): Promise<number> {
  const response = await call(world, "GET", `${tenant.origin}/v1/products`);
  if (response.status !== 200) {
    await response.body?.cancel();
    return 0;
  }
  const body = (await response.json()) as { products: unknown[] };
  return body.products.length;
}

beforeAll(async () => {
  await bootstrapPlatform(world);
  selling = await createTenant(world, { host: "wi-selling.shops.wk.test", shopName: "Säljer", tenantId: "wi-selling" });
  hidden = await createTenant(world, { host: "wi-hidden.shops.wk.test", shopName: "Dold", tenantId: "wi-hidden" });
  empty = await createTenant(world, { host: "wi-empty.shops.wk.test", shopName: "Tom", tenantId: "wi-empty" });

  // selling: 4 products — 2 public, 1 published but not approved, 1 draft — and 1 archived; 2 orders.
  const ids: string[] = [];
  for (const sku of ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"]) {
    ids.push(await createPlainProduct(world, selling, { name: `Vara ${sku}`, priceMinor: 19_900, sku }));
  }
  for (const id of ids.slice(0, 3)) {
    await publishProduct(world, selling, id);
  }
  await approveProduct(world, ids[0] as string);
  await approveProduct(world, ids[1] as string);
  await expectJson(
    await adminCall(world, selling, "PATCH", `/v1/admin/products/${ids[4]}`, { status: "archived" }),
    200,
    "archive",
  );
  soldProductId = ids[0] as string;
  await buyProduct(world, selling, soldProductId);
  await buyProduct(world, selling, soldProductId);

  // hidden: 1 approved product, then the shop is unpublished.
  const hiddenId = await createPlainProduct(world, hidden, { name: "Gömd", priceMinor: 9_900, sku: "WI-H" });
  await publishProduct(world, hidden, hiddenId);
  await approveProduct(world, hiddenId);
  await expectJson(await platformCall(world, "POST", `/v1/platform/tenants/${hidden.tenantId}/unpublish`), 200, "unpublish");
}, 180_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what is counted", () => {
  it("products = the seller's list (draft + active, not archived); publishedProducts = what a visitor sees; orders = every order", async () => {
    const counts = await detailCounts(selling.tenantId);
    expect(counts).toEqual({ orders: 2, products: 4, publishedProducts: 2 });
    expect(counts.publishedProducts).toBe(await publicProductCount(selling));
  });

  it("an unpublished shop shows nothing to a visitor: publishedProducts 0, its products still counted", async () => {
    expect(await detailCounts(hidden.tenantId)).toEqual({ orders: 0, products: 1, publishedProducts: 0 });
    expect(await publicProductCount(hidden)).toBe(0);
  });

  it("a shop with nothing yet: zeros", async () => {
    expect(await detailCounts(empty.tenantId)).toEqual({ orders: 0, products: 0, publishedProducts: 0 });
  });

  it("a product taken down leaves the public count and stays in the seller's; its orders stay counted", async () => {
    const before = await detailCounts(selling.tenantId);
    await env.DB.prepare("UPDATE products SET takedown_at = ? WHERE product_id = ?")
      .bind(new Date().toISOString(), soldProductId)
      .run();
    try {
      const after = await detailCounts(selling.tenantId);
      expect(after).toEqual({ ...before, publishedProducts: before.publishedProducts - 1 });
      expect(after.publishedProducts).toBe(await publicProductCount(selling));
    } finally {
      await env.DB.prepare("UPDATE products SET takedown_at = NULL WHERE product_id = ?").bind(soldProductId).run();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the directory: counts only when asked", () => {
  it("?counts=1 adds each row's counts; without it the rows are unchanged", async () => {
    const withCounts = await list("?counts=1&limit=100");
    const byId = new Map(withCounts.tenants.map((row) => [row.tenantId, row.counts]));
    expect(byId.get(selling.tenantId)).toEqual({ orders: 2, products: 4, publishedProducts: 2 });
    expect(byId.get(hidden.tenantId)).toEqual({ orders: 0, products: 1, publishedProducts: 0 });
    expect(byId.get(empty.tenantId)).toEqual({ orders: 0, products: 0, publishedProducts: 0 });
    expect(withCounts.tenants.every((row) => row.counts !== undefined)).toBe(true);

    const plain = await list("?limit=100");
    expect(plain.tenants.some((row) => Object.hasOwn(row, "counts"))).toBe(false);
  });

  it("pages keep their counts (the cursor applies as before)", async () => {
    const first = await list("?counts=1&limit=1");
    expect(first.tenants).toHaveLength(1);
    expect(first.tenants[0]?.counts).toBeDefined();
    expect(first.nextCursor).not.toBeNull();
  });

  it.each([["counts=0"], ["counts=true"], ["counts="], ["counts=1&counts=1"]])("refuses %s", async (query) => {
    await expectJson(await platformCall(world, "GET", `/v1/platform/tenants?${query}`), 400, query);
  });

  it("one counting statement per page, not one per shop", async () => {
    const instrumented = instrumentedDb(() => {});
    const body = await list("?counts=1&limit=100", world.with({ DB: instrumented.db }));
    expect(body.tenants.length).toBeGreaterThanOrEqual(3);
    const counting = instrumented.ops.filter((op) => op.sql.some((sql) => sql.includes("COUNT(*) FROM products")));
    expect(counting).toHaveLength(Math.ceil(body.tenants.length / 90));
  });

  it("a tenant admin cannot read the directory or the detail (unchanged guard)", async () => {
    for (const path of ["/v1/platform/tenants?counts=1", `/v1/platform/tenants/${selling.tenantId}`]) {
      const response = await call(world, "GET", `${PLATFORM}${path}`, { cookie: selling.adminCookie });
      expect(response.status, path).toBe(404);
      await response.body?.cancel();
    }
  });
});
