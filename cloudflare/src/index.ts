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
import { jsonResponse } from "./lib/http";
import { clientIp, enforceRateLimit } from "./lib/rate-limit";
import {
  authorizePlatformRequest,
  authorizeTenantAdminRequest,
} from "./auth/request-authorization";
import { handleAuthRoute } from "./auth/auth-routes";
import { handleDisabledAuthEmailQueue } from "./email/disabled-email-queue";
import { getPublicStorefront } from "./storefront/public-storefront";
import { isSameOriginRequest } from "./lib/same-origin";
import { resolveRequestTenant } from "./tenancy/resolve-tenant";

const HEALTH_PATH = "/health";
const READINESS_PATH = "/ready";
const STOREFRONT_PATH = "/v1/storefront";
const PRODUCTS_PATH = "/v1/products";
const PRODUCT_PATH_PREFIX = "/v1/products/";
const CHECKOUT_PATH = "/v1/checkout";
const ADMIN_PRODUCTS_PATH = "/v1/admin/products";
const ADMIN_PRODUCT_PATH_PREFIX = "/v1/admin/products/";
const ADMIN_OBJECTS_PATH = "/v1/admin/objects";
const ADMIN_OBJECT_PATH_PREFIX = "/v1/admin/objects/";
const PLATFORM_TENANTS_PATH = "/v1/platform/tenants";
const PLATFORM_TENANT_PATH_PREFIX = "/v1/platform/tenants/";
const PLATFORM_BOOTSTRAP_PATH = "/v1/platform/bootstrap";
const REQUIRED_MIGRATION = "0009_checkout_totals_v2.sql";

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

// A cheap shield in front of the bootstrap token compare. Legitimate use of
// that route is one successful call in the lifetime of the platform, so five
// attempts per ten minutes is generous for an operator and hostile to a
// brute-force.
export const BOOTSTRAP_IP_SCOPE = "bootstrap-ip";
export const BOOTSTRAP_IP_LIMIT = 5;
export const BOOTSTRAP_IP_WINDOW_MS = 10 * MINUTE_MS;

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

function notFoundResponse(message: string): Response {
  return jsonResponse(
    {
      error: {
        code: "not_found",
        message,
      },
    },
    404,
  );
}

function adminNotFoundResponse(): Response {
  return notFoundResponse("Route not found");
}

function invalidRequestResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "invalid_request",
        message: "Request is not valid",
      },
    },
    400,
  );
}

/**
 * The message names no limit, no window and no remaining allowance: telling a
 * caller which of several limits it tripped would let it map the limiter and
 * tune around it. Retry-After is the one hint given, because an honest client
 * needs it to back off correctly.
 */
function rateLimitedResponse(retryAfterSeconds: number): Response {
  const response = jsonResponse(
    {
      error: {
        code: "rate_limited",
        message: "Too many requests",
      },
    },
    429,
  );

  response.headers.set("Retry-After", retryAfterSeconds.toString());
  return response;
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
  if (result.status === "conflict") {
    return conflictResponse();
  }
  if (result.status === "invalid") {
    return invalidRequestResponse();
  }
  return adminNotFoundResponse();
}

function decodeSegment(segment: string): string | null {
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

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json<unknown>();
  } catch {
    return undefined;
  }
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

  const result = await createCheckout(env.DB, tenant, input, now);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === HEALTH_PATH) {
      return jsonResponse({
        environment: env.APP_ENV,
        service: env.SERVICE_NAME,
        status: "ok",
      });
    }

    if (request.method === "GET" && url.pathname === READINESS_PATH) {
      return readinessResponse(env);
    }

    if (request.method === "GET" && url.pathname === STOREFRONT_PATH) {
      const tenant = await resolveRequestTenant(env.DB, request);
      if (tenant !== null) {
        const storefront = await getPublicStorefront(env.DB, tenant);
        if (storefront !== null) {
          return jsonResponse({ storefront });
        }
      }

      return notFoundResponse("Storefront not found");
    }

    if (request.method === "GET" && url.pathname === PRODUCTS_PATH) {
      const tenant = await resolveRequestTenant(env.DB, request);
      if (tenant === null) {
        return notFoundResponse("Products not found");
      }

      const products = await listPublicProducts(env.DB, tenant);
      return jsonResponse({ products });
    }

    if (request.method === "GET" && url.pathname.startsWith(PRODUCT_PATH_PREFIX)) {
      const productId = productIdFromPath(url.pathname);
      if (productId !== null) {
        const tenant = await resolveRequestTenant(env.DB, request);
        if (tenant !== null) {
          const product = await getPublicProduct(env.DB, tenant, productId);
          if (product !== null) {
            return jsonResponse({ product });
          }
        }
      }

      return notFoundResponse("Product not found");
    }

    if (url.pathname === CHECKOUT_PATH) {
      return handleCheckoutRoute(env, request);
    }

    if (
      url.pathname === ADMIN_PRODUCTS_PATH ||
      url.pathname.startsWith(ADMIN_PRODUCT_PATH_PREFIX)
    ) {
      return handleAdminProductRoute(env, request, url);
    }

    if (
      url.pathname === ADMIN_OBJECTS_PATH ||
      url.pathname.startsWith(ADMIN_OBJECT_PATH_PREFIX)
    ) {
      return handleAdminObjectRoute(env, request, url);
    }

    if (url.pathname === PLATFORM_BOOTSTRAP_PATH) {
      return handlePlatformBootstrapRoute(env, request);
    }

    if (
      url.pathname === PLATFORM_TENANTS_PATH ||
      url.pathname.startsWith(PLATFORM_TENANT_PATH_PREFIX)
    ) {
      return handlePlatformTenantRoute(env, request, url);
    }

    const authResponse = await handleAuthRoute(env, request, url);
    if (authResponse !== null) {
      return authResponse;
    }

    return notFoundResponse("Route not found");
  },

  queue(batch: MessageBatch<unknown>): void {
    handleDisabledAuthEmailQueue(batch);
  },
} satisfies ExportedHandler<Env>;
