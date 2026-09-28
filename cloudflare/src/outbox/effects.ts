import {
  runDispatchEffect,
  runPrinterCancellationEffect,
} from "../dispatch/dispatch-effect";
import { runWithdrawalEmailEffect } from "../commerce/withdrawals";
import { runEmailEffect } from "./email-effect";
import {
  claimById,
  claimNext,
  type EffectContext,
  newClaimToken,
  type OutboxEffectType,
  type OutboxRow,
  type OutboxRunOutcome,
  readOutboxRow,
} from "./outbox";

/**
 * Running effects: claim a row, run its type's effect, report the outcome.
 * Shared by the `-outbox` queue consumer (claim by id, from a nudge) and the
 * 15-minute sweeper (claim the next due row).
 */

const EFFECTS: Record<OutboxEffectType, (ctx: EffectContext) => Promise<OutboxRunOutcome>> = {
  dispatch: runDispatchEffect,
  email: runEmailEffect,
  printer_cancellation: runPrinterCancellationEffect,
  withdrawal_email: runWithdrawalEmailEffect,
};

export function runClaimedOutboxRow(
  env: Env,
  row: OutboxRow,
  clock: () => number,
): Promise<OutboxRunOutcome> {
  const effect = EFFECTS[row.event_type as OutboxEffectType];
  if (row.claimed_by === null || effect === undefined) {
    // Unreachable: claims only ever return known types with a token.
    return Promise.resolve({ kind: "lost_claim" });
  }
  return effect({
    claim: { claimedBy: row.claimed_by, outboxId: row.outbox_id },
    clock,
    env,
    row,
  });
}

/** Why a named row was not run. */
export type NotClaimed =
  /** done / failed / superseded, unknown awaiting a human, or not ours to run. */
  | { kind: "settled" }
  /** Another worker holds a live claim, or the row is not due yet. */
  | { delayMs: number; kind: "later" }
  | { kind: "missing" };

export type ProcessResult = { kind: "ran"; outcome: OutboxRunOutcome } | NotClaimed;

function whyNotClaimed(row: OutboxRow | null, now: number): NotClaimed {
  if (row === null) {
    return { kind: "missing" };
  }
  if (row.attempts >= row.max_attempts) {
    // Exhausted: the sweeper settles stranded claims; nothing to retry here.
    return { kind: "settled" };
  }
  switch (row.status) {
    case "claimed":
    case "submitting":
      return {
        delayMs: Math.max(0, (row.claim_expires_at ?? now) - now),
        kind: "later",
      };
    case "pending":
      return { delayMs: Math.max(0, row.next_attempt_at - now), kind: "later" };
    case "unknown":
      return row.cancel_requested === 0
        ? { delayMs: Math.max(0, row.next_attempt_at - now), kind: "later" }
        : { kind: "settled" };
    default:
      return { kind: "settled" };
  }
}

export async function processOutboxRowById(
  env: Env,
  outboxId: string,
  clock: () => number = Date.now,
): Promise<ProcessResult> {
  const now = clock();
  const row = await claimById(env.DB, { claimedBy: newClaimToken(), now, outboxId });
  if (row === null) {
    return whyNotClaimed(await readOutboxRow(env.DB, outboxId), now);
  }
  return { kind: "ran", outcome: await runClaimedOutboxRow(env, row, clock) };
}

/** Claims and runs the oldest due row of a known type; null when none is due. */
export async function processNextOutboxRow(
  env: Env,
  clock: () => number = Date.now,
): Promise<{ outboxId: string; outcome: OutboxRunOutcome } | null> {
  const row = await claimNext(env.DB, { claimedBy: newClaimToken(), now: clock() });
  if (row === null) {
    return null;
  }
  return { outboxId: row.outbox_id, outcome: await runClaimedOutboxRow(env, row, clock) };
}
