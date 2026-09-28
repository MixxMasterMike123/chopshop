import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import {
  COLLECTIONS_IP_LIMIT,
  COLLECTIONS_IP_SCOPE,
  COLLECTIONS_IP_WINDOW_MS,
  handlePublicCollectionRoute,
  handlePublicCollectionsRoute,
} from "../src/routes/public-collections";
import { ADMIN, call, type CallOptions } from "./slice-harness";
import {
  attachImage,
  type ProductSeed,
  publicObject,
  removeObject,
  seedProduct,
} from "./storefront-fixtures";
import { expectJson, platform, SliceWorld, type Tenant, tenantWorld } from "./tenant-fixtures";

/**
 * CP4-B — collections, part 2: the public reads (GET /v1/collections,
 * GET /v1/collections/:ref) for the storefront and a shop's own website (D87).
 * The tenant is the hostname; only a PUBLISHED collection of an ACTIVE,
 * PUBLISHED shop answers; its products come from builder A's public
 * functions only (THE predicate); every answer is cross-origin readable;
 * the rate limit counts per caller.
 */

const NOT_FOUND = { error: { code: "not_found", message: "Collection not found" } };
const RATE_LIMITED = { error: { code: "rate_limited", message: "Too many requests" } };
const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;

interface PublicCollection {
  description: string | null;
  externalRef: string | null;
  featured: boolean;
  handle: string;
  image: { contentType: string; height: number | null; objectId: string; url: string; width: number | null } | null;
  path: string;
  sortOrder: number | null;
  title: string;
}

interface ProductSummary extends Record<string, unknown> {
  name: string;
  productId: string;
}

interface DetailBody {
  collection: PublicCollection;
  nextCursor: string | null;
  products: ProductSummary[];
}

interface ListBody {
  collections: PublicCollection[];
  nextCursor: string | null;
}

function admin(tenant: Tenant, method: string, path: string, body?: unknown): Promise<Response> {
  return call(world, method, `${ADMIN}${path}`, { body, cookie: tenant.adminCookie, shopId: tenant.tenantId });
}

async function createCollection(tenant: Tenant, body: Record<string, unknown>): Promise<string> {
  const created = await expectJson<{ collection: { collectionId: string } }>(
    await admin(tenant, "POST", "/v1/admin/collections", body),
    201,
    `create ${String(body.title)}`,
  );
  return created.collection.collectionId;
}

async function setMembers(tenant: Tenant, collectionId: string, productIds: readonly string[]): Promise<void> {
  await expectJson(
    await admin(tenant, "PUT", `/v1/admin/collections/${collectionId}/products`, productIds),
    200,
    `members of ${collectionId}`,
  );
}

async function patchCollection(tenant: Tenant, collectionId: string, body: Record<string, unknown>): Promise<void> {
  await expectJson(await admin(tenant, "PATCH", `/v1/admin/collections/${collectionId}`, body), 200, `patch ${collectionId}`);
}

function visit(tenant: Tenant, path: string, options: CallOptions = {}): Promise<Response> {
  return call(world, "GET", `${tenant.origin}${path}`, options);
}

async function readCollection(tenant: Tenant, ref: string, query = ""): Promise<DetailBody> {
  return expectJson<DetailBody>(await visit(tenant, `/v1/collections/${ref}${query}`), 200, `${ref}${query}`);
}

async function expectNotFound(response: Response, label: string): Promise<void> {
  expect(response.headers.get("access-control-allow-origin"), label).toBe("*");
  expect(response.headers.get("etag"), label).toBeNull();
  expect(await expectJson(response, 404, label), label).toEqual(NOT_FOUND);
}

let skuCounter = 0;
function product(tenant: Tenant, extra: Partial<ProductSeed> = {}): Promise<string> {
  skuCounter += 1;
  return seedProduct(tenant.tenantId, { name: `Produkt ${skuCounter}`, sku: `PC-${skuCounter}`, ...extra });
}

/** `count` product rows WITHOUT a publication — never public — in one batch. */
async function hiddenProducts(tenant: Tenant, count: number): Promise<string[]> {
  skuCounter += 1;
  const ids = Array.from({ length: count }, (_value, index) => `hidden-${tenant.tenantId}-${skuCounter}-${index}`);
  const now = Date.now();
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor, currency, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, 9900, 'SEK', ?, ?)`,
      ).bind(id, tenant.tenantId, `SKU-${id}`, `Dold ${id}`, now, now),
    ),
  );
  return ids;
}

async function unpublishProduct(productId: string): Promise<void> {
  await env.DB.prepare("UPDATE product_publications SET published = 0 WHERE product_id = ?").bind(productId).run();
}

/** A's own summary of each product, from GET /v1/products (every public product of a small shop). */
async function summariesFromA(tenant: Tenant): Promise<Map<string, ProductSummary>> {
  const body = await expectJson<{ products: ProductSummary[] }>(await visit(tenant, "/v1/products"), 200, "A's list");
  return new Map(body.products.map((summary) => [summary.productId, summary]));
}

function names(body: DetailBody): string[] {
  return body.products.map((summary) => summary.name);
}

/**
 * A fixed instant in the PREVIOUS hour: every call of a rate-limit sequence
 * lands in one one-minute window, and the instant is always in the past.
 * Each test takes its own minute.
 */
function pinnedMinute(minute: number): number {
  return Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS + minute * MINUTE_MS + 5_000;
}

function publicRequest(
  host: string,
  path: string,
  options: { headers?: Record<string, string>; ip?: string | null; method?: string } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.ip !== null) {
    headers.set("cf-connecting-ip", options.ip ?? "198.51.100.1");
  }
  return new Request(`https://${host}${path}`, { headers, method: options.method ?? "GET" });
}

// The fixtures of the shared reads.
const shared = {
  archived: "",
  cover: "",
  draft: "",
  foreign: "",
  keps: "",
  mugg: "",
  nyheter: "",
  takenDown: "",
  troja: "",
  vanlig: "",
  manualId: "",
  smartId: "",
};

beforeAll(async () => {
  const setup = await tenantWorld("pc", 3);
  world = setup.world;
  [shopA, shopB, shopC] = setup.tenants as [Tenant, Tenant, Tenant];

  shared.cover = await publicObject(shopA.tenantId, { kind: "product_media", size: { height: 500, width: 400 } });
  const muggImage = await publicObject(shopA.tenantId, { fileName: "mugg.png", kind: "product_media" });
  shared.mugg = await product(shopA, { name: "Mugg", sortOrder: 1, tags: ["Nyhet"] });
  await attachImage(shopA.tenantId, shared.mugg, muggImage, 0, "Muggen");
  shared.troja = await product(shopA, { name: "Tröja", tags: ["nyhet"] });
  shared.keps = await product(shopA, { name: "Keps", sortOrder: 2, tags: ["NYHET"] });
  shared.draft = await product(shopA, { name: "Utkast", published: false, status: "draft", tags: ["Nyhet"] });
  shared.archived = await product(shopA, { name: "Arkiverad", status: "archived", tags: ["Nyhet"] });
  shared.takenDown = await product(shopA, { name: "Nedtagen", tags: ["Nyhet"], takenDown: true });
  shared.nyheter = await product(shopA, { name: "Nyheter-produkt", tags: ["Nyheter"] });
  shared.vanlig = await product(shopA, { name: "Vanlig" });
  shared.foreign = await product(shopB, { name: "Annans", tags: ["Nyhet"] });

  shared.manualId = await createCollection(shopA, {
    description: "Det nya",
    externalRef: "412345678",
    featured: true,
    handle: "nytt",
    imageObjectId: shared.cover,
    published: true,
    sortOrder: 1,
    title: "Nytt",
  });
  await setMembers(shopA, shared.manualId, [
    shared.vanlig,
    shared.draft,
    shared.mugg,
    shared.archived,
    shared.takenDown,
    shared.troja,
  ]);
  shared.smartId = await createCollection(shopA, { published: true, ruleTag: "Nyhet", title: "Smart", type: "smart" });
  await createCollection(shopA, { published: true, ruleTag: "Finns inte", title: "Tom", type: "smart" });
  await createCollection(shopA, { handle: "utkast-samling", title: "Utkast samling" });

  // Shop B has a collection with the SAME handle and external reference.
  const foreignCollection = await createCollection(shopB, {
    externalRef: "412345678",
    handle: "nytt",
    published: true,
    title: "Annans nytt",
  });
  await setMembers(shopB, foreignCollection, [shared.foreign]);
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the refusals", () => {
  it("an unknown ref, a draft collection and another shop's id answer the one 404, with no ETag", async () => {
    const draftId = (
      await expectJson<{ collections: Array<{ collectionId: string; handle: string }> }>(
        await admin(shopA, "GET", "/v1/admin/collections"),
        200,
        "admin list",
      )
    ).collections.find((row) => row.handle === "utkast-samling")?.collectionId;
    const foreignId = (
      await expectJson<{ collections: Array<{ collectionId: string }> }>(await admin(shopB, "GET", "/v1/admin/collections"), 200, "B")
    ).collections[0]?.collectionId;
    for (const ref of ["okand", "utkast-samling", draftId, foreignId, "%ZZ", "a%2Fb", "x".repeat(201)]) {
      await expectNotFound(await visit(shopA, `/v1/collections/${ref ?? "missing"}`), `ref ${String(ref)}`);
    }
  });

  it("an unknown host answers the one 404 on both routes", async () => {
    for (const path of ["/v1/collections", "/v1/collections/nytt"]) {
      await expectNotFound(await call(world, "GET", `https://no-shop.storefront.invalid${path}`), path);
    }
  });

  it("an unpublished or suspended shop answers the one 404 on both routes, and comes back", async () => {
    const id = await createCollection(shopB, { handle: "synlig", published: true, title: "Synlig" });
    expect((await readCollection(shopB, "synlig")).collection.title).toBe("Synlig");
    const refs = ["/v1/collections", "/v1/collections/synlig", `/v1/collections/${id}`];

    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/unpublish`), 200, "unpublish");
    for (const path of refs) {
      await expectNotFound(await visit(shopB, path), `unpublished ${path}`);
    }
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/publish`), 200, "publish");
    expect((await readCollection(shopB, "synlig")).collection.title).toBe("Synlig");

    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/suspend`), 200, "suspend");
    for (const path of refs) {
      await expectNotFound(await visit(shopB, path), `suspended ${path}`);
    }
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/activate`), 200, "activate");
    expect((await readCollection(shopB, "synlig")).collection.title).toBe("Synlig");
  });

  it.each([
    ["/v1/collections?published=0", "an unknown parameter on the list"],
    ["/v1/collections?limit=1&limit=2", "a repeated limit"],
    ["/v1/collections?limit=0", "limit 0"],
    ["/v1/collections?limit=101", "limit 101"],
    ["/v1/collections?cursor=abc", "a list cursor this route never wrote"],
    ["/v1/collections/nytt?tag=nyhet", "an unknown parameter on one collection"],
    ["/v1/collections/nytt?limit=abc", "a limit that is not a number"],
    ["/v1/collections/nytt?cursor=500", "a position past the last"],
    ["/v1/collections/nytt?cursor=01", "a position with a leading zero"],
    ["/v1/collections/nytt?cursor=abc", "a cursor of neither kind"],
    ["/v1/collections/okand?cursor=abc", "a malformed cursor for an unknown ref"],
  ])("answers 400 for %s (%s)", async (path, label) => {
    const response = await visit(shopA, path);
    expect(response.headers.get("access-control-allow-origin"), label).toBe("*");
    expect(await expectJson(response, 400, label)).toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
  });

  it("answers 400 for a cursor of the other kind of collection", async () => {
    const smartPage = await readCollection(shopA, "smart", "?limit=1");
    expect(smartPage.nextCursor).not.toBeNull();
    await expectJson(
      await visit(shopA, `/v1/collections/nytt?cursor=${encodeURIComponent(smartPage.nextCursor ?? "")}`),
      400,
      "display cursor on a manual collection",
    );
    await expectJson(await visit(shopA, "/v1/collections/smart?cursor=1"), 400, "position cursor on a smart collection");
  });

  it("methods the routes do not claim fall through to the 404", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/v1/collections", "/v1/collections/nytt"]) {
        const response = await call(world, method, `${shopA.origin}${path}`, { body: {} });
        expect(response.status, `${method} ${path}`).toBe(404);
        await response.body?.cancel();
      }
    }
    const head = await call(world, "HEAD", `${shopA.origin}/v1/collections/nytt`);
    expect(head.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the list", () => {
  it("answers the published collections in the display order, public fields only", async () => {
    const response = await visit(shopA, "/v1/collections");
    expect(response.headers.get("etag")).toMatch(/^"\d+"$/);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const body = await expectJson<ListBody>(response, 200, "list");
    expect(body.nextCursor).toBeNull();
    expect(body.collections.map((row) => row.handle)).toEqual(["nytt", "smart", "tom"]);
    expect(body.collections[0]).toEqual({
      description: "Det nya",
      externalRef: "412345678",
      featured: true,
      handle: "nytt",
      image: {
        contentType: "image/png",
        height: 500,
        objectId: shared.cover,
        url: expect.stringMatching(/^https:\/\/public-objects\.test\.invalid\/shops\/pc-a\/product_media\//),
        width: 400,
      },
      path: "/samling/nytt",
      sortOrder: 1,
      title: "Nytt",
    });
    expect(body.collections[1]).toEqual({
      description: null,
      externalRef: null,
      featured: false,
      handle: "smart",
      image: null,
      path: "/samling/smart",
      sortOrder: null,
      title: "Smart",
    });
    // Nothing of the admin's: no id, no type, no tag, no state, no author.
    const text = JSON.stringify(body);
    for (const key of ["collectionId", "type", "ruleTag", "published", "createdBy", "productCount", "productIds"]) {
      expect(text, key).not.toContain(`"${key}"`);
    }
    expect(text).not.toContain(shared.manualId);
  });

  it("walks every published collection once with the cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=1" : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const body: ListBody = await expectJson<ListBody>(await visit(shopA, `/v1/collections${query}`), 200, `page ${pages}`);
      seen.push(...body.collections.map((row) => row.handle));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(["nytt", "smart", "tom"]);
    expect(pages).toBe(3);
  });

  it("an empty shop answers an empty list", async () => {
    expect(await expectJson(await visit(shopC, "/v1/collections"), 200, "empty")).toEqual({
      collections: [],
      nextCursor: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("one collection", () => {
  it("answers the same collection by handle, external reference and id, with ONLY its public products", async () => {
    const byHandle = await readCollection(shopA, "nytt");
    expect(await readCollection(shopA, "412345678")).toEqual(byHandle);
    expect(await readCollection(shopA, shared.manualId)).toEqual(byHandle);
    expect(byHandle.collection).toMatchObject({ handle: "nytt", path: "/samling/nytt", title: "Nytt" });
    expect(byHandle.nextCursor).toBeNull();

    // The admin's order; the draft, the archived and the taken-down member are absent.
    expect(byHandle.products.map((summary) => summary.productId)).toEqual([shared.vanlig, shared.mugg, shared.troja]);
    // Each summary IS builder A's (image with alt, path, lowest price …).
    const fromA = await summariesFromA(shopA);
    for (const summary of byHandle.products) {
      expect(summary).toEqual(fromA.get(summary.productId));
    }
    expect(byHandle.products[1]).toMatchObject({
      image: { alt: "Muggen", contentType: "image/png" },
      lowestPriceMinor: 19_900,
      path: expect.stringMatching(/^\/product\//),
    });
    // Shop B's collection of the same handle and external reference is never answered here.
    expect(JSON.stringify(byHandle)).not.toContain(shared.foreign);
    expect((await readCollection(shopB, "412345678")).products.map((summary) => summary.productId)).toEqual([
      shared.foreign,
    ]);
  });

  it("a smart collection holds the public products whose tag has its tag's address, in the display order", async () => {
    const body = await readCollection(shopA, "smart");
    // "Nyhet", "nyhet", "NYHET" share the address "nyhet"; "Nyheter" does not. Sort order 1, 2, then none.
    expect(names(body)).toEqual(["Mugg", "Keps", "Tröja"]);
    expect(body.nextCursor).toBeNull();
    const fromA = await summariesFromA(shopA);
    for (const summary of body.products) {
      expect(summary).toEqual(fromA.get(summary.productId));
    }
    expect(names(await readCollection(shopA, "tom"))).toEqual([]);
  });

  it("pages a smart collection with A's cursor", async () => {
    const first = await readCollection(shopA, "smart", "?limit=2");
    expect(names(first)).toEqual(["Mugg", "Keps"]);
    const second = await readCollection(shopA, "smart", `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    expect(names(second)).toEqual(["Tröja"]);
    expect(second.nextCursor).toBeNull();
  });

  it("a product taken out of the catalogue leaves the answer, never breaks it; the ETag moves", async () => {
    const [kept, archived, downed, hidden] = [
      await product(shopA, { name: "Kvar" }),
      await product(shopA, { name: "Ska arkiveras" }),
      await product(shopA, { name: "Ska tas ned" }),
      await product(shopA, { name: "Ska döljas" }),
    ];
    const id = await createCollection(shopA, { handle: "ur-katalogen", published: true, title: "Ur katalogen" });
    await setMembers(shopA, id, [archived, kept, downed, hidden]);
    const before = await visit(shopA, "/v1/collections/ur-katalogen");
    const etag = before.headers.get("etag");
    expect(names(await expectJson<DetailBody>(before, 200, "before"))).toEqual([
      "Ska arkiveras",
      "Kvar",
      "Ska tas ned",
      "Ska döljas",
    ]);

    await env.DB.prepare("UPDATE products SET status = 'archived' WHERE product_id = ?").bind(archived).run();
    await env.DB.prepare("UPDATE products SET takedown_at = ? WHERE product_id = ?").bind(new Date().toISOString(), downed).run();
    await unpublishProduct(hidden);

    const after = await visit(shopA, "/v1/collections/ur-katalogen", { headers: { "if-none-match": etag ?? "" } });
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(names(await expectJson<DetailBody>(after, 200, "after"))).toEqual(["Kvar"]);
  });

  it("a removed cover (D93) is answered as none, and the ETag moves", async () => {
    const cover = await publicObject(shopA.tenantId, { kind: "product_media" });
    await createCollection(shopA, { handle: "omslag", imageObjectId: cover, published: true, title: "Omslag" });
    const before = await visit(shopA, "/v1/collections/omslag");
    const etag = before.headers.get("etag");
    expect((await expectJson<DetailBody>(before, 200, "before")).collection.image).toMatchObject({ objectId: cover });

    await removeObject(shopA.tenantId, cover);
    const after = await visit(shopA, "/v1/collections/omslag", { headers: { "if-none-match": etag ?? "" } });
    expect(after.headers.get("etag")).not.toBe(etag);
    expect((await expectJson<DetailBody>(after, 200, "after")).collection.image).toBeNull();
  });

  it("an unpublished collection disappears, and comes back", async () => {
    const id = await createCollection(shopA, { handle: "av-och-pa", published: true, title: "Av och på" });
    expect((await readCollection(shopA, "av-och-pa")).collection.title).toBe("Av och på");
    await patchCollection(shopA, id, { published: false });
    await expectNotFound(await visit(shopA, "/v1/collections/av-och-pa"), "unpublished");
    await expectNotFound(await visit(shopA, `/v1/collections/${id}`), "unpublished by id");
    expect(
      (await expectJson<ListBody>(await visit(shopA, "/v1/collections"), 200, "list")).collections.map((row) => row.handle),
    ).not.toContain("av-och-pa");
    await patchCollection(shopA, id, { published: true });
    expect((await readCollection(shopA, "av-och-pa")).collection.title).toBe("Av och på");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("paging a manual collection", () => {
  it("walks the public members once, in order, while one is unpublished between two pages", async () => {
    const members: string[] = [];
    const publicOnes: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const isPublic = index % 3 !== 1;
      const id = await product(shopA, { name: `Sida ${String(index).padStart(2, "0")}`, published: isPublic });
      members.push(id);
      if (isPublic) {
        publicOnes.push(id);
      }
    }
    const id = await createCollection(shopA, { handle: "sidor", published: true, title: "Sidor" });
    await setMembers(shopA, id, members);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let unpublished: string | null = null;
    do {
      const query: string = cursor === null ? "?limit=4" : `?limit=4&cursor=${cursor}`;
      const body: DetailBody = await readCollection(shopA, "sidor", query);
      expect(body.products.length).toBeLessThanOrEqual(4);
      seen.push(...body.products.map((summary) => summary.productId));
      cursor = body.nextCursor;
      pages += 1;
      if (pages === 2) {
        // A member AHEAD of the cursor stops being public between two reads.
        unpublished = publicOnes[12] ?? null;
        await unpublishProduct(unpublished ?? "");
      }
    } while (cursor !== null && pages < 20);

    const expected = publicOnes.filter((productId) => productId !== unpublished);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("finds the public members behind more hidden ones than one call of A takes, and says 'more' only when there is", async () => {
    const hidden = await hiddenProducts(shopA, 150);
    const visible = [
      await product(shopA, { name: "Bakom ett" }),
      await product(shopA, { name: "Bakom två" }),
      await product(shopA, { name: "Bakom tre" }),
    ];
    const id = await createCollection(shopA, { handle: "bakom", published: true, title: "Bakom" });
    await setMembers(shopA, id, [...hidden.slice(0, 120), visible[0] as string, ...hidden.slice(120), visible[1] as string, visible[2] as string]);

    const first = await readCollection(shopA, "bakom", "?limit=2");
    expect(names(first)).toEqual(["Bakom ett", "Bakom två"]);
    expect(first.nextCursor).toBe("151");
    const second = await readCollection(shopA, "bakom", `?limit=2&cursor=${first.nextCursor ?? ""}`);
    expect(names(second)).toEqual(["Bakom tre"]);
    expect(second.nextCursor).toBeNull();

    // Exactly as many public members as the limit: no "more".
    const exact = await readCollection(shopA, "bakom", "?limit=3");
    expect(names(exact)).toEqual(["Bakom ett", "Bakom två", "Bakom tre"]);
    expect(exact.nextCursor).toBeNull();
  });

  it("answers 24 products by default and 100 at most", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      ids.push(await product(shopA, { name: `Standard ${String(index).padStart(2, "0")}` }));
    }
    const id = await createCollection(shopA, { handle: "standard", published: true, title: "Standard" });
    await setMembers(shopA, id, ids);
    const first = await readCollection(shopA, "standard");
    expect(first.products).toHaveLength(24);
    expect(first.nextCursor).toBe("23");
    const rest = await readCollection(shopA, "standard", `?cursor=${first.nextCursor ?? ""}`);
    expect(rest.products).toHaveLength(6);
    expect(rest.nextCursor).toBeNull();
    expect((await readCollection(shopA, "standard", "?limit=100")).products).toHaveLength(30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the ETag", () => {
  it("answers If-None-Match with a bodiless 304 until the collection, its members or a member product change", async () => {
    const member = await product(shopA, { name: "Etag-produkt" });
    const id = await createCollection(shopA, { handle: "etag", published: true, title: "Etag" });
    await setMembers(shopA, id, [member]);

    const fresh = async (): Promise<string> => {
      const response = await visit(shopA, "/v1/collections/etag");
      expect(response.status).toBe(200);
      await response.body?.cancel();
      return response.headers.get("etag") ?? "";
    };
    let etag = await fresh();
    const cached = await visit(shopA, "/v1/collections/etag", { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("etag")).toBe(etag);
    expect(cached.headers.get("access-control-allow-origin")).toBe("*");

    const listEtag = (await visit(shopA, "/v1/collections")).headers.get("etag") ?? "";
    expect((await visit(shopA, "/v1/collections", { headers: { "if-none-match": listEtag } })).status).toBe(304);

    for (const [label, change] of [
      ["a collection edit", () => patchCollection(shopA, id, { description: "Ändrad" })],
      ["a member list", () => setMembers(shopA, id, [])],
      ["a member again", () => setMembers(shopA, id, [member])],
      ["a member product unpublished", () => unpublishProduct(member)],
    ] as const) {
      await change();
      const response = await visit(shopA, "/v1/collections/etag", { headers: { "if-none-match": etag } });
      expect(response.status, label).toBe(200);
      await response.body?.cancel();
      expect(response.headers.get("etag"), label).not.toBe(etag);
      etag = response.headers.get("etag") ?? "";
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("cross-origin reads (D87)", () => {
  it("every answer of the two routes says Access-Control-Allow-Origin: *, never with credentials, never the caller's origin", async () => {
    const answers = [
      await visit(shopA, "/v1/collections", { headers: { origin: "https://artist.example" } }),
      await visit(shopA, "/v1/collections/nytt", { headers: { origin: "https://artist.example" } }),
      await visit(shopA, "/v1/collections/okand", { headers: { origin: "https://artist.example" } }),
      await visit(shopA, "/v1/collections?limit=0", { headers: { origin: "https://artist.example" } }),
    ];
    for (const response of answers) {
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-expose-headers")).toBe("ETag, Retry-After");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("vary")).toBeNull();
      await response.body?.cancel();
    }
  });

  it("answers a preflight with 204 without touching the database", async () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("the database was touched");
        },
      },
    );
    const noDatabase = world.with({ DB: untouchable });
    for (const path of ["/v1/collections", "/v1/collections/nytt"]) {
      const response = await call(world, "OPTIONS", `${shopA.origin}${path}`, {
        env: noDatabase,
        headers: { "access-control-request-method": "GET", origin: "https://artist.example" },
      });
      expect(response.status, path).toBe(204);
      expect(await response.text()).toBe("");
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "access-control-allow-headers": "If-None-Match",
        "access-control-allow-methods": "GET",
        "access-control-allow-origin": "*",
        "access-control-max-age": "86400",
      });
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    // The GET itself does need it: the same env makes it fail.
    await expect(
      call(world, "GET", `${shopA.origin}/v1/collections`, { env: noDatabase }),
    ).rejects.toThrow(/the database was touched/);
  });

  it("no other public route answers cross-origin", async () => {
    for (const path of ["/v1/products", "/v1/storefront", "/v1/pages"]) {
      const response = await visit(shopA, path, { headers: { origin: "https://artist.example" } });
      expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
      await response.body?.cancel();
    }
    const preflight = await call(world, "OPTIONS", `${shopA.origin}/v1/products`);
    expect(preflight.status).toBe(404);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    await preflight.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the rate limit", () => {
  it(`allows ${COLLECTIONS_IP_LIMIT} requests a minute per caller on the two routes together, refused ones included`, async () => {
    const now = pinnedMinute(1);
    const ip = "198.51.100.10";
    const statuses: number[] = [];
    const paths = ["/v1/collections", "/v1/collections/nytt", "/v1/collections/okand", "/v1/collections?limit=0"];
    for (let index = 0; index < COLLECTIONS_IP_LIMIT; index += 1) {
      const path = paths[index % paths.length] ?? "";
      const handler = path.startsWith("/v1/collections/") ? handlePublicCollectionRoute : handlePublicCollectionsRoute;
      const response = await handler(world.env, publicRequest(shopA.host, path, { ip }), { now });
      statuses.push(response.status);
      await response.body?.cancel();
    }
    expect(new Set(statuses)).toEqual(new Set([200, 404, 400]));

    const limited = await handlePublicCollectionRoute(world.env, publicRequest(shopA.host, "/v1/collections/nytt", { ip }), { now });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(limited.headers.get("access-control-allow-origin")).toBe("*");
    expect(limited.headers.get("etag")).toBeNull();
    expect(await limited.json()).toEqual(RATE_LIMITED);

    // Another caller is not affected.
    const other = await handlePublicCollectionRoute(
      world.env,
      publicRequest(shopA.host, "/v1/collections/nytt", { ip: "198.51.100.11" }),
      { now },
    );
    expect(other.status).toBe(200);
    await other.body?.cancel();
  });

  it("refuses with the same bytes whatever the ref, the query or the shop, and X-Forwarded-For buys nothing", async () => {
    const now = pinnedMinute(2);
    const ip = "198.51.100.20";
    for (let index = 0; index < COLLECTIONS_IP_LIMIT; index += 1) {
      const response = await handlePublicCollectionsRoute(world.env, publicRequest(shopA.host, "/v1/collections", { ip }), { now });
      await response.body?.cancel();
    }
    const bodies = new Set<string>();
    for (const [host, path] of [
      [shopA.host, "/v1/collections/nytt"],
      [shopA.host, "/v1/collections/okand"],
      [shopA.host, "/v1/collections/nytt?limit=0"],
      [shopB.host, "/v1/collections/nytt"],
      ["no-shop.storefront.invalid", "/v1/collections/nytt"],
    ] as const) {
      const response = await handlePublicCollectionRoute(world.env, publicRequest(host, path, { ip }), { now });
      expect(response.status, `${host}${path}`).toBe(429);
      bodies.add(`${response.headers.get("retry-after")}|${await response.text()}`);
    }
    expect(bodies.size).toBe(1);

    const spoofed = await handlePublicCollectionsRoute(
      world.env,
      publicRequest(shopA.host, "/v1/collections", { headers: { "x-forwarded-for": "192.0.2.99" }, ip }),
      { now },
    );
    expect(spoofed.status).toBe(429);
    await spoofed.body?.cancel();
  });

  it("puts every request without an edge address into ONE shared bucket", async () => {
    const now = pinnedMinute(3);
    const statuses: number[] = [];
    for (let index = 0; index <= COLLECTIONS_IP_LIMIT; index += 1) {
      const response = await handlePublicCollectionsRoute(world.env, publicRequest(shopA.host, "/v1/collections", { ip: null }), { now });
      statuses.push(response.status);
      await response.body?.cancel();
    }
    expect(statuses.slice(0, COLLECTIONS_IP_LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("counts an IPv6 caller by its /64: rotating addresses inside it buys nothing; another /64 is unaffected", async () => {
    const now = pinnedMinute(4);
    for (let index = 0; index < COLLECTIONS_IP_LIMIT; index += 1) {
      // Many addresses (and spellings) of ONE network.
      const ip = index % 2 === 0 ? `2001:db8:99:1::${(index + 1).toString(16)}` : `2001:0DB8:0099:0001:0:0:${index}:1`;
      const response = await handlePublicCollectionsRoute(world.env, publicRequest(shopA.host, "/v1/collections", { ip }), { now });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    const rotated = await handlePublicCollectionsRoute(
      world.env,
      publicRequest(shopA.host, "/v1/collections", { ip: "2001:db8:99:1:ffff:ffff:ffff:fffe" }),
      { now },
    );
    expect(rotated.status).toBe(429);
    await rotated.body?.cancel();
    const neighbour = await handlePublicCollectionsRoute(
      world.env,
      publicRequest(shopA.host, "/v1/collections", { ip: "2001:db8:99:2::1" }),
      { now },
    );
    expect(neighbour.status).toBe(200);
    await neighbour.body?.cancel();
  });

  it("a preflight is answered and not counted while the caller is over the limit", async () => {
    const now = pinnedMinute(5);
    const ip = "198.51.100.50";
    for (let index = 0; index <= COLLECTIONS_IP_LIMIT; index += 1) {
      const response = await handlePublicCollectionsRoute(world.env, publicRequest(shopA.host, "/v1/collections", { ip }), { now });
      await response.body?.cancel();
    }
    const preflight = await handlePublicCollectionsRoute(
      world.env,
      publicRequest(shopA.host, "/v1/collections", { ip, method: "OPTIONS" }),
      { now },
    );
    expect(preflight.status).toBe(204);
    const windows = await env.DB.prepare(
      "SELECT count FROM rate_limit_windows WHERE scope = ? AND window_start = ?",
    )
      .bind(COLLECTIONS_IP_SCOPE, now - (now % COLLECTIONS_IP_WINDOW_MS))
      .all<{ count: number }>();
    expect(windows.results.map((row) => row.count)).toContain(COLLECTIONS_IP_LIMIT + 1);
  });

  it("is enforced on the mounted routes, and keeps no raw address in D1", async () => {
    const ip = "198.51.100.60";
    const now = Date.now();
    const windowStart = now - (now % COLLECTIONS_IP_WINDOW_MS);
    const keyHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${COLLECTIONS_IP_SCOPE}:${ip}`))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    // This window and the next: the test does not straddle a minute.
    for (const start of [windowStart, windowStart + COLLECTIONS_IP_WINDOW_MS]) {
      await env.DB.prepare(
        `INSERT INTO rate_limit_windows (scope, key_hash, window_start, count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(COLLECTIONS_IP_SCOPE, keyHash, start, COLLECTIONS_IP_LIMIT, now, now)
        .run();
    }
    for (const path of ["/v1/collections", "/v1/collections/nytt"]) {
      const response = await worker.fetch(publicRequest(shopA.host, path, { ip }), world.env);
      expect(response.status, path).toBe(429);
      expect(await response.json()).toEqual(RATE_LIMITED);
    }
    const rows = await env.DB.prepare("SELECT * FROM rate_limit_windows WHERE scope = ?")
      .bind(COLLECTIONS_IP_SCOPE)
      .all();
    const text = JSON.stringify(rows.results);
    expect(text).not.toContain(ip);
    expect(text).not.toContain("198.51.100");
    expect(text).not.toContain("2001:db8");
  });
});
