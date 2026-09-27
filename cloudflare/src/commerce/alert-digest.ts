import type { AlertDigestContent, AlertDigestKind } from "../email/auth-email-job";
import {
  createAlertDigestEmailJob,
  deliveryIdFromKey,
  MAX_DIGEST_KINDS,
  MAX_DIGEST_RESOURCE_IDS,
} from "../email/auth-email-job";
import { recordAuthEmailDelivery } from "../email/email-delivery-store";

/**
 * The platform alert digest (DECISIONS D40, CP2-D2).
 *
 * Alerts (0017) are rows a human must look at. Every 15-minute tick (wired
 * into `scheduled()` after reconciliation, so the tick's own alerts are in it)
 * this checks whether OPEN alerts were raised since the last digest and, if so,
 * enqueues ONE `alert_digest` email to `PLATFORM_ALERT_EMAIL` through the
 * delivery ledger + EMAIL_QUEUE — the order confirmation's path.
 *
 * CONTENT: per alert kind — severity, open count, new count, oldest, up to
 * five resource ids. Never an alert's message, never an amount, never
 * customer data (auth-email-job.ts validates the shape).
 *
 * EXACTLY ONE MAIL PER BUCKET:
 *   - the delivery id is derived from the 15-minute bucket
 *     (`alert_digest:{bucketStart}`), and the content is FROZEN in
 *     platform_state (0029) at the first build of that bucket — a retried or
 *     concurrent tick re-enqueues the IDENTICAL job, which the ledger
 *     (delivery id + fingerprint over the content) sends at most once;
 *   - `last_digest_at` advances only after the queue accepted the job, and a
 *     tick that finds it already advanced for this bucket enqueues nothing;
 *   - a failed enqueue leaves `last_digest_at` where it was: the same bucket
 *     retries the frozen job, a later bucket recomputes and still counts those
 *     alerts as new.
 */

/** The digest cadence = the cron's. */
export const DIGEST_BUCKET_MS = 15 * 60 * 1_000;
/** A digest older than this is not worth mailing. */
const DIGEST_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AlertDigestStatus =
  | "already_sent"
  | "enqueue_failed"
  | "enqueued"
  | "nothing_new"
  | "queue_unconfigured"
  | "unconfigured";

export interface AlertDigestSummary {
  deliveryId?: string;
  newAlerts?: number;
  status: AlertDigestStatus;
}

interface PlatformStateRow {
  digest_bucket_start: string | null;
  digest_computed_at: string | null;
  digest_json: string | null;
  last_digest_at: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function log(level: "info" | "warn", message: string, fields: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ message, ...fields }));
}

/** The configured platform address, or null (absent / not an address). */
function platformAlertEmail(env: Env): string | null {
  const value = env.PLATFORM_ALERT_EMAIL;
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(email) && email.length <= 254 ? email : null;
}

async function readState(db: D1Database): Promise<PlatformStateRow> {
  const row = await db
    .prepare(
      `SELECT last_digest_at, digest_bucket_start, digest_computed_at, digest_json
       FROM platform_state WHERE id = 1 LIMIT 1`,
    )
    .first<PlatformStateRow>();
  if (row === null) {
    // 0029 inserts the row; its absence is a schema fault, not a state.
    throw new Error("platform_state row is missing");
  }
  return row;
}

const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END`;

/** The open alerts, grouped by kind; `since` = "" counts every one as new. */
export async function readDigestContent(
  db: D1Database,
  since: string,
  bucketStart: string,
): Promise<AlertDigestContent> {
  const [groups, totals, resources] = await db.batch([
    db
      .prepare(
        `SELECT kind,
                COUNT(*) AS n,
                SUM(CASE WHEN created_at > ?1 THEN 1 ELSE 0 END) AS new_n,
                MIN(created_at) AS oldest,
                MAX(${SEVERITY_RANK}) AS sev
         FROM alerts
         WHERE resolved_at IS NULL
         GROUP BY kind
         ORDER BY sev DESC, oldest ASC, kind ASC
         LIMIT ?2`,
      )
      .bind(since, MAX_DIGEST_KINDS),
    db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS new_n,
                COUNT(DISTINCT kind) AS kinds
         FROM alerts WHERE resolved_at IS NULL`,
      )
      .bind(since),
    db.prepare(
      `SELECT kind, resource_id FROM (
         SELECT kind, resource_id,
                ROW_NUMBER() OVER (PARTITION BY kind ORDER BY created_at, id) AS rn
         FROM alerts
         WHERE resolved_at IS NULL AND resource_id IS NOT NULL
       )
       WHERE rn <= ${MAX_DIGEST_RESOURCE_IDS}
       ORDER BY kind, rn`,
    ),
  ]);

  const byKind = new Map<string, string[]>();
  for (const row of (resources?.results ?? []) as Array<{ kind: string; resource_id: string }>) {
    byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row.resource_id]);
  }
  const severity = (value: number): AlertDigestKind["severity"] =>
    value >= 3 ? "critical" : value === 2 ? "warning" : "info";
  const kinds = ((groups?.results ?? []) as Array<{
    kind: string;
    n: number;
    new_n: number;
    oldest: string;
    sev: number;
  }>).map((row) => ({
    count: row.n,
    kind: row.kind,
    newCount: row.new_n,
    oldestAt: row.oldest,
    resourceIds: byKind.get(row.kind) ?? [],
    severity: severity(row.sev),
  }));
  const total = (totals?.results?.[0] ?? { kinds: 0, n: 0, new_n: 0 }) as {
    kinds: number;
    n: number;
    new_n: number;
  };

  return {
    bucketStart,
    kinds,
    newCount: total.new_n,
    omittedKinds: Math.max(0, total.kinds - kinds.length),
    openCount: total.n,
  };
}

/**
 * One digest tick. Returns what it did; throws only on a D1 fault (the next
 * tick retries).
 */
export async function runAlertDigest(env: Env, now: number): Promise<AlertDigestSummary> {
  const recipient = platformAlertEmail(env);
  if (recipient === null) {
    log("info", "alert digest skipped: PLATFORM_ALERT_EMAIL is not set");
    return { status: "unconfigured" };
  }
  const queue = env.EMAIL_QUEUE;
  if (queue === undefined) {
    log("warn", "alert digest skipped: EMAIL_QUEUE is not bound");
    return { status: "queue_unconfigured" };
  }

  const db = env.DB;
  const bucketStart = iso(Math.floor(now / DIGEST_BUCKET_MS) * DIGEST_BUCKET_MS);
  let state = await readState(db);
  let newAlerts: number | undefined;

  if (state.digest_bucket_start !== bucketStart) {
    const content = await readDigestContent(db, state.last_digest_at ?? "", bucketStart);
    if (content.newCount === 0) {
      return { status: "nothing_new" };
    }
    newAlerts = content.newCount;

    // Freeze it; the first writer of this bucket wins and every other build
    // of the bucket uses what it froze. Only ever forward: a late tick of an
    // older bucket can never replace a newer bucket's digest.
    const computedAt = iso(now);
    await db
      .prepare(
        `UPDATE platform_state
         SET digest_bucket_start = ?1, digest_computed_at = ?2, digest_json = ?3,
             updated_at = MAX(updated_at, ?2)
         WHERE id = 1 AND (digest_bucket_start IS NULL OR digest_bucket_start < ?1)`,
      )
      .bind(bucketStart, computedAt, JSON.stringify(content))
      .run();
    state = await readState(db);
  }

  if (
    state.digest_bucket_start !== bucketStart ||
    state.digest_computed_at === null ||
    state.digest_json === null
  ) {
    // Another tick froze a LATER bucket in between: this one is superseded.
    return { status: "already_sent" };
  }
  if (state.last_digest_at !== null && state.last_digest_at >= state.digest_computed_at) {
    // This bucket's digest is already with the queue.
    return { status: "already_sent" };
  }

  const createdAt = Date.parse(state.digest_computed_at);
  const job = createAlertDigestEmailJob({
    createdAt,
    deliveryId: await deliveryIdFromKey(`alert_digest:${bucketStart}`),
    digest: JSON.parse(state.digest_json) as AlertDigestContent,
    expiresAt: createdAt + DIGEST_LIFETIME_MS,
    recipient,
  });
  newAlerts = newAlerts ?? job.digest.newCount;

  // The producer half of the ledger, BEFORE the queue (as for auth mails).
  await recordAuthEmailDelivery(db, job, now);
  try {
    await queue.send(job, { contentType: "json" });
  } catch {
    log("warn", "alert digest could not be enqueued; the next tick retries", {
      deliveryId: job.deliveryId,
    });
    return { deliveryId: job.deliveryId, newAlerts, status: "enqueue_failed" };
  }

  await db
    .prepare(
      `UPDATE platform_state
       SET last_digest_at = ?1, updated_at = MAX(updated_at, ?2)
       WHERE id = 1 AND digest_bucket_start = ?3
         AND (last_digest_at IS NULL OR last_digest_at < ?1)`,
    )
    .bind(state.digest_computed_at, iso(now), bucketStart)
    .run();

  return { deliveryId: job.deliveryId, newAlerts, status: "enqueued" };
}
