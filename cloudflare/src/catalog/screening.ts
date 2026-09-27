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
  overlayDecision,
  productScreeningTexts,
  REVIEW_FIRST_PRODUCTS,
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

async function loadBlocklist(db: D1Database): Promise<BlocklistEntry[]> {
  const result = await db
    .prepare(
      `SELECT term, kind, hard_block FROM content_screening_terms ORDER BY term LIMIT 2000`,
    )
    .all<{ hard_block: number; kind: string; term: string }>();
  return result.results.map((row) => ({
    hardBlock: row.hard_block === 1,
    kind: row.kind,
    term: row.term,
  }));
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
    .bind(tenantId, tenantId, productId, REVIEW_FIRST_PRODUCTS)
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

/** The D1 error a tripped fence raises (the version trigger or the PK). */
export function isScreeningConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("screening version must increase") ||
    (message.includes("UNIQUE constraint failed") &&
      message.includes("product_screening.product_id"))
  );
}

/**
 * Run a guarded mutation; on a tripped fence run it ONCE more from fresh
 * reads, and if the fence trips again answer `onConflict()` rather than
 * committing anything under facts the mutation never saw.
 */
export async function withScreeningRetry<T>(
  attempt: () => Promise<T>,
  onConflict: () => T,
): Promise<T> {
  for (let round = 0; round < 2; round += 1) {
    try {
      return await attempt();
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
          `UPDATE product_screening SET version = ?, updated_at = ?
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
  const [fileNames, blocklist] = await Promise.all([
    artworkFileNames(db, tenantId, artworkIds),
    loadBlocklist(db),
  ]);
  const hits = findScreeningHits(productScreeningTexts(texts, fileNames), blocklist);
  const terms = hits.map((hit) => hit.term);
  const hardBlock = hits.some((hit) => hit.hardBlock);
  // Only needed for a first screening; Firebase skipped the query otherwise.
  const shopPublishedCount =
    prevRow === null ? await otherLiveCount(db, tenantId, productId) : REVIEW_FIRST_PRODUCTS;

  const decision = decideScreening({
    hardBlock,
    prev: toMachineState(prevRow),
    reviewFirstProducts: REVIEW_FIRST_PRODUCTS,
    shopPublishedCount,
    terms,
  });
  const next = overlayDecision(prevRow, decision, shopPublishedCount);
  if (next === null) {
    // The machine's no-op still fences: the unchanged verdict is only right
    // for the facts it was computed from.
    return {
      statements: [screeningFenceStatement(db, input.guard, input.now)],
      status: prevRow?.status ?? null,
    };
  }

  const iso = new Date(input.now).toISOString();
  const statement =
    prevRow === null
      ? db
          .prepare(
            `INSERT INTO product_screening (
               product_id, tenant_id, status, reason, hits_json, earlier_hits_json,
               requires_approval, decided_by, decided_at, version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?, 1, ?, ?)`,
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
          )
      : db
          .prepare(
            `UPDATE product_screening
             SET status = ?, reason = ?, hits_json = ?, earlier_hits_json = ?,
                 requires_approval = ?, decided_by = 'system', decided_at = ?,
                 version = ?, updated_at = ?
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
 */
export async function decideByPlatform(
  db: D1Database,
  principal: PlatformPrincipal,
  productId: string,
  decision: PlatformDecision,
  now: number,
): Promise<PlatformScreeningView | null> {
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
           decided_at = excluded.decided_at,
           version = product_screening.version + 1,
           updated_at = excluded.updated_at`,
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
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        product.tenant_id,
        principal.userId,
        decision === "approved" ? "screening.approve" : "screening.takedown",
        productId,
        crypto.randomUUID(),
        JSON.stringify({ decision }),
        now,
      ),
  ]);

  const row = await db
    .prepare(`${PLATFORM_SELECT} WHERE screening.product_id = ? LIMIT 1`)
    .bind(productId)
    .first<PlatformRow>();
  return row === null ? null : toPlatformView(row);
}
