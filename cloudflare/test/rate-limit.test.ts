import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { clientIp, enforceRateLimit } from "../src/lib/rate-limit";

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

// Deliberately not a window boundary: every test that cares about edges derives
// its own aligned value, so nothing accidentally depends on a tidy start.
const NOW = 1_787_500_000_000;

interface WindowRow {
  count: number;
  created_at: number;
  key_hash: string;
  scope: string;
  updated_at: number;
  window_start: number;
}

async function hit(
  options: {
    key: string;
    limit?: number;
    now?: number;
    scope: string;
    windowMs?: number;
  },
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  return enforceRateLimit(env.DB, {
    key: options.key,
    limit: options.limit ?? 3,
    now: options.now ?? NOW,
    scope: options.scope,
    windowMs: options.windowMs ?? MINUTE_MS,
  });
}

async function rows(scope: string): Promise<WindowRow[]> {
  const result = await env.DB.prepare(
    `SELECT scope, key_hash, window_start, count, created_at, updated_at
     FROM rate_limit_windows
     WHERE scope = ?
     ORDER BY window_start ASC`,
  )
    .bind(scope)
    .all<WindowRow>();

  return result.results;
}

describe("enforceRateLimit fixed window", () => {
  it("allows exactly the limit and denies the next request", async () => {
    const scope = "unit-basic";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(hit({ key: "a", scope })).resolves.toEqual({
        allowed: true,
      });
    }

    const denied = await hit({ key: "a", scope });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("keeps counting past the limit and stays denied", async () => {
    const scope = "unit-past-limit";

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await hit({ key: "a", scope });
    }

    await expect(hit({ key: "a", scope })).resolves.toMatchObject({
      allowed: false,
    });

    const [row] = await rows(scope);
    expect(row?.count).toBe(11);
  });

  it("clamps a sustained flood at the ceiling and stays denied", async () => {
    const scope = "unit-ceiling";
    const windowStart = NOW - (NOW % MINUTE_MS);
    const keyHash = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(`${scope}:a`))
      .then((buffer) =>
        Array.from(new Uint8Array(buffer), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      );

    // Seeded at the ceiling rather than counted up to it: reaching 1e6 for real
    // would take a million writes, and the behaviour under test is what the
    // clamp does once it is pinned, not how long it takes to get there.
    await env.DB
      .prepare(
        `INSERT INTO rate_limit_windows (
          scope, key_hash, window_start, count, created_at, updated_at
        ) VALUES (?, ?, ?, 1000000, ?, ?)`,
      )
      .bind(scope, keyHash, windowStart, windowStart, windowStart)
      .run();

    await expect(
      hit({ key: "a", now: windowStart, scope }),
    ).resolves.toMatchObject({ allowed: false });

    // Pinned, not overflowed, and still far above any real limit — so the
    // clamp can never wrap a flood back around into "allowed".
    const [row] = await rows(scope);
    expect(row?.count).toBe(1_000_000);
  });

  it("re-allows once the window rolls over", async () => {
    const scope = "unit-rollover";
    const windowStart = NOW - (NOW % MINUTE_MS);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await hit({ key: "a", now: windowStart, scope });
    }
    await expect(hit({ key: "a", now: windowStart, scope })).resolves.toMatchObject(
      { allowed: false },
    );

    // One millisecond into the next window is enough: the window is identified
    // by its floored start, not by elapsed time since the first request.
    await expect(
      hit({ key: "a", now: windowStart + MINUTE_MS, scope }),
    ).resolves.toEqual({ allowed: true });

    // The old window's row survives — it is swept on age, not on rollover — so
    // both windows are counted independently.
    const stored = await rows(scope);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.count).toBe(5);
    expect(stored[1]?.count).toBe(1);
  });

  it("survives an increment whose clock runs behind the row's creation", async () => {
    const scope = "unit-clock-skew";
    const windowStart = NOW - (NOW % MINUTE_MS);

    // The window is opened by a request late in the window...
    await expect(
      hit({ key: "a", now: windowStart + 30_000, scope }),
    ).resolves.toEqual({ allowed: true });

    // ...and incremented by one whose clock reads earlier. Two Cloudflare colos
    // can disagree about the wall clock by a few milliseconds, so this is an
    // ordinary production event, not a contrived one. It must count normally
    // rather than trip the updated_at >= created_at CHECK and 500 the route the
    // limiter is supposed to be protecting.
    await expect(
      hit({ key: "a", now: windowStart + 1_000, scope }),
    ).resolves.toEqual({ allowed: true });

    const [row] = await rows(scope);
    expect(row?.count).toBe(2);
    // updated_at holds at the later value rather than regressing.
    expect(row?.created_at).toBe(windowStart + 30_000);
    expect(row?.updated_at).toBe(windowStart + 30_000);
  });

  it("floors every request in one window onto the same row", async () => {
    const scope = "unit-floor";
    const windowStart = NOW - (NOW % MINUTE_MS);

    await hit({ key: "a", now: windowStart, scope });
    await hit({ key: "a", now: windowStart + 1, scope });
    await hit({ key: "a", now: windowStart + MINUTE_MS - 1, scope });

    const stored = await rows(scope);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ count: 3, window_start: windowStart });
    // created_at pins the window's first request; updated_at moves with the
    // latest, so the row shows both without a second write path.
    expect(stored[0]?.created_at).toBe(windowStart);
    expect(stored[0]?.updated_at).toBe(windowStart + MINUTE_MS - 1);
  });
});

describe("enforceRateLimit retryAfterSeconds", () => {
  it("reports the whole window when denied at its very start", async () => {
    const scope = "unit-retry-start";
    const windowStart = NOW - (NOW % MINUTE_MS);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await hit({ key: "a", now: windowStart, scope });
    }

    await expect(
      hit({ key: "a", now: windowStart, scope }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("rounds a partially elapsed window up to the next whole second", async () => {
    const scope = "unit-retry-mid";
    const windowStart = NOW - (NOW % MINUTE_MS);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await hit({ key: "a", now: windowStart, scope });
    }

    // 30.5s elapsed leaves 29.5s, which must round UP: rounding down would
    // invite a retry that is still inside the window.
    await expect(
      hit({ key: "a", now: windowStart + 30_500, scope }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it("never reports zero at the last millisecond of a window", async () => {
    const scope = "unit-retry-edge";
    const windowStart = NOW - (NOW % MINUTE_MS);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await hit({ key: "a", now: windowStart, scope });
    }

    // 1ms left rounds to 1s, not 0: a caller told to wait 0 seconds would retry
    // inside the same window and be denied again.
    await expect(
      hit({ key: "a", now: windowStart + MINUTE_MS - 1, scope }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

describe("enforceRateLimit isolation", () => {
  it("counts two keys in one scope independently", async () => {
    const scope = "unit-two-keys";

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await hit({ key: "a", scope });
    }
    await expect(hit({ key: "a", scope })).resolves.toMatchObject({
      allowed: false,
    });

    await expect(hit({ key: "b", scope })).resolves.toEqual({ allowed: true });
  });

  it("counts one key in two scopes independently", async () => {
    const shared = "same-key@example.test";

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await hit({ key: shared, scope: "unit-scope-one" });
    }
    await expect(
      hit({ key: shared, scope: "unit-scope-one" }),
    ).resolves.toMatchObject({ allowed: false });

    await expect(
      hit({ key: shared, scope: "unit-scope-two" }),
    ).resolves.toEqual({ allowed: true });

    // The scope is inside the digest, so the same caller key produces unrelated
    // hashes: neither scope's rows can be matched against the other's.
    const [one] = await rows("unit-scope-one");
    const [two] = await rows("unit-scope-two");
    expect(one?.key_hash).not.toBe(two?.key_hash);
  });
});

describe("enforceRateLimit key privacy", () => {
  it("stores a hash and never the raw address", async () => {
    const scope = "unit-privacy";
    const email = "private-buyer@example.test";
    const ip = "192.0.2.77";

    await hit({ key: email, scope });
    await hit({ key: ip, scope });

    const stored = await rows(scope);
    expect(stored).toHaveLength(2);

    for (const row of stored) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    // Swept across the entire table rather than the rows just written: a raw
    // key leaking into any column at all is the failure being ruled out.
    const dumped = JSON.stringify(
      (
        await env.DB.prepare("SELECT * FROM rate_limit_windows").all<
          Record<string, unknown>
        >()
      ).results,
    );
    expect(dumped).not.toContain(email);
    expect(dumped).not.toContain("private-buyer");
    expect(dumped).not.toContain(ip);
  });
});

describe("enforceRateLimit cleanup", () => {
  it("sweeps expired windows when a fresh window opens", async () => {
    const scope = "unit-cleanup";
    const windowStart = NOW - (NOW % MINUTE_MS);

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO rate_limit_windows (
            scope, key_hash, window_start, count, created_at, updated_at
          ) VALUES (?, ?, ?, 9, ?, ?)`,
        )
        .bind(scope, "a".repeat(64), windowStart - 8 * DAY_MS, NOW, NOW),
      env.DB
        .prepare(
          `INSERT INTO rate_limit_windows (
            scope, key_hash, window_start, count, created_at, updated_at
          ) VALUES (?, ?, ?, 9, ?, ?)`,
        )
        .bind(scope, "b".repeat(64), windowStart - 30 * DAY_MS, NOW, NOW),
      // Inside the retention horizon: must survive, or the sweep would be
      // deleting windows that are still counting.
      env.DB
        .prepare(
          `INSERT INTO rate_limit_windows (
            scope, key_hash, window_start, count, created_at, updated_at
          ) VALUES (?, ?, ?, 9, ?, ?)`,
        )
        .bind(scope, "c".repeat(64), windowStart - MINUTE_MS, NOW, NOW),
    ]);

    expect(await rows(scope)).toHaveLength(3);

    // A fresh window for an unrelated key is what triggers the sweep.
    await expect(
      hit({ key: "sweeper", now: windowStart, scope }),
    ).resolves.toEqual({ allowed: true });

    // Both expired rows are gone; the recent one and the new one remain.
    const remaining = await rows(scope);
    expect(remaining).toHaveLength(2);
    expect(remaining.some((row) => row.key_hash === "a".repeat(64))).toBe(false);
    expect(remaining.some((row) => row.key_hash === "b".repeat(64))).toBe(false);
    expect(remaining.some((row) => row.key_hash === "c".repeat(64))).toBe(true);
  });

  it("leaves another scope's expired rows alone", async () => {
    const scope = "unit-cleanup-scoped";
    const neighbour = "unit-cleanup-neighbour";
    const windowStart = NOW - (NOW % MINUTE_MS);

    await env.DB
      .prepare(
        `INSERT INTO rate_limit_windows (
          scope, key_hash, window_start, count, created_at, updated_at
        ) VALUES (?, ?, ?, 9, ?, ?)`,
      )
      .bind(neighbour, "d".repeat(64), windowStart - 8 * DAY_MS, NOW, NOW)
      .run();

    await hit({ key: "sweeper", now: windowStart, scope });

    // The sweep is scoped, so a busy limit cannot pay the cost of cleaning up
    // after a quiet one — and a quiet scope's rows wait for its own next window.
    expect(await rows(neighbour)).toHaveLength(1);
  });

  it("does not sweep when an existing window is merely incremented", async () => {
    const scope = "unit-cleanup-increment";
    const windowStart = NOW - (NOW % MINUTE_MS);

    await hit({ key: "a", now: windowStart, scope });

    await env.DB
      .prepare(
        `INSERT INTO rate_limit_windows (
          scope, key_hash, window_start, count, created_at, updated_at
        ) VALUES (?, ?, ?, 9, ?, ?)`,
      )
      .bind(scope, "e".repeat(64), windowStart - 8 * DAY_MS, NOW, NOW)
      .run();

    // The second hit on the same key returns count 2, not 1, so no sweep fires.
    await hit({ key: "a", now: windowStart, scope });

    expect(
      (await rows(scope)).some((row) => row.key_hash === "e".repeat(64)),
    ).toBe(true);
  });
});

describe("clientIp", () => {
  it("reads the edge-supplied address", () => {
    expect(
      clientIp(
        new Request("https://api.test/", {
          headers: { "cf-connecting-ip": "198.51.100.9" },
        }),
      ),
    ).toBe("198.51.100.9");
  });

  it("falls back to one shared bucket when the edge header is absent", () => {
    expect(clientIp(new Request("https://api.test/"))).toBe("unknown");
  });

  it("ignores a caller-supplied forwarding header", () => {
    // X-Forwarded-For is attacker-controlled; honouring it would hand every
    // caller an unlimited supply of fresh buckets.
    expect(
      clientIp(
        new Request("https://api.test/", {
          headers: { "x-forwarded-for": "203.0.113.5" },
        }),
      ),
    ).toBe("unknown");
  });
});

describe("rate_limit_windows invariants", () => {
  it("rejects a count below one", async () => {
    await expect(
      env.DB
        .prepare(
          `INSERT INTO rate_limit_windows (
            scope, key_hash, window_start, count, created_at, updated_at
          ) VALUES ('invariant', ?, 0, 0, ?, ?)`,
        )
        .bind("f".repeat(64), NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a key that is not a sha-256 digest", async () => {
    await expect(
      env.DB
        .prepare(
          `INSERT INTO rate_limit_windows (
            scope, key_hash, window_start, count, created_at, updated_at
          ) VALUES ('invariant', ?, 0, 1, ?, ?)`,
        )
        .bind("buyer@example.test", NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a second row for the same scope, key and window", async () => {
    const insert = (): Promise<D1Result> =>
      env.DB
        .prepare(
          `INSERT INTO rate_limit_windows (
            scope, key_hash, window_start, count, created_at, updated_at
          ) VALUES ('invariant-pk', ?, 0, 1, ?, ?)`,
        )
        .bind("0".repeat(64), NOW, NOW)
        .run();

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toThrow();
  });
});
