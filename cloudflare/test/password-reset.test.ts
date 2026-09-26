import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import {
  PASSWORD_RESET_EMAIL_LIMIT,
  PASSWORD_RESET_IP_LIMIT,
} from "../src/auth/password-reset";
import {
  hashEmailRecipient,
  parseAuthEmailJob,
} from "../src/email/auth-email-job";
import type { AuthEmailJob } from "../src/email/auth-email-job";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";

/**
 * Password reset, end to end, with every external edge faked at its seam:
 * the queue producer is a recording fake injected through env, and the Resend
 * call goes through RESEND_FETCH_OVERRIDE. Nothing leaves the process.
 */
const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const WEB_ORIGIN = "https://web.test.invalid";
const RESET_PAGE = `${WEB_ORIGIN}/reset-password`;
const EMAIL = "reset-user@passwordreset.test";
const PASSWORD = "original-password-long-enough";
const NEW_PASSWORD = "brand-new-password-long-enough";

let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

interface CapturedQueue {
  queue: Queue;
  sent: unknown[];
}

function captureQueue(options: { fail?: boolean } = {}): CapturedQueue {
  const sent: unknown[] = [];
  const queue = {
    async send(body: unknown) {
      if (options.fail === true) {
        throw new Error("queue unavailable");
      }
      sent.push(body);
    },
    async sendBatch() {
      throw new Error("not used");
    },
  } as unknown as Queue;
  return { queue, sent };
}

interface CapturedFetch {
  fetch: (request: Request) => Promise<Response>;
  requests: Request[];
}

function fakeResend(
  respond: (request: Request, call: number) => Response = (_request, call) =>
    Response.json({ id: `re_msg_${call}` }),
): CapturedFetch {
  const requests: Request[] = [];
  return {
    async fetch(request: Request) {
      requests.push(request.clone() as unknown as Request);
      return respond(request, requests.length);
    },
    requests,
  };
}

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function drainAuthLimiter(): Promise<void> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
}

async function requestReset(
  targetEnv: Env,
  body: unknown,
  options: { ip?: string; raw?: string } = {},
): Promise<Response> {
  await drainAuthLimiter();
  return worker.fetch(
    new Request(`${AUTH_ORIGIN}/api/auth/request-password-reset`, {
      body: options.raw ?? JSON.stringify(body),
      headers: {
        "cf-connecting-ip": options.ip ?? nextIp(),
        "content-type": "application/json",
        origin: WEB_ORIGIN,
      },
      method: "POST",
    }),
    targetEnv,
  );
}

async function signIn(password: string): Promise<Response> {
  await drainAuthLimiter();
  return worker.fetch(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: EMAIL, password }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
    env,
  );
}

async function ledgerRow(deliveryId: string) {
  return env.DB.prepare(
    `SELECT status, kind, recipient_hash, attempts, provider_message_id,
            last_error_code, resolved_at
     FROM email_deliveries WHERE delivery_id = ?`,
  )
    .bind(deliveryId)
    .first<{
      attempts: number;
      kind: string;
      last_error_code: string | null;
      provider_message_id: string | null;
      recipient_hash: string;
      resolved_at: number | null;
      status: string;
    }>();
}

async function ledgerRowsFor(email: string) {
  const result = await env.DB.prepare(
    `SELECT delivery_id, status, last_error_code
     FROM email_deliveries WHERE recipient_hash = ? ORDER BY created_at ASC`,
  )
    .bind(await hashEmailRecipient(email))
    .all<{ delivery_id: string; last_error_code: string | null; status: string }>();
  return result.results;
}

async function consume(
  body: unknown,
  resend: CapturedFetch,
  options: { attempts?: number; id?: string } = {},
) {
  const batch = createMessageBatch("chopshop-test-email", [
    {
      attempts: options.attempts ?? 1,
      body,
      id: options.id ?? crypto.randomUUID(),
      timestamp: new Date(),
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(
    batch,
    envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
  );
  return getQueueResult(batch, ctx);
}

async function clearOurLimiter(): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM rate_limit_windows
     WHERE scope IN ('password-reset-ip', 'password-reset-email')`,
  ).run();
}

beforeAll(async () => {
  await drainAuthLimiter();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: EMAIL, name: EMAIL, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
});

beforeEach(async () => {
  await clearOurLimiter();
});

describe("requesting a reset", () => {
  it("records a ledger row and enqueues a job whose link is built only from canonical origins", async () => {
    const captured = captureQueue();
    const response = await requestReset(envWith({ EMAIL_QUEUE: captured.queue }), {
      callbackURL: "https://evil.example/cb",
      email: `  ${EMAIL.toUpperCase()} `,
      redirectTo: "https://evil.example/steal",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: "If this email exists in our system, check your email for the reset link",
      status: true,
    });

    expect(captured.sent).toHaveLength(1);
    const job = parseAuthEmailJob(captured.sent[0], env.AUTH_BASE_URL);
    expect(job.kind).toBe("password_reset");
    expect(job.locale).toBe("sv");
    expect(job.recipient).toBe(EMAIL);
    expect(job.tenantId).toBeUndefined();
    expect(job.expiresAt - job.createdAt).toBe(60 * 60 * 1_000);

    const link = new URL(job.actionUrl);
    expect(link.origin).toBe(AUTH_ORIGIN);
    expect(link.pathname).toMatch(/^\/api\/auth\/reset-password\/[A-Za-z0-9]{24}$/);
    expect([...link.searchParams.keys()]).toEqual(["callbackURL"]);
    expect(link.searchParams.get("callbackURL")).toBe(RESET_PAGE);
    expect(job.actionUrl).not.toContain("evil");

    await expect(ledgerRow(job.deliveryId)).resolves.toMatchObject({
      attempts: 0,
      kind: "password_reset",
      recipient_hash: await hashEmailRecipient(EMAIL),
      status: "pending",
    });
  });

  it("answers an unknown address exactly like a known one, and sends nothing", async () => {
    const knownQueue = captureQueue();
    const known = await requestReset(envWith({ EMAIL_QUEUE: knownQueue.queue }), {
      email: EMAIL,
    });
    const unknownQueue = captureQueue();
    const unknown = await requestReset(
      envWith({ EMAIL_QUEUE: unknownQueue.queue }),
      { email: "nobody-here@passwordreset.test" },
    );

    expect(unknown.status).toBe(known.status);
    expect(unknown.headers.get("content-type")).toBe(
      known.headers.get("content-type"),
    );
    expect(unknown.headers.get("set-cookie")).toBe(known.headers.get("set-cookie"));
    await expect(unknown.text()).resolves.toBe(await known.text());

    expect(knownQueue.sent).toHaveLength(1);
    expect(unknownQueue.sent).toHaveLength(0);
    await expect(
      ledgerRowsFor("nobody-here@passwordreset.test"),
    ).resolves.toEqual([]);
  });

  it("uses the real EMAIL_QUEUE binding when nothing is injected", async () => {
    const before = (await ledgerRowsFor(EMAIL)).length;
    const response = await requestReset(env, { email: EMAIL });

    expect(response.status).toBe(200);
    const rows = await ledgerRowsFor(EMAIL);
    expect(rows).toHaveLength(before + 1);
  });

  it.each([
    ["an empty object", "{}"],
    ["a non-email", JSON.stringify({ email: "not-an-address" })],
    ["a non-string email", JSON.stringify({ email: 42 })],
    ["unparseable JSON", "{email"],
    ["an array", JSON.stringify([EMAIL])],
  ])("answers 400 for %s and enqueues nothing", async (_label, raw) => {
    const captured = captureQueue();
    const response = await requestReset(
      envWith({ EMAIL_QUEUE: captured.queue }),
      undefined,
      { raw },
    );

    expect(response.status).toBe(400);
    expect(captured.sent).toHaveLength(0);
  });

  it("limits requests per IP before reading the body", async () => {
    const ip = nextIp();
    const captured = captureQueue();
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= PASSWORD_RESET_IP_LIMIT; attempt += 1) {
      const response = await requestReset(
        envWith({ EMAIL_QUEUE: captured.queue }),
        { email: `ip-limit-${attempt}@passwordreset.test` },
        { ip },
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get("retry-after")).not.toBeNull();
      }
    }

    expect(PASSWORD_RESET_IP_LIMIT).toBe(5);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);

    // Over the limit even a malformed body is refused by the limiter, not the
    // parser: the limit runs first.
    const malformed = await requestReset(
      envWith({ EMAIL_QUEUE: captured.queue }),
      undefined,
      { ip, raw: "{nope" },
    );
    expect(malformed.status).toBe(429);
  });

  it("limits requests per address across IPs, alike for known and unknown addresses", async () => {
    for (const email of [EMAIL, "limit-unknown@passwordreset.test"]) {
      await clearOurLimiter();
      const captured = captureQueue();
      const statuses: number[] = [];
      for (let attempt = 0; attempt <= PASSWORD_RESET_EMAIL_LIMIT; attempt += 1) {
        const response = await requestReset(
          envWith({ EMAIL_QUEUE: captured.queue }),
          { email: attempt % 2 === 0 ? email : email.toUpperCase() },
        );
        statuses.push(response.status);
      }

      expect(PASSWORD_RESET_EMAIL_LIMIT).toBe(3);
      expect(statuses, email).toEqual([200, 200, 200, 429]);
    }
  });

  it("still answers 200 when the queue refuses the job, and closes the ledger row", async () => {
    const email = "queue-down@passwordreset.test";
    await drainAuthLimiter();
    const signUp = await createAuth(env).handler(
      new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email, name: email, password: PASSWORD }),
        headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
        method: "POST",
      }),
    );
    expect(signUp.status).toBe(200);

    const broken = captureQueue({ fail: true });
    const response = await requestReset(envWith({ EMAIL_QUEUE: broken.queue }), {
      email,
    });

    expect(response.status).toBe(200);
    const rows = await ledgerRowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ last_error_code: "E_ENQUEUE", status: "failed" });
  });
});

describe("the reset surface fails closed", () => {
  const routes: [string, string, string | undefined][] = [
    ["POST", "/api/auth/request-password-reset", JSON.stringify({ email: EMAIL })],
    ["GET", "/api/auth/reset-password/abcdefghijklmnopqrstuvwx", undefined],
    [
      "POST",
      "/api/auth/reset-password",
      JSON.stringify({ newPassword: NEW_PASSWORD, token: "abcdefghijklmnopqrstuvwx" }),
    ],
  ];

  it.each([
    ["no EMAIL_QUEUE binding", { EMAIL_QUEUE: undefined }],
    ["no CANONICAL_ORIGINS", { CANONICAL_ORIGINS: undefined }],
    ["malformed CANONICAL_ORIGINS", { CANONICAL_ORIGINS: { api: "x", web: "y" } }],
    ["no auth secret", { BETTER_AUTH_SECRET: undefined }],
  ])("answers the unmounted 404 on every reset route with %s", async (
    _label,
    overrides,
  ) => {
    for (const [method, path, body] of routes) {
      const response = await worker.fetch(
        new Request(`${AUTH_ORIGIN}${path}`, {
          body,
          headers: { "content-type": "application/json", origin: WEB_ORIGIN },
          method,
        }),
        envWith(overrides),
      );

      expect(response.status, `${method} ${path}`).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "not_found", message: "Route not found" },
      });
    }
  });
});

describe("the emailed link and the reset itself", () => {
  let job: AuthEmailJob;
  let oldSessionCookie: string;

  beforeAll(async () => {
    const signedIn = await signIn(PASSWORD);
    expect(signedIn.status).toBe(200);
    oldSessionCookie = (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

    await clearOurLimiter();
    const captured = captureQueue();
    const response = await requestReset(envWith({ EMAIL_QUEUE: captured.queue }), {
      email: EMAIL,
    });
    expect(response.status).toBe(200);
    job = parseAuthEmailJob(captured.sent[0], env.AUTH_BASE_URL);
  });

  it("is delivered by the -email consumer through Resend, once", async () => {
    const resend = fakeResend();
    const result = await consume(job, resend, { id: "reset-msg-1" });

    expect(result.explicitAcks).toEqual(["reset-msg-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(resend.requests).toHaveLength(1);

    const sent = resend.requests[0] as Request;
    expect(sent.url).toBe("https://api.resend.com/emails");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${env.RESEND_API_KEY}`);
    expect(sent.headers.get("idempotency-key")).toBe(job.deliveryId);
    const payload = await sent.json<{
      from: string;
      html: string;
      subject: string;
      text: string;
      to: string[];
    }>();
    expect(payload.from).toBe(env.EMAIL_FROM);
    expect(payload.to).toEqual([EMAIL]);
    expect(payload.subject).toBe("Återställ ditt lösenord");
    expect(payload.text).toContain(job.actionUrl);
    expect(payload.html).toContain(job.actionUrl.replaceAll("&", "&amp;"));

    await expect(ledgerRow(job.deliveryId)).resolves.toMatchObject({
      attempts: 1,
      provider_message_id: "re_msg_1",
      status: "sent",
    });

    // At-least-once redelivery of the same job sends nothing more.
    const again = await consume(job, resend, { id: "reset-msg-1-redelivered" });
    expect(again.explicitAcks).toEqual(["reset-msg-1-redelivered"]);
    expect(resend.requests).toHaveLength(1);
  });

  it("redirects the link to the canonical web page, whatever callbackURL it carries", async () => {
    const link = new URL(job.actionUrl);
    link.searchParams.set("callbackURL", "https://evil.example/steal");

    const response = await worker.fetch(
      new Request(link.href, { redirect: "manual" }),
      env,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(RESET_PAGE);
    expect(location.searchParams.get("token")).toBe(
      link.pathname.split("/").at(-1),
    );
  });

  it("bounces an unknown token to the web page with an error", async () => {
    const response = await worker.fetch(
      new Request(
        `${AUTH_ORIGIN}/api/auth/reset-password/zzzzzzzzzzzzzzzzzzzzzzzz?callbackURL=https://evil.example`,
      ),
      env,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(RESET_PAGE);
    expect(location.searchParams.get("error")).toBe("INVALID_TOKEN");
  });

  it("sets the new password, revokes old sessions, and cannot be replayed", async () => {
    const token = new URL(job.actionUrl).pathname.split("/").at(-1) as string;
    const reset = await worker.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/reset-password`, {
        body: JSON.stringify({ newPassword: NEW_PASSWORD, token }),
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        method: "POST",
      }),
      env,
    );
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toEqual({ status: true });

    expect((await signIn(PASSWORD)).status).toBe(401);
    expect((await signIn(NEW_PASSWORD)).status).toBe(200);

    const oldSession = await worker.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/get-session`, {
        headers: { cookie: oldSessionCookie, origin: AUTH_ORIGIN },
      }),
      env,
    );
    await expect(oldSession.json()).resolves.toBeNull();

    const replay = await worker.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/reset-password`, {
        body: JSON.stringify({ newPassword: "yet-another-password-long", token }),
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        method: "POST",
      }),
      env,
    );
    expect(replay.status).toBe(400);
  });
});
