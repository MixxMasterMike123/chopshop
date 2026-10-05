import { isAuthConfigured } from "../auth/create-auth";
import { RECOVERY_TOKEN_PATTERN } from "../email/checkout-reminder-email";

/**
 * The two links of an abandoned-checkout reminder (CP9-AC §3.4): the one that
 * rebuilds the cart (`resume`) and the one that unsubscribes the address
 * (`unsubscribe`). The pattern of the storefront preview grant
 * (src/storefront/preview.ts):
 *
 *   token     = "v1." + <reminderId> + "." + base64url(HMAC-SHA-256(key, message))
 *   message   = "checkout-recovery/v1\n<purpose>\n<tenantId>\n<reminderId>"
 *   key       = HKDF-SHA-256(BETTER_AUTH_SECRET, salt "chopshop/checkout-recovery",
 *                            info "checkout-recovery-link/v1")
 *
 * NOTHING SECRET IS STORED. The reminder id alone opens nothing; the mail
 * effect re-derives the same links on every retry (the ledger's fingerprint
 * needs a deterministic job), and no table holds a token.
 *
 * The TENANT and the PURPOSE are inside the signed message, not in the token:
 * a token of shop A on shop B's host is a wrong signature, and an unsubscribe
 * link (which travels in a mail header to mail providers) cannot rebuild the
 * cart, nor the cart link unsubscribe. The checkout id is never in a link: it
 * is the bearer capability of the payment and receipt routes.
 *
 * The key is this purpose's alone (its own salt and info), so a preview grant's
 * signature never verifies here, nor the reverse. Without a configured secret
 * nothing is minted and nothing verifies. Rotating the secret ends every link
 * already mailed, the unsubscribe links included (the design's R2).
 */

export type RecoveryPurpose = "resume" | "unsubscribe";

const TOKEN_VERSION = "v1";
// v1.<a v4 uuid>.<43 base64url characters: 32 bytes, unpadded> — 83 characters.
const TOKEN_PATTERN = RECOVERY_TOKEN_PATTERN;
const REMINDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HKDF_SALT = "chopshop/checkout-recovery";
const HKDF_INFO = "checkout-recovery-link/v1";

export { RECOVERY_TOKEN_PATTERN };

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function recoveryKey(env: Env): Promise<CryptoKey | null> {
  if (!isAuthConfigured(env)) {
    return null;
  }
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET as string),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: encoder.encode(HKDF_INFO),
      name: "HKDF",
      salt: encoder.encode(HKDF_SALT),
    },
    material,
    { hash: "SHA-256", length: 256, name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

function signedMessage(purpose: RecoveryPurpose, tenantId: string, reminderId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`checkout-recovery/${TOKEN_VERSION}\n${purpose}\n${tenantId}\n${reminderId}`);
}

/** Can links be minted and verified here? (The cron step mails nobody otherwise.) */
export function isRecoveryTokenConfigured(env: Env): boolean {
  return isAuthConfigured(env);
}

/** The token of `purpose` for a reminder of `tenantId`; null without a secret or for a malformed id. */
export async function mintRecoveryToken(
  env: Env,
  tenantId: string,
  reminderId: string,
  purpose: RecoveryPurpose,
): Promise<string | null> {
  if (!REMINDER_ID_PATTERN.test(reminderId)) {
    return null;
  }
  const key = await recoveryKey(env);
  if (key === null) {
    return null;
  }
  const signature = await crypto.subtle.sign("HMAC", key, signedMessage(purpose, tenantId, reminderId));
  return `${TOKEN_VERSION}.${reminderId}.${toBase64Url(signature)}`;
}

/**
 * The reminder id of a token this Worker minted for `tenantId` and `purpose`,
 * or null: a malformed token, another shop's, the other purpose's, a forged
 * signature, or no secret. The signature is compared by `crypto.subtle.verify`,
 * in constant time. Whether the reminder exists, and its state, is the
 * caller's to read.
 */
export async function verifyRecoveryToken(
  env: Env,
  tenantId: string,
  token: string,
  purpose: RecoveryPurpose,
): Promise<string | null> {
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) {
    return null;
  }
  const reminderId = match[1] as string;
  const signature = fromBase64Url(match[2] as string);
  const key = await recoveryKey(env);
  if (signature === null || signature.length !== 32 || key === null) {
    return null;
  }
  return (await crypto.subtle.verify("HMAC", key, signature, signedMessage(purpose, tenantId, reminderId)))
    ? reminderId
    : null;
}
