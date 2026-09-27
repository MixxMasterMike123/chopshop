import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  createAuthEmailJob,
  hashEmailRecipient,
  INVITE_LINK_VALID_HOURS,
  parseAuthEmailJob,
  PLATFORM_DISPLAY_NAME,
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
        expires_at, created_at, updated_at, job_fingerprint
      ) VALUES (?, ?, 'email_verification', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "delivery-email-a",
        "tenant-email-a",
        "a".repeat(64),
        NOW,
        NOW + 60_000,
        NOW,
        NOW,
        "b".repeat(64),
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

describe("the display name and the invite wording (CP3-B review round 1)", () => {
  const recipient = "invitee@example.com";
  const actionUrl = `${AUTH_BASE_URL}/api/auth/reset-password/invite-token?callbackURL=https%3A%2F%2Fweb.test.invalid%2Freset-password&x=1`;

  function resetJob(locale: "en" | "sv", variant?: "invite") {
    return createAuthEmailJob(
      {
        actionUrl,
        expiresAt: EXPIRES_AT,
        kind: "password_reset",
        locale,
        recipient,
        ...(variant === undefined ? {} : { variant }),
      },
      AUTH_BASE_URL,
    );
  }

  it("names the product through one constant; reset and verification subjects are unchanged", () => {
    expect(PLATFORM_DISPLAY_NAME).toBe("ChopShop");

    const svReset = renderAuthEmail(resetJob("sv"));
    expect(svReset.subject).toBe("Återställ ditt lösenord");
    expect(svReset.text).toBe(
      `Du har begärt att återställa ditt lösenord för ChopShop.\n\nÅterställ lösenord: ${actionUrl}`,
    );
    const enReset = renderAuthEmail(resetJob("en"));
    expect(enReset.subject).toBe("Reset your password");
    expect(enReset.text).toContain("You requested a password reset for ChopShop.");

    const verification = renderAuthEmail(
      createAuthEmailJob(
        {
          actionUrl: `${AUTH_BASE_URL}/api/auth/verify-email?token=a`,
          expiresAt: EXPIRES_AT,
          kind: "email_verification",
          locale: "sv",
          recipient,
        },
        AUTH_BASE_URL,
      ),
    );
    expect(verification.subject).toBe("Verifiera din e-postadress");
    expect(verification.text).toContain("Bekräfta din e-postadress för ChopShop.");

    for (const message of [svReset, enReset, verification]) {
      expect(message.text).not.toContain("MeteorShop");
      expect(message.html).not.toContain("MeteorShop");
    }
  });

  it("keeps the ordinary reset job's shape: no variant key, before or after the queue", () => {
    const job = resetJob("sv");
    expect("variant" in job).toBe(false);
    const parsed = parseAuthEmailJob(JSON.parse(JSON.stringify(job)), AUTH_BASE_URL);
    expect("variant" in parsed).toBe(false);
    expect(parsed).toEqual(job);
  });

  it("renders an invite: Swedish wording by default, English as the alternative", () => {
    expect(INVITE_LINK_VALID_HOURS).toBe(72);

    const sv = resetJob("sv", "invite");
    expect(sv).toMatchObject({ kind: "password_reset", variant: "invite" });
    const parsed = parseAuthEmailJob(JSON.parse(JSON.stringify(sv)), AUTH_BASE_URL);
    expect(parsed).toEqual(sv);

    const svMessage = renderAuthEmail(parsed);
    expect(svMessage.subject).toBe("Välj ditt lösenord för ChopShop");
    expect(svMessage.text).toBe(
      [
        "Ett konto har skapats åt dig på ChopShop.",
        "Välj ett lösenord för att logga in.",
        "",
        `Välj lösenord: ${actionUrl}`,
        "",
        "Länken gäller i 72 timmar och kan bara användas en gång.",
        "Om du inte väntade dig det här mejlet kan du bortse från det.",
      ].join("\n"),
    );
    expect(svMessage.html).toContain(`href="${actionUrl.replaceAll("&", "&amp;")}"`);
    expect(svMessage.html).toContain("<p>Länken gäller i 72 timmar och kan bara användas en gång.</p>");
    expect(svMessage.text).not.toContain("begärt");

    const enMessage = renderAuthEmail(resetJob("en", "invite"));
    expect(enMessage.subject).toBe("Choose your password for ChopShop");
    expect(enMessage.text).toBe(
      [
        "An account has been created for you on ChopShop.",
        "Choose a password to sign in.",
        "",
        `Choose password: ${actionUrl}`,
        "",
        "The link works for 72 hours and can be used once.",
        "If you did not expect this email, you can ignore it.",
      ].join("\n"),
    );
  });

  it("refuses a variant on a verification job, and an unknown variant, on create and on parse", () => {
    expect(() =>
      createAuthEmailJob(
        {
          actionUrl: `${AUTH_BASE_URL}/api/auth/verify-email?token=a`,
          expiresAt: EXPIRES_AT,
          kind: "email_verification",
          locale: "sv",
          recipient,
          variant: "invite",
        },
        AUTH_BASE_URL,
      ),
    ).toThrow("Invalid auth email variant");

    const job = resetJob("sv", "invite");
    for (const variant of ["welcome", "", 1, null]) {
      expect(() => parseAuthEmailJob({ ...job, variant }, AUTH_BASE_URL), String(variant)).toThrow(
        "Invalid auth email variant",
      );
    }
  });
});
