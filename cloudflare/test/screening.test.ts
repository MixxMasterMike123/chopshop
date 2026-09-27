import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  publishAdminProduct,
  unpublishAdminProduct,
  updateAdminProduct,
} from "../src/catalog/admin-catalog";
import { getPublicProduct, listPublicProducts } from "../src/catalog/public-catalog";
import type { BlocklistEntry, ScreeningState, StoredScreening } from "../src/catalog/screening-core";
import {
  decideScreening,
  findScreeningHits,
  foldText,
  overlayDecision,
  productScreeningTexts,
  productUsesMapping,
  tokenize,
  toMachineState,
} from "../src/catalog/screening-core";
import {
  decideByPlatform,
  listScreeningQueue,
  readScreeningGuard,
  screeningFenceStatement,
} from "../src/catalog/screening";
import { createMapping, listMappings } from "../src/pod/pod-mappings";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  adminOf,
  catalogVersion,
  PLATFORM,
  seedArtwork,
  seedPrinter,
  seedProduct,
  seedProfile,
  seedTenant,
  TEE_S,
} from "./pod-fixtures";

// ── the pure port (functions/src/catalog/contentScreening.ts) ──────────────

/** rules-tests/content-screening-parity.test.cjs LIST, as typed rows. */
const LIST: BlocklistEntry[] = [
  { hardBlock: false, kind: "band", term: "kent" },
  { hardBlock: false, kind: "band", term: "Håkan Hellström" },
  { hardBlock: false, kind: "club", term: "Djurgården" },
  { hardBlock: false, kind: "club", term: "malmö ff" },
  { hardBlock: false, kind: "band", term: "AC/DC" },
  { hardBlock: false, kind: "brand", term: "coca-cola" },
  { hardBlock: false, kind: "brand", term: "pokemon" },
  { hardBlock: false, kind: "brand", term: "louis vuitton" },
  { hardBlock: false, kind: "brand", term: "star wars" },
  { hardBlock: true, kind: "brand", term: "nike" },
  { hardBlock: false, kind: "other", term: "™" },
  { hardBlock: false, kind: "other", term: "®" },
  { hardBlock: false, kind: "other", term: "official" },
  { hardBlock: false, kind: "other", term: "   " },
];

const screen = (
  product: { description: string | null; name: string },
  files: string[] = [],
): string[] => findScreeningHits(productScreeningTexts(product, files), LIST).map((h) => h.term);

describe("the blocklist matcher (Firebase parity table)", () => {
  // [case, name, description, artwork file names, expected] — every Firebase
  // row whose input a CF product can carry (name, description, artwork file).
  it.each([
    ["kent as a word", "Kent tour 2026 tee", null, [], ["kent"]],
    ["kentucky is NOT kent", "Kentucky fried hoodie", null, [], []],
    ["kent inside a word is NOT kent", "Kentaur", null, [], []],
    ["å/ä/ö folded", "hakan hellstrom fan tee", null, [], ["Håkan Hellström"]],
    ["upper case folded", "DJURGARDEN IF", null, [], ["Djurgården"]],
    ["exact diacritics still match", "Djurgården 1891", null, [], ["Djurgården"]],
    ["multi-word split by punctuation", "Malmö-FF supporter", null, [], ["malmö ff"]],
    ["multi-word needs adjacency", "Malmö stad, FF", null, [], []],
    ["AC/DC written ac-dc", "ac-dc back in black", null, [], ["AC/DC"]],
    ["acdc not caught (documented gap)", "acdc", null, [], []],
    ["coca cola without hyphen", "Coca Cola retro", null, [], ["coca-cola"]],
    ["accent folded", "Pokémon trainer", null, [], ["pokemon"]],
    ["description HTML stripped", "Tee", "<p>Inspired by <strong>Star</strong> Wars</p>", [], ["star wars"]],
    ["description screened", "Tee", "Official merch", [], ["official"]],
    ["artwork file name screened", "Tee", null, ["nike_swoosh_final.png"], ["nike"]],
    ["™ matched raw", "Min Logga™ tee", null, [], ["™"]],
    ["® matched raw", "Brand® hoodie", null, [], ["®"]],
    ["clean product", "Blå hoodie med fiskmotiv", null, ["fisk.png"], []],
    ["hits keep blocklist order, deduped", "Nike x Kent kent NIKE", null, [], ["kent", "nike"]],
    ["entities do not glue words", "Tee", "star&nbsp;wars", [], ["star wars"]],
    ["ø folded (dodge caught)", "Pokemøn", null, [], ["pokemon"]],
  ] as Array<[string, string, string | null, string[], string[]]>)(
    "%s",
    (_label, name, description, files, expected) => {
      expect(screen({ description, name }, files)).toEqual(expected);
    },
  );

  it("folds and tokenizes like the Firebase helpers", () => {
    expect(foldText("ÆØÅ æøå")).toBe("aeoa aeoa");
    expect(foldText("Straße")).toBe("strasse");
    expect(foldText("Łódź")).toBe("lodz");
    expect(tokenize("Pokémon™")).toBe(" pokemontm ");
    expect(tokenize("")).toBe("");
    expect(tokenize(null)).toBe("");
  });

  it("carries the hard-block flag on the hit", () => {
    expect(findScreeningHits(["nike"], LIST)[0]?.hardBlock).toBe(true);
  });
});

describe("decideScreening (verbatim state machine, Firebase parity)", () => {
  const base = { hardBlock: false, reviewFirstProducts: 2, shopPublishedCount: 10 };
  const d = decideScreening;
  const prev = (status: ScreeningState["status"], hits: string[], earlierHits?: string[]) =>
    ({ hits, status, ...(earlierHits ? { earlierHits } : {}) }) as ScreeningState;

  it("first screen: clean → ok; new shop → review; exactly N → ok; hit → flagged", () => {
    expect(d({ ...base, prev: null, terms: [] }).screening?.status).toBe("ok");
    expect(d({ ...base, prev: null, shopPublishedCount: 1, terms: [] }).screening?.status).toBe("review");
    expect(d({ ...base, prev: null, shopPublishedCount: 2, terms: [] }).screening?.status).toBe("ok");
    expect(d({ ...base, prev: null, terms: ["kent"] }).screening).toEqual({ hits: ["kent"], status: "flagged" });
    expect(d({ ...base, prev: null, shopPublishedCount: 0, terms: ["kent"] }).screening?.status).toBe("flagged");
  });

  it("converges: unchanged input is a no-op", () => {
    expect(d({ ...base, prev: prev("flagged", ["kent"]), terms: ["kent"] })).toEqual({ deactivate: false, screening: null });
    expect(d({ ...base, prev: prev("ok", []), terms: [] }).screening).toBeNull();
    expect(d({ ...base, prev: prev("review", []), shopPublishedCount: 50, terms: [] }).screening).toBeNull();
  });

  it("cleared sticks until a NEW term appears, remembering dropped ones", () => {
    expect(d({ ...base, prev: prev("cleared", ["kent"]), terms: ["kent"] }).screening).toBeNull();
    expect(d({ ...base, prev: prev("cleared", ["kent"]), terms: ["kent", "nike"] }).screening?.status).toBe("flagged");
    expect(d({ ...base, prev: prev("cleared", ["kent", "nike"]), terms: ["kent"] }).screening).toEqual({
      earlierHits: ["nike"],
      hits: ["kent"],
      status: "cleared",
    });
  });

  it("a rename that drops the term stays flagged; re-adding restores hits", () => {
    expect(d({ ...base, prev: prev("flagged", ["kent"]), terms: [] }).screening).toEqual({
      earlierHits: ["kent"],
      hits: [],
      status: "flagged",
    });
    expect(d({ ...base, prev: prev("flagged", [], ["kent"]), terms: ["kent"] }).screening).toEqual({
      hits: ["kent"],
      status: "flagged",
    });
  });

  it("hard blocks, re-enforcement, and the platform states that override them", () => {
    expect(d({ ...base, hardBlock: true, prev: null, terms: ["nike"] })).toEqual({
      deactivate: true,
      screening: { hits: ["nike"], status: "blocked" },
    });
    expect(d({ ...base, hardBlock: true, prev: prev("blocked", ["nike"]), terms: ["nike"] })).toEqual({
      deactivate: true,
      screening: null,
    });
    expect(d({ ...base, hardBlock: true, prev: prev("cleared", ["nike"]), terms: ["nike"] })).toEqual({
      deactivate: false,
      screening: null,
    });
    expect(d({ ...base, prev: prev("blocked", ["nike"]), terms: [] }).screening?.status).toBe("flagged");
    expect(d({ ...base, hardBlock: true, prev: prev("taken_down", ["nike"]), terms: ["nike"] })).toEqual({
      deactivate: false,
      screening: null,
    });
    expect(d({ ...base, prev: prev("taken_down", ["nike"]), terms: ["nike", "kent"] }).screening?.status).toBe("taken_down");
  });

  it("F4: a cleared clean product whose artwork name hits is flagged (blocked if hard)", () => {
    expect(d({ ...base, prev: prev("cleared", []), terms: ["nike"] }).screening).toEqual({
      hits: ["nike"],
      status: "flagged",
    });
    expect(d({ ...base, hardBlock: true, prev: prev("cleared", []), terms: ["nike"] }).deactivate).toBe(true);
  });
});

describe("the D8 overlay (approval-before-first-sale for the first N=2)", () => {
  const stored = (over: Partial<StoredScreening>): StoredScreening => ({
    earlierHits: [],
    hits: [],
    requiresApproval: false,
    status: "advisory",
    takenDown: false,
    ...over,
  });
  const decide = (row: StoredScreening | null, terms: string[], count: number, hardBlock = false) =>
    overlayDecision(
      row,
      decideScreening({
        hardBlock,
        prev: toMachineState(row),
        reviewFirstProducts: 2,
        shopPublishedCount: count,
        terms,
      }),
      count,
    );

  it("a new shop's first product is pending and needs approval — with or without hits", () => {
    expect(decide(null, [], 0)).toMatchObject({ reason: "first_products", requiresApproval: true, status: "pending" });
    expect(decide(null, [], 1)).toMatchObject({ requiresApproval: true, status: "pending" });
    expect(decide(null, ["kent"], 0)).toMatchObject({ hits: ["kent"], requiresApproval: true, status: "pending" });
  });

  it("past the first N a clean product is advisory and a hit is flagged (both public)", () => {
    expect(decide(null, [], 2)).toMatchObject({ reason: null, requiresApproval: false, status: "advisory" });
    expect(decide(null, ["kent"], 2)).toMatchObject({ reason: "blocklist_hit", status: "flagged" });
  });

  it("a pending product stays pending through edits until a platform decision", () => {
    const pending = stored({ requiresApproval: true, status: "pending" });
    expect(decide(pending, [], 50)).toBeNull();
    expect(decide(pending, ["kent"], 50)).toMatchObject({ status: "pending" });
  });

  it("a hard-blocked first product that is renamed still waits for approval", () => {
    const blocked = stored({ hits: ["nike"], requiresApproval: true, status: "blocked" });
    expect(decide(blocked, [], 50)).toMatchObject({ earlierHits: ["nike"], status: "pending" });
  });

  it("an approved product sticks while no new term appears", () => {
    const approved = stored({ hits: ["kent"], status: "approved" });
    expect(decide(approved, ["kent"], 50)).toBeNull();
    expect(decide(approved, ["kent", "nike"], 50)).toMatchObject({ status: "flagged" });
  });

  it("a platform takedown sticks", () => {
    const takenDown = stored({ hits: ["nike"], status: "blocked", takenDown: true });
    expect(decide(takenDown, ["nike", "kent"], 50)).toMatchObject({ reason: "takedown", status: "blocked" });
  });
});

describe("productUsesMapping (productUsesMappingSku on the CF data model)", () => {
  it("a mapping feeds exactly the product it names", () => {
    expect(productUsesMapping({ productId: "p1" }, { productId: "p1" })).toBe(true);
    expect(productUsesMapping({ productId: "p1" }, { productId: "p2" })).toBe(false);
  });
});

// ── D8 end to end, on D1 ────────────────────────────────────────────────────

const TENANT = "tenant-screening";
const HOST = "screening.podtest.test";
const tenantContext: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };
const admin = adminOf(TENANT);

async function screeningRow(productId: string) {
  return env.DB.prepare(
    "SELECT status, reason, hits_json, requires_approval, version, decided_by FROM product_screening WHERE product_id = ?",
  )
    .bind(productId)
    .first<{
      decided_by: string;
      hits_json: string;
      reason: string | null;
      requires_approval: number;
      status: string;
      version: number;
    }>();
}

async function publicIds(): Promise<string[]> {
  return (await listPublicProducts(env.DB, tenantContext)).map((p) => p.productId);
}

describe("D8 on the live publish path", () => {
  beforeAll(async () => {
    await seedTenant(TENANT, HOST);
    await env.DB.prepare(
      "INSERT INTO content_screening_terms (term, kind, hard_block, created_at) VALUES ('kent', 'band', 0, ?), ('nike', 'brand', 1, ?)",
    )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    for (const id of ["first", "second", "third"]) {
      await seedProduct(TENANT, { productId: `d8-${id}`, status: "active" });
    }
  });

  it("the shop's first two published products are pending and not public", async () => {
    for (const id of ["d8-first", "d8-second"]) {
      const result = await publishAdminProduct(env.DB, admin, id, Date.now());
      expect(result).toMatchObject({ product: { screeningStatus: "pending" }, status: "ok" });
      expect(await screeningRow(id)).toMatchObject({
        decided_by: "system",
        reason: "first_products",
        requires_approval: 1,
        status: "pending",
      });
    }
    expect(await publicIds()).toEqual([]);
    expect(await getPublicProduct(env.DB, tenantContext, "d8-first")).toBeNull();
  });

  it("publishing a third before any approval is STILL pending (dummies do not clear D8)", async () => {
    const result = await publishAdminProduct(env.DB, admin, "d8-third", Date.now());
    expect(result).toMatchObject({ product: { screeningStatus: "pending" } });
  });

  it("the platform queue lists them; approving makes a product public and bumps catalog_version", async () => {
    const queue = await listScreeningQueue(env.DB, "pending");
    expect(queue.map((row) => row.productId).sort()).toEqual(["d8-first", "d8-second", "d8-third"]);

    const before = await catalogVersion(TENANT);
    const approved = await decideByPlatform(env.DB, PLATFORM, "d8-first", "approved", Date.now());
    expect(approved).toMatchObject({ decidedBy: PLATFORM.userId, reason: "platform_approved", status: "approved" });
    expect(await catalogVersion(TENANT)).toBeGreaterThan(before);
    expect(await publicIds()).toEqual(["d8-first"]);
    expect((await screeningRow("d8-first"))?.requires_approval).toBe(0);
  });

  it("once two are approved, a newly published product is advisory and public at once", async () => {
    await decideByPlatform(env.DB, PLATFORM, "d8-second", "approved", Date.now());
    await seedProduct(TENANT, { productId: "d8-fourth", status: "active" });
    const result = await publishAdminProduct(env.DB, admin, "d8-fourth", Date.now());
    expect(result).toMatchObject({ product: { screeningStatus: "advisory" } });
    expect(await publicIds()).toContain("d8-fourth");
  });

  it("a text edit on a live product is re-screened in the same batch (flagged stays public)", async () => {
    const before = (await screeningRow("d8-fourth"))?.version ?? 0;
    const result = await updateAdminProduct(env.DB, admin, "d8-fourth", { name: "Kent tour tee" }, Date.now());
    expect(result).toMatchObject({ product: { screeningStatus: "flagged" }, status: "ok" });
    expect(await screeningRow("d8-fourth")).toMatchObject({ hits_json: '["kent"]', reason: "blocklist_hit", status: "flagged" });
    expect((await screeningRow("d8-fourth"))?.version).toBe(before + 1);
    expect(await publicIds()).toContain("d8-fourth");
  });

  it("a hard-blocked term takes a live product off the storefront", async () => {
    const result = await updateAdminProduct(env.DB, admin, "d8-fourth", { name: "Nike tee" }, Date.now());
    expect(result).toMatchObject({ product: { screeningStatus: "blocked" } });
    expect(await publicIds()).not.toContain("d8-fourth");
    // Renamed away: flagged (a human still looks), public again.
    await updateAdminProduct(env.DB, admin, "d8-fourth", { name: "Plain tee" }, Date.now());
    expect((await screeningRow("d8-fourth"))?.status).toBe("flagged");
    expect(await publicIds()).toContain("d8-fourth");
  });

  it("an edit to an unpublished product is not screened (a draft harms nobody) — but it is fenced", async () => {
    await unpublishAdminProduct(env.DB, admin, "d8-fourth", Date.now());
    const before = await screeningRow("d8-fourth");
    await updateAdminProduct(env.DB, admin, "d8-fourth", { name: "Nike again" }, Date.now());
    const after = await screeningRow("d8-fourth");
    // The verdict is untouched (no rescreen of a draft)…
    expect(after).toMatchObject({
      decided_by: before?.decided_by,
      hits_json: before?.hits_json,
      reason: before?.reason,
      status: before?.status,
    });
    // …while the lock moved, so a publish that read the old version cannot
    // commit around this edit (THE FENCE).
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it("a platform takedown blocks, stamps takedown_at, refuses re-publish and deletion", async () => {
    const taken = await decideByPlatform(env.DB, PLATFORM, "d8-first", "blocked", Date.now());
    expect(taken).toMatchObject({ reason: "takedown", status: "blocked", takenDown: true });
    expect(await getPublicProduct(env.DB, tenantContext, "d8-first")).toBeNull();
    expect(await publishAdminProduct(env.DB, admin, "d8-first", Date.now())).toEqual({
      code: "taken_down",
      status: "refused",
    });
    await expect(
      env.DB.prepare("DELETE FROM products WHERE product_id = 'd8-first'").run(),
    ).rejects.toThrow(/taken-down product cannot be deleted/);

    // Reinstatement is the platform's approval, which lifts the stamp.
    await decideByPlatform(env.DB, PLATFORM, "d8-first", "approved", Date.now());
    expect(await publicIds()).toContain("d8-first");
  });

  it("the tenant cannot write another tenant's screening row (trigger)", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO product_screening (product_id, tenant_id, status, decided_by, decided_at, created_at, updated_at)
         VALUES ('d8-third', 'tenant-other', 'approved', 'x', ?, ?, ?)`,
      )
        .bind(new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
        .run(),
    ).rejects.toThrow();
  });
});

// ── THE FENCE (Codex CP2 P1): no mutation commits under facts it never saw ──

/**
 * A D1 handle whose batch() first lets something else commit — the
 * interleaving a real race produces between a mutation's reads and its batch.
 * The interleaved writer uses the REAL env.DB, so it is not itself raced.
 */
function racingDb(onBatch: (attempt: number) => Promise<void>): D1Database {
  let attempt = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          attempt += 1;
          await onBatch(attempt);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const RACE_TENANT = "tenant-race";
const RACE_HOST = "race.podtest.test";
const raceContext: TenantContext = { domainKind: "storefront", hostname: RACE_HOST, tenantId: RACE_TENANT };
const raceAdmin = adminOf(RACE_TENANT);

async function productName(productId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT name FROM products WHERE product_id = ?")
    .bind(productId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

async function auditCount(productId: string, action: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM audit_events WHERE resource_id = ? AND action = ?",
  )
    .bind(productId, action)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

describe("the screening fence (a platform decision racing a seller mutation)", () => {
  beforeAll(async () => {
    await seedTenant(RACE_TENANT, RACE_HOST);
    const iso = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO content_screening_terms (term, kind, hard_block, created_at) VALUES ('nike', 'brand', 1, ?)",
    )
      .bind(iso)
      .run();
    await seedProfile();
    await seedPrinter();
    await seedArtwork(RACE_TENANT, { artworkId: "race-clean", fileName: "clean.png" });
    await seedArtwork(RACE_TENANT, { artworkId: "race-nike", fileName: "nike_logo.png" });
  });

  it("an approval between the edit's reads and its batch: the edit is re-run and blocked, never public under the old approval", async () => {
    await seedProduct(RACE_TENANT, { name: "Plain tee", productId: "race-edit" });
    expect(await publishAdminProduct(env.DB, raceAdmin, "race-edit", Date.now())).toMatchObject({
      product: { screeningStatus: "pending" },
    });

    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        await decideByPlatform(env.DB, PLATFORM, "race-edit", "approved", Date.now());
      }
    });
    const result = await updateAdminProduct(racing, raceAdmin, "race-edit", { name: "Nike tee" }, Date.now());

    // Before the fence: the version-guarded screening UPDATE matched nothing,
    // the rename committed anyway, and "Nike tee" went public as 'approved'.
    expect(result).toMatchObject({ product: { name: "Nike tee", screeningStatus: "blocked" }, status: "ok" });
    expect(await screeningRow("race-edit")).toMatchObject({
      hits_json: '["nike"]',
      reason: "hard_block",
      status: "blocked",
    });
    expect(await getPublicProduct(env.DB, raceContext, "race-edit")).toBeNull();
    // The approval landed; the edit committed exactly once (the aborted
    // attempt left nothing behind).
    expect(await auditCount("race-edit", "screening.approve")).toBe(1);
    expect(await auditCount("race-edit", "product.update")).toBe(1);
  });

  it("a decision that keeps racing: 409, and NOTHING of the edit commits", async () => {
    await seedProduct(RACE_TENANT, { name: "Calm tee", productId: "race-persist" });
    await publishAdminProduct(env.DB, raceAdmin, "race-persist", Date.now());
    await decideByPlatform(env.DB, PLATFORM, "race-persist", "approved", Date.now());

    const racing = racingDb(async () => {
      await decideByPlatform(env.DB, PLATFORM, "race-persist", "approved", Date.now());
    });
    await expect(
      updateAdminProduct(racing, raceAdmin, "race-persist", { name: "Nike hoodie" }, Date.now()),
    ).resolves.toEqual({ status: "conflict" });

    expect(await productName("race-persist")).toBe("Calm tee");
    expect(await auditCount("race-persist", "product.update")).toBe(0);
    expect((await screeningRow("race-persist"))?.status).toBe("approved");
    expect((await getPublicProduct(env.DB, raceContext, "race-persist"))?.name).toBe("Calm tee");
  });

  it("a mapping created on a live product racing an approval is re-screened with its artwork's name", async () => {
    await seedProduct(RACE_TENANT, { priceMinor: 39_900, productId: "race-map" });
    expect((await createMapping(env.DB, raceAdmin, {
      artworkId: "race-clean", printerId: "fake-printer", productId: "race-map", sku: TEE_S, slots: ["front"], variantId: null,
    }, Date.now())).status).toBe("ok");
    expect((await publishAdminProduct(env.DB, raceAdmin, "race-map", Date.now())).status).toBe("ok");

    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        await decideByPlatform(env.DB, PLATFORM, "race-map", "approved", Date.now());
      }
    });
    const created = await createMapping(racing, raceAdmin, {
      artworkId: "race-nike", printerId: "fake-printer", productId: "race-map", sku: TEE_S, slots: ["back"], variantId: null,
    }, Date.now());
    expect(created.status).toBe("ok");
    expect((await screeningRow("race-map"))?.status).toBe("blocked");
    expect(await getPublicProduct(env.DB, raceContext, "race-map")).toBeNull();
  });

  it("a mapping committed between a FIRST publish's reads and its batch: the publish is re-run and screens the new artwork", async () => {
    await seedProduct(RACE_TENANT, { priceMinor: 39_900, productId: "race-first" });
    expect((await createMapping(env.DB, raceAdmin, {
      artworkId: "race-clean", printerId: "fake-printer", productId: "race-first", sku: TEE_S, slots: ["front"], variantId: null,
    }, Date.now())).status).toBe("ok");

    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        const late = await createMapping(env.DB, raceAdmin, {
          artworkId: "race-nike", printerId: "fake-printer", productId: "race-first", sku: TEE_S, slots: ["back"], variantId: null,
        }, Date.now());
        expect(late.status).toBe("ok");
      }
    });
    const published = await publishAdminProduct(racing, raceAdmin, "race-first", Date.now());

    // No screening row existed for the late mapping to bump; the publish's
    // products.updated_at fence is what caught it.
    expect(published).toMatchObject({ product: { screeningStatus: "blocked" }, status: "ok" });
    expect((await screeningRow("race-first"))?.hits_json).toBe('["nike"]');
    expect(await getPublicProduct(env.DB, raceContext, "race-first")).toBeNull();
  });

  it("a mapping change that keeps racing answers conflict and writes nothing", async () => {
    await seedProduct(RACE_TENANT, { priceMinor: 39_900, productId: "race-map-persist" });
    await createMapping(env.DB, raceAdmin, {
      artworkId: "race-clean", printerId: "fake-printer", productId: "race-map-persist", sku: TEE_S, slots: ["front"], variantId: null,
    }, Date.now());
    await publishAdminProduct(env.DB, raceAdmin, "race-map-persist", Date.now());

    const racing = racingDb(async () => {
      await decideByPlatform(env.DB, PLATFORM, "race-map-persist", "approved", Date.now());
    });
    await expect(
      createMapping(racing, raceAdmin, {
        artworkId: "race-nike", printerId: "fake-printer", productId: "race-map-persist", sku: TEE_S, slots: ["back"], variantId: null,
      }, Date.now()),
    ).resolves.toEqual({ code: "conflict", status: "conflict" });
    expect((await listMappings(env.DB, raceAdmin, "race-map-persist")).map((m) => m.artworkId)).toEqual(["race-clean"]);
  });

  it("the fence statements themselves: a stale version and an appeared row both abort", async () => {
    await seedProduct(RACE_TENANT, { productId: "race-fence" });
    const absent = await readScreeningGuard(env.DB, RACE_TENANT, "race-fence");
    expect(absent.row).toBeNull();
    // Nothing appeared: the absence assertion is a no-op.
    await env.DB.batch([screeningFenceStatement(env.DB, absent, Date.now())]);

    await decideByPlatform(env.DB, PLATFORM, "race-fence", "approved", Date.now());
    await expect(env.DB.batch([screeningFenceStatement(env.DB, absent, Date.now())])).rejects.toThrow(
      /screening version must increase/,
    );

    const stale = await readScreeningGuard(env.DB, RACE_TENANT, "race-fence");
    await decideByPlatform(env.DB, PLATFORM, "race-fence", "approved", Date.now());
    await expect(env.DB.batch([screeningFenceStatement(env.DB, stale, Date.now())])).rejects.toThrow(
      /screening version must increase/,
    );
    const fresh = await readScreeningGuard(env.DB, RACE_TENANT, "race-fence");
    await env.DB.batch([screeningFenceStatement(env.DB, fresh, Date.now())]);
    expect((await screeningRow("race-fence"))?.version).toBe((fresh.row?.version ?? 0) + 1);
  });
});

// ── Codex follow-on: every retry attempt stamps with its own clock ─────────

describe("the retry stamps with a fresh clock, clamped to the row it writes", () => {
  it("an edit racing a FIRST publish stamped 10 ms later: the retry succeeds (no updated_at < created_at)", async () => {
    // Live via a fixture publication and never screened: the edit's first
    // attempt INSERTs the screening row.
    await seedProduct(RACE_TENANT, { name: "Clock tee", productId: "race-clock", published: true });
    const start = Date.now();
    const racing = racingDb(async (attempt) => {
      if (attempt === 1) {
        expect((await publishAdminProduct(env.DB, raceAdmin, "race-clock", start + 10)).status).toBe("ok");
      }
    });

    // Before the fix the retry reused `start`, stamped updated_at before the
    // publish's created_at, and the CHECK threw (a 500).
    const result = await updateAdminProduct(racing, raceAdmin, "race-clock", { name: "Clock tee v2" }, start);
    expect(result).toMatchObject({ product: { name: "Clock tee v2" }, status: "ok" });

    const row = await env.DB.prepare(
      "SELECT created_at, updated_at, decided_at FROM product_screening WHERE product_id = 'race-clock'",
    ).first<{ created_at: string; decided_at: string; updated_at: string }>();
    expect(row?.created_at).toBe(new Date(start + 10).toISOString());
    expect(row !== null && row.updated_at >= row.created_at).toBe(true);
    expect(await productName("race-clock")).toBe("Clock tee v2");
  });

  it("a mapping stamped by a clock that runs ahead can still be deleted (and re-activated)", async () => {
    await seedProduct(RACE_TENANT, { priceMinor: 39_900, productId: "race-ahead" });
    const start = Date.now();
    const created = await createMapping(env.DB, raceAdmin, {
      artworkId: "race-clean", printerId: "fake-printer", productId: "race-ahead", sku: TEE_S, slots: ["front"], variantId: null,
    }, start + 60_000);
    expect(created.status).toBe("ok");
    const mappingId = created.status === "ok" ? created.mapping.mappingId : "";

    const { deleteMapping } = await import("../src/pod/pod-mappings");
    await expect(deleteMapping(env.DB, raceAdmin, mappingId, start)).resolves.toEqual({ status: "ok" });
    const again = await createMapping(env.DB, raceAdmin, {
      artworkId: "race-clean", printerId: "fake-printer", productId: "race-ahead", sku: TEE_S, slots: ["front"], variantId: null,
    }, start);
    expect(again).toMatchObject({ created: false, status: "ok" });
    const row = await env.DB.prepare("SELECT created_at, updated_at FROM pod_mappings WHERE id = ?")
      .bind(mappingId)
      .first<{ created_at: string; updated_at: string }>();
    expect(row !== null && row.updated_at >= row.created_at).toBe(true);
  });
});
