import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type {
  JobNotice,
  R2Presigner,
  RenderFarmClient,
} from "./render-farm-client";
import {
  buildJobEnvelope,
  PREVIEW_CONTENT_TYPE,
  PRINT_CONTENT_TYPE,
} from "./render-farm-client";
import { getProfile, toJobProfile } from "./pod-profiles";

/**
 * The POD artwork library — the caller side of the render-farm seam.
 *
 * ── THE FLOW, AND WHY IT IS ORDERED THIS WAY ────────────────────────────────
 *
 *   1. Resolve the profile (platform spec) and the ORIGINAL (a checkpoint-16
 *      stored object this tenant owns, already uploaded and content-committed).
 *   2. INSERT a 'processing' row. Before the farm is called, so the UNIQUE
 *      (tenant, original, profile) triple arbitrates a race BEFORE any
 *      outbound compute is spent — the loser of two concurrent posts never
 *      reaches the farm at all.
 *   3. Presign: GET for the original, PUT for both outputs with pinned content
 *      types.
 *   4. Dispatch the contract-v0 envelope.
 *   5. Persist the verdict — and on success, VERIFY BOTH OUTPUTS EXIST IN R2 AT
 *      THE REPORTED SIZES before writing 'ready'.
 *
 * ── THE DELIVERY TEETH ──────────────────────────────────────────────────────
 * Production defends the print file in three layers because its artwork docs
 * are client-writable. Here the equivalent is structural: the output keys live
 * under a `pod/` R2 prefix that no other route in this worker reads or writes,
 * they are not `stored_objects` rows so the checkpoint-16 admin surface cannot
 * name them, the schema CHECKs the prefix byte-exactly, and a trigger makes
 * them write-once. THIS MODULE IS THE ONLY WRITER OF PRINT OUTPUTS.
 */

export type ArtworkStatus = "processing" | "ready" | "rejected";

export interface ArtworkSummary {
  artworkId: string;
  createdAt: number;
  effectiveDpi: number | null;
  heightPx: number | null;
  originalObjectId: string;
  profileId: string;
  status: ArtworkStatus;
  widthPx: number | null;
}

export interface ArtworkDetail extends ArtworkSummary {
  maxPrintMm: { h: number; w: number } | null;
  notices: JobNotice[];
  pipelineVersion: number | null;
  previewBytes: number | null;
  previewSha256: string | null;
  printBytes: number | null;
  printSha256: string | null;
  reasons: JobNotice[];
  updatedAt: number;
}

interface ArtworkRow {
  artwork_id: string;
  created_at: number;
  effective_dpi: number | null;
  height_px: number | null;
  max_print_h_mm: number | null;
  max_print_w_mm: number | null;
  notices_json: string | null;
  original_object_id: string;
  pipeline_version: number | null;
  preview_bytes: number | null;
  preview_object_key: string | null;
  preview_sha256: string | null;
  print_bytes: number | null;
  print_object_key: string | null;
  print_sha256: string | null;
  profile_id: string;
  reasons_json: string | null;
  status: ArtworkStatus;
  updated_at: number;
  width_px: number | null;
}

/**
 * Every outcome the dispatch route can produce.
 *
 * `rejected` is a SUCCESSFUL request that produced a rejection verdict — the
 * route answers 200 with it, exactly as the farm answers 200 for a gate
 * rejection. `farm_error` is the only failure that reaches the client as a
 * 502-equivalent, and it carries nothing from the farm.
 */
export type CreateArtworkResult =
  | { artwork: ArtworkDetail; status: "created" }
  | { artwork: ArtworkDetail; status: "rejected" }
  | { status: "conflict" | "farm_error" | "not_found" };

const ARTWORK_SELECT = `SELECT
     artwork_id, original_object_id, profile_id, status,
     width_px, height_px, effective_dpi, max_print_w_mm, max_print_h_mm,
     pipeline_version, notices_json, reasons_json,
     print_object_key, preview_object_key,
     print_sha256, print_bytes, preview_sha256, preview_bytes,
     created_at, updated_at
   FROM pod_artwork
   WHERE tenant_id = ?`;

function parseMessages(json: string | null): JobNotice[] {
  if (json === null) {
    return [];
  }
  // Written by this module from validated data, so a parse failure would mean
  // the row was written by something else. Defensive rather than expected.
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as JobNotice[]) : [];
  } catch {
    return [];
  }
}

function toSummary(row: ArtworkRow): ArtworkSummary {
  return {
    artworkId: row.artwork_id,
    createdAt: row.created_at,
    effectiveDpi: row.effective_dpi,
    heightPx: row.height_px,
    originalObjectId: row.original_object_id,
    profileId: row.profile_id,
    status: row.status,
    widthPx: row.width_px,
  };
}

/**
 * The detail projection.
 *
 * THE OUTPUT KEYS ARE DELIBERATELY ABSENT — the same discipline the object
 * surface applies to `objectKey`. A key is internal addressing, and no client
 * should ever be able to derive access from one. The preview is reached through
 * a short-TTL signed URL the route mints; the print file is not reachable from
 * this surface at all, because delivering print files belongs to the print
 * portal checkpoint and inventing a path to them here would create a second
 * delivery route with no queue behind it.
 */
function toDetail(row: ArtworkRow): ArtworkDetail {
  return {
    ...toSummary(row),
    maxPrintMm:
      row.max_print_w_mm === null || row.max_print_h_mm === null
        ? null
        : { h: row.max_print_h_mm, w: row.max_print_w_mm },
    notices: parseMessages(row.notices_json),
    pipelineVersion: row.pipeline_version,
    previewBytes: row.preview_bytes,
    previewSha256: row.preview_sha256,
    printBytes: row.print_bytes,
    printSha256: row.print_sha256,
    reasons: parseMessages(row.reasons_json),
    updatedAt: row.updated_at,
  };
}

async function loadArtworkRow(
  db: D1Database,
  tenantId: string,
  artworkId: string,
): Promise<ArtworkRow | null> {
  return db
    .prepare(`${ARTWORK_SELECT} AND artwork_id = ? LIMIT 1`)
    .bind(tenantId, artworkId)
    .first<ArtworkRow>();
}

function auditStatement(
  db: D1Database,
  principal: TenantAdminPrincipal,
  action: string,
  artworkId: string,
  now: number,
  metadata: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'pod_artwork', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      action,
      artworkId,
      crypto.randomUUID(),
      JSON.stringify(metadata),
      now,
    );
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

/**
 * The original this artwork will measure, resolved and OWNERSHIP-CHECKED.
 *
 * Three conditions, all required:
 *   - the row belongs to THIS tenant (bound in the query, never filtered after)
 *   - it is `active`, i.e. its content was committed and R2 verified the
 *     checksum on the way in — a `pending` row names a key with no bytes behind
 *     it, and dispatching one would hand the farm a URL that 404s
 *   - it is an `artwork_original`, not some other kind of private object. A
 *     tenant admin can upload documents and exports through the same surface,
 *     and letting an arbitrary private object become a print source would make
 *     this route a general-purpose "run sharp on anything I own" primitive.
 */
interface OriginalObject {
  contentType: string;
  objectKey: string;
  sizeBytes: number;
}

async function loadOriginal(
  db: D1Database,
  tenantId: string,
  objectId: string,
): Promise<OriginalObject | null> {
  const row = await db
    .prepare(
      `SELECT object_key, content_type, size_bytes
       FROM stored_objects
       WHERE tenant_id = ?
         AND object_id = ?
         AND status = 'active'
         AND kind = 'artwork_original'
         AND bucket = 'private'
       LIMIT 1`,
    )
    .bind(tenantId, objectId)
    .first<{
      content_type: string;
      object_key: string;
      size_bytes: number | null;
    }>();

  if (row === null || row.size_bytes === null || row.size_bytes <= 0) {
    return null;
  }

  return {
    contentType: row.content_type,
    objectKey: row.object_key,
    sizeBytes: row.size_bytes,
  };
}

/**
 * Verify that the farm's PUTs actually landed, before anything is called ready.
 *
 * HEAD both keys through the R2 BINDING — not through a signed URL, and not by
 * trusting the farm's word. The binding is this worker's own credential-free
 * view of the bucket, so a farm that reported success without uploading, or
 * uploaded a truncated body, is caught here rather than in a print shop.
 *
 * SIZE IS COMPARED; sha256 IS NOT RE-HASHED. That asymmetry is deliberate and
 * worth stating plainly:
 *
 *   - The size check is free. `head()` returns the object's size without moving
 *     a byte, and comparing it to the farm's double-report catches the entire
 *     class of failure this verification exists for — a truncated or partial
 *     upload, which is what a network fault during a PUT actually produces.
 *
 *   - Re-hashing would mean STREAMING BOTH OUTPUTS BACK THROUGH THE ISOLATE on
 *     every upload — a print PNG is routinely tens of megabytes — to defend
 *     against an adversary who has the shared secret and control of the farm.
 *     Such an adversary already holds a presigned PUT URL for that exact key
 *     and could simply report the hash of whatever they uploaded. The hash
 *     would verify and prove nothing. The farm is a trusted component of this
 *     platform; the verification here is against FAULTS, not against the farm
 *     turning hostile, and a check that cannot detect the threat it appears to
 *     address is worse than an honest absence of one.
 *
 * The reported sha256 is still PERSISTED, because it is the input to a future
 * integrity sweep that can afford to stream (a cron job, not a request path)
 * and because the print portal will want to pin the bytes it delivered.
 */
async function verifyOutputs(
  env: Env,
  keys: { previewKey: string; printKey: string },
  reported: { previewBytes: number; printBytes: number },
): Promise<boolean> {
  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    return false;
  }

  const [printHead, previewHead] = await Promise.all([
    bucket.head(keys.printKey),
    bucket.head(keys.previewKey),
  ]);

  return (
    printHead !== null &&
    previewHead !== null &&
    printHead.size === reported.printBytes &&
    previewHead.size === reported.previewBytes
  );
}

/**
 * Best-effort removal of output objects this dispatch created.
 *
 * Used on the two paths where a 'ready' row will never exist: a farm failure
 * after a partial PUT, and a verification failure. A leftover object is storage
 * cost that a lifecycle rule can sweep; a leftover object that something
 * believes is a print file is a wrong garment. Failures here are swallowed
 * because the row deletion is what actually matters and must not be blocked by
 * a transient R2 error.
 */
async function discardOutputs(
  env: Env,
  keys: { previewKey: string; printKey: string },
): Promise<void> {
  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    return;
  }

  await Promise.all([
    bucket.delete(keys.printKey).catch(() => undefined),
    bucket.delete(keys.previewKey).catch(() => undefined),
  ]);
}

/**
 * Dispatch one artwork job and persist its verdict.
 *
 * ── WHY A FARM FAILURE DELETES THE ROW ──────────────────────────────────────
 * The alternative — a 'failed' status with retry semantics — was considered and
 * rejected. A 'failed' row would occupy the UNIQUE (tenant, original, profile)
 * triple, so the obvious retry (post the same body again) would answer 409
 * forever; making retry work would need either a separate retry verb or a rule
 * that a 'failed' row may be overwritten, and the second one reopens exactly
 * the mutable-verdict hole the terminal-status trigger closes.
 *
 * Deleting instead makes REPLAY THE RETRY: the same request, unchanged, works.
 * That matches the contract's own principle that jobs are pure functions and
 * "replays are safe by construction". Nothing is lost, because a failed job
 * produced no verdict to preserve — the audit row records that the attempt
 * happened, which is the part worth keeping.
 *
 * The delete is guarded on `status = 'processing'`, so it can only ever remove
 * the row this call created and never a verdict someone else just wrote.
 */
export async function createArtwork(
  env: Env,
  db: D1Database,
  farm: RenderFarmClient,
  presigner: R2Presigner,
  principal: TenantAdminPrincipal,
  input: { objectId: string; profileId: string },
  now: number,
): Promise<CreateArtworkResult> {
  const tenantId = principal.tenantId;

  const profile = await getProfile(db, input.profileId);
  // A retired profile is refused as firmly as a missing one: new artwork must
  // not be produced under a specification the printer no longer honours.
  if (profile === null || !profile.active) {
    return { status: "not_found" };
  }

  const original = await loadOriginal(db, tenantId, input.objectId);
  if (original === null) {
    // Unknown object, another tenant's object, a pending one, or one of the
    // wrong kind — all the same opaque answer. Distinguishing them would make
    // this route an oracle for which object ids exist in other tenants.
    return { status: "not_found" };
  }

  const artworkId = crypto.randomUUID();
  // Keys are derived from the artwork id, so they are unique per dispatch and
  // cannot be predicted from anything a client supplies.
  const printKey = `pod/${tenantId}/print/${artworkId}.png`;
  const previewKey = `pod/${tenantId}/preview/${artworkId}.webp`;

  // ── 2. The guarded insert. Before the farm is touched. ────────────────────
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO pod_artwork (
             artwork_id, tenant_id, original_object_id, profile_id, status,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'processing', ?, ?)`,
        )
        .bind(artworkId, tenantId, input.objectId, input.profileId, now, now),
      auditStatement(db, principal, "pod.artwork.dispatch", artworkId, now, {
        profileId: input.profileId,
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      // A row already exists for this (tenant, original, profile). Either a
      // concurrent dispatch won the race, or this original was already
      // measured under this profile. Both are conflicts, and neither has
      // called the farm.
      return { status: "conflict" };
    }
    throw error;
  }

  // ── 3. Presign. ──────────────────────────────────────────────────────────
  let envelope;
  try {
    const [sourceUrl, printPutUrl, previewPutUrl] = await Promise.all([
      presigner.presignGet(original.objectKey),
      presigner.presignPut(printKey, PRINT_CONTENT_TYPE),
      presigner.presignPut(previewKey, PREVIEW_CONTENT_TYPE),
    ]);

    envelope = buildJobEnvelope({
      jobId: artworkId,
      originalSizeBytes: original.sizeBytes,
      previewPutUrl,
      printPutUrl,
      profile: toJobProfile(profile),
      sourceUrl,
    });
  } catch {
    await deleteProcessingRow(db, tenantId, artworkId);
    return { status: "farm_error" };
  }

  // ── 4. Dispatch. ─────────────────────────────────────────────────────────
  const result = await farm.dispatch(envelope);

  if (result.status === "failed") {
    // The farm may have PUT one output before failing on the other, so both
    // keys are swept before the row goes.
    await discardOutputs(env, { previewKey, printKey });
    await deleteProcessingRow(db, tenantId, artworkId);
    return { status: "farm_error" };
  }

  // ── 5a. A REJECTION verdict. ─────────────────────────────────────────────
  if (result.status === "rejected") {
    // THE ORIGINAL IS KEPT. Production's new-upload mode deletes a rejected
    // upload's original ("no orphans: failed files never enter the library").
    // That is a deliberate DIVERGENCE here, for a structural reason rather than
    // a philosophical one: the original is a checkpoint-16 `stored_objects` row
    // that this module borrowed, and deleting another module's object — one
    // whose lifecycle includes freezing, soft-delete and an audit trail this
    // module does not own — would be reaching across a boundary. The owner
    // deletes it through DELETE /v1/admin/objects/{id}, which is the surface
    // that created it. Practically the uploader also benefits: a rejection is
    // usually a resolution problem, and keeping the file lets them re-run it
    // against a different profile without re-uploading.
    await db.batch([
      db
        .prepare(
          `UPDATE pod_artwork
           SET status = 'rejected', reasons_json = ?, updated_at = ?
           WHERE tenant_id = ?
             AND artwork_id = ?
             AND status = 'processing'`,
        )
        .bind(
          JSON.stringify(result.reasons),
          now,
          tenantId,
          artworkId,
        ),
      auditStatement(db, principal, "pod.artwork.rejected", artworkId, now, {
        profileId: input.profileId,
        reasonCodes: result.reasons.map((reason) => reason.code),
      }),
    ]);

    const row = await loadArtworkRow(db, tenantId, artworkId);
    return row === null
      ? { status: "farm_error" }
      : { artwork: toDetail(row), status: "rejected" };
  }

  // ── 5b. SUCCESS — verify before ready. ───────────────────────────────────
  const verified = await verifyOutputs(
    env,
    { previewKey, printKey },
    {
      previewBytes: result.outputs.previewWebp.bytes,
      printBytes: result.outputs.printPng.bytes,
    },
  );

  if (!verified) {
    // The farm said it uploaded; R2 disagrees about existence or size. The
    // artwork is NOT ready, and the half-written outputs are swept so nothing
    // can later find bytes at a key no row claims.
    await discardOutputs(env, { previewKey, printKey });
    await deleteProcessingRow(db, tenantId, artworkId);
    return { status: "farm_error" };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE pod_artwork
         SET status = 'ready',
             width_px = ?, height_px = ?, effective_dpi = ?,
             max_print_w_mm = ?, max_print_h_mm = ?, pipeline_version = ?,
             notices_json = ?,
             print_object_key = ?, preview_object_key = ?,
             print_sha256 = ?, print_bytes = ?,
             preview_sha256 = ?, preview_bytes = ?,
             updated_at = ?
         WHERE tenant_id = ?
           AND artwork_id = ?
           AND status = 'processing'`,
      )
      .bind(
        result.meta.widthPx,
        result.meta.heightPx,
        result.meta.effectiveDpi,
        result.meta.maxPrintMm.w,
        result.meta.maxPrintMm.h,
        result.meta.pipelineVersion,
        JSON.stringify(result.notices),
        printKey,
        previewKey,
        result.outputs.printPng.sha256,
        result.outputs.printPng.bytes,
        result.outputs.previewWebp.sha256,
        result.outputs.previewWebp.bytes,
        now,
        tenantId,
        artworkId,
      ),
    auditStatement(db, principal, "pod.artwork.ready", artworkId, now, {
      effectiveDpi: result.meta.effectiveDpi,
      noticeCodes: result.notices.map((notice) => notice.code),
      profileId: input.profileId,
    }),
  ]);

  const row = await loadArtworkRow(db, tenantId, artworkId);
  return row === null
    ? { status: "farm_error" }
    : { artwork: toDetail(row), status: "created" };
}

/**
 * Remove a row this dispatch created and could not finish.
 *
 * Guarded on `status = 'processing'` so it can only ever delete the row in the
 * state this call left it in — a verdict written by anything else survives.
 */
async function deleteProcessingRow(
  db: D1Database,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM pod_artwork
       WHERE tenant_id = ?
         AND artwork_id = ?
         AND status = 'processing'`,
    )
    .bind(tenantId, artworkId)
    .run();
}

export async function listArtwork(
  db: D1Database,
  principal: TenantAdminPrincipal,
): Promise<ArtworkSummary[]> {
  const result = await db
    .prepare(`${ARTWORK_SELECT} ORDER BY created_at DESC, artwork_id LIMIT 500`)
    .bind(principal.tenantId)
    .all<ArtworkRow>();

  return result.results.map(toSummary);
}

export async function getArtwork(
  db: D1Database,
  principal: TenantAdminPrincipal,
  artworkId: string,
): Promise<ArtworkDetail | null> {
  const row = await loadArtworkRow(db, principal.tenantId, artworkId);
  return row === null ? null : toDetail(row);
}

/**
 * The preview object key for a signed download URL, or null.
 *
 * Separate from the detail projection because the KEY must never be serialized
 * to a client — the route takes it, mints a short-TTL presigned GET, and
 * returns only the URL.
 */
export async function getPreviewKey(
  db: D1Database,
  principal: TenantAdminPrincipal,
  artworkId: string,
): Promise<string | null> {
  const row = await loadArtworkRow(db, principal.tenantId, artworkId);
  return row === null || row.status !== "ready" ? null : row.preview_object_key;
}

export type DeleteArtworkResult = { status: "not_found" | "ok" };

/**
 * Delete an artwork row and BOTH of its output objects.
 *
 * ── WHAT IS AND IS NOT REMOVED ──────────────────────────────────────────────
 * The row goes, and the two `pod/`-prefixed objects this module created go with
 * it. THE ORIGINAL IS NEVER TOUCHED: it belongs to the checkpoint-16 object
 * store, which has its own delete surface, its own soft-delete semantics and
 * its own audit trail. Reaching across that boundary would mean this route
 * could destroy an object a completely different feature depends on.
 *
 * ── ORDER: ROW FIRST, THEN BYTES ────────────────────────────────────────────
 * The same order checkpoint 16 established and for the same reason: once the
 * row is gone nothing can resolve the keys, so a failed R2 delete leaves
 * unreachable garbage rather than a live print file with no record of it. The
 * reverse order could delete the bytes and then fail to delete the row, leaving
 * a 'ready' artwork whose print file does not exist — which the print portal
 * would discover at the worst possible moment.
 *
 * ── "ONLY WHILE NOTHING REFERENCES IT" ──────────────────────────────────────
 * Nothing can reference an artwork yet: POD products, order lines and print
 * jobs are all later checkpoints. There is therefore no reference check to
 * write, and writing a fake one against tables that do not exist would be
 * theatre. What exists instead is the SHAPE for it — the delete is a single
 * guarded statement whose WHERE clause is where a `NOT EXISTS (SELECT … FROM
 * pod_product_artwork …)` term lands when there is something to check, and the
 * `changes === 0` branch already answers correctly when the guard refuses.
 */
export async function deleteArtwork(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  artworkId: string,
  now: number,
): Promise<DeleteArtworkResult> {
  const tenantId = principal.tenantId;
  const row = await loadArtworkRow(db, tenantId, artworkId);
  if (row === null) {
    return { status: "not_found" };
  }

  const deleted = await db.batch([
    db
      .prepare(
        `DELETE FROM pod_artwork WHERE tenant_id = ? AND artwork_id = ?`,
      )
      .bind(tenantId, artworkId),
    auditStatement(db, principal, "pod.artwork.delete", artworkId, now, {
      profileId: row.profile_id,
      status: row.status,
    }),
  ]);

  // The batch is atomic, so a zero-change delete means the row vanished between
  // the read and the write — someone else deleted it, and the answer is the
  // same as if it had never been there.
  if ((deleted[0]?.meta.changes ?? 0) === 0) {
    return { status: "not_found" };
  }

  const bucket = env.PRIVATE_BUCKET;
  if (bucket !== undefined) {
    // Only the keys this module owns, taken from the row rather than
    // reconstructed — a reconstructed key is a key that can be wrong.
    const keys = [row.print_object_key, row.preview_object_key].filter(
      (key): key is string => key !== null,
    );
    await Promise.all(
      keys.map((key) => bucket.delete(key).catch(() => undefined)),
    );
  }

  return { status: "ok" };
}
