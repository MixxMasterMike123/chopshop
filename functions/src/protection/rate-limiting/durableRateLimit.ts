// Durable, distributed rate limiting (P1-02, 2026-08-15 audit).
//
// The legacy in-memory limiter (rate-limiter.ts) dies with the instance and
// trusts the FIRST X-Forwarded-For entry — which the caller writes. This one
// keeps fixed-window counters in Firestore (shared across all instances) and
// derives the client IP from the LAST XFF entry, which Google's front end
// APPENDS on Cloud Run/Functions v2 — earlier entries are caller-supplied.
//
// Semantics: fixed window. Doc id = scope + key + window start, one
// transactional increment per request. FAIL-OPEN on Firestore errors — a
// limiter outage must never take checkout down; the abuse case it exists for
// is sustained volume, which the next healthy window still catches.
//
// Housekeeping: every counter doc carries `expireAt` (window end + 24h) so a
// Firestore TTL policy on rateLimits.expireAt can garbage-collect them
// (console: Firestore → TTL → collection `rateLimits`, field `expireAt`).
// Without the TTL policy stale docs simply accumulate — harmless but untidy.

import { logger } from 'firebase-functions';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../../config/database';

export interface RateLimitOptions {
  limit: number;      // max requests per window
  windowSec: number;  // window length in seconds
}

// Key sanitizer — IPs/emails/uids become safe doc-id fragments.
const safeKey = (raw: string): string =>
  (raw || 'unknown').toLowerCase().replace(/[^a-z0-9._:-]/g, '_').slice(0, 120);

// Per-instance memory of the last count seen per counter doc. Two jobs
// (verifier findings, 2026-08-15):
//   1. Once THIS instance has seen a key over its limit, deny without a
//      transaction — the hot-document contention an attacker flood causes
//      can no longer flip the limiter open on that instance.
//   2. If the transaction fails (contention/abort) we fall back to the last
//      seen count instead of blindly failing open.
// Fixed-size, oldest-first eviction — never grows unbounded.
const lastSeen = new Map<string, number>();
const LAST_SEEN_MAX = 5000;
const rememberCount = (docId: string, count: number) => {
  if (lastSeen.size >= LAST_SEEN_MAX && !lastSeen.has(docId)) {
    const oldest = lastSeen.keys().next().value;
    if (oldest !== undefined) lastSeen.delete(oldest);
  }
  lastSeen.set(docId, count);
};

/**
 * Count one hit for (scope, key) and report whether it is within the limit.
 * @returns true = allowed, false = over the limit (caller rejects with 429).
 */
export async function checkRateLimit(
  scope: string,
  key: string,
  { limit, windowSec }: RateLimitOptions
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / (windowSec * 1000)) * windowSec;
  const docId = `${scope}__${safeKey(key)}__${windowStart}`;
  // Instance-local fast deny: already known to be over the limit this window.
  if ((lastSeen.get(docId) ?? 0) >= limit) return false;
  const ref = db.collection('rateLimits').doc(docId);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = (snap.exists ? Number(snap.data()?.count) : 0) || 0;
      if (count >= limit) {
        rememberCount(docId, count);
        return false;
      }
      tx.set(ref, {
        scope,
        count: count + 1,
        windowStart,
        expireAt: Timestamp.fromMillis((windowStart + windowSec) * 1000 + 24 * 60 * 60 * 1000),
      }, { merge: true });
      rememberCount(docId, count + 1);
      return true;
    });
  } catch (e: any) {
    // Transaction failed (contention/outage). Fall back to the last count this
    // instance saw — an attacker-induced hot-doc flood therefore stays DENIED
    // once the limit was reached, while a genuine Firestore outage on a quiet
    // key still fails open (availability for real users).
    const seen = lastSeen.get(docId) ?? 0;
    logger.error('rateLimit: transaction failed', { scope, lastSeenCount: seen, error: e?.message });
    return seen < limit;
  }
}

/**
 * Trusted client IP for Cloud Run / Cloud Functions v2: Google's front end
 * appends the connecting client's IP as the LAST X-Forwarded-For entry.
 * Everything before it arrived in the request and is spoofable.
 * Accepts an Express Request or a callable's rawRequest.
 */
export function trustedClientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const xff = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : String(xff || '');
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const ip = parts.length ? parts[parts.length - 1] : (req.ip || 'unknown');
  // IPv6 rotation guard (verifier finding, 2026-08-15): a consumer line owns a
  // whole /64, so keying on the full address hands an attacker 2^64 fresh
  // keys. Bucket IPv6 to its /64 prefix; IPv4 stays exact.
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':') + '::/64';
  }
  return ip;
}
