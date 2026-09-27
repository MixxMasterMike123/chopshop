import {
  canonicalOrderContent,
  hashEmailRecipient,
  type AuthEmailJob,
} from "./auth-email-job";

const LEASE_DURATION_MS = 60_000;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

interface DeliveryRow {
  attempts: number;
  expires_at: number;
  job_fingerprint: string | null;
  lease_until: number | null;
  max_attempts: number;
  next_attempt_at: number;
  status: string;
}

export type EmailDeliveryClaim =
  | { leaseToken: string; status: "claimed" }
  | { status: "conflict" | "expired" | "missing" | "not_claimed" | "terminal" };

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function fingerprintAuthEmailJob(job: AuthEmailJob): Promise<string> {
  const canonical = JSON.stringify({
    actionUrl: job.actionUrl,
    createdAt: job.createdAt,
    deliveryId: job.deliveryId,
    expiresAt: job.expiresAt,
    kind: job.kind,
    locale: job.locale,
    recipient: job.recipient,
    tenantId: job.tenantId ?? null,
    version: job.version,
    // An order confirmation's rendered content is part of the job it is. The
    // key is ABSENT for the auth kinds, so their canonical string — and every
    // fingerprint already in a ledger — is byte-identical to before.
    ...(job.kind === "order_confirmation" ? { order: canonicalOrderContent(job.order) } : {}),
  });
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
}

function insertPendingStatement(
  db: D1Database,
  job: AuthEmailJob,
  recipientHash: string,
  fingerprint: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO email_deliveries (
      delivery_id, tenant_id, kind, recipient_hash, status, attempts,
      max_attempts, next_attempt_at, expires_at, created_at, updated_at,
      job_fingerprint
    ) VALUES (?, ?, ?, ?, 'pending', 0, 8, ?, ?, ?, ?, ?)
    ON CONFLICT(delivery_id) DO NOTHING`,
  ).bind(
    job.deliveryId,
    job.tenantId ?? null,
    job.kind,
    recipientHash,
    now,
    job.expiresAt,
    job.createdAt,
    Math.max(now, job.createdAt),
    fingerprint,
  );
}

/**
 * Records a delivery in the ledger BEFORE its job is enqueued.
 *
 * The producer half of the ledger: the row exists, `pending`, bound to the
 * job's fingerprint, from the moment the job is handed to the queue — so an
 * operator can see a delivery that was requested but never delivered, and the
 * consumer's claim will refuse a queue message whose body does not match what
 * the producer recorded. Idempotent: re-recording the same job is a no-op, and
 * the consumer's claim performs the same insert-if-absent, so a job that
 * somehow reached the queue unrecorded is still ledgered on first claim.
 */
export async function recordAuthEmailDelivery(
  db: D1Database,
  job: AuthEmailJob,
  now: number,
): Promise<void> {
  const [recipientHash, fingerprint] = await Promise.all([
    hashEmailRecipient(job.recipient),
    fingerprintAuthEmailJob(job),
  ]);
  await insertPendingStatement(db, job, recipientHash, fingerprint, now).run();
}

/**
 * Closes a recorded delivery whose job never reached the queue.
 *
 * Only a row nobody has claimed yet (`pending`, zero attempts) can be
 * abandoned, so this can never race a consumer that did receive the message.
 * Without it a failed enqueue would leave a `pending` row that no consumer
 * will ever see — the ledger holds no recipient, so nothing could resend it.
 */
export async function abandonAuthEmailDelivery(
  db: D1Database,
  deliveryId: string,
  errorCode: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE email_deliveries
       SET status = 'failed', resolved_at = ?, last_error_code = ?,
           updated_at = MAX(updated_at, ?)
       WHERE delivery_id = ?
         AND status = 'pending'
         AND attempts = 0`,
    )
    .bind(
      now,
      ERROR_CODE_PATTERN.test(errorCode) ? errorCode : "E_UNKNOWN",
      now,
      deliveryId,
    )
    .run();
  return result.meta.changes === 1;
}

export async function claimAuthEmailDelivery(
  db: D1Database,
  job: AuthEmailJob,
  now: number,
): Promise<EmailDeliveryClaim> {
  const [recipientHash, fingerprint] = await Promise.all([
    hashEmailRecipient(job.recipient),
    fingerprintAuthEmailJob(job),
  ]);
  const leaseToken = crypto.randomUUID();
  const leaseUntil = now + LEASE_DURATION_MS;

  const [, claimResult] = await db.batch([
    insertPendingStatement(db, job, recipientHash, fingerprint, now),
    db.prepare(
      `UPDATE email_deliveries
       SET status = 'processing',
           attempts = attempts + 1,
           lease_token = ?,
           lease_until = ?,
           updated_at = ?
       WHERE delivery_id = ?
         AND job_fingerprint = ?
         AND expires_at > ?
         AND attempts < max_attempts
         AND (
           (status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'processing' AND lease_until <= ?)
         )`,
    ).bind(
      leaseToken,
      leaseUntil,
      now,
      job.deliveryId,
      fingerprint,
      now,
      now,
      now,
    ),
  ]);

  if (claimResult === undefined) {
    throw new Error("Email delivery claim did not return a result");
  }
  if (claimResult.meta.changes === 1) {
    return { leaseToken, status: "claimed" };
  }

  const row = await db
    .prepare(
      `SELECT status, attempts, max_attempts, next_attempt_at, lease_until,
              expires_at, job_fingerprint
       FROM email_deliveries
       WHERE delivery_id = ?
       LIMIT 1`,
    )
    .bind(job.deliveryId)
    .first<DeliveryRow>();

  if (row === null) {
    return { status: "missing" };
  }
  if (row.job_fingerprint !== fingerprint) {
    return { status: "conflict" };
  }
  if (row.expires_at <= now) {
    await db
      .prepare(
        `UPDATE email_deliveries
         SET status = 'expired', resolved_at = ?, lease_token = NULL,
             lease_until = NULL, updated_at = ?
         WHERE delivery_id = ?
           AND status IN ('pending', 'processing')
           AND expires_at <= ?`,
      )
      .bind(now, now, job.deliveryId, now)
      .run();
    return { status: "expired" };
  }
  if (
    row.attempts >= row.max_attempts &&
    (row.status === "pending" ||
      (row.status === "processing" && (row.lease_until ?? 0) <= now))
  ) {
    await db
      .prepare(
        `UPDATE email_deliveries
         SET status = 'failed', resolved_at = ?, lease_token = NULL,
             lease_until = NULL, updated_at = ?
         WHERE delivery_id = ?
           AND attempts >= max_attempts
           AND (
             status = 'pending'
             OR (status = 'processing' AND lease_until <= ?)
           )`,
      )
      .bind(now, now, job.deliveryId, now)
      .run();
    return { status: "terminal" };
  }
  if (["sent", "failed", "expired"].includes(row.status)) {
    return { status: "terminal" };
  }
  return { status: "not_claimed" };
}

export async function completeAuthEmailDelivery(
  db: D1Database,
  deliveryId: string,
  leaseToken: string,
  // Null when the provider accepted the message without a readable id; the
  // row is still `sent` — resending to learn the id would email twice.
  providerMessageId: string | null,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE email_deliveries
       SET status = 'sent', provider_message_id = ?, resolved_at = ?,
           lease_token = NULL, lease_until = NULL, last_error_code = NULL,
           updated_at = ?
       WHERE delivery_id = ?
         AND status = 'processing'
         AND lease_token = ?`,
    )
    .bind(providerMessageId, now, now, deliveryId, leaseToken)
    .run();
  return result.meta.changes === 1;
}

/**
 * Terminally fails a claimed delivery — the provider refused the message
 * itself (a 4xx that no retry can fix). Lease-guarded like completion, so only
 * the consumer holding the claim can close it.
 */
export async function failAuthEmailDelivery(
  db: D1Database,
  deliveryId: string,
  leaseToken: string,
  errorCode: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE email_deliveries
       SET status = 'failed', resolved_at = ?, lease_token = NULL,
           lease_until = NULL, last_error_code = ?, updated_at = ?
       WHERE delivery_id = ?
         AND status = 'processing'
         AND lease_token = ?`,
    )
    .bind(
      now,
      ERROR_CODE_PATTERN.test(errorCode) ? errorCode : "E_UNKNOWN",
      now,
      deliveryId,
      leaseToken,
    )
    .run();
  return result.meta.changes === 1;
}

export async function retryAuthEmailDelivery(
  db: D1Database,
  deliveryId: string,
  leaseToken: string,
  errorCode: string,
  nextAttemptAt: number,
  now: number,
): Promise<boolean> {
  const safeErrorCode = ERROR_CODE_PATTERN.test(errorCode)
    ? errorCode
    : "E_UNKNOWN";
  const result = await db
    .prepare(
      `UPDATE email_deliveries
       SET status = CASE
             WHEN expires_at <= ? THEN 'expired'
             WHEN attempts >= max_attempts THEN 'failed'
             ELSE 'pending'
           END,
           next_attempt_at = ?,
           resolved_at = CASE
             WHEN expires_at <= ? OR attempts >= max_attempts THEN ?
             ELSE NULL
           END,
           lease_token = NULL,
           lease_until = NULL,
           last_error_code = ?,
           updated_at = ?
       WHERE delivery_id = ?
         AND status = 'processing'
         AND lease_token = ?`,
    )
    .bind(
      nextAttemptAt,
      nextAttemptAt,
      nextAttemptAt,
      now,
      safeErrorCode,
      now,
      deliveryId,
      leaseToken,
    )
    .run();
  return result.meta.changes === 1;
}
