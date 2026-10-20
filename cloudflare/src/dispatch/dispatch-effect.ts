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
  type OutboxStatus,
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
  type PrinterClient,
  type PrinterJob,
  type PrinterJobLine,
  type PrinterSubmitResult,
  resolveProviderClient,
} from "./printer-client";
import {
  DISPATCH_HOLD_UNTIL_MS,
  dispatchHeldForPayment,
  parkForHold,
} from "../commerce/dispatch-hold";
import { readDispatchShipTo } from "../commerce/recipient";
import { nudgeRenderJob } from "../pod/render-jobs";
import { type PrinterItemFacts, parsePrinterItemFacts } from "../pod/printers";
import {
  ensureCanvasJobStatements,
  type EnsureCanvasSlot,
  lineCanvasPendingSql,
  orderCanvasPendingSql,
  readLineCanvases,
} from "../pod/print-canvas-jobs";
import {
  CANVAS_HOLD_UNTIL_MS,
  CANVAS_MAX_INPUT_BYTES,
  canvasSpec,
  decidePrintFiles,
  type FrameMm,
  type FrozenFlat,
  parseFrozenFlat,
  PRINT_CANVAS_PENDING,
  printCanvasEnabled,
} from "./print-canvas";
import { printerOrderIssueAlertStatement } from "./printer-order-alerts";
import { splitProdigiSkuKey } from "./prodigi-wire";
import { parsePrinterJobId, type PrintLocation, printerJobId } from "./snapwear-wire";

/**
 * The `dispatch` outbox effect: one order line's row → the printer (PLAN §2.3).
 *
 * The row is inserted by CP2-A's webhook in the order batch, ONE PER LINE:
 *   { event_type: 'dispatch', aggregate_id: orderId,
 *     dedupe_key: 'dispatch:{orderId}:{lineNo}',
 *     payload: { orderId, lineNo, jobId: '{orderId}-{lineNo}' } }
 * The job is built ONLY from the order's frozen production data
 * (`order_items.production_json`, the snapshot's line; `orders.
 * production_snapshot_json` for the printer) — never from the catalogue.
 *
 * ── WHICH PRINTER (CP11, D1) ────────────────────────────────────────────────
 * The snapshot names the printer the order was routed to; that printer's ROW
 * names its provider (migration 0057), and the provider's client exists only
 * when its gate passes here (printer-client.ts resolveProviderClient). A
 * snapshot with no printer, a printer row that is gone or another tenant's,
 * or a row whose provider is no longer the one frozen at checkout, is
 * terminal `printer_mismatch` (resubmitting cannot fix it). It replaced the
 * comparison of the snapshot's printer with the environment's DISPATCH_TARGET.
 *
 * ── WHAT ONE SUBMISSION COVERS (CP11, D4) ───────────────────────────────────
 *   line unit (SnapWear, the fake): the row's own line, job id
 *     `{orderId}-{lineNo}` — exactly as before CP11.
 *   order unit (Prodigi): EVERY dispatchable line of the order in one printer
 *     order, job id `{orderId}` (runOrderUnit). The rows stay one per line;
 *     whichever runs first speaks for its siblings, and the others ADOPT the
 *     printer's reference without a call.
 *
 * ── ONE RUN ─────────────────────────────────────────────────────────────────
 *  1. cancellation re-check after claiming (§2.3): requested and the call never
 *     went out → superseded, line `cancelled`. Requested and a previous attempt
 *     MAY have reached the printer (`submitted_at`) → `unknown` + an immediate
 *     human-action alert; it is never re-submitted (that could create the job
 *     the buyer just cancelled).
 *  2. build the job (validation failures are terminal + alert: resubmitting
 *     cannot fix data), choose each slot's file (printFilesForPrinter: the
 *     artwork's print PNG, or with PRINT_CANVAS_ENABLED the line's print
 *     canvas — CP6-PS2; a canvas not yet made PARKS the row until it is),
 *     check each print file exists with its recorded sha256, presign it.
 *     (Order unit: for every line it covers. A SIBLING line's problem is the
 *     sibling row's to fail; this row only waits: retryLater, never terminal.)
 *  3. claimed → submitting, atomically refused if a cancellation landed
 *     meanwhile (the re-check "before the HTTP call"). Order unit: also
 *     refused while another row of the order is submitting or a line of the
 *     order is already accepted with a reference (the race of two rows of one
 *     order is closed in that same statement).
 *  4. submit with the STABLE job id (`{orderId}-{lineNo}`, or `{orderId}`):
 *       accepted   → done (result_ref = printer id), line `accepted`
 *                    (order unit: every line the job carried, same batch)
 *       duplicate  → done: the printer already had it (a lost response)
 *       rejected   → failed + alert; or superseded if a cancellation arrived;
 *                    or unknown when an earlier attempt's answer was lost
 *                    (the refusal may be the duplicate we cannot read)
 *       unknown    → unknown, re-submitted after backoff (duplicate ⇒ done);
 *                    the sweeper alerts after 30 minutes (dispatch_unknown_30m)
 *     A cancellation that arrived while the call was out turns accepted /
 *     duplicate into a `printer_cancellation` outbox row in the same batch.
 *
 * An environment with NO client for the order's printer parks the row
 * (parkForPrinter): no attempt is spent while it waits, the sweeper releases
 * it once that provider's client exists, and reconciliation's
 * dispatch_stranded_30m alert names it after 30 minutes. A row whose earlier
 * answer was lost is held as `unknown` instead (holdUnknownForPrinter): a human
 * can still resolve it, and the 30-minute unknown alert still names it.
 *
 * Every line-state write, alert and follow-up row is committed in the batch of
 * the outbox transition it belongs to, under that transition's fence.
 */

/**
 * How long the printer's download URLs stay valid. SnapWear fetches artwork by
 * URL (LAUNCH_TODO A6); whether at import or at print time is open (C4), and a
 * print-time fetch can be days after the order. R2's maximum, 7 days, so a
 * queued job is never unprintable because its link died. OPEN QUESTION (C4):
 * shorten once SnapWear confirms they store the file at import. (Prodigi
 * downloads the assets at order time, verified 2026-10-19.)
 */
export const DISPATCH_PRINT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `next_attempt_at` of a dispatch row PARKED because this environment has no
 * client for the order's printer (resolveProviderClient → null: the provider's
 * gate fails, or the printer is `manual`). Year 9999, like the payment hold,
 * but a DIFFERENT instant on purpose: releaseDispatchHolds releases rows at
 * DISPATCH_HOLD_UNTIL_MS whose ORDER is no longer payment-held, and must not
 * wake rows that wait for a printer. Only the sweeper's releasePrinterHolds
 * (src/outbox/sweeper.ts) releases these, and only once the provider of the
 * row's printer resolves.
 */
export const PRINTER_HOLD_UNTIL_MS = DISPATCH_HOLD_UNTIL_MS - 1_000;

/** The `last_error` a printer-parked row carries. */
export const PRINTER_NOT_CONFIGURED = "printer_not_configured";

/** Order unit: another row of the order is at the printer right now (D4.3). */
export const ORDER_SUBMITTING = "order_submitting";

/** Order unit: a sibling line is not ready; its own row settles it (D4.1). */
export const SIBLING_PREFIX = "sibling_";

/** Order unit: an order larger than this is not assembled into one job. */
export const MAX_ORDER_LINES = 200;

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

/** An order line as statements address it. */
interface LineRef {
  orderItemId: string;
  tenantId: string;
}

interface PrintFile {
  location: PrintLocation;
  r2Key: string;
  sha256: string;
}

/**
 * A slot as the line froze it: the file, plus what the print canvas is made
 * from (CP6-PS2). The canvas fields are OPTIONAL here: a line frozen before
 * CP6-PS2 has none, and the artwork path never reads them. canvasSpec refuses
 * a slot that lacks them.
 */
interface FrozenSlot extends PrintFile {
  /** CP12: a flat print's canvas facts (parseFrozenFlat); a malformed one refuses the line. */
  flat?: FrozenFlat;
  frameMm?: FrameMm;
  frameProvisional?: boolean;
  sourcePx?: { h: number; w: number };
  widthMm: number;
}

interface BuiltJob {
  printFiles: FrozenSlot[];
  /** CP12: the line's frozen supplier facts (checkout's `printerItem`), when it has any. */
  printerItem?: PrinterItemFacts;
  quantity: number;
  sku: string;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The frozen canvas facts of one slot, each kept only when well formed. */
function frozenCanvasFields(entry: Record<string, unknown>): Omit<FrozenSlot, keyof PrintFile> {
  const { frameMm, frameProvisional, sourcePx, widthMm } = entry;
  const fields: Omit<FrozenSlot, keyof PrintFile> = { widthMm: isPositiveInt(widthMm) ? widthMm : 0 };
  if (isRecord(frameMm) && isPositiveInt(frameMm.w) && isPositiveInt(frameMm.h)) {
    fields.frameMm =
      frameMm.offsetTopMm === undefined
        ? { h: frameMm.h, w: frameMm.w }
        : typeof frameMm.offsetTopMm === "number"
          ? { h: frameMm.h, offsetTopMm: frameMm.offsetTopMm, w: frameMm.w }
          : { h: frameMm.h, w: frameMm.w };
  }
  if (typeof frameProvisional === "boolean") {
    fields.frameProvisional = frameProvisional;
  }
  if (isRecord(sourcePx) && isPositiveInt(sourcePx.w) && isPositiveInt(sourcePx.h)) {
    fields.sourcePx = { h: sourcePx.h, w: sourcePx.w };
  }
  return fields;
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

// ── which printer (CP11, D1) ────────────────────────────────────────────────

type PrinterRoute =
  | { client: PrinterClient; kind: "client"; provider: string }
  | { error: string; kind: "terminal" }
  | { kind: "none" };

/**
 * The client for the printer the order was routed to, from the printer's ROW
 * (D1). Terminal when the order cannot name a printer this environment holds
 * for it (resubmitting cannot fix that); `none` when the printer exists but no
 * client may be built for it here (its provider's gate, or a manual printer):
 * the caller parks the row, as it always has when no client existed.
 */
async function resolveDispatchPrinter(
  env: Env,
  tenantId: string,
  snapshotJson: string | null,
): Promise<PrinterRoute> {
  const snapshot = parseJson(snapshotJson);
  if (!isRecord(snapshot)) {
    return { error: "production_snapshot_missing", kind: "terminal" };
  }
  if (typeof snapshot.printer !== "string" || snapshot.printer.length === 0 || snapshot.printer.length > 64) {
    return { error: "printer_mismatch", kind: "terminal" };
  }
  const row = await env.DB.prepare(
    `SELECT type, provider, tenant_id FROM printers WHERE id = ? LIMIT 1`,
  )
    .bind(snapshot.printer)
    .first<{ provider: string; tenant_id: string | null; type: string }>();
  if (
    row === null ||
    (row.tenant_id !== null && row.tenant_id !== tenantId) ||
    // CP11: a printer re-pointed at another system after the sale never
    // receives an order frozen (priced, validated) for the first. A snapshot
    // made before CP11 carries no provider and is judged by the row alone.
    (snapshot.provider !== undefined && snapshot.provider !== row.provider)
  ) {
    return { error: "printer_mismatch", kind: "terminal" };
  }
  const client = row.type === "api" ? resolveProviderClient(env, row.provider) : null;
  return client === null ? { kind: "none" } : { client, kind: "client", provider: row.provider };
}

/**
 * The printer job of ONE frozen line. Fails closed on anything the printer
 * could not take or that would point outside this tenant's server-owned keys.
 * (CP11: the printer check moved to resolveDispatchPrinter, which reads the
 * printer's row; this judges the line alone, for whichever row builds it.)
 */
export function buildDispatchJob(
  tenantId: string,
  lineNo: number,
  productionJson: string | null,
): Build<BuiltJob> {
  const production = parseJson(productionJson);
  if (!isRecord(production) || production.lineNo !== lineNo) {
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

  // CP12: what the printer's wire needs beyond the key; malformed = refused.
  const printerItem = parsePrinterItemFacts(production.printerItem);
  if (printerItem === null) {
    return { error: "production_line_invalid", ok: false };
  }

  const prefix = `pod/${tenantId}/`;
  const files: FrozenSlot[] = [];
  for (const entry of production.printFiles as unknown[]) {
    if (!isRecord(entry)) {
      return { error: "production_line_invalid", ok: false };
    }
    const { r2Key, sha256, slot } = entry;
    if (!LOCATIONS.includes(slot as PrintLocation)) {
      // Both printers print front and back only (SnapWear layouts[].location,
      // Prodigi assets[].printArea; sleeves are not offered at launch).
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
    // CP12: a flat slot's canvas facts are kept whole or the line is refused —
    // dropping a malformed one would print the poster as a garment's canvas.
    let flat: FrozenFlat | undefined;
    if (entry.flat !== undefined) {
      const parsed = parseFrozenFlat(entry.flat);
      if (parsed === null) {
        return { error: "production_line_invalid", ok: false };
      }
      flat = parsed;
    }
    files.push({
      location: slot as PrintLocation,
      r2Key,
      sha256,
      ...frozenCanvasFields(entry),
      ...(flat === undefined ? {} : { flat }),
    });
  }

  files.sort((a, b) => LOCATIONS.indexOf(a.location) - LOCATIONS.indexOf(b.location));
  return {
    ok: true,
    value: { printFiles: files, ...(printerItem === undefined ? {} : { printerItem }), quantity, sku },
  };
}

// ── the print files of the lines a job carries ──────────────────────────────

/** One line the job will carry, built from its frozen data. */
interface PrintTarget {
  job: BuiltJob;
  lineNo: number;
}

/** A line with its chosen, checked files. */
interface ReadyLine extends PrintTarget {
  files: PrintFile[];
}

/**
 * Which canvases hold the row: its own line's (line unit, as before CP11), or
 * any line's of the order (order unit: the job carries every line, so a
 * sibling's pending canvas holds it exactly as its own would — D4.1).
 */
type CanvasScope = { kind: "line"; lineNo: number } | { kind: "order" };

/**
 * A failure names the line it came from (null: not one line's), so the order
 * unit can tell its own line's problem (terminal for this row, as before) from
 * a sibling's (the sibling's row fails it; this row waits).
 */
type PrepareFailure = { error: string; kind: "retry" | "terminal"; lineNo: number | null };

type PrintFilesResult =
  | { kind: "ready"; lines: ReadyLine[] }
  | ({ kind: "failure" } & { failure: PrepareFailure })
  | { kind: "parked"; outcome: OutboxRunOutcome };

/**
 * THE PS2 SEAM (LAUNCH_TODO A5): the file the printer receives for each print
 * slot of each line (src/dispatch/print-canvas.ts decidePrintFiles):
 *   - the line's completed print canvases, when every slot has one (whatever
 *     the switch: a re-dispatch after a lost answer gets the same file), each
 *     checked to have been made from the very print master the line froze;
 *   - the artwork's stored print PNG exactly as the snapshot froze it, when
 *     the switch is off or the job was already submitted without canvases
 *     (the file sent for one job id never changes);
 *   - terminal `print_canvas_failed` when a canvas of the line failed for good;
 *   - otherwise the canvases are ENSURED and the row PARKED (ensureAndPark).
 * Then every file is checked in the private bucket against its recorded
 * sha256 (checkPrintFiles), as before.
 *
 * `submitted`: the job was submitted before (line unit: this row; order unit:
 * any row of the order, since they share the one printer order).
 */
async function printFilesForPrinter(
  ctx: EffectContext,
  tenantId: string,
  orderId: string,
  targets: readonly PrintTarget[],
  ownLine: LineRef,
  scope: CanvasScope,
  submitted: boolean,
): Promise<PrintFilesResult> {
  for (let pass = 0; pass < 2; pass += 1) {
    const ready: Array<PrintTarget & { files: PrintFile[] }> = [];
    const toEnsure: PrintTarget[] = [];
    for (const target of targets) {
      const canvases = await readLineCanvases(ctx.env.DB, tenantId, orderId, target.lineNo);
      const decision = decidePrintFiles({
        canvases,
        slots: target.job.printFiles.map((file) => file.location),
        submitted,
        // CP12: a flat line (a poster) is ALWAYS printed from its canvas, the
        // sheet at its exact pixels with the frozen fit and background: the
        // bare master would leave both to the printer. The switch decides the
        // garment lines only.
        switchOn: printCanvasEnabled(ctx.env) || target.job.printFiles.some((file) => file.flat !== undefined),
      });
      switch (decision.kind) {
        case "artwork":
          ready.push({
            ...target,
            files: target.job.printFiles.map(({ location, r2Key, sha256 }) => ({ location, r2Key, sha256 })),
          });
          break;
        case "terminal":
          return { failure: { error: decision.error, kind: "terminal", lineNo: target.lineNo }, kind: "failure" };
        case "canvas": {
          const madeFromFrozen = target.job.printFiles.every((file) =>
            canvases.some(
              (canvas) =>
                canvas.slot === file.location && canvas.inputKey === file.r2Key && canvas.inputSha256 === file.sha256,
            ),
          );
          if (!madeFromFrozen) {
            return {
              failure: { error: "print_canvas_input_mismatch", kind: "terminal", lineNo: target.lineNo },
              kind: "failure",
            };
          }
          ready.push({ ...target, files: decision.files });
          break;
        }
        case "ensure":
          toEnsure.push(target);
          break;
      }
    }

    if (toEnsure.length === 0) {
      const checked: ReadyLine[] = [];
      for (const line of ready) {
        const storage = await checkPrintFiles(ctx.env, line.files);
        if (storage.kind !== "ok") {
          return { failure: { error: storage.error, kind: storage.kind, lineNo: line.lineNo }, kind: "failure" };
        }
        checked.push(line);
      }
      return { kind: "ready", lines: checked };
    }

    const ensured = await ensureAndPark(ctx, tenantId, orderId, toEnsure, ownLine, scope);
    if (ensured !== "settled") {
      return ensured;
    }
    // Every canvas settled between the read and the park: decide again.
  }
  return { failure: { error: PRINT_CANVAS_PENDING, kind: "retry", lineNo: null }, kind: "failure" };
}

/**
 * Ensure the lines' canvas jobs and park the row while they render, in ONE
 * batch. The artwork files are checked first exactly as the artwork path
 * checks them (a missing or wrong master is terminal there too), which also
 * gives each job its input size; each slot's geometry is computed and frozen
 * (canvasSpec refuses a line it cannot make honestly: terminal).
 *
 * The park (the same shape as parkForPrinter) applies under the claim's fence,
 * only while an attempt remains, and ONLY while one of the canvases of its
 * SCOPE is still queued or leased (the line's; CP11, order unit: the order's).
 * A job's settling batch releases the parked row (print-canvas-jobs.ts: the
 * line's row when the line has nothing pending, and every parked row of the
 * order when the order has nothing pending); because both statements read the
 * same rows under D1's single writer, a row is never parked after the last
 * canvas of its scope settled. No attempt is spent while it waits;
 * reconciliation's dispatch_stranded_30m names it after 30 minutes.
 *
 * "settled": nothing pending was left to wait for (decide again).
 */
async function ensureAndPark(
  ctx: EffectContext,
  tenantId: string,
  orderId: string,
  targets: readonly PrintTarget[],
  ownLine: LineRef,
  scope: CanvasScope,
): Promise<PrintFilesResult | "settled"> {
  const { claim, env, row } = ctx;
  const now = ctx.clock();
  const statements: D1PreparedStatement[] = [];
  const jobIds: string[] = [];
  for (const target of targets) {
    const storage = await checkPrintFiles(env, target.job.printFiles);
    if (storage.kind !== "ok") {
      return { failure: { error: storage.error, kind: storage.kind, lineNo: target.lineNo }, kind: "failure" };
    }
    const slots: EnsureCanvasSlot[] = [];
    for (const [index, file] of target.job.printFiles.entries()) {
      const spec = canvasSpec(file);
      if (!spec.ok) {
        return { failure: { error: spec.error, kind: "terminal", lineNo: target.lineNo }, kind: "failure" };
      }
      const inputBytes = storage.sizes[index] ?? 0;
      if (inputBytes < 1 || inputBytes > CANVAS_MAX_INPUT_BYTES) {
        return {
          failure: { error: "print_canvas_input_too_large", kind: "terminal", lineNo: target.lineNo },
          kind: "failure",
        };
      }
      slots.push({ inputBytes, inputKey: file.r2Key, inputSha256: file.sha256, location: file.location, spec: spec.spec });
    }
    const ensured = ensureCanvasJobStatements(env.DB, { lineNo: target.lineNo, now, orderId, slots, tenantId });
    statements.push(...ensured.statements);
    jobIds.push(...ensured.jobIds);
  }

  const fence = fenceGuard(claim, now);
  const pending = scope.kind === "line" ? lineCanvasPendingSql() : orderCanvasPendingSql();
  const pendingBinds = scope.kind === "line" ? [tenantId, orderId, scope.lineNo] : [tenantId, orderId];
  const parkable = `${fence.sql} AND status = 'claimed' AND attempts < max_attempts AND ${pending}`;
  const results = await env.DB.batch([
    ...statements,
    env.DB.prepare(
      `UPDATE order_items
       SET dispatch_state = CASE WHEN dispatch_state = 'submitting' THEN 'pending'
                                 ELSE dispatch_state END
       WHERE order_item_id = ? AND tenant_id = ?
         AND EXISTS (SELECT 1 FROM outbox_events WHERE ${parkable})`,
    ).bind(ownLine.orderItemId, ownLine.tenantId, ...fence.binds, ...pendingBinds),
    env.DB.prepare(
      `UPDATE outbox_events
       SET status = 'pending',
           next_attempt_at = ${CANVAS_HOLD_UNTIL_MS},
           last_error = '${PRINT_CANVAS_PENDING}',
           claimed_by = NULL, claim_expires_at = NULL,
           updated_at = MAX(updated_at, ?)
       WHERE ${parkable}
       RETURNING outbox_id`,
    ).bind(now, ...fence.binds, ...pendingBinds),
  ]);

  if ((results[results.length - 1]?.results.length ?? 0) === 1) {
    // One nudge wakes the singleton container, which drains every queued job.
    const firstId = jobIds[0];
    if (firstId !== undefined) {
      await nudgeRenderJob(env, firstId);
    }
    return { kind: "parked", outcome: { delayMs: CANVAS_HOLD_UNTIL_MS - now, kind: "retry" } };
  }

  // Not parked: the claim is gone, the last attempt is running, or nothing is
  // pending any more.
  const current = await readOutboxRow(env.DB, row.outbox_id);
  if (current === null || current.status !== "claimed" || current.claimed_by !== claim.claimedBy) {
    return { kind: "parked", outcome: { kind: "lost_claim" } };
  }
  for (const target of targets) {
    const canvases = await readLineCanvases(env.DB, tenantId, orderId, target.lineNo);
    if (canvases.some((canvas) => canvas.state === "queued" || canvas.state === "leased")) {
      // The last attempt: it cannot be parked (it could never be claimed again).
      // retryLater fails it with its alert, the unchanged CP2 rule.
      return { failure: { error: PRINT_CANVAS_PENDING, kind: "retry", lineNo: null }, kind: "failure" };
    }
  }
  return "settled";
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type StorageCheck = { error: string; kind: "retry" | "terminal" } | { kind: "ok"; sizes: number[] };

/** Every print file exists in the private bucket and is the recorded bytes. */
async function checkPrintFiles(env: Env, files: readonly PrintFile[]): Promise<StorageCheck> {
  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined || !isR2PresignerConfigured(env)) {
    return { error: "storage_not_configured", kind: "retry" };
  }
  const sizes: number[] = [];
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
    sizes.push(object.size);
  }
  return { kind: "ok", sizes };
}

// ── statements committed with a transition ─────────────────────────────────

function lineStateStatement(
  db: D1Database,
  line: LineRef,
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
  line: LineRef | null,
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
  line: LineRef,
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
 * Map a failure while preparing the job's lines. The row's OWN line keeps the
 * pre-CP11 meaning (terminal → failed + alert; retry → retry). A SIBLING
 * line's problem (order unit only) is never terminal for this row: the
 * sibling's own row judges its line by the same rules and fails it with its
 * alert, after which this row leaves it out (a failed line is not
 * dispatchable) — so this row retries, and one bad line never fails the
 * good ones of its order.
 */
function failPreparation(
  ctx: EffectContext,
  ownLineNo: number,
  line: LineRef,
  failure: PrepareFailure,
): Promise<OutboxRunOutcome> {
  if (failure.lineNo !== null && failure.lineNo !== ownLineNo) {
    return retryLater(ctx, `${SIBLING_PREFIX}${failure.error}`, line);
  }
  return failure.kind === "terminal"
    ? failTerminal(ctx, failure.error, line)
    : retryLater(ctx, failure.error, line);
}

/**
 * This environment has no client for the order's printer: PARK the claimed
 * row instead of retrying it (the CP2 retry spent an attempt per wake-up and,
 * after ten, failed the job for good — a whole production window without the
 * SnapWear switch would have failed every paid POD order). The row goes back
 * to `pending` with its claim released and `next_attempt_at` =
 * PRINTER_HOLD_UNTIL_MS: nothing claims it again, so no further attempt is
 * spent however long it waits. The sweeper releases it when its printer's
 * provider resolves (src/outbox/sweeper.ts); the reconciliation cron's
 * dispatch_stranded_30m alert names it while it waits longer than 30 minutes.
 * The line stays where it was (back from a previous attempt's 'submitting' to
 * 'pending', as retryLater does); the seller sees "queued".
 *
 * Atomic under the claim's fence, and only while an attempt remains (a row
 * parked on its last attempt could never be claimed again): otherwise null,
 * and the caller falls back to retryLater, which fails an exhausted row with
 * its alert. Same shape as parkForHold (src/commerce/dispatch-hold.ts).
 */
async function parkForPrinter(
  ctx: EffectContext,
  line: LineRef,
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
 *     due, and the sweeper's releasePrinterHolds makes it due again once its
 *     printer's provider resolves. It is then re-submitted with the SAME job
 *     id: a duplicate answer settles it, and an unreadable refusal keeps it
 *     `unknown` (afterLostAnswer).
 * On the row's last attempt it stays `unknown` as well. Before, the retry
 * ended `failed`, which claims the printer never got the job.
 * The line is `unknown`, as the row is.
 */
async function holdUnknownForPrinter(
  ctx: EffectContext,
  line: LineRef,
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
  line: LineRef | null,
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
  const { env, row } = ctx;
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

  // CP11 (D1): the order's printer row decides the client. A printer the order
  // cannot name here is terminal (as printer_mismatch always was).
  const route = await resolveDispatchPrinter(env, tenantId, line.snapshotJson);
  if (route.kind === "terminal") {
    return failTerminal(ctx, route.error, lineRef);
  }
  // An environment without a usable client for that printer HOLDS its work
  // (parked, no attempt spent; released by the sweeper once the provider
  // resolves, alerted by reconciliation) rather than judging the order by it.
  if (route.kind === "none") {
    // A job whose answer was lost may already be at the printer: it stays
    // `unknown` (resolvable, alerted) rather than becoming an ordinary wait.
    if (row.unknown_since !== null) {
      return holdUnknownForPrinter(ctx, lineRef);
    }
    return (
      (await parkForPrinter(ctx, lineRef)) ?? retryLater(ctx, PRINTER_NOT_CONFIGURED, lineRef)
    );
  }
  const client = route.client;

  if (client.unit === "order") {
    return runOrderUnit(ctx, tenantId, payload, lineRef, client, route.provider);
  }

  // ── line unit: one row, one line, one job (unchanged since CP6-PS2) ──────
  const built = buildDispatchJob(tenantId, payload.lineNo, line.productionJson);
  if (!built.ok) {
    return failTerminal(ctx, built.error, lineRef);
  }
  const prepared = await printFilesForPrinter(
    ctx,
    tenantId,
    payload.orderId,
    [{ job: built.value, lineNo: payload.lineNo }],
    lineRef,
    { kind: "line", lineNo: payload.lineNo },
    row.submitted_at !== null,
  );
  if (prepared.kind === "parked") {
    return prepared.outcome;
  }
  if (prepared.kind === "failure") {
    return failPreparation(ctx, payload.lineNo, lineRef, prepared.failure);
  }
  return submitPrepared(ctx, tenantId, payload, lineRef, client, {
    jobId: payload.jobId,
    lines: prepared.lines,
    order: null,
  });
}

// ── order unit (CP11, D4) ───────────────────────────────────────────────────

/** A dispatch row of the order with the line it carries. */
interface OrderLine {
  cancelRequested: boolean;
  dispatchState: string | null;
  lineNo: number;
  orderItemId: string;
  outboxId: string;
  printerJobRef: string | null;
  productionJson: string | null;
  /** The row's result_ref: the printer's reference once the row is done. */
  resultRef: string | null;
  rowStatus: OutboxStatus;
  submittedAt: number | null;
}

/**
 * Every dispatch row of the order with its line, in line order (bounded).
 * Only POD lines have dispatch rows, and an order has one printer (A4), so
 * these are exactly the lines one printer order can carry.
 */
async function readOrderLines(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<OrderLine[] | null> {
  const rows = await db
    .prepare(
      `SELECT e.outbox_id, e.status, e.cancel_requested, e.submitted_at, e.result_ref,
              json_extract(e.payload_json, '$.lineNo') AS line_no,
              oi.order_item_id, oi.production_json, oi.dispatch_state, oi.printer_job_ref
       FROM outbox_events AS e
       JOIN order_items AS oi
         ON oi.order_id = e.aggregate_id AND oi.tenant_id = e.tenant_id
        AND oi.item_index = json_extract(e.payload_json, '$.lineNo') - 1
       WHERE e.event_type = 'dispatch' AND e.tenant_id = ? AND e.aggregate_id = ?
       ORDER BY line_no, e.outbox_id
       LIMIT ${MAX_ORDER_LINES + 1}`,
    )
    .bind(tenantId, orderId)
    .all<{
      cancel_requested: number;
      dispatch_state: string | null;
      line_no: unknown;
      order_item_id: string;
      outbox_id: string;
      printer_job_ref: string | null;
      production_json: string | null;
      result_ref: string | null;
      status: OutboxStatus;
      submitted_at: number | null;
    }>();
  if (rows.results.length > MAX_ORDER_LINES) {
    return null;
  }
  const lines: OrderLine[] = [];
  for (const entry of rows.results) {
    if (!isPositiveInt(entry.line_no)) {
      return null;
    }
    lines.push({
      cancelRequested: entry.cancel_requested === 1,
      dispatchState: entry.dispatch_state,
      lineNo: entry.line_no,
      orderItemId: entry.order_item_id,
      outboxId: entry.outbox_id,
      printerJobRef: entry.printer_job_ref,
      productionJson: entry.production_json,
      resultRef: entry.result_ref,
      rowStatus: entry.status,
      submittedAt: entry.submitted_at,
    });
  }
  return lines;
}

/**
 * A SIBLING line the printer order carries (D4.1): its line not yet at any
 * printer — `dispatch_state` NULL or 'pending' — or 'unknown' (a lost answer
 * under the same idempotency key is the same Prodigi order); and its row
 * neither superseded, failed nor flagged for cancellation. Never carried:
 * 'accepted' of any kind (with a reference the row adopts instead; WITHOUT
 * one it is a line a human resolved as placed by hand, resolution.ts, and
 * sending it again would print it twice), 'failed' (its own row's, alerted,
 * a human's), 'cancelled', and 'submitting' (its row is at the printer: this
 * row already waits for it). The row's own line is always carried (it is
 * claimed, not cancelled, and its state is its own to move).
 */
function isDispatchableSibling(line: OrderLine): boolean {
  return (
    (line.dispatchState === null || line.dispatchState === "pending" || line.dispatchState === "unknown") &&
    line.rowStatus !== "superseded" &&
    line.rowStatus !== "failed" &&
    !line.cancelRequested
  );
}

/**
 * The claimed → submitting guard of an order-unit row (D4.3), uncorrelated
 * (explicit binds), so it reads the same inside the transition's UPDATE and
 * inside the EXISTS its companion statements carry: no OTHER dispatch row of
 * the order is submitting, and no other dispatch row of the order holds the
 * printer order already (isOrderWideReference: `done` with a result_ref
 * after a submission — a sibling that won the race between this row's read
 * and its move: this row then adopts on its next run instead of calling).
 * Codex round 1, P1: it once blocked on a LINE accepted with a reference,
 * which a human can record on one line by hand (resolution.ts); such a line
 * proves nothing about the order and would have blocked its other lines for
 * good.
 */
export function orderSubmitGuard(tenantId: string, orderId: string, outboxId: string): SqlGuard {
  return {
    binds: [tenantId, orderId, outboxId, tenantId, orderId, outboxId],
    sql: `NOT EXISTS (
            SELECT 1 FROM outbox_events AS sib
            WHERE sib.event_type = 'dispatch' AND sib.tenant_id = ? AND sib.aggregate_id = ?
              AND sib.outbox_id <> ? AND sib.status = 'submitting'
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox_events AS held
            WHERE held.event_type = 'dispatch' AND held.tenant_id = ? AND held.aggregate_id = ?
              AND held.outbox_id <> ? AND held.status = 'done'
              AND held.result_ref IS NOT NULL AND held.submitted_at IS NOT NULL
          )`,
  };
}

/**
 * Codex round 1, P1: a reference proves the PRINTER ORDER exists only when an
 * order-wide submission recorded it — a dispatch row of this order that went
 * to the printer (`submitted_at`) and is `done` with that `result_ref` (an
 * acceptance, Prodigi's AlreadyExists, or a human resolving that very
 * submission). A reference a human typed on one LINE (resolution.ts on a row
 * that never submitted) is not adopted: it may be a job placed by hand for
 * that line alone.
 */
function isOrderWideReference(line: OrderLine): line is OrderLine & { resultRef: string } {
  return line.rowStatus === "done" && line.resultRef !== null && line.submittedAt !== null;
}

/**
 * Codex round 1, P2 — fail closed across siblings. Another row of the order
 * may have reached Prodigi under the SAME idempotency key without our knowing
 * the answer: it is unknown, or was (`unknown_since`), or it submitted and is
 * still in flight (claimed/submitting). Codex round 2: a CONFIRMED refusal
 * (`failed` with no lost-answer history) and a `done` row are knowledge, not
 * uncertainty, so a second definitive refusal still fails with its alert. A refusal now could then be about an order that already holds
 * this row's line, so it is read as an answer after a lost one
 * (afterLostAnswer): unknown, for a human, never "the printer did not
 * receive it". Read after the call, so a sibling that moved meanwhile counts.
 */
async function orderAnswerUncertain(
  db: D1Database,
  tenantId: string,
  orderId: string,
  outboxId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS uncertain FROM outbox_events
       WHERE event_type = 'dispatch' AND tenant_id = ? AND aggregate_id = ? AND outbox_id <> ?
         AND (unknown_since IS NOT NULL OR status = 'unknown'
              OR (submitted_at IS NOT NULL AND status IN ('claimed', 'submitting')))
       LIMIT 1`,
    )
    .bind(tenantId, orderId, outboxId)
    .first<{ uncertain: number }>();
  return row !== null;
}

/**
 * The order-unit run (D4). Its own line's rules are the line unit's; what
 * differs is that the job carries every dispatchable line of the order:
 *   1. another dispatch row of the order already holds the printer order
 *      (isOrderWideReference: `done` with a result_ref after a submission) ⇒
 *      this row ADOPTS it: its line accepted with that reference, the row done
 *      as a duplicate — no HTTP call (D4.2);
 *   2. another row of the order SUBMITTING ⇒ retry after the usual backoff,
 *      never a parallel call (D4.3; closed in SQL by orderSubmitGuard);
 *   3. build every carried line; a sibling's problem makes this row wait
 *      (failPreparation), its own is judged as always; a pending canvas of ANY
 *      carried line parks the row (CanvasScope "order");
 *   4. one job, `jobId` = orderId, the lines in line order; on `accepted` (or
 *      a duplicate naming the printer's order) EVERY carried line is marked
 *      accepted with the same reference in the row's own transition batch,
 *      and the other rows of the order are woken to adopt it (D4.4/D4.5).
 */
async function runOrderUnit(
  ctx: EffectContext,
  tenantId: string,
  payload: DispatchPayload,
  lineRef: LineRef,
  client: PrinterClient,
  provider: string,
): Promise<OutboxRunOutcome> {
  const { env, row } = ctx;
  const lines = await readOrderLines(env.DB, tenantId, payload.orderId);
  if (lines === null) {
    return failTerminal(ctx, "order_lines_over_cap", lineRef);
  }
  const own = lines.find((entry) => entry.outboxId === row.outbox_id);
  if (own === undefined || own.lineNo !== payload.lineNo) {
    return failTerminal(ctx, "order_line_not_found", lineRef);
  }

  const adopted = lines.find((entry) => entry !== own && isOrderWideReference(entry));
  if (adopted !== undefined && isOrderWideReference(adopted)) {
    return recordSubmitResult(ctx, lineRef, { printerJobId: adopted.resultRef, status: "duplicate" }, null);
  }
  if (lines.some((entry) => entry.outboxId !== row.outbox_id && entry.rowStatus === "submitting")) {
    return retryLater(ctx, ORDER_SUBMITTING, lineRef);
  }

  const carried = lines.filter((entry) => entry === own || isDispatchableSibling(entry));
  const targets: PrintTarget[] = [];
  for (const entry of carried) {
    const built = buildDispatchJob(tenantId, entry.lineNo, entry.productionJson);
    if (!built.ok) {
      return failPreparation(ctx, own.lineNo, lineRef, { error: built.error, kind: "terminal", lineNo: entry.lineNo });
    }
    // Codex round 1, P3: a Prodigi line whose SKU key does not split into
    // product, colour and size is THAT line's fault — terminal for its own
    // row, a wait (`sibling_sku_invalid`) for the others — not a refusal of
    // the whole job that would fail whichever row assembled it. The client's
    // own `sku_invalid` stays as the last resort.
    if (provider === "prodigi" && splitProdigiSkuKey(built.value.sku) === null) {
      return failPreparation(ctx, own.lineNo, lineRef, { error: "sku_invalid", kind: "terminal", lineNo: entry.lineNo });
    }
    // CP11 U7 (audit F2), the same rule: a Prodigi line without a front print
    // is THAT line's fault (terminal `front_missing` for its own row, a wait
    // for the others). Publication and checkout refuse such a line first; the
    // body builder's own `front_missing` stays as the last resort.
    if (provider === "prodigi" && !built.value.printFiles.some((file) => file.location === "front")) {
      return failPreparation(ctx, own.lineNo, lineRef, { error: "front_missing", kind: "terminal", lineNo: entry.lineNo });
    }
    targets.push({ job: built.value, lineNo: entry.lineNo });
  }

  const prepared = await printFilesForPrinter(
    ctx,
    tenantId,
    payload.orderId,
    targets,
    lineRef,
    { kind: "order" },
    // The printer order is one for all rows: if ANY row submitted it, its
    // files are the ones already sent (decidePrintFiles' rule 2).
    lines.some((entry) => entry.submittedAt !== null),
  );
  if (prepared.kind === "parked") {
    return prepared.outcome;
  }
  if (prepared.kind === "failure") {
    return failPreparation(ctx, own.lineNo, lineRef, prepared.failure);
  }

  const siblings = carried.filter((entry) => entry !== own);
  return submitPrepared(ctx, tenantId, payload, lineRef, client, {
    jobId: payload.orderId,
    lines: prepared.lines,
    order: {
      siblingItemIds: siblings.map((entry) => entry.orderItemId),
      siblingOutboxIds: lines.filter((entry) => entry !== own).map((entry) => entry.outboxId),
    },
  });
}

// ── submitting ──────────────────────────────────────────────────────────────

/**
 * Order unit: what the accepting batch also touches — the OTHER lines the job
 * carried (marked accepted with the same reference) and the other dispatch
 * rows of the order (woken to adopt it).
 */
interface OrderSubmission {
  siblingItemIds: string[];
  siblingOutboxIds: string[];
}

/**
 * The common tail of both units, unchanged in order since CP2: the parcel
 * address, the presigned files, the payment hold, claimed → submitting (with
 * the order guard for an order-unit row), the call, the record.
 */
async function submitPrepared(
  ctx: EffectContext,
  tenantId: string,
  payload: DispatchPayload,
  lineRef: LineRef,
  client: PrinterClient,
  prepared: { jobId: string; lines: ReadyLine[]; order: OrderSubmission | null },
): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;

  // D98: a shipped order's job carries where the parcel goes, read from the
  // order's frozen recipient (never from the checkout or the shop's settings).
  const shipTo = await readDispatchShipTo(env.DB, tenantId, payload.orderId);

  let job: PrinterJob;
  try {
    const presigner = resolveR2Presigner(env);
    const jobLines: PrinterJobLine[] = [];
    for (const line of prepared.lines) {
      jobLines.push({
        artworks: await Promise.all(
          line.files.map(async (file) => ({
            location: file.location,
            url: await presigner.presignGet(file.r2Key, DISPATCH_PRINT_URL_TTL_SECONDS),
          })),
        ),
        lineNo: line.lineNo,
        mockupUrls: [],
        ...(line.job.printerItem === undefined ? {} : { printerItem: line.job.printerItem }),
        quantity: line.job.quantity,
        sku: line.job.sku,
      });
    }
    job = { jobId: prepared.jobId, lines: jobLines, orderId: payload.orderId, shipTo };
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
    ...(prepared.order === null ? {} : { guard: orderSubmitGuard(tenantId, payload.orderId, row.outbox_id) }),
    now: ctx.clock(),
    withTransition: (guard) => [
      lineStateStatement(env.DB, lineRef, guard, {
        binds: [],
        sql: "dispatch_state = 'submitting'",
      }),
    ],
  });
  if (submitting === null) {
    // A cancellation landed after the claim (still ours: honour it); or, for
    // an order-unit row, a sibling is at the printer or already accepted
    // (still ours: wait, then adopt); or the claim is gone.
    const current = await readOutboxRow(env.DB, row.outbox_id);
    if (current !== null && current.status === "claimed" && current.claimed_by === claim.claimedBy) {
      if (current.cancel_requested === 1) {
        return honourCancellation(ctx, current, lineRef);
      }
      if (prepared.order !== null) {
        return retryLater(ctx, ORDER_SUBMITTING, lineRef);
      }
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

  return recordSubmitResult(ctx, lineRef, result, prepared.order);
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

/**
 * Order unit, in the accepting batch (D4.4): the OTHER lines the job carried
 * become accepted with the printer's reference — unless one meanwhile became
 * cancelled or failed (a cancellation's line is the printer_cancellation's
 * business; a failed one a human's) or already holds another reference (0022
 * never lets a reference change).
 */
function siblingLinesAcceptedStatement(
  db: D1Database,
  input: { itemIds: string[]; nowMs: number; orderId: string; printerRef: string; tenantId: string },
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE order_items
       SET dispatch_state = 'accepted',
           printer_job_ref = COALESCE(printer_job_ref, ?),
           dispatched_at = COALESCE(dispatched_at, ?)
       WHERE tenant_id = ? AND order_id = ?
         AND order_item_id IN (SELECT value FROM json_each(?))
         AND dispatch_state IS NOT 'cancelled' AND dispatch_state IS NOT 'failed'
         AND (printer_job_ref IS NULL OR printer_job_ref = ?)
         AND ${guard.sql}`,
    )
    .bind(
      input.printerRef,
      iso(input.nowMs),
      input.tenantId,
      input.orderId,
      JSON.stringify(input.itemIds),
      input.printerRef,
      ...guard.binds,
    );
}

/**
 * Order unit, in the accepting batch: the other rows of the order that wait
 * (a backoff, a canvas park, a printer park, a lost answer's re-submit)
 * become due now, so each adopts the reference on its next run instead of
 * waiting out its hold. Never a payment-held row (that hold is the money
 * path's to release) and never a row flagged for cancellation.
 */
function wakeSiblingsStatement(
  db: D1Database,
  input: { nowMs: number; orderId: string; outboxId: string; tenantId: string },
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE outbox_events
       SET next_attempt_at = ?, updated_at = MAX(updated_at, ?)
       WHERE event_type = 'dispatch' AND tenant_id = ? AND aggregate_id = ? AND outbox_id <> ?
         AND status IN ('pending', 'unknown') AND cancel_requested = 0
         AND next_attempt_at > ? AND next_attempt_at <> ${DISPATCH_HOLD_UNTIL_MS}
         AND ${guard.sql}`,
    )
    .bind(
      input.nowMs,
      input.nowMs,
      input.tenantId,
      input.orderId,
      input.outboxId,
      input.nowMs,
      ...guard.binds,
    );
}

async function recordSubmitResult(
  ctx: EffectContext,
  line: LineRef,
  submitted: PrinterSubmitResult,
  order: OrderSubmission | null,
): Promise<OutboxRunOutcome> {
  const { claim, env, row } = ctx;
  const now = ctx.clock();
  // Codex round 1, P2: for an order-unit row a lost answer of ANY row of the
  // order is a lost answer under this row's idempotency key too.
  const uncertain =
    row.unknown_since !== null ||
    (order !== null && submitted.status === "rejected" &&
      (await orderAnswerUncertain(env.DB, line.tenantId, row.aggregate_id, row.outbox_id)));
  const result = afterLostAnswer({ unknown_since: uncertain ? (row.unknown_since ?? now) : null }, submitted);

  if (result.status === "accepted" || result.status === "duplicate") {
    // CP11: a duplicate may name the printer's job (Prodigi's AlreadyExists, or
    // an adoption): then it is recorded exactly as an acceptance would be.
    const printerRef = result.printerJobId ?? null;
    const tenantId = line.tenantId;
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
        ...(order === null || printerRef === null
          ? []
          : [
              siblingLinesAcceptedStatement(
                env.DB,
                { itemIds: order.siblingItemIds, nowMs: now, orderId: row.aggregate_id, printerRef, tenantId },
                guard,
              ),
              wakeSiblingsStatement(
                env.DB,
                { nowMs: now, orderId: row.aggregate_id, outboxId: row.outbox_id, tenantId },
                guard,
              ),
            ]),
        // CP11 U7 (audit F5): the printer took the order but reports issues
        // (Prodigi's CreatedWithIssues): accepted all the same — the order
        // exists, re-submitting would only answer AlreadyExists — and ONE
        // alert per issue code, deduplicated by order + code, in this batch.
        ...(result.status !== "accepted" || result.issueCodes === undefined || printerRef === null
          ? []
          : result.issueCodes.map((code) =>
              printerOrderIssueAlertStatement(
                env.DB,
                { code, nowMs: now, orderId: row.aggregate_id, printerRef, tenantId },
                guard,
              ),
            )),
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
    if (done !== null && order !== null && printerRef !== null) {
      // A nudge of a row that is not due (or not ours to claim) is a no-op.
      await nudgeOutbox(env, order.siblingOutboxIds);
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
 * the row is done when the alert exists. A printer with a usable cancellation
 * API would call it here instead.
 *
 * CP11 (D4.6): Prodigi HAS one (`POST /v4.0/orders/{id}/actions/cancel`), but
 * it answers `ActionNotAvailable` once the order is in production (within
 * minutes), so it is NOT called: the alert stands for Prodigi too, naming the
 * printer reference `ord_…`. One Prodigi order carries every line, so a
 * cancelled multi-line order raises one alert per accepted line, each naming
 * the same `ord_…`; the human cancels it once.
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
          message: `Order ${row.aggregate_id} was cancelled after the printer accepted job ${jobId}${ref === null ? "" : ` (printer reference ${ref})`}. No cancellation was sent to the printer: SnapWear has no cancellation API, and Prodigi refuses a cancel once the order is in production (within minutes). Cancel the job with the printer by hand, or confirm that it can no longer be cancelled.`,
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
