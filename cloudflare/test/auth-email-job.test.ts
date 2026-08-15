import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  createAuthEmailJob,
  hashEmailRecipient,
  parseAuthEmailJob,
  redactedAuthEmailJobMetadata,
  renderAuthEmail,
} from "../src/email/auth-email-job";

const AUTH_BASE_URL = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const EXPIRES_AT = Date.now() + 60 * 60 * 1000;
const NOW = 1_787_000_000_000;

describe("auth email queue contract", () => {
  it("normalizes a verification job and produces both email body formats", () => {
    const job = createAuthEmailJob(
      {
        actionUrl: `${AUTH_BASE_URL}/api/auth/verify-email?token=a&callbackURL=%2F`,
        expiresAt: EXPIRES_AT,
        kind: "email_verification",
        locale: "sv",
        recipient: "  USER@Example.Test ",
        tenantId: "tenant-email",
      },
      AUTH_BASE_URL,
    );

    expect(job.recipient).toBe("user@example.test");
    expect(parseAuthEmailJob(job, AUTH_BASE_URL)).toEqual(job);
    expect(renderAuthEmail(job)).toMatchObject({
      subject: "Verifiera din e-postadress",
    });
    expect(renderAuthEmail(job).html).toContain("&amp;");
    expect(renderAuthEmail(job).text).toContain(job.actionUrl);
  });

  it("rejects external, insecure, fragmented, and wrong-purpose URLs", () => {
    const base = {
      expiresAt: EXPIRES_AT,
      kind: "password_reset" as const,
      locale: "en" as const,
      recipient: "user@example.test",
    };

    for (const actionUrl of [
      "https://evil.example/api/auth/reset-password/token",
      "http://meteorshop-stg-api.micke-ohlen.workers.dev/api/auth/reset-password/token",
      `${AUTH_BASE_URL}/api/auth/reset-password/token#leak`,
      `${AUTH_BASE_URL}/api/auth/verify-email?token=wrong-purpose`,
    ]) {
      expect(() =>
        createAuthEmailJob({ ...base, actionUrl }, AUTH_BASE_URL),
      ).toThrow("Invalid auth email action URL");
    }
  });

  it("redacts recipient and capability URL from operational metadata", () => {
    const job = createAuthEmailJob(
      {
        actionUrl: `${AUTH_BASE_URL}/api/auth/reset-password/reset-token?callbackURL=%2Freset`,
        expiresAt: EXPIRES_AT,
        kind: "password_reset",
        locale: "en",
        recipient: "secret@example.test",
      },
      AUTH_BASE_URL,
    );
    const serialized = JSON.stringify(redactedAuthEmailJobMetadata(job));

    expect(serialized).not.toContain(job.recipient);
    expect(serialized).not.toContain("reset-token");
    expect(serialized).not.toContain("actionUrl");
  });

  it("hashes normalized recipients deterministically", async () => {
    const first = await hashEmailRecipient("USER@example.test");
    const second = await hashEmailRecipient(" user@EXAMPLE.test ");

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
  });
});

describe("email delivery ledger", () => {
  it("contains no raw recipient, URL, token, or payload columns", async () => {
    const columns = await env.DB.prepare(
      "PRAGMA table_info(email_deliveries)",
    ).all<{ name: string }>();
    const names = columns.results.map((column) => column.name);

    expect(names).toContain("recipient_hash");
    expect(names).not.toContain("recipient");
    expect(names).not.toContain("email");
    expect(names).not.toContain("action_url");
    expect(names).not.toContain("token");
    expect(names).not.toContain("payload_json");
  });

  it("blocks delivery tenant re-homing", async () => {
    for (const tenantId of ["tenant-email-a", "tenant-email-b"]) {
      await env.DB.prepare(
        `INSERT INTO tenants (
          tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
        ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
      )
        .bind(tenantId, tenantId, NOW, NOW)
        .run();
    }

    await env.DB.prepare(
      `INSERT INTO email_deliveries (
        delivery_id, tenant_id, kind, recipient_hash, next_attempt_at,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, 'email_verification', ?, ?, ?, ?, ?)`,
    )
      .bind(
        "delivery-email-a",
        "tenant-email-a",
        "a".repeat(64),
        NOW,
        NOW + 60_000,
        NOW,
        NOW,
      )
      .run();

    await expect(
      env.DB.prepare(
        "UPDATE email_deliveries SET tenant_id = ?, updated_at = ? WHERE delivery_id = ?",
      )
        .bind("tenant-email-b", NOW + 1, "delivery-email-a")
        .run(),
    ).rejects.toThrow("tenant_id is immutable");
  });
});
