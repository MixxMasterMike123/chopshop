/**
 * CP13 A4 (design §6.2, §12; Codex audit CX-B7) — the bounded sweep of objects
 * nothing will ever use. Two kinds of row are swept:
 *
 *   - a reservation that never landed: `pending` for more than
 *     PENDING_OBJECT_MAX_AGE_MS (7 days). Nothing ever served it; before this
 *     sweep nothing ever removed it.
 *   - (round 1) an affiliate invoice that landed but was never attached: an
 *     ACTIVE `document` listed in `affiliate_invoice_objects`, unchanged for
 *     more than UNATTACHED_INVOICE_MAX_AGE_MS (30 days), that no payout names.
 *     An affiliate whose requests were refused would otherwise keep it in the
 *     5-loose-invoice cap (object-routes.ts AFFILIATE_INVOICE_MAX_LOOSE)
 *     forever.
 *
 * NEVER SWEPT: an immutable row (frozen by a payout request or paid state), or
 * a row anything names by id — every holder in OBJECT_ID_HOLDERS (each
 * REFERENCES stored_objects in the migrations, plus affiliate_payouts'
 * invoice column, which has no foreign key) and the store identity's branding
 * ids (tenant_settings.store_identity_json; 0032 keeps them in JSON, so the
 * guard is a substring test — it can only spare a row, never sweep a named
 * one). test/object-sweep.test.ts walks `pragma_foreign_key_list` of every
 * table, so a future foreign key to stored_objects that this list lacks fails
 * the suite instead of losing data.
 *
 * HOW, per tick (the 15-minute cron, outbox/scheduled.ts CP13_STEPS), at most
 * OBJECT_SWEEP_BATCH rows in all, in the D93 order of deleteAdminObject:
 *   0. RETRIES first: rows this sweep tombstoned whose bytes were not yet
 *      confirmed gone (an `object.sweep` audit row and no `object.bytes_deleted`
 *      one), so a failed R2 delete is retried every tick until it succeeds;
 *      and (round 2) any deleted row whose newest `object.bytes_orphaned` row
 *      is later than its newest `object.bytes_deleted` one — bytes a late
 *      invoice upload wrote after the sweep and could not remove — which get
 *      their key deleted again and a fresh `object.bytes_deleted` row.
 *   1. one batch: the new rows are TOMBSTONED (`status = 'deleted'`, each guard
 *      re-checked inside the UPDATE), with an `object.sweep` audit row each
 *      (reason `pending_expired` or `unattached_invoice`). From here the
 *      upload leg refuses a pending reservation and a payout request refuses
 *      the invoice (both need their exact prior status).
 *   2. the bytes are deleted from the bucket the row names (private / public;
 *      `temp` has no binding and holds nothing). A key that holds nothing is a
 *      no-op in R2.
 *   3. one batch, for the rows whose bytes are gone: an `object.bytes_deleted`
 *      audit row each (the marker step 0 reads), then the rows are DELETED with
 *      an `object.purge` audit row each — except a row listed in
 *      `affiliate_invoice_objects`: that listing is append-only with a
 *      RESTRICT foreign key (0059), so the row stays as a tombstone. A
 *      tombstone is not loose (the cap counts `status <> 'deleted'`), is never
 *      served, and no payout can name it (a request needs an ACTIVE object).
 *
 * A bucket delete that fails (or a missing binding) leaves the row tombstoned
 * with its key; the step then fails so the cron run shows it, and step 0
 * takes the row again next tick. Nothing here logs an id or a key: one line of
 * counts per tick that did anything.
 */

/** A reservation older than this that never landed is swept. */
export const PENDING_OBJECT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** A listed affiliate invoice no payout names, unchanged this long, is swept. */
export const UNATTACHED_INVOICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/** At most this many rows per tick, retries included. */
export const OBJECT_SWEEP_BATCH = 100;

/**
 * Every column that names a `stored_objects` row by id. `foreignKey` marks a
 * REFERENCES stored_objects (test/object-sweep.test.ts checks this list
 * against `pragma_foreign_key_list` of every table). Every holder has a
 * `tenant_id`, which the guard uses with the id.
 */
export const OBJECT_ID_HOLDERS: ReadonlyArray<{ column: string; foreignKey: boolean; table: string }> = [
  { column: "original_object_id", foreignKey: true, table: "pod_artwork" },
  { column: "object_id", foreignKey: true, table: "product_images" },
  { column: "image_object_id", foreignKey: true, table: "collections" },
  { column: "image_object_id", foreignKey: true, table: "pages" },
  { column: "invoice_object_id", foreignKey: false, table: "affiliate_payouts" },
];

/**
 * The one other foreign key to stored_objects: the affiliate invoice listing.
 * It never spares a row from the tombstone (a listed invoice is exactly what
 * the cap needs freed); it keeps the row from being deleted.
 */
export const INVOICE_LISTING = { column: "object_id", table: "affiliate_invoice_objects" } as const;

export interface ObjectSweepResult {
  /** Rows bytes could not be removed for (they stay tombstoned and are retried). */
  byteFailures: number;
  /** Rows deleted outright (step 3). */
  purged: number;
  /** Rows kept as tombstones because an affiliate invoice listing names them. */
  retained: number;
  /** Tombstones of earlier ticks taken again because their bytes were not confirmed gone. */
  retried: number;
  /** Rows tombstoned this tick (step 1). */
  swept: number;
}

/** True when nothing names the object `o` by id. Every statement repeats it. */
const UNREFERENCED_SQL = [
  ...OBJECT_ID_HOLDERS.map(
    (holder) => `NOT EXISTS (SELECT 1 FROM ${holder.table} WHERE tenant_id = o.tenant_id AND ${holder.column} = o.object_id)`,
  ),
  `NOT EXISTS (
    SELECT 1 FROM tenant_settings
    WHERE tenant_id = o.tenant_id AND instr(store_identity_json, o.object_id) > 0
  )`,
].join("\n  AND ");

const LISTED_SQL = `EXISTS (SELECT 1 FROM ${INVOICE_LISTING.table} WHERE ${INVOICE_LISTING.column} = o.object_id)`;

/** Binds: the pending cutoff, the unattached-invoice cutoff (both epoch ms). */
const DUE_SQL = `o.immutable = 0
  AND ((o.status = 'pending' AND o.created_at < ?)
    OR (o.status = 'active' AND o.kind = 'document' AND o.bucket = 'private' AND ${LISTED_SQL} AND o.updated_at < ?))
  AND ${UNREFERENCED_SQL}`;

function auditedSql(action: string): string {
  return `EXISTS (
    SELECT 1 FROM audit_events
    WHERE resource_type = 'stored_object' AND resource_id = o.object_id AND action = '${action}'
  )`;
}

/**
 * Round 2 (A1 Codex round 4, finding 5): the object's NEWEST `object.bytes_orphaned`
 * row is later than its newest `object.bytes_deleted` one — a late invoice upload
 * that lost the race with this sweep wrote bytes after the sweep deleted the key,
 * and could not delete them itself (object-routes.ts releaseLateInvoiceBytes).
 * "Later" is (created_at, rowid): audit_events is append-only (0001), so among
 * rows of one millisecond the higher rowid was written later. Written as "an
 * orphan row that no `bytes_deleted` row follows".
 */
const ORPHAN_NEWER_SQL = `EXISTS (
    SELECT 1 FROM audit_events AS orphan
    WHERE orphan.resource_type = 'stored_object' AND orphan.resource_id = o.object_id
      AND orphan.action = 'object.bytes_orphaned'
      AND NOT EXISTS (
        SELECT 1 FROM audit_events AS cleared
        WHERE cleared.resource_type = 'stored_object' AND cleared.resource_id = o.object_id
          AND cleared.action = 'object.bytes_deleted'
          AND (cleared.created_at > orphan.created_at
            OR (cleared.created_at = orphan.created_at AND cleared.rowid > orphan.rowid))
      )
  )`;

/**
 * A fresh `bytes_deleted` row is stamped no earlier than the newest orphan row,
 * so an orphan stamped by a clock ahead of this one is still cleared by it
 * (the equal-time case falls to rowid, and this row is written later).
 */
const BYTES_DELETED_AT_SQL = `MAX(?, COALESCE((
    SELECT MAX(orphan.created_at) FROM audit_events AS orphan
    WHERE orphan.resource_type = 'stored_object' AND orphan.resource_id = o.object_id
      AND orphan.action = 'object.bytes_orphaned'
  ), 0))`;

interface ObjectRow {
  bucket: "private" | "public" | "temp";
  object_id: string;
  object_key: string;
}

function binding(env: Env, bucket: ObjectRow["bucket"]): R2Bucket | undefined | null {
  if (bucket === "private") {
    return env.PRIVATE_BUCKET;
  }
  // `temp` has no binding (object-routes.ts bucketBinding): nothing to delete.
  return bucket === "public" ? env.PUBLIC_BUCKET : null;
}

function auditStatement(
  db: D1Database,
  action: "object.bytes_deleted" | "object.purge" | "object.sweep",
  reason: string,
  ids: string[],
  requestId: string,
  now: number,
  where: string,
  binds: unknown[],
  createdAtSql = "?",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       )
       SELECT lower(hex(randomblob(16))), o.tenant_id, NULL, ?, 'stored_object', o.object_id, ?,
              json_object('kind', o.kind, 'bucket', o.bucket, 'reason', ?, 'listed', ${LISTED_SQL}), ${createdAtSql}
       FROM stored_objects AS o
       WHERE o.object_id IN (SELECT value FROM json_each(?)) AND ${where}`,
    )
    .bind(action, requestId, reason, now, JSON.stringify(ids), ...binds);
}

export async function sweepPendingObjects(env: Env, now: number): Promise<ObjectSweepResult> {
  const db = env.DB;
  const pendingCutoff = now - PENDING_OBJECT_MAX_AGE_MS;
  const invoiceCutoff = now - UNATTACHED_INVOICE_MAX_AGE_MS;
  const result: ObjectSweepResult = { byteFailures: 0, purged: 0, retained: 0, retried: 0, swept: 0 };
  const requestId = crypto.randomUUID();

  // 0. Retries: tombstoned by this sweep, bytes not confirmed gone.
  const retries = (
    await db
      .prepare(
        `SELECT o.object_id, o.bucket, o.object_key
         FROM stored_objects AS o
         WHERE o.bucket IN ('private', 'public', 'temp') AND o.status = 'deleted' AND o.immutable = 0
           AND ((${auditedSql("object.sweep")} AND NOT ${auditedSql("object.bytes_deleted")})
             OR ${ORPHAN_NEWER_SQL})
         ORDER BY o.updated_at, o.object_id
         LIMIT ${OBJECT_SWEEP_BATCH}`,
      )
      .all<ObjectRow>()
  ).results;
  result.retried = retries.length;

  // 1. New rows, in what room is left; tombstoned, guarded again row by row.
  const room = OBJECT_SWEEP_BATCH - retries.length;
  let tombstoned: ObjectRow[] = [];
  if (room > 0) {
    const due = (
      await db
        .prepare(
          `SELECT o.object_id, o.status
           FROM stored_objects AS o
           WHERE o.bucket IN ('private', 'public', 'temp') AND o.status IN ('pending', 'active')
             AND ${DUE_SQL}
           ORDER BY o.created_at, o.object_id
           LIMIT ${room}`,
        )
        .bind(pendingCutoff, invoiceCutoff)
        .all<{ object_id: string; status: string }>()
    ).results;
    if (due.length > 0) {
      const pendingIds = due.filter((row) => row.status === "pending").map((row) => row.object_id);
      const activeIds = due.filter((row) => row.status === "active").map((row) => row.object_id);
      // The audits run after the UPDATE in the same transaction, so
      // `status = 'deleted' AND updated_at = now` among these ids names
      // exactly the rows this UPDATE moved (no writer runs between two
      // statements of a batch).
      const movedNow = "o.status = 'deleted' AND o.updated_at = ?";
      const [moved] = await db.batch([
        db
          .prepare(
            `UPDATE stored_objects AS o
             SET status = 'deleted', updated_at = ?
             WHERE o.object_id IN (SELECT value FROM json_each(?)) AND ${DUE_SQL}
             RETURNING object_id, bucket, object_key`,
          )
          .bind(now, JSON.stringify(due.map((row) => row.object_id)), pendingCutoff, invoiceCutoff),
        auditStatement(db, "object.sweep", "pending_expired", pendingIds, requestId, now, movedNow, [now]),
        auditStatement(db, "object.sweep", "unattached_invoice", activeIds, requestId, now, movedNow, [now]),
      ]);
      tombstoned = (moved?.results ?? []) as ObjectRow[];
    }
  }
  result.swept = tombstoned.length;
  const rows = [...retries, ...tombstoned];
  if (rows.length === 0) {
    return result;
  }

  // 2. The bytes, per bucket (one call each; R2 takes up to 1 000 keys).
  const gone: string[] = [];
  for (const bucket of ["private", "public", "temp"] as const) {
    const inBucket = rows.filter((row) => row.bucket === bucket);
    if (inBucket.length === 0) {
      continue;
    }
    const target = binding(env, bucket);
    if (target === null) {
      gone.push(...inBucket.map((row) => row.object_id));
      continue;
    }
    if (target === undefined) {
      result.byteFailures += inBucket.length;
      continue;
    }
    try {
      await target.delete(inBucket.map((row) => row.object_key));
      gone.push(...inBucket.map((row) => row.object_id));
    } catch {
      result.byteFailures += inBucket.length;
    }
  }

  // 3. Mark the bytes gone, then delete the rows — never one an affiliate
  //    invoice listing names (append-only, RESTRICT: it stays a tombstone).
  if (gone.length > 0) {
    const purgeable = `o.status = 'deleted' AND o.immutable = 0 AND NOT ${LISTED_SQL} AND ${UNREFERENCED_SQL}`;
    const [, , purged] = await db.batch([
      auditStatement(
        db,
        "object.bytes_deleted",
        "swept",
        gone,
        requestId,
        now,
        `o.status = 'deleted' AND (NOT ${auditedSql("object.bytes_deleted")} OR ${ORPHAN_NEWER_SQL})`,
        [],
        BYTES_DELETED_AT_SQL,
      ),
      auditStatement(db, "object.purge", "swept", gone, requestId, now, purgeable, []),
      db
        .prepare(`DELETE FROM stored_objects AS o WHERE o.object_id IN (SELECT value FROM json_each(?)) AND ${purgeable}`)
        .bind(JSON.stringify(gone)),
    ]);
    result.purged = purged?.meta.changes ?? 0;
    result.retained = gone.length - result.purged;
  }

  console.log(JSON.stringify({ message: "object sweep", ...result }));
  if (result.byteFailures > 0) {
    throw new Error(`object sweep: ${result.byteFailures} object(s) kept their bytes (retried next tick)`);
  }
  return result;
}
