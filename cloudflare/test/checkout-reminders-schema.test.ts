import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { REMINDER_CAP_MS } from "../src/commerce/checkout-reminders";
import {
  catalogVersionOf,
  count,
  DAY_MS,
  refusal,
  seedCheckout,
  seedReminderShop,
} from "./reminder-fixtures";

/**
 * Migration 0056 on the D1 test instance (CP9-AC build step 1): every trigger
 * refuses its case and lets the legal cases through; the ledger admits the
 * new kind and keeps every row.
 */

const TENANT = "tenant-acs";
const OTHER = "tenant-acs-b";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const T0 = 1_790_000_000_000;

beforeAll(async () => {
  await seedReminderShop(TENANT, { seller: null });
  await seedReminderShop(OTHER, { seller: null });
});

function decision(row: {
  checkoutId: string;
  decidedAt?: number;
  hash?: string;
  reason?: string | null;
  state: string;
  tenantId?: string;
}): D1PreparedStatement {
  const decidedAt = row.decidedAt ?? T0;
  const queuedOrWithdrawn = row.state !== "skipped";
  return env.DB.prepare(
    `INSERT INTO checkout_reminders (
       reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
       decided_at, link_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    row.tenantId ?? TENANT,
    row.checkoutId,
    row.hash ?? HASH_A,
    row.state,
    row.reason === undefined ? (row.state === "queued" ? null : "no_consent") : row.reason,
    decidedAt,
    queuedOrWithdrawn ? decidedAt + 7 * DAY_MS : null,
    decidedAt,
    decidedAt,
  );
}

async function checkout(tenantId = TENANT): Promise<string> {
  return (await seedCheckout(tenantId, { createdAt: T0 - DAY_MS })).checkoutId;
}

describe("0056: one decision per checkout, of its own tenant", () => {
  it("accepts a queued and a skipped decision", async () => {
    await expect(decision({ checkoutId: await checkout(), hash: "1".repeat(64), state: "queued" }).run()).resolves.toBeDefined();
    await expect(decision({ checkoutId: await checkout(), state: "skipped" }).run()).resolves.toBeDefined();
  });

  it("refuses a decision whose tenant is not its checkout's", async () => {
    const foreign = await checkout(OTHER);
    expect(await refusal(decision({ checkoutId: foreign, state: "skipped" }))).toContain(
      "checkout reminder tenant must match its checkout",
    );
  });

  it("refuses a row born withdrawn", async () => {
    expect(await refusal(decision({ checkoutId: await checkout(), reason: "paid", state: "withdrawn" }))).toContain(
      "a checkout reminder is born queued or skipped",
    );
  });

  it("refuses a second decision for one checkout (UNIQUE)", async () => {
    const id = await checkout();
    await decision({ checkoutId: id, state: "skipped" }).run();
    expect(await refusal(decision({ checkoutId: id, hash: "2".repeat(64), state: "queued" }))).toMatch(
      /UNIQUE constraint failed: checkout_reminders\.checkout_id/,
    );
  });

  it("holds both CHECK pairs: queued ⇔ no reason, skipped ⇔ no link", async () => {
    expect(await refusal(decision({ checkoutId: await checkout(), reason: "paid", state: "queued" }))).toMatch(/CHECK/);
    expect(await refusal(decision({ checkoutId: await checkout(), reason: null, state: "skipped" }))).toMatch(/CHECK/);
    const skippedWithLink = env.DB.prepare(
      `INSERT INTO checkout_reminders (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
         decided_at, link_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'skipped', 'paid', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), TENANT, await checkout(), HASH_A, T0, T0 + DAY_MS, T0, T0);
    expect(await refusal(skippedWithLink)).toMatch(/CHECK/);
    const queuedWithoutLink = env.DB.prepare(
      `INSERT INTO checkout_reminders (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
         decided_at, link_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, ?)`,
    ).bind(crypto.randomUUID(), TENANT, await checkout(), "3".repeat(64), T0, T0, T0);
    expect(await refusal(queuedWithoutLink)).toMatch(/CHECK/);
    expect(await refusal(decision({ checkoutId: await checkout(), reason: "nonsense", state: "skipped" }))).toMatch(/CHECK/);
  });
});

describe("0056: the cap (AC6)", () => {
  it("refuses a second queued reminder for one shop and address within 7 days, admits one after", async () => {
    const hash = "c".repeat(64);
    await decision({ checkoutId: await checkout(), decidedAt: T0, hash, state: "queued" }).run();
    expect(
      await refusal(decision({ checkoutId: await checkout(), decidedAt: T0 + REMINDER_CAP_MS - 1, hash, state: "queued" })),
    ).toContain("checkout reminder frequency cap");
    await expect(
      decision({ checkoutId: await checkout(), decidedAt: T0 + REMINDER_CAP_MS + 1, hash, state: "queued" }).run(),
    ).resolves.toBeDefined();
  });

  it("counts neither a skipped nor a withdrawn row, nor another tenant's or another address's", async () => {
    const hash = "d".repeat(64);
    await decision({ checkoutId: await checkout(), hash, state: "skipped" }).run();
    // Born queued, then withdrawn by the mail effect.
    const withdrawnId = await checkout();
    await decision({ checkoutId: withdrawnId, hash, state: "queued" }).run();
    await env.DB.prepare(
      "UPDATE checkout_reminders SET state = 'withdrawn', reason = 'paid', updated_at = ? WHERE checkout_id = ?",
    )
      .bind(T0 + 1, withdrawnId)
      .run();
    await decision({ checkoutId: await checkout(OTHER), hash, state: "queued", tenantId: OTHER }).run();
    await decision({ checkoutId: await checkout(), hash: "e".repeat(64), state: "queued" }).run();
    await expect(decision({ checkoutId: await checkout(), decidedAt: T0 + 1, hash, state: "queued" }).run()).resolves.toBeDefined();
  });

  it("the trigger's literal is REMINDER_CAP_MS", async () => {
    const sql = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'checkout_reminders_cap'")
      .first<{ sql: string }>();
    expect(REMINDER_CAP_MS).toBe(7 * DAY_MS);
    expect(sql?.sql).toContain(`NEW.decided_at - ${REMINDER_CAP_MS}`);
  });
});

describe("0056: a decision only moves queued → withdrawn; nothing is deleted", () => {
  it("lets queued become withdrawn with a reason, and nothing else", async () => {
    const id = await checkout();
    await decision({ checkoutId: id, hash: "f".repeat(64), state: "queued" }).run();
    const move = (set: string, ...binds: unknown[]) =>
      env.DB.prepare(`UPDATE checkout_reminders SET ${set} WHERE checkout_id = ?`).bind(...binds, id);
    expect(await refusal(move("state = 'withdrawn', reason = NULL"))).toMatch(/only moves from queued to withdrawn|CHECK/);
    expect(await refusal(move("state = 'skipped', reason = 'paid', link_expires_at = NULL"))).toContain(
      "only moves from queued to withdrawn",
    );
    for (const [column, value] of [
      ["reminder_id", crypto.randomUUID()],
      ["tenant_id", OTHER],
      ["checkout_id", await checkout()],
      ["buyer_hash", "9".repeat(64)],
      ["decided_at", T0 + 5],
      ["link_expires_at", T0 + 8 * DAY_MS],
      ["created_at", T0 - 5],
    ] as const) {
      expect(await refusal(move(`state = 'withdrawn', reason = 'paid', ${column} = ?`, value)), column).toMatch(
        /only moves from queued to withdrawn|tenant_id is immutable/,
      );
    }
    await expect(move("state = 'withdrawn', reason = 'unsubscribed', updated_at = ?", T0 + 10).run()).resolves.toBeDefined();
    // Withdrawn is final.
    expect(await refusal(move("state = 'queued', reason = NULL"))).toContain("only moves from queued to withdrawn");
    expect(await refusal(move("reason = 'paid'"))).toContain("only moves from queued to withdrawn");
  });

  it("refuses a delete of a decision, a suppression and a setting", async () => {
    const id = await checkout();
    await decision({ checkoutId: id, state: "skipped" }).run();
    expect(await refusal(env.DB.prepare("DELETE FROM checkout_reminders WHERE checkout_id = ?").bind(id))).toContain(
      "checkout reminders are append-only",
    );
    await env.DB.prepare(
      "INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at) VALUES (?, ?, 'unsubscribe', ?)",
    )
      .bind(TENANT, HASH_B, T0)
      .run();
    expect(
      await refusal(env.DB.prepare("DELETE FROM checkout_reminder_suppressions WHERE tenant_id = ?").bind(TENANT)),
    ).toContain("checkout reminder suppressions are append-only");
    expect(
      await refusal(
        env.DB.prepare("UPDATE checkout_reminder_suppressions SET source = 'import' WHERE tenant_id = ?").bind(TENANT),
      ),
    ).toContain("checkout reminder suppressions are append-only");
    await env.DB.prepare(
      `INSERT INTO checkout_reminder_settings (tenant_id, enabled, delay_hours, enabled_at, updated_at, updated_by)
       VALUES (?, 0, 1, NULL, ?, 'fixture')`,
    )
      .bind(TENANT, T0)
      .run();
    expect(
      await refusal(env.DB.prepare("DELETE FROM checkout_reminder_settings WHERE tenant_id = ?").bind(TENANT)),
    ).toContain("switched off, never deleted");
  });
});

describe("0056: suppressions and settings", () => {
  it("keys a suppression on (tenant, address hash) and refuses a malformed one", async () => {
    const insert = (tenantId: string, hash: string, source = "unsubscribe") =>
      env.DB.prepare(
        "INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at) VALUES (?, ?, ?, ?)",
      ).bind(tenantId, hash, source, T0);
    const hash = "7".repeat(64);
    await insert(TENANT, hash).run();
    await expect(insert(OTHER, hash).run()).resolves.toBeDefined();
    expect(await refusal(insert(TENANT, hash))).toMatch(/UNIQUE|PRIMARY KEY/);
    expect(await refusal(insert(TENANT, "A".repeat(64)))).toMatch(/CHECK/);
    expect(await refusal(insert(TENANT, "7".repeat(63)))).toMatch(/CHECK/);
    expect(await refusal(insert(TENANT, "8".repeat(64), "admin"))).toMatch(/CHECK/);
  });

  it("refuses a switch turned on without enabled_at and a delay outside 1–24", async () => {
    const insert = (enabled: number, delay: number, enabledAt: number | null) =>
      env.DB.prepare(
        `INSERT INTO checkout_reminder_settings (tenant_id, enabled, delay_hours, enabled_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, 'fixture')`,
      ).bind(OTHER, enabled, delay, enabledAt, T0);
    expect(await refusal(insert(1, 1, null))).toMatch(/CHECK/);
    expect(await refusal(insert(0, 0, null))).toMatch(/CHECK/);
    expect(await refusal(insert(0, 25, null))).toMatch(/CHECK/);
    expect(await refusal(insert(2, 1, T0))).toMatch(/CHECK/);
  });

  it("bumps the shop's catalog_version on the switch's insert and update", async () => {
    const shop = "tenant-acs-version";
    await seedReminderShop(shop, { seller: null });
    const before = await catalogVersionOf(shop);
    await env.DB.prepare(
      `INSERT INTO checkout_reminder_settings (tenant_id, enabled, delay_hours, enabled_at, updated_at, updated_by)
       VALUES (?, 1, 1, ?, ?, 'fixture')`,
    )
      .bind(shop, T0, T0)
      .run();
    const inserted = await catalogVersionOf(shop);
    expect(inserted).toBe(before + 1);
    await env.DB.prepare("UPDATE checkout_reminder_settings SET enabled = 0 WHERE tenant_id = ?").bind(shop).run();
    expect(await catalogVersionOf(shop)).toBe(inserted + 1);
    expect(
      await refusal(env.DB.prepare("UPDATE checkout_reminder_settings SET tenant_id = ? WHERE tenant_id = ?").bind(TENANT, shop)),
    ).toContain("tenant_id is immutable");
  });
});

describe("0056: the ledger admits checkout_reminder and keeps every row (a staged rebuild)", () => {
  it("rebuilds 0050's email_deliveries with rows of every kind in it, reads every row back unchanged", async () => {
    const migrations = env.TEST_MIGRATIONS;
    const m0050 = migrations.find((m) => m.name === "0050_email_kinds.sql");
    const m0056 = migrations.find((m) => m.name === "0056_checkout_reminders.sql");
    expect(m0050).toBeDefined();
    expect(m0056).toBeDefined();
    // Nothing between 0050 and 0056 touches the table, so 0050's rebuild IS
    // the shape 0056 meets on a deployed database.
    for (const m of migrations.filter((m) => m.name > "0051" && m.name < "0056")) {
      expect(m.queries.some((q) => q.includes("email_deliveries")), m.name).toBe(false);
    }
    const exec = (queries: string[]) => env.DB.batch(queries.map((q) => env.DB.prepare(q)));

    // 1. Back to the 0050 shape (its own statements; rows carried).
    await exec(m0050!.queries.filter((q) => q.includes("email_deliveries")));
    const insert = (row: Record<string, unknown>) =>
      env.DB.prepare(
        `INSERT INTO email_deliveries (delivery_id, tenant_id, kind, recipient_hash, status, attempts,
           max_attempts, next_attempt_at, lease_token, lease_until, provider_message_id, expires_at,
           last_error_code, resolved_at, created_at, updated_at, job_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, 8, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          row.delivery_id,
          row.tenant_id,
          row.kind,
          "a".repeat(64),
          row.status,
          row.attempts,
          100,
          row.lease_token ?? null,
          row.lease_until ?? null,
          row.provider_message_id ?? null,
          10_000,
          row.last_error_code ?? null,
          row.resolved_at ?? null,
          50,
          60,
          "b".repeat(64),
        )
        .run();
    // The old shape refuses the new kind: this really is the 0050 table.
    await expect(
      insert({ attempts: 0, delivery_id: crypto.randomUUID(), kind: "checkout_reminder", status: "pending", tenant_id: TENANT }),
    ).rejects.toThrow(/CHECK/);

    const rows = [
      { attempts: 0, kind: "email_verification", status: "pending", tenant_id: TENANT },
      { attempts: 1, kind: "password_reset", lease_token: "lease-1", lease_until: 200, status: "processing", tenant_id: null },
      { attempts: 1, kind: "order_confirmation", provider_message_id: `re_${crypto.randomUUID()}`, resolved_at: 70, status: "sent", tenant_id: TENANT },
      { attempts: 8, kind: "alert_digest", last_error_code: "E_PROVIDER_500", resolved_at: 80, status: "failed", tenant_id: null },
      { attempts: 2, kind: "withdrawal_receipt", resolved_at: 90, status: "expired", tenant_id: OTHER },
      { attempts: 0, kind: "withdrawal_notice", status: "pending", tenant_id: OTHER },
      { attempts: 0, kind: "order_status_update", status: "pending", tenant_id: TENANT },
      { attempts: 1, kind: "order_notice_shop", provider_message_id: `re_${crypto.randomUUID()}`, resolved_at: 75, status: "sent", tenant_id: TENANT },
      { attempts: 0, kind: "refund_notice", status: "pending", tenant_id: OTHER },
    ].map((row) => ({ ...row, delivery_id: crypto.randomUUID() }));
    for (const row of rows) {
      await insert(row);
    }
    const ids = rows.map((row) => row.delivery_id);
    const read = () =>
      env.DB.prepare(
        `SELECT * FROM email_deliveries WHERE delivery_id IN (${ids.map(() => "?").join(", ")}) ORDER BY delivery_id`,
      )
        .bind(...ids)
        .all();
    const before = (await read()).results;
    const totalBefore = await count("SELECT COUNT(*) AS n FROM email_deliveries");
    expect(before).toHaveLength(9);

    // 2. The email_deliveries part of 0056, as wrangler applies it.
    await exec(m0056!.queries.filter((q) => q.includes("email_deliveries")));

    expect((await read()).results).toEqual(before);
    expect(await count("SELECT COUNT(*) AS n FROM email_deliveries")).toBe(totalBefore);
    await expect(
      insert({ attempts: 0, delivery_id: crypto.randomUUID(), kind: "checkout_reminder", status: "pending", tenant_id: TENANT }),
    ).resolves.toBeDefined();
    await expect(
      insert({ attempts: 0, delivery_id: crypto.randomUUID(), kind: "newsletter", status: "pending", tenant_id: TENANT }),
    ).rejects.toThrow(/CHECK/);
    // Triggers and indexes, re-declared.
    const objects = await env.DB.prepare(
      "SELECT type, name FROM sqlite_master WHERE tbl_name = 'email_deliveries' AND type IN ('trigger', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string; type: string }>();
    expect(objects.results.map((o) => o.name)).toEqual([
      "email_deliveries_due_idx",
      "email_deliveries_fingerprint_required",
      "email_deliveries_lease_idx",
      "email_deliveries_tenant_created_idx",
      "email_deliveries_tenant_immutable",
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'email_deliveries_migration_%'")).toBe(0);
  });
});
