import type { AdminConfig, AdminEnv } from "./env";
import { readAdminConfig } from "./env";
import { apiResponseForBrowser, forwardedAdminRequest } from "./forward";
import { withAdminHeaders } from "./headers";
import { classifyAdminRequest } from "./routing";

/**
 * chopshop-admin — the admin's and the platform console's Worker (CP5 brief
 * WX, D102). It serves the admin build (vite.admin.config.js →
 * cloudflare/admin/dist) and is a same-origin proxy from `/_api/…` to the API's
 * `Internal` entrypoint over a service binding, with the session cookie.
 *
 * Every decision is made by the pure modules beside this file and tested
 * (cloudflare/test/admin-worker-*.test.ts); this file is the glue. The table of
 * what happens to which request is in docs/cf-port/CP5_WX_REPORT.md.
 */

const SHELL_PATH = "/index.html";
const IMMUTABLE = "public, max-age=31536000, immutable";
const ROBOTS = "User-agent: *\nDisallow: /\n";

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    status,
  });
}

function textResponse(body: string, status: number, cache: string): Response {
  return new Response(body, {
    headers: { "Cache-Control": cache, "Content-Type": "text/plain; charset=utf-8" },
    status,
  });
}

function notFound(): Response {
  return textResponse("Not found\n", 404, "no-store");
}

async function serveShell(env: AdminEnv, url: URL): Promise<Response> {
  const shell = await env.ASSETS.fetch(new Request(new URL(SHELL_PATH, url))).catch(() => null);
  if (shell === null || !shell.ok) {
    await shell?.body?.cancel();
    return textResponse("Unavailable\n", 503, "no-store");
  }
  return new Response(shell.body, {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
    status: 200,
  });
}

async function serveStatic(request: Request, env: AdminEnv, url: URL): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) {
    await response.body?.cancel();
    return notFound();
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", url.pathname.startsWith("/assets/") ? IMMUTABLE : "no-cache");
  return new Response(response.status === 304 ? null : response.body, {
    headers,
    status: response.status,
  });
}

async function serveApi(
  request: Request,
  env: AdminEnv,
  config: AdminConfig,
  url: URL,
  apiPath: string,
): Promise<Response> {
  // The browser's own origin (it is the admin origin: checked before routing).
  const target = `${config.adminOrigin}${apiPath}${url.search}`;
  // The forwarded path must be the path that was matched, byte for byte.
  if (new URL(target).pathname !== apiPath) {
    return jsonError("not_found", "Route not found", 404);
  }
  try {
    return apiResponseForBrowser(await env.API.fetch(forwardedAdminRequest(request, target)));
  } catch {
    return jsonError("unavailable", "The service could not be reached", 502);
  }
}

async function route(request: Request, env: AdminEnv, config: AdminConfig, url: URL): Promise<Response> {
  if (url.host !== config.adminHost) {
    return notFound();
  }
  if (url.origin !== config.adminOrigin) {
    // The admin host over plain http: a navigation is sent to https; nothing
    // else is answered (the session cookie is Secure and never travels here).
    return request.method === "GET" && !url.pathname.startsWith("/_api")
      ? new Response(null, {
          headers: { "Cache-Control": "no-store", Location: `${config.adminOrigin}${url.pathname}${url.search}` },
          status: 301,
        })
      : notFound();
  }

  const decision = classifyAdminRequest(request.method, url.pathname);
  switch (decision.kind) {
    case "api":
      return serveApi(request, env, config, url, decision.apiPath);
    case "api_refused":
      return jsonError("not_found", "Route not found", 404);
    case "robots":
      return textResponse(ROBOTS, 200, "public, max-age=3600");
    case "static":
      return serveStatic(request, env, url);
    case "shell":
      return serveShell(env, url);
    case "not_found":
      return notFound();
  }
}

export async function handleRequest(request: Request, env: AdminEnv): Promise<Response> {
  const config = readAdminConfig(env);
  if (config === null) {
    return withAdminHeaders(textResponse("Unavailable\n", 503, "no-store"), null);
  }

  const url = new URL(request.url);
  return withAdminHeaders(await route(request, env, config, url), config.publicObjectOrigin);
}

export default {
  fetch(request: Request, env: AdminEnv): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<AdminEnv>;
