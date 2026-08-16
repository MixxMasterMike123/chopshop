import type { ObjectKind, StoredObject } from "./object-store";
import {
  activateObject,
  deletePendingOrMutableObject,
  deliverPrivateObject,
  getAuthorizedObject,
  getUploadTargetObject,
  reservePendingObject,
} from "./object-store";
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

export type ReserveRouteResult =
  | { object: { objectId: string; objectKey: string }; status: "ok" }
  | { status: "conflict" | "invalid" };

export type UploadRouteResult =
  | { object: ObjectMetadata; status: "ok" }
  | { status: "conflict" | "invalid" | "not_found" | "too_large" };

export type DeleteRouteResult = { status: "conflict" | "not_found" | "ok" };

const RESERVE_KEYS = [
  "contentType",
  "fileName",
  "kind",
  "sha256",
  "sizeBytes",
] as const;
// Only private kinds are reservable through this surface. Public and temp
// objects need their own bindings and delivery model, so admitting them here
// would mint rows that no route can ever fulfil.
const PRIVATE_KINDS: ObjectKind[] = [
  "artwork_original",
  "document",
  "export",
  "print_file",
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_NAME_MAX_LENGTH = 200;
const CONTENT_TYPE_MAX_LENGTH = 255;
// Upload cap for the worker-proxied path. Bytes stream through the isolate, so
// this stays far below the object store's own ceiling.
export const UPLOAD_SIZE_BYTES_MAX = 100_000_000;

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
  return typeof value === "string" && (PRIVATE_KINDS as string[]).includes(value)
    ? (value as ObjectKind)
    : null;
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
  const contentType = parseContentType(body.contentType);
  const sha256 = parseSha256(body.sha256);
  const sizeBytes = parseSizeBytes(body.sizeBytes);

  if (
    kind === null ||
    contentType === null ||
    sha256 === null ||
    sizeBytes === null
  ) {
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

function toMetadata(object: StoredObject): ObjectMetadata {
  // The object key is deliberately absent: it is internal addressing, and no
  // caller should ever be able to derive access from it.
  return {
    contentType: object.contentType,
    immutable: object.immutable,
    kind: object.kind,
    objectId: object.objectId,
    sha256: object.sha256,
    sizeBytes: object.sizeBytes,
    status: object.status,
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
      bucket: "private",
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
 * Stream an upload through the worker into R2. The declared hash recorded at
 * reserve time is handed to R2 as the expected checksum, so R2 — not this
 * worker, and certainly not the client — is what proves the bytes match. A
 * mismatch makes the put throw and leaves the row `pending`.
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

  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^[0-9]{1,15}$/.test(contentLength)) {
    return { status: "invalid" };
  }

  const declaredLength = Number(contentLength);
  if (declaredLength > UPLOAD_SIZE_BYTES_MAX) {
    return { status: "too_large" };
  }
  if (declaredLength !== declaredSizeBytes) {
    return { status: "invalid" };
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
    ? { object: toMetadata(activated.object), status: "ok" }
    : activated;
}

export async function getAdminObjectMetadata(
  db: D1Database,
  principal: TenantAdminPrincipal,
  objectId: string,
): Promise<ObjectMetadata | null> {
  const object = await getAuthorizedObject(db, tenantOf(principal), objectId);

  return object === null ? null : toMetadata(object);
}

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
 * Tombstone the row first, then drop the bytes. That order is deliberate: once
 * the row is `deleted` nothing can be delivered, so a failed R2 delete leaves
 * unreachable garbage rather than a live object with no record of it.
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

  const bucket = env.PRIVATE_BUCKET;
  if (bucket !== undefined && existing.status === "active") {
    await bucket.delete(existing.objectKey);
  }

  return { status: "ok" };
}
