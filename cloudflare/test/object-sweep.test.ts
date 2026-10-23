import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { CP13_STEPS } from "../src/outbox/scheduled";
import { activateObject, reservePendingObject, type ObjectBucket, type ObjectKind } from "../src/storage/object-store";
import {
  INVOICE_LISTING,
  OBJECT_ID_HOLDERS,
  OBJECT_SWEEP_BATCH,
  PENDING_OBJECT_MAX_AGE_MS,
  sweepPendingObjects,
  UNATTACHED_INVOICE_MAX_AGE_MS,
} from "../src/storage/object-sweep";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import { envWith, iso, nextId, seedAffiliate } from "./affiliate-fixtures";
import { seedShop } from "./discount-fixtures";

/**
 * CP13 A4 — the object sweep (src/storage/object-sweep.ts):
 *   - an old `pending` row nothing names loses its bytes and its row;
 *   - (round 1) a listed affiliate invoice no payout names, unchanged 30 days,
 *     becomes a tombstone;
 *   - a young one, a live object of the shop, and anything a payout or the
 *     store identity names are never touched;
 *   - a listed invoice stays as a tombstone (its listing is append-only);
 *   - (round 1) a failed byte delete is retried next tick;
 *   - at most OBJECT_SWEEP_BATCH rows per run; every move audited;
 *   - (round 1) every foreign key to stored_objects is a known holder.
 */

const SHOP = "object-sweep-shop";
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1_000;
const OLD = NOW - PENDING_OBJECT_MAX_AGE_MS - 60 * 60 * 1_000;
const tenant: TenantContext = { domainKind: "admin", hostname: "object-sweep.test", tenantId: SHOP };

async function reserve(
  createdAt: number,
  kind: ObjectKind = "document",
  bucket: ObjectBucket = "private",
  listed = false,
): Promise<{ objectId: string; objectKey: string }> {
  const result = await reservePendingObject(
    env.DB,
    tenant,
    { bucket, contentType: "application/pdf", declaredSha256: "a".repeat(64), declaredSizeBytes: 5, fileName: "f.pdf", kind },
    createdAt,
    listed
      ? (objectId) => [
          env.DB.prepare(
            `INSERT INTO ${INVOICE_LISTING.table} (object_id, tenant_id, affiliate_id, created_at) VALUES (?, ?, ?, ?)`,
          ).bind(objectId, SHOP, affiliateId, iso(createdAt)),
        ]
      : undefined,
  );
  if (result.status !== "ok") {
    throw new Error(result.status);
  }
  return result.object;
}

/** An invoice the affiliate uploaded at `activatedAt` (listed, active). */
async function uploadedInvoice(activatedAt: number): Promise<{ objectId: string; objectKey: string }> {
  const invoice = await reserve(activatedAt - 60_000, "document", "private", true);
  await env.PRIVATE_BUCKET.put(invoice.objectKey, "%PDF-");
  const activated = await activateObject(env.DB, tenant, invoice.objectId, { sha256: "a".repeat(64), sizeBytes: 5 }, activatedAt);
  if (activated.status !== "ok") {
    throw new Error(activated.status);
  }
  return invoice;
}

let payoutAffiliates = 0;

/** A payout naming `objectId`, by an affiliate of its own (one open request per affiliate). */
async function requestPayoutWith(objectId: string, status: "requested" | "void" = "requested"): Promise<void> {
  const at = iso(NOW);
  const payoutId = nextId("payout");
  payoutAffiliates += 1;
  const { affiliateId: payee } = await seedAffiliate({ code: `PAYEE${payoutAffiliates}`, tenantId: SHOP });
  await env.DB.prepare(
    `INSERT INTO affiliate_payouts (
       payout_id, tenant_id, affiliate_id, amount_minor, currency, status, rail, invoice_object_id,
       requested_by, requested_at, created_at, updated_at
     ) VALUES (?, ?, ?, 100, 'SEK', 'requested', 'manual', ?, 'u', ?, ?, ?)`,
  )
    .bind(payoutId, SHOP, payee, objectId, at, at, at)
    .run();
  if (status === "void") {
    await env.DB.prepare(
      "UPDATE affiliate_payouts SET status = 'void', voided_at = ?, voided_by = 'u', void_reason = 'nej', updated_at = ? WHERE payout_id = ?",
    )
      .bind(at, at, payoutId)
      .run();
  }
}

async function rowOf(objectId: string): Promise<{ status: string } | null> {
  return env.DB.prepare("SELECT status FROM stored_objects WHERE object_id = ?").bind(objectId).first<{ status: string }>();
}

async function actionsOf(objectId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT action FROM audit_events WHERE resource_type = 'stored_object' AND resource_id = ? ORDER BY created_at, rowid",
  )
    .bind(objectId)
    .all<{ action: string }>();
  return rows.results.map((row) => row.action);
}

async function sweepReasonOf(objectId: string): Promise<unknown> {
  const audit = await env.DB.prepare(
    "SELECT tenant_id, actor_user_id, metadata_json FROM audit_events WHERE resource_id = ? AND action = 'object.sweep'",
  )
    .bind(objectId)
    .first<{ actor_user_id: string | null; metadata_json: string; tenant_id: string }>();
  return audit === null ? null : { actor: audit.actor_user_id, tenant: audit.tenant_id, ...JSON.parse(audit.metadata_json) };
}

let affiliateId = "";

beforeAll(async () => {
  await seedShop(SHOP, "object-sweep.test");
  affiliateId = (await seedAffiliate({ code: "SWEEP1", tenantId: SHOP })).affiliateId;
});

describe("the object sweep", () => {
  it("is a CP13 cron step after the application retention", () => {
    expect(CP13_STEPS.map(([name]) => name)).toEqual(["affiliate_application_retention", "pending_object_sweep"]);
  });

  it("deletes an old pending reservation nothing names, its row AND its bytes, audited", async () => {
    const old = await reserve(OLD);
    await env.PRIVATE_BUCKET.put(old.objectKey, "%PDF-");
    const result = await sweepPendingObjects(env, NOW);
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(result.byteFailures).toBe(0);
    expect(await rowOf(old.objectId)).toBeNull();
    expect(await env.PRIVATE_BUCKET.get(old.objectKey)).toBeNull();
    expect(await actionsOf(old.objectId)).toEqual(["object.reserve", "object.sweep", "object.bytes_deleted", "object.purge"]);
    expect(await sweepReasonOf(old.objectId)).toEqual({
      actor: null,
      bucket: "private",
      kind: "document",
      listed: 0,
      reason: "pending_expired",
      tenant: SHOP,
    });
  });

  it("never touches a young reservation, a live object, or an old one a payout or the store identity names", async () => {
    const young = await reserve(NOW - PENDING_OBJECT_MAX_AGE_MS + 60 * 60 * 1_000);
    const live = await reserve(OLD - 60 * DAY);
    await env.PRIVATE_BUCKET.put(live.objectKey, "%PDF-");
    // A live object of the shop that no listing names: never swept, however old.
    expect((await activateObject(env.DB, tenant, live.objectId, { sha256: "a".repeat(64), sizeBytes: 5 }, OLD - 59 * DAY)).status).toBe("ok");
    const paidFor = await reserve(OLD);
    await env.PRIVATE_BUCKET.put(paidFor.objectKey, "%PDF-");
    await requestPayoutWith(paidFor.objectId);
    const branding = await reserve(OLD, "shop_branding", "public");
    // seedShop wrote the settings row (the legal gate's fields): the identity names the logo.
    await env.DB.prepare("UPDATE tenant_settings SET store_identity_json = ? WHERE tenant_id = ?")
      .bind(JSON.stringify({ logoObjectId: branding.objectId }), SHOP)
      .run();

    await sweepPendingObjects(env, NOW);

    expect(await rowOf(young.objectId)).toEqual({ status: "pending" });
    expect(await rowOf(live.objectId)).toEqual({ status: "active" });
    expect(await env.PRIVATE_BUCKET.get(live.objectKey)).not.toBeNull();
    expect(await rowOf(paidFor.objectId)).toEqual({ status: "pending" });
    expect(await env.PRIVATE_BUCKET.get(paidFor.objectKey)).not.toBeNull();
    expect(await rowOf(branding.objectId)).toEqual({ status: "pending" });
    for (const id of [young.objectId, live.objectId, paidFor.objectId, branding.objectId]) {
      expect(await actionsOf(id), id).not.toContain("object.sweep");
    }
  });

  it("a listed affiliate invoice that never landed becomes a tombstone: bytes gone, row and listing kept, no longer loose", async () => {
    const listed = await reserve(OLD, "document", "private", true);
    await env.PRIVATE_BUCKET.put(listed.objectKey, "%PDF-");
    const result = await sweepPendingObjects(env, NOW);
    expect(result.retained).toBeGreaterThanOrEqual(1);
    expect(await rowOf(listed.objectId)).toEqual({ status: "deleted" });
    expect(await env.PRIVATE_BUCKET.get(listed.objectKey)).toBeNull();
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${INVOICE_LISTING.table} WHERE object_id = ?`).bind(listed.objectId).first<{ n: number }>(),
    ).toEqual({ n: 1 });
    expect(await actionsOf(listed.objectId)).toEqual(["object.reserve", "object.sweep", "object.bytes_deleted"]);
    // A second run neither retries nor re-audits it: its bytes are confirmed gone.
    const again = await sweepPendingObjects(env, NOW);
    expect(again.retried).toBe(0);
    expect(await actionsOf(listed.objectId)).toEqual(["object.reserve", "object.sweep", "object.bytes_deleted"]);
  });

  it("(round 1) an uploaded invoice no payout names is tombstoned after 30 days; a younger one, or one a payout names (even a void one), is not", async () => {
    const stale = await uploadedInvoice(NOW - UNATTACHED_INVOICE_MAX_AGE_MS - DAY);
    const fresh = await uploadedInvoice(NOW - UNATTACHED_INVOICE_MAX_AGE_MS + DAY);
    const attached = await uploadedInvoice(NOW - UNATTACHED_INVOICE_MAX_AGE_MS - DAY);
    await requestPayoutWith(attached.objectId, "void");

    const result = await sweepPendingObjects(env, NOW);
    expect(result.byteFailures).toBe(0);

    expect(await rowOf(stale.objectId)).toEqual({ status: "deleted" });
    expect(await env.PRIVATE_BUCKET.get(stale.objectKey)).toBeNull();
    expect(await sweepReasonOf(stale.objectId)).toMatchObject({ listed: 1, reason: "unattached_invoice" });
    expect(await actionsOf(stale.objectId)).toEqual(["object.reserve", "object.activate", "object.sweep", "object.bytes_deleted"]);

    expect(await rowOf(fresh.objectId)).toEqual({ status: "active" });
    expect(await env.PRIVATE_BUCKET.get(fresh.objectKey)).not.toBeNull();
    expect(await rowOf(attached.objectId)).toEqual({ status: "active" });
    expect(await env.PRIVATE_BUCKET.get(attached.objectKey)).not.toBeNull();

    // The cap (object-routes.ts looseInvoicesBelowLimit) counts `status <> 'deleted'`:
    // the stale one left it; the fresh one (no payout) still counts.
    const loose = await env.DB.prepare(
      `SELECT l.object_id FROM ${INVOICE_LISTING.table} AS l
       INNER JOIN stored_objects AS o ON o.object_id = l.object_id
       WHERE l.affiliate_id = ? AND o.status <> 'deleted'
         AND (o.status = 'pending' OR NOT EXISTS (SELECT 1 FROM affiliate_payouts AS p WHERE p.invoice_object_id = l.object_id))`,
    )
      .bind(affiliateId)
      .all<{ object_id: string }>();
    expect(loose.results.map((row) => row.object_id)).toEqual([fresh.objectId]);
  });

  it("(round 1) a bucket that refuses the delete keeps the row tombstoned, fails the step, and the next tick retries it", async () => {
    const stuck = await reserve(OLD);
    await env.PRIVATE_BUCKET.put(stuck.objectKey, "%PDF-");
    const refusing = envWith({
      PRIVATE_BUCKET: { delete: async () => Promise.reject(new Error("r2 down")) },
    });
    await expect(sweepPendingObjects(refusing, NOW)).rejects.toThrow(/kept their bytes/);
    expect(await rowOf(stuck.objectId)).toEqual({ status: "deleted" });
    expect(await actionsOf(stuck.objectId)).toEqual(["object.reserve", "object.sweep"]);
    // Still failing: retried, still kept, still not marked.
    await expect(sweepPendingObjects(refusing, NOW + 60_000)).rejects.toThrow(/kept their bytes/);
    expect(await actionsOf(stuck.objectId)).toEqual(["object.reserve", "object.sweep"]);
    // R2 is back: the retry deletes the bytes and the row.
    const healed = await sweepPendingObjects(env, NOW + 120_000);
    expect(healed.retried).toBe(1);
    expect(healed.purged).toBeGreaterThanOrEqual(1);
    expect(await rowOf(stuck.objectId)).toBeNull();
    expect(await env.PRIVATE_BUCKET.get(stuck.objectKey)).toBeNull();
    expect(await actionsOf(stuck.objectId)).toEqual(["object.reserve", "object.sweep", "object.bytes_deleted", "object.purge"]);
    expect((await sweepPendingObjects(env, NOW + 180_000)).retried).toBe(0);
  });

  it("takes at most OBJECT_SWEEP_BATCH rows per run, retries included, oldest first", async () => {
    const oldest = OLD - 2 * DAY;
    const ids: string[] = [];
    for (let index = 0; index < OBJECT_SWEEP_BATCH + 5; index += 1) {
      ids.push((await reserve(oldest + index, "temp_upload", "temp")).objectId);
    }
    const first = await sweepPendingObjects(env, NOW);
    expect(first.retried + first.swept).toBe(OBJECT_SWEEP_BATCH);
    expect(first.swept).toBe(OBJECT_SWEEP_BATCH);
    const left = await env.DB.prepare(
      "SELECT object_id FROM stored_objects WHERE object_id IN (SELECT value FROM json_each(?)) ORDER BY created_at",
    )
      .bind(JSON.stringify(ids))
      .all<{ object_id: string }>();
    expect(left.results.map((row) => row.object_id)).toEqual(ids.slice(OBJECT_SWEEP_BATCH));
    const second = await sweepPendingObjects(env, NOW);
    expect(second.swept).toBe(5);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM stored_objects WHERE object_id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(ids))
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("does nothing on a database with nothing due", async () => {
    expect(await sweepPendingObjects(env, NOW)).toEqual({ byteFailures: 0, purged: 0, retained: 0, retried: 0, swept: 0 });
  });
});

describe("(round 1) every holder of an object id is guarded", () => {
  it("every foreign key to stored_objects, in every table, is a guarded holder or the invoice listing", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string }>();
    const foreign: string[] = [];
    for (const { name } of tables.results) {
      const keys = await env.DB.prepare('SELECT "table", "from" FROM pragma_foreign_key_list(?)')
        .bind(name)
        .all<{ from: string; table: string }>();
      for (const key of keys.results) {
        if (key.table === "stored_objects") {
          foreign.push(`${name}.${key.from}`);
        }
      }
    }
    const guarded = OBJECT_ID_HOLDERS.filter((holder) => holder.foreignKey).map((holder) => `${holder.table}.${holder.column}`);
    expect(foreign.sort()).toEqual([...guarded, `${INVOICE_LISTING.table}.${INVOICE_LISTING.column}`].sort());
  });

  it("every holder (the payout column too) exists with a tenant_id, and the identity's branding ids are the keys the guard reads", async () => {
    for (const holder of [...OBJECT_ID_HOLDERS, { column: INVOICE_LISTING.column, table: INVOICE_LISTING.table }]) {
      const columns = await env.DB.prepare("SELECT name FROM pragma_table_info(?)").bind(holder.table).all<{ name: string }>();
      const names = columns.results.map((column) => column.name);
      expect(names, holder.table).toContain(holder.column);
      expect(names, holder.table).toContain("tenant_id");
    }
    const settings = await env.DB.prepare("SELECT name FROM pragma_table_info('tenant_settings')").all<{ name: string }>();
    expect(settings.results.map((column) => column.name)).toContain("store_identity_json");
    // The identity's branding keys (tenant-config.ts) live in that JSON, which the guard searches whole.
    const { GALLERY_IMAGE_KEY, STORE_IDENTITY_IMAGE_KEYS } = await import("../src/platform/tenant-config");
    expect([...STORE_IDENTITY_IMAGE_KEYS, GALLERY_IMAGE_KEY].every((key) => /ObjectId$/.test(key))).toBe(true);
  });
});
