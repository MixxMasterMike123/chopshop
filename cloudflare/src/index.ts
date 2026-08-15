import { jsonResponse } from "./lib/http";

const HEALTH_PATH = "/health";

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
} satisfies ExportedHandler<Env>;
