import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import { markObjectImmutable } from "../src/storage/object-store";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const HOST_A = "https://admin-a.objectroutes.test";
const HOST_B = "https://admin-b.objectroutes.test";
const TENANT_A = "tenant-objectroutes-a";
const TENANT_B = "tenant-objectroutes-b";
const NOW = 1_787_400_000_000;

interface SignedUpUser {
  cookie: string;
  userId: string;
}

interface ReservedBody {
  object: { objectId: string; objectKey: string };
}

interface MetadataBody {
  object: {
    contentType: string;
    immutable: boolean;
    kind: string;
    objectId: string;
    sha256: string | null;
    sizeBytes: number | null;
    status: string;
  };
}

interface ObjectRow {
  object_key: string;
  sha256: string | null;
  size_bytes: number | null;
  status: string;
}

let adminA: SignedUpUser;
let adminB: SignedUpUser;
let ordinary: SignedUpUser;

async function signUp(email: string): Promise<SignedUpUser> {
  // Better Auth caps /sign-up at 3 requests per 10s in a shared bucket when no
  // client IP is forwarded, so drain the ledger between fixtures.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email,
        name: email,
        password: "test-password-long-enough",
      }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();
  const setCookie = response.headers.get("set-cookie");

  expect(response.status).toBe(200);
  if (setCookie === null) {
    throw new Error("Better Auth sign-up did not return a session cookie");
  }

  const cookie = setCookie.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("Better Auth returned an invalid session cookie");
  }

  return { cookie, userId: body.user.id };
}

async function seedAccess(userId: string, accountType: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO identity_access (
      user_id, account_type, status, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(userId, accountType, NOW, NOW)
    .run();
}

async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency,
        created_at, updated_at
      ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
  ]);
}

async function seedMembership(
  userId: string,
  tenantId: string,
  role: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (
      membership_id, tenant_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(`membership-${tenantId}-${userId}`, tenantId, userId, role, NOW, NOW)
    .run();
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function objectRequest(
  target: string,
  method: string,
  options: { body?: unknown; cookie?: string; origin?: string | null } = {},
): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  const origin =
    options.origin === undefined ? new URL(target).origin : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new Request(target, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method,
  });
}

/**
 * Upload through the worker with an explicit Content-Length. A streamed body
 * carries no length header of its own, and the route requires one.
 */
function uploadRequest(
  target: string,
  bytes: Uint8Array<ArrayBuffer>,
  options: {
    contentLength?: string;
    cookie?: string;
    origin?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  const origin =
    options.origin === undefined ? new URL(target).origin : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  headers.set("content-length", options.contentLength ?? String(bytes.length));

  return new Request(target, {
    body: new Response(bytes).body,
    headers,
    method: "PUT",
  });
}

async function reserve(
  host: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(
    objectRequest(`${host}/v1/admin/objects`, "POST", { body, cookie }),
  );
}

async function reserveOk(
  host: string,
  cookie: string,
  bytes: Uint8Array<ArrayBuffer>,
  overrides: Record<string, unknown> = {},
): Promise<ReservedBody["object"]> {
  const response = await reserve(host, cookie, {
    contentType: "image/png",
    kind: "print_file",
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.length,
    ...overrides,
  });

  expect(response.status).toBe(201);
  const body = await response.json<ReservedBody>();

  return body.object;
}

async function objectRow(objectId: string): Promise<ObjectRow | null> {
  return env.DB.prepare(
    `SELECT object_key, status, size_bytes, sha256
     FROM stored_objects
     WHERE object_id = ?`,
  )
    .bind(objectId)
    .first<ObjectRow>();
}

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

async function storedBytes(
  objectKey: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const object = await env.PRIVATE_BUCKET.get(objectKey);

  return object === null ? null : new Uint8Array(await object.arrayBuffer());
}

beforeAll(async () => {
  await seedTenant(TENANT_A, "admin-a.objectroutes.test");
  await seedTenant(TENANT_B, "admin-b.objectroutes.test");

  adminA = await signUp("admin-a@objectroutes.test");
  adminB = await signUp("admin-b@objectroutes.test");
  ordinary = await signUp("ordinary@objectroutes.test");

  await seedAccess(adminA.userId, "tenant_admin");
  await seedAccess(adminB.userId, "tenant_admin");
  await seedAccess(ordinary.userId, "ordinary");

  await seedMembership(adminA.userId, TENANT_A, "admin");
  await seedMembership(adminB.userId, TENANT_B, "admin");
  await seedMembership(ordinary.userId, TENANT_A, "customer");
});

describe("admin object lifecycle through the worker", () => {
  it("reserves, uploads, reads, and deletes an object", async () => {
    const bytes = bytesOf("print-file-payload");
    const expectedSha = await sha256Hex(bytes);
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes, {
      fileName: "Artwork Final.PNG",
    });

    expect(reserved.objectKey).toBe(
      `shops/${TENANT_A}/print_file/${reserved.objectId}/v1/artworkfinal.png`,
    );
    // The declared values land on the pending row but nothing is active yet.
    expect(await objectRow(reserved.objectId)).toMatchObject({
      sha256: expectedSha,
      size_bytes: bytes.length,
      status: "pending",
    });

    // A pending object exposes neither metadata nor bytes.
    const earlyMetadata = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}`, "GET", {
        cookie: adminA.cookie,
      }),
    );
    expect(earlyMetadata.status).toBe(404);

    const uploaded = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );

    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toEqual({
      object: {
        contentType: "image/png",
        immutable: false,
        kind: "print_file",
        objectId: reserved.objectId,
        sha256: expectedSha,
        sizeBytes: bytes.length,
        status: "active",
      },
    });

    const metadata = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}`, "GET", {
        cookie: adminA.cookie,
      }),
    );
    const metadataBody = await metadata.json<MetadataBody>();

    expect(metadata.status).toBe(200);
    expect(metadataBody.object).toMatchObject({
      sha256: expectedSha,
      sizeBytes: bytes.length,
      status: "active",
    });
    // The internal key must never leak through the metadata surface.
    expect(JSON.stringify(metadataBody)).not.toContain("shops/");
    expect(JSON.stringify(metadataBody)).not.toContain("objectKey");

    const content = await exports.default.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        "GET",
        { cookie: adminA.cookie },
      ),
    );

    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/png");
    expect(content.headers.get("cache-control")).toBe("no-store");
    // Compare raw bytes: the declared type is binary, so decoding as text would
    // be the wrong assertion even though this payload happens to be ASCII.
    await expect(content.bytes()).resolves.toEqual(bytes);

    const deleted = await exports.default.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}`,
        "DELETE",
        { cookie: adminA.cookie },
      ),
    );

    expect(deleted.status).toBe(204);
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "deleted",
    });
    // Both the row and the bytes are gone.
    await expect(
      env.PRIVATE_BUCKET.get(reserved.objectKey),
    ).resolves.toBeNull();

    const afterDelete = await exports.default.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        "GET",
        { cookie: adminA.cookie },
      ),
    );
    expect(afterDelete.status).toBe(404);
  });

  it("refuses a second upload for an already active object", async () => {
    const bytes = bytesOf("first-upload");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);

    const first = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );
    expect(first.status).toBe(200);

    const second = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    // The stored bytes are untouched by the rejected attempt.
    await expect(storedBytes(reserved.objectKey)).resolves.toEqual(bytes);
  });
});

describe("admin object deletion", () => {
  it("refuses to delete a frozen object and leaves its bytes in place", async () => {
    const bytes = bytesOf("frozen-payload");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);
    const uploaded = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );
    expect(uploaded.status).toBe(200);

    // Freezing happens when paid or production state starts referencing the
    // object; there is no route for it yet, so drive the store directly.
    await markObjectImmutable(
      env.DB,
      { domainKind: "admin", hostname: "", tenantId: TENANT_A },
      reserved.objectId,
      NOW,
    );

    const response = await exports.default.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}`,
        "DELETE",
        { cookie: adminA.cookie },
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "active",
    });
    await expect(storedBytes(reserved.objectKey)).resolves.toEqual(bytes);
  });

  it("returns 404 when deleting an unknown object id", async () => {
    const response = await exports.default.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${crypto.randomUUID()}`,
        "DELETE",
        { cookie: adminA.cookie },
      ),
    );

    expect(response.status).toBe(404);
  });

  it("tombstones a pending object without touching R2", async () => {
    const bytes = bytesOf("never-uploaded");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);

    const response = await exports.default.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}`,
        "DELETE",
        { cookie: adminA.cookie },
      ),
    );

    expect(response.status).toBe(204);
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "deleted",
    });

    // A tombstoned reservation can never be filled afterwards.
    const late = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );
    expect(late.status).toBe(409);
    await expect(storedBytes(reserved.objectKey)).resolves.toBeNull();
  });
});

describe("admin object upload integrity", () => {
  it("rejects a body whose hash does not match the declared one", async () => {
    const declared = bytesOf("the-declared-bytes");
    const reserved = await reserveOk(HOST_A, adminA.cookie, declared);

    // Same length so Content-Length still matches; only the bytes differ.
    const forged = bytesOf("the-forged---bytes");
    expect(forged.length).toBe(declared.length);

    const response = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        forged,
        { cookie: adminA.cookie },
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    // R2 refused the put, so the row never activated and no bytes exist.
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "pending",
    });
    await expect(
      env.PRIVATE_BUCKET.get(reserved.objectKey),
    ).resolves.toBeNull();
  });

  it("rejects a Content-Length that disagrees with the declared size", async () => {
    const bytes = bytesOf("length-mismatch");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);

    const response = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { contentLength: String(bytes.length + 1), cookie: adminA.cookie },
      ),
    );

    expect(response.status).toBe(400);
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "pending",
    });
    await expect(
      env.PRIVATE_BUCKET.get(reserved.objectKey),
    ).resolves.toBeNull();
  });

  it("rejects an upload with no Content-Length at all", async () => {
    const bytes = bytesOf("no-length");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);

    // A byte-backed stream gets a Content-Length synthesized by the runtime, so
    // an identity transform is the only way to send a genuinely unknown length.
    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    void (async () => {
      await writer.write(bytes);
      await writer.close();
    })();

    const response = await exports.default.fetch(
      new Request(`${HOST_A}/v1/admin/objects/${reserved.objectId}/content`, {
        body: readable,
        headers: { cookie: adminA.cookie, origin: HOST_A },
        method: "PUT",
      }),
    );

    expect(response.status).toBe(400);
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "pending",
    });
    await expect(
      env.PRIVATE_BUCKET.get(reserved.objectKey),
    ).resolves.toBeNull();
  });

  it("rejects a declared size over the 100 MB cap at reserve time", async () => {
    const response = await reserve(HOST_A, adminA.cookie, {
      contentType: "image/png",
      kind: "print_file",
      sha256: "a".repeat(64),
      sizeBytes: 100_000_001,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("answers 413 when Content-Length exceeds the cap", async () => {
    const bytes = bytesOf("small-body");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);

    const response = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { contentLength: "100000001", cookie: adminA.cookie },
      ),
    );

    expect(response.status).toBe(413);
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "pending",
    });
  });
});

describe("admin object reserve validation", () => {
  it.each([
    ["public kind", { kind: "product_media" }],
    ["temp kind", { kind: "temp_upload" }],
    ["unknown kind", { kind: "not_a_kind" }],
    ["uppercase hash", { sha256: "A".repeat(64) }],
    ["short hash", { sha256: "a".repeat(63) }],
    ["non-hex hash", { sha256: "g".repeat(64) }],
    ["zero size", { sizeBytes: 0 }],
    ["negative size", { sizeBytes: -1 }],
    ["fractional size", { sizeBytes: 10.5 }],
    ["string size", { sizeBytes: "1024" }],
    ["parameterized content type", { contentType: "image/png; q=1" }],
    ["header-smuggling content type", { contentType: "image/png\r\nx-evil: 1" }],
    ["unknown key", { bucket: "private" }],
  ])("rejects reserve with %s", async (_label, overrides) => {
    const response = await reserve(HOST_A, adminA.cookie, {
      contentType: "image/png",
      kind: "print_file",
      sha256: "a".repeat(64),
      sizeBytes: 1_024,
      ...overrides,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("rejects a malformed JSON body", async () => {
    const headers = new Headers({
      "content-type": "application/json",
      cookie: adminA.cookie,
      origin: HOST_A,
    });
    const response = await exports.default.fetch(
      new Request(`${HOST_A}/v1/admin/objects`, {
        body: "{not json",
        headers,
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
  });

  it.each([
    [`${HOST_A}/v1/admin/objects/`, "GET"],
    [`${HOST_A}/v1/admin/objects/abc/bytes`, "GET"],
    [`${HOST_A}/v1/admin/objects/abc/content/extra`, "GET"],
  ])("rejects malformed object path %s", async (target, method) => {
    const response = await exports.default.fetch(
      objectRequest(target, method, { cookie: adminA.cookie }),
    );

    expect(response.status).toBe(404);
  });

  it("does not expose the collection through another method", async () => {
    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects`, "GET", {
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 for metadata of an unknown object id", async () => {
    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${crypto.randomUUID()}`, "GET", {
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe("admin object authorization", () => {
  it("hides the surface from anonymous callers", async () => {
    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects`, "POST", {
        body: {
          contentType: "image/png",
          kind: "print_file",
          sha256: "a".repeat(64),
          sizeBytes: 10,
        },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("hides the surface from an ordinary signed-in user", async () => {
    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects`, "POST", {
        body: {
          contentType: "image/png",
          kind: "print_file",
          sha256: "a".repeat(64),
          sizeBytes: 10,
        },
        cookie: ordinary.cookie,
      }),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    ["missing", null],
    ["cross-site", "https://evil.test"],
  ])("rejects a %s Origin on a state change", async (_label, origin) => {
    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects`, "POST", {
        body: {
          contentType: "image/png",
          kind: "print_file",
          sha256: "a".repeat(64),
          sizeBytes: 10,
        },
        cookie: adminA.cookie,
        origin,
      }),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a cross-origin upload even with a valid admin session", async () => {
    const bytes = bytesOf("csrf-upload");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);

    const response = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie, origin: "https://evil.test" },
      ),
    );

    expect(response.status).toBe(404);
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "pending",
    });
    await expect(
      env.PRIVATE_BUCKET.get(reserved.objectKey),
    ).resolves.toBeNull();
  });

  it("rejects a cross-origin delete even with a valid admin session", async () => {
    const bytes = bytesOf("csrf-delete");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);
    await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );

    const response = await exports.default.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}`,
        "DELETE",
        { cookie: adminA.cookie, origin: "https://evil.test" },
      ),
    );

    expect(response.status).toBe(404);
    expect(await objectRow(reserved.objectId)).toMatchObject({
      status: "active",
    });
  });
});

describe("admin object tenant isolation", () => {
  it("refuses tenant B every operation on a tenant A object", async () => {
    const bytes = bytesOf("tenant-a-only");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);
    const uploaded = await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${reserved.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );
    expect(uploaded.status).toBe(200);
    const before = await objectRow(reserved.objectId);

    // Tenant B knows the object id; only D1 ownership decides, on every leg.
    const metadata = await exports.default.fetch(
      objectRequest(`${HOST_B}/v1/admin/objects/${reserved.objectId}`, "GET", {
        cookie: adminB.cookie,
      }),
    );
    expect(metadata.status).toBe(404);

    const content = await exports.default.fetch(
      objectRequest(
        `${HOST_B}/v1/admin/objects/${reserved.objectId}/content`,
        "GET",
        { cookie: adminB.cookie },
      ),
    );
    expect(content.status).toBe(404);

    const overwrite = await exports.default.fetch(
      uploadRequest(
        `${HOST_B}/v1/admin/objects/${reserved.objectId}/content`,
        bytesOf("tenant-b-bytes"),
        { cookie: adminB.cookie },
      ),
    );
    expect(overwrite.status).toBe(404);

    const deleted = await exports.default.fetch(
      objectRequest(
        `${HOST_B}/v1/admin/objects/${reserved.objectId}`,
        "DELETE",
        { cookie: adminB.cookie },
      ),
    );
    expect(deleted.status).toBe(404);

    // Row and bytes are exactly as tenant A left them.
    expect(await objectRow(reserved.objectId)).toEqual(before);
    await expect(storedBytes(reserved.objectKey)).resolves.toEqual(bytes);
  });

  it("hides tenant A's host from tenant B's admin on reserve", async () => {
    const response = await reserve(HOST_A, adminB.cookie, {
      contentType: "image/png",
      kind: "print_file",
      sha256: "a".repeat(64),
      sizeBytes: 10,
    });

    expect(response.status).toBe(404);
  });
});

describe("admin object routes without a bucket binding", () => {
  function withoutBucket(): Env {
    return { ...env, PRIVATE_BUCKET: undefined };
  }

  it("still reserves and reads metadata, which are D1-only", async () => {
    const bytes = bytesOf("d1-only-path");
    const reserveResponse = await worker.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects`, "POST", {
        body: {
          contentType: "image/png",
          kind: "print_file",
          sha256: await sha256Hex(bytes),
          sizeBytes: bytes.length,
        },
        cookie: adminA.cookie,
      }),
      withoutBucket(),
    );
    expect(reserveResponse.status).toBe(201);
    const { object } = await reserveResponse.json<ReservedBody>();

    // Fails closed on the byte paths: no binding means nothing can be stored...
    const upload = await worker.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${object.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
      withoutBucket(),
    );
    expect(upload.status).toBe(404);
    expect(await objectRow(object.objectId)).toMatchObject({
      status: "pending",
    });

    // ...but metadata for an active object still works over D1 alone.
    const active = await reserveOk(HOST_A, adminA.cookie, bytes);
    await exports.default.fetch(
      uploadRequest(
        `${HOST_A}/v1/admin/objects/${active.objectId}/content`,
        bytes,
        { cookie: adminA.cookie },
      ),
    );

    const metadata = await worker.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${active.objectId}`, "GET", {
        cookie: adminA.cookie,
      }),
      withoutBucket(),
    );
    expect(metadata.status).toBe(200);

    const content = await worker.fetch(
      objectRequest(
        `${HOST_A}/v1/admin/objects/${active.objectId}/content`,
        "GET",
        { cookie: adminA.cookie },
      ),
      withoutBucket(),
    );
    expect(content.status).toBe(404);
  });
});
