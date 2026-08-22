import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("API foundation", () => {
  it("returns a typed staging health response", async () => {
    const response = await exports.default.fetch("https://api.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      environment: env.APP_ENV,
      service: env.SERVICE_NAME,
      status: "ok",
    });
  });

  it("fails closed for unknown routes", async () => {
    const response = await exports.default.fetch("https://api.test/unknown");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  it("reports the required D1 migration as ready", async () => {
    const response = await exports.default.fetch("https://api.test/ready");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      database: "ready",
      migration: "0012_pod_artwork.sql",
      status: "ok",
    });
  });
});
