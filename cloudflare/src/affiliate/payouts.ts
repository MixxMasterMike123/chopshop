import type { AffiliatePrincipal, TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { markObjectImmutableStatements } from "../storage/object-store";
import { parseIdSegment, parseText } from "./affiliates";
import { balanceIn, payableAtLeastSql, readBalances } from "./ledger";
import { affiliateMailStatement } from "./mail";
import { readCurrentAffiliateTerms } from "./terms";

/**
 * CP13 — the payout, manual rail (design §6.1–§6.2, A9). The money moves
 * OUTSIDE the system (bank, Swish), exactly as in Firebase §3.7; the port
 * records it as a reserve-first state machine and never deletes:
 *
 *   requested  RESERVES: the payout row is written only while the affiliate's
 *              payable balance in that currency covers it — computed INSIDE
 *              the batch (ledger.ts payableAtLeastSql) — and the ledger's
 *              `payout` row (−amount) only when that payout row exists (one
 *              decision, one guard, R2-Q5). One open request per affiliate
 *              (0059's partial unique index): a racing second request, or the
 *              shop's record while a request is open, is `payout_open`.
 *   paid       the shop's recorded EVIDENCE of a payment it made (who, when,
 *              its reference). A request is never treated as a payment; an
 *              uploaded invoice is never treated as one.
 *   void       released by a compensating `payout_void` row (+amount), in the
 *              batch that sets `void`.
 *
 * NO STRIPE CALL ANYWHERE: `rail` is always 'manual' here; the Connect rail
 * (design §6.3) is unit A5, after the sandbox proof.
 *
 * A NEGATIVE BALANCE (a commission paid out and later reversed) makes the
 * payable amount 0: no request lands until later earnings cover it (§3.6's
 * claw-back, recorded, not pursued).
 */

export const PAYOUT_LIST_LIMIT = 50;
const MAX_PAYOUT_LIST_LIMIT = 100;
/** No single payout of more than this (a typo guard: 1 000 000 kr). */
export const MAX_PAYOUT_MINOR = 100_000_000;

export interface RequestPayoutInput {
  amountMinor: number | null;
  invoiceNumber: string | null;
  invoiceObjectId: string | null;
}

const REQUEST_KEYS = ["amountMinor", "invoiceNumber", "invoiceObjectId"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAmount(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_PAYOUT_MINOR
    ? value
    : undefined;
}

/** `{ amountMinor?, invoiceObjectId?, invoiceNumber? }` (the amount defaults to the payable). */
export function parseRequestPayoutInput(body: unknown): RequestPayoutInput | null {
  if (body === null || body === undefined) {
    return { amountMinor: null, invoiceNumber: null, invoiceObjectId: null };
  }
  if (!isPlainObject(body) || !Object.keys(body).every((key) => (REQUEST_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const amountMinor = parseAmount(body.amountMinor);
  const invoiceNumber = parseText(body.invoiceNumber, 50);
  const invoiceObjectId =
    body.invoiceObjectId === undefined || body.invoiceObjectId === null
      ? null
      : typeof body.invoiceObjectId === "string"
        ? parseIdSegment(body.invoiceObjectId)
        : undefined;
  if (amountMinor === undefined || invoiceNumber === undefined || invoiceObjectId === undefined) {
    return null;
  }
  return { amountMinor, invoiceNumber, invoiceObjectId };
}

export type PayoutRefusal =
  | "insufficient_balance"
  | "invalid_invoice"
  | "payout_not_open"
  | "payout_open"
  | "profile_incomplete"
  | "terms_required";

export type PayoutResult =
  | { outboxIds: string[]; payoutId: string; status: "ok" }
  | { reason: PayoutRefusal; status: "refused" }
  | { status: "not_found" };

function isOpenRequestConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed: affiliate_payouts.tenant_id, affiliate_payouts.affiliate_id");
}

interface PayoutAffiliate {
  address_line1: string | null;
  city: string | null;
  currency: string;
  name: string;
  postal_code: string | null;
  terms_version: string | null;
}

async function readPayoutAffiliate(db: D1Database, tenantId: string, affiliateId: string): Promise<PayoutAffiliate | null> {
  return db
    .prepare(
      `SELECT name, address_line1, postal_code, city, currency, terms_version
       FROM affiliates WHERE affiliate_id = ? AND tenant_id = ? LIMIT 1`,
    )
    .bind(affiliateId, tenantId)
    .first<PayoutAffiliate>();
}

/** The invoice's counterparty (design §6.1): a name and a postal address. */
export function profileComplete(row: Pick<PayoutAffiliate, "address_line1" | "city" | "name" | "postal_code">): boolean {
  return row.name.trim() !== "" && row.address_line1 !== null && row.postal_code !== null && row.city !== null;
}

async function hasOpenRequest(db: D1Database, tenantId: string, affiliateId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS open FROM affiliate_payouts WHERE tenant_id = ? AND affiliate_id = ? AND status = 'requested' LIMIT 1")
    .bind(tenantId, affiliateId)
    .first<{ open: number }>();
  return row !== null;
}

/**
 * The statements that RESERVE a payout: the row (born `requested`, guarded on
 * the payable balance and, with an invoice, on the invoice), the ledger's
 * `payout` row guarded on it, and the invoice frozen. `invoiceGuard` is the
 * caller's own rule for which object may be attached.
 */
function reserveStatements(
  db: D1Database,
  input: {
    /**
     * Who reserves: the affiliate (no grant) or the shop's admin, whose
     * acting-as grant (a platform user acting as the shop) rides on the
     * invoice freeze's audit row (round 1, item 10).
     */
    actor: { actingAsGrantId: string | null; tenantId: string; userId: string };
    affiliateId: string;
    amountMinor: number;
    currency: string;
    invoiceGuard: { binds: unknown[]; sql: string } | null;
    invoiceNumber: string | null;
    invoiceObjectId: string | null;
    now: number;
    payoutId: string;
  },
): D1PreparedStatement[] {
  const nowIso = new Date(input.now).toISOString();
  const payable = payableAtLeastSql(input.actor.tenantId, input.affiliateId, input.currency, input.amountMinor, input.now);
  const exists = {
    binds: [input.payoutId, input.actor.tenantId],
    sql: "EXISTS (SELECT 1 FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ?)",
  };
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO affiliate_payouts (
           payout_id, tenant_id, affiliate_id, amount_minor, currency, status, rail,
           invoice_object_id, invoice_number, requested_by, requested_at, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, 'requested', 'manual', ?, ?, ?, ?, ?, ?
         WHERE ${payable.sql}${input.invoiceGuard === null ? "" : ` AND ${input.invoiceGuard.sql}`}`,
      )
      .bind(
        input.payoutId,
        input.actor.tenantId,
        input.affiliateId,
        input.amountMinor,
        input.currency,
        input.invoiceObjectId,
        input.invoiceNumber,
        input.actor.userId,
        nowIso,
        nowIso,
        nowIso,
        ...payable.binds,
        ...(input.invoiceGuard?.binds ?? []),
      ),
    db
      .prepare(
        `INSERT INTO affiliate_ledger (
           entry_id, tenant_id, affiliate_id, kind, amount_minor, currency, order_id, ref,
           formula_version, available_at, reason, created_by, created_at
         )
         SELECT ?, tenant_id, affiliate_id, 'payout', -amount_minor, currency, NULL, payout_id,
                NULL, NULL, NULL, ?, ?
         FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ?`,
      )
      .bind(crypto.randomUUID(), input.actor.userId, nowIso, input.payoutId, input.actor.tenantId),
  ];
  if (input.invoiceObjectId !== null) {
    statements.push(
      ...markObjectImmutableStatements(
        db,
        {
          actor: { actingAsGrantId: input.actor.actingAsGrantId, userId: input.actor.userId },
          domainKind: "admin",
          hostname: "",
          tenantId: input.actor.tenantId,
        },
        input.invoiceObjectId,
        input.now,
        exists,
      ),
    );
  }
  return statements;
}

/** An object the affiliate may attach: active, a document of the tenant, listed as ITS invoice, attached to no other payout. */
function affiliateInvoiceGuard(tenantId: string, affiliateId: string, objectId: string) {
  return {
    binds: [objectId, tenantId, objectId, tenantId, affiliateId, objectId, tenantId],
    sql: `EXISTS (
        SELECT 1 FROM stored_objects
        WHERE object_id = ? AND tenant_id = ? AND status = 'active' AND kind = 'document' AND bucket = 'private'
      )
      AND EXISTS (
        SELECT 1 FROM affiliate_invoice_objects WHERE object_id = ? AND tenant_id = ? AND affiliate_id = ?
      )
      AND NOT EXISTS (SELECT 1 FROM affiliate_payouts WHERE invoice_object_id = ? AND tenant_id = ?)`,
  };
}

/**
 * `POST /v1/affiliate/payouts` — the affiliate's request. Refused while the
 * profile lacks a name and a postal address (the invoice's counterparty),
 * while the current terms are not accepted, while a request is open, and when
 * the amount (default: everything payable) exceeds what is payable now.
 */
export async function requestPayout(
  db: D1Database,
  principal: AffiliatePrincipal,
  input: RequestPayoutInput,
  now: number,
): Promise<PayoutResult> {
  const affiliate = await readPayoutAffiliate(db, principal.tenantId, principal.affiliateId);
  if (affiliate === null) {
    return { status: "not_found" };
  }
  if (!profileComplete(affiliate)) {
    return { reason: "profile_incomplete", status: "refused" };
  }
  const terms = await readCurrentAffiliateTerms(db, now);
  if (terms !== null && affiliate.terms_version !== terms.version) {
    return { reason: "terms_required", status: "refused" };
  }
  if (await hasOpenRequest(db, principal.tenantId, principal.affiliateId)) {
    return { reason: "payout_open", status: "refused" };
  }
  const balance = balanceIn(
    await readBalances(db, principal.tenantId, principal.affiliateId, affiliate.currency, now),
    affiliate.currency,
  );
  const amountMinor = input.amountMinor ?? balance.payableMinor;
  if (amountMinor <= 0 || amountMinor > balance.payableMinor) {
    return { reason: "insufficient_balance", status: "refused" };
  }

  const payoutId = crypto.randomUUID();
  const exists = {
    binds: [payoutId, principal.tenantId],
    sql: "EXISTS (SELECT 1 FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ?)",
  };
  const mail = affiliateMailStatement(db, {
    aggregateId: payoutId,
    aggregateType: "affiliate_payout",
    dedupeKey: `email:affiliate_payout_requested:${payoutId}`,
    guard: exists,
    kind: "affiliate_payout_requested",
    now,
    payload: { payoutId },
    tenantId: principal.tenantId,
  });
  let results: D1Result[];
  try {
    results = await db.batch([
      ...reserveStatements(db, {
        actor: { actingAsGrantId: null, tenantId: principal.tenantId, userId: principal.userId },
        affiliateId: principal.affiliateId,
        amountMinor,
        currency: affiliate.currency,
        invoiceGuard:
          input.invoiceObjectId === null
            ? null
            : affiliateInvoiceGuard(principal.tenantId, principal.affiliateId, input.invoiceObjectId),
        invoiceNumber: input.invoiceNumber,
        invoiceObjectId: input.invoiceObjectId,
        now,
        payoutId,
      }),
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type,
             resource_id, request_id, metadata_json, created_at
           )
           SELECT ?, tenant_id, ?, 'affiliate.payout_request', 'affiliate_payout', payout_id, ?,
                  json_object('affiliateId', affiliate_id, 'amountMinor', amount_minor, 'currency', currency,
                              'invoiceObjectId', invoice_object_id),
                  ?
           FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ?`,
        )
        .bind(crypto.randomUUID(), principal.userId, crypto.randomUUID(), now, payoutId, principal.tenantId),
      mail.statement,
    ]);
  } catch (error) {
    if (isOpenRequestConflict(error)) {
      return { reason: "payout_open", status: "refused" };
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // The guard decided; these reads only name why.
    if (await hasOpenRequest(db, principal.tenantId, principal.affiliateId)) {
      return { reason: "payout_open", status: "refused" };
    }
    if (input.invoiceObjectId !== null) {
      const ok = await db
        .prepare(`SELECT 1 AS ok WHERE ${affiliateInvoiceGuard(principal.tenantId, principal.affiliateId, input.invoiceObjectId).sql}`)
        .bind(...affiliateInvoiceGuard(principal.tenantId, principal.affiliateId, input.invoiceObjectId).binds)
        .first<{ ok: number }>();
      if (ok === null) {
        return { reason: "invalid_invoice", status: "refused" };
      }
    }
    return { reason: "insufficient_balance", status: "refused" };
  }
  return { outboxIds: [mail.outboxId], payoutId, status: "ok" };
}

// ── the shop's side (design §6.2) ───────────────────────────────────────────

export interface RecordPayoutInput {
  amountMinor: number;
  invoiceNumber: string | null;
  invoiceObjectId: string | null;
  notes: string | null;
  reference: string | null;
}

const RECORD_KEYS = ["amountMinor", "invoiceNumber", "invoiceObjectId", "notes", "reference"] as const;

/** `{ amountMinor, invoiceNumber?, invoiceObjectId?, reference?, notes? }`. */
export function parseRecordPayoutInput(body: unknown): RecordPayoutInput | null {
  if (!isPlainObject(body) || !Object.keys(body).every((key) => (RECORD_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const amountMinor = parseAmount(body.amountMinor);
  const invoiceNumber = parseText(body.invoiceNumber, 50);
  const reference = parseText(body.reference, 100);
  const notes = parseText(body.notes, 1_000);
  const invoiceObjectId =
    body.invoiceObjectId === undefined || body.invoiceObjectId === null
      ? null
      : typeof body.invoiceObjectId === "string"
        ? parseIdSegment(body.invoiceObjectId)
        : undefined;
  if (
    amountMinor === undefined ||
    amountMinor === null ||
    invoiceNumber === undefined ||
    reference === undefined ||
    notes === undefined ||
    invoiceObjectId === undefined
  ) {
    return null;
  }
  return { amountMinor, invoiceNumber, invoiceObjectId, notes, reference };
}

function paidMail(db: D1Database, tenantId: string, payoutId: string, now: number, guard: { binds: unknown[]; sql: string }) {
  return affiliateMailStatement(db, {
    aggregateId: payoutId,
    aggregateType: "affiliate_payout",
    dedupeKey: `email:affiliate_payout:${payoutId}`,
    guard,
    kind: "affiliate_payout",
    now,
    payload: { payoutId },
    tenantId,
  });
}

/**
 * `POST /v1/admin/affiliates/:id/payouts` — the shop records a payout it
 * initiated: requested AND paid in one batch, reserve-first like a request
 * (the payable guard), refused while the affiliate's own request is open (the
 * open request is the thing to mark paid). Its invoice, optional, is any
 * active private document of the shop, and is frozen.
 */
export async function recordPayout(
  db: D1Database,
  principal: TenantAdminPrincipal,
  affiliateId: string,
  input: RecordPayoutInput,
  now: number,
): Promise<PayoutResult> {
  const affiliate = await readPayoutAffiliate(db, principal.tenantId, affiliateId);
  if (affiliate === null) {
    return { status: "not_found" };
  }
  if (await hasOpenRequest(db, principal.tenantId, affiliateId)) {
    return { reason: "payout_open", status: "refused" };
  }
  const payoutId = crypto.randomUUID();
  const nowIso = new Date(now).toISOString();
  const exists = {
    binds: [payoutId, principal.tenantId],
    sql: "EXISTS (SELECT 1 FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ?)",
  };
  const mail = paidMail(db, principal.tenantId, payoutId, now, exists);
  let results: D1Result[];
  try {
    results = await db.batch([
      ...reserveStatements(db, {
        actor: { actingAsGrantId: principal.actingAs?.grantId ?? null, tenantId: principal.tenantId, userId: principal.userId },
        affiliateId,
        amountMinor: input.amountMinor,
        currency: affiliate.currency,
        invoiceGuard:
          input.invoiceObjectId === null
            ? null
            : {
                binds: [input.invoiceObjectId, principal.tenantId, input.invoiceObjectId, principal.tenantId],
                sql: `EXISTS (
                    SELECT 1 FROM stored_objects
                    WHERE object_id = ? AND tenant_id = ? AND status = 'active' AND kind = 'document' AND bucket = 'private'
                  )
                  AND NOT EXISTS (SELECT 1 FROM affiliate_payouts WHERE invoice_object_id = ? AND tenant_id = ?)`,
              },
        invoiceNumber: input.invoiceNumber,
        invoiceObjectId: input.invoiceObjectId,
        now,
        payoutId,
      }),
      db
        .prepare(
          `UPDATE affiliate_payouts
           SET status = 'paid', paid_at = ?, paid_by = ?, paid_reference = ?, notes = ?, updated_at = MAX(updated_at, ?)
           WHERE payout_id = ? AND tenant_id = ? AND status = 'requested'`,
        )
        .bind(nowIso, principal.userId, input.reference, input.notes, nowIso, payoutId, principal.tenantId),
      payoutAuditStatement(db, principal, payoutId, "affiliate.payout_record", now, exists),
      mail.statement,
    ]);
  } catch (error) {
    if (isOpenRequestConflict(error)) {
      return { reason: "payout_open", status: "refused" };
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) === 0) {
    if (input.invoiceObjectId !== null) {
      const usable = await db
        .prepare(
          `SELECT 1 AS ok FROM stored_objects AS o
           WHERE o.object_id = ? AND o.tenant_id = ? AND o.status = 'active' AND o.kind = 'document' AND o.bucket = 'private'
             AND NOT EXISTS (SELECT 1 FROM affiliate_payouts WHERE invoice_object_id = o.object_id AND tenant_id = o.tenant_id)`,
        )
        .bind(input.invoiceObjectId, principal.tenantId)
        .first<{ ok: number }>();
      if (usable === null) {
        return { reason: "invalid_invoice", status: "refused" };
      }
    }
    return { reason: "insufficient_balance", status: "refused" };
  }
  return { outboxIds: [mail.outboxId], payoutId, status: "ok" };
}

/** The audit row of a shop's payout decision, written only under `guard` (the decision's stamp). */
function payoutAuditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  payoutId: string,
  action: string,
  now: number,
  guard: { binds: unknown[]; sql: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       )
       SELECT ?, ?, ?, ?, 'affiliate_payout', ?, ?, ?, ?
       WHERE ${guard.sql}`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      payoutId,
      crypto.randomUUID(),
      auditMetadataJson(principal, { payoutId }),
      now,
      ...guard.binds,
    );
}

const MARK_KEYS = ["notes", "reference"] as const;

/** `{ reference?, notes? }`. */
export function parseMarkPaidInput(body: unknown): { notes: string | null; reference: string | null } | null {
  if (body === null || body === undefined) {
    return { notes: null, reference: null };
  }
  if (!isPlainObject(body) || !Object.keys(body).every((key) => (MARK_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const reference = parseText(body.reference, 100);
  const notes = parseText(body.notes, 1_000);
  return reference === undefined || notes === undefined ? null : { notes, reference };
}

/** `{ reason }` (1–500, mailed to the affiliate). */
export function parseVoidInput(body: unknown): { reason: string } | null {
  if (!isPlainObject(body) || !Object.keys(body).every((key) => key === "reason")) {
    return null;
  }
  const reason = parseText(body.reason, 500);
  return reason === undefined || reason === null ? null : { reason };
}

/** `POST …/payouts/:payoutId/paid` — requested → paid, with its evidence, audit and mail. */
export async function markPayoutPaid(
  db: D1Database,
  principal: TenantAdminPrincipal,
  payoutId: string,
  input: { notes: string | null; reference: string | null },
  now: number,
): Promise<PayoutResult> {
  const nowIso = new Date(now).toISOString();
  const stamped = {
    binds: [payoutId, principal.tenantId, nowIso, principal.userId],
    sql: "EXISTS (SELECT 1 FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ? AND status = 'paid' AND paid_at = ? AND paid_by = ?)",
  };
  const mail = paidMail(db, principal.tenantId, payoutId, now, stamped);
  const [decision] = await db.batch([
    db
      .prepare(
        `UPDATE affiliate_payouts
         SET status = 'paid', paid_at = ?, paid_by = ?, paid_reference = ?, notes = COALESCE(?, notes),
             updated_at = MAX(updated_at, ?)
         WHERE payout_id = ? AND tenant_id = ? AND status = 'requested'`,
      )
      .bind(nowIso, principal.userId, input.reference, input.notes, nowIso, payoutId, principal.tenantId),
    payoutAuditStatement(db, principal, payoutId, "affiliate.payout_paid", now, stamped),
    mail.statement,
  ]);
  if ((decision?.meta.changes ?? 0) > 0) {
    return { outboxIds: [mail.outboxId], payoutId, status: "ok" };
  }
  return (await payoutExists(db, principal.tenantId, payoutId))
    ? { reason: "payout_not_open", status: "refused" }
    : { status: "not_found" };
}

/**
 * `POST …/payouts/:payoutId/void` — requested → void, the compensating
 * `payout_void` row (+amount) guarded on the void, audit and mail, in one
 * batch. The reservation is released by the row, never by a delete.
 */
export async function voidPayout(
  db: D1Database,
  principal: TenantAdminPrincipal,
  payoutId: string,
  reason: string,
  now: number,
): Promise<PayoutResult> {
  const nowIso = new Date(now).toISOString();
  const voided = {
    binds: [payoutId, principal.tenantId, nowIso, principal.userId],
    sql: "EXISTS (SELECT 1 FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ? AND status = 'void' AND voided_at = ? AND voided_by = ?)",
  };
  const mail = paidMail(db, principal.tenantId, payoutId, now, voided);
  const [decision] = await db.batch([
    db
      .prepare(
        `UPDATE affiliate_payouts
         SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?, updated_at = MAX(updated_at, ?)
         WHERE payout_id = ? AND tenant_id = ? AND status = 'requested'`,
      )
      .bind(nowIso, principal.userId, reason, nowIso, payoutId, principal.tenantId),
    db
      .prepare(
        `INSERT INTO affiliate_ledger (
           entry_id, tenant_id, affiliate_id, kind, amount_minor, currency, order_id, ref,
           formula_version, available_at, reason, created_by, created_at
         )
         SELECT ?, p.tenant_id, p.affiliate_id, 'payout_void', p.amount_minor, p.currency, NULL, p.payout_id,
                NULL, NULL, NULL, ?, ?
         FROM affiliate_payouts AS p
         WHERE p.payout_id = ? AND p.tenant_id = ? AND p.status = 'void' AND p.voided_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM affiliate_ledger AS l
             WHERE l.tenant_id = p.tenant_id AND l.affiliate_id = p.affiliate_id
               AND l.kind = 'payout_void' AND l.ref = p.payout_id
           )`,
      )
      .bind(crypto.randomUUID(), principal.userId, nowIso, payoutId, principal.tenantId, nowIso),
    payoutAuditStatement(db, principal, payoutId, "affiliate.payout_void", now, voided),
    mail.statement,
  ]);
  if ((decision?.meta.changes ?? 0) > 0) {
    return { outboxIds: [mail.outboxId], payoutId, status: "ok" };
  }
  return (await payoutExists(db, principal.tenantId, payoutId))
    ? { reason: "payout_not_open", status: "refused" }
    : { status: "not_found" };
}

async function payoutExists(db: D1Database, tenantId: string, payoutId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM affiliate_payouts WHERE payout_id = ? AND tenant_id = ? LIMIT 1")
    .bind(payoutId, tenantId)
    .first<{ present: number }>();
  return row !== null;
}

// ── the reads ───────────────────────────────────────────────────────────────

export interface PayoutRow {
  affiliate_id: string;
  amount_minor: number;
  created_at: string;
  currency: string;
  invoice_number: string | null;
  invoice_object_id: string | null;
  notes: string | null;
  paid_at: string | null;
  paid_reference: string | null;
  payout_id: string;
  rail: string;
  requested_at: string;
  status: "paid" | "requested" | "void";
  void_reason: string | null;
  voided_at: string | null;
}

const PAYOUT_COLUMNS = `payout_id, affiliate_id, amount_minor, currency, status, rail, invoice_object_id,
  invoice_number, requested_at, paid_at, paid_reference, notes, voided_at, void_reason, created_at`;

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([0-9a-f-]{36})$/;

export interface PageQuery {
  cursor: { at: string; id: string } | null;
  limit: number;
}

/** `?cursor=&limit=` (a list's page; anything else a 400). */
export function parsePageQuery(url: URL, defaultLimit = PAYOUT_LIST_LIMIT, max = MAX_PAYOUT_LIST_LIMIT): PageQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "limit"].includes(key) || params.getAll(key).length !== 1) {
      return null;
    }
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? defaultLimit : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : 0;
  if (limit < 1 || limit > max) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  if (cursorRaw === null) {
    return { cursor: null, limit };
  }
  const match = CURSOR.exec(cursorRaw);
  return match === null ? null : { cursor: { at: match[1] as string, id: match[2] as string }, limit };
}

/** One affiliate's payouts, newest first. */
export async function listPayouts(
  db: D1Database,
  tenantId: string,
  affiliateId: string,
  page: PageQuery,
): Promise<{ nextCursor: string | null; payouts: PayoutRow[] }> {
  const rows = await db
    .prepare(
      `SELECT ${PAYOUT_COLUMNS} FROM affiliate_payouts
       WHERE tenant_id = ? AND affiliate_id = ?
         AND (? IS NULL OR (created_at, payout_id) < (?, ?))
       ORDER BY created_at DESC, payout_id DESC
       LIMIT ?`,
    )
    .bind(tenantId, affiliateId, page.cursor?.at ?? null, page.cursor?.at ?? null, page.cursor?.id ?? null, page.limit + 1)
    .all<PayoutRow>();
  const items = rows.results.slice(0, page.limit);
  const last = items.at(-1);
  return {
    nextCursor: rows.results.length > page.limit && last !== undefined ? `${last.created_at}~${last.payout_id}` : null,
    payouts: items,
  };
}

export async function readPayout(db: D1Database, tenantId: string, payoutId: string): Promise<PayoutRow | null> {
  return db
    .prepare(`SELECT ${PAYOUT_COLUMNS} FROM affiliate_payouts WHERE tenant_id = ? AND payout_id = ? LIMIT 1`)
    .bind(tenantId, payoutId)
    .first<PayoutRow>();
}
