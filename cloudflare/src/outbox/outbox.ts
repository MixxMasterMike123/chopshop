/**
 * The outbox with claims (PLAN §2.2) — the state machine every external effect
 * runs through. Schema: migrations/0021_outbox_claims.sql.
 *
 *   pending → claimed → submitting → done | failed | superseded
 *                    ↘ unknown (the receiver's answer was lost) → claimed | done | failed
 *
 * ── CLAIMING ────────────────────────────────────────────────────────────────
 * A claim is ONE `UPDATE … RETURNING`: the row moves to `claimed` with a fresh
 * random token (`claimed_by`), a 5-minute expiry and `attempts + 1`, and only if
 * it is claimable at that instant:
 *   - `pending` and due (`next_attempt_at <= now`, no live claim), or
 *   - `unknown`, due, and not cancel-requested (the automatic re-submit: the
 *     receiver's idempotency key makes it safe), or
 *   - `claimed` / `submitting` whose claim has EXPIRED (the worker died);
 * and always `attempts < max_attempts`. Oldest first. Two workers racing for a
 * row cannot both win: SQLite serialises the statement and the second finds the
 * predicate false.
 *
 * ── THE FENCE ───────────────────────────────────────────────────────────────
 * Every transition out of a claim is conditioned on
 *   `claimed_by = <token> AND claim_expires_at > now AND status IN (claimed, submitting)`
 * so a stale worker's late completion — its claim expired, or another worker
 * re-claimed the row — changes nothing. Statements an effect wants to commit
 * WITH a transition (the order line's dispatch state, an alert, a follow-up
 * outbox row) are handed the same guard and run first in the same batch: they
 * read the row before the transition moves it, so they apply exactly when the
 * transition does.
 *
 * ── TIME ────────────────────────────────────────────────────────────────────
 * INTEGER epoch milliseconds, 0001's convention for this table. Alerts are
 * ISO-8601 (0017).
 */

export const CLAIM_TTL_MS = 5 * 60 * 1_000;

/** The effect types a consumer here knows how to run. Others wait untouched. */
export const OUTBOX_EFFECT_TYPES = ["dispatch", "email", "printer_cancellation"] as const;
export type OutboxEffectType = (typeof OUTBOX_EFFECT_TYPES)[number];

export type OutboxStatus =
  | "claimed"
  | "done"
  | "failed"
  | "pending"
  | "submitting"
  | "superseded"
  | "unknown";

export interface OutboxRow {
  aggregate_id: string;
  aggregate_type: string;
  attempts: number;
  cancel_requested: number;
  claim_expires_at: number | null;
  claimed_by: string | null;
  created_at: number;
  dedupe_key: string;
  event_type: string;
  last_attempt_at: number | null;
  last_error: string | null;
  max_attempts: number;
  next_attempt_at: number;
  outbox_id: string;
  payload_json: string;
  resolved_at: number | null;
  result_ref: string | null;
  status: OutboxStatus;
  submitted_at: number | null;
  tenant_id: string | null;
  unknown_since: number | null;
  updated_at: number;
}

/** What a claim hands back: the token that fences every later transition. */
export interface OutboxClaim {
  claimedBy: string;
  outboxId: string;
}

/** A SQL boolean expression and its binds, to be embedded in a WHERE. */
export interface SqlGuard {
  binds: unknown[];
  sql: string;
}

/** Statements to commit atomically with a transition, conditioned on its guard. */
export type WithTransition = (guard: SqlGuard) => D1PreparedStatement[];

const OUTBOX_COLUMNS = `outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
  dedupe_key, payload_json, status, attempts, max_attempts, next_attempt_at,
  last_attempt_at, resolved_at, last_error, created_at, updated_at, claimed_by,
  claim_expires_at, cancel_requested, result_ref, submitted_at, unknown_since`;

const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

/** A stored error is always a code; anything else becomes `error`. */
export function outboxErrorCode(value: string): string {
  return ERROR_CODE_PATTERN.test(value) ? value : "error";
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const RETRY_BASE_MS = 60 * 1_000;
const RETRY_CAP_MS = 60 * 60 * 1_000;

/**
 * Backoff before the next attempt, given the attempts made so far: 1, 2, 4, …
 * minutes, capped at an hour. Ten attempts span roughly four and a half hours,
 * well past the 30-minute alert SLA, so a human hears of a stuck effect long
 * before it gives up.
 */
export function outboxRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(attempts) - 1, 20));
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_CAP_MS);
}

export function newClaimToken(): string {
  return crypto.randomUUID();
}

// ── claiming ────────────────────────────────────────────────────────────────

function claimableGuard(now: number): SqlGuard {
  return {
    binds: [now, now, now, now],
    sql: `(
      (status = 'pending' AND next_attempt_at <= ?
         AND (claim_expires_at IS NULL OR claim_expires_at < ?))
      OR (status = 'unknown' AND cancel_requested = 0 AND next_attempt_at <= ?)
      OR (status IN ('claimed', 'submitting') AND claim_expires_at < ?)
    ) AND attempts < max_attempts`,
  };
}

function knownTypeGuard(type: OutboxEffectType | undefined): SqlGuard {
  if (type !== undefined) {
    return { binds: [type], sql: "event_type = ?" };
  }
  return {
    binds: [...OUTBOX_EFFECT_TYPES],
    sql: `event_type IN (${OUTBOX_EFFECT_TYPES.map(() => "?").join(", ")})`,
  };
}

function claimStatement(
  db: D1Database,
  target: SqlGuard,
  claimedBy: string,
  now: number,
): D1PreparedStatement {
  const claimable = claimableGuard(now);
  return db
    .prepare(
      `UPDATE outbox_events
       SET status = 'claimed',
           claimed_by = ?,
           claim_expires_at = ?,
           attempts = attempts + 1,
           last_attempt_at = ?,
           updated_at = MAX(updated_at, ?)
       WHERE outbox_id = (
           SELECT outbox_id FROM outbox_events
           WHERE ${target.sql} AND ${claimable.sql}
           ORDER BY next_attempt_at, created_at, outbox_id
           LIMIT 1
         )
         AND ${claimable.sql}
       RETURNING ${OUTBOX_COLUMNS}`,
    )
    .bind(
      claimedBy,
      now + CLAIM_TTL_MS,
      now,
      now,
      ...target.binds,
      ...claimable.binds,
      ...claimable.binds,
    );
}

/** Claims the oldest claimable row (of one known type, or of any). */
export async function claimNext(
  db: D1Database,
  input: { claimedBy: string; now: number; type?: OutboxEffectType },
): Promise<OutboxRow | null> {
  return claimStatement(db, knownTypeGuard(input.type), input.claimedBy, input.now).first<OutboxRow>();
}

/** Claims one named row, if it is claimable and of a known type. */
export async function claimById(
  db: D1Database,
  input: { claimedBy: string; now: number; outboxId: string },
): Promise<OutboxRow | null> {
  const known = knownTypeGuard(undefined);
  return claimStatement(
    db,
    { binds: [input.outboxId, ...known.binds], sql: `outbox_id = ? AND ${known.sql}` },
    input.claimedBy,
    input.now,
  ).first<OutboxRow>();
}

export async function readOutboxRow(
  db: D1Database,
  outboxId: string,
): Promise<OutboxRow | null> {
  return db
    .prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox_events WHERE outbox_id = ? LIMIT 1`)
    .bind(outboxId)
    .first<OutboxRow>();
}

// ── the fence ───────────────────────────────────────────────────────────────

/** The claim still holds: same token, not expired, still in flight. */
export function fenceGuard(claim: OutboxClaim, now: number): SqlGuard {
  return {
    binds: [claim.outboxId, claim.claimedBy, now],
    sql: `outbox_id = ? AND claimed_by = ? AND claim_expires_at > ?
          AND status IN ('claimed', 'submitting')`,
  };
}

/** `guard` as a standalone condition any statement can put in its WHERE. */
export function existsGuard(guard: SqlGuard): SqlGuard {
  return {
    binds: guard.binds,
    sql: `EXISTS (SELECT 1 FROM outbox_events WHERE ${guard.sql})`,
  };
}

function andGuard(guard: SqlGuard, extraSql: string, extraBinds: unknown[] = []): SqlGuard {
  return { binds: [...guard.binds, ...extraBinds], sql: `${guard.sql} AND ${extraSql}` };
}

async function transition(
  db: D1Database,
  guard: SqlGuard,
  set: { binds: unknown[]; sql: string },
  withTransition: WithTransition | undefined,
): Promise<OutboxRow | null> {
  const update = db
    .prepare(
      `UPDATE outbox_events SET ${set.sql}
       WHERE ${guard.sql}
       RETURNING ${OUTBOX_COLUMNS}`,
    )
    .bind(...set.binds, ...guard.binds);
  const before = withTransition?.(existsGuard(guard)) ?? [];
  const results = await db.batch<OutboxRow>([...before, update]);
  const last = results.at(-1);
  return last?.results[0] ?? null;
}

// ── transitions (each returns the row as it now is, or null if the fence failed)

/**
 * claimed → submitting: the external call is about to be made. Refused when a
 * cancellation was requested meanwhile — the re-check "before the HTTP call"
 * of §2.3 is this statement's `cancel_requested = 0`, atomic with the move.
 */
export function markSubmitting(
  db: D1Database,
  claim: OutboxClaim,
  input: { now: number; withTransition?: WithTransition },
): Promise<OutboxRow | null> {
  return transition(
    db,
    andGuard(fenceGuard(claim, input.now), "status = 'claimed' AND cancel_requested = 0"),
    {
      binds: [input.now, input.now],
      sql: `status = 'submitting',
            submitted_at = COALESCE(submitted_at, ?),
            updated_at = MAX(updated_at, ?)`,
    },
    input.withTransition,
  );
}

/** → done, recording the receiver's reference. */
export function complete(
  db: D1Database,
  claim: OutboxClaim,
  input: { now: number; resultRef: string | null; withTransition?: WithTransition },
): Promise<OutboxRow | null> {
  return transition(
    db,
    fenceGuard(claim, input.now),
    {
      binds: [input.resultRef, input.now, input.now],
      sql: `status = 'done', result_ref = ?, resolved_at = ?, last_error = NULL,
            claimed_by = NULL, claim_expires_at = NULL,
            updated_at = MAX(updated_at, ?)`,
    },
    input.withTransition,
  );
}

/**
 * A failed attempt. Retryable → back to `pending` after `backoffMs`; terminal,
 * or out of attempts → `failed`. `onFailed` statements (the alert) run only
 * when the row actually becomes `failed`.
 */
export function fail(
  db: D1Database,
  claim: OutboxClaim,
  input: {
    backoffMs: number;
    error: string;
    now: number;
    onFailed?: WithTransition;
    terminal?: boolean;
    withTransition?: WithTransition;
  },
): Promise<OutboxRow | null> {
  const terminal = input.terminal === true ? 1 : 0;
  const becomesFailed = `(? = 1 OR attempts >= max_attempts)`;
  return transition(
    db,
    fenceGuard(claim, input.now),
    {
      binds: [
        terminal,
        terminal,
        input.now,
        input.now + input.backoffMs,
        outboxErrorCode(input.error),
        input.now,
      ],
      sql: `status = CASE WHEN ${becomesFailed} THEN 'failed' ELSE 'pending' END,
            resolved_at = CASE WHEN ${becomesFailed} THEN ? ELSE NULL END,
            next_attempt_at = ?,
            last_error = ?,
            claimed_by = NULL, claim_expires_at = NULL,
            updated_at = MAX(updated_at, ?)`,
    },
    (guard) => [
      ...(input.withTransition?.(guard) ?? []),
      ...(input.onFailed?.(
        andGuard(
          guard,
          `EXISTS (SELECT 1 FROM outbox_events WHERE outbox_id = ? AND (? = 1 OR attempts >= max_attempts))`,
          [claim.outboxId, terminal],
        ),
      ) ?? []),
    ],
  );
}

/**
 * → unknown: the external call may or may not have taken effect. Due again
 * after `backoffMs` (the automatic re-submit under the same idempotency key)
 * unless cancellation was requested, which stops automatic retries: then only
 * a human resolves it (POST /v1/platform/dispatch/:id/resolve).
 */
export function markUnknown(
  db: D1Database,
  claim: OutboxClaim,
  input: { backoffMs: number; error: string; now: number; withTransition?: WithTransition },
): Promise<OutboxRow | null> {
  return transition(
    db,
    fenceGuard(claim, input.now),
    {
      binds: [input.now, input.now + input.backoffMs, outboxErrorCode(input.error), input.now],
      sql: `status = 'unknown',
            unknown_since = COALESCE(unknown_since, ?),
            next_attempt_at = ?,
            last_error = ?,
            claimed_by = NULL, claim_expires_at = NULL,
            updated_at = MAX(updated_at, ?)`,
    },
    input.withTransition,
  );
}

/** → superseded: the effect is no longer wanted (a cancellation). */
export function supersede(
  db: D1Database,
  claim: OutboxClaim,
  input: { now: number; reason: string; withTransition?: WithTransition },
): Promise<OutboxRow | null> {
  return transition(
    db,
    fenceGuard(claim, input.now),
    {
      binds: [input.now, outboxErrorCode(input.reason), input.now],
      sql: `status = 'superseded', resolved_at = ?, last_error = ?,
            claimed_by = NULL, claim_expires_at = NULL,
            updated_at = MAX(updated_at, ?)`,
    },
    input.withTransition,
  );
}

// ── alerts ──────────────────────────────────────────────────────────────────

export interface AlertInput {
  /** Deterministic: the primary key is the dedupe (0017). */
  id: string;
  kind: string;
  /** Ids and codes only — never URLs, tokens or personal data (0017). */
  message: string;
  nowMs: number;
  resourceId: string;
  resourceType: string;
  severity: "critical" | "info" | "warning";
  tenantId: string | null;
}

/** An alert insert, optionally conditioned on `where`; a repeat is a no-op. */
export function alertStatement(
  db: D1Database,
  alert: AlertInput,
  where?: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alerts (
         id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${where?.sql ?? "1"}
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      alert.id.slice(0, 200),
      alert.tenantId,
      alert.kind,
      alert.severity,
      alert.message.slice(0, 1_000),
      alert.resourceType,
      alert.resourceId.slice(0, 200),
      iso(alert.nowMs),
      ...(where?.binds ?? []),
    );
}

// ── effects ─────────────────────────────────────────────────────────────────

/** What one run of an effect on a claimed row came to. */
export type OutboxRunOutcome =
  | { kind: "done" }
  | { kind: "failed" }
  | { kind: "superseded" }
  /** Back to `pending`; due again after `delayMs`. */
  | { delayMs: number; kind: "retry" }
  /** `unknown`; re-submitted automatically after `delayMs`, or never (null). */
  | { delayMs: number | null; kind: "unknown" }
  /** The fence failed: another worker holds (or finished) the row. */
  | { kind: "lost_claim" };

export interface EffectContext {
  claim: OutboxClaim;
  /** Milliseconds; tests drive it, production is Date.now. */
  clock: () => number;
  env: Env;
  row: OutboxRow;
}

/** The outcome a transition's resulting row stands for. */
export function outcomeOf(row: OutboxRow | null, now: number): OutboxRunOutcome {
  if (row === null) {
    return { kind: "lost_claim" };
  }
  switch (row.status) {
    case "done":
      return { kind: "done" };
    case "failed":
      return { kind: "failed" };
    case "superseded":
      return { kind: "superseded" };
    case "pending":
      return { delayMs: Math.max(0, row.next_attempt_at - now), kind: "retry" };
    case "unknown":
      return {
        delayMs:
          row.cancel_requested === 0 && row.attempts < row.max_attempts
            ? Math.max(0, row.next_attempt_at - now)
            : null,
        kind: "unknown",
      };
    default:
      // claimed / submitting: a transition never returns these.
      return { kind: "lost_claim" };
  }
}
