PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP5-WH — the design studio's platform-owned assets (DECISIONS D101).
--
-- WHAT. The garment mockup templates the studio composes artwork onto (their
-- photos per colourway, the fabric displacement maps, the calibrated print
-- areas in px and mm) and the 3D-view model library (photo, displacement map
-- and optional mask per view and colourway, the calibrated print area, the
-- warp tuning). Firebase kept them in `settings/podMockupTemplates` (one
-- document holding an array), the `pod3dModels` collection and Storage /
-- hosting files.
--
-- WHOSE (D101). They belong to the PLATFORM, not to a shop: every POD shop's
-- studio reads the same ones, and they are not secret (a mockup photo ends up
-- in public product images). Nothing here is tenant-scoped, and no table has a
-- tenant column. Their files therefore cannot live in `stored_objects`: that
-- table requires a tenant and keys under `shops/<tenant>/` (0006). They get a
-- registry of their own, `pod_studio_files`, whose keys sit under
-- `platform/studio/<file_id>/` in the PUBLIC bucket. A CHECK below pins the
-- prefix, so a platform file can never sit under a shop's key space, and no
-- tenant route writes to these tables (src/routes/pod-studio-assets.ts: every
-- write is behind the platform principal).
--
-- ADDRESSES. Rows hold file ids and keys, never addresses: an address is
-- made at read time from PUBLIC_OBJECT_BASE_URL and the key, as CP4 does for
-- product images (src/storage/public-objects.ts).
--
-- VOCABULARY. A template names its garment with the printers' garment ids
-- (src/pod/printers.ts PrinterModel.garment: 'tee', 'hoodie', …) and its print
-- areas with PRINT_SLOTS ('front', 'back', 'pocket', 'left_sleeve',
-- 'right_sleeve'). The studio offers a template only when a usable printer
-- makes its garment (GET /v1/admin/pod/printers → `garments`).
--
-- NO MONEY. No price, cost, tier or supplier field exists on these rows (A13,
-- "the seller sees ONE number"): a seller reads them.
--
-- TIME. ISO-8601 UTC text written by the server, with the round-trip CHECK of
-- the newest tables (0042, 0044, 0046).
--
-- BOUNDS. Pixel values are integers in 0..20000 (a rect's width and height at
-- least 1 on a template), millimetres 1..2000 (the printers' MAX_AREA_MM), a
-- file at most 15 MiB (the public image cap of D92).
-- ============================================================================

-- ── the files ───────────────────────────────────────────────────────────────
--
-- One row per distinct file (by its sha256). Written ONLY by
-- POST /v1/platform/pod/studio-files: the row is reserved `pending`, the bytes
-- go to the public bucket under `object_key`, the row turns `active`. The type
-- is the one the file's own first bytes prove (src/storage/image-sniff.ts); an
-- SVG, a GIF or an icon is not admitted. A pending row whose upload died is
-- finished by the next upload of the same bytes (same key, same bytes).
CREATE TABLE pod_studio_files (
  file_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(file_id) = 36 AND file_id NOT GLOB '*[^0-9a-f-]*'
  ),
  object_key TEXT NOT NULL UNIQUE CHECK (
    object_key = 'platform/studio/' || file_id || '/v1/image.' || CASE content_type
      WHEN 'image/avif' THEN 'avif'
      WHEN 'image/jpeg' THEN 'jpg'
      WHEN 'image/png' THEN 'png'
      WHEN 'image/webp' THEN 'webp'
    END
  ),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/avif', 'image/jpeg', 'image/png', 'image/webp')
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 15728640),
  sha256 TEXT NOT NULL UNIQUE CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  -- NULL = not found within the bounded read of the file's head.
  width_px INTEGER CHECK (width_px IS NULL OR width_px BETWEEN 1 AND 100000),
  height_px INTEGER CHECK (height_px IS NULL OR height_px BETWEEN 1 AND 100000),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND updated_at >= created_at
  )
);

-- A file's identity is its bytes: the key, the type and the hash never change,
-- and an active file never goes back to pending.
CREATE TRIGGER pod_studio_files_identity_immutable
BEFORE UPDATE ON pod_studio_files
FOR EACH ROW
WHEN NEW.object_key IS NOT OLD.object_key
  OR NEW.content_type IS NOT OLD.content_type
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.size_bytes IS NOT OLD.size_bytes
  OR (OLD.status = 'active' AND NEW.status <> 'active')
BEGIN
  SELECT RAISE(ABORT, 'a studio file is immutable');
END;

-- ── mockup templates ────────────────────────────────────────────────────────
--
-- A template is a FLAT (an SVG flat the studio draws from `garment`, in the
-- colourway's hex; no files) or a PHOTO (photo_w_px/photo_h_px set: a garment
-- photo per colourway, front and back, in that coordinate space). A photo
-- template may carry displacement maps (map_*): one map per view, shared by
-- every colourway, in their own coordinate space, with the warp tuning.
CREATE TABLE pod_mockup_templates (
  template_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(template_id) BETWEEN 1 AND 64
    AND template_id GLOB '[a-z0-9]*'
    AND template_id NOT GLOB '*[^a-z0-9_-]*'
  ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND label = trim(label)),
  garment TEXT NOT NULL CHECK (
    length(garment) BETWEEN 1 AND 40
    AND garment GLOB '[a-z]*'
    AND garment NOT GLOB '*[^a-z0-9_-]*'
  ),
  -- The print profile (pod_profiles) whose DPI rules the studio applies. Not a
  -- foreign key: the platform replaces the profile list wholesale (0012).
  profile_id TEXT NOT NULL CHECK (
    length(profile_id) BETWEEN 1 AND 64
    AND profile_id GLOB '[a-z0-9]*'
    AND profile_id NOT GLOB '*[^a-z0-9_-]*'
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- 1 = a stand-in (a generic drawing, or uncalibrated): the studio says so.
  provisional INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  photo_w_px INTEGER CHECK (photo_w_px IS NULL OR photo_w_px BETWEEN 1 AND 20000),
  photo_h_px INTEGER CHECK (photo_h_px IS NULL OR photo_h_px BETWEEN 1 AND 20000),
  map_w_px INTEGER CHECK (map_w_px IS NULL OR map_w_px BETWEEN 1 AND 20000),
  map_h_px INTEGER CHECK (map_h_px IS NULL OR map_h_px BETWEEN 1 AND 20000),
  map_front_file_id TEXT REFERENCES pod_studio_files(file_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  map_back_file_id TEXT REFERENCES pod_studio_files(file_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  map_scale REAL CHECK (map_scale IS NULL OR map_scale BETWEEN 0 AND 1000),
  map_blur REAL CHECK (map_blur IS NULL OR map_blur BETWEEN 0 AND 100),
  map_contrast REAL CHECK (map_contrast IS NULL OR map_contrast BETWEEN 0 AND 20),
  map_blend TEXT CHECK (map_blend IS NULL OR map_blend IN ('normal', 'multiply', 'screen', 'overlay', 'add')),
  map_alpha REAL CHECK (map_alpha IS NULL OR map_alpha BETWEEN 0 AND 1),
  -- The discrete x offsets of the fixed-size pocket print (wearer's view).
  pocket_left_x_px INTEGER CHECK (pocket_left_x_px IS NULL OR pocket_left_x_px BETWEEN 0 AND 20000),
  pocket_center_x_px INTEGER CHECK (pocket_center_x_px IS NULL OR pocket_center_x_px BETWEEN 0 AND 20000),
  pocket_right_x_px INTEGER CHECK (pocket_right_x_px IS NULL OR pocket_right_x_px BETWEEN 0 AND 20000),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND updated_at >= created_at
  ),
  CHECK ((photo_w_px IS NULL) = (photo_h_px IS NULL)),
  CHECK ((map_w_px IS NULL) = (map_h_px IS NULL)),
  -- Maps only on a photo template; a map needs at least one file; no map, no
  -- files and no tuning.
  CHECK (map_w_px IS NULL OR photo_w_px IS NOT NULL),
  CHECK (map_w_px IS NULL OR map_front_file_id IS NOT NULL OR map_back_file_id IS NOT NULL),
  CHECK (
    map_w_px IS NOT NULL OR (
      map_front_file_id IS NULL AND map_back_file_id IS NULL AND map_scale IS NULL
      AND map_blur IS NULL AND map_contrast IS NULL AND map_blend IS NULL AND map_alpha IS NULL
    )
  )
);

CREATE INDEX pod_mockup_templates_active_idx
  ON pod_mockup_templates(active, sort_order, template_id);

-- One print area per slot: the px rect in the template's own coordinate space
-- (the photo's, or the SVG flat's viewBox) and the SAME region's physical size.
CREATE TABLE pod_mockup_template_areas (
  template_id TEXT NOT NULL REFERENCES pod_mockup_templates(template_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('front', 'back', 'pocket', 'left_sleeve', 'right_sleeve')),
  x_px INTEGER NOT NULL CHECK (x_px BETWEEN 0 AND 20000),
  y_px INTEGER NOT NULL CHECK (y_px BETWEEN 0 AND 20000),
  w_px INTEGER NOT NULL CHECK (w_px BETWEEN 1 AND 20000),
  h_px INTEGER NOT NULL CHECK (h_px BETWEEN 1 AND 20000),
  w_mm INTEGER NOT NULL CHECK (w_mm BETWEEN 1 AND 2000),
  h_mm INTEGER NOT NULL CHECK (h_mm BETWEEN 1 AND 2000),
  -- Where the rect's top sits below the collar seam (printerAreas.js moves the
  -- rect to the routed printer's own offset).
  offset_top_mm INTEGER CHECK (offset_top_mm IS NULL OR offset_top_mm BETWEEN 0 AND 2000),
  -- The studio's name for this slot on this garment ("Framsida" on a bag).
  slot_label TEXT CHECK (
    slot_label IS NULL OR (length(slot_label) BETWEEN 1 AND 40 AND slot_label = trim(slot_label))
  ),
  PRIMARY KEY (template_id, slot)
);

CREATE TABLE pod_mockup_template_colorways (
  template_id TEXT NOT NULL REFERENCES pod_mockup_templates(template_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  colorway_id TEXT NOT NULL CHECK (
    length(colorway_id) BETWEEN 1 AND 64
    AND colorway_id GLOB '[a-z0-9]*'
    AND colorway_id NOT GLOB '*[^a-z0-9_-]*'
  ),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 99),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND label = trim(label)),
  -- (D1 refuses a GLOB pattern over 50 characters: the six digits are
  -- checked as "nothing but hex digits" after the '#'.)
  hex TEXT NOT NULL CHECK (
    length(hex) = 7 AND substr(hex, 1, 1) = '#' AND substr(hex, 2) NOT GLOB '*[^0-9a-fA-F]*'
  ),
  -- The garment photo of this colourway (photo templates only); NULL = none
  -- yet (the studio shows "Foto saknas").
  front_file_id TEXT REFERENCES pod_studio_files(file_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  back_file_id TEXT REFERENCES pod_studio_files(file_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- This colourway's override of the template's warp tuning.
  blend TEXT CHECK (blend IS NULL OR blend IN ('normal', 'multiply', 'screen', 'overlay', 'add')),
  alpha REAL CHECK (alpha IS NULL OR alpha BETWEEN 0 AND 1),
  displacement_scale REAL CHECK (displacement_scale IS NULL OR displacement_scale BETWEEN 0 AND 1000),
  displacement_blur REAL CHECK (displacement_blur IS NULL OR displacement_blur BETWEEN 0 AND 100),
  displacement_contrast REAL CHECK (displacement_contrast IS NULL OR displacement_contrast BETWEEN 0 AND 20),
  PRIMARY KEY (template_id, colorway_id),
  UNIQUE (template_id, position)
);

-- ── 3D-view models ──────────────────────────────────────────────────────────
CREATE TABLE pod_3d_models (
  -- Firebase's own document ids are kept (20 characters of [A-Za-z0-9]).
  model_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(model_id) BETWEEN 1 AND 64
    AND model_id GLOB '[A-Za-z0-9]*'
    AND model_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND label = trim(label)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  displacement_scale REAL CHECK (displacement_scale IS NULL OR displacement_scale BETWEEN 0 AND 1000),
  displacement_blur REAL CHECK (displacement_blur IS NULL OR displacement_blur BETWEEN 0 AND 100),
  displacement_contrast REAL CHECK (displacement_contrast IS NULL OR displacement_contrast BETWEEN 0 AND 20),
  blend TEXT CHECK (blend IS NULL OR blend IN ('normal', 'multiply', 'screen', 'overlay', 'add')),
  alpha REAL CHECK (alpha IS NULL OR alpha BETWEEN 0 AND 1),
  output_w_px INTEGER CHECK (output_w_px IS NULL OR output_w_px BETWEEN 1 AND 20000),
  output_h_px INTEGER CHECK (output_h_px IS NULL OR output_h_px BETWEEN 1 AND 20000),
  -- Overrides keyed by colourway id: { "<id>": { blend?, alpha?,
  -- displacementScale?, displacementBlur?, displacementContrast? } }, checked
  -- key by key by the write route (src/pod/studio-assets.ts).
  per_colorway_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(per_colorway_json) AND json_type(per_colorway_json) = 'object'
    AND length(per_colorway_json) <= 16384
  ),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND updated_at >= created_at
  ),
  CHECK ((output_w_px IS NULL) = (output_h_px IS NULL))
);

CREATE INDEX pod_3d_models_active_idx ON pod_3d_models(active, label, model_id);

-- A camera angle of a model: its coordinate space (the web derivative's px;
-- NULL until the first colourway is uploaded), the calibrated print area (a
-- zero rect = not calibrated yet; the studio then leaves the model out) and
-- that area's physical size.
CREATE TABLE pod_3d_model_views (
  model_id TEXT NOT NULL REFERENCES pod_3d_models(model_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  view_id TEXT NOT NULL CHECK (view_id IN ('front', 'back')),
  w_px INTEGER CHECK (w_px IS NULL OR w_px BETWEEN 1 AND 20000),
  h_px INTEGER CHECK (h_px IS NULL OR h_px BETWEEN 1 AND 20000),
  print_x_px INTEGER NOT NULL CHECK (print_x_px BETWEEN 0 AND 20000),
  print_y_px INTEGER NOT NULL CHECK (print_y_px BETWEEN 0 AND 20000),
  print_w_px INTEGER NOT NULL CHECK (print_w_px BETWEEN 0 AND 20000),
  print_h_px INTEGER NOT NULL CHECK (print_h_px BETWEEN 0 AND 20000),
  print_w_mm INTEGER CHECK (print_w_mm IS NULL OR print_w_mm BETWEEN 0 AND 2000),
  print_h_mm INTEGER CHECK (print_h_mm IS NULL OR print_h_mm BETWEEN 0 AND 2000),
  -- The original photos' size every colourway of this view registered against
  -- (platform-only: the upload of a new colourway is checked against it).
  original_w_px INTEGER CHECK (original_w_px IS NULL OR original_w_px BETWEEN 1 AND 100000),
  original_h_px INTEGER CHECK (original_h_px IS NULL OR original_h_px BETWEEN 1 AND 100000),
  PRIMARY KEY (model_id, view_id),
  CHECK ((w_px IS NULL) = (h_px IS NULL)),
  CHECK ((print_w_mm IS NULL) = (print_h_mm IS NULL)),
  CHECK ((original_w_px IS NULL) = (original_h_px IS NULL))
);

-- One registered asset set: photo, displacement map, optional mask (same pixel
-- size, from the same frame).
CREATE TABLE pod_3d_model_colorways (
  model_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  colorway_id TEXT NOT NULL CHECK (
    length(colorway_id) BETWEEN 1 AND 64
    AND colorway_id GLOB '[a-z0-9]*'
    AND colorway_id NOT GLOB '*[^a-z0-9_-]*'
  ),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 99),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND label = trim(label)),
  photo_file_id TEXT NOT NULL REFERENCES pod_studio_files(file_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  displacement_file_id TEXT NOT NULL REFERENCES pod_studio_files(file_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  mask_file_id TEXT REFERENCES pod_studio_files(file_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The map's measured fold contrast at upload (platform-only operator hint).
  map_contrast_sd REAL CHECK (map_contrast_sd IS NULL OR map_contrast_sd BETWEEN 0 AND 256),
  PRIMARY KEY (model_id, view_id, colorway_id),
  UNIQUE (model_id, view_id, position),
  FOREIGN KEY (model_id, view_id) REFERENCES pod_3d_model_views(model_id, view_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
);
