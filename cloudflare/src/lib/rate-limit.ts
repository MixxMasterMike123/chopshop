export interface RateLimitOptions {
  key: string;
  limit: number;
  now: number;
  scope: string;
  windowMs: number;
}

/**
 * A discriminated union rather than a bare optional: retryAfterSeconds is
 * meaningful only on a denial, and this shape makes the compiler prove a caller
 * has checked `allowed` before it can read the value.
 */
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

// Swept windows are kept well past their expiry so a limit is never widened by
// the cleanup itself: even a window far longer than any configured here is long
// dead by the time it becomes eligible.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

// Rows deleted per opportunistic sweep. Bounded so the cleanup can never turn a
// single request into an unbounded table scan; a backlog drains over the next
// few fresh windows instead of in one query.
const CLEANUP_BATCH = 500;

// The counter keeps incrementing past the limit — that is simpler than
// conditionally stopping, and a caller already over the limit is denied either
// way — so it needs a ceiling. Far below Number.MAX_SAFE_INTEGER and SQLite's
// 64-bit integer range, so a sustained flood clamps here rather than overflowing.
const MAX_COUNT = 1_000_000;

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Hashes the caller key together with the scope it was presented under. The
 * scope is inside the digest, not merely beside it in the composite key, so a
 * hash observed in one scope's rows cannot be matched against another's — and
 * more importantly the raw key, always an IP address or an email address, never
 * reaches D1 or a log line.
 */
async function hashKey(scope: string, key: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${scope}:${key}`),
    ),
  );
}

/**
 * The client address as Cloudflare sees it. CF-Connecting-IP is set by the edge
 * on every request and cannot be spoofed by the client — unlike X-Forwarded-For,
 * which is caller-supplied and is deliberately not consulted here.
 *
 * A missing header means the request did not arrive through the edge, so there
 * is no address to trust and every such caller shares the single 'unknown'
 * bucket. That is fail-safe rather than fail-open: the shared bucket is
 * STRICTER than a per-caller one — unrelated unattributable callers contend for
 * one allowance — so the degenerate case throttles harder, never less.
 */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * Counts one request against a fixed window and says whether it may proceed.
 *
 * Fixed windows rather than a sliding log: one row and one write per limited
 * request, no per-request history to store or prune. The cost is the usual
 * boundary burst — up to 2x the limit across a window edge — which is an
 * acceptable trade for a shield whose job is to stop floods, not to meter
 * precisely.
 *
 * Durable and global by virtue of living in D1, so a limit holds across colos
 * and across worker restarts. One D1 write per limited request is the price.
 *
 * D1 errors are deliberately NOT caught. Failing open here would silently
 * remove the shield exactly when the database is under stress, which is when it
 * matters most — and every caller of this function goes on to do its own D1
 * work, so a broken database fails the request a moment later regardless.
 */
export async function enforceRateLimit(
  db: D1Database,
  options: RateLimitOptions,
): Promise<RateLimitDecision> {
  const windowStart = options.now - (options.now % options.windowMs);
  const keyHash = await hashKey(options.scope, options.key);

  // Single atomic statement: the upsert both claims a fresh window and
  // increments an existing one, and RETURNING hands back the post-increment
  // count. Two concurrent requests therefore cannot both read the same count
  // and both decide they are under the limit.
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_windows (
         scope, key_hash, window_start, count, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(scope, key_hash, window_start) DO UPDATE SET
         count = MIN(rate_limit_windows.count + 1, ${MAX_COUNT}),
         -- MAX against the stored value, not a plain assignment: two colos can
         -- disagree slightly about the wall clock, so an increment arriving with
         -- an earlier timestamp than the row's creation must not drive
         -- updated_at backwards past the CHECK. Skew would otherwise turn the
         -- limiter into a 500 on the very route it is protecting.
         updated_at = MAX(rate_limit_windows.updated_at, excluded.updated_at)
       RETURNING count`,
    )
    .bind(options.scope, keyHash, windowStart, options.now, options.now)
    .first<{ count: number }>();

  // RETURNING on an upsert always yields the affected row; a null here would
  // mean D1 stopped honouring it, and counting that as "allowed" would silently
  // disable the limiter. Treat it as the failure it is.
  if (row === null) {
    throw new Error("rate limit counter returned no row");
  }

  if (row.count === 1) {
    // A fresh window is the natural moment to sweep: it happens at most once
    // per key per window, so the cleanup rides along on a small fraction of
    // requests instead of every one. Bounded by LIMIT (supported by D1 since
    // 2024-01-18) so the extra work stays predictable.
    await db
      .prepare(
        `DELETE FROM rate_limit_windows
         WHERE scope = ? AND window_start < ?
         LIMIT ${CLEANUP_BATCH}`,
      )
      .bind(options.scope, options.now - RETENTION_MS)
      .run();
  }

  if (row.count <= options.limit) {
    return { allowed: true };
  }

  // Ceil, then floor at 1: a caller told to retry in 0 seconds would retry
  // inside the same window and be denied again.
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart + options.windowMs - options.now) / 1_000),
  );

  return { allowed: false, retryAfterSeconds };
}
