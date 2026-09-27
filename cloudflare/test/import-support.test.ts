import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * CP3-B — the import bookkeeping tables (0033). The import scripts write them
 * through SQL; these tests pin the contract they code against: legacy_id_map is
 * append-only (REPLACE included), a finished import_runs row never changes, and
 * import_row_hashes skips the same content and aborts on different content.
 */

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:05:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function run(sql: string, ...binds: unknown[]) {
  return env.DB.prepare(sql).bind(...binds).run();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ total: number }>();
  return row?.total ?? 0;
}

function mapInsert(
  verb: string,
  legacyId: string,
  newId: string,
  options: { createdAt?: string; env?: string; kind?: string } = {},
) {
  return run(
    `${verb} INTO legacy_id_map (kind, legacy_id, new_id, env, created_at) VALUES (?, ?, ?, ?, ?)`,
    options.kind ?? "user",
    legacyId,
    newId,
    options.env ?? "staging",
    options.createdAt ?? T0,
  );
}

async function mapRows() {
  const rows = await env.DB.prepare(
    "SELECT kind, legacy_id, new_id, env, created_at FROM legacy_id_map ORDER BY legacy_id",
  ).all();
  return rows.results;
}

function startRun(runId: string, options: { env?: string; status?: string; verb?: string } = {}) {
  return run(
    `${options.verb ?? "INSERT"} INTO import_runs (run_id, env, bundle_sha, plan_sha, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    runId,
    options.env ?? "staging",
    SHA_A,
    SHA_B,
    T0,
    options.status ?? "running",
  );
}

function finishRun(runId: string, status: "completed" | "failed") {
  return run(
    `UPDATE import_runs SET status = ?, finished_at = ?, counts_json = ? WHERE run_id = ?`,
    status,
    T1,
    JSON.stringify({ users: 3 }),
    runId,
  );
}

function hashInsert(verb: string, rowPk: string, sha: string, runId: string) {
  return run(
    `${verb} INTO import_row_hashes (table_name, row_pk, content_sha, run_id) VALUES ('tenants', ?, ?, ?)`,
    rowPk,
    sha,
    runId,
  );
}

describe("legacy_id_map", () => {
  it("stores a mapping and refuses to change or remove it", async () => {
    await mapInsert("INSERT", "firebase-uid-1", "new-user-1");
    const before = await mapRows();

    for (const statement of [
      "UPDATE legacy_id_map SET new_id = 'other' WHERE legacy_id = 'firebase-uid-1'",
      "UPDATE legacy_id_map SET env = 'production' WHERE legacy_id = 'firebase-uid-1'",
      `UPDATE legacy_id_map SET created_at = '${T1}' WHERE legacy_id = 'firebase-uid-1'`,
      "DELETE FROM legacy_id_map WHERE legacy_id = 'firebase-uid-1'",
      "DELETE FROM legacy_id_map",
    ]) {
      await expect(run(statement), statement).rejects.toThrow(/append-only/);
    }

    await expect(mapRows()).resolves.toEqual(before);
  });

  it("cannot be rewritten through INSERT OR REPLACE", async () => {
    await mapInsert("INSERT", "firebase-uid-2", "new-user-2");
    const before = await mapRows();

    // A different new id for the same legacy id.
    await expect(mapInsert("INSERT OR REPLACE", "firebase-uid-2", "hijacked")).rejects.toThrow(
      /append-only/,
    );
    // A second legacy id claiming an already-taken new id (the unique index
    // would otherwise let REPLACE delete the first mapping silently).
    await expect(mapInsert("INSERT OR REPLACE", "firebase-uid-9", "new-user-2")).rejects.toThrow(
      /append-only/,
    );
    await expect(mapInsert("INSERT", "firebase-uid-9", "new-user-2")).rejects.toThrow(
      /append-only|UNIQUE/,
    );

    await expect(mapRows()).resolves.toEqual(before);
  });

  it("treats an identical re-insert as a no-op under OR IGNORE, and anything else as a failure", async () => {
    await mapInsert("INSERT", "firebase-uid-3", "new-user-3");

    await mapInsert("INSERT OR IGNORE", "firebase-uid-3", "new-user-3");
    expect(await count("SELECT COUNT(*) AS total FROM legacy_id_map WHERE legacy_id = 'firebase-uid-3'")).toBe(1);

    // Never silently ignored: a remap attempt is loud even under OR IGNORE.
    await expect(
      mapInsert("INSERT OR IGNORE", "firebase-uid-3", "new-user-other"),
    ).rejects.toThrow(/append-only/);
    await expect(
      mapInsert("INSERT OR IGNORE", "firebase-uid-3", "new-user-3", { createdAt: T1 }),
    ).rejects.toThrow(/append-only/);
    // A plain duplicate insert is a key violation.
    await expect(mapInsert("INSERT", "firebase-uid-3", "new-user-3")).rejects.toThrow(/UNIQUE/);
  });

  it.each([
    ["an unknown kind", { kind: "printer" }],
    ["an unknown env", { env: "dev" }],
    ["a non-ISO time", { createdAt: "2026-09-27 10:00:00" }],
  ])("refuses %s", async (_label, options) => {
    await expect(mapInsert("INSERT", `firebase-${_label}`, `new-${_label}`, options)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe("import_runs", () => {
  // First, while no run exists, so no insert trigger fires ahead of the CHECK.
  it("refuses a malformed sha", async () => {
    await expect(
      run(
        `INSERT INTO import_runs (run_id, env, bundle_sha, plan_sha, started_at, status)
         VALUES ('run-bad-sha', 'staging', ?, ?, ?, 'running')`,
        SHA_A.toUpperCase(),
        SHA_B,
        T0,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("lets a running run finish once, and never changes a finished run", async () => {
    await startRun("run-complete");
    await finishRun("run-complete", "completed");

    await startRun("run-failed");
    await finishRun("run-failed", "failed");

    for (const runId of ["run-complete", "run-failed"]) {
      for (const statement of [
        `UPDATE import_runs SET status = 'running', finished_at = NULL WHERE run_id = '${runId}'`,
        `UPDATE import_runs SET counts_json = '{"users":4}' WHERE run_id = '${runId}'`,
        `UPDATE import_runs SET finished_at = '2026-09-27T11:00:00.000Z' WHERE run_id = '${runId}'`,
        `UPDATE import_runs SET status = 'completed' WHERE run_id = '${runId}'`,
      ]) {
        await expect(run(statement), statement).rejects.toThrow(/immutable/);
      }
      await expect(run(`DELETE FROM import_runs WHERE run_id = '${runId}'`)).rejects.toThrow(
        /append-only/,
      );
    }

    const rows = await env.DB.prepare(
      "SELECT run_id, status, finished_at, counts_json FROM import_runs ORDER BY run_id",
    ).all();
    expect(rows.results).toEqual([
      { counts_json: '{"users":3}', finished_at: T1, run_id: "run-complete", status: "completed" },
      { counts_json: '{"users":3}', finished_at: T1, run_id: "run-failed", status: "failed" },
    ]);
  });

  it("starts running, one at a time, and a run id is never reused", async () => {
    await expect(startRun("run-born-done", { status: "completed" })).rejects.toThrow(
      /starts running/,
    );

    await startRun("run-a");
    await expect(startRun("run-b")).rejects.toThrow(/starts running|UNIQUE/);
    await expect(startRun("run-b", { verb: "INSERT OR REPLACE" })).rejects.toThrow(
      /starts running/,
    );
    await expect(startRun("run-a", { verb: "INSERT OR REPLACE" })).rejects.toThrow(
      /starts running/,
    );
    // Another environment may run beside it.
    await startRun("run-prod-1", { env: "production" });

    // While running, the run's identity is frozen.
    await expect(
      run(`UPDATE import_runs SET bundle_sha = '${SHA_C}' WHERE run_id = 'run-a'`),
    ).rejects.toThrow(/identity is immutable/);

    // A crashed run is closed as failed, and the next one may start.
    await finishRun("run-a", "failed");
    await startRun("run-b");
    await finishRun("run-b", "completed");
  });

  it("imports production once", async () => {
    await finishRun("run-prod-1", "completed");
    await expect(startRun("run-prod-2", { env: "production" })).rejects.toThrow(/starts running/);
    await expect(startRun("run-prod-2", { env: "production", verb: "INSERT OR REPLACE" })).rejects.toThrow(
      /starts running/,
    );
  });

  it.each([
    ["a finish time on a running run", `UPDATE import_runs SET finished_at = '${T1}' WHERE run_id = 'run-check'`],
    ["a finished run without a finish time", "UPDATE import_runs SET status = 'completed' WHERE run_id = 'run-check'"],
    ["counts that are not an object", `UPDATE import_runs SET counts_json = '[1]' WHERE run_id = 'run-check'`],
  ])("refuses %s", async (_label, statement) => {
    if ((await count("SELECT COUNT(*) AS total FROM import_runs WHERE run_id = 'run-check'")) === 0) {
      await startRun("run-check");
    }
    await expect(run(statement)).rejects.toThrow(/CHECK constraint failed/);
  });

});

describe("import_row_hashes", () => {
  it("skips the same content, aborts on different content, and never changes", async () => {
    // run-check is still running (the import_runs suite left it open).
    await hashInsert("INSERT", "shop-one", SHA_A, "run-check");

    // Same id, same hash: skipped, and the first run keeps the record.
    await hashInsert("INSERT OR IGNORE", "shop-one", SHA_A, "run-check");
    expect(
      await count("SELECT COUNT(*) AS total FROM import_row_hashes WHERE row_pk = 'shop-one'"),
    ).toBe(1);

    // Same id, different hash: aborts, whatever the conflict clause.
    for (const verb of ["INSERT", "INSERT OR IGNORE", "INSERT OR REPLACE"]) {
      await expect(hashInsert(verb, "shop-one", SHA_B, "run-check"), verb).rejects.toThrow(
        /hash mismatch/,
      );
    }

    await expect(
      run(`UPDATE import_row_hashes SET content_sha = '${SHA_B}' WHERE row_pk = 'shop-one'`),
    ).rejects.toThrow(/append-only/);
    await expect(run("DELETE FROM import_row_hashes WHERE row_pk = 'shop-one'")).rejects.toThrow(
      /append-only/,
    );

    await expect(
      env.DB.prepare(
        "SELECT content_sha, run_id FROM import_row_hashes WHERE row_pk = 'shop-one'",
      ).first(),
    ).resolves.toEqual({ content_sha: SHA_A, run_id: "run-check" });
  });

  it("lets a later run skip rows an earlier run recorded", async () => {
    await finishRun("run-check", "completed");
    await startRun("run-later");

    await hashInsert("INSERT OR IGNORE", "shop-one", SHA_A, "run-later");
    await expect(
      env.DB.prepare("SELECT run_id FROM import_row_hashes WHERE row_pk = 'shop-one'").first(),
    ).resolves.toEqual({ run_id: "run-check" });

    // Codex P2 on CP3-B: the same content under ANY conflict clause leaves the
    // first run's record alone. INSERT OR REPLACE would otherwise delete the
    // row without firing the delete trigger and rewrite who imported it first.
    for (const verb of ["INSERT OR REPLACE", "INSERT"]) {
      await hashInsert(verb, "shop-one", SHA_A, "run-later");
      await expect(
        env.DB.prepare(
          "SELECT content_sha, run_id FROM import_row_hashes WHERE row_pk = 'shop-one'",
        ).first(),
        verb,
      ).resolves.toEqual({ content_sha: SHA_A, run_id: "run-check" });
    }
    expect(
      await count("SELECT COUNT(*) AS total FROM import_row_hashes WHERE row_pk = 'shop-one'"),
    ).toBe(1);

    await expect(hashInsert("INSERT OR IGNORE", "shop-one", SHA_C, "run-later")).rejects.toThrow(
      /hash mismatch/,
    );
    await hashInsert("INSERT", "shop-two", SHA_C, "run-later");
    await finishRun("run-later", "completed");
  });

  it("records hashes only under a running run", async () => {
    await expect(hashInsert("INSERT", "shop-three", SHA_A, "run-later")).rejects.toThrow(
      /running import run/,
    );
    await expect(hashInsert("INSERT", "shop-three", SHA_A, "no-such-run")).rejects.toThrow(
      /running import run|FOREIGN KEY/,
    );
    expect(
      await count("SELECT COUNT(*) AS total FROM import_row_hashes WHERE row_pk = 'shop-three'"),
    ).toBe(0);
  });
});
