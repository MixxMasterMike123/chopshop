import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type { PlatformPrincipal } from "../auth/live-authorization";
import type { JobProfile } from "./render-farm-client";

/**
 * POD print profiles — the specifications the 300-DPI gate measures against.
 *
 * PLATFORM-LEVEL, not tenant-level. See the migration's own rationale: a
 * profile encodes the PRINT SHOP's physical capability (the 250x350 mm garment
 * front, the 300 DPI floor, the formats sharp can rasterize), and the print
 * shop is the platform's supplier rather than any tenant's. Production models
 * it the same way — one `settings/podProfiles` document, readable by every
 * active user and writable only under `isPlatform`.
 *
 * Tenant admins therefore READ this list (to populate the upload picker) and
 * the platform REPLACES it wholesale. There is no per-profile PATCH: the list
 * is a specification document that arrives from the printer as a unit, and
 * production edits it exactly that way (scripts/seed-pod-profiles.cjs writes
 * the whole array with --force). A partial-update surface would invite a state
 * where two profiles disagree about the same physical product.
 */

export interface PodProfile {
  acceptedFormats: Array<{ ext: string }>;
  active: boolean;
  label: string;
  maxFileMb: number;
  minDpi: number;
  printAreaMm: { h: number; w: number };
  profileId: string;
  sortOrder: number;
}

interface PodProfileRow {
  accepted_formats_json: string;
  active: number;
  label: string;
  max_file_mb: number;
  min_dpi: number;
  print_area_h_mm: number;
  print_area_w_mm: number;
  profile_id: string;
  sort_order: number;
}

export type ReplaceProfilesResult =
  | { profiles: PodProfile[]; status: "ok" }
  | { status: "invalid" };

// Bounds mirroring the migration's CHECKs. Validated here too so a malformed
// request answers a clean 400 rather than a constraint failure the route would
// have to interpret.
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const PROFILE_ID_MAX_LENGTH = 64;
const LABEL_MAX_LENGTH = 200;
const MIN_DPI_MAX = 2400;
const PRINT_AREA_MM_MAX = 10_000;
const MAX_FILE_MB_MAX = 200;
const MAX_PROFILES = 50;
const MAX_ACCEPTED_FORMATS = 20;
// The format vocabulary the pipeline can actually decode. sharp on the farm
// handles these four; PDF and SVG are refused by the print spec (v1) because
// sharp cannot rasterize them, and admitting them into a profile would produce
// uploads that always fail with a confusing message rather than a clear one.
const ALLOWED_FORMAT_EXTS = ["jpg", "png", "tiff", "webp"];

const PROFILE_KEYS = [
  "acceptedFormats",
  "active",
  "label",
  "maxFileMb",
  "minDpi",
  "printAreaMm",
  "profileId",
  "sortOrder",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function parseAcceptedFormats(value: unknown): Array<{ ext: string }> | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ACCEPTED_FORMATS
  ) {
    return null;
  }

  const formats: Array<{ ext: string }> = [];
  const seen = new Set<string>();

  for (const entry of value) {
    // The wire shape is the CONTRACT's shape — an array of objects with an
    // `ext` — not a bare string array, because that array is forwarded verbatim
    // into the job envelope and the farm's validator checks exactly this.
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ["ext"])) {
      return null;
    }
    const { ext } = entry;
    if (typeof ext !== "string" || !ALLOWED_FORMAT_EXTS.includes(ext)) {
      return null;
    }
    // A duplicated ext is refused rather than deduplicated: it means the
    // operator's document disagrees with itself, and silently repairing it
    // would hide that.
    if (seen.has(ext)) {
      return null;
    }
    seen.add(ext);
    formats.push({ ext });
  }

  return formats;
}

function parseProfile(value: unknown): PodProfile | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, PROFILE_KEYS)) {
    return null;
  }

  const {
    acceptedFormats,
    active,
    label,
    maxFileMb,
    minDpi,
    printAreaMm,
    profileId,
    sortOrder,
  } = value;

  if (
    typeof profileId !== "string" ||
    profileId.length === 0 ||
    profileId.length > PROFILE_ID_MAX_LENGTH ||
    !PROFILE_ID_PATTERN.test(profileId) ||
    typeof label !== "string" ||
    label.length === 0 ||
    label.length > LABEL_MAX_LENGTH ||
    !isBoundedInt(minDpi, 1, MIN_DPI_MAX) ||
    !isBoundedInt(maxFileMb, 1, MAX_FILE_MB_MAX) ||
    !isPlainObject(printAreaMm) ||
    !hasOnlyKeys(printAreaMm, ["h", "w"]) ||
    !isBoundedInt(printAreaMm.w, 1, PRINT_AREA_MM_MAX) ||
    !isBoundedInt(printAreaMm.h, 1, PRINT_AREA_MM_MAX) ||
    typeof active !== "boolean" ||
    !isBoundedInt(sortOrder, 0, 10_000)
  ) {
    return null;
  }

  const formats = parseAcceptedFormats(acceptedFormats);
  if (formats === null) {
    return null;
  }

  return {
    acceptedFormats: formats,
    active,
    label,
    maxFileMb,
    minDpi,
    printAreaMm: { h: printAreaMm.h, w: printAreaMm.w },
    profileId,
    sortOrder,
  };
}

/**
 * Parse the platform's full-replace body: `{ profiles: [...] }`.
 *
 * An EMPTY list is deliberately allowed. It means "no profiles are configured",
 * which is a legitimate state — it is what a fresh platform looks like, and it
 * makes the artwork surface refuse every upload, which is the correct behaviour
 * when there is no print specification to measure against.
 */
export function parseReplaceProfilesInput(body: unknown): PodProfile[] | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["profiles"])) {
    return null;
  }

  const { profiles } = body;
  if (!Array.isArray(profiles) || profiles.length > MAX_PROFILES) {
    return null;
  }

  const parsed: PodProfile[] = [];
  const seen = new Set<string>();

  for (const entry of profiles) {
    const profile = parseProfile(entry);
    if (profile === null) {
      return null;
    }
    // Duplicate ids would collide on the PRIMARY KEY inside the batch. Caught
    // here so the operator gets a 400 naming nothing rather than a 500.
    if (seen.has(profile.profileId)) {
      return null;
    }
    seen.add(profile.profileId);
    parsed.push(profile);
  }

  return parsed;
}

function toProfile(row: PodProfileRow): PodProfile {
  return {
    // Stored verbatim as the contract shape and parsed back the same way. It
    // was validated on the way in, so a parse failure here would mean the row
    // was written by something other than this module.
    acceptedFormats: JSON.parse(row.accepted_formats_json) as Array<{
      ext: string;
    }>,
    active: row.active === 1,
    label: row.label,
    maxFileMb: row.max_file_mb,
    minDpi: row.min_dpi,
    printAreaMm: { h: row.print_area_h_mm, w: row.print_area_w_mm },
    profileId: row.profile_id,
    sortOrder: row.sort_order,
  };
}

const PROFILE_SELECT = `SELECT
     profile_id, label, min_dpi, print_area_w_mm, print_area_h_mm,
     max_file_mb, accepted_formats_json, sort_order, active
   FROM pod_profiles`;

/**
 * The ACTIVE profiles, for a tenant admin's upload picker.
 *
 * Inactive profiles are filtered out here rather than exposed with a flag: a
 * retired profile exists only so the artwork rows naming it remain readable,
 * and offering it in a picker would let a tenant produce new artwork under a
 * specification the printer no longer honours.
 */
export async function listActiveProfiles(
  db: D1Database,
  _principal: TenantAdminPrincipal,
): Promise<PodProfile[]> {
  const result = await db
    .prepare(`${PROFILE_SELECT} WHERE active = 1 ORDER BY sort_order, profile_id`)
    .all<PodProfileRow>();

  return result.results.map(toProfile);
}

/**
 * Load one profile for a dispatch, active or not.
 *
 * Deliberately NOT filtered on `active`: the caller checks that separately, so
 * that "this profile does not exist" and "this profile is retired" can be
 * distinguished internally even though the route answers both the same way.
 */
export async function getProfile(
  db: D1Database,
  profileId: string,
): Promise<PodProfile | null> {
  const row = await db
    .prepare(`${PROFILE_SELECT} WHERE profile_id = ? LIMIT 1`)
    .bind(profileId)
    .first<PodProfileRow>();

  return row === null ? null : toProfile(row);
}

/**
 * Reduce a stored profile to the FIVE fields the pipeline core consumes.
 *
 * `label`, `active` and `sortOrder` are dropped here, and that is the whole
 * point of the function existing: the farm receives a print specification and
 * nothing about how this platform presents it. The farm's validator checks
 * exactly these five, so anything extra would be either ignored or — worse —
 * quietly relied upon by a future farm version.
 */
export function toJobProfile(profile: PodProfile): JobProfile {
  return {
    accepted_formats: profile.acceptedFormats,
    id: profile.profileId,
    max_file_mb: profile.maxFileMb,
    min_dpi: profile.minDpi,
    print_area_mm: { h: profile.printAreaMm.h, w: profile.printAreaMm.w },
  };
}

/**
 * Replace the whole profile list in one batch: delete every row, insert the new
 * set, append one audit row.
 *
 * DELETE-then-INSERT rather than an upsert diff, because the list IS the
 * document: a profile absent from the new body is retired, and expressing that
 * as an upsert would require computing the complement anyway. One `db.batch`
 * means a failed insert leaves the previous list intact rather than a half-
 * replaced specification — the state in which two profiles could disagree about
 * the same physical product.
 *
 * The audit row is PLATFORM-scoped (`tenant_id` NULL) because this is not a
 * tenant's action. It records the profile IDS and the count and nothing else —
 * no dimensions, no DPI values: the audit trail answers "who changed the print
 * spec and which profiles were in it", and the spec itself is readable from the
 * table.
 */
export async function replaceProfiles(
  db: D1Database,
  principal: PlatformPrincipal,
  profiles: PodProfile[],
  now: number,
): Promise<ReplaceProfilesResult> {
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM pod_profiles"),
  ];

  for (const profile of profiles) {
    statements.push(
      db
        .prepare(
          `INSERT INTO pod_profiles (
             profile_id, label, min_dpi, print_area_w_mm, print_area_h_mm,
             max_file_mb, accepted_formats_json, sort_order, active,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          profile.profileId,
          profile.label,
          profile.minDpi,
          profile.printAreaMm.w,
          profile.printAreaMm.h,
          profile.maxFileMb,
          JSON.stringify(profile.acceptedFormats),
          profile.sortOrder,
          profile.active ? 1 : 0,
          now,
          now,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, NULL, ?, 'pod.profiles.replace', 'pod_profiles', NULL, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        JSON.stringify({
          count: profiles.length,
          profileIds: profiles.map((profile) => profile.profileId),
        }),
        now,
      ),
  );

  await db.batch(statements);

  return { profiles, status: "ok" };
}
