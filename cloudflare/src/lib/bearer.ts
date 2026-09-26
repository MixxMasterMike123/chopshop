/**
 * `Authorization: Bearer <secret>` for the machine-to-machine surfaces (the
 * render farm's pull API, the staging fake printer): no session, no cookie, no
 * tenant hostname — the shared secret is the whole credential.
 */

// Exactly "Bearer ", one space, then visible ASCII only. Anything else is not a
// credential and is refused before it is hashed.
const BEARER_PATTERN = /^Bearer ([\x21-\x7e]{1,512})$/;

export function readBearerToken(header: string | null): string | null {
  if (header === null) {
    return null;
  }

  return BEARER_PATTERN.exec(header)?.[1] ?? null;
}

/**
 * crypto.subtle.timingSafeEqual is a Workers runtime extension that the
 * tsconfig "WebWorker" lib does not declare (same cast and reasoning as
 * src/platform/bootstrap.ts).
 */
const timingSafeEqual = (
  crypto.subtle as unknown as {
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  }
).timingSafeEqual.bind(crypto.subtle);

/**
 * Constant-time comparison of a presented secret with the configured one. Both
 * sides are hashed to fixed-length SHA-256 digests first, so neither the
 * content nor the LENGTH of the configured secret leaks through timing
 * (timingSafeEqual itself throws on unequal lengths).
 */
export async function secretMatches(
  presented: string,
  configured: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [presentedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);

  return timingSafeEqual(presentedDigest, configuredDigest);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** 32 random bytes as unpadded base64url: 43 characters. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
