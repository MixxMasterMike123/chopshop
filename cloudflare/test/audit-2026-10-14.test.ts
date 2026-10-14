import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { AUTH_BODY_MAX_BYTES } from "../src/auth/auth-routes";
import type { TenantAdminPrincipal } from "../src/auth/live-authorization";
import { createAuthEmailJob, deliveryIdFromKey } from "../src/email/auth-email-job";
import { RESEND_FETCH_OVERRIDE, readEmailDeliveryConfig, shopSenderName } from "../src/email/email-queue-consumer";
import { createOrderEmailJob } from "../src/email/order-emails";
import { JSON_BODY_MAX_BYTES, readJsonBody, readTextBodyWithin } from "../src/lib/responses";
import { deliverAdminObject, privateDeliveryHeaders } from "../src/storage/object-routes";
import {
  activateObject,
  deletePendingOrMutableObject,
  markObjectImmutable,
  reservePendingObject,
  type ObjectTenant,
} from "../src/storage/object-store";

/**
 * The 2026-10-14 audit's "fix now" batch, one pin per finding:
 *   F02 bodies are read under a cap (JSON routes, the Stripe webhook, auth);
 *   F05 every buyer-facing mail is sent under the shop's name;
 *   F06 a transition that lost its race is a conflict, with no audit row;
 *   F07 the audit row of a file transition names the actor and the grant;
 *   F19 a private non-raster download never renders inline on the admin origin.
 * (F01 is pinned in render/test/pipeline.test.ts; F16 in entrypoints.test.ts.)
 */
const TENANT = "tenant-audit-1014";
const NOW = 1_787_900_000_000;
const SHA = "c".repeat(64);
const HOUR_MS = 60 * 60 * 1_000;

const tenant: ObjectTenant = { domainKind: "admin", hostname: "", tenantId: TENANT };

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO tenants (
      tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
    ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(TENANT, "Audit Shop", NOW, NOW)
    .run();
});

/** A body streamed in chunks with no declared length. */
function chunkedRequest(totalBytes: number, chunk = 65_536, onRead?: () => void): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onRead?.();
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(0x20));
      sent += size;
    },
  });
  return new Request("https://api.test/x", { body, duplex: "half", method: "POST" } as RequestInit);
}

describe("F02 — bodies are read under a cap", () => {
  it("reads a JSON body under the cap and refuses one over it, chunked and undeclared", async () => {
    const small = new Request("https://api.test/x", { body: JSON.stringify({ a: 1 }), method: "POST" });
    await expect(readJsonBody(small)).resolves.toEqual({ a: 1 });

    let reads = 0;
    const over = chunkedRequest(JSON_BODY_MAX_BYTES + 1, 65_536, () => {
      reads += 1;
    });
    await expect(readJsonBody(over)).resolves.toBeUndefined();
    // Cut off as soon as the cap is passed: not every chunk was pulled.
    expect(reads).toBeLessThan(Math.ceil((JSON_BODY_MAX_BYTES + 1) / 65_536) + 1);
  });

  it("refuses a declared length over the cap", async () => {
    // The runtime may or may not keep a caller-set Content-Length on a
    // streamed body; either way the body reads as over the cap.
    const request = new Request("https://api.test/x", {
      body: chunkedRequest(JSON_BODY_MAX_BYTES + 1).body,
      duplex: "half",
      headers: { "content-length": String(JSON_BODY_MAX_BYTES + 1) },
      method: "POST",
    } as RequestInit);
    await expect(readJsonBody(request)).resolves.toBeUndefined();
  });

  it("gives back the exact text of a body under the cap, null over it", async () => {
    const text = '{"id": "evt_1",  "x":\t"ö"}';
    await expect(readTextBodyWithin(new Request("https://api.test/x", { body: text, method: "POST" }), 1_024)).resolves.toBe(text);
    await expect(readTextBodyWithin(chunkedRequest(2_048), 1_024)).resolves.toBeNull();
  });

  it("the Stripe webhook refuses an oversized body as an unverifiable signature, before anything else", async () => {
    const response = await worker.fetch(
      new Request("https://hooks.audit.test/v1/webhooks/stripe", {
        body: new Uint8Array(1_048_577).fill(0x7b),
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
        method: "POST",
      }),
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_signature", message: "Request signature could not be verified" },
    });
  });

  it("an auth body over its cap is a 413 and never reaches Better Auth", async () => {
    const response = await worker.fetch(
      new Request(`${env.AUTH_BASE_URL}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email: "x@y.test", password: "p".repeat(AUTH_BODY_MAX_BYTES) }),
        headers: { "content-type": "application/json", origin: env.AUTH_BASE_URL },
        method: "POST",
      }),
      env,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "payload_too_large", message: "Request body is too large" },
    });
  });
});

describe("F05 — a buyer's mail is sent under the shop's name", () => {
  const frame = async (key: string) => {
    const createdAt = Date.now();
    return { createdAt, deliveryId: await deliveryIdFromKey(key), expiresAt: createdAt + HOUR_MS, tenantId: TENANT };
  };

  it("names the shop for the buyer's kinds and nobody for the platform's", async () => {
    const refund = createOrderEmailJob({
      ...(await frame("audit:refund:1")),
      content: { amountMinor: 100, currency: "SEK", full: true, orderNumber: "A-1", recipientName: null, shopName: "Fjällboden", supportEmail: null },
      kind: "refund_notice",
      recipient: "kund@example.test",
    });
    expect(shopSenderName(refund)).toBe("Fjällboden");

    const status = createOrderEmailJob({
      ...(await frame("audit:status:1")),
      content: {
        additionalParcel: false,
        carrier: null,
        orderNumber: "A-1",
        pickupPlaceAddress: null,
        pickupPlaceName: null,
        recipientName: null,
        shopName: "Fjällboden",
        status: "processing",
        supportEmail: null,
        trackingNumber: null,
      },
      kind: "order_status_update",
      recipient: "kund@example.test",
    });
    expect(shopSenderName(status)).toBe("Fjällboden");

    const notice = createOrderEmailJob({
      ...(await frame("audit:notice:1")),
      content: {
        adminUrl: null,
        currency: "SEK",
        deliveryMethod: "pickup",
        discountMinor: 0,
        items: [{ lineTotalMinor: 100, name: "x", quantity: 1 }],
        orderNumber: "A-1",
        pickupPlaceName: null,
        shippingCountry: null,
        shippingMinor: 0,
        shopName: "Fjällboden",
        subtotalMinor: 100,
        totalMinor: 100,
        vatMinor: 20,
      },
      kind: "order_notice_shop",
      recipient: "shop@example.test",
    });
    expect(shopSenderName(notice)).toBeNull();

    const reset = createAuthEmailJob(
      {
        actionUrl: `${env.AUTH_BASE_URL}/api/auth/reset-password/tokenaudit00000000000001?callbackURL=${encodeURIComponent("https://web.test.invalid/reset-password")}`,
        expiresAt: Date.now() + HOUR_MS,
        kind: "password_reset",
        locale: "sv",
        recipient: "someone@example.test",
      },
      env.AUTH_BASE_URL,
    );
    expect(shopSenderName(reset)).toBeNull();
  });

  it("the consumer sends a refund notice From the shop, at the platform's address", async () => {
    const job = createOrderEmailJob({
      ...(await frame("audit:refund:consumer")),
      content: { amountMinor: 100, currency: "SEK", full: true, orderNumber: "A-2", recipientName: null, shopName: "Fjällboden", supportEmail: "hej@fjallboden.test" },
      kind: "refund_notice",
      recipient: "kund@example.test",
    });
    const config = readEmailDeliveryConfig(env);
    if (config === null) {
      throw new Error("the test env configures mail delivery");
    }
    const bodies: Record<string, unknown>[] = [];
    const targetEnv = {
      ...env,
      [RESEND_FETCH_OVERRIDE]: async (request: Request) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return Response.json({ id: "re_audit_1" });
      },
    } as unknown as Env;
    const acks: string[] = [];
    const batch = {
      ackAll() {
        throw new Error("never");
      },
      messages: [
        {
          ack() {
            acks.push("m1");
          },
          attempts: 1,
          body: job,
          id: "m1",
          retry() {
            throw new Error("not retried");
          },
          timestamp: new Date(),
        },
      ],
      queue: "chopshop-test-email",
      retryAll() {
        throw new Error("not retried");
      },
    } as unknown as MessageBatch<unknown>;
    await worker.queue(batch, targetEnv);

    expect(acks).toEqual(["m1"]);
    expect(bodies).toHaveLength(1);
    const address = /<([^>]+)>$/.exec(config.from)?.[1] ?? config.from;
    expect(bodies[0]?.from).toBe(`"Fjällboden" <${address}>`);
    expect(bodies[0]?.reply_to).toBe("hej@fjallboden.test");
  });
});

async function reservePending(forTenant: ObjectTenant, contentType = "image/png"): Promise<string> {
  const reserved = await reservePendingObject(env.DB, forTenant, { bucket: "private", contentType, kind: "print_file" }, NOW);
  if (reserved.status !== "ok") {
    throw new Error(`reserve failed: ${reserved.status}`);
  }
  return reserved.object.objectId;
}

async function reserveActive(forTenant: ObjectTenant, contentType = "image/png"): Promise<string> {
  const objectId = await reservePending(forTenant, contentType);
  const activated = await activateObject(env.DB, forTenant, objectId, { sha256: SHA, sizeBytes: 10 }, NOW);
  expect(activated.status).toBe("ok");
  return objectId;
}

async function auditRows(objectId: string): Promise<{ action: string; actor_user_id: string | null; metadata_json: string | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT action, actor_user_id, metadata_json FROM audit_events
     WHERE resource_type = 'stored_object' AND resource_id = ? ORDER BY created_at, rowid`,
  )
    .bind(objectId)
    .all<{ action: string; actor_user_id: string | null; metadata_json: string | null }>();
  return results;
}

async function rowState(objectId: string): Promise<{ immutable: number; status: string }> {
  const row = await env.DB.prepare(`SELECT status, immutable FROM stored_objects WHERE object_id = ?`)
    .bind(objectId)
    .first<{ immutable: number; status: string }>();
  if (row === null) {
    throw new Error("missing row");
  }
  return row;
}

describe("F06 — the committed transition is the authority", () => {
  it("of two activations racing on one pending object exactly one succeeds, and only it is audited", async () => {
    const objectId = await reservePending(tenant);
    const [a, b] = await Promise.all([
      activateObject(env.DB, tenant, objectId, { sha256: SHA, sizeBytes: 10 }, NOW + 1),
      activateObject(env.DB, tenant, objectId, { sha256: SHA, sizeBytes: 10 }, NOW + 2),
    ]);
    expect([a.status, b.status].sort()).toEqual(["conflict", "ok"]);
    expect((await auditRows(objectId)).map((row) => row.action)).toEqual(["object.reserve", "object.activate"]);
  });

  it("a delete racing a freeze: one wins, the other is a conflict, the row agrees with the winner", async () => {
    const objectId = await reserveActive(tenant);
    const [frozen, deleted] = await Promise.all([
      markObjectImmutable(env.DB, tenant, objectId, NOW + 1),
      deletePendingOrMutableObject(env.DB, tenant, objectId, NOW + 2),
    ]);
    expect([frozen.status, deleted.status].sort()).toEqual(["conflict", "ok"]);
    const row = await rowState(objectId);
    const actions = (await auditRows(objectId)).map((r) => r.action);
    if (frozen.status === "ok") {
      expect(row).toEqual({ immutable: 1, status: "active" });
      expect(actions).toEqual(["object.reserve", "object.activate", "object.freeze"]);
    } else {
      expect(row).toEqual({ immutable: 0, status: "deleted" });
      expect(actions).toEqual(["object.reserve", "object.activate", "object.delete"]);
    }
  });

  it("a second delete of a tombstoned object is a conflict with no second audit row", async () => {
    const objectId = await reserveActive(tenant);
    await expect(deletePendingOrMutableObject(env.DB, tenant, objectId, NOW + 1)).resolves.toMatchObject({ status: "ok" });
    await expect(deletePendingOrMutableObject(env.DB, tenant, objectId, NOW + 2)).resolves.toEqual({ status: "conflict" });
    expect((await auditRows(objectId)).filter((r) => r.action === "object.delete")).toHaveLength(1);
  });
});

describe("F07 — the audit row names the actor and the grant", () => {
  it("a member admin's transitions carry the user id and no grant", async () => {
    const acting: ObjectTenant = { ...tenant, actor: { actingAsGrantId: null, userId: "user-member-1" } };
    const objectId = await reserveActive(acting);
    await deletePendingOrMutableObject(env.DB, acting, objectId, NOW + 1);
    const rows = await auditRows(objectId);
    expect(rows.map((r) => r.action)).toEqual(["object.reserve", "object.activate", "object.delete"]);
    for (const row of rows) {
      expect(row.actor_user_id).toBe("user-member-1");
      expect(JSON.parse(row.metadata_json ?? "{}")).toEqual({ kind: "print_file" });
    }
  });

  it("a platform user acting as the shop is recorded with the grant", async () => {
    const acting: ObjectTenant = { ...tenant, actor: { actingAsGrantId: "grant-77", userId: "user-platform-1" } };
    const objectId = await reserveActive(acting);
    const rows = await auditRows(objectId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actor_user_id).toBe("user-platform-1");
      expect(JSON.parse(row.metadata_json ?? "{}")).toEqual({ actingAsGrantId: "grant-77", kind: "print_file" });
    }
  });

  it("a transition without a person leaves the actor column null, as before", async () => {
    const objectId = await reservePending(tenant);
    expect((await auditRows(objectId))[0]?.actor_user_id).toBeNull();
  });
});

describe("F19 — a private non-raster is a download, and every delivery is sandboxed", () => {
  const principal: TenantAdminPrincipal = { accountType: "tenant_admin", role: "admin", tenantId: TENANT, userId: "user-member-1" };

  it("headers: rasters inline, everything else an attachment, all sandboxed", () => {
    expect(privateDeliveryHeaders("image/png", "a.png")).toEqual({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox",
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    });
    expect(privateDeliveryHeaders("text/html", "evil.html")["Content-Disposition"]).toBe('attachment; filename="evil.html"');
    expect(privateDeliveryHeaders("image/svg+xml", "logo.svg")["Content-Disposition"]).toBe('attachment; filename="logo.svg"');
    expect(privateDeliveryHeaders("application/pdf", 'a"b.pdf')["Content-Disposition"]).toBe('attachment; filename="a_b.pdf"');
  });

  it("the route delivers a declared HTML private object as an attachment", async () => {
    const objectId = await reserveActive(tenant, "text/html");
    const row = await env.DB.prepare(`SELECT object_key FROM stored_objects WHERE object_id = ?`).bind(objectId).first<{ object_key: string }>();
    await env.PRIVATE_BUCKET.put(row?.object_key ?? "", "<script>alert(1)</script>");

    const response = await deliverAdminObject(env, env.DB, principal, objectId);
    expect(response).not.toBeNull();
    expect(response?.headers.get("Content-Type")).toBe("text/html");
    // "object" is the store's fallback file name (none was given at reservation).
    expect(response?.headers.get("Content-Disposition")).toBe('attachment; filename="object"');
    expect(response?.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response?.text()).resolves.toBe("<script>alert(1)</script>");
  });

  it("the route delivers a raster inline, sandboxed", async () => {
    const objectId = await reserveActive(tenant);
    const row = await env.DB.prepare(`SELECT object_key FROM stored_objects WHERE object_id = ?`).bind(objectId).first<{ object_key: string }>();
    await env.PRIVATE_BUCKET.put(row?.object_key ?? "", "png-bytes");

    const response = await deliverAdminObject(env, env.DB, principal, objectId);
    expect(response?.headers.get("Content-Disposition")).toBeNull();
    expect(response?.headers.get("Content-Security-Policy")).toBe("sandbox");
  });
});
