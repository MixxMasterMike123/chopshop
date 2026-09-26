/**
 * Request parsing for the POD artwork surface.
 *
 * Kept separate from the store for the same reason every other domain here
 * does it: the parser is the trust boundary, and a body that has not been
 * through it must never reach a statement.
 */

export interface CreateArtworkRequest {
  objectId: string;
  profileId: string;
}

const CREATE_KEYS = ["objectId", "profileId"] as const;
const PROFILE_ID_MAX_LENGTH = 64;
const OBJECT_ID_MAX_LENGTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `{ objectId, profileId }` and nothing else.
 *
 * The strict key allowlist matters more than usual on this route. Everything
 * that decides the outcome — which profile, which bytes, where the outputs go,
 * how large the input may be — is resolved SERVER-SIDE from these two ids. A
 * body carrying a `printKey`, a `maxBytes` or a `minDpi` is not a validation
 * failure to be ignored; it is a caller trying to steer the pipeline, and it is
 * refused outright rather than silently dropped.
 */
export function parseCreateArtworkInput(
  body: unknown,
): CreateArtworkRequest | null {
  if (!isPlainObject(body)) {
    return null;
  }

  if (!Object.keys(body).every((key) => (CREATE_KEYS as readonly string[]).includes(key))) {
    return null;
  }

  const { objectId, profileId } = body;

  if (
    typeof objectId !== "string" ||
    objectId.length === 0 ||
    objectId.length > OBJECT_ID_MAX_LENGTH ||
    typeof profileId !== "string" ||
    profileId.length === 0 ||
    profileId.length > PROFILE_ID_MAX_LENGTH
  ) {
    return null;
  }

  return { objectId, profileId };
}
