import type { TenantAdminPrincipal } from "../auth/live-authorization";
import type { PublicImage } from "../storage/public-objects";
import { getReferencablePublicImage } from "../storage/public-objects";
import {
  auditStatement,
  hasOnlyKeys,
  isPlainObject,
  parseOptionalText,
} from "./admin-catalog";
import type { AdminProductImage, ImageRow } from "./admin-product-reads";
import {
  isProductLive,
  loadProductRow,
  loadProductScreeningInput,
  MAX_PRODUCT_IMAGES,
  placeholders,
  toAdminImages,
} from "./admin-product-reads";
import {
  isScreeningConflict,
  readScreeningGuard,
  screeningFenceStatement,
  screeningStatementsFor,
  withScreeningRetry,
} from "./screening";
import type { ProductScreeningInput } from "./screening-core";

/**
 * CP4-A — a product's images: `PUT /v1/admin/products/:productId/images`
 * replaces the WHOLE ordered list, `[{ objectId, alt?, variantId? }]`, at
 * most 30 rows (the first is the main image; `[]` clears the list).
 *
 * Every `objectId` goes through getReferencablePublicImage(…, ["product_media"])
 * (src/storage/public-objects.ts, D92): an object that is not this shop's
 * active product media in the public bucket is refused with 400 and nothing is
 * written — another shop's object, a private one, a branding image, a pending
 * upload, a removed one. The 0040 triggers refuse the same at the row, for any
 * writer. A `variantId` must name a variant of this product.
 *
 * Rows hold the object's ID; the address is made at read time. The alt texts
 * are text a visitor reads, so a list written to a live product re-screens it
 * in the same batch (THE FENCE, as every product write); a list written to a
 * product that is not live carries the fence.
 */

export interface ProductImageInput {
  alt: string | null;
  objectId: string;
  variantId: string | null;
}

export type ImagesWriteResult =
  | { images: AdminProductImage[]; status: "ok" }
  | { reason: "image_not_referencable" | "variant_not_found"; status: "invalid" }
  | { status: "conflict" | "not_found" };

const ITEM_KEYS = ["alt", "objectId", "variantId"] as const;
const ID_MAX_LENGTH = 128;
const ALT_MAX_LENGTH = 500;

function parseId(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= ID_MAX_LENGTH
    ? value
    : null;
}

/**
 * The whole list, or null (400): at most 30 rows, only the three keys, and
 * no object twice for one owner (the product, or one variant) — sent twice,
 * the list is refused, never collapsed.
 */
export function parseProductImagesInput(body: unknown): ProductImageInput[] | null {
  if (!Array.isArray(body) || body.length > MAX_PRODUCT_IMAGES) {
    return null;
  }
  const images: ProductImageInput[] = [];
  const seen = new Set<string>();
  for (const entry of body) {
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ITEM_KEYS)) {
      return null;
    }
    const objectId = parseId(entry.objectId);
    const alt = entry.alt === undefined ? null : parseOptionalText(entry.alt, ALT_MAX_LENGTH);
    const variantId =
      entry.variantId === undefined || entry.variantId === null ? null : parseId(entry.variantId);
    if (
      objectId === null ||
      alt === undefined ||
      (entry.variantId !== undefined && entry.variantId !== null && variantId === null)
    ) {
      return null;
    }
    const owner = JSON.stringify([variantId, objectId]);
    if (seen.has(owner)) {
      return null;
    }
    seen.add(owner);
    images.push({ alt, objectId, variantId });
  }
  return images;
}

function invalidReason(error: unknown): "image_not_referencable" | "variant_not_found" | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("image object must be")) {
    return "image_not_referencable";
  }
  if (message.includes("image variant must belong")) {
    return "variant_not_found";
  }
  return null;
}

export async function replaceProductImages(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  input: readonly ProductImageInput[],
  now: number,
): Promise<ImagesWriteResult> {
  return withScreeningRetry<ImagesWriteResult>(
    now,
    (attemptNow) => replaceProductImagesOnce(env, db, principal, productId, input, attemptNow),
    () => ({ status: "conflict" }),
  );
}

async function replaceProductImagesOnce(
  env: Env,
  db: D1Database,
  principal: TenantAdminPrincipal,
  productId: string,
  input: readonly ProductImageInput[],
  now: number,
): Promise<ImagesWriteResult> {
  const { tenantId } = principal;
  // FIRST, before any content read (THE FENCE).
  const guard = await readScreeningGuard(db, tenantId, productId);
  const product = await loadProductRow(db, tenantId, productId);
  if (product === null) {
    return { status: "not_found" };
  }

  const variantIds = [
    ...new Set(input.map((image) => image.variantId).filter((id): id is string => id !== null)),
  ];
  if (variantIds.length > 0) {
    const found = await db
      .prepare(
        `SELECT variant_id FROM product_variants
         WHERE tenant_id = ? AND product_id = ?
           AND variant_id IN (${placeholders(variantIds.length)})`,
      )
      .bind(tenantId, productId, ...variantIds)
      .all<{ variant_id: string }>();
    if (found.results.length !== variantIds.length) {
      return { reason: "variant_not_found", status: "invalid" };
    }
  }

  const resolved = new Map<string, PublicImage>();
  for (const objectId of new Set(input.map((image) => image.objectId))) {
    const image = await getReferencablePublicImage(env, db, tenantId, objectId, ["product_media"]);
    if (image === null) {
      return { reason: "image_not_referencable", status: "invalid" };
    }
    resolved.set(objectId, image);
  }

  const createdAt = new Date(now).toISOString();
  const statements: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM product_images WHERE tenant_id = ? AND product_id = ?")
      .bind(tenantId, productId),
    ...input.map((image, position) =>
      db
        .prepare(
          `INSERT INTO product_images (
             tenant_id, product_id, position, variant_id, object_id, alt, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(tenantId, productId, position, image.variantId, image.objectId, image.alt, createdAt),
    ),
    // Every writer of screened content moves updated_at strictly forward: a
    // concurrent FIRST publish of this product fences on it.
    db
      .prepare(
        `UPDATE products SET updated_at = max(?, updated_at + 1)
         WHERE tenant_id = ? AND product_id = ?`,
      )
      .bind(now, tenantId, productId),
  ];

  if (await isProductLive(db, tenantId, product)) {
    const stored = await loadProductScreeningInput(db, tenantId, productId);
    // Every text a visitor reads after this write: what D1 holds, with the
    // alt texts of the list this batch writes.
    const texts: ProductScreeningInput = {
      ...(stored ?? { description: product.description, name: product.name }),
      imageAlts: input.map((image) => image.alt).filter((alt): alt is string => alt !== null),
    };
    const screening = await screeningStatementsFor(db, { guard, now, texts });
    statements.push(...screening.statements);
  } else {
    statements.push(screeningFenceStatement(db, guard, now));
  }

  statements.push(
    auditStatement(db, principal, "product.images_replace", productId, now, {
      images: input.map((image) => ({ objectId: image.objectId, variantId: image.variantId })),
    }),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    // An object removed, or a variant deleted, between the checks above and
    // this batch: the 0040 triggers refused the row and nothing was written.
    const reason = isScreeningConflict(error) ? null : invalidReason(error);
    if (reason !== null) {
      return { reason, status: "invalid" };
    }
    throw error;
  }

  const rows: ImageRow[] = input.map((image, position) => ({
    alt: image.alt,
    object_id: image.objectId,
    position,
    product_id: productId,
    variant_active: null,
    variant_group: null,
    variant_id: image.variantId,
  }));
  return { images: toAdminImages(rows, resolved), status: "ok" };
}
