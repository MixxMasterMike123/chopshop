import type { Site } from "./routing";

/**
 * The answer of `GET /v1/seo?path=` (CP4 brief D, D88), checked field by field
 * before anything of it reaches a header or a page, and the rules that turn a
 * path relative to the shop's root into an address.
 *
 * Anything that does not have the documented shape is treated as no answer:
 * the page is then served without a head of its own, never broken by it.
 */

/** Brief E rule 3: the head of a page never waits longer than this. */
export const SEO_DEADLINE_MS = 1_500;

export interface SeoImage {
  height: number | null;
  url: string;
  width: number | null;
}

export interface SeoPage {
  bodyHtml: string | null;
  canonicalPath: string | null;
  description: string | null;
  image: SeoImage | null;
  jsonLd: unknown;
  robots: string | null;
  title: string;
}

export type SeoAnswer =
  | { kind: "page"; page: SeoPage }
  | { kind: "redirect"; to: string };

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 1_000;
const MAX_ROBOTS = 100;
const MAX_BODY_HTML = 200_000;
const MAX_PATH = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function dimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000
    ? value
    : null;
}

function parseImage(value: unknown): SeoImage | null {
  if (!isRecord(value) || typeof value.url !== "string" || value.url.length > MAX_PATH) {
    return null;
  }
  return { height: dimension(value.height), url: value.url, width: dimension(value.width) };
}

export function parseSeoAnswer(body: unknown): SeoAnswer | null {
  if (!isRecord(body)) {
    return null;
  }

  if (isRecord(body.redirect)) {
    const { status, to } = body.redirect;
    return status === 301 && typeof to === "string" && to.length <= MAX_PATH
      ? { kind: "redirect", to }
      : null;
  }

  if (!isRecord(body.page)) {
    return null;
  }
  const page = body.page;
  const title = page.title;
  const description = optionalString(page.description, MAX_DESCRIPTION);
  const canonicalPath = optionalString(page.canonicalPath, MAX_PATH);
  const robots = optionalString(page.robots, MAX_ROBOTS);
  const bodyHtml = optionalString(page.bodyHtml, MAX_BODY_HTML);
  if (
    typeof title !== "string" ||
    title.length > MAX_TITLE ||
    description === undefined ||
    canonicalPath === undefined ||
    robots === undefined ||
    bodyHtml === undefined
  ) {
    return null;
  }

  return {
    kind: "page",
    page: {
      bodyHtml,
      canonicalPath,
      description,
      image: parseImage(page.image),
      jsonLd: page.jsonLd ?? null,
      robots,
      title,
    },
  };
}

// A path relative to the shop's root, as the API writes it: one leading
// slash, no second (a `//host` is an address on another site), no backslash
// (browsers read `/\host` as `//host`), no whitespace or control character.
const RELATIVE_PATH = /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/;

/**
 * The absolute address of a path relative to the shop's root, or null when it
 * would leave that root. The path is resolved as a browser would resolve it
 * (dot segments included), and the result must still be on `origin` and, on
 * the shared host, under `/<shop>`: `/../other-shop/x` is refused.
 */
export function shopUrl(origin: string, site: Site, relative: string): URL | null {
  if (relative.length > MAX_PATH || !RELATIVE_PATH.test(relative)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(`${site.root}${relative}`, origin);
  } catch {
    return null;
  }

  const underRoot =
    site.root === "" ||
    url.pathname === site.root ||
    url.pathname.startsWith(`${site.root}/`);
  return url.origin === origin && underRoot ? url : null;
}

/** The `Location` of a forward: always a path under the shop's own root. */
export function redirectLocation(origin: string, site: Site, to: string): string | null {
  const url = shopUrl(origin, site, to);
  return url === null ? null : `${url.pathname}${url.search}${url.hash}`;
}

const MAX_JSON_LD_DEPTH = 32;

/**
 * JSON-LD with every `{ "@relative": "<path>" }` replaced by the absolute
 * address of that path (brief D: the API writes relative paths, the caller
 * makes them absolute). A relative path that would leave the shop's root
 * becomes null. Deeper than 32 levels ⇒ the whole block is dropped (null).
 */
export function absolutizeJsonLd(
  value: unknown,
  resolve: (relative: string) => string | null,
): unknown {
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_LD_DEPTH) {
      throw new RangeError("JSON-LD too deep");
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }
    if (!isRecord(node)) {
      return node;
    }

    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === "@relative") {
      const relative = node["@relative"];
      return typeof relative === "string" ? resolve(relative) : null;
    }

    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = walk(node[key], depth + 1);
    }
    return out;
  };

  try {
    return walk(value, 0);
  } catch {
    return null;
  }
}

/**
 * Resolves with the promise's value, or with "timeout" once `ms` has passed.
 * A late rejection of the promise is swallowed: the caller has moved on.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  promise.catch(() => undefined);

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
