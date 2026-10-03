/**
 * The per-environment canonical origin allowlist (PLAN §2.1).
 *
 * Every link this API puts in front of a person — a password-reset email today,
 * verification and receipt links later — is built from these origins and from
 * nothing else. In particular a link is NEVER built from the request's `Origin`
 * or `Host`: those are caller-controlled, and a reset link that followed them
 * would mail a victim a working token pointing at an attacker's host.
 *
 * `CANONICAL_ORIGINS` is a JSON object var, `{ "api": "https://…", "web":
 * "https://…", "admin": "https://…" }`. Wrangler hands an object var to the
 * Worker as an object; a JSON STRING is accepted too, so a var set through a
 * string-only channel cannot silently disable the surfaces that depend on it.
 *
 * `api` and `web` are required. `admin` (CP5: the admin Worker's host, where a
 * shop's admins and the platform console sign in) is optional while the
 * deployed configs do not list it yet; `platform` is optional too and, when
 * absent, IS the admin origin (D102: one host serves the admin and the
 * platform console). `platform` without `admin` is refused: the platform
 * console is served by the admin Worker, so there is no platform host without
 * an admin host.
 *
 * Validation is strict and fails closed. Each value must be exactly an https
 * origin — scheme, host, optional port, and nothing else: no path (not even a
 * trailing slash), no query, no fragment, no credentials, and already in the
 * canonical lowercase form `URL` would produce. An unknown key is refused
 * rather than ignored, so a typo in the var surfaces as a dark feature instead
 * of a link built from a default.
 */

export type CanonicalSurface = "admin" | "api" | "platform" | "web";

/**
 * `admin` and `platform` are both present or both absent: a parsed value that
 * lists `admin` always carries `platform` (the admin origin when the var does
 * not name one).
 */
export interface CanonicalOrigins {
  readonly admin?: string;
  readonly api: string;
  readonly platform?: string;
  readonly web: string;
}

const SURFACES: readonly CanonicalSurface[] = ["admin", "api", "platform", "web"];

export class CanonicalOriginsError extends Error {
  constructor(message: string) {
    super(`CANONICAL_ORIGINS ${message}`);
    this.name = "CanonicalOriginsError";
  }
}

function parseOrigin(surface: CanonicalSurface, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CanonicalOriginsError(`.${surface} must be a non-empty string`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CanonicalOriginsError(`.${surface} is not a URL`);
  }

  if (url.protocol !== "https:") {
    throw new CanonicalOriginsError(`.${surface} must use https`);
  }

  // `url.origin === value` rejects, in one comparison: any path including a
  // bare trailing slash, a query, a fragment, userinfo, an explicit default
  // port, and any non-canonical spelling of the host.
  if (url.origin !== value) {
    throw new CanonicalOriginsError(`.${surface} must be a bare origin`);
  }

  return url.origin;
}

/**
 * Parses and validates the var. Throws CanonicalOriginsError on anything that
 * is not `{ api, web }` plus, optionally, `admin` and `platform`, each a bare
 * https origin.
 */
export function parseCanonicalOrigins(raw: unknown): CanonicalOrigins {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new CanonicalOriginsError("is not valid JSON");
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CanonicalOriginsError("must be an object");
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SURFACES as readonly string[]).includes(key)) {
      throw new CanonicalOriginsError(`has an unknown key "${key}"`);
    }
  }

  const api = parseOrigin("api", record.api);
  const web = parseOrigin("web", record.web);
  if (record.admin === undefined) {
    if (record.platform !== undefined) {
      throw new CanonicalOriginsError("lists platform without admin");
    }
    return Object.freeze({ api, web });
  }

  const admin = parseOrigin("admin", record.admin);
  const platform =
    record.platform === undefined ? admin : parseOrigin("platform", record.platform);
  return Object.freeze({ admin, api, platform, web });
}

/**
 * The canonical origin for one surface. Throws when the var is missing or
 * malformed, or does not list the surface; callers that must fail closed
 * without throwing use `readCanonicalOrigins`.
 */
export function canonicalOrigin(env: Env, surface: CanonicalSurface): string {
  const origin = parseCanonicalOrigins(env.CANONICAL_ORIGINS)[surface];
  if (origin === undefined) {
    throw new CanonicalOriginsError(`does not list ${surface}`);
  }
  return origin;
}

/**
 * The validated origins, or null when the var is missing or malformed. For the
 * route gates: a surface that needs a link it cannot build safely answers the
 * same 404 as a surface that was never deployed.
 */
export function readCanonicalOrigins(env: Env): CanonicalOrigins | null {
  try {
    return parseCanonicalOrigins(env.CANONICAL_ORIGINS);
  } catch {
    return null;
  }
}
