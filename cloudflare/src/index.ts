import type { AdminCatalogResult } from "./catalog/admin-catalog";
import {
  createAdminProduct,
  parseCreateProductInput,
  parseUpdateProductInput,
  publishAdminProduct,
  unpublishAdminProduct,
  updateAdminProduct,
} from "./catalog/admin-catalog";
import {
  getPublicProduct,
  listPublicProducts,
} from "./catalog/public-catalog";
import { jsonResponse } from "./lib/http";
import { authorizeTenantAdminRequest } from "./auth/request-authorization";
import { handleDisabledAuthEmailQueue } from "./email/disabled-email-queue";
import { getPublicStorefront } from "./storefront/public-storefront";
import { isSameOriginRequest } from "./lib/same-origin";
import { resolveRequestTenant } from "./tenancy/resolve-tenant";

const HEALTH_PATH = "/health";
const READINESS_PATH = "/ready";
const STOREFRONT_PATH = "/v1/storefront";
const PRODUCTS_PATH = "/v1/products";
const PRODUCT_PATH_PREFIX = "/v1/products/";
const ADMIN_PRODUCTS_PATH = "/v1/admin/products";
const ADMIN_PRODUCT_PATH_PREFIX = "/v1/admin/products/";
const REQUIRED_MIGRATION = "0005_catalogue.sql";

type AdminProductAction = "publish" | "unpublish";

interface AdminProductRoute {
  action: AdminProductAction | null;
  productId: string;
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

    if (
      url.pathname === ADMIN_PRODUCTS_PATH ||
      url.pathname.startsWith(ADMIN_PRODUCT_PATH_PREFIX)
    ) {
      return handleAdminProductRoute(env, request, url);
    }

    return notFoundResponse("Route not found");
  },

  queue(batch: MessageBatch<unknown>): void {
    handleDisabledAuthEmailQueue(batch);
  },
} satisfies ExportedHandler<Env>;
