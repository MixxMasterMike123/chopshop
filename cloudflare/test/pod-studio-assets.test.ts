import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  expectNoCostKeys,
  grantActingAs,
  grantPlatformAdmin,
  grantTenantAdmin,
  OPAQUE_NOT_FOUND,
  seedTenant,
  signUp,
} from "./pod-fixtures";

/**
 * CP5-WH (D101): the design studio's platform-owned assets — the mockup
 * templates and the 3D models — and their files.
 *
 * Order: who may do what (the opaque 404 for everyone but the platform on a
 * write, and for everyone but a shop's admin on a seller read); the upload
 * (the type proven from the bytes, the same bytes stored once, never under a
 * shop's key); the template and model writes (create, the same document
 * again is a no-op, refusals); what a seller sees (active only, the Firebase
 * shape with addresses, no platform-only field).
 */

const HOST = "https://api.studiotest.test";
const TENANT_A = "tenant-studio-a";
const TENANT_B = "tenant-studio-b";
const BASE = "https://public-objects.test.invalid";

let platform: { cookie: string; userId: string };
let tenantAdmin: { cookie: string; userId: string };

// ── small real images (the sniff and the size reader prove them) ────────────

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: readonly number[]): number[] {
  const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32(body))];
}

/** A PNG whose header says width × height (distinct sizes → distinct bytes). */
function png(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...chunk("IDAT", [0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]),
    ...chunk("IEND", []),
  ]);
}

const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff,
  0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');

// ── requests ────────────────────────────────────────────────────────────────

interface CallOptions {
  body?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  cookie?: string | null;
  origin?: string | null;
  shopId?: string;
}

function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers();
  if (options.cookie !== undefined && options.cookie !== null) headers.set("cookie", options.cookie);
  if (options.shopId !== undefined) headers.set("x-shop-id", options.shopId);
  const origin = options.origin === undefined ? HOST : options.origin;
  if (origin !== null) headers.set("origin", origin);
  let body: BodyInit | undefined;
  if (options.bytes !== undefined) {
    body = options.bytes as Uint8Array<ArrayBuffer>;
    headers.set("content-type", options.contentType ?? "image/png");
    headers.set("content-length", String(options.bytes.byteLength));
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return exports.default.fetch(new Request(`${HOST}${path}`, { body, headers, method }));
}

const asPlatform = (method: string, path: string, options: CallOptions = {}) =>
  call(method, path, { cookie: platform.cookie, ...options });

async function upload(bytes: Uint8Array, contentType = "image/png"): Promise<{ fileId: string; url: string }> {
  const response = await asPlatform("POST", "/v1/platform/pod/studio-files", { bytes, contentType });
  expect([200, 201]).toContain(response.status);
  const { file } = await response.json<{ file: { fileId: string; url: string } }>();
  return file;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

// ── documents ───────────────────────────────────────────────────────────────

function flatTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    colorways: [
      { hex: "#ffffff", id: "white", label: "Vit" },
      { hex: "#1a1a1a", id: "black", label: "Svart" },
    ],
    garment: "bag",
    label: "Tygkasse",
    printAreaMm: { front: { h: 250, w: 250 } },
    printAreas: { front: { h: 300, w: 300, x: 250, y: 330 } },
    profileId: "bag_dtg",
    provisional: true,
    slotLabels: { front: "Framsida" },
    sortOrder: 40,
    ...overrides,
  };
}

let teeFront: string;
let teeBack: string;
let mapFront: string;
let mapBack: string;

function photoTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    colorways: [
      { backFileId: teeBack, frontFileId: teeFront, hex: "#f3f3f3", id: "white", label: "Vit" },
      { backFileId: null, frontFileId: null, hex: "#363435", id: "black", label: "Svart", tuning: { blend: "normal" } },
    ],
    garment: "tee",
    label: "T-shirt",
    photo: {
      displacement: {
        alpha: 0.8,
        backFileId: mapBack,
        blend: "multiply",
        blur: 6,
        contrast: 2,
        frontFileId: mapFront,
        h: 2186,
        scale: 30,
        w: 1920,
      },
      h: 1093,
      w: 960,
    },
    pocketPositions: { center: { x: 434 }, left: { x: 535 }, right: { x: 333 } },
    printAreaMm: {
      back: { h: 400, w: 300 },
      front: { h: 350, w: 300 },
      left_sleeve: { h: 80, w: 80 },
      pocket: { h: 100, w: 100 },
    },
    printAreas: {
      back: { h: 373, w: 280, x: 340, y: 340 },
      front: { h: 322, w: 276, x: 342, y: 411 },
      left_sleeve: { h: 74, w: 74, x: 725, y: 365 },
      pocket: { h: 92, w: 92, x: 535, y: 365 },
    },
    printOffsetTopMm: { back: 85, front: 65 },
    profileId: "apparel_dtg",
    provisional: false,
    sortOrder: 10,
    ...overrides,
  };
}

let modelPhoto: string;
let modelMap: string;
let modelMask: string;
let wrongSizeMap: string;

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alpha: 0.8,
    blend: "multiply",
    displacementBlur: 6,
    displacementContrast: 1,
    displacementScale: 30,
    label: "T-shirt på modell",
    output: { h: 1936, w: 1600 },
    perColorway: { black: { alpha: 0.9, blend: "screen" } },
    views: {
      front: {
        colorways: [
          {
            displacementFileId: modelMap,
            id: "white",
            label: "Vit",
            mapContrastSd: 41.5,
            maskFileId: modelMask,
            photoFileId: modelPhoto,
          },
        ],
        h: 1936,
        originalDims: { h: 3871, w: 3200 },
        printArea: { h: 700, w: 525, x: 548, y: 875 },
        printAreaMm: { h: 400, w: 300 },
        w: 1600,
      },
    },
    ...overrides,
  };
}

beforeAll(async () => {
  await seedTenant(TENANT_A, "studio-a.studiotest.test");
  await seedTenant(TENANT_B, "studio-b.studiotest.test");
  platform = await signUp("studio-platform@studiotest.test");
  await grantPlatformAdmin(platform.userId);
  tenantAdmin = await signUp("studio-admin@studiotest.test");
  await grantTenantAdmin(tenantAdmin.userId, TENANT_A);
  await grantActingAs(platform.userId, TENANT_A);

  teeFront = (await upload(png(1920, 2186))).fileId;
  teeBack = (await upload(png(1920, 2187))).fileId;
  mapFront = (await upload(png(1920, 2188))).fileId;
  mapBack = (await upload(png(1920, 2189))).fileId;
  modelPhoto = (await upload(png(1600, 1936))).fileId;
  modelMap = (await upload(new Uint8Array([...png(1600, 1936), 0]))).fileId;
  modelMask = (await upload(new Uint8Array([...png(1600, 1936), 0, 0]))).fileId;
  wrongSizeMap = (await upload(png(1600, 1937))).fileId;
});

// ── who ─────────────────────────────────────────────────────────────────────

describe("the platform writes, nobody else", () => {
  const writes: Array<[string, string, CallOptions]> = [
    ["POST", "/v1/platform/pod/studio-files", { bytes: png(7, 7) }],
    ["PUT", "/v1/platform/pod/mockup-templates/bag_who", { body: flatTemplate() }],
    ["PATCH", "/v1/platform/pod/mockup-templates/bag_who", { body: { active: false } }],
    ["PUT", "/v1/platform/pod/3d-models/whoModel", { body: { label: "x", views: { front: { printArea: { h: 0, w: 0, x: 0, y: 0 } } } } }],
    ["PATCH", "/v1/platform/pod/3d-models/whoModel", { body: { active: false } }],
  ];
  const reads = ["/v1/platform/pod/mockup-templates", "/v1/platform/pod/3d-models"];

  it("a tenant admin (with or without X-Shop-Id) gets the opaque 404 and writes nothing", async () => {
    const before = {
      audits: await count("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'pod.%' AND resource_type LIKE 'pod_%'"),
      files: await count("SELECT COUNT(*) AS n FROM pod_studio_files"),
      models: await count("SELECT COUNT(*) AS n FROM pod_3d_models"),
      templates: await count("SELECT COUNT(*) AS n FROM pod_mockup_templates"),
    };
    for (const [method, path, options] of writes) {
      for (const shopId of [undefined, TENANT_A]) {
        const response = await call(method, path, { ...options, cookie: tenantAdmin.cookie, shopId });
        expect(response.status, `${method} ${path} ${shopId ?? ""}`).toBe(404);
        expect(await response.json()).toStrictEqual(OPAQUE_NOT_FOUND);
      }
    }
    for (const path of reads) {
      const response = await call("GET", path, { cookie: tenantAdmin.cookie });
      expect(response.status, path).toBe(404);
    }
    expect({
      audits: await count("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'pod.%' AND resource_type LIKE 'pod_%'"),
      files: await count("SELECT COUNT(*) AS n FROM pod_studio_files"),
      models: await count("SELECT COUNT(*) AS n FROM pod_3d_models"),
      templates: await count("SELECT COUNT(*) AS n FROM pod_mockup_templates"),
    }).toStrictEqual(before);
  });

  it("signed out, a platform session that names a shop (acting-as), or a cross-origin write: the opaque 404", async () => {
    for (const [method, path, options] of writes) {
      for (const variant of [
        { cookie: null },
        { cookie: platform.cookie, shopId: TENANT_A },
        { cookie: platform.cookie, origin: "https://evil.test" },
        { cookie: platform.cookie, origin: null },
      ] as const) {
        const response = await call(method, path, { ...options, ...variant });
        expect(response.status, `${method} ${path} ${JSON.stringify(variant)}`).toBe(404);
        expect(await response.json()).toStrictEqual(OPAQUE_NOT_FOUND);
      }
    }
    for (const path of reads) {
      expect((await call("GET", path, { cookie: null })).status).toBe(404);
      expect((await call("GET", path, { cookie: platform.cookie, shopId: TENANT_A })).status).toBe(404);
    }
  });

  it("methods a path does not own are the opaque 404", async () => {
    for (const [method, path] of [
      ["GET", "/v1/platform/pod/studio-files"],
      ["DELETE", "/v1/platform/pod/mockup-templates/bag_who"],
      ["GET", "/v1/platform/pod/mockup-templates/bag_who"],
      ["POST", "/v1/platform/pod/mockup-templates"],
      ["DELETE", "/v1/platform/pod/3d-models/whoModel"],
    ] as const) {
      const response = await asPlatform(method, path);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("the seller reads: no session, no X-Shop-Id, a foreign shop, or a write method — the opaque 404", async () => {
    for (const path of ["/v1/admin/pod/mockup-templates", "/v1/admin/pod/3d-models"]) {
      for (const options of [
        { cookie: null, shopId: TENANT_A },
        { cookie: tenantAdmin.cookie },
        { cookie: tenantAdmin.cookie, shopId: TENANT_B },
        { cookie: platform.cookie },
      ]) {
        const response = await call("GET", path, options);
        expect(response.status, `${path} ${JSON.stringify(options)}`).toBe(404);
        expect(await response.json()).toStrictEqual(OPAQUE_NOT_FOUND);
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect((await call(method, path, { body: {}, cookie: tenantAdmin.cookie, shopId: TENANT_A })).status).toBe(404);
      }
    }
  });
});

// ── the upload ──────────────────────────────────────────────────────────────

describe("POST /v1/platform/pod/studio-files", () => {
  it("stores the bytes under platform/studio/<id>/, never under shops/, and answers the address", async () => {
    const bytes = png(33, 44);
    const response = await asPlatform("POST", "/v1/platform/pod/studio-files", { bytes });
    expect(response.status).toBe(201);
    const { file } = await response.json<{ file: Record<string, unknown> }>();
    const fileId = file.fileId as string;
    expect(file).toStrictEqual({
      contentType: "image/png",
      fileId,
      height: 44,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      sizeBytes: bytes.byteLength,
      url: `${BASE}/platform/studio/${fileId}/v1/image.png`,
      width: 33,
    });
    const row = await env.DB.prepare("SELECT object_key, status, created_by FROM pod_studio_files WHERE file_id = ?")
      .bind(fileId)
      .first<{ created_by: string; object_key: string; status: string }>();
    expect(row).toStrictEqual({
      created_by: platform.userId,
      object_key: `platform/studio/${fileId}/v1/image.png`,
      status: "active",
    });
    const stored = await env.PUBLIC_BUCKET.get(`platform/studio/${fileId}/v1/image.png`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toStrictEqual(bytes);
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'pod.studio_file.upload' AND resource_id = ? AND tenant_id IS NULL",
        fileId,
      ),
    ).toBe(1);
    // No stored_objects row: a platform file is nobody's tenant object.
    expect(await count("SELECT COUNT(*) AS n FROM stored_objects WHERE object_key LIKE 'platform/%'")).toBe(0);
  });

  it("the same bytes again answer the same file (200) and store nothing new", async () => {
    const bytes = png(55, 66);
    const first = await asPlatform("POST", "/v1/platform/pod/studio-files", { bytes });
    expect(first.status).toBe(201);
    const files = await count("SELECT COUNT(*) AS n FROM pod_studio_files");
    const second = await asPlatform("POST", "/v1/platform/pod/studio-files", { bytes });
    expect(second.status).toBe(200);
    expect((await second.json<{ file: { fileId: string } }>()).file.fileId).toBe(
      (await first.json<{ file: { fileId: string } }>()).file.fileId,
    );
    expect(await count("SELECT COUNT(*) AS n FROM pod_studio_files")).toBe(files);
  });

  it.each([
    ["PNG bytes stated as WebP", png(9, 9), "image/webp", "type_not_as_stated"],
    ["PNG bytes stated as nothing", png(9, 10), "", "type_not_as_stated"],
    ["text stated as PNG", new TextEncoder().encode("not an image at all"), "image/png", "not_an_allowed_image"],
    ["an SVG", SVG, "image/svg+xml", "not_an_allowed_image"],
    ["a GIF", GIF, "image/gif", "not_an_allowed_image"],
  ])("%s is refused by its bytes, and nothing is stored", async (_name, bytes, contentType, reason) => {
    const files = await count("SELECT COUNT(*) AS n FROM pod_studio_files");
    const response = await asPlatform("POST", "/v1/platform/pod/studio-files", { bytes, contentType });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "invalid_request", message: "Request is not valid", reason },
    });
    expect(await count("SELECT COUNT(*) AS n FROM pod_studio_files")).toBe(files);
  });

  it("a declared length over 15 MiB is 413 before the body is read", async () => {
    const headers = new Headers({
      "content-length": String(15 * 1024 * 1024 + 1),
      "content-type": "image/png",
      cookie: platform.cookie,
      origin: HOST,
    });
    const tooLarge = await exports.default.fetch(
      new Request(`${HOST}/v1/platform/pod/studio-files`, { body: png(1, 1) as Uint8Array<ArrayBuffer>, headers, method: "POST" }),
    );
    expect(tooLarge.status).toBe(413);
  });

  it("the table refuses a key outside platform/studio/<file id>/ (the D101 containment)", async () => {
    const at = new Date().toISOString();
    for (const key of ["shops/tenant-studio-a/product_media/x/v1/image.png", "platform/studio/other/v1/image.png"]) {
      await expect(
        env.DB.prepare(
          `INSERT INTO pod_studio_files (file_id, object_key, content_type, size_bytes, sha256, status, created_by, created_at, updated_at)
           VALUES ('00000000-0000-4000-8000-000000000001', ?, 'image/png', 1, ?, 'pending', 'x', ?, ?)`,
        )
          .bind(key, "a".repeat(64), at, at)
          .run(),
      ).rejects.toThrow();
    }
  });
});

// ── the writes ──────────────────────────────────────────────────────────────

describe("PUT/PATCH /v1/platform/pod/mockup-templates/:templateId", () => {
  it("creates (201), the same document again changes nothing (200, changed:false, no audit row), a change updates", async () => {
    const created = await asPlatform("PUT", "/v1/platform/pod/mockup-templates/tee_bc_e150", { body: photoTemplate() });
    expect(created.status).toBe(201);
    const body = await created.json<{ changed: boolean; template: Record<string, unknown> }>();
    expect(body.changed).toBe(true);
    expect(body.template).toMatchObject({ ...photoTemplate(), active: true, templateId: "tee_bc_e150" });

    const audits = () =>
      count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_type = 'pod_mockup_template' AND resource_id = 'tee_bc_e150'");
    expect(await audits()).toBe(1);
    const again = await asPlatform("PUT", "/v1/platform/pod/mockup-templates/tee_bc_e150", { body: photoTemplate() });
    expect(again.status).toBe(200);
    expect((await again.json<{ changed: boolean }>()).changed).toBe(false);
    expect(await audits()).toBe(1);

    const changed = await asPlatform("PUT", "/v1/platform/pod/mockup-templates/tee_bc_e150", {
      body: photoTemplate({ label: "T-shirt B&C" }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ changed: true, template: { label: "T-shirt B&C" } });
    expect(await audits()).toBe(2);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'pod.mockup_template.update' AND resource_id = 'tee_bc_e150' AND actor_user_id = ?",
        platform.userId,
      ),
    ).toBe(1);
    await asPlatform("PUT", "/v1/platform/pod/mockup-templates/tee_bc_e150", { body: photoTemplate() });
  });

  it.each([
    ["a px rect whose aspect is not its mm size's", () => flatTemplate({ printAreas: { front: { h: 200, w: 300, x: 0, y: 0 } } }), "aspect_mismatch"],
    ["a file that does not exist", () => photoTemplate({ colorways: [{ frontFileId: "00000000-0000-4000-8000-00000000dead", hex: "#ffffff", id: "white", label: "Vit" }] }), "file_not_found"],
    ["a photo file on a flat template", () => flatTemplate({ colorways: [{ frontFileId: teeFront, hex: "#ffffff", id: "white", label: "Vit" }] }), "files_on_flat_template"],
    ["a rect outside the photo", () => photoTemplate({ printAreas: { ...(photoTemplate().printAreas as object), back: { h: 373, w: 280, x: 900, y: 340 } } }), "area_outside_photo"],
    ["a colourway tuning without a displacement", () => flatTemplate({ colorways: [{ hex: "#ffffff", id: "white", label: "Vit", tuning: { blend: "normal" } }] }), "tuning_without_displacement"],
    ["pocket positions without a pocket", () => flatTemplate({ pocketPositions: { left: { x: 1 } } }), "pocket_positions_without_pocket"],
    ["a colourway twice", () => flatTemplate({ colorways: [{ hex: "#ffffff", id: "white", label: "Vit" }, { hex: "#ffffff", id: "white", label: "Vit 2" }] }), "duplicate_colorway"],
  ])("refuses %s (400 %s) and writes nothing", async (_name, build, reason) => {
    const response = await asPlatform("PUT", "/v1/platform/pod/mockup-templates/refused_one", { body: build() });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "invalid_request", message: "Request is not valid", reason },
    });
    expect(await count("SELECT COUNT(*) AS n FROM pod_mockup_templates WHERE template_id = 'refused_one'")).toBe(0);
  });

  it.each([
    ["an unknown key", flatTemplate({ blankCostSek: 60 })],
    ["a slot outside PRINT_SLOTS", flatTemplate({ printAreaMm: { chest: { h: 250, w: 250 } }, printAreas: { chest: { h: 300, w: 300, x: 0, y: 0 } } })],
    ["mm without its px rect", flatTemplate({ printAreaMm: { back: { h: 1, w: 1 }, front: { h: 250, w: 250 } } })],
    ["a garment outside the vocabulary's grammar", flatTemplate({ garment: "T-Shirt" })],
    ["millimetres past 2000", flatTemplate({ printAreaMm: { front: { h: 2500, w: 2500 } } })],
    ["fractional pixels", flatTemplate({ printAreas: { front: { h: 300.5, w: 300, x: 0, y: 0 } } })],
    ["no colourway", flatTemplate({ colorways: [] })],
    ["a bad hex", flatTemplate({ colorways: [{ hex: "white", id: "white", label: "Vit" }] })],
  ])("refuses %s as a shape error", async (_name, body) => {
    const response = await asPlatform("PUT", "/v1/platform/pod/mockup-templates/shape_one", { body });
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: { code: "invalid_request", message: "Request is not valid" } });
  });

  it("a malformed id in the path is the opaque 404", async () => {
    for (const id of ["Tee", "-tee", "a%2Fb", "x".repeat(65)]) {
      const response = await asPlatform("PUT", `/v1/platform/pod/mockup-templates/${id}`, { body: flatTemplate() });
      expect(response.status, id).toBe(404);
    }
  });

  it("PATCH { active } deactivates and activates, audited; an unknown id is 404", async () => {
    expect((await asPlatform("PUT", "/v1/platform/pod/mockup-templates/bag_flat", { body: flatTemplate() })).status).toBe(201);
    const off = await asPlatform("PATCH", "/v1/platform/pod/mockup-templates/bag_flat", { body: { active: false } });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ changed: true, template: { active: false } });
    expect(
      await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'pod.mockup_template.deactivate' AND resource_id = 'bag_flat'"),
    ).toBe(1);
    const again = await asPlatform("PATCH", "/v1/platform/pod/mockup-templates/bag_flat", { body: { active: false } });
    expect(await again.json()).toMatchObject({ changed: false });
    expect((await asPlatform("PATCH", "/v1/platform/pod/mockup-templates/nope", { body: { active: true } })).status).toBe(404);
    expect((await asPlatform("PATCH", "/v1/platform/pod/mockup-templates/bag_flat", { body: { active: "no" } })).status).toBe(400);
  });

  it("the platform list holds inactive templates too, with the files they name", async () => {
    const response = await asPlatform("GET", "/v1/platform/pod/mockup-templates");
    expect(response.status).toBe(200);
    const body = await response.json<{ files: Record<string, { url: string }>; templates: Array<{ active: boolean; templateId: string }> }>();
    expect(body.templates.find((t) => t.templateId === "bag_flat")?.active).toBe(false);
    expect(body.templates.find((t) => t.templateId === "tee_bc_e150")?.active).toBe(true);
    expect(body.files[teeFront]?.url).toBe(`${BASE}/platform/studio/${teeFront}/v1/image.png`);
  });
});

describe("PUT/PATCH /v1/platform/pod/3d-models/:modelId", () => {
  it("creates, the same document again is a no-op, and a set whose files differ in size is refused", async () => {
    const created = await asPlatform("PUT", "/v1/platform/pod/3d-models/AbCdEf0123456789wxyz", { body: model() });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ changed: true, model: { ...model(), active: true, modelId: "AbCdEf0123456789wxyz" } });
    const again = await asPlatform("PUT", "/v1/platform/pod/3d-models/AbCdEf0123456789wxyz", { body: model() });
    expect(again.status).toBe(200);
    expect((await again.json<{ changed: boolean }>()).changed).toBe(false);

    const unregistered = model();
    (unregistered.views as { front: { colorways: Array<Record<string, unknown>> } }).front.colorways[0]!.displacementFileId =
      wrongSizeMap;
    const refused = await asPlatform("PUT", "/v1/platform/pod/3d-models/AbCdEf0123456789wxyz", { body: unregistered });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { reason: "not_registered" } });
  });

  it("an uncalibrated model (zero rect, no size yet, no colourway) is a valid platform record", async () => {
    const response = await asPlatform("PUT", "/v1/platform/pod/3d-models/blankModel", {
      body: { label: "Namnlös", views: { front: { colorways: [], h: null, printArea: { h: 0, w: 0, x: 0, y: 0 }, printAreaMm: { h: 400, w: 300 }, w: null } } },
    });
    expect(response.status).toBe(201);
  });

  it("a second model, then deactivated", async () => {
    expect((await asPlatform("PUT", "/v1/platform/pod/3d-models/offModel", { body: model({ label: "Avstängd" }) })).status).toBe(201);
    const off = await asPlatform("PATCH", "/v1/platform/pod/3d-models/offModel", { body: { active: false } });
    expect(await off.json()).toMatchObject({ changed: true, model: { active: false } });
  });
});

// ── what a seller sees ──────────────────────────────────────────────────────

/** Keys that are the platform's alone: none may reach a seller. */
const PLATFORM_ONLY_KEY_PARTS = [
  "active",
  "sortorder",
  "fileid",
  "mapcontrastsd",
  "originaldims",
  "createdat",
  "updatedat",
  "createdby",
  "updatedby",
  "sha256",
  "sizebytes",
];

function expectNoPlatformOnlyKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoPlatformOnlyKeys(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    // `profileId` is the print profile, not a file: the one key that merely ends like one.
    const lowered = key === "profileId" ? "" : key.toLowerCase();
    expect(PLATFORM_ONLY_KEY_PARTS.find((part) => lowered.includes(part)), `${path}.${key}`).toBeUndefined();
    expectNoPlatformOnlyKeys(entry, `${path}.${key}`);
  }
}

describe("GET /v1/admin/pod/mockup-templates and /3d-models (the seller)", () => {
  it("lists only ACTIVE templates, in the Firebase document's shape, with addresses", async () => {
    for (const cookie of [tenantAdmin.cookie, platform.cookie]) {
      // A shop's admin, and the platform acting as that shop.
      const response = await call("GET", "/v1/admin/pod/mockup-templates", { cookie, shopId: TENANT_A });
      expect(response.status).toBe(200);
      const body = await response.json<{ provisional: boolean; templates: Array<Record<string, unknown>> }>();
      const ids = body.templates.map((t) => t.id);
      expect(ids).toContain("tee_bc_e150");
      expect(ids).not.toContain("bag_flat");
      expect(body.templates.find((t) => t.id === "tee_bc_e150")).toStrictEqual({
        colorways: [
          { hex: "#f3f3f3", id: "white", label: "Vit" },
          { hex: "#363435", id: "black", label: "Svart" },
        ],
        garment: "tee",
        id: "tee_bc_e150",
        label: "T-shirt",
        photo: {
          backUrls: { white: `${BASE}/platform/studio/${teeBack}/v1/image.png` },
          displacement: {
            alpha: 0.8,
            blend: "multiply",
            blur: 6,
            contrast: 2,
            h: 2186,
            perColorway: { black: { blend: "normal" } },
            scale: 30,
            urls: {
              back: `${BASE}/platform/studio/${mapBack}/v1/image.png`,
              front: `${BASE}/platform/studio/${mapFront}/v1/image.png`,
            },
            w: 1920,
          },
          h: 1093,
          urls: { white: `${BASE}/platform/studio/${teeFront}/v1/image.png` },
          w: 960,
        },
        pocketPositions: { center: { x: 434 }, left: { x: 535 }, right: { x: 333 } },
        printAreaMm: {
          back: { h: 400, w: 300 },
          front: { h: 350, w: 300 },
          left_sleeve: { h: 80, w: 80 },
          pocket: { h: 100, w: 100 },
        },
        printAreas: {
          back: { h: 373, w: 280, x: 340, y: 340 },
          front: { h: 322, w: 276, x: 342, y: 411 },
          left_sleeve: { h: 74, w: 74, x: 725, y: 365 },
          pocket: { h: 92, w: 92, x: 535, y: 365 },
        },
        printOffsetTopMm: { back: 85, front: 65 },
        profileId: "apparel_dtg",
        provisional: false,
      });
      expectNoPlatformOnlyKeys(body);
      expectNoCostKeys(body);
    }
  });

  it("an active flat template appears without a photo; provisional reflects it; deactivating hides it again", async () => {
    await asPlatform("PATCH", "/v1/platform/pod/mockup-templates/bag_flat", { body: { active: true } });
    const on = await (await call("GET", "/v1/admin/pod/mockup-templates", { cookie: tenantAdmin.cookie, shopId: TENANT_A }))
      .json<{ provisional: boolean; templates: Array<Record<string, unknown>> }>();
    expect(on.provisional).toBe(true);
    expect(on.templates.map((t) => t.id)).toStrictEqual(["tee_bc_e150", "bag_flat"]);
    expect(on.templates[1]).toStrictEqual({
      colorways: [
        { hex: "#ffffff", id: "white", label: "Vit" },
        { hex: "#1a1a1a", id: "black", label: "Svart" },
      ],
      garment: "bag",
      id: "bag_flat",
      label: "Tygkasse",
      printAreaMm: { front: { h: 250, w: 250 } },
      printAreas: { front: { h: 300, w: 300, x: 250, y: 330 } },
      profileId: "bag_dtg",
      provisional: true,
      slotLabels: { front: "Framsida" },
    });
    await asPlatform("PATCH", "/v1/platform/pod/mockup-templates/bag_flat", { body: { active: false } });
    const off = await (await call("GET", "/v1/admin/pod/mockup-templates", { cookie: tenantAdmin.cookie, shopId: TENANT_A }))
      .json<{ provisional: boolean; templates: Array<Record<string, unknown>> }>();
    expect(off.templates.map((t) => t.id)).toStrictEqual(["tee_bc_e150"]);
    expect(off.provisional).toBe(false);
  });

  it("lists only ACTIVE models, in the compositor's shape, with no platform-only field", async () => {
    const response = await call("GET", "/v1/admin/pod/3d-models", { cookie: tenantAdmin.cookie, shopId: TENANT_A });
    expect(response.status).toBe(200);
    const body = await response.json<{ models: Array<Record<string, unknown>> }>();
    const ids = body.models.map((m) => m.id);
    expect(ids).not.toContain("offModel");
    expect(ids).toContain("blankModel");
    expect(body.models.find((m) => m.id === "AbCdEf0123456789wxyz")).toStrictEqual({
      alpha: 0.8,
      blend: "multiply",
      displacementBlur: 6,
      displacementContrast: 1,
      displacementScale: 30,
      id: "AbCdEf0123456789wxyz",
      label: "T-shirt på modell",
      output: { h: 1936, w: 1600 },
      perColorway: { black: { alpha: 0.9, blend: "screen" } },
      printAreaMm: { front: { h: 400, w: 300 } },
      views: {
        front: {
          colorways: {
            white: {
              displacementUrl: `${BASE}/platform/studio/${modelMap}/v1/image.png`,
              label: "Vit",
              maskUrl: `${BASE}/platform/studio/${modelMask}/v1/image.png`,
              photoUrl: `${BASE}/platform/studio/${modelPhoto}/v1/image.png`,
            },
          },
          h: 1936,
          printArea: { h: 700, w: 525, x: 548, y: 875 },
          w: 1600,
        },
      },
    });
    expectNoPlatformOnlyKeys(body);
    expectNoCostKeys(body);
  });
});
