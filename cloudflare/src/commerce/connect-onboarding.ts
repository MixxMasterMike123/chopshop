import type { PlatformPrincipal, TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import type { CanonicalOrigins } from "../lib/origins";
import type {
  ConnectAccountFacts,
  ConnectAccountsApi,
  ConnectGateway,
  ConnectLink,
} from "./connect-gateway";
import { connectGatewayError, disabledReasonFrom, requirementsFrom } from "./connect-gateway";
import { secondWatermark } from "./crons";

/**
 * Stripe Connect onboarding (CP3-F; Firebase functions/src/payment/
 * connectOnboarding.ts): the shop's ONE connected account, its onboarding and
 * dashboard links, its status, and the platform's opt-in and payout delay.
 *
 * ── CREATE IS RESERVE-FIRST (migrations/0038) ───────────────────────────────
 *   1. `connect_enabled = 0` ⇒ the opaque 404. An account already recorded ⇒
 *      its status; Stripe is not called — no second account, ever.
 *   2. Otherwise a `reserved` operation is written FIRST (with its audit row);
 *      the partial UNIQUE index lets only one exist per tenant, and its lease
 *      lets only one request talk to Stripe under it at a time.
 *   3. Stripe is called with idempotency key = op_id and metadata naming the
 *      tenant and the operation.
 *   4. ONE batch: the operation → `succeeded` with the account, the tenant
 *      `SET stripe_account_id … WHERE stripe_account_id IS NULL` (and not held
 *      by another shop), an alert when that guard kept the account out, and
 *      the audit row.
 *
 * ── WHAT CAN GO WRONG, AND WHAT HAPPENS ─────────────────────────────────────
 *   Stripe refuses (4xx)   → `failed` + its code. Stripe replays the refusal
 *                            for 24 h under that key, so the key is DEAD: the
 *                            next request reserves a new op_id.
 *   answer lost / timeout  → stays `reserved`, lease released at once: the
 *   / 5xx / 409 / 429        next request retries under the SAME key and
 *                            Stripe returns the account it made (or makes it).
 *   worker dies after      → stays `reserved`, lease held: the first request
 *   Stripe succeeded         after the lease (CONNECT_ATTEMPT_LEASE_MS) retries
 *                            under the same key — the same account.
 *   the key is too old     → after CONNECT_KEY_RETRY_WINDOW_MS the key is not
 *                            retried (Stripe may have pruned it, and a retry
 *                            could then create a second account). The
 *                            platform's accounts are listed instead: one
 *                            carrying this tenant's metadata is adopted; none
 *                            (complete listing) ⇒ `abandoned` and a new op.
 */

/**
 * How long one request may hold an operation while it talks to Stripe. The
 * SDK times out at CONNECT_STRIPE_TIMEOUT_MS (30 s); the batch that follows is
 * milliseconds. 90 s covers both with room, and bounds how long a crashed
 * request blocks the next one.
 */
export const CONNECT_ATTEMPT_LEASE_MS = 90_000;

/**
 * How long a reserved operation is retried under its OWN idempotency key: 20
 * hours from its reservation (= its first call).
 *
 * Stripe keeps an idempotency key for at least 24 hours and prunes it after —
 * a key younger than 24 h is guaranteed to replay the first answer (the
 * account, or the refusal); an older one may run as a brand-new request. The
 * 4-hour margin absorbs any clock skew between this Worker and Stripe and a
 * request still in flight at the boundary, and it costs nothing: past the
 * window the recovery listing (by metadata) decides instead, which is exact
 * too, only more expensive. A seller who retries the same day never needs it.
 */
export const CONNECT_KEY_RETRY_WINDOW_MS = 20 * 60 * 60 * 1_000;

const MAX_CREATE_ROUNDS = 3;
const OPERATIONS_HISTORY_LIMIT = 50;
const MAX_BUSINESS_NAME_LENGTH = 200;
const MAX_PAYOUT_DELAY_DAYS = 365;

type Clock = () => number;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A link handed to a person must be https (the adapters check too; a fake is not trusted). */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

// ═══════════════════════════════════════════════════════════════════════════
// reads and views
// ═══════════════════════════════════════════════════════════════════════════

export interface TenantConnectRow {
  connect_enabled: number;
  payout_delay_days: number | null;
  shop_name: string | null;
  stripe_account_id: string | null;
  stripe_account_resync_needed: number;
  stripe_account_synced_at: number | null;
  stripe_charges_enabled: number;
  stripe_details_submitted: number;
  stripe_disabled_reason: string | null;
  stripe_payouts_enabled: number;
  stripe_requirements_due_json: string | null;
  tenant_id: string;
}

export async function readTenantConnect(db: D1Database, tenantId: string): Promise<TenantConnectRow | null> {
  return db
    .prepare(
      `SELECT tenant_id, shop_name, connect_enabled, stripe_account_id,
              stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted,
              stripe_account_synced_at, stripe_account_resync_needed,
              stripe_requirements_due_json, stripe_disabled_reason, payout_delay_days
       FROM tenants WHERE tenant_id = ? LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantConnectRow>();
}

/** Firebase `connectStatus` vocabulary (deriveStatus), plus "none" for no account. */
export type ConnectStatus = "active" | "none" | "onboarding" | "pending" | "restricted";

/** Firebase deriveStatus, from the stored facts. */
export function deriveConnectStatus(row: TenantConnectRow): ConnectStatus {
  if (row.stripe_account_id === null) {
    return "none";
  }
  if (row.stripe_charges_enabled === 1) {
    return "active";
  }
  if (row.stripe_disabled_reason !== null) {
    return "restricted";
  }
  if (row.stripe_details_submitted === 1) {
    return "pending";
  }
  return "onboarding";
}

function requirementsOf(row: TenantConnectRow): string[] {
  if (row.stripe_requirements_due_json === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.stripe_requirements_due_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The SELLER's view: only the shop's own Connect facts — can it take payments
 * and receive payouts, what does Stripe still need. No commission, no payout
 * delay (a platform risk control), no operation history, no account id, no
 * disabled reason (Firebase showed the seller only the derived status too).
 */
export interface SellerConnectView {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  enabled: boolean;
  hasAccount: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  status: ConnectStatus;
  syncedAt: string | null;
}

export function sellerConnectView(row: TenantConnectRow): SellerConnectView {
  return {
    chargesEnabled: row.stripe_charges_enabled === 1,
    detailsSubmitted: row.stripe_details_submitted === 1,
    enabled: row.connect_enabled === 1,
    hasAccount: row.stripe_account_id !== null,
    payoutsEnabled: row.stripe_payouts_enabled === 1,
    requirementsDue: requirementsOf(row),
    status: deriveConnectStatus(row),
    syncedAt: row.stripe_account_synced_at === null ? null : iso(row.stripe_account_synced_at),
  };
}

/** The PLATFORM's view: every Connect fact of the shop. */
export interface PlatformConnectView {
  accountId: string | null;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
  enabled: boolean;
  payoutsEnabled: boolean;
  /** Days; null = Stripe's default, the account country's minimum. */
  payoutDelayDays: number | null;
  requirementsDue: string[];
  resyncNeeded: boolean;
  status: ConnectStatus;
  syncedAt: string | null;
  tenantId: string;
}

export function platformConnectView(row: TenantConnectRow): PlatformConnectView {
  return {
    accountId: row.stripe_account_id,
    chargesEnabled: row.stripe_charges_enabled === 1,
    detailsSubmitted: row.stripe_details_submitted === 1,
    disabledReason: row.stripe_disabled_reason,
    enabled: row.connect_enabled === 1,
    payoutDelayDays: row.payout_delay_days,
    payoutsEnabled: row.stripe_payouts_enabled === 1,
    requirementsDue: requirementsOf(row),
    resyncNeeded: row.stripe_account_resync_needed === 1,
    status: deriveConnectStatus(row),
    syncedAt: row.stripe_account_synced_at === null ? null : iso(row.stripe_account_synced_at),
    tenantId: row.tenant_id,
  };
}

export type OnboardingOpState = "abandoned" | "failed" | "reserved" | "succeeded";

interface OpRow {
  accounts_api: ConnectAccountsApi;
  attempts: number;
  business_name: string | null;
  created_at: string;
  created_by: string;
  error_code: string | null;
  lease_expires_at: string | null;
  op_id: string;
  settled_at: string | null;
  state: OnboardingOpState;
  stripe_account_id: string | null;
  tenant_id: string;
  updated_at: string;
}

const OP_COLUMNS = `op_id, tenant_id, state, stripe_account_id, accounts_api, business_name,
  attempts, lease_expires_at, error_code, created_by, created_at, updated_at, settled_at`;

export interface ConnectOperationView {
  accountId: string | null;
  accountsApi: ConnectAccountsApi;
  attempts: number;
  createdAt: string;
  createdBy: string;
  errorCode: string | null;
  leaseExpiresAt: string | null;
  opId: string;
  settledAt: string | null;
  state: OnboardingOpState;
  updatedAt: string;
}

function operationView(row: OpRow): ConnectOperationView {
  return {
    accountId: row.stripe_account_id,
    accountsApi: row.accounts_api,
    attempts: row.attempts,
    createdAt: row.created_at,
    createdBy: row.created_by,
    errorCode: row.error_code,
    leaseExpiresAt: row.lease_expires_at,
    opId: row.op_id,
    settledAt: row.settled_at,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

/** The platform's history read: newest first, bounded. */
export async function listOnboardingOperations(
  db: D1Database,
  tenantId: string,
): Promise<ConnectOperationView[]> {
  const rows = await db
    .prepare(
      `SELECT ${OP_COLUMNS} FROM connect_onboarding_ops
       WHERE tenant_id = ? ORDER BY created_at DESC, op_id DESC LIMIT ?`,
    )
    .bind(tenantId, OPERATIONS_HISTORY_LIMIT)
    .all<OpRow>();
  return rows.results.map(operationView);
}

// ═══════════════════════════════════════════════════════════════════════════
// audit + alert statements
// ═══════════════════════════════════════════════════════════════════════════

function tenantAuditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  nowMs: number,
  onlyIf: { sql: string; binds: unknown[] } | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
         request_id, metadata_json, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       ${onlyIf === null ? "" : `WHERE ${onlyIf.sql}`}`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      resourceType,
      resourceId,
      crypto.randomUUID(),
      auditMetadataJson(principal, metadata),
      nowMs,
      ...(onlyIf?.binds ?? []),
    );
}

function platformAuditStatement(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  action: string,
  metadata: Record<string, unknown> | null,
  nowMs: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
         request_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'tenant', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      tenantId,
      principal.userId,
      action,
      tenantId,
      crypto.randomUUID(),
      metadata === null ? null : JSON.stringify(metadata),
      nowMs,
    );
}

/**
 * An `alerts` row in the money alerts' shape (src/commerce/money-alerts.ts):
 * one OPEN alert per (kind, resource), ids and codes only in the message.
 */
function alertStatement(
  db: D1Database,
  alert: {
    kind: "connect_account_conflict" | "connect_account_duplicate";
    message: string;
    resourceId: string;
    tenantId: string;
  },
  nowMs: number,
  onlyIf: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alerts (
         id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
       )
       SELECT ?, ?, ?, 'critical', ?, 'connect_onboarding_op', ?, ?
       WHERE ${onlyIf.sql}
         AND NOT EXISTS (
           SELECT 1 FROM alerts
           WHERE kind = ? AND resource_type = 'connect_onboarding_op'
             AND resource_id = ? AND resolved_at IS NULL
         )`,
    )
    .bind(
      `${alert.kind}:${crypto.randomUUID()}`,
      alert.tenantId,
      alert.kind,
      alert.message.slice(0, 1_000),
      alert.resourceId,
      iso(nowMs),
      ...onlyIf.binds,
      alert.kind,
      alert.resourceId,
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// create or reuse the account
// ═══════════════════════════════════════════════════════════════════════════

export type CreateAccountOutcome =
  /** Connect not enabled for the shop (or the shop vanished): the opaque 404. */
  | { status: "not_found" }
  /** The shop already has an account; nothing was sent to Stripe. */
  | { row: TenantConnectRow; status: "exists" }
  /** This request recorded the account. */
  | { row: TenantConnectRow; status: "created" }
  /** Unknown yet: another request holds the lease, or Stripe's answer was lost. */
  | { reason: "in_progress" | "outcome_unknown" | "recovery_incomplete"; row: TenantConnectRow; status: "pending" }
  /** Stripe refused; the operation is `failed`, the next request starts a new one. */
  | { status: "refused" }
  /** The account Stripe returned could not be recorded without an overwrite: alerted. */
  | { status: "conflict" };

export interface CreateAccountDeps {
  clock?: Clock;
  /** The API a NEW operation uses (CONNECT_ACCOUNTS_API). */
  defaultApi: ConnectAccountsApi;
  /** The gateway for an operation's own API (a retry goes where the key went). */
  gatewayFor(api: ConnectAccountsApi): ConnectGateway | null;
}

async function readReservedOp(db: D1Database, tenantId: string): Promise<OpRow | null> {
  return db
    .prepare(`SELECT ${OP_COLUMNS} FROM connect_onboarding_ops WHERE tenant_id = ? AND state = 'reserved' LIMIT 1`)
    .bind(tenantId)
    .first<OpRow>();
}

async function readOp(db: D1Database, opId: string): Promise<OpRow | null> {
  return db
    .prepare(`SELECT ${OP_COLUMNS} FROM connect_onboarding_ops WHERE op_id = ? LIMIT 1`)
    .bind(opId)
    .first<OpRow>();
}

function businessNameOf(shopName: string | null): string | null {
  if (shopName === null) {
    return null;
  }
  const trimmed = shopName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_BUSINESS_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Step 2: the reservation and its audit row, in one batch, conditioned on
 * the shop still being opted in without an account. Null when another
 * request's reservation won (the UNIQUE index) or the shop changed: re-read.
 */
async function reserveOperation(
  db: D1Database,
  principal: TenantAdminPrincipal,
  tenant: TenantConnectRow,
  api: ConnectAccountsApi,
  nowMs: number,
): Promise<OpRow | null> {
  const opId = crypto.randomUUID();
  const now = iso(nowMs);
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO connect_onboarding_ops (
             op_id, tenant_id, state, accounts_api, business_name, attempts,
             lease_expires_at, created_by, created_at, updated_at
           )
           SELECT ?, t.tenant_id, 'reserved', ?, ?, 1, ?, ?, ?, ?
           FROM tenants AS t
           WHERE t.tenant_id = ? AND t.connect_enabled = 1 AND t.stripe_account_id IS NULL`,
        )
        .bind(
          opId,
          api,
          businessNameOf(tenant.shop_name),
          iso(nowMs + CONNECT_ATTEMPT_LEASE_MS),
          principal.userId,
          now,
          now,
          tenant.tenant_id,
        ),
      tenantAuditStatement(
        db,
        principal,
        "connect.account.reserve",
        "connect_onboarding_op",
        opId,
        { accountsApi: api, opId },
        nowMs,
        { binds: [opId], sql: "EXISTS (SELECT 1 FROM connect_onboarding_ops WHERE op_id = ?)" },
      ),
    ]);
    if (results[0]?.meta.changes !== 1) {
      return null;
    }
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return null;
    }
    throw error;
  }
  return readOp(db, opId);
}

/**
 * Takes over a reserved operation whose lease ran out: a CAS on the attempts
 * count read, so of two requests that saw the same expired lease one wins.
 * Returns this request's attempt number, or null.
 */
async function claimOperation(db: D1Database, op: OpRow, nowMs: number): Promise<number | null> {
  const now = iso(nowMs);
  const result = await db
    .prepare(
      `UPDATE connect_onboarding_ops
       SET attempts = attempts + 1, lease_expires_at = ?, updated_at = MAX(updated_at, ?)
       WHERE op_id = ? AND state = 'reserved' AND attempts = ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    )
    .bind(iso(nowMs + CONNECT_ATTEMPT_LEASE_MS), now, op.op_id, op.attempts, now)
    .run();
  return result.meta.changes === 1 ? op.attempts + 1 : null;
}

/** An attempt whose outcome is unknown: the op stays reserved, the lease is released now. */
async function releaseLease(
  db: D1Database,
  op: OpRow,
  attempt: number,
  errorCode: string,
  nowMs: number,
): Promise<void> {
  const now = iso(nowMs);
  await db
    .prepare(
      `UPDATE connect_onboarding_ops
       SET lease_expires_at = ?, error_code = ?, updated_at = MAX(updated_at, ?)
       WHERE op_id = ? AND state = 'reserved' AND attempts = ?`,
    )
    .bind(now, errorCode, now, op.op_id, attempt)
    .run();
}

/** reserved → failed | abandoned, with its audit row, for exactly this transition. */
async function settleClosed(
  db: D1Database,
  principal: TenantAdminPrincipal,
  op: OpRow,
  state: "abandoned" | "failed",
  errorCode: string,
  nowMs: number,
): Promise<void> {
  const now = iso(nowMs);
  const transitionId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `UPDATE connect_onboarding_ops
         SET state = ?, error_code = ?, settled_at = MAX(created_at, ?), lease_expires_at = NULL,
             transition_id = ?, updated_at = MAX(updated_at, ?)
         WHERE op_id = ? AND state = 'reserved'`,
      )
      .bind(state, errorCode, now, transitionId, now, op.op_id),
    tenantAuditStatement(
      db,
      principal,
      state === "failed" ? "connect.account.refused" : "connect.account.abandoned",
      "connect_onboarding_op",
      op.op_id,
      { errorCode, opId: op.op_id },
      nowMs,
      {
        binds: [op.op_id, transitionId],
        sql: "EXISTS (SELECT 1 FROM connect_onboarding_ops WHERE op_id = ? AND transition_id = ?)",
      },
    ),
  ]);
}

/**
 * Step 4: ONE batch records what Stripe returned. The tenant is written only
 * `WHERE stripe_account_id IS NULL` and only when no other shop holds the
 * account (0019's UNIQUE index would otherwise abort the whole batch); when
 * either guard kept it out, a critical alert is raised in the same batch —
 * nothing is overwritten, a human reconciles the orphaned account.
 */
async function settleSucceeded(
  db: D1Database,
  principal: TenantAdminPrincipal,
  op: OpRow,
  accountId: string,
  nowMs: number,
): Promise<CreateAccountOutcome> {
  const now = iso(nowMs);
  const transitionId = crypto.randomUUID();
  const thisTransition = {
    binds: [op.op_id, transitionId],
    sql: "EXISTS (SELECT 1 FROM connect_onboarding_ops WHERE op_id = ? AND transition_id = ?)",
  };
  const results = await db.batch([
    db
      .prepare(
        `UPDATE connect_onboarding_ops
         SET state = 'succeeded', stripe_account_id = ?, error_code = NULL,
             settled_at = MAX(created_at, ?), lease_expires_at = NULL,
             transition_id = ?, updated_at = MAX(updated_at, ?)
         WHERE op_id = ? AND state = 'reserved'`,
      )
      .bind(accountId, now, transitionId, now, op.op_id),
    db
      .prepare(
        `UPDATE tenants
         SET stripe_account_id = ?1, updated_at = MAX(updated_at, ?2)
         WHERE tenant_id = ?3 AND stripe_account_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM tenants AS other WHERE other.stripe_account_id = ?1)`,
      )
      .bind(accountId, nowMs, op.tenant_id),
    alertStatement(
      db,
      {
        kind: "connect_account_conflict",
        message: `shop ${op.tenant_id}: Stripe account ${accountId} (onboarding operation ${op.op_id}) was NOT recorded — the shop already holds another account or the account belongs to another shop; nothing was overwritten, reconcile by hand`,
        resourceId: op.op_id,
        tenantId: op.tenant_id,
      },
      nowMs,
      // Whenever Stripe handed this shop an account the shop does not hold —
      // also when another request closed the operation meanwhile (then this
      // batch transitions nothing, and the account would be orphaned
      // silently). One open alert per operation.
      {
        binds: [op.tenant_id, accountId],
        sql: "NOT EXISTS (SELECT 1 FROM tenants WHERE tenant_id = ? AND stripe_account_id IS ?)",
      },
    ),
    tenantAuditStatement(
      db,
      principal,
      "connect.account.created",
      "connect_onboarding_op",
      op.op_id,
      { accountId, opId: op.op_id },
      nowMs,
      thisTransition,
    ),
  ]);

  const row = await readTenantConnect(db, op.tenant_id);
  if (row === null || row.stripe_account_id !== accountId) {
    return { status: "conflict" };
  }
  return results[0]?.meta.changes === 1 ? { row, status: "created" } : { row, status: "exists" };
}

async function pendingOutcome(
  db: D1Database,
  tenantId: string,
  reason: "in_progress" | "outcome_unknown" | "recovery_incomplete",
): Promise<CreateAccountOutcome> {
  const row = await readTenantConnect(db, tenantId);
  return row === null ? { status: "not_found" } : { reason, row, status: "pending" };
}

/** Step 3: one create call under the operation's key. */
async function attemptCreate(
  db: D1Database,
  gateway: ConnectGateway,
  principal: TenantAdminPrincipal,
  op: OpRow,
  attempt: number,
  clock: Clock,
): Promise<CreateAccountOutcome> {
  let facts: ConnectAccountFacts;
  try {
    facts = await gateway.createAccount({
      businessName: op.business_name,
      idempotencyKey: op.op_id,
      opId: op.op_id,
      tenantId: op.tenant_id,
    });
  } catch (error) {
    const failure = connectGatewayError(error);
    if (failure.rejected) {
      await settleClosed(
        db,
        principal,
        op,
        "failed",
        failure.code === null ? "stripe_refused" : `stripe_refused:${failure.code}`,
        clock(),
      );
      return { status: "refused" };
    }
    await releaseLease(db, op, attempt, "outcome_unknown", clock());
    return pendingOutcome(db, op.tenant_id, "outcome_unknown");
  }
  return settleSucceeded(db, principal, op, facts.accountId, clock());
}

/**
 * The key is too old to retry: find what Stripe holds for this tenant by its
 * metadata. One account, from a COMPLETE listing ⇒ adopt it (whichever
 * operation made it). More than one ⇒ a human decides (alert). None, from a
 * COMPLETE listing ⇒ nothing was ever created: `abandoned`, and the caller
 * starts a new operation. An incomplete listing with fewer than two matches
 * decides nothing: the operation stays reserved (`recovery_incomplete`).
 */
async function recoverByListing(
  db: D1Database,
  gateway: ConnectGateway,
  principal: TenantAdminPrincipal,
  op: OpRow,
  attempt: number,
  clock: Clock,
): Promise<CreateAccountOutcome | "abandoned"> {
  let listing;
  try {
    listing = await gateway.findAccountsByTenant(op.tenant_id);
  } catch {
    await releaseLease(db, op, attempt, "recovery_listing_failed", clock());
    return pendingOutcome(db, op.tenant_id, "recovery_incomplete");
  }

  const found = listing.accounts.filter((account) => account.metadata.tenant_id === op.tenant_id);
  // "Exactly one" is only known from a COMPLETE listing (Codex P2 on CP3-F):
  // when the scan stopped at its limit, a second account carrying this shop's
  // metadata may sit on a page that was never read, and adopting the visible
  // one would skip the duplicate alert. Two or more are a duplicate whatever
  // else the unread pages hold.
  if (found.length === 1 && listing.complete) {
    return settleSucceeded(db, principal, op, (found[0] as ConnectAccountFacts).accountId, clock());
  }
  if (found.length > 1) {
    const nowMs = clock();
    await db.batch([
      alertStatement(
        db,
        {
          kind: "connect_account_duplicate",
          message: `shop ${op.tenant_id}: Stripe holds ${found.length} accounts carrying this shop's metadata (${found
            .map((account) => account.accountId)
            .join(", ")
            .slice(0, 600)}); onboarding operation ${op.op_id} cannot choose — reconcile by hand`,
          resourceId: op.op_id,
          tenantId: op.tenant_id,
        },
        nowMs,
        { binds: [], sql: "1 = 1" },
      ),
    ]);
    await releaseLease(db, op, attempt, "duplicate_accounts", nowMs);
    return { status: "conflict" };
  }
  if (!listing.complete) {
    await releaseLease(db, op, attempt, "recovery_listing_incomplete", clock());
    return pendingOutcome(db, op.tenant_id, "recovery_incomplete");
  }

  await settleClosed(db, principal, op, "abandoned", "idempotency_window_expired", clock());
  return "abandoned";
}

/**
 * `POST /v1/admin/payments/connect/account`: the shop's account, created at
 * most once. See the module header for every path.
 */
export async function createOrReuseConnectAccount(
  db: D1Database,
  principal: TenantAdminPrincipal,
  deps: CreateAccountDeps,
): Promise<CreateAccountOutcome> {
  const clock = deps.clock ?? Date.now;

  for (let round = 0; round < MAX_CREATE_ROUNDS; round += 1) {
    const tenant = await readTenantConnect(db, principal.tenantId);
    if (tenant === null || tenant.connect_enabled !== 1) {
      return { status: "not_found" };
    }
    if (tenant.stripe_account_id !== null) {
      return { row: tenant, status: "exists" };
    }

    const nowMs = clock();
    let op = await readReservedOp(db, principal.tenantId);
    let attempt: number;
    if (op === null) {
      op = await reserveOperation(db, principal, tenant, deps.defaultApi, nowMs);
      if (op === null) {
        continue;
      }
      attempt = 1;
    } else {
      if (op.lease_expires_at !== null && Date.parse(op.lease_expires_at) > nowMs) {
        return { reason: "in_progress", row: tenant, status: "pending" };
      }
      const claimed = await claimOperation(db, op, nowMs);
      if (claimed === null) {
        return { reason: "in_progress", row: tenant, status: "pending" };
      }
      attempt = claimed;
    }

    const gateway = deps.gatewayFor(op.accounts_api);
    if (gateway === null) {
      await releaseLease(db, op, attempt, "gateway_unavailable", clock());
      return pendingOutcome(db, op.tenant_id, "outcome_unknown");
    }

    if (nowMs - Date.parse(op.created_at) < CONNECT_KEY_RETRY_WINDOW_MS) {
      return attemptCreate(db, gateway, principal, op, attempt, clock);
    }

    const recovered = await recoverByListing(db, gateway, principal, op, attempt, clock);
    if (recovered !== "abandoned") {
      return recovered;
    }
    // Nothing exists at Stripe for the old key: the next round reserves a new one.
  }

  return pendingOutcome(db, principal.tenantId, "in_progress");
}

// ═══════════════════════════════════════════════════════════════════════════
// stuck reservations (CP3-F review round 1) — for the 15-minute cron
// ═══════════════════════════════════════════════════════════════════════════

/** An operation `reserved` longer than this is shown to a human. */
export const CONNECT_STUCK_RESERVATION_MS = 24 * 60 * 60 * 1_000;

/** Alerts raised per run at most: the cron never does unbounded work. */
export const CONNECT_STUCK_ALERT_BATCH = 50;

export const CONNECT_STUCK_ALERT_KIND = "connect_onboarding_stuck_24h";

/**
 * ONE warning alert per onboarding operation that has been `reserved` for
 * more than 24 hours (strictly: created before `now − 24 h`). Nothing else
 * looks at those: a reservation is retried only by the seller's next request,
 * so a lost answer followed by a seller who walks away — or a shop the
 * platform disabled mid-creation — would otherwise sit unseen.
 *
 * The same shape and de-duplication as the other alerts (money-alerts.ts):
 * one OPEN alert per (kind, operation), ids and codes only in the message —
 * no amount, no URL, no personal data. One `INSERT … SELECT … WHERE NOT
 * EXISTS (open alert) … LIMIT`, evaluated atomically, so running it every 15
 * minutes (or twice at once) writes no duplicate; once an operator resolves
 * the alert, an operation that is STILL reserved raises a fresh one. Oldest
 * first, at most `limit` per run. Returns how many it raised.
 *
 * Exported for `scheduled()`; the reviewer wires it (src/outbox/scheduled.ts
 * is not this module's).
 */
export async function raiseStuckOnboardingAlerts(
  db: D1Database,
  nowMs: number,
  limit: number = CONNECT_STUCK_ALERT_BATCH,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO alerts (
         id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
       )
       SELECT ?1 || ':' || lower(hex(randomblob(16))), o.tenant_id, ?1, 'warning',
              'shop ' || o.tenant_id || ': Stripe account creation (onboarding operation '
                || o.op_id || ', ' || o.attempts || ' attempt(s), last error '
                || COALESCE(o.error_code, 'none')
                || ') has stayed reserved for over 24 hours; the shop''s next request retries it — check the Connect status of the shop',
              'connect_onboarding_op', o.op_id, ?2
       FROM connect_onboarding_ops AS o
       WHERE o.state = 'reserved' AND o.created_at < ?3
         AND NOT EXISTS (
           SELECT 1 FROM alerts AS a
           WHERE a.kind = ?1 AND a.resource_type = 'connect_onboarding_op'
             AND a.resource_id = o.op_id AND a.resolved_at IS NULL
         )
       ORDER BY o.created_at, o.op_id
       LIMIT ?4`,
    )
    .bind(
      CONNECT_STUCK_ALERT_KIND,
      iso(nowMs),
      iso(nowMs - CONNECT_STUCK_RESERVATION_MS),
      Math.max(0, Math.floor(limit)),
    )
    .run();
  return result.meta.changes;
}

// ═══════════════════════════════════════════════════════════════════════════
// onboarding link, refresh, dashboard login link
// ═══════════════════════════════════════════════════════════════════════════

export type LinkOutcome =
  | { link: ConnectLink; status: "ok" }
  | { status: "gateway_error" }
  | { status: "no_account" }
  | { status: "not_found" };

/**
 * The return and refresh URLs Stripe sends the seller back to: built from the
 * canonical allowlist only (never the request's Origin or Host), carrying the
 * shop id the way Firebase's did (connectOnboarding.ts accountLinkUrls: the
 * managed-shop context does not survive the round trip through Stripe).
 *
 * The page is an ADMIN page. The allowlist lists `api` and `web` today, so it
 * is served by the web origin; once an `admin` surface is listed it is used —
 * the same fallback the invite/reset links use (auth/password-reset.ts
 * resetPageOrigin).
 */
export function onboardingReturnUrls(
  origins: CanonicalOrigins,
  tenantId: string,
): { refreshUrl: string; returnUrl: string } {
  const listed = (origins as Readonly<Partial<Record<"admin", string>>>).admin;
  const base = typeof listed === "string" ? listed : origins.web;
  const shop = encodeURIComponent(tenantId);
  return {
    refreshUrl: `${base}/admin/payments?refresh=1&shopId=${shop}`,
    returnUrl: `${base}/admin/payments?return=1&shopId=${shop}`,
  };
}

/**
 * `POST /v1/admin/payments/connect/onboarding-link`: a fresh hosted
 * onboarding URL. Handed to the caller only — never stored, never logged, and
 * the audit row names the account, not the link.
 */
export async function issueOnboardingLink(
  db: D1Database,
  gateway: ConnectGateway,
  principal: TenantAdminPrincipal,
  origins: CanonicalOrigins,
  nowMs: number,
): Promise<LinkOutcome> {
  const tenant = await readTenantConnect(db, principal.tenantId);
  if (tenant === null || tenant.connect_enabled !== 1) {
    return { status: "not_found" };
  }
  if (tenant.stripe_account_id === null) {
    return { status: "no_account" };
  }

  let link: ConnectLink;
  try {
    link = await gateway.createOnboardingLink({
      accountId: tenant.stripe_account_id,
      ...onboardingReturnUrls(origins, tenant.tenant_id),
    });
  } catch {
    return { status: "gateway_error" };
  }
  if (!isHttpsUrl(link.url)) {
    return { status: "gateway_error" };
  }

  await tenantAuditStatement(
    db,
    principal,
    "connect.onboarding_link",
    "tenant",
    tenant.tenant_id,
    { accountId: tenant.stripe_account_id },
    nowMs,
  ).run();
  return { link, status: "ok" };
}

export type LoginLinkOutcome =
  | { status: "gateway_error" }
  | { status: "not_found" }
  | { status: "onboarding_incomplete" }
  | { status: "ok"; url: string };

/**
 * `POST /v1/admin/payments/connect/login-link`: the Express dashboard, only
 * once the account can take charges (Firebase: chargesEnabled). The ROUTE
 * refuses a platform user acting as the shop before this is reached.
 */
export async function issueDashboardLoginLink(
  db: D1Database,
  gateway: ConnectGateway,
  principal: TenantAdminPrincipal,
  nowMs: number,
): Promise<LoginLinkOutcome> {
  const tenant = await readTenantConnect(db, principal.tenantId);
  if (tenant === null) {
    return { status: "not_found" };
  }
  if (tenant.stripe_account_id === null || tenant.stripe_charges_enabled !== 1) {
    return { status: "onboarding_incomplete" };
  }

  let link: { url: string };
  try {
    link = await gateway.createLoginLink(tenant.stripe_account_id);
  } catch {
    return { status: "gateway_error" };
  }
  if (!isHttpsUrl(link.url)) {
    return { status: "gateway_error" };
  }

  await tenantAuditStatement(
    db,
    principal,
    "connect.login_link",
    "tenant",
    tenant.tenant_id,
    { accountId: tenant.stripe_account_id },
    nowMs,
  ).run();
  return { status: "ok", url: link.url };
}

export type RefreshOutcome =
  | { applied: boolean; row: TenantConnectRow; status: "ok" }
  | { status: "gateway_error" }
  | { status: "not_found" };

/**
 * `POST /v1/admin/payments/connect/refresh`: Stripe's CURRENT view of the
 * account, written as facts — under the SAME ordering rule as the
 * `account.updated` handler and the reconciliation resync (0027):
 *
 *   - `stripe_account_synced_at` is read BEFORE the call and the write is
 *     guarded on it being unchanged (`IS ?`). An event applied meanwhile moved
 *     it, so its newer facts are never overwritten (the refresh then changes
 *     nothing and answers what is stored).
 *   - The watermark written is the call's START, floored to its second
 *     (crons.ts secondWatermark): an event created in an earlier second is
 *     older than what Stripe just returned and is dropped as stale; one
 *     created in the same second is a tie the handler merges fail-closed and
 *     marks for resync — never silently lost.
 *   - A pending resync mark is cleared: this retrieve IS the authoritative
 *     read the mark was waiting for (as the cron's resync clears it).
 *
 * The requirement list and the disabled reason travel in the same guarded
 * write (the webhook does not write them — reviewer wiring in the report).
 */
export async function refreshConnectStatus(
  db: D1Database,
  gateway: ConnectGateway,
  tenantId: string,
  clock: Clock = Date.now,
): Promise<RefreshOutcome> {
  const tenant = await readTenantConnect(db, tenantId);
  if (tenant === null) {
    return { status: "not_found" };
  }
  if (tenant.stripe_account_id === null) {
    return { applied: false, row: tenant, status: "ok" };
  }

  const startedAt = clock();
  let facts: ConnectAccountFacts;
  try {
    facts = await gateway.retrieveAccount(tenant.stripe_account_id);
  } catch {
    return { status: "gateway_error" };
  }
  if (facts.accountId !== tenant.stripe_account_id) {
    return { status: "gateway_error" };
  }

  const nowMs = clock();
  const result = await db
    .prepare(
      `UPDATE tenants
       SET stripe_charges_enabled = ?,
           stripe_payouts_enabled = ?,
           stripe_details_submitted = ?,
           stripe_requirements_due_json = ?,
           stripe_disabled_reason = ?,
           stripe_account_synced_at = MAX(COALESCE(stripe_account_synced_at, 0), ?),
           stripe_account_resync_needed = 0,
           updated_at = MAX(updated_at, ?)
       WHERE tenant_id = ? AND stripe_account_id = ?
         -- COMPARE-AND-SET ON EVERYTHING THIS REQUEST READ (Codex P1 on CP3-F).
         -- The watermark alone has second resolution: an account.updated that
         -- arrives while this request waits for Stripe and shares the stored
         -- watermark changes the flags (fail-closed) and marks the shop for
         -- the resync WITHOUT moving the watermark. Guarded on the watermark
         -- only, this stale read would then switch charges back on and clear
         -- the marker. Any intervening change of the account's state makes
         -- this statement match nothing; the resync settles it.
         AND stripe_account_synced_at IS ?
         AND stripe_account_resync_needed = ?
         AND stripe_charges_enabled = ?
         AND stripe_payouts_enabled = ?
         AND stripe_details_submitted = ?
         AND stripe_requirements_due_json IS ?
         AND stripe_disabled_reason IS ?`,
    )
    .bind(
      facts.chargesEnabled ? 1 : 0,
      facts.payoutsEnabled ? 1 : 0,
      facts.detailsSubmitted ? 1 : 0,
      JSON.stringify(requirementsFrom(facts.requirementsDue)),
      disabledReasonFrom(facts.disabledReason),
      secondWatermark(startedAt),
      nowMs,
      tenant.tenant_id,
      tenant.stripe_account_id,
      tenant.stripe_account_synced_at,
      tenant.stripe_account_resync_needed,
      tenant.stripe_charges_enabled,
      tenant.stripe_payouts_enabled,
      tenant.stripe_details_submitted,
      tenant.stripe_requirements_due_json,
      tenant.stripe_disabled_reason,
    )
    .run();

  const row = await readTenantConnect(db, tenantId);
  // "Matched" is changes > 0: D1 also counts rows a trigger wrote.
  return row === null
    ? { status: "not_found" }
    : { applied: result.meta.changes > 0, row, status: "ok" };
}

// ═══════════════════════════════════════════════════════════════════════════
// platform: opt-in, payout delay, the full read
// ═══════════════════════════════════════════════════════════════════════════

export type PlatformConnectOutcome =
  | { row: TenantConnectRow; status: "ok" }
  | { status: "not_found" };

/**
 * `POST /v1/platform/tenants/:id/connect/enable|disable`. The flag and its
 * audit row in one batch; idempotent (the same value twice is still audited,
 * like setTenantStatus). Disabling touches neither Stripe nor the account: it
 * closes the seller's create and onboarding-link routes. Checkout keys on the
 * account's `charges_enabled` alone, so a live shop keeps taking payments.
 */
export async function setConnectEnabled(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  enabled: boolean,
  nowMs: number,
): Promise<PlatformConnectOutcome> {
  if ((await readTenantConnect(db, tenantId)) === null) {
    return { status: "not_found" };
  }
  await db.batch([
    db
      .prepare("UPDATE tenants SET connect_enabled = ?, updated_at = MAX(updated_at, ?) WHERE tenant_id = ?")
      .bind(enabled ? 1 : 0, nowMs, tenantId),
    platformAuditStatement(db, principal, tenantId, enabled ? "connect.enable" : "connect.disable", null, nowMs),
  ]);
  const row = await readTenantConnect(db, tenantId);
  return row === null ? { status: "not_found" } : { row, status: "ok" };
}

/** `{ "delayDays": <0..365> | "minimum" }`, exactly. */
export function parsePayoutDelayInput(body: unknown): { delayDays: number | "minimum" } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body);
  const delayDays = (body as Record<string, unknown>).delayDays;
  if (keys.length !== 1 || keys[0] !== "delayDays") {
    return null;
  }
  if (delayDays === "minimum") {
    return { delayDays };
  }
  return typeof delayDays === "number" &&
    Number.isSafeInteger(delayDays) &&
    delayDays >= 0 &&
    delayDays <= MAX_PAYOUT_DELAY_DAYS
    ? { delayDays }
    : null;
}

export type PayoutDelayOutcome =
  | PlatformConnectOutcome
  | { status: "gateway_error" }
  | { status: "no_account" }
  | { status: "refused" };

/**
 * `PUT /v1/platform/tenants/:id/connect/payout-delay`: Stripe first (the
 * source of truth), then the mirror + audit row — only after Stripe accepted.
 * "minimum" is stored as NULL (Stripe's default IS the country minimum).
 */
export async function setPayoutDelay(
  db: D1Database,
  gateway: ConnectGateway,
  principal: PlatformPrincipal,
  tenantId: string,
  input: { delayDays: number | "minimum" },
  nowMs: number,
): Promise<PayoutDelayOutcome> {
  const tenant = await readTenantConnect(db, tenantId);
  if (tenant === null) {
    return { status: "not_found" };
  }
  if (tenant.stripe_account_id === null) {
    return { status: "no_account" };
  }

  try {
    await gateway.updatePayoutDelay({ accountId: tenant.stripe_account_id, delayDays: input.delayDays });
  } catch (error) {
    return connectGatewayError(error).rejected ? { status: "refused" } : { status: "gateway_error" };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE tenants SET payout_delay_days = ?, updated_at = MAX(updated_at, ?)
         WHERE tenant_id = ? AND stripe_account_id = ?`,
      )
      .bind(input.delayDays === "minimum" ? null : input.delayDays, nowMs, tenantId, tenant.stripe_account_id),
    platformAuditStatement(
      db,
      principal,
      tenantId,
      "connect.payout_delay",
      { accountId: tenant.stripe_account_id, delayDays: input.delayDays },
      nowMs,
    ),
  ]);
  const row = await readTenantConnect(db, tenantId);
  return row === null ? { status: "not_found" } : { row, status: "ok" };
}
