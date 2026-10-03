import { isAuthConfigured } from "../auth/create-auth";
import { PUBLIC_ELIGIBILITY_PREDICATE } from "../catalog/eligibility";
import { jsonResponse } from "../lib/http";
import type { TenantContext } from "../tenancy/resolve-tenant";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP4-D2 — the preview of an unpublished shop (D57, D's second pass).
 *
 * ── THE GRANT ───────────────────────────────────────────────────────────────
 * `POST /v1/admin/preview` (src/routes/admin-preview.ts) mints, for the shop's
 * own admin, a grant bound to that shop and valid 30 minutes:
 *
 *   v1.<expiresAtMs>.<signature>
 *
 *   signature = base64url(HMAC-SHA-256(key, "storefront-preview/v1\n<tenantId>\n<expiresAtMs>"))
 *
 * The tenant is IN the signed message and NOT in the token: the grant is
 * checked against the tenant the request's hostname names, so a grant of
 * shop A on shop B's host is simply a wrong signature. Stateless: no table,
 * no migration; it cannot be revoked before it expires (30 minutes is the
 * whole exposure, and it shows nothing a buyer could not see once the shop is
 * published).
 *
 * ── THE KEY ─────────────────────────────────────────────────────────────────
 * No new secret. The key is DERIVED from the Worker secret that already
 * exists wherever an admin can sign in, BETTER_AUTH_SECRET, by HKDF-SHA-256
 * with a salt and info of this purpose alone, so the bytes that sign a
 * preview grant are never the bytes Better Auth signs its cookies with, and a
 * grant can never be read as anything of Better Auth's (or the reverse).
 * Without a configured secret (isAuthConfigured) nothing is minted and every
 * grant is ignored. Rotating the secret ends every grant.
 *
 * ── THE READS ───────────────────────────────────────────────────────────────
 * The storefront sends the grant in `X-Storefront-Preview` on its reads. A
 * public read resolves its tenant through `resolveStorefrontTenant`: the
 * hostname's tenant as always, marked `preview: true` only when the header
 * holds a grant valid FOR THAT TENANT and unexpired. Every other header — no
 * header, a malformed, expired, foreign or forged grant — leaves the tenant
 * unmarked, and the read answers exactly what it answers without one (an
 * opaque 404 for an unpublished shop). A marked read evaluates THE predicate
 * without its `tenant.published = 1` term (below) and the shop gate without
 * `published = 1` (public-shop.ts); `tenant.status = 'active'` and every
 * product-level term stay. Its answer is `Cache-Control: no-store`, no ETag,
 * `X-Robots-Tag: noindex`.
 *
 * Checkout, payment, the receipt, the order, the withdrawal and the report
 * never call `resolveStorefrontTenant` and keep THE predicate itself: a
 * preview never sells (test/storefront-preview.test.ts proves each refusal).
 */

/** The request header the storefront sends the grant in (lower case, as Headers reads it). */
export const PREVIEW_HEADER = "x-storefront-preview";

export const PREVIEW_GRANT_TTL_MS = 30 * 60 * 1_000;

const GRANT_VERSION = "v1";
// v1.<13-digit milliseconds>.<43 base64url characters: 32 bytes, unpadded>
const GRANT_PATTERN = /^v1\.([1-9][0-9]{12})\.([A-Za-z0-9_-]{43})$/;
const HKDF_SALT = "chopshop/storefront-preview";
const HKDF_INFO = "storefront-preview-grant/v1";

/**
 * A storefront read's tenant: the hostname's, and `preview` when the request
 * holds a valid grant for it. A plain TenantContext is an unmarked one, so
 * every caller that never asks for a preview (checkout, the sitemap, the
 * admin) passes its context unchanged and reads as public.
 */
export interface StorefrontTenant extends TenantContext {
  readonly preview?: true;
}

export function isPreview(tenant: StorefrontTenant): boolean {
  return tenant.preview === true;
}

// ── the predicate of a preview: THE predicate minus ONE term ────────────────

const PUBLISHED_TERM = /\n[ \t]*AND tenant\.published = 1[ \t]*(?=\n)/g;

/**
 * `predicate` without its `AND tenant.published = 1` line, and nothing else
 * changed. Throws when the predicate no longer has that term exactly once on
 * a line of its own, names `tenant.published` anywhere else, or would lose
 * `tenant.status = 'active'`: eligibility.ts changed shape, and the preview
 * must be re-read rather than guessed (the spirit of verify-catalogue.mjs
 * `liftedShopGate`). Evaluated at module load, so such a change fails every
 * suite and the Worker's start, never silently.
 */
export function withoutPublishedTerm(predicate: string): string {
  const terms = predicate.match(PUBLISHED_TERM) ?? [];
  if (terms.length !== 1 || predicate.split("tenant.published").length !== 2) {
    throw new Error(
      "eligibility.ts changed its shop terms: the preview cannot lift `tenant.published = 1`; re-read it",
    );
  }
  const lifted = predicate.replace(PUBLISHED_TERM, "");
  if (!lifted.includes("tenant.status = 'active'")) {
    throw new Error("eligibility.ts lost `tenant.status = 'active'`: the preview cannot be derived; re-read it");
  }
  return lifted;
}

/** THE predicate with the shop's `published` term lifted. The only place it is made. */
export const PREVIEW_ELIGIBILITY_PREDICATE = withoutPublishedTerm(PUBLIC_ELIGIBILITY_PREDICATE);

/** The fragment a storefront read of `tenant` uses: THE predicate, or the preview's. */
export function eligibilityPredicate(tenant: StorefrontTenant): string {
  return isPreview(tenant) ? PREVIEW_ELIGIBILITY_PREDICATE : PUBLIC_ELIGIBILITY_PREDICATE;
}

// ── the grant ───────────────────────────────────────────────────────────────

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function grantKey(env: Env): Promise<CryptoKey | null> {
  if (!isAuthConfigured(env)) {
    return null;
  }
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET as string),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: encoder.encode(HKDF_INFO),
      name: "HKDF",
      salt: encoder.encode(HKDF_SALT),
    },
    material,
    { hash: "SHA-256", length: 256, name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

function signedMessage(tenantId: string, expiresAt: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`storefront-preview/${GRANT_VERSION}\n${tenantId}\n${expiresAt}`);
}

export interface PreviewGrant {
  expiresAt: number;
  grant: string;
}

/** A grant for `tenantId`, valid until now + 30 minutes; null when no secret is configured. */
export async function mintPreviewGrant(
  env: Env,
  tenantId: string,
  now: number,
): Promise<PreviewGrant | null> {
  const key = await grantKey(env);
  if (key === null) {
    return null;
  }
  const expiresAt = now + PREVIEW_GRANT_TTL_MS;
  const signature = await crypto.subtle.sign("HMAC", key, signedMessage(tenantId, expiresAt));
  return { expiresAt, grant: `${GRANT_VERSION}.${expiresAt}.${toBase64Url(signature)}` };
}

/**
 * Whether `grant` is one this Worker minted for `tenantId` that has not
 * expired at `now`. A grant whose expiry lies further ahead than one lifetime
 * is refused as well (a grant this code never minted). The signature is
 * compared by `crypto.subtle.verify`, in constant time.
 */
export async function verifyPreviewGrant(
  env: Env,
  tenantId: string,
  grant: string | null,
  now: number,
): Promise<boolean> {
  if (grant === null) {
    return false;
  }
  const match = GRANT_PATTERN.exec(grant);
  if (match === null) {
    return false;
  }
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + PREVIEW_GRANT_TTL_MS) {
    return false;
  }
  const signature = fromBase64Url(match[2] as string);
  const key = await grantKey(env);
  if (signature === null || signature.length !== 32 || key === null) {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, signature, signedMessage(tenantId, expiresAt));
}

/**
 * THE tenant of a public storefront read: `resolveRequestTenant` (the
 * hostname, an active shop), marked `preview` when the request's
 * `X-Storefront-Preview` holds a valid grant for that tenant. An invalid
 * grant is ignored, never refused: the read then answers as it would without
 * one, so a grant cannot be used to learn whether a shop exists.
 */
export async function resolveStorefrontTenant(
  env: Env,
  request: Request,
  now: number = Date.now(),
): Promise<StorefrontTenant | null> {
  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return null;
  }
  const grant = request.headers.get(PREVIEW_HEADER);
  return grant !== null && (await verifyPreviewGrant(env, tenant.tenantId, grant, now))
    ? { ...tenant, preview: true }
    : tenant;
}

// ── the answer of a preview ─────────────────────────────────────────────────

/** The headers every preview answer carries: never stored, never indexed. */
export const PREVIEW_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
} as const;

/** A preview's 200: the body, `no-store`, no ETag, `noindex`; If-None-Match is never answered. */
export function previewJsonResponse(body: unknown): Response {
  const response = jsonResponse(body);
  response.headers.set("X-Robots-Tag", PREVIEW_RESPONSE_HEADERS["X-Robots-Tag"]);
  return response;
}
