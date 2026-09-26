import { describe, expect, it } from "vitest";

import { MAX_RETRY_AFTER_MS, RenderApi, type ReportStatus } from "../src/api.ts";

/**
 * The /v1/render client (Codex P2): report retries honour Retry-After (capped) and
 * last as long as the lease has time left, instead of three fixed attempts that a
 * 120/min limiter window could swallow whole. A fake clock advances only when the
 * client sleeps, so every schedule below is exact.
 */

const JOB = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TOKEN = "t".repeat(40);

type Answer = { retryAfter?: string; status: number } | "network" | { throws: Error };

function harness(answers: Answer[], start = 1_000_000) {
  let clock = start;
  const sleeps: number[] = [];
  const requests: Array<{ body: string | null; headers: Record<string, string>; url: string }> = [];
  const api = new RenderApi({
    apiUrl: "https://api.test",
    async fetch(url, init) {
      requests.push({
        body: typeof init?.body === "string" ? init.body : null,
        headers: init?.headers as Record<string, string>,
        url,
      });
      const answer = answers.shift() ?? { status: 200 };
      if (answer === "network") {
        throw new TypeError("fetch failed");
      }
      if ("throws" in answer) {
        throw answer.throws;
      }
      return new Response(null, {
        headers: answer.retryAfter === undefined ? {} : { "retry-after": answer.retryAfter },
        status: answer.status,
      });
    },
    now: () => clock,
    async sleep(ms) {
      sleeps.push(ms);
      clock += ms;
    },
    token: TOKEN,
  });
  return { api, get clock() { return clock; }, requests, sleeps };
}

describe("report retries", () => {
  it("waits out each 429's Retry-After and lands the report inside the lease", async () => {
    const h = harness([
      { retryAfter: "40", status: 429 },
      { retryAfter: "25", status: 429 },
      { status: 200 },
    ]);
    const status = await h.api.report(JOB, "complete", { attempt: 1 }, h.clock + 590_000);
    expect(status).toBe(200);
    // The old schedule (2 s, 5 s, give up) would have spent all three attempts
    // inside one 60 s limiter window.
    expect(h.sleeps).toStrictEqual([40_000, 25_000]);
    expect(h.requests).toHaveLength(3);
    expect(h.requests[0]?.url).toBe(`https://api.test/v1/render/jobs/${JOB}/complete`);
    expect(h.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("caps a Retry-After it does not believe at 60 s", async () => {
    const h = harness([{ retryAfter: "3600", status: 429 }, { status: 200 }]);
    await h.api.report(JOB, "fail", { error: "x" }, h.clock + 590_000);
    expect(h.sleeps).toStrictEqual([MAX_RETRY_AFTER_MS]);
  });

  it("falls back to the back-off schedule on a 429 without Retry-After", async () => {
    const h = harness([{ status: 429 }, { status: 200 }]);
    await h.api.report(JOB, "fail", {}, h.clock + 590_000);
    expect(h.sleeps).toStrictEqual([2_000]);
  });

  it("keeps retrying no answer and 5xx for as long as the lease lasts — past three attempts", async () => {
    const h = harness([
      "network",
      { status: 503 },
      "network",
      { status: 500 },
      "network",
      { status: 200 },
    ]);
    const status = await h.api.report(JOB, "complete", {}, h.clock + 590_000);
    expect(status).toBe(200);
    expect(h.sleeps).toStrictEqual([2_000, 5_000, 10_000, 10_000, 10_000]);
  });

  it("stops before the deadline and returns the last unsettled status (abandoned)", async () => {
    const answers: Answer[] = Array.from({ length: 1_000 }, () => ({ status: 503 }));
    const h = harness(answers);
    const deadline = h.clock + 30_000;
    const status: ReportStatus = await h.api.report(JOB, "complete", {}, deadline);
    expect(status).toBe(503);
    // Attempts at 0, 2, 7, 17 and 27 s. A sleep happens only if it ENDS before the
    // deadline: 2, 7, 17 and 27 s do; the next would end at 37 s > 30 s, so the
    // fifth failure is returned as abandoned.
    expect(h.sleeps).toStrictEqual([2_000, 5_000, 10_000, 10_000]);
    expect(h.clock).toBe(deadline - 3_000);
    expect(h.requests).toHaveLength(5);
  });

  it("always makes one attempt, even with the deadline already past", async () => {
    const h = harness([{ status: 503 }]);
    expect(await h.api.report(JOB, "fail", {}, h.clock - 1)).toBe(503);
    expect(h.requests).toHaveLength(1);
    expect(h.sleeps).toStrictEqual([]);
  });

  it.each([200, 400, 404, 409, 422])("returns %s at once: the API has settled it", async (code) => {
    const h = harness([{ status: code }]);
    expect(await h.api.report(JOB, "complete", {}, h.clock + 590_000)).toBe(code);
    expect(h.sleeps).toStrictEqual([]);
  });
});

describe("acquire: may a lease have been made?", () => {
  it.each<[Answer, boolean]>([
    ["network", true],
    [{ status: 500 }, true],
    [{ status: 503 }, true],
    [{ status: 429, retryAfter: "7" }, false],
    [{ status: 404 }, false],
    [{ status: 401 }, false],
  ])("%j → mayHaveLeased %s", async (answer, mayHaveLeased) => {
    const h = harness([answer]);
    const result = await h.api.acquire();
    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.mayHaveLeased).toBe(mayHaveLeased);
  });

  function fetchFailed(causeCode: string): TypeError {
    return new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: causeCode }) });
  }

  it.each<[string, Error, boolean, string]>([
    ["a refused connection", fetchFailed("ECONNREFUSED"), false, "acquire_unreachable"],
    ["a refused dual-stack connection", new TypeError("fetch failed", {
      cause: Object.assign(new AggregateError([], "x"), { code: "ECONNREFUSED" }),
    }), false, "acquire_unreachable"],
    ["a DNS failure", fetchFailed("ENOTFOUND"), false, "acquire_unreachable"],
    ["a connect timeout", fetchFailed("UND_ERR_CONNECT_TIMEOUT"), false, "acquire_unreachable"],
    ["a socket dropped after sending", fetchFailed("UND_ERR_SOCKET"), true, "acquire_network"],
    ["a timeout after sending", new DOMException("aborted", "TimeoutError"), true, "acquire_network"],
  ])("%s → mayHaveLeased %s", async (_label, error, mayHaveLeased, code) => {
    const h = harness([{ throws: error }]);
    expect(await h.api.acquire()).toMatchObject({ code, kind: "unavailable", mayHaveLeased });
  });

  it("an unreadable 200 may have leased a job", async () => {
    const api = new RenderApi({
      apiUrl: "https://api.test",
      fetch: async () => new Response("{not json", { status: 200 }),
      sleep: async () => undefined,
      token: TOKEN,
    });
    expect(await api.acquire()).toMatchObject({ code: "acquire_bad_body", mayHaveLeased: true });
  });

  it("honours a 429's Retry-After on acquire", async () => {
    const h = harness([{ retryAfter: "7", status: 429 }]);
    expect(await h.api.acquire()).toMatchObject({ code: "acquire_rate_limited", retryAfterMs: 7_000 });
  });
});
