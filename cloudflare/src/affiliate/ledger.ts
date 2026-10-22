import { WITHDRAWAL_WINDOW_MS } from "../commerce/payouts";
import { MAX_VAT_SAFE_TOTAL_MINOR, vatMinor } from "../commerce/shipping";

/**
 * CP13 — the commission ledger (design §4, migration 0059 affiliate_ledger).
 *
 * WHERE EACH ROW IS WRITTEN, always in the batch that moves the money it
 * follows (CX-B3), never after it:
 *   accrual    webhook.ts, in the ORDER batch (accrualStatement): the order and
 *              its commission land together or not at all.
 *   reversal   refunds.ts orderEffectStatements, in the batch of the refund
 *              operation's transition (reversalStatement, guarded by that
 *              transition's stamp, ref = the TRANSITION id); and
 *              stripe-events.ts applyDisputeFact, in the batch that records a
 *              LOST dispute (ref = the dispute id, guarded on the stored
 *              post-state).
 *   payout / payout_void / adjustment   src/affiliate/payouts.ts and
 *              src/affiliate/affiliates.ts, in their own route batches.
 *
 * EVERY WRITER IS IDEMPOTENT BY CONSTRUCTION: `INSERT … SELECT … WHERE NOT
 * EXISTS (same tenant, affiliate, kind, ref)`, so a replayed delivery or a
 * re-applied fact inserts nothing and never raises the UNIQUE violation that
 * the webhook's deliberately narrow isDuplicateDelivery would have to
 * classify. A statement here can therefore never abort the batch that moves
 * money: every CHECK and trigger of the ledger is met by the WHERE that
 * selects the row.
 *
 * ACCRUAL FROM FROZEN FACTS ONLY (design §4.1, CX-B2): the checkout's
 * `discount_authority = 'affiliate'` and `affiliate_self_referral = 0`, its
 * frozen rates, the order's frozen totals and VAT rate. Nothing is re-resolved
 * at payment: not the add-on, not the affiliate's status, not its code.
 *
 * Money is integer öre and basis points throughout; nothing here is a float.
 */

/** The one versioned rule of the accrual (CX-B10, CX-C9). */
export const COMMISSION_FORMULA_VERSION = 1;

/** A cancelled order that is never refunded stays held this long after its cancellation (§4.4). */
export const CANCELLED_HOLD_MS = WITHDRAWAL_WINDOW_MS + 30 * 24 * 60 * 60 * 1_000;

export interface CommissionInput {
  commissionBp: number;
  shippingMinor: number;
  totalMinor: number;
  vatRateBp: number;
}

/**
 * The commission base: the discounted goods, ex VAT, in öre (design §4.1).
 *
 *   G = max(0, total − shipping)   the goods the buyer paid for, VAT-inclusive
 *                                  (shipping's own VAT leaves with shipping)
 *   B = G − vatMinor(G, rate)      ex VAT at the ORDER's frozen rate, the
 *                                  checkout's own half-up-on-the-net rule
 */
export function commissionBaseMinor(totalMinor: number, shippingMinor: number, vatRateBp: number): number {
  const goods = Math.max(0, totalMinor - shippingMinor);
  return goods - vatMinor(goods, vatRateBp);
}

/**
 * The accrual: `floor((B × commission_bp + 5 000) / 10 000)` — half-up to the
 * öre (Firebase's Math.round). The base is rounded to the öre BEFORE the rate
 * applies; that can differ from Firebase by one öre on some orders, which is
 * why formula_version 1 is recorded on the row.
 *
 * `B × bp` stays below 2^53 for every total the checkout admits
 * (MAX_VAT_SAFE_TOTAL_MINOR × 10 000 = Number.MAX_SAFE_INTEGER, floored); the
 * assertion throws rather than return a plausible wrong number.
 *
 * Worked example (§3.5): total 47 900, shipping 2 900, VAT 25 % → G 45 000,
 * B 36 000, 15 % → 5 400 öre.
 */
export function commissionMinor(input: CommissionInput): number {
  if (
    !Number.isSafeInteger(input.totalMinor) ||
    input.totalMinor < 0 ||
    input.totalMinor > MAX_VAT_SAFE_TOTAL_MINOR ||
    !Number.isSafeInteger(input.shippingMinor) ||
    input.shippingMinor < 0 ||
    !Number.isSafeInteger(input.commissionBp) ||
    input.commissionBp < 0 ||
    input.commissionBp > 10_000
  ) {
    throw new RangeError("commission input is outside the exact-arithmetic range");
  }
  const base = commissionBaseMinor(input.totalMinor, input.shippingMinor, input.vatRateBp);
  const product = base * input.commissionBp;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError("commission product is outside the exact-arithmetic range");
  }
  // Half-up as quotient and remainder, so `product + 5 000` is never formed
  // (at the very ceiling it would pass 2^53).
  const quotient = Math.floor(product / 10_000);
  return product - quotient * 10_000 >= 5_000 ? quotient + 1 : quotient;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface AccrualFacts {
  affiliateId: string;
  commissionBp: number;
  orderId: string;
  paidAt: number;
  shippingMinor: number;
  tenantId: string;
  totalMinor: number;
  vatRateBp: number;
}

/**
 * The accrual row of a paid order, for the webhook's order batch, or null
 * when nothing accrues (a commission of 0 öre: a 0 % affiliate, or a basket
 * whose goods are worth nothing). The row's currency is the ORDER's, read
 * from the order row this same batch inserted just before; its
 * `available_at` is paid_at + 14 days (A8).
 */
export function accrualStatement(
  db: D1Database,
  facts: AccrualFacts,
  now: number,
): { amountMinor: number; entryId: string; statement: D1PreparedStatement } | null {
  const amountMinor = commissionMinor({
    commissionBp: facts.commissionBp,
    shippingMinor: facts.shippingMinor,
    totalMinor: facts.totalMinor,
    vatRateBp: facts.vatRateBp,
  });
  if (amountMinor <= 0) {
    return null;
  }
  const entryId = crypto.randomUUID();
  return {
    amountMinor,
    entryId,
    statement: db
      .prepare(
        `INSERT INTO affiliate_ledger (
           entry_id, tenant_id, affiliate_id, kind, amount_minor, currency, order_id, ref,
           formula_version, available_at, reason, created_by, created_at
         )
         SELECT ?1, o.tenant_id, ?2, 'accrual', ?3, o.currency, o.order_id, o.order_id,
                ?4, ?5, NULL, 'system', ?6
         FROM orders AS o
         WHERE o.order_id = ?7 AND o.tenant_id = ?8
           AND NOT EXISTS (
             SELECT 1 FROM affiliate_ledger AS l
             WHERE l.tenant_id = ?8 AND l.affiliate_id = ?2 AND l.kind = 'accrual' AND l.ref = ?7
           )`,
      )
      .bind(
        entryId,
        facts.affiliateId,
        amountMinor,
        COMMISSION_FORMULA_VERSION,
        iso(facts.paidAt + WITHDRAWAL_WINDOW_MS),
        iso(now),
        facts.orderId,
        facts.tenantId,
      ),
  };
}

/**
 * The reversal an order needs NOW, as SQL over `o` (the order) and `a` (its
 * accrual row): the required cumulative reversal minus what is already
 * reversed, negated (design §4.2, R2-1/3/23):
 *
 *   fraction_bp = 10 000                          once the dispute is LOST
 *               = min(refunded, charged) × 10 000 / charged   otherwise (floored)
 *   required    = (accrual × fraction_bp + 5 000) / 10 000    (half-up)
 *   row         = −(required − already_reversed)   either sign; ≠ 0 to be written
 *
 * Integer-only in SQL: `refunded × 10 000` and `accrual × 10 000` stay far
 * inside int64 for every total the checkout admits, where `accrual × refunded`
 * would not. Flooring the fraction under-reverses by less than one öre per
 * 10 000 öre of commission (in the affiliate's favour); a full refund and a
 * lost dispute are exact, and the total reversal never exceeds the accrual.
 * Against the CHARGED total (CX-C5): a refund carries an amount, not a
 * goods/shipping split.
 */
const REVERSAL_DELTA_SQL = `-(
    ((a.amount_minor * (CASE
        WHEN o.dispute_status = 'lost' THEN 10000
        WHEN o.charged_minor <= 0 THEN 0
        ELSE (MIN(o.refund_succeeded_minor, o.charged_minor) * 10000) / o.charged_minor
      END) + 5000) / 10000)
    + COALESCE((
        SELECT SUM(r.amount_minor) FROM affiliate_ledger AS r
        WHERE r.tenant_id = a.tenant_id AND r.affiliate_id = a.affiliate_id
          AND r.order_id = a.order_id AND r.kind = 'reversal'
      ), 0)
  )`;

export interface SqlGuard {
  binds: unknown[];
  sql: string;
}

export interface ReversalInput {
  entryId: string;
  /** Only when this holds is anything written (the money fact's own stamp). */
  guard: SqlGuard;
  now: number;
  orderId: string;
  /** The idempotency key: a refund TRANSITION id, or a dispute id. */
  ref: string;
}

/**
 * The reversal row of one money fact, or nothing: "reverse iff accrued" (an
 * order without an accrual — no affiliate, a self-referral, 0 öre — matches
 * no `a`), never flag-gated, whatever the add-on or the affiliate's status
 * say today. Written when the delta is not 0, the guard holds, and no row
 * carries this ref yet.
 */
export function reversalStatement(db: D1Database, input: ReversalInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO affiliate_ledger (
         entry_id, tenant_id, affiliate_id, kind, amount_minor, currency, order_id, ref,
         formula_version, available_at, reason, created_by, created_at
       )
       SELECT ?, x.tenant_id, x.affiliate_id, 'reversal', x.delta, x.currency, x.order_id, ?,
              NULL, NULL, NULL, 'system', ?
       FROM (
         SELECT a.tenant_id, a.affiliate_id, a.currency, a.order_id, ${REVERSAL_DELTA_SQL} AS delta
         FROM orders AS o
         INNER JOIN affiliate_ledger AS a
           ON a.tenant_id = o.tenant_id AND a.order_id = o.order_id AND a.kind = 'accrual' AND a.ref = o.order_id
         WHERE o.order_id = ?
       ) AS x
       WHERE x.delta <> 0
         AND (${input.guard.sql})
         AND NOT EXISTS (
           SELECT 1 FROM affiliate_ledger AS d
           WHERE d.tenant_id = x.tenant_id AND d.affiliate_id = x.affiliate_id
             AND d.kind = 'reversal' AND d.ref = ?
         )`,
    )
    .bind(input.entryId, input.ref, iso(input.now), input.orderId, ...input.guard.binds, input.ref);
}

/**
 * The affiliate's reversal mail, beside the row it reports: an outbox `email`
 * row exists exactly when `entryId` was just written (design §9). Ids only;
 * the effect reads the rest. Never aborts its batch (DO NOTHING on any
 * conflict).
 */
export function reversalMailStatement(db: D1Database, entryId: string, nowMs: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox_events (
         outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
         dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
       )
       SELECT 'email-affiliate-reversal:' || l.entry_id, l.tenant_id, 'email', 'order', l.order_id,
              'email:affiliate_reversal:' || l.entry_id,
              json_object('entryId', l.entry_id, 'kind', 'affiliate_reversal', 'orderId', l.order_id),
              'pending', ?2, ?2, ?2
       FROM affiliate_ledger AS l
       WHERE l.entry_id = ?1 AND l.kind = 'reversal'
       ON CONFLICT DO NOTHING`,
    )
    .bind(entryId, nowMs);
}

// ── balances (design §4.4) ──────────────────────────────────────────────────

/**
 * Is ONE order's accrual held now? SQL over `a` (the accrual row) and `o` (its
 * order), two binds: now (ISO), the cancellation cutoff (ISO, now − 44 days).
 * The order is
 *   - inside its 14 days (`available_at` > now), or
 *   - disputed and the dispute is still open (payouts.ts's closed set), or
 *   - refunding (an operation 'reserved' or 'submitted'), or
 *   - cancelled and not refunded to its charge, for at most 44 days after the
 *     cancellation (then released: the shop kept the money, §4.2).
 */
export const HELD_ORDER_SQL = `(
    a.available_at > ?
    OR (o.dispute_status IS NOT NULL
        AND o.dispute_status NOT IN ('lost', 'won', 'warning_closed', 'prevented'))
    OR EXISTS (
      SELECT 1 FROM refund_operations AS op
      WHERE op.order_id = o.order_id AND op.tenant_id = o.tenant_id
        AND op.state IN ('reserved', 'submitted')
    )
    OR (o.cancelled_at IS NOT NULL
        AND o.refund_succeeded_minor < o.charged_minor
        AND o.cancelled_at > ?)
  )`;

/** HELD_ORDER_SQL's two binds. */
export function heldOrderBinds(now: number): [string, string] {
  return [iso(now), iso(now - CANCELLED_HOLD_MS)];
}

/** The net of one order's commission (accrual + its reversals), as SQL over `a`. */
export const ORDER_NET_SQL = `(a.amount_minor + COALESCE((
    SELECT SUM(r.amount_minor) FROM affiliate_ledger AS r
    WHERE r.tenant_id = a.tenant_id AND r.affiliate_id = a.affiliate_id
      AND r.order_id = a.order_id AND r.kind = 'reversal'
  ), 0))`;

/**
 * The HELD part of an affiliate's commission in one currency, as SQL: per
 * ORDER, its net (never below 0, counted once, R2-10), where HELD_ORDER_SQL
 * holds. Binds: tenant, affiliate, currency, now (ISO), the cancellation
 * cutoff (ISO).
 */
export const HELD_SQL = `COALESCE((
    SELECT SUM(MAX(0, ${ORDER_NET_SQL}))
    FROM affiliate_ledger AS a
    INNER JOIN orders AS o ON o.order_id = a.order_id AND o.tenant_id = a.tenant_id
    WHERE a.tenant_id = ? AND a.affiliate_id = ? AND a.currency = ? AND a.kind = 'accrual'
      AND ${HELD_ORDER_SQL}
  ), 0)`;

/** HELD_SQL's binds, in its order. */
export function heldBinds(tenantId: string, affiliateId: string, currency: string, now: number): unknown[] {
  return [tenantId, affiliateId, currency, ...heldOrderBinds(now)];
}

/**
 * `payable >= amount` for one affiliate and currency, as a SQL condition: the
 * payout request's guard, evaluated INSIDE its batch (design §6.1, R2-Q5).
 * payable = balance − held (balance = Σ every row of the currency).
 */
export function payableAtLeastSql(
  tenantId: string,
  affiliateId: string,
  currency: string,
  amountMinor: number,
  now: number,
): SqlGuard {
  return {
    binds: [tenantId, affiliateId, currency, ...heldBinds(tenantId, affiliateId, currency, now), amountMinor],
    sql: `(COALESCE((
        SELECT SUM(b.amount_minor) FROM affiliate_ledger AS b
        WHERE b.tenant_id = ? AND b.affiliate_id = ? AND b.currency = ?
      ), 0) - ${HELD_SQL}) >= ?`,
  };
}

export interface AffiliateBalance {
  /** Σ every row (accruals, reversals, payouts, voids, adjustments). */
  balanceMinor: number;
  currency: string;
  /** Σ accruals + Σ reversals: what was earned and kept. */
  earnedMinor: number;
  /** Held (HELD_SQL): not yet payable. */
  heldMinor: number;
  /** −Σ payout rows whose payout is `paid`. */
  paidMinor: number;
  /** max(0, balance − held): what a request may take now. */
  payableMinor: number;
  /** −Σ payout rows whose payout is still `requested`. */
  requestedMinor: number;
}

/**
 * The balances of one affiliate, per currency (R2-11): one SQL aggregate per
 * read, nothing stored, nothing to reconcile. An affiliate without a row has
 * one zero balance in its own currency.
 */
export async function readBalances(
  db: D1Database,
  tenantId: string,
  affiliateId: string,
  affiliateCurrency: string,
  now: number,
): Promise<AffiliateBalance[]> {
  const rows = await db
    .prepare(
      `SELECT l.currency AS currency,
              SUM(l.amount_minor) AS balance,
              SUM(CASE WHEN l.kind IN ('accrual', 'reversal') THEN l.amount_minor ELSE 0 END) AS earned,
              SUM(CASE WHEN l.kind = 'payout' AND p.status = 'paid' THEN -l.amount_minor ELSE 0 END) AS paid,
              SUM(CASE WHEN l.kind = 'payout' AND p.status = 'requested' THEN -l.amount_minor ELSE 0 END) AS requested
       FROM affiliate_ledger AS l
       LEFT JOIN affiliate_payouts AS p
         ON l.kind = 'payout' AND p.payout_id = l.ref AND p.tenant_id = l.tenant_id
       WHERE l.tenant_id = ? AND l.affiliate_id = ?
       GROUP BY l.currency
       ORDER BY l.currency
       LIMIT 10`,
    )
    .bind(tenantId, affiliateId)
    .all<{ balance: number; currency: string; earned: number; paid: number; requested: number }>();
  const byCurrency = rows.results.length === 0
    ? [{ balance: 0, currency: affiliateCurrency, earned: 0, paid: 0, requested: 0 }]
    : rows.results;

  const balances: AffiliateBalance[] = [];
  for (const row of byCurrency) {
    const held = await db
      .prepare(`SELECT ${HELD_SQL} AS held`)
      .bind(...heldBinds(tenantId, affiliateId, row.currency, now))
      .first<{ held: number }>();
    const heldMinor = held?.held ?? 0;
    balances.push({
      balanceMinor: row.balance,
      currency: row.currency,
      earnedMinor: row.earned,
      heldMinor,
      paidMinor: row.paid,
      payableMinor: Math.max(0, row.balance - heldMinor),
      requestedMinor: row.requested,
    });
  }
  return balances;
}

/** The balance of `currency` (the affiliate's own when there is no row of it). */
export function balanceIn(balances: readonly AffiliateBalance[], currency: string): AffiliateBalance {
  return (
    balances.find((balance) => balance.currency === currency) ?? {
      balanceMinor: 0,
      currency,
      earnedMinor: 0,
      heldMinor: 0,
      paidMinor: 0,
      payableMinor: 0,
      requestedMinor: 0,
    }
  );
}
