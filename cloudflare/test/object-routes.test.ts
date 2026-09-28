import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import type { TenantAdminPrincipal } from "../src/auth/live-authorization";
import { createAuth } from "../src/auth/create-auth";
import {
  getAdminObjectMetadataWithUrl,
  isKindReservable,
} from "../src/storage/object-routes";
import {
  activateObject,
  deletePendingOrMutableObject,
  markObjectImmutable,
} from "../src/storage/object-store";

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

// One password for every fixture identity: sign-up and the sign-in that
// follows it must agree, so the value lives in one place.
const FIXTURE_PASSWORD = "test-password-long-enough";

async function signUp(email: string): Promise<SignedUpUser> {
  // Better Auth caps /sign-up at 3 requests per 10s in a shared bucket when no
  // client IP is forwarded, so drain the ledger between fixtures.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email,
        name: email,
        password: FIXTURE_PASSWORD,
      }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();

  expect(response.status).toBe(200);

  // autoSignIn is deliberately off (see create-auth.ts), so signing up creates
  // an identity and no session. A fixture that needs a session therefore signs
  // in for it, exactly as a real provisioned user does.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signedIn = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );
  const setCookie = signedIn.headers.get("set-cookie");

  expect(signedIn.status).toBe(200);
  if (setCookie === null) {
    throw new Error("Better Auth sign-in did not return a session cookie");
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

/**
 * Admin routes take the active shop from `X-Shop-Id` (PLAN §2.1), never from
 * the hostname. Each fixture host stands for one shop, so the helpers name the
 * shop their host stands for; `shopId` overrides that and `null` omits it.
 */
const SHOP_BY_HOST: Record<string, string> = {
  [new URL(HOST_A).host]: TENANT_A,
  [new URL(HOST_B).host]: TENANT_B,
};

function setShopHeader(
  headers: Headers,
  target: string,
  shopId: string | null | undefined,
): void {
  const resolved =
    shopId === undefined ? SHOP_BY_HOST[new URL(target).host] : shopId;
  if (resolved !== undefined && resolved !== null) {
    headers.set("x-shop-id", resolved);
  }
}

function objectRequest(
  target: string,
  method: string,
  options: {
    body?: unknown;
    cookie?: string;
    origin?: string | null;
    shopId?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  setShopHeader(headers, target, options.shopId);
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
    shopId?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  setShopHeader(headers, target, options.shopId);
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
    // Real clock, not NOW: the object row was created by the live route with
    // the real clock, and CHECK (updated_at >= created_at) fails once the
    // frozen NOW constant falls behind it.
    await markObjectImmutable(
      env.DB,
      { domainKind: "admin", hostname: "", tenantId: TENANT_A },
      reserved.objectId,
      Date.now(),
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
        headers: {
          cookie: adminA.cookie,
          origin: HOST_A,
          "x-shop-id": TENANT_A,
        },
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
    // CP4-P: public kinds are admitted now (see "public object admission");
    // previews stay the render service's, never an admin's.
    ["preview kind", { kind: "preview_image" }],
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
      "x-shop-id": TENANT_A,
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

// ── CP4-P: public objects (D92, D93) ────────────────────────────────────────

const PUBLIC_BASE = "https://public-objects.test.invalid";
const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

interface PublicMetadataBody {
  object: MetadataBody["object"] & {
    height: number | null;
    url: string | null;
    width: number | null;
  };
}

interface DimensionRow {
  bucket: string;
  content_type: string;
  height_px: number | null;
  status: string;
  width_px: number | null;
}

/** PNG-headed bytes: the signature and an IHDR of this size, then filler. */
function pngHeaded(width: number, height: number, length = 256): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let index = 24; index < length; index += 1) {
    bytes[index] = (index * 31) % 251;
  }
  return bytes;
}

/** SOI, one APP2 segment per entry of `profile` (its total size), SOF0, filler. */
function jpegHeaded(width: number, height: number, profile: readonly number[] = []): Uint8Array<ArrayBuffer> {
  const parts: number[] = [0xff, 0xd8];
  for (const size of profile) {
    parts.push(0xff, 0xe2, ((size - 2) >>> 8) & 0xff, (size - 2) & 0xff, ...new Array<number>(size - 4).fill(0x41));
  }
  parts.push(0xff, 0xc0, 0x00, 0x0b, 0x08, height >>> 8, height & 0xff, width >>> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00);
  parts.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9);
  return new Uint8Array(parts);
}

const CLEAN_LOGO = bytesOf(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#111"/></svg>',
);

async function reservePublic(
  host: string,
  cookie: string,
  bytes: Uint8Array<ArrayBuffer>,
  overrides: Record<string, unknown> = {},
): Promise<ReservedBody["object"]> {
  return reserveOk(host, cookie, bytes, {
    contentType: "image/png",
    fileName: "Photo.PNG",
    kind: "product_media",
    ...overrides,
  });
}

async function uploadTo(
  host: string,
  cookie: string,
  objectId: string,
  bytes: Uint8Array<ArrayBuffer>,
  targetEnv?: Env,
): Promise<Response> {
  const request = uploadRequest(`${host}/v1/admin/objects/${objectId}/content`, bytes, { cookie });
  return targetEnv === undefined ? exports.default.fetch(request) : worker.fetch(request, targetEnv);
}

/** A reserved and uploaded product image of tenant A. */
async function activePublic(bytes = pngHeaded(640, 480)): Promise<ReservedBody["object"]> {
  const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);
  const uploaded = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);
  expect(uploaded.status).toBe(200);
  return reserved;
}

async function dimensionRow(objectId: string): Promise<DimensionRow | null> {
  return env.DB.prepare(
    `SELECT bucket, content_type, status, width_px, height_px
     FROM stored_objects
     WHERE object_id = ?`,
  )
    .bind(objectId)
    .first<DimensionRow>();
}

/**
 * The public bucket, with `afterPut` run once the bytes are stored and before
 * the route goes on: a deterministic stand-in for what a concurrent request
 * could do in that window. The route only calls put and delete.
 */
function bucketWithAfterPut(afterPut: () => Promise<void>): R2Bucket {
  const real = env.PUBLIC_BUCKET;
  const wrapper: Pick<R2Bucket, "delete" | "put"> = {
    delete: (keys) => real.delete(keys),
    put: async (key, value, options) => {
      const stored = await real.put(key, value, options);
      await afterPut();
      return stored;
    },
  };
  return wrapper as R2Bucket;
}

function principalOf(user: SignedUpUser, tenantId: string): TenantAdminPrincipal {
  return { accountType: "tenant_admin", role: "admin", tenantId, userId: user.userId };
}

describe("public object admission (D92)", () => {
  it("reserves a product image in the public bucket under the tenant's prefix", async () => {
    const bytes = pngHeaded(10, 10);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);

    expect(reserved.objectKey).toBe(`shops/${TENANT_A}/product_media/${reserved.objectId}/v1/photo.png`);
    expect(await dimensionRow(reserved.objectId)).toEqual({
      bucket: "public",
      content_type: "image/png",
      height_px: null,
      status: "pending",
      width_px: null,
    });
  });

  it("records a stated image/jpg in its canonical spelling", async () => {
    const reserved = await reservePublic(HOST_A, adminA.cookie, jpegHeaded(4, 4), { contentType: "image/jpg" });

    expect((await dimensionRow(reserved.objectId))?.content_type).toBe("image/jpeg");
  });

  it.each([
    ["product_media", "image/jpeg"],
    ["product_media", "image/png"],
    ["product_media", "image/webp"],
    ["product_media", "image/gif"],
    ["product_media", "image/avif"],
    ["shop_branding", "image/jpeg"],
    ["shop_branding", "image/png"],
    ["shop_branding", "image/webp"],
    ["shop_branding", "image/gif"],
    ["shop_branding", "image/avif"],
    ["shop_branding", "image/svg+xml"],
    ["shop_branding", "image/vnd.microsoft.icon"],
  ])("admits %s stated as %s", async (kind, contentType) => {
    const response = await reserve(HOST_A, adminA.cookie, {
      contentType,
      kind,
      sha256: "a".repeat(64),
      sizeBytes: 1_024,
    });

    expect(response.status).toBe(201);
  });

  it.each([
    ["an SVG as a product image", { contentType: "image/svg+xml" }],
    ["an icon as a product image", { contentType: "image/x-icon" }],
    ["HTML", { contentType: "text/html" }],
    ["an octet stream", { contentType: "application/octet-stream" }],
    ["a type with parameters", { contentType: "image/png; q=1" }],
    ["a type no public kind admits", { contentType: "image/bmp", kind: "shop_branding" }],
    ["a product image over 15 MB", { sizeBytes: 15 * 1024 * 1024 + 1 }],
    ["a branding image over 15 MB", { kind: "shop_branding", sizeBytes: 15 * 1024 * 1024 + 1 }],
    ["an SVG over 512 KB", { contentType: "image/svg+xml", kind: "shop_branding", sizeBytes: 512 * 1024 + 1 }],
    ["a preview image", { kind: "preview_image" }],
  ])("refuses %s at reserve time", async (_label, overrides) => {
    const response = await reserve(HOST_A, adminA.cookie, {
      contentType: "image/png",
      kind: "product_media",
      sha256: "a".repeat(64),
      sizeBytes: 1_024,
      ...overrides,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it("admits exactly the caps", async () => {
    for (const [kind, contentType, sizeBytes] of [
      ["product_media", "image/png", 15 * 1024 * 1024],
      ["shop_branding", "image/svg+xml", 512 * 1024],
    ] as const) {
      const response = await reserve(HOST_A, adminA.cookie, { contentType, kind, sha256: "a".repeat(64), sizeBytes });
      expect(response.status).toBe(201);
    }
  });

  it("names a missing public configuration as a reason not to reserve a public kind", () => {
    expect(isKindReservable(env, "product_media")).toBe(true);
    expect(isKindReservable({ ...env, PUBLIC_BUCKET: undefined }, "product_media")).toBe(false);
    expect(isKindReservable({ ...env, PUBLIC_OBJECT_BASE_URL: undefined }, "shop_branding")).toBe(false);
    expect(isKindReservable({ ...env, PUBLIC_OBJECT_BASE_URL: "http://plain.test" }, "shop_branding")).toBe(false);
    // Private kinds are unchanged: their binding is checked at upload.
    expect(isKindReservable({ ...env, PUBLIC_BUCKET: undefined, PRIVATE_BUCKET: undefined }, "print_file")).toBe(true);
  });
});

describe("public object upload (D92)", () => {
  it("stores a proven image in the public bucket with its type, the cache header and its size", async () => {
    const bytes = pngHeaded(640, 480);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);

    const uploaded = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);

    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toEqual({
      object: {
        contentType: "image/png",
        height: 480,
        immutable: false,
        kind: "product_media",
        objectId: reserved.objectId,
        sha256: await sha256Hex(bytes),
        sizeBytes: bytes.length,
        status: "active",
        url: `${PUBLIC_BASE}/shops/${TENANT_A}/product_media/${reserved.objectId}/v1/photo.png`,
        width: 640,
      },
    });

    const stored = await env.PUBLIC_BUCKET.get(reserved.objectKey);
    expect(stored?.httpMetadata).toMatchObject({
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "image/png",
    });
    await expect(stored?.bytes()).resolves.toEqual(bytes);
    // Never in the private bucket.
    await expect(env.PRIVATE_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    expect(await dimensionRow(reserved.objectId)).toMatchObject({
      height_px: 480,
      status: "active",
      width_px: 640,
    });
  });

  it("streams a body larger than the sniffed head, in many chunks, byte for byte", async () => {
    const bytes = pngHeaded(3000, 2000, 300_000);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);

    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    void (async () => {
      for (let offset = 0; offset < bytes.length; offset += 16_384) {
        await writer.write(bytes.slice(offset, offset + 16_384));
      }
      await writer.close();
    })();

    const response = await exports.default.fetch(
      new Request(`${HOST_A}/v1/admin/objects/${reserved.objectId}/content`, {
        body: readable,
        headers: {
          "content-length": String(bytes.length),
          cookie: adminA.cookie,
          origin: HOST_A,
          "x-shop-id": TENANT_A,
        },
        method: "PUT",
      }),
    );

    expect(response.status).toBe(200);
    const stored = await env.PUBLIC_BUCKET.get(reserved.objectKey);
    await expect(stored?.bytes()).resolves.toEqual(bytes);
    expect(await dimensionRow(reserved.objectId)).toMatchObject({ height_px: 2000, width_px: 3000 });
  });

  it("refuses a body that ends before its declared length and stores nothing", async () => {
    const bytes = pngHeaded(64, 64, 4_096);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);

    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    void (async () => {
      await writer.write(bytes.slice(0, 4_000));
      await writer.close();
    })();

    const response = await exports.default.fetch(
      new Request(`${HOST_A}/v1/admin/objects/${reserved.objectId}/content`, {
        body: readable,
        headers: {
          "content-length": String(bytes.length),
          cookie: adminA.cookie,
          origin: HOST_A,
          "x-shop-id": TENANT_A,
        },
        method: "PUT",
      }),
    );

    expect(response.status).toBe(400);
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    expect((await dimensionRow(reserved.objectId))?.status).toBe("pending");
  });

  it.each([
    ["JPEG bytes stated as PNG", "image/png", jpegHeaded(10, 10)],
    ["PNG bytes stated as JPEG", "image/jpeg", pngHeaded(10, 10)],
    ["SVG text stated as PNG", "image/png", CLEAN_LOGO],
    ["HTML stated as GIF", "image/gif", bytesOf("<!doctype html><script>alert(1)</script>")],
    ["a GIF header before markup, stated as WebP", "image/webp", bytesOf('GIF89a<svg onload="alert(1)"/>')],
    ["PNG bytes stated as SVG", "image/svg+xml", pngHeaded(10, 10)],
    ["a GIF header before markup, stated as SVG", "image/svg+xml", bytesOf('GIF89a<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ])("refuses %s and stores nothing", async (_label, contentType, bytes) => {
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes, { contentType, kind: "shop_branding" });

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    await expect(env.PRIVATE_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    expect((await dimensionRow(reserved.objectId))?.status).toBe("pending");
  });

  it("refuses a proven image whose hash is not the declared one", async () => {
    const declared = pngHeaded(20, 20);
    const reserved = await reservePublic(HOST_A, adminA.cookie, declared);
    const forged = pngHeaded(20, 20);
    forged[200] = (forged[200] ?? 0) ^ 0xff;

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, forged);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request", reason: "bytes_not_as_declared" },
    });
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    expect((await dimensionRow(reserved.objectId))?.status).toBe("pending");
  });

  it("stores a clean branding SVG with its size from the file", async () => {
    const reserved = await reservePublic(HOST_A, adminA.cookie, CLEAN_LOGO, {
      contentType: "image/svg+xml",
      fileName: "logo.svg",
      kind: "shop_branding",
    });

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, CLEAN_LOGO);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: { contentType: "image/svg+xml", height: 60, kind: "shop_branding", width: 200 },
    });
    const stored = await env.PUBLIC_BUCKET.head(reserved.objectKey);
    expect(stored?.httpMetadata).toMatchObject({
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "image/svg+xml",
    });
  });

  it("refuses an SVG that carries a script and stores nothing", async () => {
    const bytes = bytesOf(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes, {
      contentType: "image/svg+xml",
      kind: "shop_branding",
    });

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);

    expect(response.status).toBe(400);
    // The admin, and the importer's report, are told why.
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request", reason: "svg_script" },
    });
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    expect((await dimensionRow(reserved.objectId))?.status).toBe("pending");
  });

  it("stores an image whose size sits beyond the bounded read, with the size unknown", async () => {
    // The frame header follows ~66 KB of profile: outside the 64 KiB head.
    const bytes = jpegHeaded(3000, 2000, [65_000, 1_000]);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes, { contentType: "image/jpeg" });

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ object: { height: null, width: null } });
    expect(await dimensionRow(reserved.objectId)).toMatchObject({
      height_px: null,
      status: "active",
      width_px: null,
    });
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.not.toBeNull();
  });

  it("answers 413 when Content-Length exceeds the SVG cap", async () => {
    const reserved = await reservePublic(HOST_A, adminA.cookie, CLEAN_LOGO, {
      contentType: "image/svg+xml",
      kind: "shop_branding",
    });

    const response = await exports.default.fetch(
      uploadRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}/content`, CLEAN_LOGO, {
        contentLength: String(512 * 1024 + 1),
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(413);
    expect((await dimensionRow(reserved.objectId))?.status).toBe("pending");
  });

  it("refuses a second upload to an active public object", async () => {
    const bytes = pngHeaded(30, 30);
    const reserved = await activePublic(bytes);

    const second = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);

    expect(second.status).toBe(409);
    const stored = await env.PUBLIC_BUCKET.get(reserved.objectKey);
    await expect(stored?.bytes()).resolves.toEqual(bytes);
  });

  it("leaves no bytes behind when a removal lands while they are in flight", async () => {
    const bytes = pngHeaded(40, 40);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);
    const tenant = { domainKind: "admin" as const, hostname: "", tenantId: TENANT_A };

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes, {
      ...env,
      PUBLIC_BUCKET: bucketWithAfterPut(async () => {
        await deletePendingOrMutableObject(env.DB, tenant, reserved.objectId, Date.now());
      }),
    });

    expect(response.status).toBe(409);
    expect((await dimensionRow(reserved.objectId))?.status).toBe("deleted");
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
  });

  it("keeps the bytes when a concurrent upload of the same row activated it first", async () => {
    const bytes = pngHeaded(41, 41);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);
    const tenant = { domainKind: "admin" as const, hostname: "", tenantId: TENANT_A };

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes, {
      ...env,
      PUBLIC_BUCKET: bucketWithAfterPut(async () => {
        await activateObject(
          env.DB,
          tenant,
          reserved.objectId,
          { sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
          Date.now(),
        );
      }),
    });

    expect(response.status).toBe(409);
    expect((await dimensionRow(reserved.objectId))?.status).toBe("active");
    const stored = await env.PUBLIC_BUCKET.get(reserved.objectKey);
    await expect(stored?.bytes()).resolves.toEqual(bytes);
  });

  it.each([
    ["no public bucket", { PUBLIC_BUCKET: undefined }],
    ["no public address", { PUBLIC_OBJECT_BASE_URL: undefined }],
    ["an address with a path", { PUBLIC_OBJECT_BASE_URL: `${PUBLIC_BASE}/images` }],
    ["a plain-http address", { PUBLIC_OBJECT_BASE_URL: "http://public-objects.test.invalid" }],
  ])("refuses the upload with %s, and stores nothing", async (_label, overrides) => {
    const bytes = pngHeaded(12, 12);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);

    const response = await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes, {
      ...env,
      ...overrides,
    });

    expect(response.status).toBe(404);
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    expect((await dimensionRow(reserved.objectId))?.status).toBe("pending");
  });
});

describe("public object reads", () => {
  it("gives a public object's metadata its size and its address", async () => {
    const reserved = await activePublic(pngHeaded(800, 600));

    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}`, "GET", { cookie: adminA.cookie }),
    );
    const body = await response.json<PublicMetadataBody>();

    expect(response.status).toBe(200);
    expect(body.object).toMatchObject({
      height: 600,
      status: "active",
      url: `${PUBLIC_BASE}/shops/${TENANT_A}/product_media/${reserved.objectId}/v1/photo.png`,
      width: 800,
    });
    expect(body.object).not.toHaveProperty("objectKey");

    await expect(
      getAdminObjectMetadataWithUrl(env, env.DB, principalOf(adminA, TENANT_A), reserved.objectId),
    ).resolves.toMatchObject({
      height: 600,
      url: `${PUBLIC_BASE}/shops/${TENANT_A}/product_media/${reserved.objectId}/v1/photo.png`,
      width: 800,
    });
    // With no valid base the metadata still answers, without an address.
    await expect(
      getAdminObjectMetadataWithUrl(
        { ...env, PUBLIC_OBJECT_BASE_URL: undefined },
        env.DB,
        principalOf(adminA, TENANT_A),
        reserved.objectId,
      ),
    ).resolves.toMatchObject({ url: null, width: 800 });
  });

  it("keeps a private object's metadata exactly as it was", async () => {
    const bytes = bytesOf("private-metadata");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);
    await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);

    await expect(
      getAdminObjectMetadataWithUrl(env, env.DB, principalOf(adminA, TENANT_A), reserved.objectId),
    ).resolves.toEqual({
      contentType: "image/png",
      immutable: false,
      kind: "print_file",
      objectId: reserved.objectId,
      sha256: await sha256Hex(bytes),
      sizeBytes: bytes.length,
      status: "active",
    });
  });

  it("never proxies a public object's bytes: its content route is the opaque 404", async () => {
    const reserved = await activePublic();

    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}/content`, "GET", { cookie: adminA.cookie }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });
});

describe("object removal takes the bytes out of the bucket the row names (D93)", () => {
  it("removes a public object from the public bucket and leaves the private bucket alone", async () => {
    const reserved = await activePublic();
    // A decoy under the same key in the private bucket: the old code deleted
    // from the private bucket whatever the row said.
    await env.PRIVATE_BUCKET.put(reserved.objectKey, "private-decoy");

    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}`, "DELETE", { cookie: adminA.cookie }),
    );

    expect(response.status).toBe(204);
    expect((await dimensionRow(reserved.objectId))?.status).toBe("deleted");
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    const decoy = await env.PRIVATE_BUCKET.get(reserved.objectKey);
    await expect(decoy?.text()).resolves.toBe("private-decoy");
  });

  it("removes a private object from the private bucket and leaves the public bucket alone", async () => {
    const bytes = bytesOf("private-removal");
    const reserved = await reserveOk(HOST_A, adminA.cookie, bytes);
    await uploadTo(HOST_A, adminA.cookie, reserved.objectId, bytes);
    await env.PUBLIC_BUCKET.put(reserved.objectKey, "public-decoy");

    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}`, "DELETE", { cookie: adminA.cookie }),
    );

    expect(response.status).toBe(204);
    await expect(env.PRIVATE_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    const decoy = await env.PUBLIC_BUCKET.get(reserved.objectKey);
    await expect(decoy?.text()).resolves.toBe("public-decoy");
  });

  it("removes the bytes of a public object whose row was still pending when it was read", async () => {
    const bytes = pngHeaded(5, 5);
    const reserved = await reservePublic(HOST_A, adminA.cookie, bytes);
    // What an upload leaves when it stores and activates between the
    // removal's read of the row and its tombstone.
    await env.PUBLIC_BUCKET.put(reserved.objectKey, "stray");
    await env.PRIVATE_BUCKET.put(reserved.objectKey, "decoy");

    const response = await exports.default.fetch(
      objectRequest(`${HOST_A}/v1/admin/objects/${reserved.objectId}`, "DELETE", { cookie: adminA.cookie }),
    );

    expect(response.status).toBe(204);
    expect((await dimensionRow(reserved.objectId))?.status).toBe("deleted");
    // Bytes anyone can read never outlive their row, whatever the row said
    // when the removal read it.
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    await expect(env.PRIVATE_BUCKET.head(reserved.objectKey)).resolves.not.toBeNull();
    await env.PRIVATE_BUCKET.delete(reserved.objectKey);
  });
});

describe("public object tenant isolation", () => {
  it("refuses tenant B's admin every operation on tenant A's public object", async () => {
    const bytes = pngHeaded(50, 50);
    const reserved = await activePublic(bytes);
    const before = await dimensionRow(reserved.objectId);

    const attempts = [
      objectRequest(`${HOST_B}/v1/admin/objects/${reserved.objectId}`, "GET", { cookie: adminB.cookie }),
      objectRequest(`${HOST_B}/v1/admin/objects/${reserved.objectId}/content`, "GET", { cookie: adminB.cookie }),
      uploadRequest(`${HOST_B}/v1/admin/objects/${reserved.objectId}/content`, pngHeaded(50, 50), {
        cookie: adminB.cookie,
      }),
      objectRequest(`${HOST_B}/v1/admin/objects/${reserved.objectId}`, "DELETE", { cookie: adminB.cookie }),
    ];
    for (const attempt of attempts) {
      const response = await exports.default.fetch(attempt);
      expect(response.status).toBe(404);
    }

    await expect(
      getAdminObjectMetadataWithUrl(env, env.DB, principalOf(adminB, TENANT_B), reserved.objectId),
    ).resolves.toBeNull();
    expect(await dimensionRow(reserved.objectId)).toEqual(before);
    const stored = await env.PUBLIC_BUCKET.get(reserved.objectKey);
    await expect(stored?.bytes()).resolves.toEqual(bytes);
  });

  it("refuses tenant A's admin a pending upload target of tenant B", async () => {
    const bytes = pngHeaded(9, 9);
    const reserved = await reservePublic(HOST_B, adminB.cookie, bytes);

    const response = await exports.default.fetch(
      uploadRequest(`${HOST_B}/v1/admin/objects/${reserved.objectId}/content`, bytes, {
        cookie: adminA.cookie,
        shopId: TENANT_B,
      }),
    );

    expect(response.status).toBe(404);
    await expect(env.PUBLIC_BUCKET.head(reserved.objectKey)).resolves.toBeNull();
    expect((await dimensionRow(reserved.objectId))?.status).toBe("pending");
  });

  it("refuses tenant A's admin a reservation in tenant B's shop", async () => {
    const response = await exports.default.fetch(
      objectRequest(`${HOST_B}/v1/admin/objects`, "POST", {
        body: { contentType: "image/png", kind: "product_media", sha256: "a".repeat(64), sizeBytes: 10 },
        cookie: adminA.cookie,
        shopId: TENANT_B,
      }),
    );

    expect(response.status).toBe(404);
  });

  it("hides every public-object operation from an ordinary user and from a request without a session", async () => {
    const bytes = pngHeaded(7, 7);
    const active = await activePublic(bytes);
    const pending = await reservePublic(HOST_A, adminA.cookie, bytes);

    for (const cookie of [ordinary.cookie, undefined]) {
      const attempts = [
        objectRequest(`${HOST_A}/v1/admin/objects`, "POST", {
          body: { contentType: "image/png", kind: "product_media", sha256: "a".repeat(64), sizeBytes: 10 },
          cookie,
        }),
        uploadRequest(`${HOST_A}/v1/admin/objects/${pending.objectId}/content`, bytes, { cookie }),
        objectRequest(`${HOST_A}/v1/admin/objects/${active.objectId}`, "GET", { cookie }),
        objectRequest(`${HOST_A}/v1/admin/objects/${active.objectId}/content`, "GET", { cookie }),
        objectRequest(`${HOST_A}/v1/admin/objects/${active.objectId}`, "DELETE", { cookie }),
      ];
      for (const attempt of attempts) {
        const response = await exports.default.fetch(attempt);
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
      }
    }

    expect((await dimensionRow(pending.objectId))?.status).toBe("pending");
    expect((await dimensionRow(active.objectId))?.status).toBe("active");
    await expect(env.PUBLIC_BUCKET.head(pending.objectKey)).resolves.toBeNull();
  });
});
