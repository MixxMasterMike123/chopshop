import { rescreenStaleScreenings } from "../catalog/screening";
import { raiseStuckOnboardingAlerts } from "../commerce/connect-onboarding";
import { runOutboxSweep } from "./sweeper";

/**
 * The `scheduled()` handler (src/index.ts): cron triggers are routed by
 * `controller.cron`, the exact expression wrangler.jsonc declares.
 *
 *   "*\/15 * * * *"  → runOutboxSweep (PLAN §2.2), THEN CP2-A's
 *                      runReconciliation and runRetentionSweep (§2.2, §2.3) —
 *                      same 15-minute cadence, so the 30-minute alert SLA holds
 *                      — THEN the CP3 steps (CP3_STEPS below), THEN the digest
 *   anything else    → logged and ignored (a cron this build does not know)
 *
 * Each step is isolated: one failing never skips the next. If any failed, the
 * handler rejects AFTER running them all, so the invocation shows as failed in
 * the Cron Events log.
 */

export const OUTBOX_SWEEP_CRON = "*/15 * * * *";

type CronStep = (env: Env, now: number) => Promise<unknown>;

interface CommerceCrons {
  replayDeferred?: CronStep;
  runReconciliation?: CronStep;
  runRetentionSweep?: CronStep;
  runAlertDigest?: CronStep;
}

/**
 * CP2-A's cron module (src/commerce/crons.ts), imported lazily and defensively:
 * a module that fails to load (or lacks a step) skips that step with a log
 * line, and never the outbox sweep before it.
 */
const importCommerceCrons = (): Promise<CommerceCrons | null> => import("../commerce/crons");

let commerceCronsLoader: () => Promise<CommerceCrons | null> = importCommerceCrons;

/** Test seam: replaces the loader; `null` restores the real module. */
export function setCommerceCronsLoader(
  loader: (() => Promise<CommerceCrons | null>) | null,
): void {
  commerceCronsLoader = loader ?? importCommerceCrons;
}

export async function loadCommerceCrons(): Promise<CommerceCrons | null> {
  try {
    return await commerceCronsLoader();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "unknown",
        message: "commerce cron module could not be loaded",
      }),
    );
    return null;
  }
}

async function runStep(name: string, step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "unknown",
        message: "scheduled step failed",
        step: name,
      }),
    );
    return false;
  }
}

const CP3_STEPS: ReadonlyArray<readonly [string, CronStep]> = [
  ["rescreen_stale", (env, now) => rescreenStaleScreenings(env.DB, now)],
  ["connect_stuck", (env, now) => raiseStuckOnboardingAlerts(env.DB, now)],
];

export async function handleScheduled(
  controller: Pick<ScheduledController, "cron" | "scheduledTime">,
  env: Env,
): Promise<void> {
  if (controller.cron !== OUTBOX_SWEEP_CRON) {
    console.warn(JSON.stringify({ cron: controller.cron, message: "unknown cron ignored" }));
    return;
  }

  const failures: string[] = [];
  const now = () => Date.now();

  // Parked payment facts (refunds/disputes that arrived before their order)
  // are replayed BEFORE the sweep, so a fully refunded order is never handed
  // to a printer by the sweep that runs in the same tick (CP2-A review P2-1;
  // the dispatch hold in src/commerce/dispatch-hold.ts is the belt to this
  // brace).
  const commerce = await loadCommerceCrons();
  const replay = commerce?.replayDeferred;
  if (typeof replay === "function") {
    if (!(await runStep("replayDeferred", () => replay(env, now())))) {
      failures.push("replayDeferred");
    }
  }

  if (!(await runStep("outbox_sweep", () => runOutboxSweep(env, now())))) {
    failures.push("outbox_sweep");
  }

  const runCommerce = async (name: keyof CommerceCrons): Promise<void> => {
    const step = commerce?.[name];
    if (typeof step !== "function") {
      return;
    }
    if (!(await runStep(name, () => step(env, now())))) {
      failures.push(name);
    }
  };

  await runCommerce("runReconciliation");
  await runCommerce("runRetentionSweep");

  // CP3 steps. Each is bounded per tick and safe to repeat every 15 minutes.
  //   rescreen_stale   product verdicts computed under an older blocklist are
  //                    re-screened, 25 per tick (src/catalog/screening.ts);
  //   connect_stuck    one warning alert per Connect onboarding operation that
  //                    has stayed `reserved` for more than 24 hours
  //                    (src/commerce/connect-onboarding.ts).
  for (const [name, step] of CP3_STEPS) {
    if (!(await runStep(name, () => step(env, now())))) {
      failures.push(name);
    }
  }

  // The digest runs LAST so it sees the alerts this tick raised (D40).
  await runCommerce("runAlertDigest");

  if (failures.length > 0) {
    throw new Error(`scheduled steps failed: ${failures.join(", ")}`);
  }
}
