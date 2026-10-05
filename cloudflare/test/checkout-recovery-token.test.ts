import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  mintRecoveryToken,
  RECOVERY_TOKEN_PATTERN,
  verifyRecoveryToken,
} from "../src/commerce/checkout-recovery-token";

/**
 * CP9-AC build step 3: the links' tokens (checkout-recovery-token.ts) — the
 * tenant and the purpose are signed, nothing is stored, nothing verifies
 * without the secret.
 */

const TENANT = "tenant-ac-token";
const REMINDER = "3f2a6b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

function withoutSecret(): Env {
  return { ...env, BETTER_AUTH_SECRET: undefined } as unknown as Env;
}

async function hmacWith(salt: string, info: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET as string), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { hash: "SHA-256", info: encoder.encode(info), name: "HKDF", salt: encoder.encode(salt) },
    material,
    { hash: "SHA-256", length: 256, name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  let binary = "";
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("the recovery link tokens", () => {
  it("round-trips each purpose: 83 characters, the reminder id and nothing else of the reminder", async () => {
    for (const purpose of ["resume", "unsubscribe"] as const) {
      const token = await mintRecoveryToken(env, TENANT, REMINDER, purpose);
      expect(token).toMatch(RECOVERY_TOKEN_PATTERN);
      expect(token).toHaveLength(83);
      expect(token?.startsWith(`v1.${REMINDER}.`)).toBe(true);
      expect(token).not.toContain(TENANT);
      expect(await verifyRecoveryToken(env, TENANT, token as string, purpose)).toBe(REMINDER);
    }
  });

  it("is deterministic: the same reminder gives the same token on every build", async () => {
    expect(await mintRecoveryToken(env, TENANT, REMINDER, "resume")).toBe(
      await mintRecoveryToken(env, TENANT, REMINDER, "resume"),
    );
  });

  it("refuses the other purpose, another tenant and one flipped character", async () => {
    const resume = (await mintRecoveryToken(env, TENANT, REMINDER, "resume")) as string;
    const unsubscribe = (await mintRecoveryToken(env, TENANT, REMINDER, "unsubscribe")) as string;
    expect(resume).not.toBe(unsubscribe);
    expect(await verifyRecoveryToken(env, TENANT, resume, "unsubscribe")).toBeNull();
    expect(await verifyRecoveryToken(env, TENANT, unsubscribe, "resume")).toBeNull();
    expect(await verifyRecoveryToken(env, "tenant-ac-token-b", resume, "resume")).toBeNull();
    const last = resume.at(-2) === "A" ? "B" : "A";
    const flipped = `${resume.slice(0, -2)}${last}${resume.at(-1)}`;
    expect(await verifyRecoveryToken(env, TENANT, flipped, "resume")).toBeNull();
    // A signature of another reminder id does not carry over.
    const other = "3f2a6b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2d";
    expect(await verifyRecoveryToken(env, TENANT, resume.replace(REMINDER, other), "resume")).toBeNull();
  });

  it.each([
    [""],
    ["v1"],
    [`v2.${REMINDER}.${"A".repeat(43)}`],
    [`v1.${REMINDER}.${"A".repeat(42)}`],
    [`v1.${REMINDER}.${"A".repeat(44)}`],
    [`v1.${REMINDER.toUpperCase()}.${"A".repeat(43)}`],
    [`v1.00000000-0000-0000-0000-000000000000.${"A".repeat(43)}`],
    [`v1.${REMINDER}.${"A".repeat(42)}=`],
    [`v1.${REMINDER}.${"A".repeat(42)}/`],
    [` v1.${REMINDER}.${"A".repeat(43)}`],
  ])("refuses the malformed token %j", async (token) => {
    expect(await verifyRecoveryToken(env, TENANT, token, "resume")).toBeNull();
  });

  it("mints nothing and verifies nothing without the secret", async () => {
    const token = (await mintRecoveryToken(env, TENANT, REMINDER, "resume")) as string;
    expect(await mintRecoveryToken(withoutSecret(), TENANT, REMINDER, "resume")).toBeNull();
    expect(await verifyRecoveryToken(withoutSecret(), TENANT, token, "resume")).toBeNull();
    expect(await mintRecoveryToken(env, TENANT, "not-a-uuid", "resume")).toBeNull();
  });

  it("uses a key of its own: a signature made with the preview grant's key never verifies", async () => {
    const message = `checkout-recovery/v1\nresume\n${TENANT}\n${REMINDER}`;
    const previewSigned = await hmacWith("chopshop/storefront-preview", "storefront-preview-grant/v1", message);
    expect(await verifyRecoveryToken(env, TENANT, `v1.${REMINDER}.${previewSigned}`, "resume")).toBeNull();
    // The same construction with this module's salt and info is the token.
    const ownSigned = await hmacWith("chopshop/checkout-recovery", "checkout-recovery-link/v1", message);
    expect(await verifyRecoveryToken(env, TENANT, `v1.${REMINDER}.${ownSigned}`, "resume")).toBe(REMINDER);
  });
});
