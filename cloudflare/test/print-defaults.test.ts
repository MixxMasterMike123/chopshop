import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createMapping } from "../src/pod/pod-mappings";
import { setDefaultPrinter } from "../src/pod/print-defaults";
import { editPrinter, replacePrinters } from "../src/pod/printers";
import {
  adminOf,
  grantActingAs,
  grantPlatformAdmin,
  grantTenantAdmin,
  hiddenPrinter,
  OPAQUE_NOT_FOUND,
  PLATFORM,
  SEED_NOW,
  seedArtwork,
  seedProduct,
  seedProfile,
  seedTenant,
  sessionRequest,
  signUp,
  TEE_S,
} from "./pod-fixtures";

/**
 * CP3-C: the platform's default printer (`print_defaults`, D52) —
 * GET/PUT /v1/platform/printers/default, its validation, its schema, and the
 * fact that nothing in the Worker consumes it yet.
 */

const TENANT_A = "tenant-pd-a";
const HOST = "https://platform.pdtest.test";
const PATH = "/v1/platform/printers/default";

let tenantAdmin: { cookie: string; userId: string };
let platform: { cookie: string; userId: string };

type Caller = "anonymous" | "tenant" | "acting" | "platform";

function call(
  caller: Caller,
  path: string,
  method: string,
  body?: unknown,
  options: { origin?: string | null } = {},
): Promise<Response> {
  const url = `${HOST}${path}`;
  if (caller === "anonymous") {
    return exports.default.fetch(
      new Request(url, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "content-type": "application/json", origin: HOST },
        method,
      }),
    );
  }
  return exports.default.fetch(
    sessionRequest(url, method, {
      body,
      cookie: caller === "tenant" ? tenantAdmin.cookie : platform.cookie,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(caller === "platform" ? {} : { shopId: TENANT_A }),
    }),
  );
}

async function stored(): Promise<unknown> {
  return env.DB.prepare("SELECT id, default_printer_id, updated_at, updated_by FROM print_defaults").all().then((r) => r.results);
}

async function insertPrinter(id: string, options: { status?: string; tenantId?: string | null } = {}): Promise<void> {
  const iso = new Date(SEED_NOW).toISOString();
  await env.DB.prepare(
    `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor, capabilities_json, created_at, updated_at)
     VALUES (?, ?, 'manual', ?, ?, 'SEK', 0, '{"models":{},"skus":{}}', ?, ?)`,
  )
    .bind(id, options.tenantId ?? null, id, options.status ?? "active", iso, iso)
    .run();
}

beforeAll(async () => {
  await seedTenant(TENANT_A, "pd-a.pdtest.test");
  await seedProfile();
  expect(await replacePrinters(env.DB, PLATFORM, [hiddenPrinter()], Date.now())).not.toBeNull();
  await insertPrinter("pd-inactive", { status: "inactive" });
  await insertPrinter("pd-shop-press", { tenantId: TENANT_A });
  await seedArtwork(TENANT_A, { artworkId: "art-a" });
  tenantAdmin = await signUp("pd-admin@pdtest.test");
  await grantTenantAdmin(tenantAdmin.userId, TENANT_A);
  platform = await signUp("pd-platform@pdtest.test");
  await grantPlatformAdmin(platform.userId);
  await grantActingAs(platform.userId, TENANT_A);
});

describe("GET/PUT /v1/platform/printers/default", () => {
  it("starts with no default (the migration seeds the one row)", async () => {
    const response = await call("platform", PATH, "GET");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultPrinter: { printerActive: null, printerId: null, updatedBy: null },
    });
  });

  it("sets an existing, active platform printer; audits it; the list marks it", async () => {
    const response = await call("platform", PATH, "PUT", { printerId: "fake-printer" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultPrinter: { printerActive: true, printerId: "fake-printer", updatedBy: platform.userId },
    });
    const audit = await env.DB.prepare(
      "SELECT actor_user_id, metadata_json FROM audit_events WHERE action = 'pod.printers.default'",
    ).all();
    expect(audit.results).toEqual([
      { actor_user_id: platform.userId, metadata_json: JSON.stringify({ printerId: "fake-printer" }) },
    ]);
    const list = await (await call("platform", "/v1/platform/printers", "GET")).json<{
      defaultPrinterId: string | null;
      printers: Array<{ isDefault: boolean; printerId: string }>;
    }>();
    expect(list.defaultPrinterId).toBe("fake-printer");
    expect(list.printers.filter((printer) => printer.isDefault).map((printer) => printer.printerId)).toEqual([
      "fake-printer",
    ]);
  });

  it("refuses a printer that does not exist, is inactive, or belongs to a tenant (422) and changes nothing", async () => {
    const before = await stored();
    for (const [printerId, code] of [
      ["no-such-printer", "printer_not_found"],
      ["pd-inactive", "printer_inactive"],
      ["pd-shop-press", "tenant_printer"],
    ] as const) {
      const response = await call("platform", PATH, "PUT", { printerId });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    }
    expect(await stored()).toEqual(before);
  });

  it("refuses malformed bodies, including `default` as a printer id (400)", async () => {
    for (const body of [{}, { printerId: "default" }, { printerId: "" }, { printerId: 7 }, { printerId: "x", extra: 1 }, []]) {
      expect((await call("platform", PATH, "PUT", body)).status).toBe(400);
    }
  });

  it("a deactivation racing the write leaves the default untouched and writes no audit row", async () => {
    let batches = 0;
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batches += 1;
            // Between the pre-check and the write: the target goes inactive.
            await target.prepare("UPDATE printers SET status = 'inactive', updated_at = updated_at WHERE id = 'pd-racer'").run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await insertPrinter("pd-racer");
    const before = await stored();
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>();
    await expect(setDefaultPrinter(racing, PLATFORM, "pd-racer", Date.now())).resolves.toEqual({
      code: "printer_inactive",
      status: "refused",
    });
    expect(batches).toBe(1);
    expect(await stored()).toEqual(before);
    await expect(env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events").first()).resolves.toEqual(audits);
  });

  it("a default that is later deactivated reads as `printerActive: false`; null clears it", async () => {
    await insertPrinter("pd-later");
    expect((await call("platform", PATH, "PUT", { printerId: "pd-later" })).status).toBe(200);
    const result = await editPrinter(env.DB, PLATFORM, "pd-later", { status: "inactive" }, Date.now(), {
      action: "pod.printers.edit",
      dryRun: false,
      target: "fake-printer",
    });
    expect(result.status).toBe("ok");
    await expect((await call("platform", PATH, "GET")).json()).resolves.toMatchObject({
      defaultPrinter: { printerActive: false, printerId: "pd-later" },
    });
    const cleared = await call("platform", PATH, "PUT", { printerId: null });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ defaultPrinter: { printerActive: null, printerId: null } });
  });
});

describe("`default` is the default-printer resource, never a printer id — both directions", () => {
  it("GET …/default answers the default resource, not a printer called `default`", async () => {
    const response = await call("platform", PATH, "GET");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(["defaultPrinter"]);
  });

  it("the id routes refuse `default` (PATCH falls through to them and is refused)", async () => {
    for (const [method, path] of [
      ["PATCH", PATH],
      ["GET", "/v1/platform/printers/%64efault"],
      ["PATCH", "/v1/platform/printers/%64efault"],
    ] as const) {
      const response = await call("platform", path, method, method === "PATCH" ? { name: "x" } : undefined);
      expect(response.status, `${method} ${path}`).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
    }
    // The default resource answers GET and PUT only.
    for (const method of ["POST", "DELETE", "HEAD"]) {
      expect((await call("platform", PATH, method)).status).toBe(404);
    }
  });
});

describe("platform sessions only", () => {
  it.each([
    ["GET", undefined],
    ["PUT", { printerId: "fake-printer" }],
  ] as const)("%s: anonymous, tenant admin and a platform user acting as the shop get the opaque 404", async (method, body) => {
    const before = await stored();
    for (const caller of ["anonymous", "tenant", "acting"] as const) {
      const response = await call(caller, PATH, method, body);
      expect(response.status, caller).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
    }
    expect(await stored()).toEqual(before);
  });

  it("a cross-site or Origin-less PUT is refused the same way", async () => {
    const before = await stored();
    for (const origin of ["https://evil.test", null]) {
      const response = await call("platform", PATH, "PUT", { printerId: "fake-printer" }, { origin });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_NOT_FOUND);
    }
    expect(await stored()).toEqual(before);
  });
});

describe("the schema holds the invariants too", () => {
  it("one permanent row; its printer must exist and be platform-owned", async () => {
    await expect(env.DB.prepare("DELETE FROM print_defaults").run()).rejects.toThrow(/single permanent row/);
    await expect(
      env.DB.prepare("INSERT INTO print_defaults (id, updated_at) VALUES (2, ?)").bind(new Date().toISOString()).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE print_defaults SET default_printer_id = 'pd-shop-press' WHERE id = 1").run(),
    ).rejects.toThrow(/platform printer/);
    await expect(
      env.DB.prepare("UPDATE print_defaults SET default_printer_id = 'no-such-printer' WHERE id = 1").run(),
    ).rejects.toThrow();
    // The importer's path: an inactive platform printer may be carried verbatim (D59).
    await env.DB.prepare("UPDATE print_defaults SET default_printer_id = 'pd-inactive', updated_by = 'import' WHERE id = 1").run();
    await env.DB.prepare("UPDATE print_defaults SET default_printer_id = NULL, updated_by = NULL WHERE id = 1").run();
  });
});

describe("nothing in the Worker consumes the default printer yet", () => {
  it("a mapping must still name its printer, even with a default set", async () => {
    expect((await call("platform", PATH, "PUT", { printerId: "fake-printer" })).status).toBe(200);
    await seedProduct(TENANT_A, { productId: "pd-tee" });
    const withoutPrinter = await exports.default.fetch(
      sessionRequest(`${HOST}/v1/admin/pod/mappings`, "POST", {
        body: { artworkId: "art-a", productId: "pd-tee", sku: TEE_S, slots: ["front"] },
        cookie: tenantAdmin.cookie,
        shopId: TENANT_A,
      }),
    );
    expect(withoutPrinter.status).toBe(400);
    const named = await createMapping(
      env.DB,
      adminOf(TENANT_A),
      { artworkId: "art-a", printerId: "fake-printer", productId: "pd-tee", sku: TEE_S, slots: ["front"], variantId: null },
      Date.now(),
    );
    expect(named.status).toBe("ok");
  });
});
