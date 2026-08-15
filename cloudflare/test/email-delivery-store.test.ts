import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createAuthEmailJob } from "../src/email/auth-email-job";
import {
  claimAuthEmailDelivery,
  completeAuthEmailDelivery,
  retryAuthEmailDelivery,
} from "../src/email/email-delivery-store";

const AUTH_BASE_URL = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
function job(email: string) {
  return createAuthEmailJob(
    {
      actionUrl: `${AUTH_BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(email)}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
      kind: "email_verification",
      locale: "en",
      recipient: email,
    },
    AUTH_BASE_URL,
  );
}

describe("email delivery leases", () => {
  it("allows exactly one concurrent claim", async () => {
    const message = job("concurrent@example.test");
    const now = message.createdAt;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimAuthEmailDelivery(env.DB, message, now),
      ),
    );

    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
  });

  it("rejects a changed payload reusing a delivery ID", async () => {
    const original = job("fingerprint-a@example.test");
    const claim = await claimAuthEmailDelivery(
      env.DB,
      original,
      original.createdAt,
    );
    expect(claim.status).toBe("claimed");

    const changed = {
      ...original,
      actionUrl: `${AUTH_BASE_URL}/api/auth/verify-email?token=changed`,
    };
    await expect(
      claimAuthEmailDelivery(env.DB, changed, original.createdAt + 1),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("only lets the lease owner complete a delivery", async () => {
    const message = job("complete@example.test");
    const now = message.createdAt;
    const claim = await claimAuthEmailDelivery(env.DB, message, now);
    if (claim.status !== "claimed") {
      throw new Error("Expected the test delivery to be claimed");
    }

    await expect(
      completeAuthEmailDelivery(
        env.DB,
        message.deliveryId,
        "wrong-lease",
        "message-wrong",
        now + 1,
      ),
    ).resolves.toBe(false);
    await expect(
      completeAuthEmailDelivery(
        env.DB,
        message.deliveryId,
        claim.leaseToken,
        "message-complete",
        now + 1,
      ),
    ).resolves.toBe(true);
    await expect(
      claimAuthEmailDelivery(env.DB, message, now + 2),
    ).resolves.toEqual({ status: "terminal" });
  });

  it("retries only after the scheduled time", async () => {
    const message = job("retry@example.test");
    const now = message.createdAt;
    const claim = await claimAuthEmailDelivery(env.DB, message, now);
    if (claim.status !== "claimed") {
      throw new Error("Expected the test delivery to be claimed");
    }
    const nextAttemptAt = now + 10_000;

    await expect(
      retryAuthEmailDelivery(
        env.DB,
        message.deliveryId,
        claim.leaseToken,
        "unsafe error with recipient@example.test",
        nextAttemptAt,
        now + 1,
      ),
    ).resolves.toBe(true);
    await expect(
      claimAuthEmailDelivery(env.DB, message, nextAttemptAt - 1),
    ).resolves.toEqual({ status: "not_claimed" });

    const retryClaim = await claimAuthEmailDelivery(
      env.DB,
      message,
      nextAttemptAt,
    );
    expect(retryClaim.status).toBe("claimed");

    const row = await env.DB.prepare(
      "SELECT attempts, last_error_code FROM email_deliveries WHERE delivery_id = ?",
    )
      .bind(message.deliveryId)
      .first<{ attempts: number; last_error_code: string }>();
    expect(row).toEqual({ attempts: 2, last_error_code: "E_UNKNOWN" });
  });

  it("records an expired capability without claiming it", async () => {
    const message = job("expired@example.test");
    const expiredAt = message.expiresAt + 1;

    await expect(
      claimAuthEmailDelivery(env.DB, message, expiredAt),
    ).resolves.toEqual({ status: "expired" });
    const row = await env.DB.prepare(
      "SELECT status, resolved_at FROM email_deliveries WHERE delivery_id = ?",
    )
      .bind(message.deliveryId)
      .first<{ resolved_at: number; status: string }>();
    expect(row).toEqual({ resolved_at: expiredAt, status: "expired" });
  });

  it("terminates an exhausted crashed lease instead of stranding it", async () => {
    const message = job("exhausted@example.test");
    let now = message.createdAt;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const claim = await claimAuthEmailDelivery(env.DB, message, now);
      expect(claim.status).toBe("claimed");
      now += 60_001;
    }

    await expect(
      claimAuthEmailDelivery(env.DB, message, now),
    ).resolves.toEqual({ status: "terminal" });
    const row = await env.DB.prepare(
      "SELECT status, attempts, resolved_at FROM email_deliveries WHERE delivery_id = ?",
    )
      .bind(message.deliveryId)
      .first<{ attempts: number; resolved_at: number; status: string }>();
    expect(row).toEqual({ attempts: 8, resolved_at: now, status: "failed" });
  });
});
