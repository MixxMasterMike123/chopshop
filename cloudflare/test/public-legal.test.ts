import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex, termsTextObjectKey } from "../src/legal/platform-terms";
import { ADMIN, call, type CallOptions, giveLegalIdentity, settle } from "./slice-harness";
import { expectJson, platform, SliceWorld, type Tenant, tenantWorld } from "./tenant-fixtures";

/**
 * CP4-C — the legal pages a visitor reads (D79): the text the seller ADOPTED
 * (0037 legal_acceptances), as adopted, and the platform's own terms as the
 * platform published and archived them. Nothing here is editable; nothing is
 * served for a shop that is not public.
 */

const NOT_FOUND = { error: { code: "not_found", message: "Legal page not found" } };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ENTRIES = {
  angerratt: { key: "angerratt", path: "/legal/angerratt-och-returer", title: "Ångerrätt & returer" },
  integritetspolicy: { key: "integritetspolicy", path: "/legal/integritetspolicy", title: "Integritetspolicy" },
  kopvillkor: { key: "kopvillkor", path: "/legal/kopvillkor", title: "Köpvillkor" },
  plattformsvillkor: { key: "plattformsvillkor", path: "/legal/plattformsvillkor", title: "Plattformsvillkor" },
} as const;

type ShopKey = "angerratt" | "integritetspolicy" | "kopvillkor";

const FIRST_TEXTS: Record<ShopKey, string> = {
  angerratt: "<h1>Ångerrätt &amp; returer</h1><p>14 dagar.</p>",
  integritetspolicy: '<h1>Integritetspolicy</h1><p>Personuppgifter "test" \\ ok — 🙂</p>',
  kopvillkor: "<h1>Köpvillkor – Butik</h1><p>§ 1 Säljare</p>",
};

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;

function visit(tenant: Tenant, path: string, options: CallOptions = {}): Promise<Response> {
  return call(world, "GET", `${tenant.origin}${path}`, options);
}

async function expectLegalNotFound(response: Response, label: string): Promise<void> {
  expect(await expectJson(response, 404, label), label).toEqual(NOT_FOUND);
  expect(response.headers.get("etag"), label).toBeNull();
}

async function adopt(tenant: Tenant, texts: Record<ShopKey, string>): Promise<string> {
  const body = await expectJson<{ acceptance: { acceptedAt: string } }>(
    await call(world, "POST", `${ADMIN}/v1/admin/legal/accept-pages`, {
      body: { custom: false, pod: false, templateVersion: "2026-09-07", texts },
      cookie: tenant.adminCookie,
      shopId: tenant.tenantId,
    }),
    201,
    `adopt for ${tenant.tenantId}`,
  );
  return body.acceptance.acceptedAt;
}

async function legalList(tenant: Tenant): Promise<Array<{ key: string; path: string; title: string }>> {
  return (await expectJson<{ pages: Array<{ key: string; path: string; title: string }> }>(
    await visit(tenant, "/v1/legal"),
    200,
    "list",
  )).pages;
}

beforeAll(async () => {
  const setup = await tenantWorld("pl", 3);
  world = setup.world;
  [shopA, shopB, shopC] = setup.tenants as [Tenant, Tenant, Tenant];
  // CP9-OB: an adoption requires the identity the pages print.
  for (const tenant of setup.tenants) {
    await giveLegalIdentity(world, tenant);
  }
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the shop's own legal pages: the adopted snapshot, verbatim", () => {
  let adoptedAt: string;

  beforeAll(async () => {
    adoptedAt = await adopt(shopA, FIRST_TEXTS);
  });

  it.each(["kopvillkor", "angerratt", "integritetspolicy"] as const)(
    "answers %s exactly as adopted, with the adoption date",
    async (key) => {
      const response = await visit(shopA, `/v1/legal/${key}`);
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(response.headers.get("etag")).toMatch(/^"\d+"$/);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(JSON.parse(text)).toEqual({
        page: { ...ENTRIES[key], adoptedAt, html: FIRST_TEXTS[key] },
      });
      expect(adoptedAt).toMatch(ISO);
    },
  );

  it("lists the three pages in the footer's order", async () => {
    expect(await legalList(shopA)).toEqual([ENTRIES.kopvillkor, ENTRIES.angerratt, ENTRIES.integritetspolicy]);
  });

  it("a shop that adopted nothing has no legal page, whatever another shop adopted", async () => {
    for (const key of ["kopvillkor", "angerratt", "integritetspolicy"]) {
      await expectLegalNotFound(await visit(shopB, `/v1/legal/${key}`), `B ${key}`);
    }
    expect(await legalList(shopB)).toEqual([]);
  });

  it("a later adoption replaces the answer, and moves the ETag", async () => {
    const first = await visit(shopA, "/v1/legal/kopvillkor");
    const etag = first.headers.get("etag") ?? "";
    await first.body?.cancel();
    const cached = await visit(shopA, "/v1/legal/kopvillkor", { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");

    const second = { ...FIRST_TEXTS, kopvillkor: "<h1>Köpvillkor v2</h1>" };
    const secondAt = await adopt(shopA, second);
    const after = await visit(shopA, "/v1/legal/kopvillkor", { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(await after.json()).toEqual({
      page: { ...ENTRIES.kopvillkor, adoptedAt: secondAt, html: "<h1>Köpvillkor v2</h1>" },
    });
  });

  it("the latest adoption decides: a page it lacks, or holds as anything but text, is a 404", async () => {
    await adopt(shopC, FIRST_TEXTS);
    // An imported adoption, later than the Worker's, with one page missing,
    // one empty and one not a string.
    await env.DB.prepare(
      `INSERT INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, legacy_uid, accepted_at, texts_json, texts_sha256, source
       ) VALUES (?, ?, 'legalPages', NULL, 'legacy-uid-1', ?, ?, ?, 'import')`,
    )
      .bind(
        "imported-c-1",
        shopC.tenantId,
        "2099-01-01T00:00:00.000Z",
        JSON.stringify({ angerratt: "", integritetspolicy: { html: "x" } }),
        "0".repeat(64),
      )
      .run();

    for (const key of ["kopvillkor", "angerratt", "integritetspolicy"]) {
      await expectLegalNotFound(await visit(shopC, `/v1/legal/${key}`), key);
    }
    expect(await legalList(shopC)).toEqual([]);

    await env.DB.prepare(
      `INSERT INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, legacy_uid, accepted_at, texts_json, texts_sha256, source
       ) VALUES (?, ?, 'legalPages', NULL, 'legacy-uid-2', ?, ?, ?, 'import')`,
    )
      .bind(
        "imported-c-2",
        shopC.tenantId,
        "2099-01-02T00:00:00.000Z",
        JSON.stringify({ integritetspolicy: "<p>Importerad</p>" }),
        "0".repeat(64),
      )
      .run();
    expect(await expectJson(await visit(shopC, "/v1/legal/integritetspolicy"), 200, "imported")).toEqual({
      page: { ...ENTRIES.integritetspolicy, adoptedAt: "2099-01-02T00:00:00.000Z", html: "<p>Importerad</p>" },
    });
    expect(await legalList(shopC)).toEqual([ENTRIES.integritetspolicy]);
  });

  it("an imported platform-terms row is not a legal-pages adoption", async () => {
    await env.DB.prepare(
      `INSERT INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, legacy_uid, accepted_at, texts_json, texts_sha256, source
       ) VALUES ('imported-b-terms', ?, 'platformTerms', NULL, 'legacy-uid-3', ?, ?, ?, 'import')`,
    )
      .bind(shopB.tenantId, "2099-01-01T00:00:00.000Z", JSON.stringify({ kopvillkor: "<p>Fel typ</p>" }), "0".repeat(64))
      .run();
    await expectLegalNotFound(await visit(shopB, "/v1/legal/kopvillkor"), "platformTerms row");
  });

  it("only the four keys and the last segment of their addresses are routes, each decoded once", async () => {
    for (const segment of ["angerratt-och", "KOPVILLKOR", "legal", "cookies", "%ZZ", "kop%2Fvillkor"]) {
      await expectLegalNotFound(await visit(shopA, `/v1/legal/${segment}`), segment);
    }
    // The storefront's router holds the address, not the key.
    const byAddress = await expectJson<{ page: { key: string; path: string } }>(
      await visit(shopA, "/v1/legal/angerratt-och-returer"),
      200,
      "by address",
    );
    expect(byAddress.page).toMatchObject({ key: "angerratt", path: "/legal/angerratt-och-returer" });
    const escaped = await visit(shopA, "/v1/legal/%6Bopvillkor");
    expect(escaped.status).toBe(200);
    await escaped.body?.cancel();
    const deeper = await visit(shopA, "/v1/legal/kopvillkor/extra");
    expect(deeper.status).toBe(404);
    await deeper.body?.cancel();
  });

  it("nothing is writable: every method but GET is the 404", async () => {
    for (const path of ["/v1/legal", "/v1/legal/kopvillkor", "/v1/legal/plattformsvillkor"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
        const response = await call(world, method, `${shopA.origin}${path}`, {
          body: method === "HEAD" ? undefined : { html: "<p>Ändrad</p>" },
        });
        expect(response.status, `${method} ${path}`).toBe(404);
        await response.body?.cancel();
      }
    }
    expect(
      ((await expectJson<{ page: { html: string } }>(await visit(shopA, "/v1/legal/angerratt"), 200, "unchanged")).page)
        .html,
    ).toBe(FIRST_TEXTS.angerratt);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the platform's own terms", () => {
  const VERSION = "2026-09-28-c";
  // A leading byte-order mark and a CRLF: the text is served byte for byte.
  const TEXT = '﻿{"version":"2026-09-28-c","terms":"# Plattformsvillkor\\r\\n{{platform_legal_name}}"}\r\n';
  let publishedAt: string;

  it("before any text is archived there is no page, and the list does not name one", async () => {
    await expectLegalNotFound(await visit(shopA, "/v1/legal/plattformsvillkor"), "seed without text");
    expect((await legalList(shopA)).map((entry) => entry.key)).not.toContain("plattformsvillkor");
  });

  it("answers the current version's archived text verbatim, under any public shop's host", async () => {
    const published = await expectJson<{ version: { publishedAt: string; sha256: string } }>(
      await platform(world, "POST", "/v1/platform/legal/terms-versions", { body: { text: TEXT, version: VERSION } }),
      201,
      "publish",
    );
    publishedAt = published.version.publishedAt;

    for (const shop of [shopA, shopB]) {
      const response = await visit(shop, "/v1/legal/plattformsvillkor");
      const raw = await response.text();
      expect(response.status, raw).toBe(200);
      expect(response.headers.get("etag")).toMatch(new RegExp(`^"\\d+\\.${VERSION}"$`));
      const body = JSON.parse(raw) as { page: { text: string } };
      expect(body).toEqual({
        page: { ...ENTRIES.plattformsvillkor, publishedAt, text: TEXT, version: VERSION },
      });
      expect(await sha256Hex(body.page.text)).toBe(published.version.sha256);
    }
    expect((await legalList(shopA)).at(-1)).toEqual(ENTRIES.plattformsvillkor);
    expect(await legalList(shopB)).toEqual([ENTRIES.plattformsvillkor]);
  });

  it("a version published for later is not current yet: the current one is still answered", async () => {
    const later = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    await expectJson(
      await platform(world, "POST", "/v1/platform/legal/terms-versions", {
        body: { publishedAt: later, text: "Senare villkor", version: "2026-09-29-later" },
      }),
      201,
      "schedule",
    );
    const body = await expectJson<{ page: { version: string } }>(
      await visit(shopA, "/v1/legal/plattformsvillkor"),
      200,
      "current",
    );
    expect(body.page.version).toBe(VERSION);
  });

  it("a 304 is answered without reading the bucket; a 200 reads it once", async () => {
    let reads = 0;
    const bucket = env.PRIVATE_BUCKET;
    const counting = new Proxy(bucket, {
      get(target, property, receiver) {
        if (property === "get") {
          return (...args: Parameters<R2Bucket["get"]>) => {
            reads += 1;
            return target.get(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = world.with({ PRIVATE_BUCKET: counting });

    const first = await visit(shopA, "/v1/legal/plattformsvillkor", { env: counted });
    const etag = first.headers.get("etag") ?? "";
    await first.body?.cancel();
    expect(reads).toBe(1);

    const cached = await visit(shopA, "/v1/legal/plattformsvillkor", { env: counted, headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(reads).toBe(1);
  });

  it("without the private bucket there is no page", async () => {
    await expectLegalNotFound(
      await visit(shopA, "/v1/legal/plattformsvillkor", { env: world.with({ PRIVATE_BUCKET: undefined }) }),
      "no bucket",
    );
  });

  it("an archive that no longer matches its hash is never served", async () => {
    const sha = await sha256Hex(TEXT);
    const key = termsTextObjectKey(VERSION, sha);
    await env.PRIVATE_BUCKET.put(key, "manipulerad text");
    try {
      expect(await settle(visit(shopA, "/v1/legal/plattformsvillkor"))).toBe("threw");
    } finally {
      await env.PRIVATE_BUCKET.put(key, TEXT);
    }
    const restored = await visit(shopA, "/v1/legal/plattformsvillkor");
    expect(restored.status).toBe(200);
    await restored.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a shop that is not public answers no legal page", () => {
  const paths = ["/v1/legal", "/v1/legal/kopvillkor", "/v1/legal/plattformsvillkor"];

  it("unpublished: every legal route is the 404; published again: back", async () => {
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/unpublish`), 200, "unpublish");
    for (const path of paths) {
      await expectLegalNotFound(await visit(shopA, path), path);
    }
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/publish`), 200, "publish");
    for (const path of paths) {
      const response = await visit(shopA, path);
      expect(response.status, path).toBe(200);
      await response.body?.cancel();
    }
  });

  it("suspended: every legal route is the 404; active again: back", async () => {
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/suspend`), 200, "suspend");
    for (const path of paths) {
      await expectLegalNotFound(await visit(shopA, path), path);
    }
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/activate`), 200, "activate");
    const back = await visit(shopA, "/v1/legal/kopvillkor");
    expect(back.status).toBe(200);
    await back.body?.cancel();
  });

  it("an unknown host is the 404", async () => {
    await expectLegalNotFound(await call(world, "GET", "https://unknown.shops.cp4c.test/v1/legal"), "list");
    await expectLegalNotFound(
      await call(world, "GET", "https://unknown.shops.cp4c.test/v1/legal/plattformsvillkor"),
      "terms",
    );
  });
});
