import type { WebConfig, WebEnv } from "./env";
import { readWebConfig } from "./env";
import {
  apiResponseForBrowser,
  forwardedApiRequest,
  isPreviewRead,
  workerApiRequest,
} from "./forward";
import { withSecurityHeaders } from "./headers";
import type { PageHead } from "./html";
import { renderShell, sanitizeBodyHtml } from "./html";
import type { Site } from "./routing";
import { classifyRequest } from "./routing";
import type { SeoAnswer, SeoPage } from "./seo";
import {
  absolutizeJsonLd,
  parseSeoAnswer,
  redirectLocation,
  SEO_DEADLINE_MS,
  shopUrl,
  withDeadline,
} from "./seo";
import type { SitemapEntry } from "./sitemap";
import {
  buildRobotsTxt,
  buildSitemapXml,
  MAX_SITEMAP_PAGES,
  parseSitemapPage,
  SITEMAP_DEADLINE_MS,
} from "./sitemap";

/**
 * chopshop-web — the storefront's Worker (CP4 brief E, D77, D88).
 *
 * Every decision is made by the pure modules beside this file and tested
 * there (cloudflare/test/web-*.test.ts); this file is the glue that calls
 * them in order and the bindings. The table of what happens to which request
 * is in docs/cf-port/CP4_E_REPORT.md.
 */

export interface HandleOptions {
  /** The SEO call's deadline; tests shorten it. */
  seoDeadlineMs?: number;
}

const SHELL_PATH = "/index.html";
const IMMUTABLE = "public, max-age=31536000, immutable";

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    status,
  });
}

function textResponse(body: string, status: number, contentType: string, cache: string): Response {
  return new Response(body, {
    headers: { "Cache-Control": cache, "Content-Type": contentType },
    status,
  });
}

function notFound(): Response {
  return textResponse("Not found\n", 404, "text/plain; charset=utf-8", "no-store");
}

/** The origin addresses are built on: the pinned one on the shared host. */
function siteOrigin(config: WebConfig, url: URL, site: Site): string {
  return site.shop === null ? `https://${url.host}` : config.webOrigin;
}

/** Calls the API for `site` over the binding (D77). */
function callApi(env: WebEnv, site: Site, request: Request): Promise<Response> {
  return site.shop === null
    ? env.API.fetch(request)
    : env.API.fetchForShop(site.shop, request);
}

async function readJson(env: WebEnv, site: Site, request: Request): Promise<{ body: unknown; status: number }> {
  const response = await callApi(env, site, request);
  if (response.status !== 200) {
    await response.body?.cancel();
    return { body: null, status: response.status };
  }
  return { body: await response.json<unknown>(), status: 200 };
}

/**
 * The SEO answer; "none" when the API answered 404 (no public page at this
 * address — every address of an unpublished shop), null when there is no
 * answer to go by (slow, failing, malformed).
 */
async function seoAnswer(
  env: WebEnv,
  site: Site,
  origin: string,
  relativePath: string,
  visitor: string | null,
  deadlineMs: number,
): Promise<SeoAnswer | "none" | null> {
  const target = `${origin}/v1/seo?path=${encodeURIComponent(relativePath)}`;
  const call = readJson(env, site, workerApiRequest(target, visitor)).then((result) =>
    result.status === 200 ? parseSeoAnswer(result.body) : result.status === 404 ? ("none" as const) : null,
  );
  // A slow, failing or malformed answer is no answer: the page still opens.
  const answer = await withDeadline(call, deadlineMs).catch(() => null);
  return answer === "timeout" ? null : answer;
}

async function renderedPage(
  page: SeoPage,
  config: WebConfig,
  origin: string,
  site: Site,
): Promise<{ bodyHtml: string | null; head: PageHead }> {
  const absolute = (relative: string): string | null =>
    shopUrl(origin, site, relative)?.toString() ?? null;
  const imageUrl =
    page.image !== null &&
    config.publicObjectOrigin !== null &&
    page.image.url.startsWith(`${config.publicObjectOrigin}/`)
      ? page.image.url
      : null;

  return {
    bodyHtml:
      page.bodyHtml === null
        ? null
        : await sanitizeBodyHtml(page.bodyHtml, {
            linkPath: (relative) => shopUrl(origin, site, relative)?.pathname ?? null,
            publicObjectOrigin: config.publicObjectOrigin,
          }),
    head: {
      canonicalUrl: page.canonicalPath === null ? null : absolute(page.canonicalPath),
      description: page.description,
      imageUrl,
      jsonLd: page.jsonLd === null ? null : absolutizeJsonLd(page.jsonLd, absolute),
      robots: page.robots,
      title: page.title,
    },
  };
}

function htmlResponse(response: Response, status: number, noindex = false): Response {
  const headers = new Headers({
    "Cache-Control": "no-cache",
    "Content-Type": "text/html; charset=utf-8",
  });
  if (noindex) {
    headers.set("X-Robots-Tag", "noindex");
  }
  return new Response(response.body, { headers, status });
}

async function servePage(
  request: Request,
  env: WebEnv,
  config: WebConfig,
  url: URL,
  site: Site,
  relativePath: string,
  options: HandleOptions,
): Promise<Response> {
  const origin = siteOrigin(config, url, site);
  // Fetched while the head is asked for, not after.
  const shell = env.ASSETS.fetch(new Request(new URL(SHELL_PATH, url))).catch(() => null);
  const answer = await seoAnswer(
    env,
    site,
    origin,
    relativePath,
    request.headers.get("cf-connecting-ip"),
    options.seoDeadlineMs ?? SEO_DEADLINE_MS,
  );

  if (answer !== "none" && answer?.kind === "redirect") {
    const location = redirectLocation(origin, site, answer.to);
    if (location !== null) {
      void shell.then((unused) => unused?.body?.cancel());
      return new Response(null, {
        headers: { "Cache-Control": "no-cache", Location: location },
        status: 301,
      });
    }
  }

  const shellResponse = await shell;
  if (shellResponse === null || !shellResponse.ok) {
    return textResponse("Unavailable\n", 503, "text/plain; charset=utf-8", "no-store");
  }

  const page =
    answer !== "none" && answer?.kind === "page"
      ? await renderedPage(answer.page, config, origin, site)
      : null;
  // The API said there is no public page here: an address of an unpublished
  // shop (D57: its preview is opened at such an address, with the grant in the
  // fragment, which this Worker never sees), a cart, an unknown path. Such a
  // shell is never one to index. A slow or failing answer says nothing, and
  // the shell keeps the default.
  return htmlResponse(renderShell(shellResponse, site.root, page), 200, answer === "none");
}

async function serveSitemap(
  request: Request,
  env: WebEnv,
  config: WebConfig,
  url: URL,
  site: Site,
): Promise<Response> {
  const origin = siteOrigin(config, url, site);
  const visitor = request.headers.get("cf-connecting-ip");
  const entries: SitemapEntry[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_SITEMAP_PAGES; page += 1) {
    const target: string = `${origin}/v1/sitemap${
      cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`
    }`;
    const result = await withDeadline(
      readJson(env, site, workerApiRequest(target, visitor)),
      SITEMAP_DEADLINE_MS,
    ).catch(() => null);
    if (result === null || result === "timeout") {
      return textResponse("Unavailable\n", 503, "text/plain; charset=utf-8", "no-store");
    }
    if (result.status === 404) {
      return notFound();
    }
    const parsed = result.status === 200 ? parseSitemapPage(result.body) : null;
    if (parsed === null) {
      return textResponse("Unavailable\n", 503, "text/plain; charset=utf-8", "no-store");
    }
    entries.push(...parsed.entries);
    cursor = parsed.nextCursor;
    if (cursor === null) {
      break;
    }
  }

  const xml = buildSitemapXml(entries, (relative) => shopUrl(origin, site, relative)?.toString() ?? null);
  return textResponse(xml, 200, "application/xml; charset=utf-8", "public, max-age=3600");
}

async function serveStatic(request: Request, env: WebEnv, url: URL): Promise<Response | null> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
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
  env: WebEnv,
  config: WebConfig,
  url: URL,
  site: Site,
  apiPath: string,
): Promise<Response> {
  const target = `${siteOrigin(config, url, site)}${apiPath}${url.search}`;
  // The forwarded path must be the path that was matched, byte for byte.
  if (new URL(target).pathname !== apiPath) {
    return jsonError("not_found", "Route not found", 404);
  }
  try {
    return apiResponseForBrowser(
      await callApi(env, site, forwardedApiRequest(request, target)),
      isPreviewRead(request),
    );
  } catch {
    return jsonError("unavailable", "The shop could not be reached", 502);
  }
}

export async function handleRequest(
  request: Request,
  env: WebEnv,
  options: HandleOptions = {},
): Promise<Response> {
  const config = readWebConfig(env);
  if (config === null) {
    return textResponse("Unavailable\n", 503, "text/plain; charset=utf-8", "no-store");
  }

  const url = new URL(request.url);
  const shared = url.host === config.webHost;
  const route = classifyRequest(request.method, url.pathname, shared);

  let response: Response;
  switch (route.kind) {
    case "api":
      response = await serveApi(request, env, config, url, route.site, route.apiPath);
      break;
    case "api_refused":
      response = jsonError("not_found", "Route not found", 404);
      break;
    case "robots":
      response = textResponse(
        buildRobotsTxt(shared ? null : `https://${url.host}/sitemap.xml`),
        200,
        "text/plain; charset=utf-8",
        "public, max-age=3600",
      );
      break;
    case "sitemap":
      response = await serveSitemap(request, env, config, url, route.site);
      break;
    case "static": {
      const found = await serveStatic(request, env, url);
      response =
        found ??
        (route.orPage === null
          ? notFound()
          : await servePage(request, env, config, url, route.orPage.site, route.orPage.relativePath, options));
      break;
    }
    case "page":
      response = await servePage(request, env, config, url, route.site, route.relativePath, options);
      break;
    case "no_shop": {
      const shell = await env.ASSETS.fetch(new Request(new URL(SHELL_PATH, url)));
      response = shell.ok ? htmlResponse(renderShell(shell, null, null), 404) : notFound();
      break;
    }
    case "not_found":
      response = notFound();
      break;
  }

  return withSecurityHeaders(response, config.publicObjectOrigin);
}

export default {
  fetch(request: Request, env: WebEnv): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<WebEnv>;
