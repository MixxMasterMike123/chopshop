import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { ImageDimensions } from "../src/storage/image-sniff";
import type { ObjectBucket, ObjectKind } from "../src/storage/object-store";
import {
  activateObject,
  deletePendingOrMutableObject,
  reservePendingObject,
} from "../src/storage/object-store";
import type { PublicObjectKind } from "../src/storage/public-objects";
import {
  getReferencablePublicImage,
  publicObjectBase,
  publicObjectUrl,
  resolvePublicImages,
} from "../src/storage/public-objects";
import type { TenantContext } from "../src/tenancy/resolve-tenant";

const TENANT_A = "tenant-public-a";
const TENANT_B = "tenant-public-b";
const NOW = 1_787_500_000_000;
const BASE = "https://public-objects.test.invalid";
const SHA = "c".repeat(64);
const ALL_PUBLIC_KINDS: readonly PublicObjectKind[] = [
  "preview_image",
  "product_media",
  "shop_branding",
];

const tenantA: TenantContext = { domainKind: "admin", hostname: "", tenantId: TENANT_A };
const tenantB: TenantContext = { domainKind: "admin", hostname: "", tenantId: TENANT_B };

interface RowOptions {
  activate?: boolean;
  bucket?: ObjectBucket;
  dimensions?: ImageDimensions | null;
  fileName?: string;
  kind?: ObjectKind;
}

async function seedTenant(tenantId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (
      tenant_id, status, shop_name, default_locale, default_currency,
      created_at, updated_at
    ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, `Shop ${tenantId}`, NOW, NOW)
    .run();
}

/** A row made the way the upload makes it: reserved, then activated. */
async function objectRow(tenant: TenantContext, options: RowOptions = {}): Promise<string> {
  const kind = options.kind ?? "product_media";
  const reserved = await reservePendingObject(
    env.DB,
    tenant,
    {
      bucket: options.bucket ?? "public",
      contentType: "image/png",
      fileName: options.fileName ?? "photo.png",
      kind,
    },
    NOW,
  );
  if (reserved.status !== "ok") {
    throw new Error(`reserve failed: ${reserved.status}`);
  }

  if (options.activate !== false) {
    const activated = await activateObject(
      env.DB,
      tenant,
      reserved.object.objectId,
      {
        dimensions: options.dimensions === undefined ? { height: 480, width: 640 } : options.dimensions,
        sha256: SHA,
        sizeBytes: 2_048,
      },
      NOW,
    );
    expect(activated.status).toBe("ok");
  }

  return reserved.object.objectId;
}

async function objectKey(objectId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT object_key FROM stored_objects WHERE object_id = ?")
    .bind(objectId)
    .first<{ object_key: string }>();
  if (row === null) {
    throw new Error(`no row ${objectId}`);
  }
  return row.object_key;
}

function withBase(value: unknown): Env {
  return { ...env, PUBLIC_OBJECT_BASE_URL: value } as Env;
}

beforeAll(async () => {
  await seedTenant(TENANT_A);
  await seedTenant(TENANT_B);
});

describe("publicObjectBase", () => {
  it("accepts a bare https origin, with or without one trailing slash", () => {
    expect(publicObjectBase(env)).toBe(BASE);
    expect(publicObjectBase(withBase(`${BASE}/`))).toBe(BASE);
    expect(publicObjectBase(withBase("https://pub-0123456789abcdef.r2.dev"))).toBe(
      "https://pub-0123456789abcdef.r2.dev",
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a string", 42],
    ["not a URL", "public objects"],
    ["plain http", "http://public-objects.test.invalid"],
    ["another scheme", "ftp://public-objects.test.invalid"],
    ["a script URL", "javascript:alert(1)"],
    ["a path", `${BASE}/images`],
    ["two trailing slashes", `${BASE}//`],
    ["a query", `${BASE}/?v=1`],
    ["a fragment", `${BASE}#x`],
    ["credentials", "https://user:secret@public-objects.test.invalid"],
    ["a port", "https://public-objects.test.invalid:8443"],
    ["the default port written out", "https://public-objects.test.invalid:443"],
    ["upper-case letters the parser would lower", "https://Public-Objects.test.invalid"],
    ["leading white space", ` ${BASE}`],
    ["an overlong value", `https://${"a".repeat(200)}.test`],
  ])("refuses %s", (_label, value) => {
    expect(publicObjectBase(withBase(value))).toBeNull();
  });
});

describe("publicObjectUrl", () => {
  it("percent-encodes every segment of the key", () => {
    expect(publicObjectUrl(BASE, "shops/t 1/product_media/id/v1/a b#c?.png")).toBe(
      `${BASE}/shops/t%201/product_media/id/v1/a%20b%23c%3F.png`,
    );
  });

  it.each([
    ["a parent segment", "shops/t/product_media/x/../../u/y.png"],
    ["a dot segment", "shops/t/./y.png"],
    ["an empty segment", "shops/t//y.png"],
  ])("gives no address for a key with %s", (_label, key) => {
    expect(publicObjectUrl(BASE, key)).toBeNull();
  });
});

describe("resolvePublicImages", () => {
  it("resolves an active public image of this tenant to its address, type and size", async () => {
    const objectId = await objectRow(tenantA, { fileName: "Hero Shot.PNG" });

    const images = await resolvePublicImages(env, env.DB, TENANT_A, [objectId], ["product_media"]);

    expect(images.get(objectId)).toEqual({
      contentType: "image/png",
      height: 480,
      objectId,
      url: `${BASE}/shops/${TENANT_A}/product_media/${objectId}/v1/heroshot.png`,
      width: 640,
    });
  });

  it("carries an unknown size as null", async () => {
    const objectId = await objectRow(tenantA, { dimensions: null });

    const images = await resolvePublicImages(env, env.DB, TENANT_A, [objectId], ["product_media"]);

    expect(images.get(objectId)).toMatchObject({ height: null, width: null });
  });

  it("leaves out a pending, a deleted, a private, a foreign and an other-kind row", async () => {
    const good = await objectRow(tenantA);
    const pending = await objectRow(tenantA, { activate: false });
    const deleted = await objectRow(tenantA);
    await deletePendingOrMutableObject(env.DB, tenantA, deleted, NOW + 1);
    const privateRow = await objectRow(tenantA, { bucket: "private", kind: "print_file" });
    const foreign = await objectRow(tenantB);
    const branding = await objectRow(tenantA, { kind: "shop_branding" });
    const unknown = crypto.randomUUID();

    const images = await resolvePublicImages(
      env,
      env.DB,
      TENANT_A,
      [good, pending, deleted, privateRow, foreign, branding, unknown],
      ["product_media"],
    );

    expect([...images.keys()]).toEqual([good]);
  });

  it("resolves the other kinds when they are asked for", async () => {
    const product = await objectRow(tenantA);
    const branding = await objectRow(tenantA, { kind: "shop_branding" });

    const images = await resolvePublicImages(env, env.DB, TENANT_A, [product, branding], ALL_PUBLIC_KINDS);

    expect(new Set(images.keys())).toEqual(new Set([product, branding]));
  });

  it("resolves 200 ids across chunks of 90, duplicates read once", async () => {
    const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
    await env.DB.batch(
      ids.map((objectId) =>
        env.DB.prepare(
          `INSERT INTO stored_objects (
            object_id, tenant_id, bucket, object_key, kind, content_type,
            size_bytes, sha256, status, immutable, created_at, updated_at,
            width_px, height_px
          ) VALUES (?, ?, 'public', ?, 'product_media', 'image/webp', 10, ?, 'active', 0, ?, ?, 10, 20)`,
        ).bind(objectId, TENANT_A, `shops/${TENANT_A}/product_media/${objectId}/v1/object`, SHA, NOW, NOW),
      ),
    );

    const images = await resolvePublicImages(
      env,
      env.DB,
      TENANT_A,
      [...ids, ...ids.slice(0, 50)],
      ["product_media"],
    );

    expect(images.size).toBe(200);
    expect(ids.every((objectId) => images.get(objectId)?.url.endsWith(`/${objectId}/v1/object`))).toBe(true);
  });

  it("answers an empty map without a valid base, even for a good row", async () => {
    const objectId = await objectRow(tenantA);

    for (const value of [undefined, "http://public-objects.test.invalid", `${BASE}/path`]) {
      const images = await resolvePublicImages(withBase(value), env.DB, TENANT_A, [objectId], ["product_media"]);
      expect(images.size).toBe(0);
    }
  });

  it("answers an empty map for no ids or no kinds", async () => {
    const objectId = await objectRow(tenantA);

    await expect(resolvePublicImages(env, env.DB, TENANT_A, [], ["product_media"])).resolves.toEqual(new Map());
    await expect(resolvePublicImages(env, env.DB, TENANT_A, [objectId], [])).resolves.toEqual(new Map());
  });

  it("gives no address to a row whose key a client would resolve elsewhere", async () => {
    // Not a key this platform writes (safeFileName strips dots), but an
    // imported row must not be able to point into another tenant's keys.
    const objectId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO stored_objects (
        object_id, tenant_id, bucket, object_key, kind, content_type,
        size_bytes, sha256, status, immutable, created_at, updated_at
      ) VALUES (?, ?, 'public', ?, 'product_media', 'image/png', 10, ?, 'active', 0, ?, ?)`,
    )
      .bind(objectId, TENANT_A, `shops/${TENANT_A}/../${TENANT_B}/product_media/x/v1/object`, SHA, NOW, NOW)
      .run();

    const images = await resolvePublicImages(env, env.DB, TENANT_A, [objectId], ["product_media"]);

    expect(images.size).toBe(0);
  });
});

describe("getReferencablePublicImage", () => {
  it("lets a tenant reference its own active public image", async () => {
    const objectId = await objectRow(tenantA);

    await expect(
      getReferencablePublicImage(env, env.DB, TENANT_A, objectId, ["product_media"]),
    ).resolves.toMatchObject({
      objectId,
      url: `${BASE}/${await objectKey(objectId)}`,
    });
  });

  it("refuses tenant A an image of tenant B", async () => {
    const objectId = await objectRow(tenantB);

    await expect(
      getReferencablePublicImage(env, env.DB, TENANT_A, objectId, ALL_PUBLIC_KINDS),
    ).resolves.toBeNull();
    // The owner may.
    await expect(
      getReferencablePublicImage(env, env.DB, TENANT_B, objectId, ALL_PUBLIC_KINDS),
    ).resolves.not.toBeNull();
  });

  it.each([
    ["a pending row", { activate: false }],
    ["a private row", { bucket: "private", kind: "print_file" }],
    ["a kind outside the list", { kind: "shop_branding" }],
  ] as const)("refuses %s", async (_label, options) => {
    const objectId = await objectRow(tenantA, options);

    await expect(
      getReferencablePublicImage(env, env.DB, TENANT_A, objectId, ["product_media"]),
    ).resolves.toBeNull();
  });

  it("refuses a deleted row", async () => {
    const objectId = await objectRow(tenantA);
    await deletePendingOrMutableObject(env.DB, tenantA, objectId, NOW + 1);

    await expect(
      getReferencablePublicImage(env, env.DB, TENANT_A, objectId, ["product_media"]),
    ).resolves.toBeNull();
  });

  it("refuses every image while the base is not valid", async () => {
    const objectId = await objectRow(tenantA);

    await expect(
      getReferencablePublicImage(withBase(undefined), env.DB, TENANT_A, objectId, ["product_media"]),
    ).resolves.toBeNull();
  });
});
