import type { TenantContext } from "../tenancy/resolve-tenant";

export type ObjectBucket = "private" | "public" | "temp";

export type ObjectKind =
  | "artwork_original"
  | "document"
  | "export"
  | "preview_image"
  | "print_file"
  | "product_media"
  | "shop_branding"
  | "temp_upload";

export type ObjectStatus = "active" | "deleted" | "pending";

export interface StoredObject {
  bucket: ObjectBucket;
  contentType: string;
  immutable: boolean;
  kind: ObjectKind;
  objectId: string;
  objectKey: string;
  sha256: string | null;
  sizeBytes: number | null;
  status: ObjectStatus;
}

export interface ReservedObject {
  bucket: ObjectBucket;
  objectId: string;
  objectKey: string;
}

export type ReserveObjectResult =
  | { object: ReservedObject; status: "ok" }
  | { status: "conflict" | "invalid" };

export type ObjectMutationResult =
  | { object: StoredObject; status: "ok" }
  | { status: "conflict" | "invalid" | "not_found" };

export interface ReserveObjectInput {
  bucket: ObjectBucket;
  contentType: string;
  // Hash and size the client claims the bytes will have. Recorded on the
  // pending row so the upload leg can hand them to R2, which is what actually
  // makes them trustworthy; until then they are an unverified claim.
  declaredSha256?: string;
  declaredSizeBytes?: number;
  fileName?: string;
  kind: ObjectKind;
}

export interface ActivateObjectInput {
  sha256: string;
  sizeBytes: number;
}

export interface DeliveredObject {
  body: ReadableStream;
  contentType: string;
}

interface StoredObjectRow {
  bucket: ObjectBucket;
  content_type: string;
  immutable: number;
  kind: ObjectKind;
  object_id: string;
  object_key: string;
  sha256: string | null;
  size_bytes: number | null;
  status: ObjectStatus;
}

// Which bucket each kind is allowed to live in. `temp` is reserved for staging
// uploads, `public` only for objects that are safe to serve without a session,
// and everything else must stay private.
const ALLOWED_BUCKETS: Record<ObjectKind, ObjectBucket> = {
  artwork_original: "private",
  document: "private",
  export: "private",
  preview_image: "public",
  print_file: "private",
  product_media: "public",
  shop_branding: "public",
  temp_upload: "temp",
};

const FILE_NAME_MAX_LENGTH = 100;
const FILE_NAME_FALLBACK = "object";
const CONTENT_TYPE_MAX_LENGTH = 255;
// RFC 7230 token charset for `type/subtype`, without parameters. Rejects
// whitespace and control characters so a stored content type can never smuggle
// header content, while still accepting hyphenated types such as
// `application/octet-stream`.
const CONTENT_TYPE_PATTERN =
  /^[!#$%&'*+.^_`|~0-9a-zA-Z-]+\/[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIZE_BYTES_MAX = 5_000_000_000;
const OBJECT_SELECT = `SELECT
     object_id, tenant_id, bucket, object_key, kind, content_type,
     size_bytes, sha256, status, immutable
   FROM stored_objects
   WHERE tenant_id = ?
     AND object_id = ?
   LIMIT 1`;

/**
 * Reduce a caller-supplied file name to a key-safe suffix. The result is only
 * cosmetic: it never participates in authorization.
 */
function safeFileName(fileName: string | undefined): string {
  if (fileName === undefined) {
    return FILE_NAME_FALLBACK;
  }

  const cleaned = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^\.+/, "")
    .slice(0, FILE_NAME_MAX_LENGTH);

  return cleaned.length > 0 ? cleaned : FILE_NAME_FALLBACK;
}

function isBucketAllowed(kind: ObjectKind, bucket: ObjectBucket): boolean {
  return ALLOWED_BUCKETS[kind] === bucket;
}

function isValidContentType(contentType: string): boolean {
  return (
    contentType.length <= CONTENT_TYPE_MAX_LENGTH &&
    CONTENT_TYPE_PATTERN.test(contentType)
  );
}

function toStoredObject(row: StoredObjectRow): StoredObject {
  return {
    bucket: row.bucket,
    contentType: row.content_type,
    immutable: row.immutable === 1,
    kind: row.kind,
    objectId: row.object_id,
    objectKey: row.object_key,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    status: row.status,
  };
}

function isUniqueConstraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

function auditStatement(
  db: D1Database,
  tenant: TenantContext,
  action: string,
  objectId: string,
  now: number,
  metadata: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        event_id, tenant_id, actor_user_id, action, resource_type,
        resource_id, request_id, metadata_json, created_at
      ) VALUES (?, ?, NULL, ?, 'stored_object', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      tenant.tenantId,
      action,
      objectId,
      crypto.randomUUID(),
      metadata === null ? null : JSON.stringify(metadata),
      now,
    );
}

async function loadObject(
  db: D1Database,
  tenantId: string,
  objectId: string,
): Promise<StoredObjectRow | null> {
  return db
    .prepare(OBJECT_SELECT)
    .bind(tenantId, objectId)
    .first<StoredObjectRow>();
}

/**
 * Reserve a versioned key and record a `pending` row before the bytes exist.
 * The key encodes ownership for operability only; the row is the authority.
 */
export async function reservePendingObject(
  db: D1Database,
  tenant: TenantContext,
  input: ReserveObjectInput,
  now: number,
): Promise<ReserveObjectResult> {
  const declaredSha256 = input.declaredSha256 ?? null;
  const declaredSizeBytes = input.declaredSizeBytes ?? null;

  if (
    !isBucketAllowed(input.kind, input.bucket) ||
    !isValidContentType(input.contentType) ||
    (declaredSha256 !== null && !SHA256_PATTERN.test(declaredSha256)) ||
    (declaredSizeBytes !== null &&
      (!Number.isSafeInteger(declaredSizeBytes) ||
        declaredSizeBytes < 0 ||
        declaredSizeBytes > SIZE_BYTES_MAX))
  ) {
    return { status: "invalid" };
  }

  const objectId = crypto.randomUUID();
  const objectKey = `shops/${tenant.tenantId}/${input.kind}/${objectId}/v1/${safeFileName(input.fileName)}`;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO stored_objects (
            object_id, tenant_id, bucket, object_key, kind, content_type,
            size_bytes, sha256, status, immutable, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .bind(
          objectId,
          tenant.tenantId,
          input.bucket,
          objectKey,
          input.kind,
          input.contentType,
          declaredSizeBytes,
          declaredSha256,
          now,
          now,
        ),
      auditStatement(db, tenant, "object.reserve", objectId, now, {
        kind: input.kind,
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraintFailure(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    object: { bucket: input.bucket, objectId, objectKey },
    status: "ok",
  };
}

/**
 * Finalize an upload: `pending` -> `active`, recording the observed size and
 * content hash. Anything already active or deleted is a conflict.
 */
export async function activateObject(
  db: D1Database,
  tenant: TenantContext,
  objectId: string,
  input: ActivateObjectInput,
  now: number,
): Promise<ObjectMutationResult> {
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 0 ||
    input.sizeBytes > SIZE_BYTES_MAX ||
    !SHA256_PATTERN.test(input.sha256)
  ) {
    return { status: "invalid" };
  }

  const existing = await loadObject(db, tenant.tenantId, objectId);
  if (existing === null) {
    return { status: "not_found" };
  }
  if (existing.status !== "pending") {
    return { status: "conflict" };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE stored_objects
         SET status = 'active', size_bytes = ?, sha256 = ?, updated_at = ?
         WHERE tenant_id = ?
           AND object_id = ?
           AND status = 'pending'`,
      )
      .bind(input.sizeBytes, input.sha256, now, tenant.tenantId, objectId),
    auditStatement(db, tenant, "object.activate", objectId, now, {
      kind: existing.kind,
    }),
  ]);

  return {
    object: toStoredObject({
      ...existing,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      status: "active",
    }),
    status: "ok",
  };
}

/**
 * Freeze an active object because paid or production state now references it.
 * Idempotent: freezing an already-frozen object is a no-op success.
 */
export async function markObjectImmutable(
  db: D1Database,
  tenant: TenantContext,
  objectId: string,
  now: number,
): Promise<ObjectMutationResult> {
  const existing = await loadObject(db, tenant.tenantId, objectId);
  if (existing === null) {
    return { status: "not_found" };
  }
  if (existing.status !== "active") {
    return { status: "conflict" };
  }
  if (existing.immutable === 1) {
    return { object: toStoredObject(existing), status: "ok" };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE stored_objects
         SET immutable = 1, updated_at = ?
         WHERE tenant_id = ?
           AND object_id = ?
           AND status = 'active'`,
      )
      .bind(now, tenant.tenantId, objectId),
    auditStatement(db, tenant, "object.freeze", objectId, now, {
      kind: existing.kind,
    }),
  ]);

  return {
    object: toStoredObject({ ...existing, immutable: 1 }),
    status: "ok",
  };
}

/**
 * The single authorization gate for object access. Callers must never derive
 * permission from an object key; only an active row owned by this tenant
 * grants access.
 */
export async function getAuthorizedObject(
  db: D1Database,
  tenant: TenantContext,
  objectId: string,
): Promise<StoredObject | null> {
  const row = await loadObject(db, tenant.tenantId, objectId);

  return row === null || row.status !== "active" ? null : toStoredObject(row);
}

/**
 * Load a row for an upload leg, which must see `pending` rows that
 * `getAuthorizedObject` deliberately hides. This grants no access to bytes: the
 * caller still has to enforce status and bucket before touching R2.
 */
export async function getUploadTargetObject(
  db: D1Database,
  tenant: TenantContext,
  objectId: string,
): Promise<StoredObject | null> {
  const row = await loadObject(db, tenant.tenantId, objectId);

  return row === null ? null : toStoredObject(row);
}

/**
 * Soft-delete an object that no paid or production state depends on. Frozen
 * objects can never be tombstoned.
 */
export async function deletePendingOrMutableObject(
  db: D1Database,
  tenant: TenantContext,
  objectId: string,
  now: number,
): Promise<ObjectMutationResult> {
  const existing = await loadObject(db, tenant.tenantId, objectId);
  if (existing === null) {
    return { status: "not_found" };
  }
  if (existing.immutable === 1 || existing.status === "deleted") {
    return { status: "conflict" };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE stored_objects
         SET status = 'deleted', updated_at = ?
         WHERE tenant_id = ?
           AND object_id = ?
           AND immutable = 0`,
      )
      .bind(now, tenant.tenantId, objectId),
    auditStatement(db, tenant, "object.delete", objectId, now, {
      kind: existing.kind,
    }),
  ]);

  return {
    object: toStoredObject({ ...existing, status: "deleted" }),
    status: "ok",
  };
}

/**
 * Proxy a private object after D1 validation. Fails closed when the row is not
 * deliverable, when the row is not private, or when the bucket binding is
 * absent (it stays absent until the buckets are provisioned).
 */
export async function deliverPrivateObject(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
  objectId: string,
): Promise<DeliveredObject | null> {
  const authorized = await getAuthorizedObject(db, tenant, objectId);
  if (authorized === null || authorized.bucket !== "private") {
    return null;
  }

  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    return null;
  }

  const object = await bucket.get(authorized.objectKey);
  if (object === null) {
    return null;
  }

  return { body: object.body, contentType: authorized.contentType };
}
