PRAGMA foreign_keys = ON;

-- ============================================================================
-- POD artwork domain — the caller side of the render-farm seam.
--
-- SSOT for the pipeline's rules: docs/POD_PRINT_SPEC.md (locked 2026-07-27).
-- SSOT for the job contract: docs/RENDER_FARM_CONTRACT.md (v0).
--
-- Two tables with deliberately DIFFERENT tenancy, because they model
-- deliberately different things:
--
--   pod_profiles  — PLATFORM-level print specifications. No tenant_id, by
--                   design (see the table's own comment).
--   pod_artwork   — TENANT-scoped library rows: one uploaded motif, one
--                   verdict, and the two server-owned outputs the verdict
--                   produced.
--
-- THE DELIVERY TEETH, restated for this schema. Production defends the print
-- file in three layers because its artwork docs are client-writable
-- (functions/src/pod/processArtwork.ts header): storage.rules denies client
-- writes under `pod-artwork/{shopId}/print/**`, the print projection only
-- honours paths inside the order's own shop print folder, and the callable
-- prefix-validates before touching Storage with admin credentials. Here the
-- equivalent is structural rather than rule-based: `print_object_key` and
-- `preview_object_key` are written by exactly ONE code path (the dispatch
-- route in src/pod/artwork-routes.ts, after the farm's 200), they live under a
-- `pod/` R2 prefix that NO other route in this worker reads or writes, and
-- they are NOT rows in `stored_objects` — so the checkpoint-16 admin object
-- surface, which is the only client-reachable path to R2, cannot address them
-- at all. A client cannot ask for a key it cannot name.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- pod_profiles — the print specifications the gate measures against.
--
-- WHY NO tenant_id. Production keeps these in ONE platform-level Firestore doc
-- (`settings/podProfiles`, read by src/config/podProfiles.js, written only by
-- scripts/seed-pod-profiles.cjs under `isPlatform` rules), and that is the
-- correct model rather than an accident of the old schema: a profile encodes
-- the PRINT SHOP's physical capability — the 250x350 mm garment front, the
-- 300 DPI floor, the formats sharp can rasterize — and the print shop is the
-- platform's supplier, not a tenant's. A tenant that could edit its own
-- min_dpi could admit files the printer will refuse, and the rejection would
-- arrive as a returned order rather than as an upload error.
--
-- The five columns after `profile_id` ARE the PipelineProfile the farm
-- consumes (functions/src/pod/artworkPipelineCore.ts). `label` is the sixth
-- field prod's ProfileDoc carries and is display-only — it never reaches the
-- core, and the dispatch route never puts it in the job envelope.
--
-- SIMPLE, REPLACEABLE ROWS. There is no immutability trigger and no audit
-- trigger on this table, deliberately: the platform PUT replaces the whole
-- list, and a verdict does not depend on the row surviving. See
-- `pod_artwork.profile_id` for why that is safe.
-- ----------------------------------------------------------------------------
CREATE TABLE pod_profiles (
  -- The profile id the print spec uses: 'apparel_dtg', 'bag_dtg', 'cap_dtg'…
  -- It is the PRIMARY KEY rather than a surrogate because it is already the
  -- stable identifier everywhere else in the system (prod's profile array, the
  -- job envelope's `profile.id`, the frozen `pod_artwork.profile_id`), and a
  -- surrogate would create a second name for one thing.
  profile_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(profile_id) BETWEEN 1 AND 64
  ),
  -- Display-only. Swedish in prod ('Textil (DTG)'), and this column stores
  -- whatever the platform puts there — it is never parsed and never gates
  -- anything.
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  -- The DPI floor at contain-fit inside the print area. 300 for every real
  -- profile today; the column exists because the spec says the number lives in
  -- data, not code ("changing a profile's size/DPI auto-updates the validation
  -- thresholds").
  min_dpi INTEGER NOT NULL CHECK (min_dpi > 0 AND min_dpi <= 2400),
  -- The LARGEST print surface for this profile, in millimetres — the gate's
  -- contain-fit reference (POD_PRINT_SPEC.md §2: "största ytan sätter ribban").
  -- Stored as integers: every real profile is whole millimetres, and an
  -- integer cannot carry a float that rounds differently in SQLite than in the
  -- pipeline's arithmetic.
  print_area_w_mm INTEGER NOT NULL CHECK (print_area_w_mm > 0 AND print_area_w_mm <= 10000),
  print_area_h_mm INTEGER NOT NULL CHECK (print_area_h_mm > 0 AND print_area_h_mm <= 10000),
  -- The byte-size gate, in megabytes. The core treats 0/absent as "no size
  -- gate", so this column is NOT NULL with a positive CHECK: a profile that
  -- disabled the size gate would let a 200 MB file reach sharp, and the farm's
  -- own hard ceiling would then be the only defence. Making it mandatory here
  -- means the tightest bound is always the profile's.
  max_file_mb INTEGER NOT NULL CHECK (max_file_mb > 0 AND max_file_mb <= 200),
  -- The accepted upload formats, as the contract's array-of-objects shape:
  -- [{"ext":"png"},{"ext":"jpg"},...]. JSON because the farm receives it
  -- verbatim in the envelope and a join table would have to be reassembled
  -- into exactly this shape on every dispatch.
  --
  -- json_valid() and json_type() are usable in D1 CHECKs (probed at
  -- checkpoint 22). Emptiness is refused because the core turns an empty list
  -- into "Tillåtna format: ." — every file rejected with a nonsense message.
  accepted_formats_json TEXT NOT NULL CHECK (
    json_valid(accepted_formats_json)
    AND json_type(accepted_formats_json) = 'array'
    AND json_array_length(accepted_formats_json) > 0
  ),
  -- Presentation order for the upload picker, and the active flag. Both exist
  -- so the platform can retire a profile without deleting it out from under
  -- the artwork rows that name it.
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE INDEX pod_profiles_active_sort_idx ON pod_profiles(active, sort_order);


-- ----------------------------------------------------------------------------
-- pod_artwork — one uploaded motif, its verdict, and its two outputs.
--
-- The lifecycle, and the only lifecycle:
--
--   processing  the row was inserted before the farm was called. A row may sit
--               here only for the duration of one dispatch; see the route for
--               why a farm FAILURE deletes the row rather than parking it in a
--               'failed' status.
--   ready       the farm returned ok:true, BOTH outputs were verified present
--               in R2 at the reported byte sizes, and only then was this
--               status written. There is no state in which `ready` means
--               "probably uploaded".
--   rejected    the farm returned ok:false. The artwork failed the gate; the
--               job succeeded. The reasons are the Swedish user-facing
--               messages from the pipeline core, stored verbatim.
-- ----------------------------------------------------------------------------
CREATE TABLE pod_artwork (
  artwork_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  -- The ORIGINAL upload, as a checkpoint-15/16 stored object. A real FK, not a
  -- loose id: the original is owned by the object store, was uploaded through
  -- the object surface, and its bytes are verified by R2's own checksum on the
  -- way in. This table borrows it and must never write it.
  --
  -- ON DELETE RESTRICT matters more than usual here: `stored_objects` rows are
  -- SOFT-deleted (status='deleted'), so this constraint is not what stops the
  -- owner from retiring an original — the divergence note in the route covers
  -- that. What it stops is a hard row removal leaving an artwork row pointing
  -- at nothing.
  original_object_id TEXT NOT NULL REFERENCES stored_objects(object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  -- The profile the verdict was produced under, FROZEN as a plain string.
  --
  -- DELIBERATELY NOT A FOREIGN KEY. A verdict is a measurement taken under a
  -- specific spec at a specific moment; the spec is platform-editable and a
  -- profile can be retired outright. A FK would mean either that retiring a
  -- profile is impossible while any artwork names it (RESTRICT), or that
  -- retiring one silently rewrites history (SET NULL / CASCADE). Both are
  -- worse than a dangling string. The same reasoning production applies to
  -- `validation.profileId`, and the same reasoning checkpoint 22 applied to
  -- discount scope product ids.
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),

  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'rejected')),

  -- ---- the verdict facts (PipelineMeta), NULL until a verdict exists -------
  -- Every one of these is MEASURED BY THE FARM and copied verbatim. Nothing in
  -- this worker computes DPI or print millimetres; the gate math lives in one
  -- place (artworkPipelineCore.ts) and duplicating it here is exactly the
  -- drift the pipeline-core extraction existed to prevent.
  width_px INTEGER CHECK (width_px IS NULL OR width_px > 0),
  height_px INTEGER CHECK (height_px IS NULL OR height_px > 0),
  effective_dpi INTEGER CHECK (effective_dpi IS NULL OR effective_dpi > 0),
  max_print_w_mm INTEGER CHECK (max_print_w_mm IS NULL OR max_print_w_mm >= 0),
  max_print_h_mm INTEGER CHECK (max_print_h_mm IS NULL OR max_print_h_mm >= 0),
  -- The core's PIPELINE_VERSION at the time of the verdict. Prod stores the
  -- same value for the same purpose: a spec tightening (2026-07-27) made old
  -- verdicts revalidatable, and the version is how you find them.
  pipeline_version INTEGER CHECK (pipeline_version IS NULL OR pipeline_version > 0),

  -- ---- notices and reasons, verbatim JSON --------------------------------
  -- [{ "code": "...", "message": "..." }] in both cases, with the Swedish
  -- messages unchanged from the pipeline. Stored as the farm sent them rather
  -- than normalized into columns: they are USER-FACING TEXT authored by the
  -- pipeline, and any re-derivation here would be a second, drifting copy of
  -- strings the print spec is written against.
  notices_json TEXT CHECK (
    notices_json IS NULL
    OR (json_valid(notices_json) AND json_type(notices_json) = 'array')
  ),
  reasons_json TEXT CHECK (
    reasons_json IS NULL
    OR (json_valid(reasons_json) AND json_type(reasons_json) = 'array')
  ),

  -- ---- the SERVER-OWNED outputs ------------------------------------------
  -- R2 keys under the dedicated `pod/` prefix. NOT `stored_objects` rows and
  -- NOT under the `shops/` prefix that table's containment CHECK enforces —
  -- that separation is the delivery teeth (see the header). The key format is
  -- pinned by the CHECKs below rather than merely by convention, because a
  -- containment invariant that lives only in application code is one refactor
  -- away from not existing.
  --
  -- Same byte-exact substr() comparison checkpoint 15 established, and for the
  -- same reason: LIKE treats `_` as a wildcard and is ASCII-case-insensitive,
  -- so tenant `a_b` would accept `pod/axb/...` and tenant `abc` would accept
  -- `pod/ABC/...`.
  print_object_key TEXT CHECK (
    print_object_key IS NULL
    OR substr(print_object_key, 1, length('pod/' || tenant_id || '/print/'))
       = 'pod/' || tenant_id || '/print/'
  ),
  preview_object_key TEXT CHECK (
    preview_object_key IS NULL
    OR substr(preview_object_key, 1, length('pod/' || tenant_id || '/preview/'))
       = 'pod/' || tenant_id || '/preview/'
  ),

  -- The farm's double-report, persisted. The contract left "should the farm
  -- report output sha256" open and checkpoint 26 answered yes; this is where
  -- the answer lands. The sizes are what the dispatch route compares against a
  -- real R2 HEAD before it writes 'ready', so they are not decoration — they
  -- are the input to the verification. The hashes are recorded for the print
  -- portal and for a later integrity sweep.
  print_sha256 TEXT CHECK (print_sha256 IS NULL OR (length(print_sha256) = 64 AND print_sha256 GLOB '[0-9a-f]*')),
  print_bytes INTEGER CHECK (print_bytes IS NULL OR print_bytes > 0),
  preview_sha256 TEXT CHECK (preview_sha256 IS NULL OR (length(preview_sha256) = 64 AND preview_sha256 GLOB '[0-9a-f]*')),
  preview_bytes INTEGER CHECK (preview_bytes IS NULL OR preview_bytes > 0),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),

  -- ---- what SQL can enforce about the status machine ---------------------
  --
  -- READY IS A COMPLETE STATEMENT. A 'ready' row without both output keys,
  -- both hashes, both byte counts and the full fact set would be a row the
  -- print portal could read and then fail to deliver — the exact half-written
  -- state the verify-before-ready discipline exists to prevent. Making it
  -- unstorable means the discipline survives a future caller who forgets it.
  CHECK (
    status <> 'ready'
    OR (
      print_object_key IS NOT NULL
      AND preview_object_key IS NOT NULL
      AND print_sha256 IS NOT NULL
      AND print_bytes IS NOT NULL
      AND preview_sha256 IS NOT NULL
      AND preview_bytes IS NOT NULL
      AND width_px IS NOT NULL
      AND height_px IS NOT NULL
      AND effective_dpi IS NOT NULL
      AND max_print_w_mm IS NOT NULL
      AND max_print_h_mm IS NOT NULL
      AND pipeline_version IS NOT NULL
    )
  ),
  -- A REJECTION MUST SAY WHY. An empty-reasoned rejection would show the
  -- uploader a rejected card with no explanation, which is precisely the
  -- failure mode the Swedish messages were written to avoid.
  CHECK (
    status <> 'rejected'
    OR (reasons_json IS NOT NULL AND json_array_length(reasons_json) > 0)
  ),
  -- NOTHING IS DELIVERABLE BEFORE A VERDICT. A 'processing' row must not carry
  -- output keys: it has none, and a key present at that point could only have
  -- come from a caller inventing one.
  CHECK (
    status <> 'processing'
    OR (print_object_key IS NULL AND preview_object_key IS NULL)
  ),

  -- ---- CONCURRENCY: one row per (tenant, original, profile) --------------
  --
  -- This is the structural half of the no-double-dispatch guarantee, and it is
  -- the half that holds even if the route's logic were wrong. Two racing POSTs
  -- for the same object and profile insert the same triple; SQLite admits one
  -- and aborts the other, and the loser answers a conflict WITHOUT having
  -- called the farm — the insert happens before the dispatch precisely so the
  -- constraint can arbitrate before any outbound compute is spent.
  --
  -- The tenant is in the key even though `original_object_id` is already
  -- tenant-unique via its own table, because a UNIQUE that reads correctly on
  -- its own is worth more than one that is correct only by reference to
  -- another table's invariant.
  --
  -- Re-running the SAME original under a DIFFERENT profile is deliberately
  -- allowed: that is a different measurement of the same file, and prod's
  -- reprocess mode exists for exactly that.
  UNIQUE (tenant_id, original_object_id, profile_id)
);

-- Tenant immutability, the same discipline every tenant-scoped table here
-- carries since 0001: a row cannot be re-homed to another tenant by an UPDATE
-- that forgot its WHERE clause.
CREATE TRIGGER pod_artwork_tenant_immutable
BEFORE UPDATE OF tenant_id ON pod_artwork
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- The tenant-match guard the FK alone cannot give. `original_object_id`
-- references a GLOBAL primary key, so the FK is satisfied by ANY tenant's
-- object — exactly the gap 0007's checkout_items closed against products and
-- 0011's orders closed against checkouts. The route also checks ownership
-- before it inserts; this trigger is what makes the check impossible to skip.
CREATE TRIGGER pod_artwork_original_tenant_matches_insert
BEFORE INSERT ON pod_artwork
FOR EACH ROW
WHEN (
  SELECT tenant_id FROM stored_objects WHERE object_id = NEW.original_object_id
) IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'artwork original must belong to the same tenant');
END;

CREATE TRIGGER pod_artwork_original_tenant_matches_update
BEFORE UPDATE OF original_object_id, tenant_id ON pod_artwork
FOR EACH ROW
WHEN (
  SELECT tenant_id FROM stored_objects WHERE object_id = NEW.original_object_id
) IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'artwork original must belong to the same tenant');
END;

-- A VERDICT IS FINAL. Once a row leaves 'processing' it never returns, and a
-- 'ready' row never becomes 'rejected' or vice versa. Re-measuring an original
-- under the same profile is not an UPDATE of this row — it is a delete and a
-- fresh dispatch, which is what keeps `print_object_key` a stable reference
-- for anything that later points at it.
--
-- Production's reprocess mode DOES mutate the doc in place (processArtwork.ts
-- REPROCESS branch flips status ready<->rejected on an existing doc), and that
-- is a real divergence, recorded here rather than in a comment nobody reads:
-- prod's artwork docs are client-writable and it had no constraint layer to
-- lean on, whereas here a mutable verdict would mean a print file's key could
-- change under an order that already referenced it.
CREATE TRIGGER pod_artwork_status_is_terminal
BEFORE UPDATE OF status ON pod_artwork
FOR EACH ROW
WHEN OLD.status <> 'processing' AND NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'artwork status is terminal once a verdict exists');
END;

-- The server-owned output keys are write-ONCE. The dispatch route writes them
-- in the same guarded UPDATE that sets 'ready'; nothing may re-point them
-- afterwards, because the bytes at that key are the print file and a moved
-- pointer is how a print job silently starts printing something else.
CREATE TRIGGER pod_artwork_output_keys_immutable
BEFORE UPDATE ON pod_artwork
FOR EACH ROW
WHEN (
  (OLD.print_object_key IS NOT NULL AND NEW.print_object_key IS NOT OLD.print_object_key)
  OR (OLD.preview_object_key IS NOT NULL AND NEW.preview_object_key IS NOT OLD.preview_object_key)
)
BEGIN
  SELECT RAISE(ABORT, 'artwork output keys cannot be re-pointed');
END;

-- The tenant library listing, newest first, and the status filter the UI's
-- spinner cards need.
CREATE INDEX pod_artwork_tenant_created_idx ON pod_artwork(tenant_id, created_at DESC);
CREATE INDEX pod_artwork_tenant_status_idx ON pod_artwork(tenant_id, status);
