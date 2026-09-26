import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import {
  authorizePlatformRequest,
  authorizeTenantAdminRequest,
  resolveSessionIdentity,
} from "../src/auth/request-authorization";

function withoutAuthSecret(): Env {
  return { ...env, BETTER_AUTH_SECRET: undefined };
}

describe("session guards without a configured auth secret", () => {
  it.each([
    ["missing", undefined],
    ["too short", "short-secret"],
  ])("resolves no session identity when the secret is %s", async (
    _label,
    secret,
  ) => {
    const identity = await resolveSessionIdentity(
      { ...env, BETTER_AUTH_SECRET: secret },
      new Request("https://any.host.test/", {
        headers: { cookie: "better-auth.session_token=forged" },
      }),
    );

    expect(identity).toBeNull();
  });

  it("fails closed on the tenant-admin guard", async () => {
    await expect(
      authorizeTenantAdminRequest(
        withoutAuthSecret(),
        new Request("https://any.host.test/v1/admin/products"),
      ),
    ).resolves.toBeNull();
  });

  it("fails closed on the platform guard", async () => {
    await expect(
      authorizePlatformRequest(
        withoutAuthSecret(),
        new Request("https://any.host.test/v1/platform/tenants"),
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["https://any.host.test/v1/admin/products"],
    ["https://any.host.test/v1/platform/tenants"],
  ])("returns fail-closed JSON 404 for %s instead of throwing", async (
    target,
  ) => {
    const response = await worker.fetch(
      new Request(target, {
        body: JSON.stringify({}),
        headers: {
          "content-type": "application/json",
          origin: "https://any.host.test",
        },
        method: "POST",
      }),
      withoutAuthSecret(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });
});
