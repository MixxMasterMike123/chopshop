import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { PENDING_OBJECT_MAX_AGE_MS, sweepPendingObjects } from "../src/storage/object-sweep";
import {
  ADMIN_HOST,
  count,
  envWith,
  hostRequest,
  portalAffiliateOf,
  seedPublicShop,
} from "./affiliate-fixtures";

/**
 * CP13 A1 round 4 (Codex finding 5) — an invoice upload racing the object
 * sweep. The upload reads `pending`, the sweep tombstones the reservation,
 * deletes its key and marks the bytes gone, and only THEN does the upload's
 * R2 write finish: the refused activation must remove those late bytes (the
 * sweep never visits that row again). It must never remove bytes another
 * upload activated. Its own file: the sweep runs over the whole database.
 */

const SHOP = "aff-race";
const PDF = new TextEncoder().encode("%PDF-1.7\nrace\n%%EOF\n");

type Affiliate = Awaited<ReturnType<typeof portalAffiliateOf>>;
let person: Affiliate;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reserve(): Promise<{ key: string; objectId: string }> {
  const response = await worker.fetch(
    hostRequest("POST", "/v1/affiliate/objects", {
      body: { contentType: "application/pdf", sha256: await sha256Hex(PDF), sizeBytes: PDF.length },
      cookie: person.cookie,
      shopId: SHOP,
    }),
    env,
  );
  expect(response.status).toBe(201);
  const { objectId } = (await response.json<{ object: { objectId: string } }>()).object;
  const row = await env.DB.prepare("SELECT object_key FROM stored_objects WHERE object_id = ?")
    .bind(objectId)
    .first<{ object_key: string }>();
  return { key: row?.object_key ?? "", objectId };
}

/** The real bucket, with a hook run BEFORE each put lands and an optional failing delete. */
function racingBucket(beforePut: () => Promise<void>, failDelete = false): R2Bucket {
  const real = env.PRIVATE_BUCKET;
  return new Proxy(real, {
    get(target, property) {
      if (property === "put") {
        return async (...args: Parameters<R2Bucket["put"]>) => {
          await beforePut();
          return target.put(...args);
        };
      }
      if (property === "delete" && failDelete) {
        return async () => {
          throw new Error("r2 down");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function upload(objectId: string, bucket: R2Bucket): Promise<Response> {
  return worker.fetch(
    new Request(`${ADMIN_HOST}/v1/affiliate/objects/${objectId}/content`, {
      body: PDF,
      headers: {
        "content-length": String(PDF.length),
        "content-type": "application/pdf",
        cookie: person.cookie,
        origin: ADMIN_HOST,
        "x-shop-id": SHOP,
      },
      method: "PUT",
    }),
    envWith({ PRIVATE_BUCKET: bucket }),
  );
}

const sweepLater = () => sweepPendingObjects(env, Date.now() + PENDING_OBJECT_MAX_AGE_MS + 60_000).then(() => undefined);

beforeAll(async () => {
  await seedPublicShop(SHOP, "aff-race.shop.test");
  person = await portalAffiliateOf(SHOP, "RACE01");
});

describe("an invoice upload racing the sweep (Codex round 4, finding 5)", () => {
  it("the sweep wins between the pending read and the R2 write: the late bytes are deleted, the answer is a conflict", async () => {
    const { key, objectId } = await reserve();
    const response = await upload(objectId, racingBucket(sweepLater));
    expect(response.status).toBe(409);
    const row = await env.DB.prepare("SELECT status FROM stored_objects WHERE object_id = ?").bind(objectId).first();
    expect(row).toEqual({ status: "deleted" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'object.bytes_deleted'", objectId)).toBe(1);
    // The late write is gone too: nothing is orphaned.
    expect(await env.PRIVATE_BUCKET.head(key)).toBeNull();
  });

  it("the late delete fails: the bytes stay, an object.bytes_orphaned row names the object for the sweep's retry", async () => {
    const { key, objectId } = await reserve();
    const response = await upload(objectId, racingBucket(sweepLater, true));
    expect(response.status).toBe(409);
    expect(await env.PRIVATE_BUCKET.head(key)).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'object.bytes_orphaned'", objectId)).toBe(1);
    await env.PRIVATE_BUCKET.delete(key);
  });

  it("another upload activated the reservation first: its bytes are never deleted", async () => {
    const { key, objectId } = await reserve();
    const otherActivates = async () => {
      await env.DB.prepare("UPDATE stored_objects SET status = 'active', updated_at = updated_at + 1 WHERE object_id = ?")
        .bind(objectId)
        .run();
    };
    const response = await upload(objectId, racingBucket(otherActivates));
    expect(response.status).toBe(409);
    expect(await env.DB.prepare("SELECT status FROM stored_objects WHERE object_id = ?").bind(objectId).first()).toEqual({
      status: "active",
    });
    expect(await env.PRIVATE_BUCKET.head(key)).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'object.bytes_orphaned'", objectId)).toBe(0);
  });

  it("without a race the upload activates as before", async () => {
    const { key, objectId } = await reserve();
    const response = await upload(objectId, env.PRIVATE_BUCKET);
    expect(response.status).toBe(200);
    expect(await env.PRIVATE_BUCKET.head(key)).not.toBeNull();
  });
});
