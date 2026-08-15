import { jsonResponse } from "./lib/http";
import { handleDisabledAuthEmailQueue } from "./email/disabled-email-queue";
import { getPublicStorefront } from "./storefront/public-storefront";
import { resolveRequestTenant } from "./tenancy/resolve-tenant";

const HEALTH_PATH = "/health";
const READINESS_PATH = "/ready";
const STOREFRONT_PATH = "/v1/storefront";
const REQUIRED_MIGRATION = "0004_email_delivery_fingerprint.sql";

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

      return jsonResponse(
        {
          error: {
            code: "not_found",
            message: "Storefront not found",
          },
        },
        404,
      );
    }

    return jsonResponse(
      {
        error: {
          code: "not_found",
          message: "Route not found",
        },
      },
      404,
    );
  },

  queue(batch: MessageBatch<unknown>): void {
    handleDisabledAuthEmailQueue(batch);
  },
} satisfies ExportedHandler<Env>;
