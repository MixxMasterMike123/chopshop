import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { createAuthEmailJob } from "../src/email/auth-email-job";
import type { AuthEmailJob } from "../src/email/auth-email-job";
import {
  RESEND_FETCH_OVERRIDE,
  backoffSeconds,
  readEmailDeliveryConfig,
} from "../src/email/email-queue-consumer";
import { routeQueue } from "../src/queues";

/**
 * The `-email` consumer and the suffix dispatcher, driven through the real
 * `queue()` export — with recording batches, plus one pool-built MessageBatch.
 * Resend is always the fake below; vitest's outboundService refuses anything
 * that would escape it.
 */
const EMAIL_QUEUE_NAME = "chopshop-test-email";

let jobCounter = 0;

function newJob(): AuthEmailJob {
  jobCounter += 1;
  return createAuthEmailJob(
    {
      actionUrl: `${env.AUTH_BASE_URL}/api/auth/reset-password/tokenconsumer${jobCounter.toString().padStart(11, "0")}?callbackURL=${encodeURIComponent("https://web.test.invalid/reset-password")}`,
      expiresAt: Date.now() + 60 * 60 * 1_000,
      kind: "password_reset",
      locale: "sv",
      recipient: `consumer-${jobCounter}@queue.test`,
    },
    env.AUTH_BASE_URL,
  );
}

interface FakeResend {
  calls: Request[];
  fetch: (request: Request) => Promise<Response>;
}

function fakeResend(respond: () => Response | Promise<Response>): FakeResend {
  const calls: Request[] = [];
  return {
    calls,
    async fetch(request: Request) {
      calls.push(request);
      return respond();
    },
  };
}

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

interface RunResult {
  explicitAcks: string[];
  retryBatch: { delaySeconds?: number; retry: boolean };
  retryMessages: { delaySeconds?: number; msgId: string }[];
}

/**
 * Drives the real `queue()` export with a batch that RECORDS what the consumer
 * asked for. The pool's getQueueResult reports ack/retry state but drops
 * `delaySeconds`, and the delay is half of what these tests pin; the pool's
 * own MessageBatch is exercised separately below.
 */
async function run(
  queueName: string,
  messages: { attempts?: number; body: unknown; id: string }[],
  targetEnv: Env,
): Promise<RunResult> {
  const result: RunResult = {
    explicitAcks: [],
    retryBatch: { retry: false },
    retryMessages: [],
  };
  const batch = {
    ackAll() {
      throw new Error("the consumer never acks a whole batch");
    },
    messages: messages.map((message) => ({
      ack() {
        result.explicitAcks.push(message.id);
      },
      attempts: message.attempts ?? 1,
      body: message.body,
      id: message.id,
      retry(options?: QueueRetryOptions) {
        result.retryMessages.push({ msgId: message.id, ...options });
      },
      timestamp: new Date(),
    })),
    queue: queueName,
    retryAll(options?: QueueRetryOptions) {
      result.retryBatch = { retry: true, ...options };
    },
  } as unknown as MessageBatch<unknown>;

  await worker.queue(batch, targetEnv);
  return result;
}

async function ledger(deliveryId: string) {
  return env.DB.prepare(
    `SELECT status, attempts, next_attempt_at, last_error_code,
            provider_message_id, resolved_at, lease_token
     FROM email_deliveries WHERE delivery_id = ?`,
  )
    .bind(deliveryId)
    .first<{
      attempts: number;
      last_error_code: string | null;
      lease_token: string | null;
      next_attempt_at: number;
      provider_message_id: string | null;
      resolved_at: number | null;
      status: string;
    }>();
}

describe("the -email consumer: delivery outcomes", () => {
  it("sends once and records the provider id", async () => {
    const job = newJob();
    const resend = fakeResend(() => Response.json({ id: "re_happy_1" }));

    const result = await run(
      EMAIL_QUEUE_NAME,
      [{ body: job, id: "happy-1" }],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.explicitAcks).toEqual(["happy-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(result.retryBatch.retry).toBe(false);
    expect(resend.calls).toHaveLength(1);
    await expect(ledger(job.deliveryId)).resolves.toMatchObject({
      attempts: 1,
      lease_token: null,
      provider_message_id: "re_happy_1",
      status: "sent",
    });
    expect((await ledger(job.deliveryId))?.resolved_at).not.toBeNull();
  });

  it("sends a redelivered job exactly once", async () => {
    const job = newJob();
    const resend = fakeResend(() => Response.json({ id: "re_idem_1" }));
    const target = envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch });

    const first = await run(EMAIL_QUEUE_NAME, [{ body: job, id: "idem-1" }], target);
    const second = await run(
      EMAIL_QUEUE_NAME,
      [{ attempts: 2, body: job, id: "idem-1" }],
      target,
    );

    expect(first.explicitAcks).toEqual(["idem-1"]);
    expect(second.explicitAcks).toEqual(["idem-1"]);
    expect(resend.calls).toHaveLength(1);
  });

  it("sends a job duplicated inside one batch exactly once", async () => {
    const job = newJob();
    const resend = fakeResend(() => Response.json({ id: "re_dup_1" }));

    const result = await run(
      EMAIL_QUEUE_NAME,
      [
        { body: job, id: "dup-a" },
        { body: job, id: "dup-b" },
      ],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(resend.calls).toHaveLength(1);
    // The second copy finds the row sent (terminal) and is acked.
    expect(result.explicitAcks.sort()).toEqual(["dup-a", "dup-b"]);
  });

  it("presents the key, the idempotency key and the rendered Swedish email", async () => {
    const job = newJob();
    const resend = fakeResend(() => Response.json({ id: "re_shape_1" }));

    await run(
      EMAIL_QUEUE_NAME,
      [{ body: job, id: "shape-1" }],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    const call = resend.calls[0] as Request;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.headers.get("authorization")).toBe(`Bearer ${env.RESEND_API_KEY}`);
    expect(call.headers.get("idempotency-key")).toBe(job.deliveryId);
    expect(call.headers.get("content-type")).toBe("application/json");
    const body = await call.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(body.to).toEqual([job.recipient]);
    expect(body.subject).toBe("Återställ ditt lösenord");
  });

  it("records a sent row even when the provider returns no readable id", async () => {
    const job = newJob();
    const resend = fakeResend(() => new Response("accepted", { status: 202 }));

    const result = await run(
      EMAIL_QUEUE_NAME,
      [{ body: job, id: "noid-1" }],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.explicitAcks).toEqual(["noid-1"]);
    await expect(ledger(job.deliveryId)).resolves.toMatchObject({
      provider_message_id: null,
      status: "sent",
    });
  });

  it("retries a 429 after the provider's Retry-After and reschedules the ledger", async () => {
    const job = newJob();
    const resend = fakeResend(
      () => new Response("slow down", { headers: { "retry-after": "120" }, status: 429 }),
    );
    const target = envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch });
    const before = Date.now();

    const result = await run(EMAIL_QUEUE_NAME, [{ body: job, id: "rl-1" }], target);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ delaySeconds: 120, msgId: "rl-1" }]);
    const row = await ledger(job.deliveryId);
    expect(row).toMatchObject({
      attempts: 1,
      last_error_code: "E_PROVIDER_429",
      lease_token: null,
      status: "pending",
    });
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(before + 120_000);

    // An early redelivery (before next_attempt_at) is not claimed and sends
    // nothing; it backs off again.
    const early = await run(
      EMAIL_QUEUE_NAME,
      [{ attempts: 2, body: job, id: "rl-1" }],
      target,
    );
    expect(early.retryMessages).toEqual([{ delaySeconds: 30, msgId: "rl-1" }]);
    expect(resend.calls).toHaveLength(1);
  });

  it.each([
    [503, 1, 30],
    [500, 3, 120],
    [408, 2, 60],
    [409, 1, 30],
  ])("retries a %i with exponential backoff (attempt %i → %i s)", async (
    status,
    attempts,
    delay,
  ) => {
    const job = newJob();
    const resend = fakeResend(() => new Response("nope", { status }));

    const result = await run(
      EMAIL_QUEUE_NAME,
      [{ attempts, body: job, id: `backoff-${status}` }],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.retryMessages).toEqual([
      { delaySeconds: delay, msgId: `backoff-${status}` },
    ]);
    await expect(ledger(job.deliveryId)).resolves.toMatchObject({
      last_error_code: `E_PROVIDER_${status}`,
      status: "pending",
    });
  });

  it("retries a network failure", async () => {
    const job = newJob();
    const resend = fakeResend(() => {
      throw new TypeError("network down");
    });

    const result = await run(
      EMAIL_QUEUE_NAME,
      [{ body: job, id: "net-1" }],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.retryMessages).toEqual([{ delaySeconds: 30, msgId: "net-1" }]);
    await expect(ledger(job.deliveryId)).resolves.toMatchObject({
      last_error_code: "E_PROVIDER_NETWORK",
      status: "pending",
    });
  });

  it.each([400, 401, 403, 422])(
    "fails a %i permanently: ledger failed, message acked, never resent",
    async (status) => {
      const job = newJob();
      const resend = fakeResend(
        () => new Response(`{"message":"${job.recipient} rejected"}`, { status }),
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const target = envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch });

      const result = await run(
        EMAIL_QUEUE_NAME,
        [{ body: job, id: `fail-${status}` }],
        target,
      );

      expect(result.explicitAcks).toEqual([`fail-${status}`]);
      expect(result.retryMessages).toEqual([]);
      const row = await ledger(job.deliveryId);
      expect(row).toMatchObject({
        last_error_code: `E_PROVIDER_${status}`,
        lease_token: null,
        status: "failed",
      });
      expect(row?.resolved_at).not.toBeNull();
      // Provider text (which echoes the recipient) never reaches a log line.
      for (const call of error.mock.calls) {
        expect(String(call[0])).not.toContain(job.recipient);
      }
      error.mockRestore();

      const again = await run(
        EMAIL_QUEUE_NAME,
        [{ attempts: 2, body: job, id: `fail-${status}` }],
        target,
      );
      expect(again.explicitAcks).toEqual([`fail-${status}`]);
      expect(resend.calls).toHaveLength(1);
    },
  );

  it("acks an expired job without sending it", async () => {
    const now = Date.now();
    const expired = {
      ...newJob(),
      createdAt: now - 2 * 60 * 60 * 1_000,
      expiresAt: now - 60 * 60 * 1_000,
    };
    const resend = fakeResend(() => Response.json({ id: "never" }));

    const result = await run(
      EMAIL_QUEUE_NAME,
      [{ body: expired, id: "expired-1" }],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.explicitAcks).toEqual(["expired-1"]);
    expect(resend.calls).toHaveLength(0);
    await expect(ledger(expired.deliveryId)).resolves.toMatchObject({
      status: "expired",
    });
  });

  it.each([
    ["not an object", "just a string"],
    ["a foreign action URL", { ...newJob(), actionUrl: "https://evil.example/api/auth/reset-password/x" }],
    ["a missing delivery id", { ...newJob(), deliveryId: "not-a-uuid" }],
  ])("drops a malformed job (%s) without sending or logging its body", async (
    _label,
    body,
  ) => {
    const resend = fakeResend(() => Response.json({ id: "never" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await run(
      EMAIL_QUEUE_NAME,
      [{ body, id: "malformed-1" }],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.explicitAcks).toEqual(["malformed-1"]);
    expect(resend.calls).toHaveLength(0);
    const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("malformed");
    expect(logged).not.toContain("evil.example");
    expect(logged).not.toContain("@queue.test");
    error.mockRestore();
  });
});

describe("the -email consumer without delivery configuration", () => {
  it.each([
    ["no RESEND_API_KEY", { RESEND_API_KEY: undefined }],
    ["an empty RESEND_API_KEY", { RESEND_API_KEY: "" }],
    ["no EMAIL_FROM", { EMAIL_FROM: undefined }],
    ["an EMAIL_FROM with a line break", { EMAIL_FROM: "x <a@b.test>\r\nBcc: c@d.test" }],
    ["an EMAIL_FROM that is not an address", { EMAIL_FROM: "ChopShop" }],
  ])("holds the whole batch for 300 s with %s, touching nothing", async (
    _label,
    overrides,
  ) => {
    const job = newJob();
    const resend = fakeResend(() => Response.json({ id: "never" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await run(
      EMAIL_QUEUE_NAME,
      [{ body: job, id: "unconfigured-1" }],
      envWith({ ...overrides, [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.retryBatch).toEqual({ delaySeconds: 300, retry: true });
    expect(result.explicitAcks).toEqual([]);
    expect(resend.calls).toHaveLength(0);
    // Not even claimed: the ledger never saw this job.
    await expect(ledger(job.deliveryId)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledOnce();
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain("email delivery is not configured");
    expect(logged).not.toContain(job.recipient);
    expect(logged).not.toContain(job.actionUrl);
    warn.mockRestore();
  });

  it("accepts both sender shapes", () => {
    expect(
      readEmailDeliveryConfig(envWith({ EMAIL_FROM: "no-reply@mail.test.invalid" })),
    ).not.toBeNull();
    expect(
      readEmailDeliveryConfig(
        envWith({ EMAIL_FROM: "ChopShop <no-reply@mail.test.invalid>" }),
      ),
    ).not.toBeNull();
  });
});

describe("queue dispatch by suffix", () => {
  it.each([
    ["chopshop-stg-email", "email"],
    ["chopshop-prod-email", "email"],
    ["chopshop-test-email", "email"],
    // CP2-B: the outbox has its nudge consumer; see test/outbox.test.ts.
    ["chopshop-stg-outbox", "outbox"],
    ["chopshop-prod-outbox", "outbox"],
    ["chopshop-stg-outbox-dlq", "held"],
    // CP1-C: the render-jobs queue has its (nudge-only) consumer; see
    // test/render-jobs.test.ts for what it does with a batch.
    ["chopshop-prod-render-jobs", "render_jobs"],
    ["chopshop-test-render-jobs", "render_jobs"],
    ["chopshop-stg-render-jobs-dlq", "held"],
    ["meteorshop-stg-email-auth", "held"],
    ["chopshop-stg-email-dlq", "held"],
    ["email", "held"],
  ])("routes %s to %s", (name, route) => {
    expect(routeQueue(name)).toBe(route);
  });

  it.each([
    "chopshop-stg-render-jobs-dlq",
    "meteorshop-stg-email-auth",
    "chopshop-stg-email-dlq",
  ])("holds %s for 300 s without reading a body", async (queueName) => {
    const resend = fakeResend(() => Response.json({ id: "never" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await run(
      queueName,
      [
        {
          body: {
            actionUrl: "https://should-not-appear.example/token",
            recipient: "should-not-appear@example.test",
          },
          id: "held-1",
        },
      ],
      envWith({ [RESEND_FETCH_OVERRIDE]: resend.fetch }),
    );

    expect(result.retryBatch).toEqual({ delaySeconds: 300, retry: true });
    expect(result.explicitAcks).toEqual([]);
    expect(resend.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain(queueName);
    expect(logged).not.toContain("should-not-appear");
    warn.mockRestore();
  });
});

describe("the pool's own MessageBatch", () => {
  it("acks a delivered message and retries a failed one on the real batch type", async () => {
    const sentJob = newJob();
    const failedJob = newJob();
    const resend = fakeResend(() => Response.json({ id: "re_pool_1" }));
    let call = 0;
    const alternating = async (request: Request) => {
      call += 1;
      return call === 1
        ? resend.fetch(request)
        : new Response("unavailable", { status: 503 });
    };

    const batch = createMessageBatch(EMAIL_QUEUE_NAME, [
      { attempts: 1, body: sentJob, id: "pool-sent", timestamp: new Date() },
      { attempts: 1, body: failedJob, id: "pool-retry", timestamp: new Date() },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(
      batch,
      envWith({ [RESEND_FETCH_OVERRIDE]: alternating }),
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["pool-sent"]);
    expect(result.retryMessages.map((message: { msgId: string }) => message.msgId)).toEqual([
      "pool-retry",
    ]);
    await expect(ledger(sentJob.deliveryId)).resolves.toMatchObject({
      status: "sent",
    });
    await expect(ledger(failedJob.deliveryId)).resolves.toMatchObject({
      status: "pending",
    });
  });
});

describe("backoff", () => {
  it("doubles from 30 s and caps at an hour", () => {
    expect([1, 2, 3, 4, 7, 8, 20].map(backoffSeconds)).toEqual([
      30, 60, 120, 240, 1920, 3600, 3600,
    ]);
    expect(backoffSeconds(0)).toBe(30);
  });
});
