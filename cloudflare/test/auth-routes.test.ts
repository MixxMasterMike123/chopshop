import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const EMAIL = "signin@authroutes.test";
const PASSWORD = "test-password-long-enough";

function withoutAuthSecret(): Env {
  return { ...env, BETTER_AUTH_SECRET: undefined };
}

function authRequest(
  path: string,
  method: string,
  options: { body?: unknown; cookie?: string; origin?: string } = {},
): Request {
  const headers = new Headers();
  headers.set("origin", options.origin ?? AUTH_ORIGIN);
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new Request(`${AUTH_ORIGIN}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method,
  });
}

function sessionCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null || !setCookie.includes("session_token=")) {
    return null;
  }

  const cookie = setCookie.split(";", 1)[0];
  return cookie === undefined || cookie.endsWith("session_token=")
    ? null
    : cookie;
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM "${table}"`,
  ).first<{ total: number }>();

  return row?.total ?? 0;
}

async function sessionRowCount(token: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM "session" WHERE "token" = ?',
  )
    .bind(token)
    .first<{ total: number }>();

  return row?.total ?? 0;
}

async function signIn(
  options: { origin?: string; password?: string } = {},
): Promise<Response> {
  // Sign-in shares a rate-limit bucket when no client IP is forwarded. Drain
  // it first so a 429 can never stand in for the auth outcome under test — the
  // negative assertions below pin exact statuses and would otherwise pass
  // vacuously on a throttled request.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  return worker.fetch(
    authRequest("/api/auth/sign-in/email", "POST", {
      body: { email: EMAIL, password: options.password ?? PASSWORD },
      origin: options.origin,
    }),
    env,
  );
}

beforeAll(async () => {
  // Better Auth caps sign-up in a shared bucket when no client IP is
  // forwarded; drain the ledger so other suites cannot starve this fixture.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  // Seeded through the Better Auth handler directly: the worker deliberately
  // does not mount sign-up, so the HTTP allowlist has to be bypassed here.
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: EMAIL, name: EMAIL, password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );

  expect(response.status).toBe(200);
});

describe("mounted auth routes", () => {
  it("signs in with correct credentials and resolves the session", async () => {
    const response = await signIn();
    const cookie = sessionCookie(response);

    expect(response.status).toBe(200);
    expect(cookie).not.toBeNull();

    const session = await worker.fetch(
      authRequest("/api/auth/get-session", "GET", { cookie: cookie ?? "" }),
      env,
    );

    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      user: { email: EMAIL },
    });
  });

  it("signs out and drops the session row", async () => {
    const response = await signIn();
    const cookie = sessionCookie(response);
    if (cookie === null) {
      throw new Error("sign-in did not return a session cookie");
    }

    // Pin the row this session owns rather than a global count: other suites
    // share the database, so a count delta could be satisfied by their churn.
    const { token } = await response.json<{ token: string }>();
    await expect(sessionRowCount(token)).resolves.toBe(1);

    const signedOut = await worker.fetch(
      authRequest("/api/auth/sign-out", "POST", { body: {}, cookie }),
      env,
    );

    expect(signedOut.status).toBe(200);
    await expect(sessionRowCount(token)).resolves.toBe(0);

    const session = await worker.fetch(
      authRequest("/api/auth/get-session", "GET", { cookie }),
      env,
    );

    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toBeNull();
  });

  it("returns no session data without a cookie", async () => {
    const response = await worker.fetch(
      authRequest("/api/auth/get-session", "GET"),
      env,
    );

    expect(response.status).toBeLessThan(500);
    await expect(response.json()).resolves.toBeNull();
  });
});

describe("auth route rejection", () => {
  it("refuses a wrong password without issuing a session", async () => {
    const response = await signIn({ password: "wrong-password-entirely" });

    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_EMAIL_OR_PASSWORD",
    });
  });

  // Better Auth enforces trustedOrigins itself for state-changing requests, so
  // the worker deliberately adds no CSRF check of its own for these routes.
  // This pins that behaviour: if it ever regresses, we must add our own check.
  it("refuses a sign-in from an untrusted origin", async () => {
    const response = await signIn({ origin: "https://evil.test" });

    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_ORIGIN",
    });
  });
});

describe("unmounted auth routes", () => {
  it.each([
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/forget-password"],
    ["POST", "/api/auth/reset-password"],
    ["GET", "/api/auth/verify-email"],
    ["GET", "/api/auth/sign-in/social"],
    ["GET", "/api/auth/whatever"],
    ["GET", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-in/email/"],
  ])("returns fail-closed JSON 404 for %s %s", async (method, path) => {
    const response = await worker.fetch(
      authRequest(path, method, method === "POST" ? { body: {} } : {}),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });

  it("does not create a user through the unmounted sign-up route", async () => {
    const before = await countRows("user");
    const response = await worker.fetch(
      authRequest("/api/auth/sign-up/email", "POST", {
        body: {
          email: "intruder@authroutes.test",
          name: "Intruder",
          password: PASSWORD,
        },
      }),
      env,
    );

    expect(response.status).toBe(404);
    await expect(countRows("user")).resolves.toBe(before);
  });
});

describe("auth routes without a configured auth secret", () => {
  it.each([
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-out"],
    ["GET", "/api/auth/get-session"],
  ])("returns fail-closed JSON 404 for %s %s", async (method, path) => {
    const response = await worker.fetch(
      authRequest(path, method, method === "POST" ? { body: {} } : {}),
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
