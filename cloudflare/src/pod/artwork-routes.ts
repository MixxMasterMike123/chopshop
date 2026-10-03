/**
 * Request parsing for the POD artwork surface.
 *
 * Kept separate from the store for the same reason every other domain here
 * does it: the parser is the trust boundary, and a body that has not been
 * through it must never reach a statement.
 */

export interface CreateArtworkRequest {
  /** The seller's internal name, trimmed; null when none was given. */
  label: string | null;
  objectId: string;
  profileId: string;
}

export interface PatchArtworkRequest {
  /** The new name, trimmed; null clears it. */
  label: string | null;
}

const CREATE_KEYS = ["label", "objectId", "profileId", "rightsConfirmed"] as const;
const PATCH_KEYS = ["label"] as const;
export const ARTWORK_LABEL_MAX_LENGTH = 120;
const PROFILE_ID_MAX_LENGTH = 64;
const OBJECT_ID_MAX_LENGTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `{ objectId, profileId, rightsConfirmed: true, label? }` and nothing else.
 *
 * `rightsConfirmed` is the uploader's LEGAL confirmation that they may print
 * the motif (the upload modal's rights box). It must be literally `true`: a
 * missing key, `false`, `"true"` or `1` is refused, so a client that predates
 * the confirmation (the body `{ objectId, profileId }`) cannot create an
 * artwork without it. The time stored with it is the server's (the store sets
 * it from the request's own clock); nothing in the body says when.
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
  if (body.rightsConfirmed !== true) {
    return null;
  }
  const label = parseLabel(body.label);
  if (label === undefined) {
    return null;
  }

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

  return { label, objectId, profileId };
}

/** Control characters (C0, DEL, C1) and the Unicode line/paragraph separators. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * A label: absent or null → null; a string → trimmed, 1–120 characters, no
 * control characters; anything else → undefined (refused). A string that is
 * empty after trimming is refused rather than read as "no label": the caller
 * meant to name the motif and sent nothing.
 */
function parseLabel(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length >= 1 &&
    trimmed.length <= ARTWORK_LABEL_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(trimmed)
    ? trimmed
    : undefined;
}

/**
 * `PATCH /v1/admin/pod/artwork/:id` — `{ label }` and nothing else; `label`
 * is required (a string, or null to clear it).
 */
export function parsePatchArtworkInput(body: unknown): PatchArtworkRequest | null {
  if (
    !isPlainObject(body) ||
    !Object.keys(body).every((key) => (PATCH_KEYS as readonly string[]).includes(key)) ||
    !("label" in body)
  ) {
    return null;
  }
  const label = parseLabel(body.label);
  return label === undefined ? null : { label };
}
