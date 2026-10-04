import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { seedOrder, seedTenant } from "./dispatch-fixtures";

/**
 * CP6-PS2 — 0053 `print_canvas_jobs`: one test per CHECK and per trigger.
 * Every refusal is tried on an otherwise valid row, so the named constraint is
 * the only one that can fire.
 */

const TENANT = "canvas-mig";
const OTHER_TENANT = "canvas-mig-other";
const T0 = "2026-10-04T10:00:00.000Z";
const T1 = "2026-10-04T10:05:00.000Z";
const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TOKEN_HASH = "c".repeat(64);

let orderId = "";
let otherOrderId = "";

type Row = Record<string, unknown>;

function validRow(overrides: Row = {}): Row {
  const base: Row = {
    attempt: 0,
    canvas_bytes: null,
    canvas_key: `pod/${TENANT}/print/orders/${orderId}/1-front.png`,
    canvas_sha256: null,
    completed_at: null,
    created_at: T0,
    error: null,
    id: crypto.randomUUID(),
    input_bytes: 1234,
    input_key: `pod/${TENANT}/print/art-1.png`,
    input_sha256: SHA,
    lease_token_hash: null,
    lease_until: null,
    line_no: 1,
    order_id: orderId,
    output_prefix: `pod/${TENANT}/render/canvas/${orderId}/1/front/`,
    slot: "front",
    spec_json: "{}",
    state: "queued",
    tenant_id: TENANT,
    updated_at: T0,
  };
  return { ...base, ...overrides };
}

/** A row for (line, slot) with its keys derived, as the Worker writes them. */
function rowFor(lineNo: number, slot: string, overrides: Row = {}): Row {
  return validRow({
    canvas_key: `pod/${TENANT}/print/orders/${orderId}/${lineNo}-${slot}.png`,
    line_no: lineNo,
    output_prefix: `pod/${TENANT}/render/canvas/${orderId}/${lineNo}/${slot}/`,
    slot,
    ...overrides,
  });
}

function insert(row: Row, verb = "INSERT") {
  const columns = Object.keys(row);
  return env.DB.prepare(
    `${verb} INTO print_canvas_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  )
    .bind(...columns.map((column) => row[column]))
    .run();
}

async function count(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM print_canvas_jobs").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await seedTenant(TENANT);
  await seedTenant(OTHER_TENANT);
  // Lines 1..3 exist; each test that inserts takes its own (line, slot).
  orderId = (await seedOrder(TENANT, { lines: [{}, {}, {}, {}, {}, {}] })).orderId;
  otherOrderId = (await seedOrder(OTHER_TENANT)).orderId;
});

describe("print_canvas_jobs CHECKs (0053)", () => {
  const refusals: Array<[string, (lineNo: number) => Row]> = [
    ["id not a uuid", (n) => rowFor(n, "front", { id: "x".repeat(36) })],
    ["id too short", (n) => rowFor(n, "front", { id: "abc" })],
    ["slot other than front/back", (n) => rowFor(n, "pocket")],
    
    ["attempt 4", (n) => rowFor(n, "front", { attempt: 4, error: "x", state: "failed" })],
    ["unknown state", (n) => rowFor(n, "front", { state: "promoting" })],
    ["lease token hash not hex", (n) =>
      rowFor(n, "front", { attempt: 1, lease_token_hash: "Z".repeat(64), lease_until: T1, state: "leased" })],
    ["lease_until not ISO", (n) =>
      rowFor(n, "front", { attempt: 1, lease_token_hash: TOKEN_HASH, lease_until: "2026-10-04 10:00", state: "leased" })],
    ["input outside the tenant's print path", (n) => rowFor(n, "front", { input_key: `pod/${OTHER_TENANT}/print/a.png` })],
    ["input under preview/", (n) => rowFor(n, "front", { input_key: `pod/${TENANT}/preview/a.webp` })],
    ["input sha256 not hex", (n) => rowFor(n, "front", { input_sha256: "A".repeat(64) })],
    ["input_bytes 0", (n) => rowFor(n, "front", { input_bytes: 0 })],
    ["spec not an object", (n) => rowFor(n, "front", { spec_json: "[]" })],
    ["spec not JSON", (n) => rowFor(n, "front", { spec_json: "{" })],
    ["output prefix of another line", (n) =>
      rowFor(n, "front", { output_prefix: `pod/${TENANT}/render/canvas/${orderId}/${n + 1}/front/` })],
    ["canvas key of another slot", (n) =>
      rowFor(n, "front", { canvas_key: `pod/${TENANT}/print/orders/${orderId}/${n}-back.png` })],
    ["canvas sha256 not hex", (n) =>
      rowFor(n, "front", { attempt: 1, canvas_bytes: 9, canvas_sha256: "g".repeat(64), completed_at: T1, state: "completed", updated_at: T1 })],
    ["canvas_bytes 0", (n) =>
      rowFor(n, "front", { attempt: 1, canvas_bytes: 0, canvas_sha256: SHA_B, completed_at: T1, state: "completed", updated_at: T1 })],
    ["error with a space", (n) => rowFor(n, "front", { attempt: 3, error: "bad code", state: "failed" })],
    ["created_at not ISO", (n) => rowFor(n, "front", { created_at: "yesterday" })],
    ["updated_at before created_at", (n) => rowFor(n, "front", { created_at: T1, updated_at: T0 })],
    ["queued with a lease", (n) => rowFor(n, "front", { lease_token_hash: TOKEN_HASH, lease_until: T1 })],
    ["queued on attempt 3", (n) => rowFor(n, "front", { attempt: 3 })],
    ["leased without a token", (n) => rowFor(n, "front", { attempt: 1, lease_until: T1, state: "leased" })],
    ["leased on attempt 0", (n) =>
      rowFor(n, "front", { lease_token_hash: TOKEN_HASH, lease_until: T1, state: "leased" })],
    ["completed without completed_at", (n) =>
      rowFor(n, "front", { attempt: 1, canvas_bytes: 9, canvas_sha256: SHA_B, state: "completed" })],
    ["completed_at on a queued row", (n) => rowFor(n, "front", { completed_at: T1, updated_at: T1 })],
    ["completed without its sha256", (n) =>
      rowFor(n, "front", { attempt: 1, canvas_bytes: 9, completed_at: T1, state: "completed", updated_at: T1 })],
    ["a canvas recorded on a queued row", (n) => rowFor(n, "front", { canvas_bytes: 9, canvas_sha256: SHA_B })],
    ["completed on attempt 0", (n) =>
      rowFor(n, "front", { canvas_bytes: 9, canvas_sha256: SHA_B, completed_at: T1, state: "completed", updated_at: T1 })],
    ["failed without an error", (n) => rowFor(n, "front", { attempt: 3, state: "failed" })],
  ];

  for (const [name, build] of refusals) {
    it(`refuses ${name}`, async () => {
      await expect(insert(build(1))).rejects.toThrow(/CHECK constraint failed/);
      expect(await count()).toBe(0);
    });
  }

  it("refuses line_no 0 (the line trigger answers first: there is no item_index -1)", async () => {
    await expect(insert(rowFor(0, "front"))).rejects.toThrow(/CHECK constraint failed|names a line/);
    expect(await count()).toBe(0);
  });

  it("refuses an unknown tenant and an unknown order (foreign keys)", async () => {
    await expect(insert(rowFor(1, "front", { tenant_id: "no-such-tenant" }))).rejects.toThrow();
    await expect(
      insert(
        validRow({
          canvas_key: `pod/${TENANT}/print/orders/no-such-order/1-front.png`,
          order_id: "no-such-order",
          output_prefix: `pod/${TENANT}/render/canvas/no-such-order/1/front/`,
        }),
      ),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
  });

  it("takes a valid queued row", async () => {
    await insert(rowFor(1, "front"));
    expect(await count()).toBe(1);
  });
});

describe("print_canvas_jobs triggers (0053)", () => {
  it("line_exists: refuses another tenant's order and a line the order does not have", async () => {
    const before = await count();
    await expect(
      insert(
        validRow({
          canvas_key: `pod/${TENANT}/print/orders/${otherOrderId}/1-front.png`,
          order_id: otherOrderId,
          output_prefix: `pod/${TENANT}/render/canvas/${otherOrderId}/1/front/`,
        }),
      ),
    ).rejects.toThrow(/names a line of an order of its own tenant/);
    await expect(insert(rowFor(99, "front"))).rejects.toThrow(/names a line of an order of its own tenant/);
    expect(await count()).toBe(before);
  });

  it("insert_once: a second row for the same line and slot is a no-op, whatever its verb", async () => {
    const first = rowFor(2, "front");
    await insert(first);
    const before = await count();
    const second = rowFor(2, "front", { input_sha256: SHA_B });
    await insert(second);
    await insert(second, "INSERT OR IGNORE");
    await insert(second, "INSERT OR REPLACE");
    await env.DB.prepare(
      `INSERT INTO print_canvas_jobs (${Object.keys(second).join(", ")})
       VALUES (${Object.keys(second).map(() => "?").join(", ")})
       ON CONFLICT (tenant_id, order_id, line_no, slot) DO UPDATE SET input_sha256 = excluded.input_sha256`,
    )
      .bind(...Object.values(second))
      .run();
    // The same id under another slot is ignored too.
    await insert(rowFor(2, "back", { id: first.id }));
    expect(await count()).toBe(before);
    const stored = await env.DB.prepare(
      "SELECT id, input_sha256 FROM print_canvas_jobs WHERE order_id = ? AND line_no = 2",
    )
      .bind(orderId)
      .all();
    expect(stored.results).toEqual([{ id: first.id, input_sha256: SHA }]);
  });

  it("identity_immutable: refuses a change of every identity column", async () => {
    const row = rowFor(3, "front");
    await insert(row);
    const changes: Array<[string, unknown]> = [
      ["id", crypto.randomUUID()],
      ["tenant_id", OTHER_TENANT],
      ["order_id", otherOrderId],
      ["line_no", 4],
      ["slot", "back"],
      ["input_key", `pod/${TENANT}/print/other.png`],
      ["input_sha256", SHA_B],
      ["input_bytes", 99],
      ["spec_json", '{"x":1}'],
      ["output_prefix", `pod/${TENANT}/render/canvas/${orderId}/3/back/`],
      ["canvas_key", `pod/${TENANT}/print/orders/${orderId}/3-back.png`],
      ["created_at", "2026-10-04T09:00:00.000Z"],
    ];
    for (const [column, value] of changes) {
      await expect(
        env.DB.prepare(`UPDATE print_canvas_jobs SET ${column} = ? WHERE id = ?`).bind(value, row.id).run(),
      ).rejects.toThrow(/identity is immutable/);
    }
    // The lease columns move freely while the row is open.
    await env.DB.prepare(
      `UPDATE print_canvas_jobs SET state = 'leased', attempt = 1, lease_token_hash = ?,
         lease_until = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(TOKEN_HASH, T1, T1, row.id)
      .run();
  });

  it("settled_final: a completed row and a failed row never change again", async () => {
    const done = rowFor(4, "front", {
      attempt: 1,
      canvas_bytes: 10,
      canvas_sha256: SHA_B,
      completed_at: T1,
      state: "completed",
      updated_at: T1,
    });
    const failed = rowFor(4, "back", { attempt: 3, error: "pipeline_crashed", state: "failed" });
    await insert(done);
    await insert(failed);
    for (const id of [done.id, failed.id]) {
      await expect(
        env.DB.prepare("UPDATE print_canvas_jobs SET updated_at = ? WHERE id = ?")
          .bind("2026-10-04T11:00:00.000Z", id)
          .run(),
      ).rejects.toThrow(/a settled canvas job is final/);
    }
    await expect(
      env.DB.prepare(
        `UPDATE print_canvas_jobs SET state = 'queued', attempt = 0, error = NULL WHERE id = ?`,
      )
        .bind(failed.id)
        .run(),
    ).rejects.toThrow(/a settled canvas job is final/);
  });

  it("never_deleted: no row is ever deleted", async () => {
    const row = rowFor(5, "front");
    await insert(row);
    await expect(
      env.DB.prepare("DELETE FROM print_canvas_jobs WHERE id = ?").bind(row.id).run(),
    ).rejects.toThrow(/never deleted/);
  });
});
