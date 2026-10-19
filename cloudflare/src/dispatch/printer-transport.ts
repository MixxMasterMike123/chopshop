/**
 * What every printer client's transport shares (CP11): the fetch seam's type,
 * the one origin rule and the one token rule its gate applies, and the
 * submission timeout. Its own module so the provider clients
 * (printer-client.ts, prodigi-client.ts) share it without importing each
 * other.
 */

export type PrinterFetch = (request: Request) => Promise<Response>;

/** One submission waits this long; then it is `unknown` "network". */
export const PRINTER_SUBMIT_TIMEOUT_MS = 30_000;

/**
 * Printable ASCII without spaces, 16–512 characters: a value a header can
 * carry unchanged, and long enough that a placeholder ("x", "changeme") is
 * not mistaken for a credential.
 */
export const PRINTER_API_TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/;

/**
 * A bare https origin and nothing else: no credentials, port, path, query or
 * fragment (`https://host` or `https://host/`). Anything else is refused, never
 * repaired, so a token can only ever travel to the host the operator named.
 */
export function bareHttpsOrigin(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    return null;
  }
  return url;
}

/** The fetch a symbol seam on `env` injects, else the global fetch. */
export function seamFetch(env: Env, seam: symbol): PrinterFetch {
  const override = (env as unknown as Record<PropertyKey, unknown>)[seam];
  return typeof override === "function"
    ? (override as PrinterFetch)
    : (request) => fetch(request);
}
