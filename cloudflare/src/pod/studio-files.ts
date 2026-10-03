import type { PlatformPrincipal } from "../auth/live-authorization";
import type { RasterImageType } from "../storage/image-sniff";
import {
  normalizeImageType,
  readImageDimensions,
  sniffImageType,
} from "../storage/image-sniff";
import { publicObjectBase, publicObjectUrl } from "../storage/public-objects";

/**
 * The design studio's platform-owned files (CP5-WH, D101): the garment photos,
 * the displacement maps and the masks the mockup templates and the 3D models
 * name. Platform assets, not a shop's: their rows live in `pod_studio_files`
 * (0049), never in `stored_objects`, and their bytes in the PUBLIC bucket
 * under `platform/studio/<fileId>/v1/image.<ext>` — never under `shops/`.
 *
 * ONE upload path, platform only (src/routes/pod-studio-assets.ts):
 *
 *   1. the body is read whole, bounded by the declared Content-Length (at
 *      most 15 MiB, D92's public-image cap) — a studio photo is a few hundred
 *      kilobytes, so the isolate never holds much;
 *   2. the TYPE is proven from the file's own first bytes (image-sniff.ts) and
 *      must be one of PNG, JPEG, WebP or AVIF, and equal to the stated
 *      Content-Type. No SVG: the studio draws flats from its own code and
 *      every uploaded asset is a raster photo or map; no GIF or icon either;
 *   3. the file's identity is its sha256, computed here. The same bytes
 *      uploaded again answer the file that already holds them (200), so an
 *      import that is run twice uploads nothing twice;
 *   4. the row is reserved `pending`, the bytes are put, the row turns
 *      `active` with its pixel size, and one audit row is written with it.
 *      A pending row left by an upload that died is finished by the next
 *      upload of the same bytes (same key, same bytes: the put is repeatable).
 *
 * Nothing deletes a studio file: a template or a model stops naming it.
 */

export const STUDIO_FILE_MAX_BYTES = 15 * 1024 * 1024;

export type StudioFileType = Extract<
  RasterImageType,
  "image/avif" | "image/jpeg" | "image/png" | "image/webp"
>;

const STUDIO_FILE_TYPES: Readonly<Record<StudioFileType, string>> = {
  "image/avif": "avif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Written once: the key is never rewritten with other bytes.
const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

export const STUDIO_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StudioFile {
  contentType: StudioFileType;
  fileId: string;
  height: number | null;
  sha256: string;
  sizeBytes: number;
  // The public address; null while PUBLIC_OBJECT_BASE_URL is not configured.
  url: string | null;
  width: number | null;
}

export interface StudioFileRow {
  content_type: string;
  file_id: string;
  height_px: number | null;
  object_key: string;
  sha256: string;
  size_bytes: number;
  status: string;
  width_px: number | null;
}

export type StudioFileRefusal = "not_an_allowed_image" | "type_not_as_stated";

export type UploadStudioFileResult =
  | { created: boolean; file: StudioFile; status: "ok" }
  | { reason?: StudioFileRefusal; status: "invalid" }
  | { status: "conflict" | "too_large" | "unavailable" };

function iso(now: number): string {
  return new Date(now).toISOString();
}

function isStudioFileType(value: string | null): value is StudioFileType {
  return value !== null && Object.hasOwn(STUDIO_FILE_TYPES, value);
}

export function isStudioFileId(value: unknown): value is string {
  return typeof value === "string" && STUDIO_FILE_ID_PATTERN.test(value);
}

export function studioFileKey(fileId: string, type: StudioFileType): string {
  return `platform/studio/${fileId}/v1/image.${STUDIO_FILE_TYPES[type]}`;
}

/** The address of a studio file's key, or null without a valid public base. */
export function studioFileUrl(base: string | null, objectKey: string): string | null {
  return base === null ? null : publicObjectUrl(base, objectKey);
}

export function toStudioFile(row: StudioFileRow, base: string | null): StudioFile {
  return {
    contentType: row.content_type as StudioFileType,
    fileId: row.file_id,
    height: row.height_px,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    url: studioFileUrl(base, row.object_key),
    width: row.width_px,
  };
}

const FILE_COLUMNS =
  "file_id, object_key, content_type, size_bytes, sha256, width_px, height_px, status";

/** The upload surface exists only with the public bucket AND a valid public base. */
export function isStudioFileStoreConfigured(env: Env): boolean {
  return env.PUBLIC_BUCKET !== undefined && publicObjectBase(env) !== null;
}

/**
 * The declared length: present, digits only, within the cap. "too_large" is
 * answered before a byte of the body is read.
 */
export function declaredStudioFileLength(
  request: Request,
): number | "invalid" | "too_large" {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^[0-9]{1,15}$/.test(raw)) {
    return "invalid";
  }
  const length = Number(raw);
  if (length > STUDIO_FILE_MAX_BYTES) {
    return "too_large";
  }
  return length >= 1 ? length : "invalid";
}

/** Reads at most `limit + 1` bytes: one past the declared length shows a longer body. */
async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= limit) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBySha256(db: D1Database, sha256: string): Promise<StudioFileRow | null> {
  return db
    .prepare(`SELECT ${FILE_COLUMNS} FROM pod_studio_files WHERE sha256 = ? LIMIT 1`)
    .bind(sha256)
    .first<StudioFileRow>();
}

/**
 * The upload (see the header). The caller has authorized a platform principal,
 * checked same-origin and that the store is configured.
 */
export async function uploadStudioFile(
  env: Env,
  principal: PlatformPrincipal,
  request: Request,
  now: number,
): Promise<UploadStudioFileResult> {
  const bucket = env.PUBLIC_BUCKET;
  const base = publicObjectBase(env);
  if (bucket === undefined || base === null) {
    return { status: "unavailable" };
  }

  const declared = declaredStudioFileLength(request);
  if (declared === "too_large") {
    return { status: "too_large" };
  }
  const stated = normalizeImageType(request.headers.get("content-type") ?? "");
  if (declared === "invalid" || request.body === null) {
    return { status: "invalid" };
  }

  const bytes = await readBounded(request.body, declared);
  if (bytes.byteLength !== declared) {
    return { status: "invalid" };
  }

  const proven = sniffImageType(bytes);
  if (!isStudioFileType(proven)) {
    return { reason: "not_an_allowed_image", status: "invalid" };
  }
  if (stated !== proven) {
    return { reason: "type_not_as_stated", status: "invalid" };
  }
  const size = readImageDimensions(proven, bytes);
  const dimensions = size === null || size === "need_more" ? null : size;
  const sha256 = await sha256Hex(bytes);

  const existing = await readBySha256(env.DB, sha256);
  if (existing !== null && existing.status === "active") {
    return { created: false, file: toStudioFile(existing, base), status: "ok" };
  }

  let row: StudioFileRow;
  if (existing !== null) {
    // A reservation an earlier upload of these bytes left: finish it.
    row = existing;
  } else {
    const fileId = crypto.randomUUID();
    row = {
      content_type: proven,
      file_id: fileId,
      height_px: null,
      object_key: studioFileKey(fileId, proven),
      sha256,
      size_bytes: declared,
      status: "pending",
      width_px: null,
    };
    try {
      await env.DB.prepare(
        `INSERT INTO pod_studio_files (
           file_id, object_key, content_type, size_bytes, sha256, status,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
        .bind(row.file_id, row.object_key, proven, declared, sha256, principal.userId, iso(now), iso(now))
        .run();
    } catch (error) {
      // Two uploads of the same bytes at once: the other one reserved first.
      const raced = await readBySha256(env.DB, sha256);
      if (raced === null) {
        throw error;
      }
      return raced.status === "active"
        ? { created: false, file: toStudioFile(raced, base), status: "ok" }
        : { status: "conflict" };
    }
  }

  await bucket.put(row.object_key, bytes, {
    httpMetadata: { cacheControl: PUBLIC_CACHE_CONTROL, contentType: row.content_type },
  });

  // The activation and its audit row in one batch. Two uploads of a pending
  // row racing here both put the same bytes; each writes its audit row (each
  // did upload), and only the first UPDATE changes the row.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE pod_studio_files
       SET status = 'active', width_px = ?, height_px = ?, updated_at = ?
       WHERE file_id = ? AND status = 'pending'`,
    ).bind(dimensions?.width ?? null, dimensions?.height ?? null, iso(now), row.file_id),
    env.DB.prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       ) VALUES (?, NULL, ?, 'pod.studio_file.upload', 'pod_studio_file', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      principal.userId,
      row.file_id,
      crypto.randomUUID(),
      JSON.stringify({ contentType: row.content_type, sha256, sizeBytes: declared }),
      now,
    ),
  ]);
  const activated = (results[0]?.meta.changes ?? 0) === 1;
  const current = await readBySha256(env.DB, sha256);
  if (current === null || current.status !== "active") {
    return { status: "conflict" };
  }
  return { created: activated, file: toStudioFile(current, base), status: "ok" };
}

/**
 * The ACTIVE files among `fileIds`, by id (one query, ids as one JSON
 * parameter: no bound-parameter limit).
 */
export async function readActiveStudioFiles(
  db: D1Database,
  fileIds: readonly string[],
): Promise<Map<string, StudioFileRow>> {
  const ids = [...new Set(fileIds)];
  const found = new Map<string, StudioFileRow>();
  if (ids.length === 0) {
    return found;
  }
  const result = await db
    .prepare(
      `SELECT ${FILE_COLUMNS} FROM pod_studio_files
       WHERE status = 'active' AND file_id IN (SELECT value FROM json_each(?))
       LIMIT 1000`,
    )
    .bind(JSON.stringify(ids))
    .all<StudioFileRow>();
  for (const row of result.results) {
    found.set(row.file_id, row);
  }
  return found;
}
