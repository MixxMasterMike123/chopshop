import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  activateObject,
  deletePendingOrMutableObject,
  deliverPrivateObject,
  getAuthorizedObject,
  markObjectImmutable,
  reservePendingObject,
} from "../src/storage/object-store";

const TENANT_A = "tenant-object-a";
const TENANT_B = "tenant-object-b";
const NOW = 1_787_300_000_000;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const tenantA: TenantContext = {
  domainKind: "admin",
  hostname: "a.objects.test",
  tenantId: TENANT_A,
};
const tenantB: TenantContext = {
  domainKind: "admin",
  hostname: "b.objects.test",
  tenantId: TENANT_B,
};

interface StoredObjectSnapshot {
  immutable: number;
  object_key: string;
  sha256: string | null;
  size_bytes: number | null;
  status: string;
  tenant_id: string;
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

async function snapshot(objectId: string): Promise<StoredObjectSnapshot> {
  const row = await env.DB.prepare(
    `SELECT tenant_id, object_key, status, size_bytes, sha256, immutable
     FROM stored_objects
     WHERE object_id = ?`,
  )
    .bind(objectId)
    .first<StoredObjectSnapshot>();

  if (row === null) {
    throw new Error(`stored object ${objectId} not found`);
  }

  return row;
}

async function auditActions(objectId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT action
     FROM audit_events
     WHERE resource_type = 'stored_object'
       AND resource_id = ?
     ORDER BY created_at, rowid`,
  )
    .bind(objectId)
    .all<{ action: string }>();

  return results.map((row) => row.action);
}

async function reserveActive(
  tenant: TenantContext,
  kind: "print_file" | "product_media" = "print_file",
): Promise<string> {
  const bucket = kind === "print_file" ? "private" : "public";
  const reserved = await reservePendingObject(
    env.DB,
    tenant,
    { bucket, contentType: "image/png", kind },
    NOW,
  );

  if (reserved.status !== "ok") {
    throw new Error(`reserve failed: ${reserved.status}`);
  }

  const activated = await activateObject(
    env.DB,
    tenant,
    reserved.object.objectId,
    { sha256: SHA_A, sizeBytes: 2_048 },
    NOW,
  );
  expect(activated.status).toBe("ok");

  return reserved.object.objectId;
}

beforeAll(async () => {
  await seedTenant(TENANT_A);
  await seedTenant(TENANT_B);
});

describe("object lifecycle", () => {
  it("reserves, activates, and authorizes an object", async () => {
    const reserved = await reservePendingObject(
      env.DB,
      tenantA,
      {
        bucket: "private",
        contentType: "image/png",
        fileName: "My Artwork (Final).PNG",
        kind: "artwork_original",
      },
      NOW,
    );

    expect(reserved.status).toBe("ok");
    if (reserved.status !== "ok") {
      return;
    }

    const { objectId, objectKey } = reserved.object;
    expect(reserved.object.bucket).toBe("private");
    expect(objectKey).toBe(
      `shops/${TENANT_A}/artwork_original/${objectId}/v1/myartworkfinal.png`,
    );

    // A pending object is not deliverable.
    await expect(
      getAuthorizedObject(env.DB, tenantA, objectId),
    ).resolves.toBeNull();

    const activated = await activateObject(
      env.DB,
      tenantA,
      objectId,
      { sha256: SHA_B, sizeBytes: 4_096 },
      NOW + 1,
    );

    expect(activated).toEqual({
      object: {
        bucket: "private",
        contentType: "image/png",
        immutable: false,
        kind: "artwork_original",
        objectId,
        objectKey,
        sha256: SHA_B,
        sizeBytes: 4_096,
        status: "active",
      },
      status: "ok",
    });

    const authorized = await getAuthorizedObject(env.DB, tenantA, objectId);
    expect(authorized?.sha256).toBe(SHA_B);
    expect(authorized?.sizeBytes).toBe(4_096);
    expect(await auditActions(objectId)).toEqual([
      "object.reserve",
      "object.activate",
    ]);
  });

  it("sanitizes file names down to the fallback when nothing survives", async () => {
    const reserved = await reservePendingObject(
      env.DB,
      tenantA,
      { bucket: "temp", contentType: "text/csv", fileName: "…/…", kind: "temp_upload" },
      NOW,
    );

    expect(reserved.status).toBe("ok");
    if (reserved.status !== "ok") {
      return;
    }

    expect(reserved.object.objectKey).toBe(
      `shops/${TENANT_A}/temp_upload/${reserved.object.objectId}/v1/object`,
    );
  });

  it("strips leading dots so a name cannot become a dotfile", async () => {
    const reserved = await reservePendingObject(
      env.DB,
      tenantA,
      {
        bucket: "private",
        contentType: "application/pdf",
        fileName: "../.htaccess",
        kind: "document",
      },
      NOW,
    );

    expect(reserved.status).toBe("ok");
    if (reserved.status !== "ok") {
      return;
    }

    expect(reserved.object.objectKey.endsWith("/v1/htaccess")).toBe(true);
  });

  it("rejects kind/bucket combinations that break the visibility split", async () => {
    const combinations = [
      { bucket: "public", kind: "print_file" },
      { bucket: "public", kind: "artwork_original" },
      { bucket: "public", kind: "document" },
      { bucket: "public", kind: "export" },
      { bucket: "private", kind: "temp_upload" },
      { bucket: "temp", kind: "print_file" },
      { bucket: "temp", kind: "product_media" },
      { bucket: "private", kind: "product_media" },
    ] as const;

    for (const combination of combinations) {
      await expect(
        reservePendingObject(
          env.DB,
          tenantA,
          { ...combination, contentType: "image/png" },
          NOW,
        ),
      ).resolves.toEqual({ status: "invalid" });
    }
  });

  it("accepts hyphenated content types and rejects parameterized or smuggled ones", async () => {
    const accepted = await reservePendingObject(
      env.DB,
      tenantA,
      {
        bucket: "private",
        contentType: "application/octet-stream",
        kind: "document",
      },
      NOW,
    );
    expect(accepted.status).toBe("ok");

    for (const contentType of [
      "text/plain; charset=utf-8",
      "text/html\r\nx-evil: 1",
      "image/",
      "/png",
      "image",
      "",
    ]) {
      await expect(
        reservePendingObject(
          env.DB,
          tenantA,
          { bucket: "private", contentType, kind: "document" },
          NOW,
        ),
      ).resolves.toEqual({ status: "invalid" });
    }
  });

  it("rejects malformed activation input", async () => {
    const reserved = await reservePendingObject(
      env.DB,
      tenantA,
      { bucket: "private", contentType: "image/png", kind: "print_file" },
      NOW,
    );
    if (reserved.status !== "ok") {
      throw new Error("reserve failed");
    }
    const { objectId } = reserved.object;

    await expect(
      activateObject(
        env.DB,
        tenantA,
        objectId,
        { sha256: "not-a-hash", sizeBytes: 1 },
        NOW,
      ),
    ).resolves.toEqual({ status: "invalid" });

    await expect(
      activateObject(
        env.DB,
        tenantA,
        objectId,
        { sha256: SHA_A, sizeBytes: -1 },
        NOW,
      ),
    ).resolves.toEqual({ status: "invalid" });

    expect((await snapshot(objectId)).status).toBe("pending");
  });

  it("refuses to activate an object twice", async () => {
    const objectId = await reserveActive(tenantA);

    await expect(
      activateObject(
        env.DB,
        tenantA,
        objectId,
        { sha256: SHA_B, sizeBytes: 99 },
        NOW,
      ),
    ).resolves.toEqual({ status: "conflict" });

    const row = await snapshot(objectId);
    expect(row.sha256).toBe(SHA_A);
    expect(row.size_bytes).toBe(2_048);
  });

  it("soft-deletes a mutable object and stops authorizing it", async () => {
    const objectId = await reserveActive(tenantA);

    const deleted = await deletePendingOrMutableObject(
      env.DB,
      tenantA,
      objectId,
      NOW + 5,
    );
    expect(deleted.status).toBe("ok");
    expect((await snapshot(objectId)).status).toBe("deleted");
    await expect(
      getAuthorizedObject(env.DB, tenantA, objectId),
    ).resolves.toBeNull();

    // Deleting again is a conflict, not a silent success.
    await expect(
      deletePendingOrMutableObject(env.DB, tenantA, objectId, NOW + 6),
    ).resolves.toEqual({ status: "conflict" });

    expect(await auditActions(objectId)).toEqual([
      "object.reserve",
      "object.activate",
      "object.delete",
    ]);
  });

  it("reports not_found for an unknown object id", async () => {
    await expect(
      activateObject(
        env.DB,
        tenantA,
        crypto.randomUUID(),
        { sha256: SHA_A, sizeBytes: 1 },
        NOW,
      ),
    ).resolves.toEqual({ status: "not_found" });

    await expect(
      markObjectImmutable(env.DB, tenantA, crypto.randomUUID(), NOW),
    ).resolves.toEqual({ status: "not_found" });
  });
});

describe("tenant isolation", () => {
  it("refuses cross-tenant reads and writes with a valid foreign object id", async () => {
    const objectId = await reserveActive(tenantA);
    const before = await snapshot(objectId);

    await expect(
      getAuthorizedObject(env.DB, tenantB, objectId),
    ).resolves.toBeNull();

    await expect(
      activateObject(
        env.DB,
        tenantB,
        objectId,
        { sha256: SHA_B, sizeBytes: 1 },
        NOW,
      ),
    ).resolves.toEqual({ status: "not_found" });

    await expect(
      markObjectImmutable(env.DB, tenantB, objectId, NOW),
    ).resolves.toEqual({ status: "not_found" });

    await expect(
      deletePendingOrMutableObject(env.DB, tenantB, objectId, NOW),
    ).resolves.toEqual({ status: "not_found" });

    expect(await snapshot(objectId)).toEqual(before);
  });

  it("rejects a direct insert whose key sits under a foreign prefix", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO stored_objects (
          object_id, tenant_id, bucket, object_key, kind, content_type,
          status, immutable, created_at, updated_at
        ) VALUES (?, ?, 'private', ?, 'print_file', 'image/png', 'active', 0, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          TENANT_A,
          `shops/${TENANT_B}/print_file/forged/v1/object`,
          NOW,
          NOW,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a key with no tenant prefix at all", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO stored_objects (
          object_id, tenant_id, bucket, object_key, kind, content_type,
          status, immutable, created_at, updated_at
        ) VALUES (?, ?, 'private', 'print_file/loose/v1/object', 'print_file',
                  'image/png', 'active', 0, ?, ?)`,
      )
        .bind(crypto.randomUUID(), TENANT_A, NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects re-homing an object to another tenant", async () => {
    const objectId = await reserveActive(tenantA);

    await expect(
      env.DB.prepare(
        "UPDATE stored_objects SET tenant_id = ? WHERE object_id = ?",
      )
        .bind(TENANT_B, objectId)
        .run(),
    ).rejects.toThrow(/tenant_id is immutable/);

    expect((await snapshot(objectId)).tenant_id).toBe(TENANT_A);
  });

  it("rejects a duplicate key in the same bucket", async () => {
    const objectId = await reserveActive(tenantA);
    const { object_key: objectKey } = await snapshot(objectId);

    await expect(
      env.DB.prepare(
        `INSERT INTO stored_objects (
          object_id, tenant_id, bucket, object_key, kind, content_type,
          status, immutable, created_at, updated_at
        ) VALUES (?, ?, 'private', ?, 'print_file', 'image/png', 'active', 0, ?, ?)`,
      )
        .bind(crypto.randomUUID(), TENANT_A, objectKey, NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("immutability", () => {
  it("freezes an active object and refuses every re-point afterwards", async () => {
    const objectId = await reserveActive(tenantA);

    const frozen = await markObjectImmutable(env.DB, tenantA, objectId, NOW + 2);
    expect(frozen.status).toBe("ok");
    expect((await snapshot(objectId)).immutable).toBe(1);

    // Idempotent: freezing again succeeds without a second audit row.
    await expect(
      markObjectImmutable(env.DB, tenantA, objectId, NOW + 3),
    ).resolves.toMatchObject({ status: "ok" });
    expect(await auditActions(objectId)).toEqual([
      "object.reserve",
      "object.activate",
      "object.freeze",
    ]);

    await expect(
      env.DB.prepare(
        "UPDATE stored_objects SET object_key = ? WHERE object_id = ?",
      )
        .bind(`shops/${TENANT_A}/print_file/${objectId}/v2/object`, objectId)
        .run(),
    ).rejects.toThrow(/immutable object cannot be re-pointed/);

    await expect(
      env.DB.prepare(
        "UPDATE stored_objects SET bucket = 'public' WHERE object_id = ?",
      )
        .bind(objectId)
        .run(),
    ).rejects.toThrow(/immutable object cannot be re-pointed/);

    await expect(
      env.DB.prepare("UPDATE stored_objects SET sha256 = ? WHERE object_id = ?")
        .bind(SHA_B, objectId)
        .run(),
    ).rejects.toThrow(/immutable object cannot be re-pointed/);

    await expect(
      env.DB.prepare(
        "UPDATE stored_objects SET status = 'deleted' WHERE object_id = ?",
      )
        .bind(objectId)
        .run(),
    ).rejects.toThrow(/immutable object cannot be re-pointed/);

    await expect(
      env.DB.prepare(
        "UPDATE stored_objects SET immutable = 0 WHERE object_id = ?",
      )
        .bind(objectId)
        .run(),
    ).rejects.toThrow(/immutable objects cannot be unfrozen/);

    const row = await snapshot(objectId);
    expect(row).toMatchObject({ immutable: 1, sha256: SHA_A, status: "active" });
  });

  it("still allows a metadata touch on a frozen object", async () => {
    const objectId = await reserveActive(tenantA);
    await markObjectImmutable(env.DB, tenantA, objectId, NOW + 2);

    await env.DB.prepare(
      "UPDATE stored_objects SET content_type = 'image/webp', updated_at = ? WHERE object_id = ?",
    )
      .bind(NOW + 9, objectId)
      .run();

    const authorized = await getAuthorizedObject(env.DB, tenantA, objectId);
    expect(authorized?.contentType).toBe("image/webp");
  });

  it("refuses to soft-delete a frozen object through the module", async () => {
    const objectId = await reserveActive(tenantA);
    await markObjectImmutable(env.DB, tenantA, objectId, NOW + 2);

    await expect(
      deletePendingOrMutableObject(env.DB, tenantA, objectId, NOW + 3),
    ).resolves.toEqual({ status: "conflict" });

    expect((await snapshot(objectId)).status).toBe("active");
  });

  it("refuses to freeze an object that is not active", async () => {
    const reserved = await reservePendingObject(
      env.DB,
      tenantA,
      { bucket: "private", contentType: "image/png", kind: "print_file" },
      NOW,
    );
    if (reserved.status !== "ok") {
      throw new Error("reserve failed");
    }

    await expect(
      markObjectImmutable(env.DB, tenantA, reserved.object.objectId, NOW),
    ).resolves.toEqual({ status: "conflict" });
  });
});

describe("private delivery", () => {
  it("streams a private object once D1 authorizes it", async () => {
    const objectId = await reserveActive(tenantA);
    const { object_key: objectKey } = await snapshot(objectId);
    await env.PRIVATE_BUCKET.put(objectKey, "print-bytes");

    const delivered = await deliverPrivateObject(
      env,
      env.DB,
      tenantA,
      objectId,
    );

    expect(delivered?.contentType).toBe("image/png");
    await expect(new Response(delivered?.body).text()).resolves.toBe(
      "print-bytes",
    );
  });

  it("refuses delivery to another tenant even though the bytes exist", async () => {
    const objectId = await reserveActive(tenantA);
    const { object_key: objectKey } = await snapshot(objectId);
    await env.PRIVATE_BUCKET.put(objectKey, "print-bytes");

    // Tenant B knows the object id and could guess the key; D1 is the only
    // authority, so delivery must still fail.
    await expect(
      deliverPrivateObject(env, env.DB, tenantB, objectId),
    ).resolves.toBeNull();
  });

  it("fails closed when the bucket binding is absent", async () => {
    const objectId = await reserveActive(tenantA);
    const { object_key: objectKey } = await snapshot(objectId);
    await env.PRIVATE_BUCKET.put(objectKey, "print-bytes");

    await expect(
      deliverPrivateObject(
        { ...env, PRIVATE_BUCKET: undefined },
        env.DB,
        tenantA,
        objectId,
      ),
    ).resolves.toBeNull();
  });

  it("refuses to serve a public-bucket row through the private path", async () => {
    const objectId = await reserveActive(tenantA, "product_media");
    const { object_key: objectKey } = await snapshot(objectId);
    await env.PRIVATE_BUCKET.put(objectKey, "public-bytes");

    await expect(
      deliverPrivateObject(env, env.DB, tenantA, objectId),
    ).resolves.toBeNull();
  });

  it("returns null for a pending object and for missing bytes", async () => {
    const reserved = await reservePendingObject(
      env.DB,
      tenantA,
      { bucket: "private", contentType: "image/png", kind: "print_file" },
      NOW,
    );
    if (reserved.status !== "ok") {
      throw new Error("reserve failed");
    }

    // Bytes exist but the row is still pending.
    await env.PRIVATE_BUCKET.put(reserved.object.objectKey, "early-bytes");
    await expect(
      deliverPrivateObject(env, env.DB, tenantA, reserved.object.objectId),
    ).resolves.toBeNull();

    // Row is active but nothing was ever uploaded.
    const orphan = await reserveActive(tenantA);
    await expect(
      deliverPrivateObject(env, env.DB, tenantA, orphan),
    ).resolves.toBeNull();
  });
});
