/**
 * CP13 — the outbox rows of the affiliate mails (design §9). Each is an
 * outbox `email` row written IN the batch of the change it reports (the
 * apply, the decision, the order, the reversal, the payout), ids only — the
 * effect (src/outbox/email-effect.ts → src/email/affiliate-emails.ts) reads
 * the rest, freezes the shop's name and support address at its first build,
 * and hands one job to the `-email` queue. Never a recipient, a name or an
 * amount in the row (D68).
 *
 *   kind                              aggregate               payload
 *   affiliate_application_received    affiliate_application   { kind, applicationId }
 *   affiliate_application_notice      affiliate_application   { kind, applicationId }
 *   affiliate_application_denied      affiliate_application   { kind, applicationId }
 *   affiliate_welcome                 affiliate               { kind, affiliateId }
 *   affiliate_conversion              order                   { kind, orderId }
 *   affiliate_reversal                order                   { kind, orderId, entryId }
 *   affiliate_payout                  affiliate_payout        { kind, payoutId }
 *   affiliate_payout_requested        affiliate_payout        { kind, payoutId }
 *
 * The conversion row is written by the webhook's own outbox helper and the
 * reversal row by ledger.ts (both in money batches); every other one here.
 * This module imports nothing.
 */

export const AFFILIATE_EMAIL_KINDS = [
  "affiliate_application_denied",
  "affiliate_application_notice",
  "affiliate_application_received",
  "affiliate_conversion",
  "affiliate_payout",
  "affiliate_payout_requested",
  "affiliate_reversal",
  "affiliate_welcome",
] as const;
export type AffiliateEmailKind = (typeof AFFILIATE_EMAIL_KINDS)[number];

export function isAffiliateEmailKind(value: unknown): value is AffiliateEmailKind {
  return (AFFILIATE_EMAIL_KINDS as readonly unknown[]).includes(value);
}

export type AffiliateMailAggregate = "affiliate" | "affiliate_application" | "affiliate_payout" | "order";

export interface MailGuard {
  binds: unknown[];
  sql: string;
}

export interface AffiliateMailRow {
  aggregateId: string;
  aggregateType: AffiliateMailAggregate;
  /** Unique per mail: a retry of the same change is the same row. */
  dedupeKey: string;
  /** Only when this holds is the row written (the change's own stamp). */
  guard?: MailGuard;
  kind: AffiliateEmailKind;
  now: number;
  payload: Record<string, string>;
  tenantId: string;
}

/**
 * One outbox `email` row, written only under `guard`, never aborting its
 * batch (DO NOTHING on any conflict). Returns the statement and the row's id
 * (for the post-commit nudge).
 */
export function affiliateMailStatement(
  db: D1Database,
  row: AffiliateMailRow,
): { outboxId: string; statement: D1PreparedStatement } {
  const outboxId = crypto.randomUUID();
  const payload = JSON.stringify({ ...row.payload, kind: row.kind });
  return {
    outboxId,
    statement: db
      .prepare(
        `INSERT INTO outbox_events (
           outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
           dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
         )
         SELECT ?, ?, 'email', ?, ?, ?, ?, 'pending', ?, ?, ?
         WHERE ${row.guard?.sql ?? "1"}
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        outboxId,
        row.tenantId,
        row.aggregateType,
        row.aggregateId,
        row.dedupeKey,
        payload,
        row.now,
        row.now,
        row.now,
        ...(row.guard?.binds ?? []),
      ),
  };
}
