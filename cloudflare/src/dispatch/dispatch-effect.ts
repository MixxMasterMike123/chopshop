import {
  alertStatement,
  complete,
  type EffectContext,
  fail,
  fenceGuard,
  iso,
  markSubmitting,
  markUnknown,
  outboxRetryDelayMs,
  outcomeOf,
  type OutboxRow,
  type OutboxRunOutcome,
  readOutboxRow,
  type SqlGuard,
  supersede,
  type WithTransition,
} from "../outbox/outbox";
import { nudgeOutbox } from "../outbox/nudge";
import {
  isR2PresignerConfigured,
  resolveR2Presigner,
} from "../pod/render-farm-client";
import {
  type PrinterJob,
  type PrinterSubmitResult,
  resolvePrinterClient,
} from "./printer-client";
import {
  DISPATCH_HOLD_UNTIL_MS,
  dispatchHeldForPayment,
  parkForHold,
} from "../commerce/dispatch-hold";
import { readDispatchShipTo } from "../commerce/recipient";
import { parsePrinterJobId, type PrintLocation, printerJobId } from "./snapwear-wire";

/**
 * The `dispatch` outbox effect: one order line → one printer job (PLAN §2.3).
 *
 * The row is inserted by CP2-A's webhook in the order batch:
 *   { event_type: 'dispatch', aggregate_id: orderId,
 *     dedupe_key: 'dispatch:{orderId}:{lineNo}',
 *     payload: { orderId, lineNo, jobId: '{orderId}-{lineNo}' } }
 * The job is built ONLY from the order's frozen production data
 * (`order_items.production_json`, the snapshot's line; `orders.
 * production_snapshot_json` for the printer) — never from the catalogue.
 *
 * ── ONE RUN ─────────────────────────────────────────────────────────────────
 *  1. cancellation re-check after claiming (§2.3): requested and the call never
 *     went out → superseded, line `cancelled`. Requested and a previous attempt
 *     MAY have reached the printer (`submitted_at`) → `unknown` + an immediate
 *     human-action alert; it is never re-submitted (that could create the job
 *     the buyer just cancelled).
 *  2. build the job (validation failures are terminal + alert: resubmitting
 *     cannot fix data), check each print file exists with the snapshot's sha256,
 *     presign it.
 *  3. claimed → submitting, atomically refused if a cancellation landed
 *     meanwhile (the re-check "before the HTTP call").
 *  4. submit with the STABLE job id `{orderId}-{lineNo}`:
 *       accepted   → done (result_ref = printer id), line `accepted`
 *       duplicate  → done: the printer already had it (a lost response)
 *       rejected   → failed + alert; or superseded if a cancellation arrived;
 *                    or unknown when an earlier attempt's answer was lost
 *                    (the refusal may be the duplicate we cannot read)
 *       unknown    → unknown, re-submitted after backoff (duplicate ⇒ done);
 *                    the sweeper alerts after 30 minutes (dispatch_unknown_30m)
 *     A cancellation that arrived while the call was out turns accepted /
 *     duplicate into a `printer_cancellation` outbox row in the same batch.
 *
 * An environment with NO printer client parks the row (parkForPrinter): no
 * attempt is spent while it waits, the sweeper releases it once a client
 * exists, and reconciliation's dispatch_stranded_30m alert names it after 30
 * minutes. A row whose earlier answer was lost is held as `unknown` instead
 * (holdUnknownForPrinter): a human can still resolve it, and the 30-minute
 * unknown alert still names it.
 *
 * Every line-state write, alert and follow-up row is committed in the batch of
 * the outbox transition it belongs to, under that transition's fence.
 */

/**
 * How long the printer's download URLs stay valid. SnapWear fetches artwork by
 * URL (LAUNCH_TODO A6); whether at import or at print time is open (C4), and a
 * print-time fetch can be days after the order. R2's maximum, 7 days, so a
 * queued job is never unprintable because its link died. OPEN QUESTION (C4):
 * shorten once SnapWear confirms they store the file at import.
 */
export const DISPATCH_PRINT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `next_attempt_at` of a dispatch row PARKED because this environment has no
 * printer client (resolvePrinterClient → null: no DISPATCH_TARGET, the fake
 * outside staging, SnapWear before its switch). Year 9999, like the payment
 * hold, but a DIFFERENT instant on purpose: releaseDispatchHolds releases
 * rows at DISPATCH_HOLD_UNTIL_MS whose ORDER is no longer payment-held, and
 * must not wake rows that wait for a printer. Only the sweeper's
 * releasePrinterHolds (src/outbox/sweeper.ts) releases these, and only once
 * a client resolves.
 */
export const PRINTER_HOLD_UNTIL_MS = DISPATCH_HOLD_UNTIL_MS - 1_000;

/** The `last_error` a printer-parked row carries. */
export const PRINTER_NOT_CONFIGURED = "printer_not_configured";

const LOCATIONS: readonly PrintLocation[] = ["front", "back"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PRINT_FILES = 2;

interface DispatchPayload {
  jobId: string;
  lineNo: number;
  orderId: string;
}

interface DispatchLine {
  orderItemId: string;
  productionJson: string | null;
  snapshotJson: string | null;
}

interface PrintFile {
  location: PrintLocation;
  r2Key: string;
  sha256: string;
}

interface BuiltJob {
  printFiles: PrintFile[];
  quantity: number;
  sku: string;
}

type Build<T> = { error: string; ok: false } | { ok: true; value: T };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parseDispatchPayload(row: OutboxRow): DispatchPayload | null {
  const payload = parseJson(row.payload_json);
  if (!isRecord(payload) || typeof payload.jobId !== "string") {
    return null;
  }
  const parsed = parsePrinterJobId(payload.jobId);
  if (
    parsed === null ||
    payload.orderId !== parsed.orderId ||
    payload.lineNo !== parsed.lineNo ||
    row.aggregate_id !== parsed.orderId ||
    printerJobId(parsed.orderId, parsed.lineNo) !== payload.jobId
  ) {
    return null;
  }
  return { jobId: payload.jobId, lineNo: parsed.lineNo, orderId: parsed.orderId };
}

async function loadDispatchLine(
  db: D1Database,
  tenantId: string,
  payload: DispatchPayload,
): Promise<DispatchLine | null> {
  // lineNo = item_index + 1 (0019). The frozen production line must agree.
  const row = await db
    .prepare(
      `SELECT oi.order_item_id, oi.production_json, o.production_snapshot_json
       FROM orders AS o
       JOIN order_items AS oi ON oi.order_id = o.order_id AND oi.tenant_id = o.tenant_id
       WHERE o.order_id = ? AND o.tenant_id = ? AND oi.item_index = ?
       LIMIT 1`,
    )
    .bind(payload.orderId, tenantId, payload.lineNo - 1)
    .first<{
      order_item_id: string;
      production_json: string | null;
      production_snapshot_json: string | null;
    }>();
  return row === null
    ? null
    : {
        orderItemId: row.order_item_id,
        productionJson: row.production_json,
        snapshotJson: row.production_snapshot_json,
      };
}

/**
 * The printer job from the frozen line. Fails closed on anything the printer
 * could not take or that would point outside this tenant's server-owned keys.
 */
export function buildDispatchJob(
  env: Env,
  tenantId: string,
  payload: DispatchPayload,
  line: DispatchLine,
): Build<BuiltJob> {
  const snapshot = parseJson(line.snapshotJson);
  if (!isRecord(snapshot)) {
    return { error: "production_snapshot_missing", ok: false };
  }
  // The order was routed to ONE printer when it was paid; this environment
  // dispatches to exactly one. A mismatch is never guessed across.
  if (snapshot.printer !== env.DISPATCH_TARGET) {
    return { error: "printer_mismatch", ok: false };
  }

  const production = parseJson(line.productionJson);
  if (!isRecord(production) || production.lineNo !== payload.lineNo) {
    return { error: "production_line_missing", ok: false };
  }
  const { quantity, sku } = production;
  if (
    typeof sku !== "string" ||
    sku.length === 0 ||
    sku.length > 64 ||
    typeof quantity !== "number" ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 999 ||
    !Array.isArray(production.printFiles) ||
    production.printFiles.length === 0 ||
    production.printFiles.length > MAX_PRINT_FILES
  ) {
    return { error: "production_line_invalid", ok: false };
  }

  const prefix = `pod/${tenantId}/`;
  const files: PrintFile[] = [];
  for (const entry of production.printFiles as unknown[]) {
    if (!isRecord(entry)) {
      return { error: "production_line_invalid", ok: false };
    }
    const { r2Key, sha256, slot } = entry;
    if (!LOCATIONS.includes(slot as PrintLocation)) {
      // SnapWear prints front and back only (layouts[].location).
      return { error: "print_slot_unsupported", ok: false };
    }
    if (
      typeof r2Key !== "string" ||
      !r2Key.startsWith(prefix) ||
      r2Key.length > 512 ||
      r2Key.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      typeof sha256 !== "string" ||
      !SHA256_PATTERN.test(sha256)
    ) {
      return { error: "production_line_invalid", ok: false };
    }
    if (files.some((file) => file.location === slot)) {
      return { error: "production_line_invalid", ok: false };
    }
    files.push({ location: slot as PrintLocation, r2Key, sha256 });
  }

  files.sort((a, b) => LOCATIONS.indexOf(a.location) - LOCATIONS.indexOf(b.location));
  return { ok: true, value: { printFiles: files, quantity, sku } };
}

/**
 * THE PS2 SEAM (LAUNCH_TODO A5): the file the printer receives for each print
 * slot of ONE line. Today it is the artwork's stored print PNG, exactly as the
 * line's production snapshot froze it (key + sha256); the caller then checks
 * it in the private bucket and presigns it. PS2 replaces this one function: a
 * PNG of the printer's whole frame with the motif at its placement offset,
 * rendered per line (render container; waits on C2/C3) and stored under the
 * order in the shop's server-owned print path, returned here as that file's
 * key and sha256 per slot. Nothing else in the dispatch needs to change.
 */
function printFilesForPrinter(job: BuiltJob): PrintFile[] {
  return job.printFiles;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type StorageCheck = { error: string; kind: "retry" | "terminal" } | { kind: "ok" };

/** Every print file exists in the private bucket and is the snapshot's bytes. */
async function checkPrintFiles(env: Env, files: PrintFile[]): Promise<StorageCheck> {
  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined || !isR2PresignerConfigured(env)) {
    return { error: "storage_not_configured", kind: "retry" };
  }
  for (const file of files) {
    let object: R2Object | null;
    try {
      object = await bucket.head(file.r2Key);
    } catch {
      return { error: "storage_error", kind: "retry" };
    }
    if (object === null) {
      return { error: "print_file_missing", kind: "terminal" };
    }
    const stored = object.checksums.sha256;
    // Every canonical print is written with its sha256 (render-jobs promote);
    // a file with none cannot be matched to the snapshot, so it is not sent.
    if (stored === undefined) {
      return { error: "print_file_unverified", kind: "terminal" };
    }
    if (hex(stored) !== file.sha256) {
      return { error: "print_file_mismatch", kind: "terminal" };
    }
  }
  return { kind: "ok" };
}

// ── statements committed with a transition ─────────────────────────────────

function lineStateStatement(
  db: D1Database,
  line: { orderItemId: string; tenantId: string },
  guard: SqlGuard,
  set: { binds: unknown[]; sql: string },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE order_items SET ${set.sql}
       WHERE order_item_id = ? AND tenant_id = ? AND ${guard.sql}`,
    )
    .bind(...set.binds, line.orderItemId, line.tenantId, ...guard.binds);
}

/**
 * The printer_cancellation follow-up for dispatch rows matching `where` (which
 * may only reference the dispatch row as `d`). Idempotent: one per line, keyed
 * `printer_cancellation:{orderId}:{lineNo}`.
 */
export function printerCancellationInsert(
  db: D1Database,
  input: { nowMs: number; printerJobRef: string | null; where: SqlGuard },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox_events (
         outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
       )
       SELECT 'printer-cancellation:' || d.outbox_id, d.tenant_id,
              'printer_cancellation', 'order', d.aggregate_id,
              'printer_cancellation:' || d.aggregate_id || ':'
                || json_extract(d.payload_json, '$.lineNo'),
              json_object(
                'dispatchOutboxId', d.outbox_id,
                'jobId', json_extract(d.payload_json, '$.jobId'),
                'lineNo', json_extract(d.payload_json, '$.lineNo'),
                'orderId', d.aggregate_id,
                'printerJobRef', COALESCE(?, d.result_ref)
              ),
              'pending', ?, ?, ?
       FROM outbox_events AS d
       WHERE d.event_type = 'dispatch' AND ${input.where.sql}
       ON CONFLICT DO NOTHING`,
    )
    .bind(input.printerJobRef, input.nowMs, input.nowMs, input.nowMs, ...input.where.binds);
}

export function printerCancellationId(dispatchOutboxId: string): string {
  return `printer-cancellation:${dispatchOutboxId}`;
}

function dispatchAlert(
  db: D1Database,
  row: OutboxRow,
  kind: string,
  message: string,
  nowMs: number,
  where?: SqlGuard,
): D1PreparedStatement {
  return alertStatement(
    db,
    {
      id: `${kind.replaceAll("_", "-")}:${row.outbox_id}`,
      kind,
      message,
      nowMs,
      resourceId: row.outbox_id,
      resourceType: "outbox_event",
      severity: "critical",
      tenantId: row.tenant_id,
    },
    where,
  );
}

// ── the effect ──────────────────────────────────────────────────────────────

async function failTerminal(
  ctx: EffectContext,
  error: string,
  line: { orderItemId: string; tenantId: string } | null,
): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const now = ctx.clock();
  const result = await fail(env.DB, claim, {
    backoffMs: 0,
    error,
    now,
    onFailed: (guard) => [
      dispatchAlert(
        env.DB,
        row,
        "dispatch_failed",
        `Dispatch ${row.outbox_id} for order ${row.aggregate_id} failed (${error}); the printer did not receive it. Check the order line.`,
        now,
        guard,
      ),
    ],
    terminal: true,
    withTransition: (guard) =>
      line === null
        ? []
        : [lineStateStatement(env.DB, line, guard, { binds: [], sql: "dispatch_state = 'failed'" })],
  });
  return outcomeOf(result, now);
}

/**
 * A retryable failure. The line follows the row IN THE SAME BATCH: back to
 * `pending` when the row is (a line shown `submitting` must not stay so), and
 * `failed` when this attempt was the last one and the row becomes `failed` —
 * whether the failure came before the printer call or from the call itself.
 * (`fail` moves the row to `failed` exactly when attempts >= max_attempts; the
 * CASE reads the same row before the transition, so the two cannot disagree.)
 */
async function retryLater(
  ctx: EffectContext,
  error: string,
  line: { orderItemId: string; tenantId: string },
): Promise<OutboxRunOutcome> {
  const now = ctx.clock();
  const result = await fail(ctx.env.DB, ctx.claim, {
    withTransition: (guard) => [
      lineStateStatement(ctx.env.DB, line, guard, {
        binds: [ctx.row.outbox_id],
        sql: `dispatch_state = CASE
                WHEN (SELECT e.attempts >= e.max_attempts FROM outbox_events AS e
                      WHERE e.outbox_id = ?) THEN 'failed'
                WHEN dispatch_state = 'submitting' THEN 'pending'
                ELSE dispatch_state
              END`,
      }),
    ],
    backoffMs: outboxRetryDelayMs(ctx.row.attempts),
    error,
    now,
    onFailed: (guard) => [
      dispatchAlert(
        ctx.env.DB,
        ctx.row,
        "dispatch_failed",
        `Dispatch ${ctx.row.outbox_id} for order ${ctx.row.aggregate_id} gave up after ${ctx.row.attempts} attempts (${error}).`,
        now,
        guard,
      ),
    ],
  });
  return outcomeOf(result, now);
}

/**
 * This environment has no printer client: PARK the claimed row instead of
 * retrying it (the CP2 retry spent an attempt per wake-up and, after ten,
 * failed the job for good — a whole production window without the SnapWear
 * switch would have failed every paid POD order). The row goes back to
 * `pending` with its claim released and `next_attempt_at` =
 * PRINTER_HOLD_UNTIL_MS: nothing claims it again, so no further attempt is
 * spent however long it waits. The sweeper releases it when a client resolves
 * (src/outbox/sweeper.ts); the reconciliation cron's dispatch_stranded_30m
 * alert names it while it waits longer than 30 minutes. The line stays
 * where it was (back from a previous attempt's 'submitting' to 'pending', as
 * retryLater does); the seller sees "queued".
 *
 * Atomic under the claim's fence, and only while an attempt remains (a row
 * parked on its last attempt could never be claimed again): otherwise null,
 * and the caller falls back to retryLater, which fails an exhausted row with
 * its alert. Same shape as parkForHold (src/commerce/dispatch-hold.ts).
 */
async function parkForPrinter(
  ctx: EffectContext,
  line: { orderItemId: string; tenantId: string },
): Promise<OutboxRunOutcome | null> {
  const { claim, env } = ctx;
  const now = ctx.clock();
  const fence = fenceGuard(claim, now);
  const parkable = {
    binds: fence.binds,
    sql: `${fence.sql} AND status = 'claimed' AND attempts < max_attempts`,
  };

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE order_items
       SET dispatch_state = CASE WHEN dispatch_state = 'submitting' THEN 'pending'
                                 ELSE dispatch_state END
       WHERE order_item_id = ? AND tenant_id = ?
         AND EXISTS (SELECT 1 FROM outbox_events WHERE ${parkable.sql})`,
    ).bind(line.orderItemId, line.tenantId, ...parkable.binds),
    env.DB.prepare(
      `UPDATE outbox_events
       SET status = 'pending',
           next_attempt_at = ${PRINTER_HOLD_UNTIL_MS},
           last_error = '${PRINTER_NOT_CONFIGURED}',
           claimed_by = NULL, claim_expires_at = NULL,
           updated_at = MAX(updated_at, ?)
       WHERE ${parkable.sql}
       RETURNING outbox_id`,
    ).bind(now, ...parkable.binds),
  ]);

  return (results[1]?.results.length ?? 0) === 1
    ? { delayMs: PRINTER_HOLD_UNTIL_MS - now, kind: "retry" }
    : null;
}

/**
 * The same hold for a row whose earlier answer was LOST (`unknown_since`
 * set; Codex CP6-PS1 P2). The printer may already have its job, so the row
 * must stay what a human can act on. parkForPrinter would make it `pending`,
 * which the resolution route refuses and the 30-minute unknown alert skips.
 * So it goes back to `unknown`, with `next_attempt_at` = PRINTER_HOLD_UNTIL_MS:
 *   - resolvable: POST /v1/platform/dispatch/:id/resolve takes `unknown`;
 *   - alerted: the sweeper's dispatch_unknown_30m names unknown rows by
 *     `unknown_since`, whatever their next attempt;
 *   - no attempt spent while it waits: an `unknown` row is claimed only when
 *     due, and the sweeper's releasePrinterHolds makes it due again once a
 *     client resolves. It is then re-submitted with the SAME job id: a
 *     duplicate answer settles it, and an unreadable refusal keeps it
 *     `unknown` (afterLostAnswer).
 * On the row's last attempt it stays `unknown` as well. Before, the retry
 * ended `failed`, which claims the printer never got the job.
 * The line is `unknown`, as the row is.
 */
async function holdUnknownForPrinter(
  ctx: EffectContext,
  line: { orderItemId: string; tenantId: string },
): Promise<OutboxRunOutcome> {
  const now = ctx.clock();
  const held = await markUnknown(ctx.env.DB, ctx.claim, {
    backoffMs: PRINTER_HOLD_UNTIL_MS - now,
    error: PRINTER_NOT_CONFIGURED,
    now,
    withTransition: (guard) => [
      lineStateStatement(ctx.env.DB, line, guard, { binds: [], sql: "dispatch_state = 'unknown'" }),
    ],
  });
  return outcomeOf(held, now);
}

/**
 * A cancellation was requested (seen after claiming, or refused at the
 * submitting step). Never a printer call from here.
 */
async function honourCancellation(
  ctx: EffectContext,
  row: OutboxRow,
  line: { orderItemId: string; tenantId: string } | null,
): Promise<OutboxRunOutcome> {
  const { claim, env } = ctx;
  const now = ctx.clock();
  const lineState = (state: string): WithTransition => (guard) =>
    line === null
      ? []
      : [lineStateStatement(env.DB, line, guard, { binds: [state], sql: "dispatch_state = ?" })];

  if (row.submitted_at === null) {
    // Path 1/2 of §2.3: it never left — zero printer jobs.
    const result = await supersede(env.DB, claim, {
      now,
      reason: "cancelled",
      withTransition: lineState("cancelled"),
    });
    return outcomeOf(result, now);
  }

  // A previous attempt may have reached the printer and its answer was lost.
  // Re-submitting could CREATE the job the buyer cancelled, so a human checks
  // the printer and resolves (accepted → printer_cancellation; failed → done).
  const result = await markUnknown(env.DB, claim, {
    backoffMs: 0,
    error: "cancel_requested_after_submit",
    now,
    withTransition: (guard) => [
      ...lineState("unknown")(guard),
      dispatchAlert(
        env.DB,
        row,
        "dispatch_cancel_unconfirmed",
        `Order ${row.aggregate_id} was cancelled while dispatch ${row.outbox_id} may already have reached the printer. Check the printer for job ${parseDispatchPayload(row)?.jobId ?? "?"} and resolve the dispatch.`,
        now,
        guard,
      ),
    ],
  });
  return outcomeOf(result, now);
}

export async function runDispatchEffect(ctx: EffectContext): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const tenantId = row.tenant_id;
  const payload = parseDispatchPayload(row);
  if (tenantId === null || payload === null) {
    return failTerminal(ctx, "invalid_payload", null);
  }

  const line = await loadDispatchLine(env.DB, tenantId, payload);
  const lineRef = line === null ? null : { orderItemId: line.orderItemId, tenantId };

  // §2.3: re-check cancel_requested after claiming.
  if (row.cancel_requested === 1) {
    return honourCancellation(ctx, row, lineRef);
  }
  if (line === null || lineRef === null) {
    return failTerminal(ctx, "order_line_not_found", null);
  }

  // An environment without a usable printer HOLDS its work (parked, no
  // attempt spent; released by the sweeper, alerted by reconciliation)
  // rather than judging the order by it.
  const client = resolvePrinterClient(env);
  if (client === null) {
    // A job whose answer was lost may already be at the printer: it stays
    // `unknown` (resolvable, alerted) rather than becoming an ordinary wait.
    if (row.unknown_since !== null) {
      return holdUnknownForPrinter(ctx, lineRef);
    }
    return (
      (await parkForPrinter(ctx, lineRef)) ?? retryLater(ctx, PRINTER_NOT_CONFIGURED, lineRef)
    );
  }

  const built = buildDispatchJob(env, tenantId, payload, line);
  if (!built.ok) {
    return failTerminal(ctx, built.error, lineRef);
  }

  const printFiles = printFilesForPrinter(built.value);
  const storage = await checkPrintFiles(env, printFiles);
  if (storage.kind !== "ok") {
    return storage.kind === "terminal"
      ? failTerminal(ctx, storage.error, lineRef)
      : retryLater(ctx, storage.error, lineRef);
  }

  // D98: a shipped order's job carries where the parcel goes, read from the
  // order's frozen recipient (never from the checkout or the shop's settings).
  const shipTo = await readDispatchShipTo(env.DB, tenantId, payload.orderId);

  let job: PrinterJob;
  try {
    const presigner = resolveR2Presigner(env);
    job = {
      artworks: await Promise.all(
        printFiles.map(async (file) => ({
          location: file.location,
          url: await presigner.presignGet(file.r2Key, DISPATCH_PRINT_URL_TTL_SECONDS),
        })),
      ),
      items: [{ quantity: built.value.quantity, sku: built.value.sku }],
      jobId: payload.jobId,
      mockupUrls: [],
      shipTo,
    };
  } catch {
    return retryLater(ctx, "presign_failed", lineRef);
  }

  // Never hand a job to a printer while payment facts for the order are still
  // unapplied or Stripe's refunded total exceeds what is settled here (CP2-A
  // dispatch hold): the row is retried once the hold releases and nudges it.
  if (await dispatchHeldForPayment(env.DB, row.aggregate_id)) {
    return (await parkForHold(ctx, lineRef)) ?? retryLater(ctx, "payment_facts_pending", lineRef);
  }

  const submitting = await markSubmitting(env.DB, claim, {
    now: ctx.clock(),
    withTransition: (guard) => [
      lineStateStatement(env.DB, lineRef, guard, {
        binds: [],
        sql: "dispatch_state = 'submitting'",
      }),
    ],
  });
  if (submitting === null) {
    // Either a cancellation landed after the claim (still ours: honour it), or
    // the claim is gone.
    const current = await readOutboxRow(env.DB, row.outbox_id);
    if (
      current !== null &&
      current.status === "claimed" &&
      current.claimed_by === claim.claimedBy &&
      current.cancel_requested === 1
    ) {
      return honourCancellation(ctx, current, lineRef);
    }
    return { kind: "lost_claim" };
  }

  let result: PrinterSubmitResult;
  try {
    result = await client.submit(job);
  } catch {
    // The client contract returns transport failures as `unknown`; a throw is
    // a fault before sending (no client throws by design). Retrying re-sends
    // the same job id, which the printer deduplicates either way.
    return retryLater(ctx, "printer_client_error", lineRef);
  }

  return recordSubmitResult(ctx, lineRef, result);
}

/**
 * Fail CLOSED on a refusal that follows a lost answer (CP6-PS1). When an
 * earlier attempt of this row went `unknown` (`unknown_since`), the job may
 * already be at the printer, and the refusal now may be the printer's
 * duplicate answer in words this client cannot read (C5: its exact text is not
 * known, and an unrecognised 400 is `rejected`). Recording it `failed` ("the
 * printer did not receive it") could lead a human to place the job a second
 * time, so it stays `unknown`: a human checks the printer and resolves it.
 */
export function afterLostAnswer(
  row: Pick<OutboxRow, "unknown_since">,
  result: PrinterSubmitResult,
): PrinterSubmitResult {
  return result.status === "rejected" && row.unknown_since !== null
    ? { reason: `rejected_after_unknown_${result.code}`, status: "unknown" }
    : result;
}

async function recordSubmitResult(
  ctx: EffectContext,
  line: { orderItemId: string; tenantId: string },
  submitted: PrinterSubmitResult,
): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const now = ctx.clock();
  const result = afterLostAnswer(row, submitted);

  if (result.status === "accepted" || result.status === "duplicate") {
    const printerRef = result.status === "accepted" ? result.printerJobId : null;
    const done = await complete(env.DB, claim, {
      now,
      resultRef: printerRef,
      withTransition: (guard) => [
        lineStateStatement(env.DB, line, guard, {
          binds: [printerRef, iso(now)],
          sql: `dispatch_state = 'accepted',
                printer_job_ref = COALESCE(printer_job_ref, ?),
                dispatched_at = COALESCE(dispatched_at, ?)`,
        }),
        // A cancellation that arrived while the call was out (§2.3 path 2).
        printerCancellationInsert(env.DB, {
          nowMs: now,
          printerJobRef: printerRef,
          where: {
            binds: [row.outbox_id, ...guard.binds],
            sql: `d.outbox_id = ? AND d.cancel_requested = 1 AND ${guard.sql}`,
          },
        }),
      ],
    });
    if (done !== null && done.cancel_requested === 1) {
      await nudgeOutbox(env, [printerCancellationId(row.outbox_id)]);
    }
    return outcomeOf(done, now);
  }

  if (result.status === "rejected") {
    const current = await readOutboxRow(env.DB, row.outbox_id);
    if (current?.cancel_requested === 1) {
      // Refused by the printer AND cancelled: nothing to produce, nothing to undo.
      const superseded = await supersede(env.DB, claim, {
        now,
        reason: `rejected_${result.code}`,
        withTransition: (guard) => [
          lineStateStatement(env.DB, line, guard, { binds: [], sql: "dispatch_state = 'cancelled'" }),
        ],
      });
      return outcomeOf(superseded, now);
    }
    return failTerminal(ctx, `rejected_${result.code}`, line);
  }

  // unknown: the job may or may not be at the printer. The same job id is
  // re-submitted after backoff; a cancellation stops that and asks a human.
  const unknown = await markUnknown(env.DB, claim, {
    backoffMs: outboxRetryDelayMs(row.attempts),
    error: `unknown_${result.reason}`,
    now,
    withTransition: (guard) => [
      lineStateStatement(env.DB, line, guard, { binds: [], sql: "dispatch_state = 'unknown'" }),
      dispatchAlert(
        env.DB,
        row,
        "dispatch_cancel_unconfirmed",
        `Order ${row.aggregate_id} was cancelled while dispatch ${row.outbox_id} was at the printer and the printer's answer was lost. Check the printer and resolve the dispatch.`,
        now,
        {
          binds: [row.outbox_id, ...guard.binds],
          sql: `EXISTS (SELECT 1 FROM outbox_events WHERE outbox_id = ? AND cancel_requested = 1) AND ${guard.sql}`,
        },
      ),
    ],
  });
  return outcomeOf(unknown, now);
}

// ── printer_cancellation ────────────────────────────────────────────────────

/**
 * The `printer_cancellation` effect: an accepted printer job belongs to a
 * cancelled order. SnapWear has no cancellation API (LAUNCH_TODO A6; nor does
 * the fake), so the effect is a human-action alert, raised exactly once, and
 * the row is done when the alert exists. A printer with a cancellation API
 * would call it here instead.
 */
export async function runPrinterCancellationEffect(
  ctx: EffectContext,
): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const now = ctx.clock();
  const payload = parseJson(row.payload_json);
  const record = isRecord(payload) ? payload : {};
  const jobId = typeof record.jobId === "string" ? record.jobId : "?";
  const ref = typeof record.printerJobRef === "string" ? record.printerJobRef : null;
  const alertId = `printer-cancellation-needed:${row.outbox_id}`;

  const done = await complete(env.DB, claim, {
    now,
    resultRef: alertId.slice(0, 200),
    withTransition: (guard) => [
      alertStatement(
        env.DB,
        {
          id: alertId,
          kind: "printer_cancellation_needed",
          message: `Order ${row.aggregate_id} was cancelled after the printer accepted job ${jobId}${ref === null ? "" : ` (printer reference ${ref})`}. The printer has no cancellation API: cancel the job with the printer by hand.`,
          nowMs: now,
          resourceId: row.outbox_id,
          resourceType: "outbox_event",
          severity: "critical",
          tenantId: row.tenant_id,
        },
        guard,
      ),
    ],
  });
  return outcomeOf(done, now);
}
