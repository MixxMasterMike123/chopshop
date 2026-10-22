import { normalizeDiscountCode } from "../commerce/discount-codes";
import { clientIp, enforceRateLimit, visitorRateKey } from "../lib/rate-limit";
import { isFeatureEnabled } from "../platform/tenant-config";
import { AFFILIATE_CODE_PATTERN } from "./affiliates";

/**
 * CP13 — the referral-link landing count (design §2.1, D27, CX-B9, R2-20/25).
 *
 * THE WEB WORKER REPORTS, THE API COUNTS. A page landing on
 * `<shop>/…?ref=CODE` makes the web Worker carry the normalized code on the
 * `GET /v1/seo` call it already makes for that page (an internal route, on no
 * browser allowlist); the SEO handler hands it here under the API's OWN
 * `ctx.waitUntil`, so the page is served whatever the count does and the web
 * Worker needs no ExecutionContext.
 *
 * WHAT IS STORED: `affiliate_click_days(tenant, affiliate, day) += 1`. No IP,
 * no user agent, no referrer, no visitor id, no click row. The only other
 * write is the durable limiter's (0008), whose key is a HASH of the visitor
 * (an IPv6 address by its /64), as for every anonymous route — so a reload
 * loop counts at most AFFILIATE_REF_LIMIT landings per window per visitor.
 * The figure is "link landings" ("Länkbesök"): repeat visits, bots and
 * prefetches included; never "unique visitors", never a click-conversion
 * rate.
 *
 * WHAT COUNTS: an ACTIVE affiliate of this shop, while the shop's add-on is
 * ON. Anything else — an unknown, inactive or suspended code, another shop's
 * code, the add-on off, a malformed code — counts nothing and writes nothing
 * (not even the limiter's row). Nothing here can fail the page: every error
 * is swallowed and logged by name only.
 */

export const AFFILIATE_REF_SCOPE = "affiliate-ref-ip";
export const AFFILIATE_REF_LIMIT = 60;
export const AFFILIATE_REF_WINDOW_MS = 10 * 60 * 1_000;

/** A `ref` value as the SEO route receives it: normalized, of the affiliate code grammar, or null. */
export function parseRefParam(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const code = normalizeDiscountCode(value);
  return AFFILIATE_CODE_PATTERN.test(code) ? code : null;
}

/**
 * Counts one landing. Never throws (the caller runs it under waitUntil, and a
 * thrown count would only be noise in the log).
 */
export async function countReferralLanding(
  env: Env,
  request: Request,
  tenantId: string,
  code: string,
  now: number,
): Promise<"counted" | "ignored" | "limited"> {
  try {
    const db = env.DB;
    if (!(await isFeatureEnabled(db, tenantId, "affiliate"))) {
      return "ignored";
    }
    const affiliate = await db
      .prepare(
        "SELECT affiliate_id FROM affiliates WHERE tenant_id = ? AND code = ? AND status = 'active' LIMIT 1",
      )
      .bind(tenantId, code)
      .first<{ affiliate_id: string }>();
    if (affiliate === null) {
      return "ignored";
    }
    const limit = await enforceRateLimit(db, {
      key: visitorRateKey(clientIp(request)),
      limit: AFFILIATE_REF_LIMIT,
      now,
      scope: AFFILIATE_REF_SCOPE,
      windowMs: AFFILIATE_REF_WINDOW_MS,
    });
    if (!limit.allowed) {
      return "limited";
    }
    await db
      .prepare(
        `INSERT INTO affiliate_click_days (tenant_id, affiliate_id, day, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (tenant_id, affiliate_id, day) DO UPDATE SET count = count + 1`,
      )
      .bind(tenantId, affiliate.affiliate_id, new Date(now).toISOString().slice(0, 10))
      .run();
    return "counted";
  } catch (error) {
    console.warn(
      JSON.stringify({
        error: error instanceof Error ? error.name : "unknown",
        message: "affiliate link landing could not be counted",
      }),
    );
    return "ignored";
  }
}
