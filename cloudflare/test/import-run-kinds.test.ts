import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * CP7-T1 — 0052: one completed production import run PER KIND (platform, the
 * CP3 plan; catalogue, the catalogue plan), still one run in flight at a time,
 * the catalogue only after the platform import of the same export, and the
 * kind frozen with the rest of a run's identity. The rows of a file stay for
 * the next test, so the tests below run in order, as an import would.
 *
 * The P2/P7 guard (no run once production holds an order) is proven on
 * node:sqlite in scripts/cf-port/migrate/test/import-run-kinds.test.mjs: its
 * tables are append-only, so one file's database cannot first hold an order
 * and then hold none.
 */

const T0 = "2026-10-04T10:00:00.000Z";
const T1 = "2026-10-04T10:05:00.000Z";
const EXPORT_A = "a".repeat(64);
const EXPORT_B = "b".repeat(64);
const PLAN = "c".repeat(64);

function startRun(
  runId: string,
  options: { bundle?: string; env?: string; kind?: string; verb?: string } = {},
) {
  const withKind = options.kind !== undefined;
  return env.DB.prepare(
    `${options.verb ?? "INSERT"} INTO import_runs (run_id, env, ${withKind ? "kind, " : ""}bundle_sha, plan_sha, started_at, status)
     VALUES (?, ?, ${withKind ? "?, " : ""}?, ?, ?, 'running')`,
  )
    .bind(
      runId,
      options.env ?? "production",
      ...(withKind ? [options.kind] : []),
      options.bundle ?? EXPORT_A,
      PLAN,
      T0,
    )
    .run();
}

function finishRun(runId: string, status: "completed" | "failed") {
  return env.DB.prepare(
    "UPDATE import_runs SET status = ?, finished_at = ?, counts_json = '{}' WHERE run_id = ?",
  )
    .bind(status, T1, runId)
    .run();
}

async function runs() {
  const rows = await env.DB.prepare(
    "SELECT run_id, env, kind, status FROM import_runs ORDER BY run_id",
  ).all();
  return rows.results;
}

describe("import_runs kinds (0052)", () => {
  it("starts from no run, and a run that names no kind is a platform run", async () => {
    await expect(runs()).resolves.toEqual([]);
    await startRun("staging-platform", { env: "staging" });
    await expect(runs()).resolves.toEqual([
      { env: "staging", kind: "platform", run_id: "staging-platform", status: "running" },
    ]);
  });

  it("refuses two runs in flight at once, of either kind", async () => {
    // staging-platform is running: a second staging run of another kind waits.
    await expect(startRun("staging-catalogue", { env: "staging", kind: "catalogue" })).rejects.toThrow(
      /starts running, once, one at a time/,
    );
    await finishRun("staging-platform", "completed");
    await startRun("staging-catalogue", { env: "staging", kind: "catalogue" });
    await finishRun("staging-catalogue", "completed");

    await startRun("prod-platform-1");
    await expect(startRun("prod-platform-2")).rejects.toThrow(/starts running, once, one at a time/);
    await expect(startRun("prod-catalogue-early", { kind: "catalogue" })).rejects.toThrow(
      /one at a time|after the platform import/,
    );
  });

  it("refuses a catalogue run before the platform run of its export has completed", async () => {
    // prod-platform-1 is still running: it does not count until it completes.
    await finishRun("prod-platform-1", "failed");
    await expect(startRun("prod-catalogue-first", { kind: "catalogue" })).rejects.toThrow(
      /the catalogue is imported after the platform import of the same export/,
    );
    await startRun("prod-platform-3");
    await finishRun("prod-platform-3", "completed");
    // A catalogue of another export than the one the platform import read.
    await expect(
      startRun("prod-catalogue-other-export", { bundle: EXPORT_B, kind: "catalogue" }),
    ).rejects.toThrow(/the catalogue is imported after the platform import of the same export/);
  });

  it("refuses a second completed platform run, REPLACE included", async () => {
    await expect(startRun("prod-platform-4")).rejects.toThrow(/starts running, once, one at a time/);
    await expect(startRun("prod-platform-4", { kind: "platform" })).rejects.toThrow(
      /starts running, once, one at a time/,
    );
    await expect(startRun("prod-platform-4", { verb: "INSERT OR REPLACE" })).rejects.toThrow(
      /starts running, once, one at a time/,
    );
  });

  it("allows the first catalogue run after the platform run, and freezes its kind", async () => {
    await startRun("prod-catalogue-1", { kind: "catalogue" });
    await expect(
      env.DB.prepare("UPDATE import_runs SET kind = 'platform' WHERE run_id = 'prod-catalogue-1'").run(),
    ).rejects.toThrow(/identity is immutable/);
    await finishRun("prod-catalogue-1", "completed");
    await expect(
      env.DB.prepare("UPDATE import_runs SET kind = 'platform' WHERE run_id = 'prod-catalogue-1'").run(),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses a second completed catalogue run, REPLACE included", async () => {
    await expect(startRun("prod-catalogue-2", { kind: "catalogue" })).rejects.toThrow(
      /starts running, once, one at a time/,
    );
    await expect(
      startRun("prod-catalogue-2", { kind: "catalogue", verb: "INSERT OR REPLACE" }),
    ).rejects.toThrow(/starts running, once, one at a time/);
    await expect(
      startRun("prod-catalogue-1", { kind: "catalogue", verb: "INSERT OR REPLACE" }),
    ).rejects.toThrow(/starts running, once, one at a time/);
  });

  it("refuses an unknown kind", async () => {
    await expect(startRun("prod-other", { kind: "pages" })).rejects.toThrow(/CHECK constraint failed/);
  });

  it("ends with one completed production run of each kind, and staging untouched by the kinds", async () => {
    await expect(runs()).resolves.toEqual([
      { env: "production", kind: "catalogue", run_id: "prod-catalogue-1", status: "completed" },
      { env: "production", kind: "platform", run_id: "prod-platform-1", status: "failed" },
      { env: "production", kind: "platform", run_id: "prod-platform-3", status: "completed" },
      { env: "staging", kind: "catalogue", run_id: "staging-catalogue", status: "completed" },
      { env: "staging", kind: "platform", run_id: "staging-platform", status: "completed" },
    ]);
    // Staging's once-rule is 0033's: none. A second staging catalogue run may start.
    await startRun("staging-catalogue-2", { env: "staging", kind: "catalogue" });
    await finishRun("staging-catalogue-2", "completed");
  });
});
