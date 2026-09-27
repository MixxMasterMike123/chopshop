import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import type { AdminCatalogResult } from "./catalog/admin-catalog";
import {
  createAdminProduct,
  parseCreateProductInput,
  parseUpdateProductInput,
  publishAdminProduct,
  unpublishAdminProduct,
  updateAdminProduct,
} from "./catalog/admin-catalog";
import type {
  DomainResult,
  MembershipResult,
  TenantResult,
} from "./platform/provision-tenants";
import {
  addTenantDomain,
  createTenant,
  grantTenantAdmin,
  parseAddDomainInput,
  parseCreateTenantInput,
  parseGrantAdminInput,
  parseTenantIdPathSegment,
  setTenantStatus,
} from "./platform/provision-tenants";
import {
  getPublicProduct,
  listPublicProducts,
} from "./catalog/public-catalog";
import {
  createCheckout,
  parseCreateCheckoutInput,
} from "./commerce/checkout";
import { createCheckoutPayment } from "./commerce/payment";
import { handleStripeWebhookEvent } from "./commerce/webhook";
import {
  isStripeConfigured,
  isStripeWebhookConfigured,
  resolveStripeGateway,
  resolveStripeWebhookVerifier,
  StripeSignatureError,
} from "./commerce/stripe-client";
import type { AdminDiscountCodeResult } from "./commerce/admin-discount-codes";
import {
  createAdminDiscountCode,
  getAdminDiscountCode,
  parseCreateDiscountCodeInput,
  parseUpdateDiscountCodeInput,
  updateAdminDiscountCode,
} from "./commerce/admin-discount-codes";
import {
  deleteAdminObject,
  deliverAdminObject,
  getAdminObjectMetadata,
  parseReserveObjectInput,
  reserveAdminObject,
  uploadAdminObject,
} from "./storage/object-routes";
import {
  bootstrapPlatformAdmin,
  isBootstrapAllowed,
  parseBootstrapInput,
} from "./platform/bootstrap";
import {
  createPlatformUser,
  parseCreateUserInput,
} from "./platform/provision-users";
import {
  createArtwork,
  deleteArtwork,
  enqueueArtwork,
  getArtwork,
  getPreviewKey,
  listArtwork,
  SYNC_RENDER_FALLBACK,
} from "./pod/artwork-store";
import { parseCreateArtworkInput } from "./pod/artwork-routes";
import {
  listActiveProfiles,
  parseReplaceProfilesInput,
  replaceProfiles,
} from "./pod/pod-profiles";
import {
  isPodConfigured,
  isR2PresignerConfigured,
  resolveR2Presigner,
  resolveRenderFarmClient,
} from "./pod/render-farm-client";
import { jsonResponse } from "./lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  notFoundResponse,
  rateLimitedResponse,
  readJsonBody,
} from "./lib/responses";
import { clientIp, enforceRateLimit } from "./lib/rate-limit";
import {
  authorizePlatformRequest,
  authorizeTenantAdminRequest,
} from "./auth/request-authorization";
import { handleAuthRoute } from "./auth/auth-routes";
import { dispatchTargetOf } from "./pod/printers";
import { getPublicStorefront } from "./storefront/public-storefront";
import {
  handlePublicProductRequest,
  handlePublicProductsRequest,
  handlePublicStorefrontRequest,
} from "./storefront/public-routes";
import { isSameOriginRequest } from "./lib/same-origin";
import { resolveRequestTenant } from "./tenancy/resolve-tenant";
import { hasTenantHeader } from "./lib/tenant-headers";
import { ACTING_AS_ROUTE, handleActingAsRoute } from "./routes/acting-as";
import {
  BUYER_ORDER_ROUTE,
  handleBuyerOrderRoute,
  handleReceiptClaimRoute,
  RECEIPT_CLAIM_ROUTE,
} from "./routes/receipts";
import {
  handleRenderJobsRoute,
  RENDER_API_PATH_PREFIX,
} from "./routes/render-jobs";
import { isRenderJobsConfigured } from "./pod/render-jobs";
import { handleFakePrinterRoute } from "./routes/fake-printer";
import {
  ADMIN_ORDER_REFUNDS_ROUTE,
  ADMIN_ORDER_ROUTE,
  handleAdminOrderRefundsRoute,
  handleAdminOrderRoute,
} from "./routes/money-orders";
import { FAKE_PRINTER_JOBS_PATH } from "./dispatch/fake-printer";
// CP2-B (outbox/dispatch) route handlers.
import {
  ADMIN_ORDER_CANCEL_ROUTE,
  handleAdminOrderCancelRoute,
} from "./routes/dispatch-admin";
import {
  handlePlatformDispatchListRoute,
  handlePlatformDispatchResolveRoute,
  PLATFORM_DISPATCH_PATH,
  PLATFORM_DISPATCH_RESOLVE_ROUTE,
} from "./routes/dispatch-platform";

// CP2-C (POD product path) route handlers.
import {
  ADMIN_POD_MAPPING_PATH_PREFIX,
  ADMIN_POD_MAPPINGS_PATH,
  ADMIN_POD_PRINTERS_PATH,
  ADMIN_POD_QUOTE_PATH,
  handleAdminPodProductRoute,
} from "./routes/pod-admin";
import {
  handlePlatformPrintersRoute,
  handlePlatformScreeningRoute,
  PLATFORM_PRINTERS_PATH,
  PLATFORM_SCREENING_PATH,
  PLATFORM_SCREENING_PATH_PREFIX,
} from "./routes/pod-platform";
import {
  handlePodPreviewRoute,
  STOREFRONT_POD_PREVIEWS_PREFIX,
} from "./routes/pod-storefront";

const HEALTH_PATH = "/health";
const READINESS_PATH = "/ready";
const STOREFRONT_PATH = "/v1/storefront";
const PRODUCTS_PATH = "/v1/products";
const PRODUCT_PATH_PREFIX = "/v1/products/";
const CHECKOUT_PATH = "/v1/checkout";
const CHECKOUT_PATH_PREFIX = "/v1/checkout/";
const ADMIN_PRODUCTS_PATH = "/v1/admin/products";
const ADMIN_PRODUCT_PATH_PREFIX = "/v1/admin/products/";
const ADMIN_OBJECTS_PATH = "/v1/admin/objects";
const ADMIN_OBJECT_PATH_PREFIX = "/v1/admin/objects/";
const ADMIN_DISCOUNT_CODES_PATH = "/v1/admin/discount-codes";
const ADMIN_DISCOUNT_CODE_PATH_PREFIX = "/v1/admin/discount-codes/";
const PLATFORM_TENANTS_PATH = "/v1/platform/tenants";
const PLATFORM_TENANT_PATH_PREFIX = "/v1/platform/tenants/";
const PLATFORM_BOOTSTRAP_PATH = "/v1/platform/bootstrap";
const PLATFORM_USERS_PATH = "/v1/platform/users";
// PLATFORM-level, not tenant-level, and deliberately so: Stripe is configured
// with ONE endpoint URL per account and calls it for every event on that
// account, regardless of which storefront the money belonged to. There is no
// storefront hostname on these requests to resolve a tenant from — the tenant
// comes from the checkout row the intent id finds. Grouping it under /v1/webhooks
// rather than /v1/platform keeps it out of the namespace whose other routes all
// require a live platform session; nothing here has a session at all.
const STRIPE_WEBHOOK_PATH = "/v1/webhooks/stripe";
const ADMIN_POD_PROFILES_PATH = "/v1/admin/pod/profiles";
const ADMIN_POD_ARTWORK_PATH = "/v1/admin/pod/artwork";
const ADMIN_POD_ARTWORK_PATH_PREFIX = "/v1/admin/pod/artwork/";
const PLATFORM_POD_PROFILES_PATH = "/v1/platform/pod/profiles";
const REQUIRED_MIGRATION = "0027_connect_account_resync.sql";

const MINUTE_MS = 60 * 1_000;

// Checkout is an unauthenticated write, so it carries two independent limits.
// The per-IP one is the flood shield and is deliberately tight. The per-email
// one is looser but wider-reaching: it survives an attacker rotating addresses
// through a proxy pool, which the IP limit alone cannot.
export const CHECKOUT_IP_SCOPE = "checkout-ip";
export const CHECKOUT_IP_LIMIT = 10;
export const CHECKOUT_IP_WINDOW_MS = MINUTE_MS;
export const CHECKOUT_EMAIL_SCOPE = "checkout-email";
export const CHECKOUT_EMAIL_LIMIT = 30;
export const CHECKOUT_EMAIL_WINDOW_MS = 60 * MINUTE_MS;

// The payment route's per-IP shield. Deliberately TWICE the checkout limit
// rather than equal to it: one buyer legitimately creates one checkout and then
// polls its intent — a page reload, a browser back-navigation, a re-mounted
// payment element each retrieve the same intent — so a limit equal to
// checkout's would throttle the honest flow before it throttled anything else.
// It is still tight in absolute terms, and it must be, because past this gate
// sits an outbound network call to a third party: an unthrottled caller is a
// cost and reputation vector against the platform's Stripe account, not merely
// a load on D1. The same window as checkout keeps the two comparable.
export const PAYMENT_IP_SCOPE = "checkout-payment-ip";
export const PAYMENT_IP_LIMIT = 20;
export const PAYMENT_IP_WINDOW_MS = MINUTE_MS;

// A cheap shield in front of the bootstrap token compare. Legitimate use of
// that route is one successful call in the lifetime of the platform, so five
// attempts per ten minutes is generous for an operator and hostile to a
// brute-force.
export const BOOTSTRAP_IP_SCOPE = "bootstrap-ip";
export const BOOTSTRAP_IP_LIMIT = 5;
export const BOOTSTRAP_IP_WINDOW_MS = 10 * MINUTE_MS;

/**
 * The artwork dispatch route's per-IP shield.
 *
 * TIGHT — 5 per minute, half the anonymous checkout allowance — even though
 * this surface sits behind a live tenant-admin session, because of what one
 * request costs. Past this gate is a render job (queued since CP1-C rather than
 * dispatched synchronously, but the same compute) that may hold a 2 GiB
 * instance for up to 300 seconds running sharp over a file up to the profile's
 * cap, and the farm runs at concurrency 1. A handful
 * of parallel dispatches is therefore not "some load on D1"; it is the whole
 * render capacity of the platform, occupied.
 *
 * Five per minute is generous against the honest flow: an admin uploads a motif
 * and waits for a spinner, and even a bulk uploader working through a folder
 * cannot start a sixth job in a minute while the first five are still running.
 * It is hostile to the case that matters — a compromised or careless admin
 * session turning into a denial of service against every other tenant's
 * uploads, which is the shape a shared, serialized compute resource takes when
 * nothing bounds it.
 *
 * The limiter runs BEFORE the profile lookup, the ownership check, the insert
 * and the farm call, so a flood is refused without spending any of the work it
 * is trying to provoke.
 */
export const POD_DISPATCH_IP_SCOPE = "pod-dispatch-ip";
export const POD_DISPATCH_IP_LIMIT = 5;
export const POD_DISPATCH_IP_WINDOW_MS = MINUTE_MS;

/**
 * How long a preview download URL stays valid.
 *
 * Short by design: it is minted per detail-read, handed to a browser that is
 * about to render it, and a rendered preview does not need an hour of validity.
 * A leaked URL is a capability on one tenant's preview image, and 300 seconds
 * bounds that without making the admin UI re-fetch mid-session.
 */
const PREVIEW_URL_TTL_SECONDS = 300;

type AdminProductAction = "publish" | "unpublish";

type PlatformTenantAction = "activate" | "admins" | "domains" | "suspend";

interface AdminProductRoute {
  action: AdminProductAction | null;
  productId: string;
}

interface PlatformTenantRoute {
  action: PlatformTenantAction;
  tenantId: string;
}

interface AdminObjectRoute {
  content: boolean;
  objectId: string;
}

function adminNotFoundResponse(): Response {
  return notFoundResponse("Route not found");
}

function conflictResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "conflict",
        message: "Request conflicts with the current product state",
      },
    },
    409,
  );
}

function platformConflictResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "conflict",
        message: "Request conflicts with the current tenant state",
      },
    },
    409,
  );
}

function adminResultResponse(
  result: AdminCatalogResult,
  successStatus: number,
): Response {
  if (result.status === "ok") {
    return jsonResponse({ product: result.product }, successStatus);
  }
  if (result.status === "refused") {
    // A publish/price edit the POD gate refuses (no active mapping, price
    // below the PRISGOLV floor, …): the code tells the admin UI what to fix.
    return jsonResponse(
      {
        error: {
          code: result.code,
          message: result.message ?? "Product cannot be published",
        },
      },
      422,
    );
  }
  if (result.status === "conflict") {
    return conflictResponse();
  }
  if (result.status === "invalid") {
    return invalidRequestResponse();
  }
  return adminNotFoundResponse();
}

function adminProductRouteFromPath(pathname: string): AdminProductRoute | null {
  if (!pathname.startsWith(ADMIN_PRODUCT_PATH_PREFIX)) {
    return null;
  }

  const segments = pathname.slice(ADMIN_PRODUCT_PATH_PREFIX.length).split("/");
  const [rawProductId, rawAction, ...rest] = segments;
  if (rawProductId === undefined || rest.length > 0) {
    return null;
  }

  const productId = decodeSegment(rawProductId);
  if (productId === null) {
    return null;
  }

  if (rawAction === undefined) {
    return { action: null, productId };
  }
  if (rawAction === "publish" || rawAction === "unpublish") {
    return { action: rawAction, productId };
  }

  return null;
}

function adminObjectRouteFromPath(pathname: string): AdminObjectRoute | null {
  if (!pathname.startsWith(ADMIN_OBJECT_PATH_PREFIX)) {
    return null;
  }

  const segments = pathname.slice(ADMIN_OBJECT_PATH_PREFIX.length).split("/");
  const [rawObjectId, rawContent, ...rest] = segments;
  if (rawObjectId === undefined || rest.length > 0) {
    return null;
  }

  const objectId = decodeSegment(rawObjectId);
  if (objectId === null) {
    return null;
  }

  if (rawContent === undefined) {
    return { content: false, objectId };
  }

  return rawContent === "content" ? { content: true, objectId } : null;
}

function platformTenantRouteFromPath(
  pathname: string,
): PlatformTenantRoute | null {
  if (!pathname.startsWith(PLATFORM_TENANT_PATH_PREFIX)) {
    return null;
  }

  const segments = pathname.slice(PLATFORM_TENANT_PATH_PREFIX.length).split("/");
  const [rawTenantId, rawAction, ...rest] = segments;
  if (rawTenantId === undefined || rawAction === undefined || rest.length > 0) {
    return null;
  }

  const decoded = decodeSegment(rawTenantId);
  if (decoded === null) {
    return null;
  }

  const tenantId = parseTenantIdPathSegment(decoded);
  if (tenantId === null) {
    return null;
  }

  if (
    rawAction === "activate" ||
    rawAction === "admins" ||
    rawAction === "domains" ||
    rawAction === "suspend"
  ) {
    return { action: rawAction, tenantId };
  }

  return null;
}

function productIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(PRODUCT_PATH_PREFIX)) {
    return null;
  }

  const segment = pathname.slice(PRODUCT_PATH_PREFIX.length);
  if (segment.length === 0 || segment.includes("/")) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }

  return decoded.length > 0 && !decoded.includes("/") ? decoded : null;
}

async function readinessResponse(env: Env): Promise<Response> {
  try {
    const migration = await env.DB.prepare(
      "SELECT name FROM d1_migrations WHERE name = ? LIMIT 1",
    )
      .bind(REQUIRED_MIGRATION)
      .first<{ name: string }>();

    if (migration === null) {
      return jsonResponse(
        {
          database: "migration_required",
          status: "not_ready",
        },
        503,
      );
    }

    return jsonResponse({
      database: "ready",
      migration: migration.name,
      status: "ok",
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown readiness error",
        message: "database readiness check failed",
      }),
    );

    return jsonResponse(
      {
        database: "unavailable",
        status: "not_ready",
      },
      503,
    );
  }
}

async function handleAdminProductRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  // Guard and CSRF check run before any parsing so an unauthorized caller can
  // never learn whether the surface, the tenant, or the product exists.
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return adminNotFoundResponse();
  }

  const now = Date.now();

  if (url.pathname === ADMIN_PRODUCTS_PATH) {
    if (request.method !== "POST") {
      return adminNotFoundResponse();
    }

    const input = parseCreateProductInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    return adminResultResponse(
      await createAdminProduct(env.DB, principal, input, now),
      201,
    );
  }

  const route = adminProductRouteFromPath(url.pathname);
  if (route === null) {
    return adminNotFoundResponse();
  }

  if (route.action === null) {
    if (request.method !== "PATCH") {
      return adminNotFoundResponse();
    }

    const input = parseUpdateProductInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    return adminResultResponse(
      await updateAdminProduct(env.DB, principal, route.productId, input, now),
      200,
    );
  }

  if (request.method !== "POST") {
    return adminNotFoundResponse();
  }

  return adminResultResponse(
    route.action === "publish"
      ? await publishAdminProduct(env.DB, principal, route.productId, now)
      : await unpublishAdminProduct(env.DB, principal, route.productId, now),
    200,
  );
}

function payloadTooLargeResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "payload_too_large",
        message: "Upload exceeds the maximum allowed size",
      },
    },
    413,
  );
}

function objectConflictResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "conflict",
        message: "Request conflicts with the current object state",
      },
    },
    409,
  );
}

async function handleAdminObjectRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  // Guard and CSRF check run before any parsing — including before the body is
  // touched — so an unauthorized caller can never stream bytes into the worker
  // or learn that the object surface exists.
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return adminNotFoundResponse();
  }

  const isStateChanging = request.method !== "GET";
  if (isStateChanging && !isSameOriginRequest(request)) {
    return adminNotFoundResponse();
  }

  const now = Date.now();

  if (url.pathname === ADMIN_OBJECTS_PATH) {
    if (request.method !== "POST") {
      return adminNotFoundResponse();
    }

    const input = parseReserveObjectInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    const reserved = await reserveAdminObject(env.DB, principal, input, now);
    if (reserved.status === "conflict") {
      return objectConflictResponse();
    }
    if (reserved.status !== "ok") {
      return invalidRequestResponse();
    }

    return jsonResponse({ object: reserved.object }, 201);
  }

  const route = adminObjectRouteFromPath(url.pathname);
  if (route === null) {
    return adminNotFoundResponse();
  }

  if (route.content) {
    if (request.method === "PUT") {
      const uploaded = await uploadAdminObject(
        env,
        env.DB,
        principal,
        route.objectId,
        request,
        now,
      );

      if (uploaded.status === "ok") {
        return jsonResponse({ object: uploaded.object }, 200);
      }
      if (uploaded.status === "conflict") {
        return objectConflictResponse();
      }
      if (uploaded.status === "too_large") {
        return payloadTooLargeResponse();
      }
      if (uploaded.status === "invalid") {
        return invalidRequestResponse();
      }
      return adminNotFoundResponse();
    }

    if (request.method !== "GET") {
      return adminNotFoundResponse();
    }

    const delivered = await deliverAdminObject(
      env,
      env.DB,
      principal,
      route.objectId,
    );

    return delivered ?? adminNotFoundResponse();
  }

  if (request.method === "GET") {
    const metadata = await getAdminObjectMetadata(
      env.DB,
      principal,
      route.objectId,
    );

    return metadata === null
      ? adminNotFoundResponse()
      : jsonResponse({ object: metadata });
  }

  if (request.method !== "DELETE") {
    return adminNotFoundResponse();
  }

  const deleted = await deleteAdminObject(
    env,
    env.DB,
    principal,
    route.objectId,
    now,
  );

  if (deleted.status === "conflict") {
    return objectConflictResponse();
  }

  return deleted.status === "ok"
    ? new Response(null, { status: 204 })
    : adminNotFoundResponse();
}

function discountCodeConflictResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "conflict",
        message: "Request conflicts with the current discount code state",
      },
    },
    409,
  );
}

function discountCodeResultResponse(
  result: AdminDiscountCodeResult,
  successStatus: number,
): Response {
  if (result.status === "ok") {
    return jsonResponse({ discountCode: result.discountCode }, successStatus);
  }
  if (result.status === "conflict") {
    return discountCodeConflictResponse();
  }
  if (result.status === "invalid") {
    return invalidRequestResponse();
  }
  return adminNotFoundResponse();
}

function discountCodeIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(ADMIN_DISCOUNT_CODE_PATH_PREFIX)) {
    return null;
  }

  const segments = pathname
    .slice(ADMIN_DISCOUNT_CODE_PATH_PREFIX.length)
    .split("/");
  const [rawId, ...rest] = segments;
  if (rawId === undefined || rest.length > 0) {
    return null;
  }

  return decodeSegment(rawId);
}

/**
 * Tenant-admin campaign discount codes. Same guard order as the products
 * surface: the live D1 session/membership check AND the strict same-origin
 * check run before any body is read, so an unauthorized or cross-site caller
 * cannot learn that this surface exists, let alone which codes a tenant runs.
 *
 * The same-origin check applies to STATE CHANGES only, matching the objects
 * surface rather than the products one. Browsers do not send an Origin header
 * on a same-origin GET, and this check fails closed on a missing one, so
 * demanding it on the read would make the read unusable from the very admin UI
 * it exists for. The GET is still fully privileged — it is behind the same live
 * session and membership guard — and CSRF is meaningless for a request that
 * changes nothing: an attacker who forges one cannot read the response.
 *
 * ACTIVATION is a PATCH field (`active`), not a pair of action verbs. The
 * products surface uses POST .../publish because publishing writes a separate
 * projection row; here it is one boolean on one row, and a dedicated verb would
 * mean two paths writing the same column.
 */
async function handleAdminDiscountCodeRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return adminNotFoundResponse();
  }

  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return adminNotFoundResponse();
  }

  const now = Date.now();

  if (url.pathname === ADMIN_DISCOUNT_CODES_PATH) {
    if (request.method !== "POST") {
      return adminNotFoundResponse();
    }

    const input = parseCreateDiscountCodeInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    return discountCodeResultResponse(
      await createAdminDiscountCode(env.DB, principal, input, now),
      201,
    );
  }

  const discountCodeId = discountCodeIdFromPath(url.pathname);
  if (discountCodeId === null) {
    return adminNotFoundResponse();
  }

  if (request.method === "GET") {
    return discountCodeResultResponse(
      await getAdminDiscountCode(env.DB, principal, discountCodeId),
      200,
    );
  }

  if (request.method !== "PATCH") {
    return adminNotFoundResponse();
  }

  const input = parseUpdateDiscountCodeInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  return discountCodeResultResponse(
    await updateAdminDiscountCode(
      env.DB,
      principal,
      discountCodeId,
      input,
      now,
    ),
    200,
  );
}

function unprocessableResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "unprocessable",
        message: "Request could not be processed",
      },
    },
    422,
  );
}

/**
 * Anonymous storefront checkout. The tenant comes from the verified hostname
 * and nothing else — an x-shop-id header or a forwarded-host claim is never
 * consulted — so a caller can only ever price against the storefront it is
 * actually talking to.
 *
 * There is no session and no same-origin check, and both omissions are
 * deliberate: this surface accepts unauthenticated buyers by design, and CSRF
 * protection is meaningless for a request that carries no ambient credential.
 * A forged cross-site POST here can create a checkout, which is exactly what an
 * honest buyer's browser does too, and it grants the attacker nothing: the
 * response is the only place the checkout id appears.
 *
 * The 422 is deliberately opaque about which line failed. Naming the offending
 * item would turn this route into a catalogue oracle that reveals which product
 * and variant ids exist, are active, and belong to this tenant.
 *
 * Being an unauthenticated write that inserts rows and runs a query per item,
 * it is rate limited twice. The per-IP limit runs BEFORE the body is parsed, so
 * a flood is refused without the worker doing the parsing work it is trying to
 * provoke. The per-email limit can only run after parsing — the address is what
 * it keys on — and catches the distributed case the IP limit cannot: one buyer
 * address driven from many addresses.
 */
async function handleCheckoutRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return notFoundResponse("Route not found");
  }

  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return notFoundResponse("Checkout not found");
  }

  const now = Date.now();

  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: CHECKOUT_IP_LIMIT,
    now,
    scope: CHECKOUT_IP_SCOPE,
    windowMs: CHECKOUT_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const input = parseCreateCheckoutInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  // Keyed on the parsed address, which parseCreateCheckoutInput has already
  // lowercased, so casing variants cannot be used to mint fresh buckets.
  const byEmail = await enforceRateLimit(env.DB, {
    key: input.email,
    limit: CHECKOUT_EMAIL_LIMIT,
    now,
    scope: CHECKOUT_EMAIL_SCOPE,
    windowMs: CHECKOUT_EMAIL_WINDOW_MS,
  });
  if (!byEmail.allowed) {
    return rateLimitedResponse(byEmail.retryAfterSeconds);
  }

  const result = await createCheckout(env.DB, tenant, input, now, {
    dispatchTarget: dispatchTargetOf(env),
  });
  if (result.status === "ok") {
    // A replay answers 200 rather than 201: the checkout already existed, and
    // the status code is the only honest way to say so without changing body.
    return jsonResponse(
      { checkout: result.checkout },
      result.replayed ? 200 : 201,
    );
  }

  if (result.status === "invalid_items") {
    return unprocessableResponse();
  }

  return jsonResponse(
    {
      error: {
        code: "conflict",
        message: "Idempotency key was already used for a different request",
      },
    },
    409,
  );
}

/**
 * Parses `/v1/checkout/{checkoutId}/payment` and nothing else.
 *
 * Strict two-segment shape with the same safe percent-decoding the other id
 * routes use: a malformed path, an extra segment, or any action other than
 * `payment` is not a route here, and the caller learns that as the same 404 an
 * unknown checkout gets.
 */
function checkoutPaymentIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(CHECKOUT_PATH_PREFIX)) {
    return null;
  }

  const segments = pathname.slice(CHECKOUT_PATH_PREFIX.length).split("/");
  const [rawCheckoutId, rawAction, ...rest] = segments;
  if (rawCheckoutId === undefined || rawAction !== "payment" || rest.length > 0) {
    return null;
  }

  return decodeSegment(rawCheckoutId);
}

/**
 * Every failure on the payment route answers with this one shape.
 *
 * ONE opaque failure for unknown ids, foreign tenants, expired quotes,
 * non-open statuses, and terminal intents — deliberately not a 410 for expiry
 * and a 404 for the rest. The checkout id is a bearer capability, and the only
 * way to hold one is to have been handed it; distinguishing "this id never
 * existed" from "this id is yours but dead" would turn the route into an oracle
 * that confirms an id is real, which is precisely the fact a leaked or guessed
 * id is trying to establish. A buyer whose own checkout died learns the same
 * thing either way — they need a new checkout — and 404 says that without
 * telling an attacker anything.
 */
function paymentNotFoundResponse(): Response {
  return notFoundResponse("Checkout not found");
}

/**
 * The one answer to a request that failed to prove it came from Stripe.
 *
 * 400 rather than 401/403 because that is Stripe's own documented convention for
 * a signature failure, and because it is what their dashboard's endpoint health
 * view expects to see. It is also correct on the merits: an unsigned or
 * mis-signed request is malformed as a webhook, not merely unauthorized.
 *
 * The body is a constant. It does not say whether the header was missing or
 * wrong, whether the timestamp was stale, or whether the secret is the problem —
 * an attacker probing a public URL learns nothing from it, and Stripe does not
 * read it.
 */
function webhookSignatureFailureResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "invalid_signature",
        message: "Request signature could not be verified",
      },
    },
    400,
  );
}

/**
 * Anonymous, server-authoritative PaymentIntent creation for one checkout.
 *
 * The checkout id in the path is the entire capability, matching production's
 * trust model: possession of the id is what a buyer has, and the tenancy is
 * still resolved from the verified hostname, so an id from tenant A is not a
 * capability on tenant B's storefront.
 *
 * THE ROUTE READS NO BODY AT ALL, and a non-empty one is refused. The amount is
 * the checkout's frozen total and the currency is its own; there is nothing a
 * caller could put in a body that this route would be willing to honour, so
 * accepting-and-ignoring one would be a lie about the interface. Refusing is
 * also what makes the interface auditable: nobody can later "just read one
 * field" from a body the contract says does not exist.
 *
 * The whole surface fails closed 404 while STRIPE_SECRET_KEY is unset, exactly
 * as the auth namespace does without its secret — staging deploys dark and
 * lights up on the secret alone.
 */
async function handleCheckoutPaymentRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  // The unconfigured gate runs FIRST, before the method check and before any
  // D1 work, so an unconfigured deployment is indistinguishable from one where
  // the route was never written.
  if (!isStripeConfigured(env)) {
    return paymentNotFoundResponse();
  }

  if (request.method !== "POST") {
    return paymentNotFoundResponse();
  }

  const checkoutId = checkoutPaymentIdFromPath(url.pathname);
  if (checkoutId === null) {
    return paymentNotFoundResponse();
  }

  // A body is a contract violation, not a validation failure, so it is refused
  // before the tenant is resolved and before the limiter counts the request:
  // the caller is not describing anything this route does.
  //
  // A declared `Content-Length: 0` is the authoritative statement of "no body"
  // and is ACCEPTED: Cloudflare's edge normalizes ordinary bodyless POSTs
  // (curl, fetch over HTTP/2) into exactly that shape before the worker sees
  // them, so rejecting it — as the first deployed version of this route did —
  // 404s every legitimate caller while passing every local test, where Request
  // objects are built without edge normalization. Live smoke caught it; local
  // gates cannot. Beyond that declared-empty case, either signal refuses: a
  // non-zero length declares a body outright, and an absent length with a
  // present stream is a chunked body. Content-Length cannot lie low — HTTP
  // forbids it coexisting with a longer body, and the edge enforces that
  // before the worker runs.
  const contentLength = request.headers.get("content-length");
  const declaresBody = contentLength !== null && contentLength !== "0";
  const undeclaredStream = contentLength === null && request.body !== null;
  if (declaresBody || undeclaredStream) {
    return paymentNotFoundResponse();
  }

  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return paymentNotFoundResponse();
  }

  const now = Date.now();

  // Before any checkout read and — the point of putting it here — before Stripe
  // is touched. Past this gate is an outbound call to a third party, so the
  // limiter must be the first thing a flood meets, not the last.
  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: PAYMENT_IP_LIMIT,
    now,
    scope: PAYMENT_IP_SCOPE,
    windowMs: PAYMENT_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const outcome = await createCheckoutPayment(
    env.DB,
    resolveStripeGateway(env),
    tenant,
    checkoutId,
    now,
  );

  if (outcome.status === "not_available") {
    return paymentNotFoundResponse();
  }

  // The gateway failed. 502 rather than 500 because the failure is upstream and
  // an honest client may retry — the deterministic idempotency key means a retry
  // reaches the same intent rather than minting a second one. The body names
  // neither Stripe nor its error: see StripeGatewayError.
  if (outcome.status === "gateway_error") {
    return jsonResponse(
      {
        error: {
          code: "payment_unavailable",
          message: "Payment could not be prepared",
        },
      },
      502,
    );
  }

  // 201 when this request minted the intent, 200 when it re-served an existing
  // one — the same honest distinction the creation route draws for a replay.
  // The client secret is the only capability handed back; the intent id travels
  // with it because the storefront needs it for Stripe.js. jsonResponse already
  // sets no-store, which matters more here than anywhere else on this worker.
  return jsonResponse(
    {
      payment: {
        clientSecret: outcome.result.clientSecret,
        paymentIntentId: outcome.result.paymentIntentId,
      },
    },
    outcome.result.created ? 201 : 200,
  );
}

/**
 * The Stripe webhook endpoint — where a succeeded payment becomes an order.
 *
 * ── AUTHENTICATION ───────────────────────────────────────────────────────────
 * The signature is the whole of it, and it is enough: verifying it proves the
 * request was produced by someone holding STRIPE_WEBHOOK_SECRET, which is Stripe
 * and this worker and nobody else. There is no session (Stripe has no account
 * here), no same-origin check (a server-to-server call sends no Origin), and no
 * tenant hostname (Stripe calls one URL per account, not one per storefront).
 * Every one of those absences is a consequence of who the caller is, not a gap.
 *
 * ── WHY THERE IS NO RATE LIMITER ─────────────────────────────────────────────
 * Considered and deliberately omitted. The checkpoint-19 limiter keys on
 * CF-Connecting-IP, and Stripe delivers from a small pool of its own addresses:
 * every legitimate event for every tenant on this account arrives from those few
 * IPs, so any limit tight enough to matter would throttle real payment
 * notifications — the one class of request this platform can least afford to
 * drop — and a limit loose enough not to would stop nothing. Worse, a 429 to
 * Stripe is a retry signal, so throttling a flood would convert it into a
 * sustained retry storm rather than ending it.
 *
 * What actually bounds an attacker here is the signature check, which runs
 * before any database work: an unsigned flood costs one HMAC each and touches
 * nothing. A SIGNED flood is Stripe itself, and the event ledger makes each
 * event idempotent no matter how often it arrives. If volume ever needs
 * shaping, it belongs at the edge (WAF rate rules on this path), not in a
 * D1-backed counter that would add a write to every payment notification.
 *
 * ── RESPONSES ────────────────────────────────────────────────────────────────
 * 404 while unconfigured, 400 for a signature that does not verify, 500 for a
 * database fault, and 200 for absolutely everything else — including events this
 * worker refuses to act on. See handleStripeWebhookEvent for why a 4xx on an
 * understood-but-unusable event is a trap rather than a correctness measure.
 * No response body ever names Stripe, an error, an id, or a reason.
 */
async function handleStripeWebhookRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  // The unconfigured gate runs FIRST — before the method check, before the body
  // is read, before D1 — so an unconfigured deployment is indistinguishable from
  // one where this endpoint was never written. Both secrets are required: the
  // signing secret to authenticate the caller, and the API key because the
  // verifier is built from the same SDK client, and because a worker that can
  // record payments but could not have created them is a misconfiguration worth
  // failing closed on.
  if (!isStripeWebhookConfigured(env) || !isStripeConfigured(env)) {
    return notFoundResponse("Route not found");
  }

  if (request.method !== "POST") {
    return notFoundResponse("Route not found");
  }

  const signature = request.headers.get("stripe-signature");
  if (signature === null) {
    return webhookSignatureFailureResponse();
  }

  // THE RAW BODY, read as text before anything parses it. The signature is
  // computed over the exact bytes Stripe sent, so a parse-then-reserialize round
  // trip — different key order, different spacing — would break verification for
  // every honest request. Nothing may read this body before this line.
  let payload: string;
  try {
    payload = await request.text();
  } catch {
    // A body that could not be read cannot be verified.
    return webhookSignatureFailureResponse();
  }

  let event;
  try {
    event = await resolveStripeWebhookVerifier(env).constructEvent(
      payload,
      signature,
    );
  } catch (error) {
    if (error instanceof StripeSignatureError) {
      return webhookSignatureFailureResponse();
    }

    throw error;
  }

  // Past this line the request is provably Stripe's, and every outcome is a 200.
  // The result is deliberately not inspected: there is no outcome this route
  // answers differently for, because every one of them is a fact recorded in
  // `payment_events` rather than a message to the caller. A D1 fault throws
  // instead of returning, which is the one case Stripe should retry.
  await handleStripeWebhookEvent(env.DB, event, Date.now());

  // `received` and nothing else. Not the outcome, not the reason code, not the
  // order id: Stripe does not read the body, and a webhook endpoint is a public
  // URL whose responses should tell an unauthenticated prober nothing — least of
  // all whether a given event id was recognized, which would make the endpoint an
  // oracle for whether a payment landed. The detail lives in `payment_events`,
  // where an operator can query it.
  return jsonResponse({ received: true }, 200);
}

/**
 * Parses `/v1/admin/pod/artwork/{artworkId}` and nothing else.
 *
 * Strict single-segment shape with the same safe percent-decoding every other
 * id route uses. A sub-path, an extra segment or a malformed encoding is not a
 * route here and answers the same 404 an unknown artwork gets.
 */
function podArtworkIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(ADMIN_POD_ARTWORK_PATH_PREFIX)) {
    return null;
  }

  const segments = pathname
    .slice(ADMIN_POD_ARTWORK_PATH_PREFIX.length)
    .split("/");
  const [rawId, ...rest] = segments;
  if (rawId === undefined || rest.length > 0) {
    return null;
  }

  return decodeSegment(rawId);
}

/**
 * The POD artwork surface — profiles, the library, and the render-farm dispatch.
 *
 * ── THE SURFACE IS DARK UNTIL FULLY CONFIGURED ──────────────────────────────
 * Every route below answers a fail-closed 404 while any of the six POD
 * configuration values is missing, and the gate runs FIRST — before the method
 * check, before the path parse, before the session guard, before D1 and before
 * the rate limiter — so an unconfigured deployment is indistinguishable from
 * one where none of this was ever written. Same contract as the payment and
 * webhook surfaces, and for a sharper reason here: a partially configured POD
 * worker cannot do anything useful, so admitting callers to a broken surface
 * would only produce confusing failures on a path that ends at a print shop.
 *
 * ── WHY THE FARM'S ANSWER NEVER REACHES THE CLIENT ──────────────────────────
 * A dispatch failure is one opaque 502 that names neither the farm, its URL,
 * its status code, nor its body. The farm's own error bodies are constant by
 * design and its detail lives in its logs keyed by jobId; propagating any of it
 * would put upstream text in a tenant admin's browser and, worse, would let a
 * caller distinguish "the farm is down" from "the farm rejected the envelope"
 * — the second of which is a fact about this worker's own correctness that no
 * client needs.
 */
/**
 * The admin POD surface exists only when the creation path in use can finish.
 *
 * Asynchronous creation (SYNC_RENDER_FALLBACK = false) queues a job that only
 * the /v1/render pull surface can hand to a farm, so it needs that surface's
 * configuration (isRenderJobsConfigured: a ≥ 32-character RENDER_FARM_TOKEN,
 * the presigner, the private bucket). Gating on isPodConfigured alone (a token
 * of ≥ 16) left a window: a 16–31-character token accepted artworks whose jobs
 * no farm could ever acquire, so they sat 'processing' forever. The
 * synchronous fallback keeps its own gate. Same all-or-nothing rule as before:
 * a partially configured surface is dark, not degraded.
 */
function isAdminPodSurfaceConfigured(env: Env): boolean {
  // The async path (CP1-C/D) never calls a farm URL: the container PULLS from
  // /v1/render, so RENDER_FARM_URL is only a requirement of the synchronous
  // fallback. Requiring it here would keep the whole admin POD surface dark on
  // a deployment that is correctly configured for the pull model.
  return SYNC_RENDER_FALLBACK
    ? isPodConfigured(env)
    : isR2PresignerConfigured(env) && isRenderJobsConfigured(env);
}

async function handleAdminPodRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  // The unconfigured gate, first and before everything.
  if (!isAdminPodSurfaceConfigured(env)) {
    return adminNotFoundResponse();
  }

  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return adminNotFoundResponse();
  }

  // Same split the objects and discount-code surfaces use: CSRF on state
  // changes only, because browsers send no Origin on a same-origin GET and a
  // check that fails closed on a missing one would make the reads unusable from
  // the admin UI they exist for. The GETs remain fully privileged behind the
  // live session and membership guard.
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return adminNotFoundResponse();
  }

  const now = Date.now();

  if (url.pathname === ADMIN_POD_PROFILES_PATH) {
    if (request.method !== "GET") {
      return adminNotFoundResponse();
    }

    return jsonResponse({ profiles: await listActiveProfiles(env.DB, principal) });
  }

  if (url.pathname === ADMIN_POD_ARTWORK_PATH) {
    if (request.method === "GET") {
      return jsonResponse({ artwork: await listArtwork(env.DB, principal) });
    }

    if (request.method !== "POST") {
      return adminNotFoundResponse();
    }

    // BEFORE the body is parsed, before the profile lookup, before the
    // ownership check, and — the point of putting it here — before the farm is
    // touched. See POD_DISPATCH_IP_SCOPE for why this limit is tight.
    const byIp = await enforceRateLimit(env.DB, {
      key: clientIp(request),
      limit: POD_DISPATCH_IP_LIMIT,
      now,
      scope: POD_DISPATCH_IP_SCOPE,
      windowMs: POD_DISPATCH_IP_WINDOW_MS,
    });
    if (!byIp.allowed) {
      return rateLimitedResponse(byIp.retryAfterSeconds);
    }

    const input = parseCreateArtworkInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    // Asynchronous since CP1-C: the artwork is created 'processing' with a
    // queued render job, and the farm pulls it (src/pod/render-jobs.ts). The
    // synchronous dispatch stays reachable only by flipping the constant; see
    // SYNC_RENDER_FALLBACK.
    const result = SYNC_RENDER_FALLBACK
      ? await createArtwork(
          env,
          env.DB,
          resolveRenderFarmClient(env),
          resolveR2Presigner(env),
          principal,
          input,
          now,
        )
      : await enqueueArtwork(env, env.DB, principal, input, now);

    if (result.status === "not_found") {
      // Unknown/foreign/pending original, or an unknown or retired profile.
      // One answer for all of them: naming which would turn this route into an
      // oracle for another tenant's object ids.
      return adminNotFoundResponse();
    }

    if (result.status === "conflict") {
      return jsonResponse(
        {
          error: {
            code: "conflict",
            message: "Artwork already exists for this original and profile",
          },
        },
        409,
      );
    }

    // 202: accepted for processing. The body is the 'processing' artwork; its
    // detail GET is the poll.
    if (result.status === "queued") {
      return jsonResponse({ artwork: result.artwork }, 202);
    }

    // 201 for a ready verdict, 200 for a rejection. A rejection is a
    // SUCCESSFUL request whose artwork failed the gate — the same distinction
    // the farm itself draws by answering 200 `{ ok:false }` — and answering
    // 4xx would tell the client its request was wrong when it was not.
    if (result.status === "created" || result.status === "rejected") {
      return jsonResponse(
        { artwork: result.artwork },
        result.status === "created" ? 201 : 200,
      );
    }

    // 502 rather than 500: the failure is upstream. No stuck row remains — the
    // dispatch path deleted it — so an honest client retry with the same body
    // simply works, which is the retry story the contract's purity principle
    // makes possible.
    return jsonResponse(
      {
        error: {
          code: "artwork_unavailable",
          message: "Artwork could not be processed",
        },
      },
      502,
    );
  }

  const artworkId = podArtworkIdFromPath(url.pathname);
  if (artworkId === null) {
    return adminNotFoundResponse();
  }

  if (request.method === "GET") {
    const artwork = await getArtwork(env.DB, principal, artworkId);
    if (artwork === null) {
      return adminNotFoundResponse();
    }

    // The preview download URL, minted per read.
    //
    // PRESIGNED rather than routed through this worker's own delivery
    // machinery, deliberately and consistently with how the outputs are
    // written: these objects are NOT `stored_objects` rows, so the checkpoint-16
    // signed-delivery path — which resolves that table as its sole authority —
    // has nothing to resolve for them. Reusing it would mean either inventing
    // ownership rows for server-owned objects (giving the client-facing object
    // surface a handle on print outputs, which is exactly the delivery teeth
    // this checkpoint is protecting) or bypassing its authorization check. A
    // short-TTL presigned GET keeps the authorization here, where the session
    // and tenant were already proven, and hands out a capability that expires.
    //
    // Only READY artwork has a preview; anything else gets null rather than a
    // URL to nothing.
    const previewKey = await getPreviewKey(env.DB, principal, artworkId);
    const previewUrl =
      previewKey === null
        ? null
        : await resolveR2Presigner(env).presignGet(previewKey, PREVIEW_URL_TTL_SECONDS);

    return jsonResponse({ artwork, previewUrl });
  }

  if (request.method !== "DELETE") {
    return adminNotFoundResponse();
  }

  const deleted = await deleteArtwork(env, env.DB, principal, artworkId, now);

  if (deleted.status === "conflict") {
    return jsonResponse(
      { error: { code: "conflict", message: "Artwork is used by a POD mapping" } },
      409,
    );
  }
  return deleted.status === "ok"
    ? new Response(null, { status: 204 })
    : adminNotFoundResponse();
}

/**
 * Platform replacement of the print profile list.
 *
 * PLATFORM-guarded, not tenant-guarded, because a profile encodes the print
 * shop's physical capability rather than any tenant's preference — see
 * src/pod/pod-profiles.ts. A tenant able to lower its own `min_dpi` could admit
 * files the printer will refuse, and the rejection would arrive as a returned
 * order rather than as an upload error.
 *
 * Full replace rather than per-profile PATCH: the list IS a specification
 * document that arrives from the printer as a unit, and production edits it
 * exactly that way. A partial-update surface would invite a state where two
 * profiles disagree about the same physical product.
 */
async function handlePlatformPodProfilesRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (!isAdminPodSurfaceConfigured(env)) {
    return adminNotFoundResponse();
  }

  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return adminNotFoundResponse();
  }

  if (request.method !== "PUT") {
    return adminNotFoundResponse();
  }

  const profiles = parseReplaceProfilesInput(await readJsonBody(request));
  if (profiles === null) {
    return invalidRequestResponse();
  }

  const result = await replaceProfiles(env.DB, principal, profiles, Date.now());
  if (result.status !== "ok") {
    return invalidRequestResponse();
  }

  return jsonResponse({ profiles: result.profiles }, 200);
}

function platformResultResponse(
  result: DomainResult | MembershipResult | TenantResult,
  successStatus: number,
): Response {
  if (result.status !== "ok") {
    return result.status === "conflict"
      ? platformConflictResponse()
      : adminNotFoundResponse();
  }
  if ("tenant" in result) {
    return jsonResponse({ tenant: result.tenant }, successStatus);
  }
  if ("domain" in result) {
    return jsonResponse({ domain: result.domain }, successStatus);
  }
  return jsonResponse({ membership: result.membership }, successStatus);
}

/**
 * One-time platform bootstrap. This route exists only to mint the very first
 * platform admin on a platform that has none, and goes permanently dead the
 * moment it succeeds: the zero-admin check inside isBootstrapAllowed can never
 * pass again.
 *
 * No session and no same-origin check are involved — the token in the
 * x-bootstrap-token header is the entire credential, so cookies are ignored.
 * Every guard failure returns the same 404 as a nonexistent route, so a caller
 * cannot tell an unconfigured token from a wrong one from an already-used
 * surface. Body validation runs only after the token gate has passed, so a 400
 * is itself proof of a correct token and never reaches an unauthorized caller.
 *
 * A per-IP limit runs in front of the token compare as a cheap shield: the
 * compare hashes both sides on every attempt, and this route is a brute-force
 * target by nature. It deliberately answers the SAME 404 as every other failure
 * here rather than the 429 the checkout route uses. That is not an oversight —
 * a 429 would confirm the surface exists and is worth attacking, and would let
 * a caller distinguish "throttled" from "wrong token", which is precisely the
 * distinction the rest of this route spends its effort hiding. The honest
 * operator hitting this limit is a person retrying by hand, who is no worse off
 * for seeing the same 404 they would see with a typo'd token.
 */
async function handlePlatformBootstrapRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return adminNotFoundResponse();
  }

  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: BOOTSTRAP_IP_LIMIT,
    now: Date.now(),
    scope: BOOTSTRAP_IP_SCOPE,
    windowMs: BOOTSTRAP_IP_WINDOW_MS,
  });
  if (!byIp.allowed || !(await isBootstrapAllowed(env, request))) {
    return adminNotFoundResponse();
  }

  const input = parseBootstrapInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await bootstrapPlatformAdmin(env, input, Date.now());
  if (result.status === "conflict") {
    return platformConflictResponse();
  }
  if (result.status !== "ok") {
    return adminNotFoundResponse();
  }

  // Nothing beyond the identity itself, and no session cookie: the new admin
  // signs in through the normal mounted sign-in route.
  return jsonResponse({ user: result.user }, 201);
}

/**
 * Platform-provisioned user creation — the only HTTP path that mints an account
 * once bootstrap has gone dead. See src/platform/provision-users.ts for why it
 * exists, why platform_admin is not a creatable kind, and why this authenticated
 * surface carries no rate limiter.
 *
 * Same fail-closed shape as the rest of the platform surface: the live D1
 * session check AND the strict same-origin check both run before the body is
 * touched, so a caller without platform rights cannot learn that a
 * user-provisioning surface exists, let alone probe it for which addresses are
 * already taken. Only past both guards can a 400 or a 409 be reached, which
 * makes either one proof of an authorized caller rather than a leak to an
 * anonymous one.
 */
async function handlePlatformUserRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return adminNotFoundResponse();
  }

  if (request.method !== "POST") {
    return adminNotFoundResponse();
  }

  const input = parseCreateUserInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await createPlatformUser(env, principal, input, Date.now());

  // A bare 409 that names neither the email nor which half of the identity
  // already existed. The operator learns the address is taken and nothing more.
  if (result.status === "conflict") {
    return jsonResponse(
      {
        error: {
          code: "conflict",
          message: "Request conflicts with an existing identity",
        },
      },
      409,
    );
  }

  // Better Auth's own password policy rejection lands here, indistinguishable
  // from a malformed body and echoing nothing back.
  if (result.status !== "ok") {
    return invalidRequestResponse();
  }

  // The identity and nothing else: no session cookie, no password echo. The new
  // user signs in through the normal mounted sign-in route, and the operator
  // feeds the returned userId to POST /v1/platform/tenants/{id}/admins.
  return jsonResponse({ user: result.user }, 201);
}

async function handlePlatformTenantRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  // Same fail-closed shape as the tenant admin surface: guard and CSRF check
  // run before any parsing, so a caller without platform rights cannot learn
  // that the provisioning surface exists at all.
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return adminNotFoundResponse();
  }

  if (request.method !== "POST") {
    return adminNotFoundResponse();
  }

  const now = Date.now();

  if (url.pathname === PLATFORM_TENANTS_PATH) {
    const input = parseCreateTenantInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    return platformResultResponse(
      await createTenant(env.DB, principal, input, now),
      201,
    );
  }

  const route = platformTenantRouteFromPath(url.pathname);
  if (route === null) {
    return adminNotFoundResponse();
  }

  if (route.action === "domains") {
    const input = parseAddDomainInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    return platformResultResponse(
      await addTenantDomain(env.DB, principal, route.tenantId, input, now),
      201,
    );
  }

  if (route.action === "admins") {
    const input = parseGrantAdminInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }

    return platformResultResponse(
      await grantTenantAdmin(env.DB, principal, route.tenantId, input, now),
      201,
    );
  }

  return platformResultResponse(
    await setTenantStatus(
      env.DB,
      principal,
      route.tenantId,
      route.action === "activate" ? "active" : "suspended",
      now,
    ),
    200,
  );
}

/**
 * Which entrypoint a request arrived through (PLAN §2.1).
 *
 * `public` is the Worker's own `fetch` handler — anything on the internet.
 * `internal` is the `Internal` WorkerEntrypoint, reachable only over the
 * service binding from `chopshop-web`. Set once per request by the entrypoint
 * that built the app, never derived from anything the request carries.
 */
export type Surface = "internal" | "public";

/**
 * TODO(PLAN §2.1, flip when chopshop-web ships): storefront routes are meant
 * to be served ONLY through the `Internal` entrypoint, i.e. only to requests
 * that `chopshop-web` forwarded over its service binding. No web worker exists
 * at CP1, so the public entrypoint still serves them by hostname. Setting this
 * to `false` is the whole switch: every storefront route then answers the
 * public entrypoint with the same 404 as an unknown route.
 */
export const PUBLIC_STOREFRONT_ALLOWED: boolean = true;

/**
 * The Hono environment every route sees: the Worker bindings and the surface
 * the request arrived through.
 */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    surface: Surface;
  };
}

export interface AppOptions {
  /** Defaults to PUBLIC_STOREFRONT_ALLOWED; tests pin both settings. */
  publicStorefrontAllowed?: boolean;
  surface: Surface;
}

type Endpoint = (c: Context<AppEnv>) => Promise<Response> | Response;

/**
 * Wraps a handler that the old if-chain only reached on `GET`.
 *
 * Every route below is registered method-agnostic (`app.all`) on purpose, so
 * the route table is a table of PATHS matched in registration order — exactly
 * the if-chain it replaces. The handlers that did their own method checks keep
 * doing them; the five routes whose method check lived in the dispatcher
 * (`request.method === "GET" && ...`) keep it here, and a non-GET falls through
 * to whatever the chain would have tried next, ending in the same 404.
 *
 * `c.req.method` is the RAW request method. Hono routes a HEAD request as a GET
 * and strips the body afterwards; checking the raw method keeps HEAD a 404 on
 * these routes, as it always was.
 */
function getOnly(handler: Endpoint): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== "GET") {
      await next();
      return;
    }

    return handler(c);
  };
}

/**
 * Builds the router.
 *
 * ── ROUTING IS ON THE RAW PATHNAME ──────────────────────────────────────────
 * Hono's default path extraction runs `decodeURI` over any path containing a
 * `%`, so `/v1/%70roducts` would route as `/v1/products`. The if-chain this
 * replaces compared `new URL(request.url).pathname`, which keeps percent
 * escapes, and every handler still parses that same raw pathname with its own
 * strict, safely-decoding parser. `getPath` is therefore pinned to the raw
 * pathname, so the router and the handlers agree on what path they are
 * looking at, and an encoded alias can never reach a handler the literal path
 * would not.
 *
 * ── ERRORS ARE NOT SWALLOWED ────────────────────────────────────────────────
 * Hono's default error handler turns a throw into a 500 response. The Stripe
 * webhook relies on the opposite: a D1 fault must surface as a failed
 * invocation so Stripe retries, and the test suite pins that the handler
 * REJECTS. `onError` rethrows, which makes `app.fetch` reject exactly as the
 * old handler did; the runtime's own opaque 500 is what a client sees.
 *
 * ── ORDER IS THE CONTRACT ───────────────────────────────────────────────────
 * Routes are tried in registration order, which is the order of the old
 * if-chain, and none of the prefixes overlap. The Stripe raw body is never
 * touched by the router: nothing here reads `c.req` beyond its method and URL.
 */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const publicStorefrontAllowed =
    options.publicStorefrontAllowed ?? PUBLIC_STOREFRONT_ALLOWED;
  const app = new Hono<AppEnv>({
    getPath: (request) => new URL(request.url).pathname,
  });

  app.onError((error) => {
    throw error;
  });
  app.notFound(() => notFoundResponse("Route not found"));

  // Both entrypoints strip every X-Tenant-* header before a request reaches
  // this app (src/lib/tenant-headers.ts). Seeing one here therefore means the
  // app was reached some other way — a new entrypoint, a refactor that skipped
  // the strip — and the only safe answer is the opaque 404. It also makes the
  // strip observable: the entrypoint tests prove a tenant header is served for
  // the HOSTNAME's tenant, which this guard makes impossible unless the header
  // was removed first.
  app.use("*", async (c, next) => {
    if (hasTenantHeader(c.req.raw.headers)) {
      return notFoundResponse("Route not found");
    }

    c.set("surface", options.surface);
    await next();
  });

  // Storefront routes answer the public entrypoint only while
  // PUBLIC_STOREFRONT_ALLOWED holds; see its TODO.
  const storefront =
    (handler: Endpoint): Endpoint =>
    (c) =>
      c.var.surface === "internal" || publicStorefrontAllowed
        ? handler(c)
        : notFoundResponse("Route not found");

  app.all(
    HEALTH_PATH,
    getOnly((c) =>
      jsonResponse({
        environment: c.env.APP_ENV,
        service: c.env.SERVICE_NAME,
        status: "ok",
      }),
    ),
  );

  app.all(
    READINESS_PATH,
    getOnly((c) => readinessResponse(c.env)),
  );

  // Public reads answer through the ETag/304 handlers (src/storefront/public-routes.ts):
  // bodies are byte-identical to the plain handlers, plus `ETag: "<catalog_version>"` and
  // If-None-Match → 304 (PLAN §2.4 catalog_version caching).
  app.all(
    STOREFRONT_PATH,
    getOnly(storefront((c) => handlePublicStorefrontRequest(c.env, c.req.raw))),
  );

  app.all(
    PRODUCTS_PATH,
    getOnly(storefront((c) => handlePublicProductsRequest(c.env, c.req.raw))),
  );

  app.all(
    `${PRODUCT_PATH_PREFIX}*`,
    getOnly(storefront((c) =>
      handlePublicProductRequest(
        c.env,
        c.req.raw,
        productIdFromPath(new URL(c.req.url).pathname),
      ),
    )),
  );

  // Exact match only: no prefix, no sub-paths, so a probe for
  // /v1/webhooks/stripe/anything is an ordinary 404 from the fallthrough.
  app.all(STRIPE_WEBHOOK_PATH, (c) =>
    handleStripeWebhookRoute(c.env, c.req.raw),
  );

  app.all(
    CHECKOUT_PATH,
    storefront((c) => handleCheckoutRoute(c.env, c.req.raw)),
  );
  // Before the checkout prefix below, whose handler knows only `/payment`.
  // Raw path segments, decoded once by the handler (see ACTING_AS_ROUTE).
  app.all(
    RECEIPT_CLAIM_ROUTE,
    storefront((c) =>
      handleReceiptClaimRoute(
        c.env,
        c.req.raw,
        new URL(c.req.url).pathname.split("/")[3] ?? "",
      ),
    ),
  );
  app.all(
    `${CHECKOUT_PATH_PREFIX}*`,
    storefront((c) =>
      handleCheckoutPaymentRoute(c.env, c.req.raw, new URL(c.req.url)),
    ),
  );

  app.all(
    BUYER_ORDER_ROUTE,
    storefront((c) =>
      handleBuyerOrderRoute(
        c.env,
        c.req.raw,
        new URL(c.req.url).pathname.split("/")[3] ?? "",
      ),
    ),
  );

  const adminProducts: Endpoint = (c) =>
    handleAdminProductRoute(c.env, c.req.raw, new URL(c.req.url));
  app.all(ADMIN_PRODUCTS_PATH, adminProducts);
  app.all(`${ADMIN_PRODUCT_PATH_PREFIX}*`, adminProducts);

  const adminObjects: Endpoint = (c) =>
    handleAdminObjectRoute(c.env, c.req.raw, new URL(c.req.url));
  app.all(ADMIN_OBJECTS_PATH, adminObjects);
  app.all(`${ADMIN_OBJECT_PATH_PREFIX}*`, adminObjects);

  const adminDiscountCodes: Endpoint = (c) =>
    handleAdminDiscountCodeRoute(c.env, c.req.raw, new URL(c.req.url));
  app.all(ADMIN_DISCOUNT_CODES_PATH, adminDiscountCodes);
  app.all(`${ADMIN_DISCOUNT_CODE_PATH_PREFIX}*`, adminDiscountCodes);

  const adminPod: Endpoint = (c) =>
    handleAdminPodRoute(c.env, c.req.raw, new URL(c.req.url));
  app.all(ADMIN_POD_PROFILES_PATH, adminPod);
  app.all(ADMIN_POD_ARTWORK_PATH, adminPod);
  app.all(`${ADMIN_POD_ARTWORK_PATH_PREFIX}*`, adminPod);

  app.all(PLATFORM_POD_PROFILES_PATH, (c) =>
    handlePlatformPodProfilesRoute(c.env, c.req.raw),
  );

  // The render farm's pull surface (PLAN §2.6): bearer-authenticated, no
  // session, no tenant hostname; the whole prefix is one handler so every path
  // under it shares the configuration gate, the limiter and the token check.
  app.all(`${RENDER_API_PATH_PREFIX}*`, (c) =>
    handleRenderJobsRoute(c.env, c.req.raw, new URL(c.req.url).pathname),
  );
  // Staging-only SnapWear stand-in; a 404 everywhere else (see the handler).
  app.all(FAKE_PRINTER_JOBS_PATH, (c) =>
    handleFakePrinterRoute(c.env, c.req.raw),
  );
  app.all(PLATFORM_BOOTSTRAP_PATH, (c) =>
    handlePlatformBootstrapRoute(c.env, c.req.raw),
  );
  app.all(PLATFORM_USERS_PATH, (c) =>
    handlePlatformUserRoute(c.env, c.req.raw),
  );

  // Before the generic tenant prefix below, which would otherwise claim this
  // path and answer it as an unknown tenant action. The tenant segment is taken
  // from the RAW pathname rather than `c.req.param()`, which percent-decodes:
  // the handler decodes exactly once, with the same rules as every other
  // tenant-id path, so `%2561` can never become `a` by being decoded twice.
  app.all(ACTING_AS_ROUTE, (c) =>
    handleActingAsRoute(
      c.env,
      c.req.raw,
      new URL(c.req.url).pathname.split("/")[4] ?? "",
    ),
  );

  // ── CP2 route mounts. Each CP2 builder appends ONLY inside its own anchor
  // block; the reviewer consolidates after merge. ──────────────────────────
  // CP2-ROUTES-A (money: refunds, payouts) — begin
  // Exact patterns only (no prefix wildcard), so CP2-B's
  // /v1/admin/orders/:orderId/cancel stays theirs. The order segment is taken
  // from the RAW pathname and decoded once by the handler (see ACTING_AS_ROUTE).
  app.all(ADMIN_ORDER_ROUTE, (c) =>
    handleAdminOrderRoute(
      c.env,
      c.req.raw,
      new URL(c.req.url).pathname.split("/")[4] ?? "",
    ),
  );
  app.all(ADMIN_ORDER_REFUNDS_ROUTE, (c) =>
    handleAdminOrderRefundsRoute(
      c.env,
      c.req.raw,
      new URL(c.req.url).pathname.split("/")[4] ?? "",
    ),
  );
  // CP2-ROUTES-A — end
  // CP2-ROUTES-B (outbox/dispatch: manual resolution, cancellation) — begin
  // Exact patterns only; the id segment is taken from the RAW pathname and
  // decoded once by the handler (see ACTING_AS_ROUTE).
  app.all(ADMIN_ORDER_CANCEL_ROUTE, (c) =>
    handleAdminOrderCancelRoute(
      c.env,
      c.req.raw,
      new URL(c.req.url).pathname.split("/")[4] ?? "",
    ),
  );
  app.all(PLATFORM_DISPATCH_PATH, (c) =>
    handlePlatformDispatchListRoute(c.env, c.req.raw),
  );
  app.all(PLATFORM_DISPATCH_RESOLVE_ROUTE, (c) =>
    handlePlatformDispatchResolveRoute(
      c.env,
      c.req.raw,
      new URL(c.req.url).pathname.split("/")[4] ?? "",
    ),
  );
  // CP2-ROUTES-B — end
  // CP2-ROUTES-C (POD product path: mappings, publish, quote) — begin
  // Exact paths or prefixes no earlier route claims (the admin POD artwork
  // routes are exact paths + the artwork prefix; /v1/storefront is exact).
  const adminPodProduct: Endpoint = (c) =>
    handleAdminPodProductRoute(c.env, c.req.raw);
  app.all(ADMIN_POD_PRINTERS_PATH, adminPodProduct);
  app.all(ADMIN_POD_QUOTE_PATH, adminPodProduct);
  app.all(ADMIN_POD_MAPPINGS_PATH, adminPodProduct);
  app.all(`${ADMIN_POD_MAPPING_PATH_PREFIX}*`, adminPodProduct);
  app.all(PLATFORM_PRINTERS_PATH, (c) =>
    handlePlatformPrintersRoute(c.env, c.req.raw),
  );
  const platformScreening: Endpoint = (c) =>
    handlePlatformScreeningRoute(c.env, c.req.raw);
  app.all(PLATFORM_SCREENING_PATH, platformScreening);
  app.all(`${PLATFORM_SCREENING_PATH_PREFIX}*`, platformScreening);
  // A storefront route: tenant by hostname, same public-entrypoint rule.
  app.all(
    `${STOREFRONT_POD_PREVIEWS_PREFIX}*`,
    storefront((c) => handlePodPreviewRoute(c.env, c.req.raw)),
  );
  // CP2-ROUTES-C — end

  const platformTenants: Endpoint = (c) =>
    handlePlatformTenantRoute(c.env, c.req.raw, new URL(c.req.url));
  app.all(PLATFORM_TENANTS_PATH, platformTenants);
  app.all(`${PLATFORM_TENANT_PATH_PREFIX}*`, platformTenants);

  // The Better Auth namespace was the if-chain's last resort: tried for every
  // path nothing above claimed, answering null for anything outside
  // /api/auth/. The catch-all keeps that exact shape.
  app.all("*", async (c) => {
    const authResponse = await handleAuthRoute(
      c.env,
      c.req.raw,
      new URL(c.req.url),
    );
    return authResponse ?? notFoundResponse("Route not found");
  });

  return app;
}
