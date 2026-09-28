import type { ObjectKind } from "./object-store";

/**
 * The one place a public object gets an address (D78, D95). Rows hold object
 * ids and keys, never addresses: an address is made at read time from
 * `PUBLIC_OBJECT_BASE_URL` and the object's key, so moving the public bucket
 * behind a domain of our own (CP7) changes one value and no row.
 *
 * Every other module turns an object id into an image through the two
 * resolvers below, and only through them. With no valid base they answer
 * nothing: a public shape then carries no image, and an admin write that
 * names one is refused.
 */

export type PublicObjectKind = Extract<
  ObjectKind,
  "preview_image" | "product_media" | "shop_branding"
>;

export interface PublicImage {
  contentType: string;
  height: number | null;
  objectId: string;
  // The base, then the key with each segment percent-encoded.
  url: string;
  width: number | null;
}

interface PublicImageRow {
  content_type: string;
  height_px: number | null;
  object_id: string;
  object_key: string;
  width_px: number | null;
}

const PUBLIC_OBJECT_KINDS: readonly PublicObjectKind[] = [
  "preview_image",
  "product_media",
  "shop_branding",
];
// `IN (...)` is chunked at 90 (PLAN §2.7): 90 ids, the tenant id and at most
// three kinds stay under D1's 100 bound parameters per query.
const ID_CHUNK_SIZE = 90;
const BASE_URL_MAX_LENGTH = 200;

/**
 * A bare https origin from `env.PUBLIC_OBJECT_BASE_URL`, else null. The value
 * must be exactly what the URL parser makes of it, optionally with one
 * trailing slash: a path, a query, a fragment, credentials, a port (even the
 * default one written out) or a spelling the parser would normalise all fail.
 */
export function publicObjectBase(env: Env): string | null {
  const configured: unknown = env.PUBLIC_OBJECT_BASE_URL;
  if (
    typeof configured !== "string" ||
    configured.length === 0 ||
    configured.length > BASE_URL_MAX_LENGTH
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }

  return parsed.protocol === "https:" &&
    parsed.port === "" &&
    (configured === parsed.origin || configured === `${parsed.origin}/`)
    ? parsed.origin
    : null;
}

/**
 * The address of the object stored under `objectKey`. Null for a key with an
 * empty, `.` or `..` segment: a client would resolve those, and the address
 * could then point outside the object's own key.
 */
export function publicObjectUrl(base: string, objectKey: string): string | null {
  const segments = objectKey.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  return `${base}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * For public shapes. Only rows that are active, in the public bucket, of this
 * tenant and of one of `kinds` resolve; anything else is absent from the map,
 * never an error. Ids are de-duplicated and read 90 at a time, in one batch.
 */
export async function resolvePublicImages(
  env: Env,
  db: D1Database,
  tenantId: string,
  objectIds: readonly string[],
  kinds: readonly PublicObjectKind[],
): Promise<Map<string, PublicImage>> {
  const images = new Map<string, PublicImage>();
  const base = publicObjectBase(env);
  const wantedKinds = [...new Set(kinds)].filter((kind) =>
    PUBLIC_OBJECT_KINDS.includes(kind),
  );
  const ids = [...new Set(objectIds)];
  if (base === null || wantedKinds.length === 0 || ids.length === 0) {
    return images;
  }

  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + ID_CHUNK_SIZE);
    statements.push(
      db
        .prepare(
          `SELECT object_id, object_key, content_type, width_px, height_px
           FROM stored_objects
           WHERE tenant_id = ?
             AND status = 'active'
             AND bucket = 'public'
             AND kind IN (${placeholders(wantedKinds.length)})
             AND object_id IN (${placeholders(chunk.length)})
           LIMIT ${ID_CHUNK_SIZE}`,
        )
        .bind(tenantId, ...wantedKinds, ...chunk),
    );
  }

  const results = await db.batch<PublicImageRow>(statements);
  for (const result of results) {
    for (const row of result.results) {
      const url = publicObjectUrl(base, row.object_key);
      if (url !== null) {
        images.set(row.object_id, {
          contentType: row.content_type,
          height: row.height_px,
          objectId: row.object_id,
          url,
          width: row.width_px,
        });
      }
    }
  }

  return images;
}

/**
 * For admin writes: may this tenant reference this object as an image? The
 * same conditions as `resolvePublicImages`; the caller refuses the write with
 * 400 on null.
 */
export async function getReferencablePublicImage(
  env: Env,
  db: D1Database,
  tenantId: string,
  objectId: string,
  kinds: readonly PublicObjectKind[],
): Promise<PublicImage | null> {
  const images = await resolvePublicImages(env, db, tenantId, [objectId], kinds);

  return images.get(objectId) ?? null;
}
