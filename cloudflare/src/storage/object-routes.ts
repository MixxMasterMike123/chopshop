import type {
  ImageDimensions,
  ImageType,
  RasterImageType,
  SvgRefusal,
} from "./image-sniff";
import {
  checkSvg,
  normalizeImageType,
  readImageDimensions,
  sniffImageType,
  SVG_MAX_BYTES,
} from "./image-sniff";
import type { ObjectBucket, ObjectKind, StoredObject } from "./object-store";
import {
  activateObject,
  bucketForKind,
  deletePendingOrMutableObject,
  deliverPrivateObject,
  getAuthorizedObjectWithDimensions,
  getUploadTargetObject,
  reservePendingObject,
} from "./object-store";
import { publicObjectBase, publicObjectUrl } from "./public-objects";
import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type { TenantContext } from "../tenancy/resolve-tenant";

export interface ReserveObjectRequest {
  contentType: string;
  fileName?: string;
  kind: ObjectKind;
  sha256: string;
  sizeBytes: number;
}

export interface ObjectMetadata {
  contentType: string;
  immutable: boolean;
  kind: ObjectKind;
  objectId: string;
  sha256: string | null;
  sizeBytes: number | null;
  status: string;
}

// A public object's metadata also says where a visitor reads it and how large
// it is. `url` is null while the public address is not configured, or when the
// caller had no `env` to read it from; width and height are null when the
// upload could not read them within its bounded look at the file.
export interface PublicObjectMetadata extends ObjectMetadata {
  height: number | null;
  url: string | null;
  width: number | null;
}

export type ReserveRouteResult =
  | { object: { objectId: string; objectKey: string }; status: "ok" }
  | { status: "conflict" | "invalid" };

// Why a public upload was refused, for the admin who sent it and for the
// importer's report (D92). `bytes_not_as_declared` covers what R2 itself
// refuses: a hash or a length that is not the declared one.
export type UploadRefusalReason =
  | "bytes_not_as_declared"
  | "type_not_as_stated"
  | `svg_${SvgRefusal}`;

export type UploadRouteResult =
  | { object: ObjectMetadata | PublicObjectMetadata; status: "ok" }
  | { reason?: UploadRefusalReason; status: "invalid" }
  | { status: "conflict" | "not_found" | "too_large" };

export type DeleteRouteResult = { status: "conflict" | "not_found" | "ok" };

type ProvenImage =
  | { dimensions: ImageDimensions | null; ok: true }
  | { ok: false; reason: UploadRefusalReason };

const RESERVE_KEYS = [
  "contentType",
  "fileName",
  "kind",
  "sha256",
  "sizeBytes",
] as const;
// The kinds an admin may reserve here. The bucket follows from the kind
// (bucketForKind); the caller never names it. `preview_image` is public too,
// but previews are written by the render service, never by an admin, and a
// `temp_upload` row would be one no route here can ever fulfil.
const RESERVABLE_KINDS: ObjectKind[] = [
  "artwork_original",
  "document",
  "export",
  "print_file",
  "product_media",
  "shop_branding",
];
// D92: the image types each public kind admits. What the file IS is proven
// from its bytes at upload; this list bounds what may be stated.
const PRODUCT_IMAGE_TYPES: readonly ImageType[] = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
];
const PUBLIC_IMAGE_TYPES: Partial<Record<ObjectKind, readonly ImageType[]>> = {
  product_media: PRODUCT_IMAGE_TYPES,
  shop_branding: [...PRODUCT_IMAGE_TYPES, "image/svg+xml", "image/x-icon"],
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_NAME_MAX_LENGTH = 200;
const CONTENT_TYPE_MAX_LENGTH = 255;
// Upload cap for the worker-proxied path. Bytes stream through the isolate, so
// this stays far below the object store's own ceiling.
export const UPLOAD_SIZE_BYTES_MAX = 100_000_000;
// D92: a public image is at most 15 MB (an SVG at most SVG_MAX_BYTES).
export const PUBLIC_IMAGE_SIZE_BYTES_MAX = 15 * 1024 * 1024;
// How much of a raster upload is read before its type is decided. The type is
// in the first bytes of every admitted format; the pixel size usually is too,
// unless a JPEG carries a large profile ahead of its frame header (then the
// size is recorded as unknown).
const IMAGE_HEAD_BYTES = 64 * 1024;
// A key is never written twice (a second upload is a conflict), so whatever
// is at an address stays what it is.
const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function parseKind(value: unknown): ObjectKind | null {
  return typeof value === "string" &&
    (RESERVABLE_KINDS as string[]).includes(value)
    ? (value as ObjectKind)
    : null;
}

// The cap for a stated type under a public kind, or null when the kind does
// not admit that type.
function publicImageCap(kind: ObjectKind, type: ImageType): number | null {
  const admitted = PUBLIC_IMAGE_TYPES[kind];
  if (admitted === undefined || !admitted.includes(type)) {
    return null;
  }

  return type === "image/svg+xml" ? SVG_MAX_BYTES : PUBLIC_IMAGE_SIZE_BYTES_MAX;
}

// A private kind keeps its stated type (the object store re-validates its
// shape). A public kind must state a type it admits, within that type's cap,
// and the type is recorded in its canonical spelling: that is what the upload
// compares the proof from the bytes with.
function admitContentType(
  kind: ObjectKind,
  contentType: string,
  sizeBytes: number,
): string | null {
  if (bucketForKind(kind) !== "public") {
    return contentType;
  }

  const type = normalizeImageType(contentType);
  const cap = type === null ? null : publicImageCap(kind, type);
  return type !== null && cap !== null && sizeBytes <= cap ? type : null;
}

function parseSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function parseSizeBytes(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= UPLOAD_SIZE_BYTES_MAX
    ? value
    : null;
}

function parseContentType(value: unknown): string | null {
  // Shape is re-validated by the object store; this only bounds the input.
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CONTENT_TYPE_MAX_LENGTH
    ? value
    : null;
}

function parseFileName(value: unknown): string | null {
  return typeof value === "string" && value.length <= FILE_NAME_MAX_LENGTH
    ? value
    : null;
}

export function parseReserveObjectInput(
  body: unknown,
): ReserveObjectRequest | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, RESERVE_KEYS)) {
    return null;
  }

  const kind = parseKind(body.kind);
  const statedType = parseContentType(body.contentType);
  const sha256 = parseSha256(body.sha256);
  const sizeBytes = parseSizeBytes(body.sizeBytes);

  if (
    kind === null ||
    statedType === null ||
    sha256 === null ||
    sizeBytes === null
  ) {
    return null;
  }

  const contentType = admitContentType(kind, statedType, sizeBytes);
  if (contentType === null) {
    return null;
  }

  if (body.fileName === undefined) {
    return { contentType, kind, sha256, sizeBytes };
  }

  const fileName = parseFileName(body.fileName);
  return fileName === null
    ? null
    : { contentType, fileName, kind, sha256, sizeBytes };
}

function toMetadata(
  object: StoredObject,
  dimensions: ImageDimensions | null,
  base: string | null,
): ObjectMetadata | PublicObjectMetadata {
  // The object key is deliberately absent: it is internal addressing, and no
  // caller should ever be able to derive access from it. A public object's
  // address necessarily carries its key, but that address grants nothing the
  // public bucket does not already grant to anyone.
  const metadata: ObjectMetadata = {
    contentType: object.contentType,
    immutable: object.immutable,
    kind: object.kind,
    objectId: object.objectId,
    sha256: object.sha256,
    sizeBytes: object.sizeBytes,
    status: object.status,
  };
  if (object.bucket !== "public") {
    return metadata;
  }

  return {
    ...metadata,
    height: dimensions?.height ?? null,
    url: base === null ? null : publicObjectUrl(base, object.objectKey),
    width: dimensions?.width ?? null,
  };
}

// The binding that holds a bucket's bytes. No binding holds `temp` objects,
// and this surface never creates one.
function bucketBinding(env: Env, bucket: ObjectBucket): R2Bucket | undefined {
  if (bucket === "private") {
    return env.PRIVATE_BUCKET;
  }

  return bucket === "public" ? env.PUBLIC_BUCKET : undefined;
}

/**
 * False only for a public kind while the public bucket or a valid public
 * address is missing: such a reservation could never be uploaded to, since
 * the upload refuses it. Private kinds answer true, as before (their binding
 * is checked at upload). The reserve route asks this before it reserves.
 */
export function isKindReservable(env: Env, kind: ObjectKind): boolean {
  return (
    bucketForKind(kind) !== "public" ||
    (env.PUBLIC_BUCKET !== undefined && publicObjectBase(env) !== null)
  );
}

// The Content-Length an upload must carry: present, numeric, within the cap
// and equal to the size declared at reserve time.
function checkContentLength(
  request: Request,
  declaredSizeBytes: number,
  capBytes: number,
): "invalid" | "ok" | "too_large" {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^[0-9]{1,15}$/.test(contentLength)) {
    return "invalid";
  }

  const declaredLength = Number(contentLength);
  if (declaredLength > capBytes) {
    return "too_large";
  }

  return declaredLength === declaredSizeBytes ? "ok" : "invalid";
}

// Reads until at least `limit` bytes are in hand or the body ends. The last
// chunk read is kept whole, so the result may run past `limit` by less than a
// chunk.
async function readAtLeast(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

// The head already read, then the rest of the upload as it arrives.
function replayed(
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      return reader.cancel(reason);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    start(controller) {
      controller.enqueue(head);
    },
  });
}

/**
 * A raster upload: its head is read and its type proven from the bytes before
 * anything is stored, then the head and the rest go to R2 as one body of the
 * declared length, with the declared hash as R2's own checksum. Refused when
 * the type is not the stated one or R2 refused the bytes; either way nothing
 * is stored.
 */
async function storeProvenRaster(
  bucket: R2Bucket,
  objectKey: string,
  body: ReadableStream<Uint8Array>,
  type: RasterImageType,
  sizeBytes: number,
  sha256: string,
): Promise<ProvenImage> {
  const reader = body.getReader();
  const head = await readAtLeast(reader, Math.min(IMAGE_HEAD_BYTES, sizeBytes));
  // Exactly the first IMAGE_HEAD_BYTES decide, however the body was chunked.
  const window = head.subarray(0, IMAGE_HEAD_BYTES);
  if (sniffImageType(window) !== type) {
    await reader.cancel();
    return { ok: false, reason: "type_not_as_stated" };
  }

  const size = readImageDimensions(type, window);
  const dimensions = size === null || size === "need_more" ? null : size;

  // R2 needs a body of known length. FixedLengthStream fails the put when the
  // head and the rest together are not exactly the declared size.
  const { readable, writable } = new FixedLengthStream(sizeBytes);
  const piped = replayed(head, reader).pipeTo(writable);
  // Awaited below once the put has succeeded; on a failed put nothing waits
  // for it any more, and its rejection must not go unhandled.
  piped.catch(() => undefined);

  try {
    await bucket.put(objectKey, readable, {
      httpMetadata: { cacheControl: PUBLIC_CACHE_CONTROL, contentType: type },
      sha256,
    });
  } catch {
    // Checksum mismatch, a body shorter or longer than declared, or a
    // transient R2 failure: R2 stored nothing.
    return { ok: false, reason: "bytes_not_as_declared" };
  }

  try {
    await piped;
  } catch {
    // Unreachable in practice (a stored put consumed the whole pipe), but a
    // body R2 kept without the pipe finishing is not one this route vouches for.
    await bucket.delete(objectKey);
    return { ok: false, reason: "bytes_not_as_declared" };
  }

  return { dimensions, ok: true };
}

/**
 * An SVG upload: small by its cap, so it is read whole and checked whole
 * (D92) before a byte is stored. Refused when it is not exactly the declared
 * size, the check refuses it or R2 refused the bytes; nothing is stored.
 */
async function storeProvenSvg(
  bucket: R2Bucket,
  objectKey: string,
  body: ReadableStream<Uint8Array>,
  sizeBytes: number,
  sha256: string,
): Promise<ProvenImage> {
  const reader = body.getReader();
  // One byte past the declared size is enough to see a body that is too long.
  const bytes = await readAtLeast(reader, sizeBytes + 1);
  await reader.cancel();
  if (bytes.byteLength !== sizeBytes) {
    return { ok: false, reason: "bytes_not_as_declared" };
  }

  const checked = checkSvg(bytes);
  if (!checked.ok) {
    return { ok: false, reason: `svg_${checked.reason}` };
  }

  try {
    await bucket.put(objectKey, bytes, {
      httpMetadata: {
        cacheControl: PUBLIC_CACHE_CONTROL,
        contentType: "image/svg+xml",
      },
      sha256,
    });
  } catch {
    return { ok: false, reason: "bytes_not_as_declared" };
  }

  return {
    dimensions:
      checked.width !== null && checked.height !== null
        ? { height: checked.height, width: checked.width }
        : null,
    ok: true,
  };
}

function tenantOf(principal: TenantAdminPrincipal): TenantContext {
  // The object store is keyed by tenant, and the principal has already been
  // proven to administer exactly this tenant.
  return {
    domainKind: "admin",
    hostname: "",
    tenantId: principal.tenantId,
  };
}

export async function reserveAdminObject(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: ReserveObjectRequest,
  now: number,
): Promise<ReserveRouteResult> {
  const reserved = await reservePendingObject(
    db,
    tenantOf(principal),
    {
      bucket: bucketForKind(input.kind),
      contentType: input.contentType,
      declaredSha256: input.sha256,
      declaredSizeBytes: input.sizeBytes,
      fileName: input.fileName,
      kind: input.kind,
    },
    now,
  );

  return reserved.status === "ok"
    ? {
        object: {
          objectId: reserved.object.objectId,
          objectKey: reserved.object.objectKey,
        },
        status: "ok",
      }
    : reserved;
}

/**
 * The public leg (D92). The type is proven from the bytes BEFORE the first
 * byte is stored: a raster's head is read and sniffed, an SVG is read whole
 * and checked whole. Only then do the bytes go to R2, stored with the proven
 * type, the immutable cache header and the declared hash as R2's checksum.
 * Anything refused stores nothing and leaves the row `pending`.
 */
async function uploadPublicObject(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  existing: StoredObject,
  request: Request,
  now: number,
): Promise<UploadRouteResult> {
  if (existing.status !== "pending") {
    // Already uploaded (or tombstoned): never touch R2 for a second attempt.
    return { status: "conflict" };
  }

  const declaredSha256 = existing.sha256;
  const declaredSizeBytes = existing.sizeBytes;
  if (declaredSha256 === null || declaredSizeBytes === null) {
    return { status: "not_found" };
  }

  // The stated type was admitted and canonicalised at reserve time; a row
  // outside the admission list is not an upload target of this surface.
  const type = normalizeImageType(existing.contentType);
  const cap = type === null ? null : publicImageCap(existing.kind, type);
  const bucket = env.PUBLIC_BUCKET;
  const base = publicObjectBase(env);
  if (type === null || cap === null || bucket === undefined || base === null) {
    return { status: "not_found" };
  }

  const length = checkContentLength(request, declaredSizeBytes, cap);
  if (length !== "ok") {
    return { status: length };
  }

  const body = request.body;
  if (body === null) {
    return { status: "invalid" };
  }

  const proven =
    type === "image/svg+xml"
      ? await storeProvenSvg(
          bucket,
          existing.objectKey,
          body,
          declaredSizeBytes,
          declaredSha256,
        )
      : await storeProvenRaster(
          bucket,
          existing.objectKey,
          body,
          type,
          declaredSizeBytes,
          declaredSha256,
        );
  if (!proven.ok) {
    return { reason: proven.reason, status: "invalid" };
  }

  const activated = await activateObject(
    db,
    tenant,
    existing.objectId,
    {
      dimensions: proven.dimensions,
      sha256: declaredSha256,
      sizeBytes: declaredSizeBytes,
    },
    now,
  );
  if (activated.status !== "ok") {
    // The row moved on while the bytes were in flight. When a removal
    // tombstoned it, bytes anyone can read must not outlive their row. When a
    // concurrent upload of the same row won, the bytes are that upload's (the
    // same declared hash) and stay.
    const current = await getUploadTargetObject(db, tenant, existing.objectId);
    if (current === null || current.status === "deleted") {
      await bucket.delete(existing.objectKey);
    }
    return activated;
  }

  return {
    object: toMetadata(activated.object, proven.dimensions, base),
    status: "ok",
  };
}

/**
 * Stream an upload through the worker into R2. The declared hash recorded at
 * reserve time is handed to R2 as the expected checksum, so R2 — not this
 * worker, and certainly not the client — is what proves the bytes match. A
 * mismatch makes the put throw and leaves the row `pending`. A public object
 * takes the public leg above, which proves the type first.
 */
export async function uploadAdminObject(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  objectId: string,
  request: Request,
  now: number,
): Promise<UploadRouteResult> {
  const tenant = tenantOf(principal);
  const existing = await getUploadTargetObject(db, tenant, objectId);

  if (existing !== null && existing.bucket === "public") {
    return uploadPublicObject(env, db, tenant, existing, request, now);
  }
  if (existing === null || existing.bucket !== "private") {
    return { status: "not_found" };
  }
  if (existing.status !== "pending") {
    // Already uploaded (or tombstoned): never touch R2 for a second attempt.
    return { status: "conflict" };
  }

  const declaredSha256 = existing.sha256;
  const declaredSizeBytes = existing.sizeBytes;
  if (declaredSha256 === null || declaredSizeBytes === null) {
    return { status: "not_found" };
  }

  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    return { status: "not_found" };
  }

  const length = checkContentLength(
    request,
    declaredSizeBytes,
    UPLOAD_SIZE_BYTES_MAX,
  );
  if (length !== "ok") {
    return { status: length };
  }

  const body = request.body;
  if (body === null) {
    return { status: "invalid" };
  }

  try {
    // Streamed straight through: the bytes are never buffered in the isolate.
    await bucket.put(existing.objectKey, body, {
      httpMetadata: { contentType: existing.contentType },
      sha256: declaredSha256,
    });
  } catch {
    // Checksum mismatch, truncated body, or a transient R2 failure. R2 stores
    // nothing on a failed checksum, and the row stays `pending` so the caller
    // can retry with the correct bytes.
    return { status: "invalid" };
  }

  const activated = await activateObject(
    db,
    tenant,
    objectId,
    { sha256: declaredSha256, sizeBytes: declaredSizeBytes },
    now,
  );

  return activated.status === "ok"
    ? { object: toMetadata(activated.object, null, null), status: "ok" }
    : activated;
}

async function readAdminObjectMetadata(
  db: D1Database,
  principal: TenantAdminPrincipal,
  objectId: string,
  base: string | null,
): Promise<ObjectMetadata | PublicObjectMetadata | null> {
  const found = await getAuthorizedObjectWithDimensions(
    db,
    tenantOf(principal),
    objectId,
  );

  return found === null
    ? null
    : toMetadata(found.object, found.dimensions, base);
}

/**
 * An object's metadata; a public object's carries its address and its size.
 * The address is null while the public address is not configured.
 */
export async function getAdminObjectMetadataWithUrl(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  objectId: string,
): Promise<ObjectMetadata | PublicObjectMetadata | null> {
  return readAdminObjectMetadata(
    db,
    principal,
    objectId,
    publicObjectBase(env),
  );
}

/**
 * The bytes of a private object. A public object is read at its address and
 * never proxied here: deliverPrivateObject refuses every row that is not in
 * the private bucket, so the route answers its opaque 404.
 */
export async function deliverAdminObject(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  objectId: string,
): Promise<Response | null> {
  const delivered = await deliverPrivateObject(
    env,
    db,
    tenantOf(principal),
    objectId,
  );

  if (delivered === null) {
    return null;
  }

  return new Response(delivered.body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": delivered.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Tombstone the row first, then drop the bytes from the bucket the row names
 * (D93). That order is deliberate: once the row is `deleted` nothing can be
 * delivered and no public shape resolves it, so a failed R2 delete leaves
 * garbage for the sweep rather than a live object with no record of it. (A
 * public object's bytes stay readable at their address until then; nothing
 * links to it any more.) Removing a public image that a product, a collection
 * or the branding still names is allowed: they show no image from then on.
 */
export async function deleteAdminObject(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  objectId: string,
  now: number,
): Promise<DeleteRouteResult> {
  const tenant = tenantOf(principal);
  const existing = await getUploadTargetObject(db, tenant, objectId);
  if (existing === null) {
    return { status: "not_found" };
  }

  const deleted = await deletePendingOrMutableObject(
    db,
    tenant,
    objectId,
    now,
  );
  if (deleted.status !== "ok") {
    return deleted.status === "conflict"
      ? { status: "conflict" }
      : { status: "not_found" };
  }

  const bucket = bucketBinding(env, existing.bucket);
  if (bucket !== undefined && existing.status === "active") {
    await bucket.delete(existing.objectKey);
  }

  return { status: "ok" };
}
