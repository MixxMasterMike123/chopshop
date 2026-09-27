import type { PlatformPrincipal } from "../auth/live-authorization";
import {
  ELIGIBLE_PRODUCTS_FROM,
  PUBLIC_ELIGIBILITY_PREDICATE,
} from "./eligibility";
import type {
  BlocklistEntry,
  ScreeningStatus,
  StoredScreening,
} from "./screening-core";
import {
  decideScreening,
  findScreeningHits,
  isHardBlock,
  normalizeScreeningTerm,
  overlayDecision,
  productScreeningTexts,
  REVIEW_FIRST_PRODUCTS,
  screeningHaystacks,
  sqlMatchTerms,
  termMatch,
  toMachineState,
} from "./screening-core";

/**
 * Content screening — the D1 half (PLAN §2.4, DECISIONS D8, LAUNCH_TODO A11).
 *
 * Firebase ran screening in a Firestore trigger AFTER the write
 * (screenProductOnWrite + the two rescreen triggers). Here the decision is
 * computed BEFORE the mutating batch from the post-mutation facts the caller
 * supplies, and returned as statements the caller appends to ITS batch — so
 * the screened content and its verdict commit together or not at all.
 *
 * Only LIVE products are screened (published = 1, status 'active'): the
 * Firebase `isLive` rule — a draft harms nobody. The first screening therefore
 * happens at publish, and every later mutation of a live product rescreens.
 *
 * ── THE FENCE (Codex CP2 P1) ────────────────────────────────────────────────
 * A decision is computed from facts read BEFORE the batch, so something must
 * stop the batch from committing when those facts moved in between — most
 * sharply, a platform approval landing between the read and a seller edit
 * that introduces a blocked term (the edit would otherwise go live under the
 * approval of the previous content). The screening row is that lock:
 *
 *   1. every mutation of screened content or eligibility reads a
 *      ScreeningGuard FIRST (readScreeningGuard), before any content read;
 *   2. its batch carries exactly one statement that writes the row to
 *      `version = <read version> + 1` (or INSERTs it, or — when there was no
 *      row and the mutation is not screening — asserts there still is none);
 *   3. any other writer in between has bumped the version (every writer
 *      does), so that statement trips `product_screening_version_monotonic`
 *      (or the primary key) and the WHOLE batch rolls back — nothing of the
 *      mutation commits;
 *   4. withScreeningRetry re-runs the mutation once from fresh reads; a second
 *      conflict answers `conflict` (409).
 */

interface ScreeningRow {
  earlier_hits_json: string;
  hits_json: string;
  requires_approval: number;
  status: ScreeningStatus;
  takedown_at: string | null;
  version: number;
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

async function loadScreeningRow(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<(StoredScreening & { version: number }) | null> {
  const row = await db
    .prepare(
      `SELECT screening.status, screening.hits_json, screening.earlier_hits_json,
              screening.requires_approval, screening.version, product.takedown_at
       FROM product_screening AS screening
       INNER JOIN products AS product ON product.product_id = screening.product_id
       WHERE screening.tenant_id = ? AND screening.product_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, productId)
    .first<ScreeningRow>();
  return row === null
    ? null
    : {
        earlierHits: parseStringArray(row.earlier_hits_json),
        hits: parseStringArray(row.hits_json),
        requiresApproval: row.requires_approval === 1,
        status: row.status,
        takenDown: row.takedown_at !== null,
        version: row.version,
      };
}

/** The blocklist is capped here and at the add route (no silent truncation). */
export const MAX_SCREENING_TERMS = 2_000;

async function loadBlocklist(db: D1Database): Promise<BlocklistEntry[]> {
  const result = await db
    .prepare(
      `SELECT term, kind, hard_block FROM content_screening_terms ORDER BY term LIMIT ${MAX_SCREENING_TERMS}`,
    )
    .all<{ hard_block: number; kind: string; term: string }>();
  return result.results.map((row) => ({
    hardBlock: row.hard_block === 1,
    kind: row.kind,
    term: row.term,
  }));
}

/**
 * Everything a verdict depends on besides the product (CP3-D): the blocklist
 * and the three screening settings of `platform_settings` (defaults when the
 * row is absent: N = 2, no global hard block, version 0).
 *
 * The VERSION IS READ FIRST, then the terms. A term change committing between
 * the two reads leaves this verdict stamped with the older version, which the
 * terms fence (migration 0034) refuses at commit — a spurious retry, never a
 * verdict computed from a newer term list under an older stamp. (Two plain
 * reads rather than a batch: the race suites intercept `batch()` as "the
 * mutation's write", and a read batch would shift their interleaving.)
 */
export interface ScreeningConfig {
  blocklist: BlocklistEntry[];
  globalHardBlock: boolean;
  reviewFirstProducts: number;
  termsVersion: number;
}

export async function loadScreeningConfig(db: D1Database): Promise<ScreeningConfig> {
  const settings = await db
    .prepare(
      `SELECT review_first_products, screening_hard_block, screening_terms_version
       FROM platform_settings WHERE id = 1 LIMIT 1`,
    )
    .first<{
      review_first_products: number;
      screening_hard_block: number;
      screening_terms_version: number;
    }>();
  const blocklist = await loadBlocklist(db);
  return {
    blocklist,
    globalHardBlock: settings?.screening_hard_block === 1,
    reviewFirstProducts: settings?.review_first_products ?? REVIEW_FIRST_PRODUCTS,
    termsVersion: settings?.screening_terms_version ?? 0,
  };
}

/**
 * The file names of the ORIGINALS behind these artworks — the CF stand-in for
 * Firebase's `podArtwork.fileName` (the object store keeps the uploader's
 * sanitized name as the last key segment).
 */
async function artworkFileNames(
  db: D1Database,
  tenantId: string,
  artworkIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(artworkIds)];
  if (unique.length === 0) {
    return [];
  }
  const result = await db
    .prepare(
      `SELECT object.object_key
       FROM pod_artwork AS artwork
       INNER JOIN stored_objects AS object
         ON object.object_id = artwork.original_object_id
        AND object.tenant_id = artwork.tenant_id
       WHERE artwork.tenant_id = ?
         AND artwork.artwork_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(tenantId, JSON.stringify(unique))
    .all<{ object_key: string }>();
  return result.results
    .map((row) => row.object_key.split("/").pop() ?? "")
    .filter((name) => name.trim() !== "");
}

/**
 * Other products of this shop that are publicly eligible right now — the
 * Firebase `otherLiveCount` over `productsPublic` (the live set), counted up to
 * the cap it is compared against. Uses THE predicate, so a pending product is
 * not live and a new shop cannot clear D8 by publishing two dummies.
 */
async function otherLiveCount(
  db: D1Database,
  tenantId: string,
  productId: string,
  cap: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM (
         SELECT 1
         ${ELIGIBLE_PRODUCTS_FROM}
         WHERE publication.tenant_id = ?
           AND product.tenant_id = ?
           AND product.product_id <> ?
           AND ${PUBLIC_ELIGIBILITY_PREDICATE}
         LIMIT ?
       )`,
    )
    .bind(tenantId, tenantId, productId, cap)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function activeMappingArtworkIds(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT DISTINCT artwork_id FROM pod_mappings
       WHERE tenant_id = ? AND product_id = ? AND status = 'active'`,
    )
    .bind(tenantId, productId)
    .all<{ artwork_id: string }>();
  return result.results.map((row) => row.artwork_id);
}

/**
 * The optimistic lock of one product's screened content: the screening row as
 * it was read at the START of a mutation (null = the product was never
 * screened). See THE FENCE above.
 */
export interface ScreeningGuard {
  productId: string;
  row: (StoredScreening & { version: number }) | null;
  tenantId: string;
}

export async function readScreeningGuard(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<ScreeningGuard> {
  return { productId, row: await loadScreeningRow(db, tenantId, productId), tenantId };
}

/**
 * The D1 error a tripped fence raises (the version trigger or the PK), or the
 * terms fence (0034: the blocklist or the global hard block changed after the
 * verdict's reads — re-run from fresh reads exactly like a racing writer).
 */
export function isScreeningConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("screening version must increase") ||
    message.includes("screening terms changed") ||
    (message.includes("UNIQUE constraint failed") &&
      message.includes("product_screening.product_id"))
  );
}

/**
 * Run a guarded mutation; on a tripped fence run it ONCE more from fresh
 * reads, and if the fence trips again answer `onConflict()` rather than
 * committing anything under facts the mutation never saw.
 *
 * Each attempt gets its own clock reading (Codex CP2 follow-on): the retry
 * runs AFTER the writer it lost to, whose rows may be stamped later than this
 * mutation's original `now` — reusing that instant would write an
 * `updated_at` before the row's own `created_at`. The retry takes
 * max(now, the current time); the SQL additionally clamps every ISO stamp it
 * writes to the row's `created_at` (another isolate's clock may run ahead).
 */
export async function withScreeningRetry<T>(
  now: number,
  attempt: (now: number) => Promise<T>,
  onConflict: () => T,
): Promise<T> {
  for (let round = 0; round < 2; round += 1) {
    try {
      return await attempt(round === 0 ? now : Math.max(now, Date.now()));
    } catch (error) {
      if (!isScreeningConflict(error)) {
        throw error;
      }
    }
  }
  return onConflict();
}

/**
 * The fence for a batch that does NOT (re)screen — a mutation of a product
 * that is not live. With a row: bump its version (a concurrent writer that
 * read the same version then trips). Without one: assert there still is none
 * — `version = 0` on a row that appeared meanwhile (a first publish, a
 * platform takedown) trips the version trigger.
 */
export function screeningFenceStatement(
  db: D1Database,
  guard: ScreeningGuard,
  now: number,
): D1PreparedStatement {
  return guard.row === null
    ? db
        .prepare(
          "UPDATE product_screening SET version = 0 WHERE tenant_id = ? AND product_id = ?",
        )
        .bind(guard.tenantId, guard.productId)
    : db
        .prepare(
          `UPDATE product_screening SET version = ?, updated_at = max(?, created_at)
           WHERE tenant_id = ? AND product_id = ?`,
        )
        .bind(
          guard.row.version + 1,
          new Date(now).toISOString(),
          guard.tenantId,
          guard.productId,
        );
}

export interface ScreeningStatementsInput {
  /** Post-mutation artwork ids of the product's ACTIVE mappings (default: current). */
  artworkIds?: readonly string[];
  /** Read at the START of the mutation, before any content it screens. */
  guard: ScreeningGuard;
  now: number;
  /** Post-mutation screened text (default: the stored product row). */
  texts?: { description: string | null; name: string };
}

export interface ScreeningStatements {
  statements: D1PreparedStatement[];
  /** The status the product will have after the batch (null = never screened). */
  status: ScreeningStatus | null;
}

/**
 * Decide the product's screening for its POST-mutation state and return the
 * statement that records it, to be appended to the caller's batch.
 *
 * The caller decides liveness: call this only for a product that is (or is
 * becoming) live. The returned statement IS the batch's fence (THE FENCE
 * above): it always writes the row — even when the decision is "no change" —
 * at the guard's version + 1, so a batch computed from stale facts never
 * commits.
 */
export async function screeningStatementsFor(
  db: D1Database,
  input: ScreeningStatementsInput,
): Promise<ScreeningStatements> {
  const { productId, tenantId } = input.guard;
  const prevRow = input.guard.row;

  let texts = input.texts;
  if (texts === undefined) {
    const product = await db
      .prepare(
        "SELECT name, description FROM products WHERE tenant_id = ? AND product_id = ? LIMIT 1",
      )
      .bind(tenantId, productId)
      .first<{ description: string | null; name: string }>();
    if (product === null) {
      return {
        statements: [screeningFenceStatement(db, input.guard, input.now)],
        status: prevRow?.status ?? null,
      };
    }
    texts = product;
  }

  const artworkIds = input.artworkIds ?? (await activeMappingArtworkIds(db, tenantId, productId));
  // The config (settings version FIRST, then the terms) before anything else
  // it is compared against — see loadScreeningConfig.
  const config = await loadScreeningConfig(db);
  const fileNames = await artworkFileNames(db, tenantId, artworkIds);
  const screenedTexts = productScreeningTexts(texts, fileNames);
  const haystacks = screeningHaystacks(screenedTexts);
  const hits = findScreeningHits(screenedTexts, config.blocklist);
  const terms = hits.map((hit) => hit.term);
  // Firebase parity (screenProductOnWrite.ts:119): the platform's global
  // switch makes every hit blocking.
  const hardBlock = isHardBlock(hits, config.globalHardBlock);
  // Only needed for a first screening; Firebase skipped the query otherwise.
  const shopPublishedCount =
    prevRow === null
      ? await otherLiveCount(db, tenantId, productId, config.reviewFirstProducts)
      : config.reviewFirstProducts;

  const decision = decideScreening({
    hardBlock,
    prev: toMachineState(prevRow),
    reviewFirstProducts: config.reviewFirstProducts,
    shopPublishedCount,
    terms,
  });
  const next = overlayDecision(prevRow, decision, shopPublishedCount, config.reviewFirstProducts);
  const iso = new Date(input.now).toISOString();

  if (next === null) {
    // The machine's no-op still fences — the unchanged verdict is only right
    // for the facts it was computed from — and records those facts: the text
    // the verdict holds for (a rename that changes no hit still changes what
    // a later blocklist change is checked against) and the term version.
    if (prevRow === null) {
      return {
        statements: [screeningFenceStatement(db, input.guard, input.now)],
        status: null,
      };
    }
    return {
      statements: [
        db
          .prepare(
            `UPDATE product_screening
             SET screened_tokens = ?, screened_raw = ?, terms_version = ?,
                 version = ?, updated_at = max(?, created_at)
             WHERE tenant_id = ? AND product_id = ?`,
          )
          .bind(
            haystacks.tokens,
            haystacks.raw,
            config.termsVersion,
            prevRow.version + 1,
            iso,
            tenantId,
            productId,
          ),
      ],
      status: prevRow.status,
    };
  }

  const statement =
    prevRow === null
      ? db
          .prepare(
            `INSERT INTO product_screening (
               product_id, tenant_id, status, reason, hits_json, earlier_hits_json,
               requires_approval, decided_by, decided_at, version, created_at, updated_at,
               screened_tokens, screened_raw, terms_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?, 1, ?, ?, ?, ?, ?)`,
          )
          .bind(
            productId,
            tenantId,
            next.status,
            next.reason,
            JSON.stringify(next.hits),
            JSON.stringify(next.earlierHits),
            next.requiresApproval ? 1 : 0,
            iso,
            iso,
            iso,
            haystacks.tokens,
            haystacks.raw,
            config.termsVersion,
          )
      : db
          .prepare(
            `UPDATE product_screening
             SET status = ?, reason = ?, hits_json = ?, earlier_hits_json = ?,
                 requires_approval = ?, decided_by = 'system',
                 decided_at = max(?, created_at),
                 version = ?, updated_at = max(?, created_at),
                 screened_tokens = ?, screened_raw = ?, terms_version = ?
             WHERE tenant_id = ? AND product_id = ?`,
          )
          .bind(
            next.status,
            next.reason,
            JSON.stringify(next.hits),
            JSON.stringify(next.earlierHits),
            next.requiresApproval ? 1 : 0,
            iso,
            // An explicit target, not `version + 1`: if another writer bumped
            // the row since the guard was read, this is <= the stored version
            // and the monotonic trigger aborts the whole batch.
            prevRow.version + 1,
            iso,
            haystacks.tokens,
            haystacks.raw,
            config.termsVersion,
            tenantId,
            productId,
          );

  return { statements: [statement], status: next.status };
}

/** The admin-facing status of one product (null = never screened). */
export async function loadScreeningStatus(
  db: D1Database,
  tenantId: string,
  productId: string,
): Promise<ScreeningStatus | null> {
  const row = await db
    .prepare(
      "SELECT status FROM product_screening WHERE tenant_id = ? AND product_id = ? LIMIT 1",
    )
    .bind(tenantId, productId)
    .first<{ status: ScreeningStatus }>();
  return row?.status ?? null;
}

// ── the platform decision (POST /v1/platform/screening/:productId) ─────────

export type PlatformDecision = "approved" | "blocked";

export interface PlatformScreeningView {
  decidedAt: string;
  decidedBy: string;
  hits: string[];
  productId: string;
  productName: string;
  reason: string | null;
  status: ScreeningStatus;
  takenDown: boolean;
  tenantId: string;
  version: number;
}

export function parsePlatformDecisionInput(body: unknown): PlatformDecision | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "decision")) {
    return null;
  }
  return record.decision === "approved" || record.decision === "blocked"
    ? record.decision
    : null;
}

interface PlatformRow {
  decided_at: string;
  decided_by: string;
  hits_json: string;
  name: string;
  product_id: string;
  reason: string | null;
  status: ScreeningStatus;
  takedown_at: string | null;
  tenant_id: string;
  version: number;
}

const PLATFORM_SELECT = `SELECT screening.product_id, screening.tenant_id, screening.status,
     screening.reason, screening.hits_json, screening.decided_by, screening.decided_at,
     screening.version, product.name, product.takedown_at
   FROM product_screening AS screening
   INNER JOIN products AS product
     ON product.product_id = screening.product_id
    AND product.tenant_id = screening.tenant_id`;

function toPlatformView(row: PlatformRow): PlatformScreeningView {
  return {
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    hits: parseStringArray(row.hits_json),
    productId: row.product_id,
    productName: row.name,
    reason: row.reason,
    status: row.status,
    takenDown: row.takedown_at !== null,
    tenantId: row.tenant_id,
    version: row.version,
  };
}

/** The platform review queue: pending first, then flagged and blocked. */
export async function listScreeningQueue(
  db: D1Database,
  status: ScreeningStatus | null,
): Promise<PlatformScreeningView[]> {
  const result = await db
    .prepare(
      `${PLATFORM_SELECT}
       WHERE screening.status ${status === null ? "IN ('pending', 'flagged', 'blocked')" : "= ?"}
       ORDER BY screening.decided_at ASC, screening.product_id ASC
       LIMIT 100`,
    )
    .bind(...(status === null ? [] : [status]))
    .all<PlatformRow>();
  return result.results.map(toPlatformView);
}

/**
 * A platform decision on one product (D8 approval, or an A10 takedown):
 *
 *   approved → status 'approved' [Firebase 'cleared'], requires_approval
 *              cleared, and any takedown stamp lifted (reinstatement);
 *   blocked  → status 'blocked' [Firebase 'taken_down'] AND products.takedown_at
 *              stamped: the product is off every public surface in this same
 *              batch (catalog_version bumps by trigger) and cannot be deleted.
 *
 * Works on any product, screened or not (a takedown must not wait for a
 * publish). Audited on the product's tenant with the platform actor.
 *
 * CP3-D: a takedown can carry an infringement report (`report`). Its id and
 * the platform's note go on this audit row, and the report's own statements
 * (built by src/catalog/infringement-reports.ts: the report → taken_down with
 * handler and time, its audit row, its alert resolved) are appended to THIS
 * batch — the one takedown, never a second one. Those statements guard
 * themselves: one that finds the report moved, or the report's shop not the
 * product's, aborts the whole batch, so the product is never taken down
 * without its report and never under another shop's report. Only a
 * `blocked` decision takes a report; an `approved` one with a report is refused.
 */
export interface TakedownReportLink {
  note: string | null;
  reportId: string;
  statements: D1PreparedStatement[];
}

export async function decideByPlatform(
  db: D1Database,
  principal: PlatformPrincipal,
  productId: string,
  decision: PlatformDecision,
  now: number,
  report?: TakedownReportLink,
): Promise<PlatformScreeningView | null> {
  if (report !== undefined && decision !== "blocked") {
    throw new Error("only a takedown can carry an infringement report");
  }
  const product = await db
    .prepare("SELECT tenant_id, takedown_at FROM products WHERE product_id = ? LIMIT 1")
    .bind(productId)
    .first<{ takedown_at: string | null; tenant_id: string }>();
  if (product === null) {
    return null;
  }
  const iso = new Date(now).toISOString();
  const status: ScreeningStatus = decision === "approved" ? "approved" : "blocked";
  const reason = decision === "approved" ? "platform_approved" : "takedown";
  const takedownAt = decision === "approved" ? null : (product.takedown_at ?? iso);
  const metadata =
    report === undefined
      ? { decision }
      : { decision, reportId: report.reportId, source: "infringement_report" };

  await db.batch([
    db
      .prepare(
        `INSERT INTO product_screening (
           product_id, tenant_id, status, reason, hits_json, earlier_hits_json,
           requires_approval, decided_by, decided_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, '[]', '[]', 0, ?, ?, 1, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           status = excluded.status,
           reason = excluded.reason,
           requires_approval = CASE WHEN excluded.status = 'approved' THEN 0
                                    ELSE product_screening.requires_approval END,
           decided_by = excluded.decided_by,
           decided_at = max(excluded.decided_at, product_screening.created_at),
           version = product_screening.version + 1,
           updated_at = max(excluded.updated_at, product_screening.created_at)`,
      )
      .bind(productId, product.tenant_id, status, reason, principal.userId, iso, iso, iso),
    db
      .prepare(
        "UPDATE products SET takedown_at = ?, updated_at = max(?, updated_at + 1) WHERE product_id = ?",
      )
      .bind(takedownAt, now, productId),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, reason, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        product.tenant_id,
        principal.userId,
        decision === "approved" ? "screening.approve" : "screening.takedown",
        productId,
        report?.note ?? null,
        crypto.randomUUID(),
        JSON.stringify(metadata),
        now,
      ),
    ...(report?.statements ?? []),
  ]);

  const row = await db
    .prepare(`${PLATFORM_SELECT} WHERE screening.product_id = ? LIMIT 1`)
    .bind(productId)
    .first<PlatformRow>();
  return row === null ? null : toPlatformView(row);
}

// ═══════════════════════════════════════════════════════════════════════════
// CP3-D — the blocklist write path and re-screening on a screening-input change
//
//   listScreeningTerms / addScreeningTerm / updateScreeningTerm /
//   deleteScreeningTerm        the platform's term routes
//   screeningInputChangeStatements   what every term change (and a switch of
//                              the global hard block) appends to its batch
//   rescreenStaleScreenings    the bounded sweep that re-runs the machine
//
// A change of the blocklist or of the global hard block is screening input for
// every live product (PLAN §2.4). It takes effect in ONE batch with the change:
//
//   1. platform_settings.screening_terms_version moves to <read> + 1 (a
//      concurrent change trips platform_settings_terms_version_forward and the
//      change is re-run once from fresh reads);
//   2. SAFETY — every LIVE product whose stored screened text the NEW term set
//      hard-blocks and that is public now is set 'blocked' (hits and earlier
//      hits as the machine would set them). One UPDATE, no loop: no product the
//      new term set blocks stays public after the change commits;
//   3. FAST-FORWARD — every verdict computed under the previous version whose
//      stored text yields the SAME hits under the new term set, and that the
//      machine would not turn into a block, is stamped with the new version:
//      the machine would change nothing for it;
//   4. the audit row.
//
// Everything else stays STALE (terms_version below the current one, or NULL):
// a live product whose verdict the change moves in a way that does not block —
// a new advisory hit, a removed term — or whose text the Worker has never
// stored. rescreenStaleScreenings re-runs the full machine on those, a bounded
// number per call, oldest first.
//
// LIMITS (the report has the detail): a live product with NO screening row
// (a fixture, a future import) and a row whose text was never stored (written
// before 0034, or a platform decision on a never-screened product) cannot be
// checked in SQL; the first are outside this path entirely (the predicate
// admits them as advisory), the second wait for the sweep. Both are counted in
// every term change's answer (`unverified`), so neither is silent.
// ═══════════════════════════════════════════════════════════════════════════

export const SCREENING_TERM_KINDS = ["band", "brand", "club", "other"] as const;
export type ScreeningTermKind = (typeof SCREENING_TERM_KINDS)[number];
export const MAX_TERM_NOTE_LENGTH = 500;
/** One sweep call re-screens at most this many products (≈ 6 queries each). */
export const RESCREEN_BATCH = 25;

const TERM_KEY_PATTERN = /^[A-Za-z0-9_-]{1,1100}$/;

/**
 * A term in a URL: the base64url (no padding) of its UTF-8. The term is the
 * table's natural key and legally contains "/", "%", "?", spaces and
 * non-ASCII ("ac/dc", "™"); a percent-encoded segment carrying "/" is refused
 * by the shared segment decoder on purpose, and anything else would need a
 * second decoding rule. base64url is one segment of [A-Za-z0-9_-], reversible,
 * and termFromKey accepts only the CANONICAL encoding, so a term has exactly
 * one URL.
 */
export function termKeyOf(term: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(term)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function termFromKey(key: string): string | null {
  if (!TERM_KEY_PATTERN.test(key)) {
    return null;
  }
  let term: string;
  try {
    const padded = key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    term = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return term.length > 0 && termKeyOf(term) === key ? term : null;
}

export interface ScreeningTermView {
  createdAt: string;
  hardBlock: boolean;
  kind: string;
  note: string | null;
  term: string;
  termKey: string;
}

interface TermRow {
  created_at: string;
  hard_block: number;
  kind: string;
  note: string | null;
  term: string;
}

function termView(row: TermRow): ScreeningTermView {
  return {
    createdAt: row.created_at,
    hardBlock: row.hard_block === 1,
    kind: row.kind,
    note: row.note,
    term: row.term,
    termKey: termKeyOf(row.term),
  };
}

async function loadTerm(db: D1Database, term: string): Promise<TermRow | null> {
  return db
    .prepare(
      "SELECT term, kind, hard_block, note, created_at FROM content_screening_terms WHERE term = ? LIMIT 1",
    )
    .bind(term)
    .first<TermRow>();
}

// ── parsing ─────────────────────────────────────────────────────────────────

export interface AddTermInput {
  hardBlock: boolean;
  kind: ScreeningTermKind;
  note: string | null;
  /** Already normalised (normalizeScreeningTerm). */
  term: string;
}

export interface UpdateTermInput {
  hardBlock?: boolean;
  kind?: ScreeningTermKind;
  note?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKind(value: unknown): ScreeningTermKind | null {
  return (SCREENING_TERM_KINDS as readonly unknown[]).includes(value)
    ? (value as ScreeningTermKind)
    : null;
}

/** undefined = invalid; null = no note ("" and whitespace clear it). */
function parseNote(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TERM_NOTE_LENGTH) {
    return undefined;
  }
  return trimmed === "" ? null : trimmed;
}

export function parseAddTermInput(body: unknown): AddTermInput | null {
  if (!isRecord(body)) {
    return null;
  }
  if (!Object.keys(body).every((key) => ["hardBlock", "kind", "note", "term"].includes(key))) {
    return null;
  }
  const normalized = normalizeScreeningTerm(body.term);
  const kind = body.kind === undefined ? "other" : parseKind(body.kind);
  const note = body.note === undefined ? null : parseNote(body.note);
  const hardBlock = body.hardBlock === undefined ? false : body.hardBlock;
  if (normalized === null || kind === null || note === undefined || typeof hardBlock !== "boolean") {
    return null;
  }
  return { hardBlock, kind, note, term: normalized.term };
}

/** A term is its own key: renaming one is a delete and an add. */
export function parseUpdateTermInput(body: unknown): UpdateTermInput | null {
  if (!isRecord(body)) {
    return null;
  }
  const keys = Object.keys(body);
  if (keys.length === 0 || !keys.every((key) => ["hardBlock", "kind", "note"].includes(key))) {
    return null;
  }
  const input: UpdateTermInput = {};
  if (body.kind !== undefined) {
    const kind = parseKind(body.kind);
    if (kind === null) {
      return null;
    }
    input.kind = kind;
  }
  if (body.hardBlock !== undefined) {
    if (typeof body.hardBlock !== "boolean") {
      return null;
    }
    input.hardBlock = body.hardBlock;
  }
  if (body.note !== undefined) {
    const note = parseNote(body.note);
    if (note === undefined) {
      return null;
    }
    input.note = note;
  }
  return input;
}

// ── the SQL half of a screening-input change ────────────────────────────────

/** Does list element `t` match the stored text of the product_screening row? */
const MATCH = `(CASE json_extract(t.value, '$.s')
     WHEN 1 THEN instr(product_screening.screened_raw, json_extract(t.value, '$.r')) > 0
     ELSE instr(product_screening.screened_tokens, json_extract(t.value, '$.k')) > 0
   END)`;

/** The row's hits under the list (findScreeningHits on the stored text). */
const NEW_HITS = `SELECT json_extract(t.value, '$.t') AS hit FROM json_each(?1) AS t WHERE ${MATCH}`;

/** A live product: published and active (the machine's `isLive`). */
const ROW_IS_LIVE = `EXISTS (
     SELECT 1 FROM product_publications AS pub
     INNER JOIN products AS live_product
       ON live_product.product_id = pub.product_id
      AND live_product.tenant_id = pub.tenant_id
     WHERE pub.product_id = product_screening.product_id
       AND pub.tenant_id = product_screening.tenant_id
       AND pub.published = 1
       AND live_product.status = 'active'
   )`;

const BLOCKING_HIT = `EXISTS (
     SELECT 1 FROM json_each(?1) AS t WHERE json_extract(t.value, '$.b') = 1 AND ${MATCH}
   )`;

/**
 * Step 2 (SAFETY). The machine's verdict for a PUBLIC row whose text the new
 * list hard-blocks, derived case by case from decideScreening + the overlay:
 *
 *   advisory (ok)     any blocking hit                         → blocked
 *   flagged           any blocking hit (same or new hit set)   → blocked
 *   approved (cleared) any blocking hit AND a hit the approval
 *                     never saw (not in hits ∪ earlierHits)    → blocked;
 *                     otherwise the approval sticks (Firebase parity)
 *
 * hits = the new hit list; earlier hits = (earlier ∪ hits) minus the new hits;
 * reason 'hard_block', decided by 'system', version + 1. terms_version is NOT
 * touched here (step 3 decides it). Rows without stored text are skipped:
 * nothing is known about them in SQL (counted as `unverified`).
 */
function safetyStatement(db: D1Database, list: string, iso: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE product_screening
       SET status = 'blocked',
           reason = 'hard_block',
           -- In list order (the matcher's order: blocklist ORDER BY term).
           hits_json = (SELECT json_group_array(hit) FROM (${NEW_HITS} ORDER BY t.key)),
           earlier_hits_json = (
             SELECT json_group_array(value) FROM (
               SELECT value FROM json_each(product_screening.earlier_hits_json)
               UNION
               SELECT value FROM json_each(product_screening.hits_json)
             )
             WHERE value NOT IN (${NEW_HITS})
           ),
           decided_by = 'system',
           decided_at = max(?2, created_at),
           version = version + 1,
           updated_at = max(?2, created_at)
       WHERE status IN ('advisory', 'flagged', 'approved')
         AND screened_tokens IS NOT NULL
         AND screened_raw IS NOT NULL
         AND ${ROW_IS_LIVE}
         AND ${BLOCKING_HIT}
         AND (
           status <> 'approved'
           OR EXISTS (
             SELECT 1 FROM json_each(?1) AS t
             WHERE ${MATCH}
               AND json_extract(t.value, '$.t') NOT IN (
                 SELECT value FROM json_each(product_screening.hits_json)
                 UNION ALL
                 SELECT value FROM json_each(product_screening.earlier_hits_json)
               )
           )
         )
       RETURNING product_id`,
    )
    .bind(list, iso);
}

/**
 * How many products a safety statement blocked. Its RETURNING rows, not
 * `meta.changes`: D1 counts the catalog_version trigger's `tenants` updates
 * in `changes` too.
 */
export function blockedCount(result: D1Result | undefined): number {
  return result?.results.length ?? 0;
}

/**
 * Step 3 (FAST-FORWARD). A verdict that was current under the previous version
 * (?2) stays right under the new one (?3) when the new list yields the SAME
 * hit set from its stored text (then decideScreening takes its "unchanged
 * input" branch) and that branch writes nothing — it writes only for a
 * blocking hit on a flagged or pending row. Rows step 2 just blocked qualify:
 * their hits already are the new hit set. Everything else stays stale.
 */
function fastForwardStatement(
  db: D1Database,
  list: string,
  fromVersion: number,
  toVersion: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE product_screening
       SET terms_version = ?3
       WHERE terms_version = ?2
         AND screened_tokens IS NOT NULL
         AND screened_raw IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?1) AS t
           WHERE ${MATCH}
             AND json_extract(t.value, '$.t') NOT IN (
               SELECT value FROM json_each(product_screening.hits_json)
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(product_screening.hits_json) AS h
           WHERE h.value NOT IN (${NEW_HITS})
         )
         AND NOT (${BLOCKING_HIT} AND status IN ('flagged', 'pending'))`,
    )
    .bind(list, fromVersion, toVersion);
}

/**
 * Steps 2 and 3 for a change to `blocklist` / `globalHardBlock` (the state
 * AFTER the change), moving verdicts from `fromVersion` to `fromVersion + 1`.
 * The caller puts them AFTER the statement that bumps the version (step 1).
 * Returns [safety, fastForward]; the safety statement's `changes` is the
 * number of products blocked by the change.
 */
export function screeningInputChangeStatements(
  db: D1Database,
  blocklist: readonly BlocklistEntry[],
  globalHardBlock: boolean,
  fromVersion: number,
  now: number,
): [D1PreparedStatement, D1PreparedStatement] {
  const list = JSON.stringify(sqlMatchTerms(blocklist, globalHardBlock));
  return [
    safetyStatement(db, list, new Date(now).toISOString()),
    fastForwardStatement(db, list, fromVersion, fromVersion + 1),
  ];
}

/** Step 1 for a term change: the version moves to exactly `nextVersion`. */
function termsVersionStatement(
  db: D1Database,
  principal: PlatformPrincipal,
  nextVersion: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_settings (id, screening_terms_version, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET
         screening_terms_version = excluded.screening_terms_version,
         updated_at = max(excluded.updated_at, platform_settings.updated_at),
         updated_by = excluded.updated_by`,
    )
    .bind(nextVersion, new Date(now).toISOString(), principal.userId);
}

// ── counts ──────────────────────────────────────────────────────────────────

export interface RescreenBacklog {
  /** Live products whose verdict predates the current term set (the sweep's work). */
  pending: number;
  /**
   * Live, publicly visible products whose text the Worker has never stored —
   * a term change could not check them. Rows among them are re-screened by
   * the sweep first; products with no screening row at all are not (the
   * predicate admits them as advisory; see the CP3-D report).
   */
  unverified: number;
}

const LIVE_FROM = `FROM product_publications AS pub
   INNER JOIN products AS p ON p.product_id = pub.product_id AND p.tenant_id = pub.tenant_id`;

async function loadTermsVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT screening_terms_version FROM platform_settings WHERE id = 1 LIMIT 1")
    .first<{ screening_terms_version: number }>();
  return row?.screening_terms_version ?? 0;
}

export async function readRescreenBacklog(db: D1Database): Promise<RescreenBacklog> {
  const termsVersion = await loadTermsVersion(db);
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS total ${LIVE_FROM}
       INNER JOIN product_screening AS s ON s.product_id = p.product_id AND s.tenant_id = p.tenant_id
       WHERE pub.published = 1 AND p.status = 'active'
         AND (s.terms_version IS NULL OR s.terms_version < ?)`,
    )
    .bind(termsVersion)
    .first<{ total: number }>();
  const unverified = await db
    .prepare(
      `SELECT COUNT(*) AS total ${LIVE_FROM}
       LEFT JOIN product_screening AS s ON s.product_id = p.product_id AND s.tenant_id = p.tenant_id
       WHERE pub.published = 1 AND p.status = 'active'
         AND (
           s.product_id IS NULL
           OR (s.screened_tokens IS NULL AND s.status IN ('advisory', 'flagged', 'approved'))
         )`,
    )
    .first<{ total: number }>();
  return { pending: pending?.total ?? 0, unverified: unverified?.total ?? 0 };
}

// ── the term routes ─────────────────────────────────────────────────────────

export interface RescreenSummary extends RescreenBacklog {
  /** Products the change took off the storefront in its own batch. */
  blockedNow: number;
}

export type TermWriteResult =
  | { rescreen: RescreenSummary; status: "ok"; term: ScreeningTermView | null }
  | { code: "conflict" | "duplicate_term" | "term_limit"; status: "conflict" }
  | { status: "not_found" };

export async function listScreeningTerms(
  db: D1Database,
  query: { cursor: string | null; limit: number },
): Promise<{ nextCursor: string | null; terms: ScreeningTermView[]; termsVersion: number }> {
  const termsVersion = await loadTermsVersion(db);
  const rows = await db
    .prepare(
      `SELECT term, kind, hard_block, note, created_at FROM content_screening_terms
       WHERE (?1 IS NULL OR term > ?1)
       ORDER BY term
       LIMIT ?2`,
    )
    .bind(query.cursor, query.limit + 1)
    .all<TermRow>();
  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    nextCursor:
      rows.results.length > query.limit && last !== undefined ? termKeyOf(last.term) : null,
    terms: page.map(termView),
    termsVersion,
  };
}

interface TermChangePlan {
  audit: { action: string; metadata: unknown; term: string };
  blocklist: BlocklistEntry[];
  statements: D1PreparedStatement[];
}

function sortTerms(entries: BlocklistEntry[]): BlocklistEntry[] {
  // content_screening_terms ORDER BY term (BINARY): UTF-16 order equals it
  // for every term outside the astral planes.
  return [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
}

/**
 * One term change = steps 1–4 in ONE batch, planned from a consistent read
 * (version first). A concurrent change of the screening input trips the
 * version fence; the change is re-planned once from fresh reads, and a second
 * trip answers `conflict` with nothing written.
 */
async function commitTermChange(
  db: D1Database,
  principal: PlatformPrincipal,
  now: number,
  plan: (config: ScreeningConfig) => Promise<TermChangePlan | TermWriteResult>,
  termAfter: string | null,
): Promise<TermWriteResult> {
  for (let round = 0; round < 2; round += 1) {
    const attemptNow = round === 0 ? now : Math.max(now, Date.now());
    const config = await loadScreeningConfig(db);
    const planned = await plan(config);
    if ("status" in planned) {
      return planned;
    }
    const [safety, fastForward] = screeningInputChangeStatements(
      db,
      planned.blocklist,
      config.globalHardBlock,
      config.termsVersion,
      attemptNow,
    );
    const statements = [
      ...planned.statements,
      termsVersionStatement(db, principal, config.termsVersion + 1, attemptNow),
      safety,
      fastForward,
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type,
             resource_id, request_id, metadata_json, created_at
           ) VALUES (?, NULL, ?, ?, 'screening_term', ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          principal.userId,
          planned.audit.action,
          planned.audit.term,
          crypto.randomUUID(),
          JSON.stringify(planned.audit.metadata),
          attemptNow,
        ),
    ];
    let results: D1Result[];
    try {
      results = await db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("screening terms changed")) {
        continue;
      }
      if (message.includes("UNIQUE constraint failed")) {
        return { code: "duplicate_term", status: "conflict" };
      }
      throw error;
    }
    const blockedNow = blockedCount(results[planned.statements.length + 1]);
    const row = termAfter === null ? null : await loadTerm(db, termAfter);
    return {
      rescreen: { blockedNow, ...(await readRescreenBacklog(db)) },
      status: "ok",
      term: row === null ? null : termView(row),
    };
  }
  return { code: "conflict", status: "conflict" };
}

export async function addScreeningTerm(
  db: D1Database,
  principal: PlatformPrincipal,
  input: AddTermInput,
  now: number,
): Promise<TermWriteResult> {
  return commitTermChange(
    db,
    principal,
    now,
    async (config) => {
      if (config.blocklist.length >= MAX_SCREENING_TERMS) {
        return { code: "term_limit", status: "conflict" };
      }
      // Two spellings the matcher cannot tell apart are one term: an imported
      // "Håkan Hellström" already covers "hakan hellstrom".
      const key = termMatch(input.term)?.key;
      if (config.blocklist.some((entry) => termMatch(entry.term)?.key === key)) {
        return { code: "duplicate_term", status: "conflict" };
      }
      return {
        audit: {
          action: "screening.term_add",
          metadata: { hardBlock: input.hardBlock, kind: input.kind, note: input.note },
          term: input.term,
        },
        blocklist: sortTerms([
          ...config.blocklist,
          { hardBlock: input.hardBlock, kind: input.kind, term: input.term },
        ]),
        statements: [
          db
            .prepare(
              `INSERT INTO content_screening_terms (term, kind, hard_block, note, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(
              input.term,
              input.kind,
              input.hardBlock ? 1 : 0,
              input.note,
              new Date(now).toISOString(),
            ),
        ],
      };
    },
    input.term,
  );
}

/**
 * kind / note only: a plain audited update (nothing the matcher reads moved).
 * hardBlock: a screening-input change (steps 1–4).
 */
export async function updateScreeningTerm(
  db: D1Database,
  principal: PlatformPrincipal,
  term: string,
  input: UpdateTermInput,
  now: number,
): Promise<TermWriteResult> {
  const current = await loadTerm(db, term);
  if (current === null) {
    return { status: "not_found" };
  }
  const kind = input.kind ?? current.kind;
  const note = input.note === undefined ? current.note : input.note;
  const hardBlock = input.hardBlock ?? current.hard_block === 1;
  const metadata = {
    after: { hardBlock, kind, note },
    before: { hardBlock: current.hard_block === 1, kind: current.kind, note: current.note },
  };
  const update = db
    .prepare("UPDATE content_screening_terms SET kind = ?, hard_block = ?, note = ? WHERE term = ?")
    .bind(kind, hardBlock ? 1 : 0, note, term);

  if (hardBlock === (current.hard_block === 1)) {
    await db.batch([
      update,
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type,
             resource_id, request_id, metadata_json, created_at
           ) VALUES (?, NULL, ?, 'screening.term_update', 'screening_term', ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), principal.userId, term, crypto.randomUUID(), JSON.stringify(metadata), now),
    ]);
    const row = await loadTerm(db, term);
    return {
      rescreen: { blockedNow: 0, ...(await readRescreenBacklog(db)) },
      status: "ok",
      term: row === null ? null : termView(row),
    };
  }

  return commitTermChange(
    db,
    principal,
    now,
    async (config) => {
      if (!config.blocklist.some((entry) => entry.term === term)) {
        return { status: "not_found" };
      }
      return {
        audit: { action: "screening.term_update", metadata, term },
        blocklist: config.blocklist.map((entry) =>
          entry.term === term ? { ...entry, hardBlock } : entry,
        ),
        statements: [update],
      };
    },
    term,
  );
}

export async function deleteScreeningTerm(
  db: D1Database,
  principal: PlatformPrincipal,
  term: string,
  now: number,
): Promise<TermWriteResult> {
  return commitTermChange(
    db,
    principal,
    now,
    async (config) => {
      const current = config.blocklist.find((entry) => entry.term === term);
      if (current === undefined) {
        return { status: "not_found" };
      }
      return {
        audit: {
          action: "screening.term_delete",
          metadata: { hardBlock: current.hardBlock, kind: current.kind },
          term,
        },
        blocklist: config.blocklist.filter((entry) => entry.term !== term),
        statements: [
          db.prepare("DELETE FROM content_screening_terms WHERE term = ?").bind(term),
        ],
      };
    },
    null,
  );
}

// ── the sweep ───────────────────────────────────────────────────────────────

/**
 * Re-runs the full machine (screeningStatementsFor, the same path as a seller
 * edit, fenced and retried the same way) on at most `limit` LIVE products
 * whose verdict predates the current term set — never-computed ones (NULL)
 * first, then the oldest version. Bounded per call: the platform route and
 * the cron call it repeatedly until `pending` is 0. A product that is not
 * live is left alone: its next publish screens it (the Firebase `isLive` rule).
 */
export async function rescreenStaleScreenings(
  db: D1Database,
  now: number,
  limit: number = RESCREEN_BATCH,
): Promise<RescreenBacklog & { rescreened: number }> {
  const termsVersion = await loadTermsVersion(db);
  const stale = await db
    .prepare(
      `SELECT s.tenant_id, s.product_id ${LIVE_FROM}
       INNER JOIN product_screening AS s ON s.product_id = p.product_id AND s.tenant_id = p.tenant_id
       WHERE pub.published = 1 AND p.status = 'active'
         AND (s.terms_version IS NULL OR s.terms_version < ?)
       ORDER BY s.terms_version IS NOT NULL, s.terms_version, s.updated_at, s.product_id
       LIMIT ?`,
    )
    .bind(termsVersion, Math.max(0, Math.min(limit, 100)))
    .all<{ product_id: string; tenant_id: string }>();

  let rescreened = 0;
  for (const row of stale.results) {
    const done = await withScreeningRetry(
      now,
      async (attemptNow) => {
        const guard = await readScreeningGuard(db, row.tenant_id, row.product_id);
        const screening = await screeningStatementsFor(db, { guard, now: attemptNow });
        await db.batch(screening.statements);
        return true;
      },
      () => false,
    );
    if (done) {
      rescreened += 1;
    }
  }
  return { rescreened, ...(await readRescreenBacklog(db)) };
}
