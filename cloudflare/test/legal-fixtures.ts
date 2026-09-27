/**
 * CP2-E test fixtures: the seller's platform-terms acceptance (the HARD
 * checkout gate) and the buyer's consent (src/legal/). Not a test file.
 *
 * Suites that seed tenants with SQL add `acceptTermsStatement` to their seed
 * batch — a shop that sells has accepted the current terms — and send
 * `BUYER_CONSENT` in a checkout body. The gate itself and the consent rules
 * are proven through the real routes in legal.test.ts and checkout.test.ts.
 */

/** The version 0031 seeds (src/config/platformTerms.js PLATFORM_TERMS_VERSION). */
export const CURRENT_TERMS_VERSION = "2026-09-07";

/** The minimum a checkout body must carry: the buyer accepted the terms. */
export const BUYER_CONSENT = { terms: true } as const;

/** One acceptance row for `tenantId`, as the accept route would write it. */
export function acceptTermsStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_terms_acceptances (
         id, tenant_id, user_id, terms_version, accepted_at, ip, user_agent, evidence_json
       ) VALUES (?, ?, 'seed-admin', ?, '2026-09-07T00:00:00.000Z', NULL, NULL, '{"seeded":true}')
       ON CONFLICT (tenant_id, terms_version) DO NOTHING`,
    )
    .bind(`seed-terms-${tenantId}`, tenantId, CURRENT_TERMS_VERSION);
}
