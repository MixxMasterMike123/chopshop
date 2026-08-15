export interface RateLimitOptions {
    limit: number;
    windowSec: number;
}
/**
 * Count one hit for (scope, key) and report whether it is within the limit.
 * @returns true = allowed, false = over the limit (caller rejects with 429).
 */
export declare function checkRateLimit(scope: string, key: string, { limit, windowSec }: RateLimitOptions): Promise<boolean>;
/**
 * Trusted client IP for Cloud Run / Cloud Functions v2: Google's front end
 * appends the connecting client's IP as the LAST X-Forwarded-For entry.
 * Everything before it arrived in the request and is spoofable.
 * Accepts an Express Request or a callable's rawRequest.
 */
export declare function trustedClientIp(req: {
    headers: Record<string, unknown>;
    ip?: string;
}): string;
