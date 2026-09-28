import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isCollectionHandle } from "../src/catalog/collections";
import { ADMIN, call, type CallOptions } from "./slice-harness";
import { type ProductSeed, publicObject, removeObject, seedProduct } from "./storefront-fixtures";
import {
  auditCount,
  auditRows,
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  type Tenant,
  tenantRow,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP4-B — collections, part 1: the 0041 schema (its CHECKs and triggers, the
 * shared namespace of handle, external reference and id, the version bumps)
 * and the admin routes (/v1/admin/collections). The public reads, CORS and
 * the rate limit are in public-collections.test.ts.
 *
 * Refusals first (rule 9), then the happy paths. Every shop, admin and
 * session comes from the real routes (tenant-fixtures.ts); products are rows
 * (storefront-fixtures.ts seedProduct), as an importer writes them.
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_BASE = "https://public-objects.test.invalid";

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;

interface AdminCollectionBody {
  collection: {
    collectionId: string;
    createdAt: string;
    createdBy: string | null;
    description: string | null;
    externalRef: string | null;
    featured: boolean;
    handle: string;
    image: { contentType: string; height: number | null; objectId: string; url: string; width: number | null } | null;
    imageObjectId: string | null;
    path: string;
    productCount: number;
    productIds: string[];
    published: boolean;
    ruleTag: string | null;
    sortOrder: number | null;
    title: string;
    type: string;
    updatedAt: string;
    updatedBy: string | null;
  };
}

type AdminCollectionView = AdminCollectionBody["collection"];

function adminAs(tenant: Tenant, method: string, path: string, body?: unknown, options: CallOptions = {}) {
  return call(world, method, `${ADMIN}${path}`, {
    body,
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

async function create(tenant: Tenant, body: Record<string, unknown>): Promise<AdminCollectionView> {
  return (
    await expectJson<AdminCollectionBody>(
      await adminAs(tenant, "POST", "/v1/admin/collections", body),
      201,
      `create ${String(body.title)}`,
    )
  ).collection;
}

async function patch(tenant: Tenant, id: string, body: unknown): Promise<AdminCollectionView> {
  return (
    await expectJson<AdminCollectionBody>(
      await adminAs(tenant, "PATCH", `/v1/admin/collections/${id}`, body),
      200,
      `patch ${id}`,
    )
  ).collection;
}

async function putProducts(tenant: Tenant, id: string, productIds: unknown): Promise<Response> {
  return adminAs(tenant, "PUT", `/v1/admin/collections/${id}/products`, productIds);
}

async function collectionRow(collectionId: string) {
  return env.DB.prepare("SELECT * FROM collections WHERE collection_id = ?")
    .bind(collectionId)
    .first<Record<string, unknown>>();
}

async function memberIds(collectionId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT product_id FROM collection_products WHERE collection_id = ? ORDER BY position",
  )
    .bind(collectionId)
    .all<{ product_id: string }>();
  return rows.results.map((row) => row.product_id);
}

async function catalogVersion(tenant: Tenant): Promise<number> {
  return (await tenantRow(tenant.tenantId))?.catalog_version ?? -1;
}

let skuCounter = 0;
function product(tenant: Tenant, extra: Partial<ProductSeed> = {}): Promise<string> {
  skuCounter += 1;
  return seedProduct(tenant.tenantId, { name: `Produkt ${skuCounter}`, sku: `CO-${skuCounter}`, ...extra });
}

/** `count` product rows of the shop in one batch (no publication: the admin keeps any product). */
async function bulkProducts(tenant: Tenant, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_value, index) => `bulk-${tenant.tenantId}-${skuCounter}-${index}`);
  skuCounter += 1;
  const now = Date.now();
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor, currency, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, 9900, 'SEK', ?, ?)`,
      ).bind(id, tenant.tenantId, `SKU-${id}`, `Bulk ${id}`, now, now),
    ),
  );
  return ids;
}

beforeAll(async () => {
  const setup = await tenantWorld("co", 3);
  world = setup.world;
  [shopA, shopB, shopC] = setup.tenants as [Tenant, Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
// The 0041 schema
// ═══════════════════════════════════════════════════════════════════════════

describe("the 0041 schema", () => {
  const iso = "2026-09-28T00:00:00.000Z";
  let seq = 0;

  function insertCollection(overrides: Record<string, unknown> = {}): Promise<D1Result> {
    seq += 1;
    const row: Record<string, unknown> = {
      collection_id: `sid-${seq}`,
      created_at: iso,
      handle: `sh-${seq}`,
      tenant_id: shopA.tenantId,
      title: "Samling",
      type: "manual",
      updated_at: iso,
      ...overrides,
    };
    const columns = Object.keys(row);
    return env.DB.prepare(
      `INSERT INTO collections (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
      .bind(...Object.values(row))
      .run();
  }

  function insertMember(tenantId: string, collectionId: string, productId: string, position: number) {
    return env.DB.prepare(
      "INSERT INTO collection_products (tenant_id, collection_id, product_id, position) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, collectionId, productId, position)
      .run();
  }

  it("admits a manual and a smart row with every optional field, and an imported id", async () => {
    const cover = await publicObject(shopA.tenantId, { kind: "product_media" });
    await expect(insertCollection()).resolves.toBeDefined();
    await expect(
      insertCollection({
        collection_id: "Ab3dE5gH9jK1mN2pQ4rS",
        created_by: "user-1",
        description: "Rad ett\nRad två",
        external_ref: "ext-imported-1",
        featured: 1,
        handle: "eva_eastwood-2",
        image_object_id: cover,
        published: 1,
        rule_tag: "Nyhet",
        sort_order: -5,
        type: "smart",
        updated_by: "user-1",
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["an upper-case handle", { handle: "Nyheter" }],
    ["a handle with a space", { handle: "ny het" }],
    ["a handle with a slash", { handle: "ny/het" }],
    ["a handle with a double hyphen", { handle: "ny--het" }],
    ["a handle of hyphens only", { handle: "-_-" }],
    ["a handle with a non-ASCII letter", { handle: "nyhét" }],
    ["a handle over 200 characters", { handle: "a".repeat(201) }],
    ["an empty handle", { handle: "" }],
    ["an external reference with a slash", { external_ref: "gid/1" }],
    ["an external reference with a space", { external_ref: "a b" }],
    ["a dot-segment external reference", { external_ref: ".." }],
    ["an empty external reference", { external_ref: "" }],
    ["an external reference over 128 characters", { external_ref: "1".repeat(129) }],
    ["an empty title", { title: "" }],
    ["a title over 200 characters", { title: "x".repeat(201) }],
    ["an empty description", { description: "" }],
    ["an unknown type", { type: "automatic" }],
    ["a smart collection without a tag", { type: "smart" }],
    ["a manual collection with a tag", { rule_tag: "Nyhet" }],
    ["a tag over 50 characters", { rule_tag: "x".repeat(51), type: "smart" }],
    ["published 2", { published: 2 }],
    ["featured -1", { featured: -1 }],
    ["a sort order out of range", { sort_order: 1_000_000_001 }],
    ["a date that is not ISO", { created_at: "2026-09-28 00:00:00", updated_at: "2026-09-28 00:00:00" }],
    ["updated before created", { updated_at: "2026-09-27T00:00:00.000Z" }],
    ["an id with a slash", { collection_id: "a/b" }],
    ["an image that does not exist", { image_object_id: "no-such-object" }],
    ["an empty creator", { created_by: "" }],
  ])("refuses %s", async (_label, overrides) => {
    await expect(insertCollection(overrides)).rejects.toThrow();
  });

  it("the code's handle rule is the CHECK's: exactly the fixed points of slugify", () => {
    for (const handle of ["nytt", "eva-eastwood", "a_b", "-and-co", "2026", "x-"]) {
      expect(isCollectionHandle(handle), handle).toBe(true);
    }
    for (const handle of ["", "Nytt", "ny het", "ny--het", "å", "-", "__", "a/b", "a".repeat(201), " a"]) {
      expect(isCollectionHandle(handle), handle).toBe(false);
    }
  });

  it("keeps handles and external references unique per shop, not across shops", async () => {
    await insertCollection({ collection_id: "uniq-a", external_ref: "uniq-ext", handle: "uniq-handle" });
    await expect(insertCollection({ handle: "uniq-handle" })).rejects.toThrow(
      /UNIQUE constraint failed: collections\.tenant_id, collections\.handle/,
    );
    await expect(insertCollection({ external_ref: "uniq-ext" })).rejects.toThrow(
      /UNIQUE constraint failed: collections\.tenant_id, collections\.external_ref/,
    );
    // Many collections without an external reference.
    await expect(insertCollection()).resolves.toBeDefined();
    await expect(insertCollection()).resolves.toBeDefined();
    await expect(
      insertCollection({ external_ref: "uniq-ext", handle: "uniq-handle", tenant_id: shopB.tenantId }),
    ).resolves.toBeDefined();
  });

  it("shares ONE namespace of handle, external reference and id per shop, in both directions", async () => {
    await insertCollection({ collection_id: "ns-x", external_ref: "ns-ext", handle: "ns-handle" });

    // A new row that names X by any of its three names is refused.
    await expect(insertCollection({ handle: "ns-ext" })).rejects.toThrow(/the handle names another collection/);
    await expect(insertCollection({ handle: "ns-x" })).rejects.toThrow(/the handle names another collection/);
    await expect(insertCollection({ external_ref: "ns-handle" })).rejects.toThrow(
      /the external reference names another collection/,
    );
    await expect(insertCollection({ external_ref: "ns-x" })).rejects.toThrow(
      /the external reference names another collection/,
    );
    await expect(insertCollection({ collection_id: "ns-handle" })).rejects.toThrow(
      /the collection id names another collection/,
    );
    await expect(insertCollection({ collection_id: "ns-ext" })).rejects.toThrow(
      /the collection id names another collection/,
    );

    // An existing row renamed onto X's names is refused too.
    await insertCollection({ collection_id: "ns-y", handle: "ns-y-handle" });
    await expect(
      env.DB.prepare("UPDATE collections SET handle = 'ns-ext' WHERE collection_id = 'ns-y'").run(),
    ).rejects.toThrow(/the handle names another collection/);
    await expect(
      env.DB.prepare("UPDATE collections SET handle = 'ns-x' WHERE collection_id = 'ns-y'").run(),
    ).rejects.toThrow(/the handle names another collection/);
    await expect(
      env.DB.prepare("UPDATE collections SET external_ref = 'ns-handle' WHERE collection_id = 'ns-y'").run(),
    ).rejects.toThrow(/the external reference names another collection/);
    await expect(
      env.DB.prepare("UPDATE collections SET external_ref = 'ns-x' WHERE collection_id = 'ns-y'").run(),
    ).rejects.toThrow(/the external reference names another collection/);

    // A collection's own names may coincide; another shop's are no concern.
    await expect(
      env.DB.prepare("UPDATE collections SET external_ref = 'ns-handle' WHERE collection_id = 'ns-x'").run(),
    ).resolves.toBeDefined();
    await expect(
      insertCollection({ collection_id: "ns-other", external_ref: "ns-x", handle: "ns-handle", tenant_id: shopB.tenantId }),
    ).resolves.toBeDefined();
  });

  it("keeps tenant_id and collection_id immutable", async () => {
    await insertCollection({ collection_id: "imm", handle: "imm" });
    await expect(
      env.DB.prepare("UPDATE collections SET tenant_id = ? WHERE collection_id = 'imm'").bind(shopB.tenantId).run(),
    ).rejects.toThrow(/tenant_id is immutable/);
    await expect(
      env.DB.prepare("UPDATE collections SET collection_id = 'imm-2' WHERE collection_id = 'imm'").run(),
    ).rejects.toThrow(/collection_id is immutable/);
  });

  it("names as its cover only an active public product image of its own shop", async () => {
    const own = await publicObject(shopA.tenantId, { kind: "product_media" });
    const foreign = await publicObject(shopB.tenantId, { kind: "product_media" });
    const branding = await publicObject(shopA.tenantId, { kind: "shop_branding" });
    const pending = await publicObject(shopA.tenantId, { activate: false, kind: "product_media" });
    const removed = await publicObject(shopA.tenantId, { kind: "product_media" });
    await removeObject(shopA.tenantId, removed);

    await expect(insertCollection({ image_object_id: own })).resolves.toBeDefined();
    for (const [label, objectId] of [
      ["another shop's", foreign],
      ["a branding", branding],
      ["a pending", pending],
      ["a removed", removed],
    ] as const) {
      await expect(insertCollection({ image_object_id: objectId }), label).rejects.toThrow(
        /collection image must be/,
      );
    }

    // D93: once named, the cover may be removed; the row stays writable.
    const cover = await publicObject(shopA.tenantId, { kind: "product_media" });
    await insertCollection({ collection_id: "covered", handle: "covered", image_object_id: cover });
    await removeObject(shopA.tenantId, cover);
    await expect(
      env.DB.prepare("UPDATE collections SET title = 'Ny titel', image_object_id = image_object_id WHERE collection_id = 'covered'").run(),
    ).resolves.toBeDefined();
    await expect(
      env.DB.prepare("UPDATE collections SET image_object_id = ? WHERE collection_id = 'covered'").bind(foreign).run(),
    ).rejects.toThrow(/collection image must be/);
  });

  it("admits as members only products of the collection's shop, in a manual collection, 500 at most", async () => {
    const own = await product(shopA);
    const draft = await product(shopA, { published: false, status: "draft" });
    const foreign = await product(shopB);
    await insertCollection({ collection_id: "members", handle: "members" });
    await insertCollection({ collection_id: "smart-members", handle: "smart-members", rule_tag: "Nyhet", type: "smart" });

    await expect(insertMember(shopA.tenantId, "members", own, 0)).resolves.toBeDefined();
    await expect(insertMember(shopA.tenantId, "members", draft, 1)).resolves.toBeDefined();
    await expect(insertMember(shopA.tenantId, "members", foreign, 2)).rejects.toThrow(
      /member must be a product of the collection tenant/,
    );
    await expect(insertMember(shopA.tenantId, "members", "no-such-product", 2)).rejects.toThrow(
      /member must be a product of the collection tenant/,
    );
    await expect(insertMember(shopB.tenantId, "members", foreign, 2)).rejects.toThrow(
      /member tenant_id must match collection tenant_id/,
    );
    await expect(insertMember(shopA.tenantId, "smart-members", own, 0)).rejects.toThrow(
      /a smart collection holds no products/,
    );
    await expect(insertMember(shopA.tenantId, "members", await product(shopA), 1)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(insertMember(shopA.tenantId, "members", await product(shopA), 500)).rejects.toThrow();

    // A collection with members is not turned smart; a member row cannot move shop.
    await expect(
      env.DB.prepare("UPDATE collections SET type = 'smart', rule_tag = 'x' WHERE collection_id = 'members'").run(),
    ).rejects.toThrow(/a smart collection holds no products/);
    await expect(
      env.DB.prepare("UPDATE collection_products SET tenant_id = ? WHERE collection_id = 'members'")
        .bind(shopB.tenantId)
        .run(),
    // Three triggers refuse this; which fires first is SQLite's order, not ours.
    ).rejects.toThrow(/tenant_id is immutable|member tenant_id must match|member must be a product/);
    await expect(
      env.DB.prepare("UPDATE collection_products SET collection_id = 'smart-members' WHERE collection_id = 'members'").run(),
    ).rejects.toThrow(/a smart collection holds no products/);
  });

  it("bumps catalog_version on every insert, update and delete of both tables", async () => {
    const member = await product(shopA);
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["insert a collection", () => insertCollection({ collection_id: "bump", handle: "bump" })],
      ["update it", () => env.DB.prepare("UPDATE collections SET title = 'B' WHERE collection_id = 'bump'").run()],
      ["insert a member", () => insertMember(shopA.tenantId, "bump", member, 0)],
      ["move the member", () => env.DB.prepare("UPDATE collection_products SET position = 3 WHERE collection_id = 'bump'").run()],
      ["delete the member", () => env.DB.prepare("DELETE FROM collection_products WHERE collection_id = 'bump'").run()],
      ["delete the collection", () => env.DB.prepare("DELETE FROM collections WHERE collection_id = 'bump'").run()],
    ];
    for (const [label, step] of steps) {
      const before = await catalogVersion(shopA);
      await step();
      expect(await catalogVersion(shopA), label).toBeGreaterThan(before);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The admin routes: the refusals first
// ═══════════════════════════════════════════════════════════════════════════

describe("who may read and write collections", () => {
  let collectionA: AdminCollectionView;
  let memberA: string;

  beforeAll(async () => {
    collectionA = await create(shopA, { title: "Vem får" });
    memberA = await product(shopA);
  });

  it("anonymous callers get the opaque 404 on every route and method", async () => {
    const before = await auditCount();
    const anonymous = { cookie: undefined, shopId: shopA.tenantId };
    const id = collectionA.collectionId;
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/collections", undefined, anonymous), "list");
    await expectOpaque404(await adminAs(shopA, "POST", "/v1/admin/collections", { title: "Anon" }, anonymous), "create");
    await expectOpaque404(await adminAs(shopA, "GET", `/v1/admin/collections/${id}`, undefined, anonymous), "read");
    await expectOpaque404(await adminAs(shopA, "PATCH", `/v1/admin/collections/${id}`, { title: "x" }, anonymous), "patch");
    await expectOpaque404(await adminAs(shopA, "DELETE", `/v1/admin/collections/${id}`, undefined, anonymous), "delete");
    await expectOpaque404(await adminAs(shopA, "PUT", `/v1/admin/collections/${id}/products`, [memberA], anonymous), "put");
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/collections", undefined, { shopId: undefined }), "no X-Shop-Id");
    expect(await auditCount()).toBe(before);
    expect(await collectionRow(id)).toMatchObject({ title: "Vem får" });
    expect(await memberIds(id)).toEqual([]);
  });

  it("another shop's admin can neither see nor touch this shop's collections", async () => {
    const id = collectionA.collectionId;
    const asB = { cookie: shopB.adminCookie, shopId: shopA.tenantId };
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/collections", undefined, asB), "B lists A");
    await expectOpaque404(await adminAs(shopA, "POST", "/v1/admin/collections", { title: "Kapad" }, asB), "B creates in A");
    await expectOpaque404(await adminAs(shopA, "PATCH", `/v1/admin/collections/${id}`, { title: "B" }, asB), "B edits A");
    await expectOpaque404(await adminAs(shopA, "PUT", `/v1/admin/collections/${id}/products`, [], asB), "B lists A's products");
    await expectOpaque404(await adminAs(shopA, "DELETE", `/v1/admin/collections/${id}`, undefined, asB), "B deletes A");

    // B's own shop: A's id does not exist there.
    for (const [method, path, body] of [
      ["GET", `/v1/admin/collections/${id}`, undefined],
      ["PATCH", `/v1/admin/collections/${id}`, { title: "B" }],
      ["DELETE", `/v1/admin/collections/${id}`, undefined],
      ["PUT", `/v1/admin/collections/${id}/products`, []],
    ] as const) {
      await expectOpaque404(await adminAs(shopB, method, path, body), `B ${method} A's id in B`);
    }
    const listB = await expectJson<{ collections: unknown[] }>(await adminAs(shopB, "GET", "/v1/admin/collections"), 200, "B's list");
    expect(JSON.stringify(listB)).not.toContain(id);
    expect(await collectionRow(id)).toMatchObject({ tenant_id: shopA.tenantId, title: "Vem får" });
  });

  it("cross-origin and origin-less writes are refused before the body is read", async () => {
    const before = await auditCount();
    const id = collectionA.collectionId;
    for (const origin of ["https://evil.test", null]) {
      await expectOpaque404(await adminAs(shopA, "POST", "/v1/admin/collections", { title: "csrf" }, { origin }), `POST ${origin}`);
      await expectOpaque404(await adminAs(shopA, "PATCH", `/v1/admin/collections/${id}`, { title: "csrf" }, { origin }), `PATCH ${origin}`);
      await expectOpaque404(await adminAs(shopA, "PUT", `/v1/admin/collections/${id}/products`, [memberA], { origin }), `PUT ${origin}`);
      await expectOpaque404(await adminAs(shopA, "DELETE", `/v1/admin/collections/${id}`, undefined, { origin }), `DELETE ${origin}`);
      // Not even a malformed body is looked at.
      await expectOpaque404(
        await call(world, "POST", `${ADMIN}/v1/admin/collections`, {
          cookie: shopA.adminCookie,
          origin,
          rawBody: "{",
          shopId: shopA.tenantId,
        }),
        `malformed POST ${origin}`,
      );
    }
    expect(await auditCount()).toBe(before);
    expect(await collectionRow(id)).toMatchObject({ title: "Vem får" });
    expect(await memberIds(id)).toEqual([]);
  });

  it("methods the routes do not claim fall through to the 404", async () => {
    const id = collectionA.collectionId;
    await expectOpaque404(await adminAs(shopA, "PUT", "/v1/admin/collections", { title: "put" }), "PUT list");
    await expectOpaque404(await adminAs(shopA, "DELETE", "/v1/admin/collections"), "DELETE list");
    await expectOpaque404(await adminAs(shopA, "POST", `/v1/admin/collections/${id}`, { title: "post" }), "POST id");
    await expectOpaque404(await adminAs(shopA, "PUT", `/v1/admin/collections/${id}`, { title: "put" }), "PUT id");
    await expectOpaque404(await adminAs(shopA, "GET", `/v1/admin/collections/${id}/products`), "GET products");
    await expectOpaque404(await adminAs(shopA, "POST", `/v1/admin/collections/${id}/products`, []), "POST products");
    await expectOpaque404(await adminAs(shopA, "OPTIONS", "/v1/admin/collections"), "OPTIONS list");
    const head = await adminAs(shopA, "HEAD", `/v1/admin/collections/${id}`);
    expect(head.status).toBe(404);
  });

  it("a malformed or unknown collection id is the opaque 404", async () => {
    for (const segment of ["%ZZ", "a%2Fb", "a.b", "a".repeat(129), "%20", "nytt%20"]) {
      await expectOpaque404(await adminAs(shopA, "GET", `/v1/admin/collections/${segment}`), segment);
      await expectOpaque404(await adminAs(shopA, "PUT", `/v1/admin/collections/${segment}/products`, []), `PUT ${segment}`);
    }
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/collections/no-such-collection"), "unknown id");
    await expectOpaque404(await adminAs(shopA, "PATCH", "/v1/admin/collections/no-such-collection", { title: "x" }), "unknown PATCH");
    await expectOpaque404(await adminAs(shopA, "DELETE", "/v1/admin/collections/no-such-collection"), "unknown DELETE");
    await expectOpaque404(await putProducts(shopA, "no-such-collection", []), "unknown PUT");
  });

  it("the admin answers carry no cross-origin header", async () => {
    const list = await adminAs(shopA, "GET", "/v1/admin/collections");
    expect(list.status).toBe(200);
    expect(list.headers.get("access-control-allow-origin")).toBeNull();
    await list.body?.cancel();
  });

  it("a platform user needs an acting-as grant; with one it writes, audited with the grant", async () => {
    const asPlatform = { cookie: world.platformCookie, shopId: shopB.tenantId };
    await expectOpaque404(await adminAs(shopB, "GET", "/v1/admin/collections", undefined, asPlatform), "no grant");

    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/acting-as`, { body: { reason: "support" } }),
      201,
      "acting-as grant",
    );
    const grant = await env.DB.prepare(
      "SELECT id FROM acting_as_grants WHERE tenant_id = ? AND platform_user_id = ? AND revoked_at IS NULL",
    )
      .bind(shopB.tenantId, world.platformUserId)
      .first<{ id: string }>();

    const created = await expectJson<AdminCollectionBody>(
      await adminAs(shopB, "POST", "/v1/admin/collections", { title: "Support" }, asPlatform),
      201,
      "create as platform",
    );
    expect(created.collection.createdBy).toBe(world.platformUserId);
    expect((await auditRows(shopB.tenantId, "collections.create")).at(-1)).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: { actingAsGrantId: grant?.id, handle: "support", published: false, type: "manual" },
      resourceId: created.collection.collectionId,
      resourceType: "collection",
    });
  });
});

describe("what a write must carry", () => {
  it.each([
    ["no body", undefined],
    ["an array", []],
    ["an empty object", {}],
    ["no title", { handle: "utan-titel" }],
    ["an unknown field", { productIds: [], title: "Okänd" }],
    ["a title that is not a string", { title: 7 }],
    ["a blank title", { title: "   " }],
    ["a title with a line break", { title: "a\nb" }],
    ["a title over 200 characters", { title: "x".repeat(201) }],
    ["a title with a lone surrogate", { title: "a\ud800" }],
    ["an upper-case handle", { handle: "Nytt", title: "Nytt" }],
    ["a handle with a space", { handle: "ny het", title: "Nytt" }],
    ["a handle with a double hyphen", { handle: "ny--het", title: "Nytt" }],
    ["a handle with a non-ASCII letter", { handle: "nyhét", title: "Nytt" }],
    ["a handle that is not a string", { handle: 1, title: "Nytt" }],
    ["a title with no address and no handle", { title: "!!!" }],
    ["an external reference with a slash", { externalRef: "gid://x/1", title: "Nytt" }],
    ["an external reference with a space", { externalRef: "a b", title: "Nytt" }],
    ["a dot-segment external reference", { externalRef: "..", title: "Nytt" }],
    ["an external reference over 128 characters", { externalRef: "1".repeat(129), title: "Nytt" }],
    ["an unknown type", { title: "Nytt", type: "automatic" }],
    ["a smart collection without a tag", { title: "Nytt", type: "smart" }],
    ["a smart collection with a null tag", { ruleTag: null, title: "Nytt", type: "smart" }],
    ["a manual collection with a tag", { ruleTag: "Nyhet", title: "Nytt" }],
    ["a tag with no address", { ruleTag: "!!!", title: "Nytt", type: "smart" }],
    ["a tag over 50 characters", { ruleTag: "x".repeat(51), title: "Nytt", type: "smart" }],
    ["published that is not a boolean", { published: 1, title: "Nytt" }],
    ["featured that is not a boolean", { featured: "yes", title: "Nytt" }],
    ["a fractional sort order", { sortOrder: 1.5, title: "Nytt" }],
    ["a sort order out of range", { sortOrder: 1_000_000_001, title: "Nytt" }],
    ["an object id with a slash", { imageObjectId: "a/b", title: "Nytt" }],
    ["a description over 5 000 characters", { description: "x".repeat(5_001), title: "Nytt" }],
    ["a description with a control character", { description: "a\u0007b", title: "Nytt" }],
  ])("refuses %s with 400 invalid_request", async (_label, body) => {
    const before = await auditCount();
    const response = await adminAs(shopA, "POST", "/v1/admin/collections", body);
    expect(await expectJson(response, 400, "create")).toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
    expect(await auditCount()).toBe(before);
  });

  it("refuses a malformed JSON body, and answers 413 for a body over 64 KiB", async () => {
    const malformed = await call(world, "POST", `${ADMIN}/v1/admin/collections`, {
      cookie: shopA.adminCookie,
      rawBody: '{"title":',
      shopId: shopA.tenantId,
    });
    expect(await expectJson(malformed, 400, "malformed")).toMatchObject({ error: { code: "invalid_request" } });

    const large = await adminAs(shopA, "POST", "/v1/admin/collections", { description: "x".repeat(70_000), title: "Stor" });
    expect(await expectJson(large, 413, "large")).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("refuses a cover that is not an active public product image of this shop", async () => {
    const foreign = await publicObject(shopB.tenantId, { kind: "product_media" });
    const branding = await publicObject(shopA.tenantId, { kind: "shop_branding" });
    const pending = await publicObject(shopA.tenantId, { activate: false, kind: "product_media" });
    const removed = await publicObject(shopA.tenantId, { kind: "product_media" });
    await removeObject(shopA.tenantId, removed);
    const before = await auditCount();
    for (const [label, objectId] of [
      ["another shop's", foreign],
      ["a branding image", branding],
      ["a pending upload", pending],
      ["a removed image", removed],
      ["an unknown object", "no-such-object"],
    ] as const) {
      const response = await adminAs(shopA, "POST", "/v1/admin/collections", { imageObjectId: objectId, title: `Omslag ${label}` });
      expect(await expectJson(response, 400, label)).toEqual({
        error: { code: "image_not_referencable", message: "The image is not a public product image of this shop" },
      });
    }
    expect(await auditCount()).toBe(before);
  });

  it("answers 409 when the handle or the external reference names another collection of the shop", async () => {
    const taken = await create(shopA, { externalRef: "EXT-409", handle: "tagen", title: "Tagen" });
    const before = await auditCount();
    for (const [label, body, code] of [
      ["the same handle", { handle: "tagen", title: "Annan" }, "handle_taken"],
      ["a handle derived from the title", { title: "Tagen" }, "handle_taken"],
      ["a handle equal to another's id", { handle: taken.collectionId, title: "Annan" }, "handle_taken"],
      ["the same external reference", { externalRef: "EXT-409", title: "Annan" }, "external_ref_taken"],
      ["an external reference equal to another's handle", { externalRef: "tagen", title: "Annan" }, "external_ref_taken"],
      ["an external reference equal to another's id", { externalRef: taken.collectionId, title: "Annan" }, "external_ref_taken"],
    ] as const) {
      const response = await adminAs(shopA, "POST", "/v1/admin/collections", body);
      expect(await expectJson(response, 409, label), label).toMatchObject({ error: { code } });
    }

    // Renaming another collection onto them is refused the same way.
    const other = await create(shopA, { title: "Annan samling" });
    for (const [label, body, code] of [
      ["handle → handle", { handle: "tagen" }, "handle_taken"],
      ["handle → external reference", { handle: "ext-409" }, null],
      ["external reference → handle", { externalRef: "tagen" }, "external_ref_taken"],
      ["external reference → id", { externalRef: taken.collectionId }, "external_ref_taken"],
    ] as const) {
      const response = await adminAs(shopA, "PATCH", `/v1/admin/collections/${other.collectionId}`, body);
      if (code === null) {
        // "ext-409" is not "EXT-409": the namespace compares exactly, as `:ref` does.
        expect(response.status, label).toBe(200);
        await response.body?.cancel();
      } else {
        expect(await expectJson(response, 409, label), label).toMatchObject({ error: { code } });
      }
    }
    expect((await collectionRow(taken.collectionId))?.handle).toBe("tagen");

    // Another shop may use every one of them.
    await create(shopB, { externalRef: "EXT-409", handle: "tagen", title: "Tagen" });
    // Written: `other`, its one admitted rename, shop B's collection.
    expect(await auditCount()).toBe(before + 3);
  });

  it("refuses a product list that is not a list of at most 500 distinct ids", async () => {
    const collection = await create(shopA, { title: "Listregler" });
    const member = await product(shopA);
    const path = `/v1/admin/collections/${collection.collectionId}/products`;
    for (const [label, body] of [
      ["an object", { productIds: [member] }],
      ["no body", undefined],
      ["a number in the list", [member, 7]],
      ["an empty id", [""]],
      ["an id over 128 characters", ["p".repeat(129)]],
      ["a repeated id", [member, member]],
      ["501 ids", Array.from({ length: 501 }, (_value, index) => `p-${index}`)],
    ] as const) {
      expect(await expectJson(await adminAs(shopA, "PUT", path, body), 400, label), label).toMatchObject({
        error: { code: "invalid_request" },
      });
    }
    expect(await memberIds(collection.collectionId)).toEqual([]);
  });

  it("refuses another shop's or an unknown product, and writes nothing", async () => {
    const collection = await create(shopA, { title: "Främmande" });
    const own = await product(shopA);
    await expectJson(await putProducts(shopA, collection.collectionId, [own]), 200, "first list");
    const foreign = await product(shopB);
    const before = await auditCount();
    const version = await catalogVersion(shopA);
    for (const list of [[own, foreign], ["no-such-product", own]]) {
      expect(await expectJson(await putProducts(shopA, collection.collectionId, list), 400, list.join()), list.join()).toEqual({
        error: { code: "product_not_found", message: "A listed product is not a product of this shop" },
      });
    }
    expect(await memberIds(collection.collectionId)).toEqual([own]);
    expect(await auditCount()).toBe(before);
    expect(await catalogVersion(shopA)).toBe(version);
  });

  it("refuses a product list for a smart collection with 409", async () => {
    const smart = await create(shopA, { ruleTag: "Nyhet", title: "Smart lista", type: "smart" });
    const response = await putProducts(shopA, smart.collectionId, [await product(shopA)]);
    expect(await expectJson(response, 409, "smart")).toEqual({
      error: { code: "collection_not_manual", message: "Only a manual collection has a product list" },
    });
    expect(await memberIds(smart.collectionId)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The happy paths
// ═══════════════════════════════════════════════════════════════════════════

describe("creating, reading, editing and deleting a collection", () => {
  it("creates a collection with every field, audited in the same batch, and reads it back", async () => {
    const cover = await publicObject(shopA.tenantId, { kind: "product_media", size: { height: 500, width: 400 } });
    const before = await catalogVersion(shopA);
    const created = await create(shopA, {
      description: "  Allt om Eva.\nMed två rader.  ",
      externalRef: "412345678",
      featured: true,
      handle: "eva-eastwood",
      imageObjectId: cover,
      published: true,
      sortOrder: 3,
      title: "  Eva Eastwood  ",
    });
    expect(created).toEqual({
      collectionId: expect.stringMatching(UUID),
      createdAt: expect.stringMatching(ISO),
      createdBy: shopA.adminUserId,
      description: "Allt om Eva.\nMed två rader.",
      externalRef: "412345678",
      featured: true,
      handle: "eva-eastwood",
      image: {
        contentType: "image/png",
        height: 500,
        objectId: cover,
        url: expect.stringMatching(new RegExp(`^${PUBLIC_BASE}/shops/${shopA.tenantId}/product_media/`)),
        width: 400,
      },
      imageObjectId: cover,
      path: "/samling/eva-eastwood",
      productCount: 0,
      productIds: [],
      published: true,
      ruleTag: null,
      sortOrder: 3,
      title: "Eva Eastwood",
      type: "manual",
      updatedAt: created.createdAt,
      updatedBy: shopA.adminUserId,
    });
    expect(await catalogVersion(shopA)).toBeGreaterThan(before);
    expect((await auditRows(shopA.tenantId, "collections.create")).at(-1)).toMatchObject({
      actorUserId: shopA.adminUserId,
      metadata: { handle: "eva-eastwood", published: true, type: "manual" },
      resourceId: created.collectionId,
      resourceType: "collection",
    });

    const read = await expectJson<AdminCollectionBody>(
      await adminAs(shopA, "GET", `/v1/admin/collections/${created.collectionId}`),
      200,
      "read",
    );
    expect(read.collection).toEqual(created);
  });

  it("derives the handle from the title as the source's form did, and starts as a draft", async () => {
    const created = await create(shopA, { title: "Rock & Roll Å Ö" });
    expect(created).toMatchObject({
      featured: false,
      handle: "rock-and-roll-a-o",
      path: "/samling/rock-and-roll-a-o",
      published: false,
      sortOrder: null,
      type: "manual",
    });
  });

  it("edits only the fields named, clears the nullable ones with null, and audits the fields", async () => {
    const cover = await publicObject(shopA.tenantId, { kind: "product_media" });
    const created = await create(shopA, {
      description: "Text",
      externalRef: "clear-me",
      imageObjectId: cover,
      title: "Redigera",
    });
    const patched = await patch(shopA, created.collectionId, {
      description: null,
      externalRef: null,
      featured: true,
      imageObjectId: null,
      sortOrder: -2,
    });
    expect(patched).toMatchObject({
      description: null,
      externalRef: null,
      featured: true,
      handle: "redigera",
      image: null,
      imageObjectId: null,
      published: false,
      sortOrder: -2,
      title: "Redigera",
    });
    expect(patched.updatedAt >= created.updatedAt).toBe(true);
    expect((await auditRows(shopA.tenantId, "collections.update")).at(-1)).toMatchObject({
      metadata: { fields: ["externalRef", "description", "imageObjectId", "featured", "sortOrder"], handle: "redigera" },
      resourceId: created.collectionId,
    });

    const renamed = await patch(shopA, created.collectionId, { handle: "redigerad", externalRef: "", title: "Redigerad" });
    expect(renamed).toMatchObject({ externalRef: null, handle: "redigerad", path: "/samling/redigerad", title: "Redigerad" });
  });

  it("a cover removed since is kept on a write that does not change it, and shows as none", async () => {
    const cover = await publicObject(shopA.tenantId, { kind: "product_media" });
    const created = await create(shopA, { imageObjectId: cover, title: "Borttagen bild" });
    await removeObject(shopA.tenantId, cover);
    const patched = await patch(shopA, created.collectionId, { imageObjectId: cover, title: "Borttagen bild 2" });
    expect(patched).toMatchObject({ image: null, imageObjectId: cover, title: "Borttagen bild 2" });

    const other = await create(shopA, { title: "Ny bild" });
    expect(
      await expectJson(
        await adminAs(shopA, "PATCH", `/v1/admin/collections/${other.collectionId}`, { imageObjectId: cover }),
        400,
        "set a removed cover",
      ),
    ).toMatchObject({ error: { code: "image_not_referencable" } });
  });

  it("turns a manual collection smart (its members go) and back (its tag goes)", async () => {
    const created = await create(shopA, { title: "Byt typ" });
    const members = [await product(shopA), await product(shopA)];
    await expectJson(await putProducts(shopA, created.collectionId, members), 200, "members");

    expect(
      await expectJson(
        await adminAs(shopA, "PATCH", `/v1/admin/collections/${created.collectionId}`, { type: "smart" }),
        400,
        "smart without a tag",
      ),
    ).toMatchObject({ error: { code: "invalid_request" } });
    expect(await memberIds(created.collectionId)).toEqual(members);

    const smart = await patch(shopA, created.collectionId, { ruleTag: "  Nyhet  ", type: "smart" });
    expect(smart).toMatchObject({ productCount: 0, productIds: [], ruleTag: "Nyhet", type: "smart" });
    expect(await memberIds(created.collectionId)).toEqual([]);

    expect(await patch(shopA, created.collectionId, { ruleTag: "Rea" })).toMatchObject({ ruleTag: "Rea", type: "smart" });
    expect(
      await expectJson(
        await adminAs(shopA, "PATCH", `/v1/admin/collections/${created.collectionId}`, { ruleTag: null }),
        400,
        "smart loses its tag",
      ),
    ).toMatchObject({ error: { code: "invalid_request" } });

    const manual = await patch(shopA, created.collectionId, { type: "manual" });
    expect(manual).toMatchObject({ ruleTag: null, type: "manual" });
    expect(
      await expectJson(
        await adminAs(shopA, "PATCH", `/v1/admin/collections/${created.collectionId}`, { ruleTag: "Nyhet" }),
        400,
        "a tag on a manual collection",
      ),
    ).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("sets the product list in order, replaces it whole, clears it, and audits the count", async () => {
    const collection = await create(shopA, { title: "Ordning" });
    const [first, second, third] = [await product(shopA), await product(shopA), await product(shopA)];
    // A draft and an archived product are the shop's own: the admin keeps them.
    const draft = await product(shopA, { published: false, status: "draft" });
    const archived = await product(shopA, { status: "archived" });

    let version = await catalogVersion(shopA);
    const set = await expectJson<AdminCollectionBody>(
      await putProducts(shopA, collection.collectionId, [third, first, draft, archived, second]),
      200,
      "set",
    );
    expect(set.collection).toMatchObject({ productCount: 5, productIds: [third, first, draft, archived, second] });
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);
    expect(set.collection.updatedAt >= collection.updatedAt).toBe(true);
    expect((await auditRows(shopA.tenantId, "collections.products")).at(-1)).toMatchObject({
      metadata: { count: 5 },
      resourceId: collection.collectionId,
      resourceType: "collection",
    });

    const replaced = await expectJson<AdminCollectionBody>(
      await putProducts(shopA, collection.collectionId, [second, first]),
      200,
      "replace",
    );
    expect(replaced.collection.productIds).toEqual([second, first]);

    version = await catalogVersion(shopA);
    const cleared = await expectJson<AdminCollectionBody>(await putProducts(shopA, collection.collectionId, []), 200, "clear");
    expect(cleared.collection).toMatchObject({ productCount: 0, productIds: [] });
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);
  });

  it("takes 500 products in one list", async () => {
    const collection = await create(shopA, { title: "Femhundra" });
    const ids = await bulkProducts(shopA, 500);
    const set = await expectJson<AdminCollectionBody>(await putProducts(shopA, collection.collectionId, ids), 200, "500");
    expect(set.collection.productCount).toBe(500);
    expect(set.collection.productIds).toEqual(ids);
  }, 120_000);

  it("deletes a collection and its members, audited, and answers 404 after", async () => {
    const collection = await create(shopA, { title: "Ta bort" });
    await expectJson(await putProducts(shopA, collection.collectionId, [await product(shopA)]), 200, "members");
    const version = await catalogVersion(shopA);
    const response = await adminAs(shopA, "DELETE", `/v1/admin/collections/${collection.collectionId}`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await collectionRow(collection.collectionId)).toBeNull();
    expect(await memberIds(collection.collectionId)).toEqual([]);
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);
    expect((await auditRows(shopA.tenantId, "collections.delete")).at(-1)).toMatchObject({
      metadata: { handle: "ta-bort", published: false, type: "manual" },
      resourceId: collection.collectionId,
    });
    await expectOpaque404(await adminAs(shopA, "GET", `/v1/admin/collections/${collection.collectionId}`), "after delete");
    await expectOpaque404(await adminAs(shopA, "DELETE", `/v1/admin/collections/${collection.collectionId}`), "delete again");
  });
});

describe("the admin list", () => {
  let shopList: Tenant;

  beforeAll(async () => {
    // A shop of its own: the list is compared whole.
    shopList = shopC;
    const cover = await publicObject(shopList.tenantId, { kind: "product_media" });
    await create(shopList, { sortOrder: 2, title: "Beta" });
    await create(shopList, { sortOrder: 1, title: "Gamma" });
    await create(shopList, { title: "alfa" });
    await create(shopList, { imageObjectId: cover, title: "Delta" });
    await create(shopList, { handle: "alfa-smart", published: true, ruleTag: "Nyhet", sortOrder: 2, title: "Alfa", type: "smart" });
    const manual = await create(shopList, { title: "Epsilon" });
    await expectJson(
      await adminAs(shopList, "PUT", `/v1/admin/collections/${manual.collectionId}/products`, [
        await product(shopList),
        await product(shopList),
      ]),
      200,
      "members",
    );
  }, 120_000);

  interface ListBody {
    collections: Array<Record<string, unknown> & { title: string }>;
    nextCursor: string | null;
  }

  it("lists every collection in the display order, drafts included, with the summary shape", async () => {
    const body = await expectJson<ListBody>(await adminAs(shopList, "GET", "/v1/admin/collections"), 200, "list");
    // Sort order first (NULL last), then the title case-insensitively, then the id.
    expect(body.collections.map((row) => row.title)).toEqual(["Gamma", "Alfa", "Beta", "alfa", "Delta", "Epsilon"]);
    expect(body.nextCursor).toBeNull();
    expect(Object.keys(body.collections[0] ?? {}).sort()).toEqual([
      "collectionId",
      "createdAt",
      "externalRef",
      "featured",
      "handle",
      "image",
      "imageObjectId",
      "path",
      "productCount",
      "published",
      "ruleTag",
      "sortOrder",
      "title",
      "type",
      "updatedAt",
    ]);
    expect(body.collections.find((row) => row.title === "Epsilon")).toMatchObject({ productCount: 2 });
    expect(body.collections.find((row) => row.title === "Delta")?.image).toMatchObject({ contentType: "image/png" });
    expect(body.collections.find((row) => row.title === "Alfa")).toMatchObject({
      productCount: 0,
      published: true,
      ruleTag: "Nyhet",
      type: "smart",
    });
  });

  it("walks every collection once with the cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=4" : `?limit=4&cursor=${encodeURIComponent(cursor)}`;
      const body: ListBody = await expectJson<ListBody>(
        await adminAs(shopList, "GET", `/v1/admin/collections${query}`),
        200,
        `page ${pages}`,
      );
      seen.push(...body.collections.map((row) => row.title));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(2);
    expect(seen).toEqual(["Gamma", "Alfa", "Beta", "alfa", "Delta", "Epsilon"]);
  });

  it.each([
    ["an unknown parameter", "?published=1"],
    ["a repeated limit", "?limit=1&limit=2"],
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
    ["a limit that is not a number", "?limit=ten"],
    ["a cursor this route never wrote", "?cursor=abc"],
    ["a cursor with padding", `?cursor=${encodeURIComponent("WzEsImEiLCJiIl0=")}`],
  ])("refuses %s with 400", async (_label, query) => {
    await expectJson(await adminAs(shopList, "GET", `/v1/admin/collections${query}`), 400, query);
  });
});
