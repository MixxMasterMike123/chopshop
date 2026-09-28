import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

/**
 * CP2-E / CP3-E test fixtures: the seller's platform-terms acceptance and legal
 * readiness (the two HARD checkout gates), the buyer's consent (src/legal/),
 * and the SQL seeds the grace and legal-pages suites share. Not a test file.
 *
 * Suites that seed tenants with SQL add `acceptTermsStatement` to their seed
 * batch — a shop that sells has accepted the current terms AND is legally
 * ready — and send `BUYER_CONSENT` in a checkout body. The gates themselves
 * and the consent rules are proven through the real routes in legal*.test.ts
 * and checkout.test.ts.
 */

/** The version 0031 seeds (src/config/platformTerms.js PLATFORM_TERMS_VERSION). */
export const CURRENT_TERMS_VERSION = "2026-09-07";

/** The minimum a checkout body must carry: the buyer accepted the terms. */
export const BUYER_CONSENT = { terms: true } as const;

// ── D98: the recipient every checkout body carries ─────────────────────────

/**
 * The pickup place every fixture shop offers (invented): the fixture trigger
 * below writes it into the shop's store identity, and the slice harness sets
 * it through PUT /v1/admin/settings.
 */
export const FIXTURE_PICKUP_LOCATION = {
  address: "Testgatan 1, 123 45 Teststad",
  dates: [] as string[],
  id: "fixture-pickup",
  name: "Testbutikens utlämning",
} as const;

/** A collected order's recipient at the fixture place (invented). */
export const BUYER_RECIPIENT_PICKUP = {
  name: "Testa Köpare",
  pickupLocationId: FIXTURE_PICKUP_LOCATION.id,
} as const;

/** A shipped order's recipient in `country` (invented; must equal shippingCountry). */
export function buyerRecipientShipping(country = "SE") {
  return {
    addressLine1: "Provvägen 2",
    city: "Teststad",
    country,
    name: "Testa Köpare",
    postalCode: "123 45",
  };
}

/** `body` with the recipient its delivery needs, unless it names one. */
export function withBuyerRecipient<T extends Record<string, unknown>>(body: T): T & { recipient: unknown } {
  return "recipient" in body
    ? (body as T & { recipient: unknown })
    : { ...body, recipient: buyerRecipientFor(body.deliveryMethod, body.shippingCountry) };
}

/** The recipient a checkout body with this delivery (and country) needs. */
export function buyerRecipientFor(deliveryMethod: unknown, shippingCountry: unknown): Record<string, unknown> {
  return deliveryMethod === "pickup"
    ? { ...BUYER_RECIPIENT_PICKUP }
    : buyerRecipientShipping(
        typeof shippingCountry === "string" ? shippingCountry.toUpperCase() : "SE",
      );
}

/**
 * One acceptance row for `tenantId`, as the accept route would write it — and,
 * through the fixture trigger below, the shop's legal readiness too.
 *
 * WHY A TRIGGER. Every caller puts this ONE statement inside its own
 * `db.batch([...])` (checkout, discount-codes, admin-discount-codes,
 * admin-catalog, pod-fixtures seedTenant), and one D1 statement inserts into
 * one table. CP3-E's second gate needs three more rows (a fixture seller, its
 * tenant_settings row, its legal-pages acceptance). Rather than edit every
 * caller, importing this module installs, per test file, a TEST-ONLY trigger
 * that adds those rows when — and only when — this helper's own row
 * (`seed-terms-<tenant>`) is inserted. It lives only in the test database; no
 * migration carries it.
 */
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

// ── CP3-E ───────────────────────────────────────────────────────────────────

export const DAY = 24 * 60 * 60 * 1_000;
export const FOURTEEN_DAYS = 14 * DAY;

/** A terms version as a migration (or the 0031 seed) would insert it: no archived text. */
export function termsVersionStatement(
  db: D1Database,
  version: string,
  publishedAt: string,
  sha256 = "0".repeat(64),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_terms_versions (version, published_at, sha256, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(version, publishedAt, sha256, publishedAt);
}

/** `tenantId` accepted `version` at `acceptedAt` (evidence, as the route writes it). */
export function termsAcceptanceStatement(
  db: D1Database,
  tenantId: string,
  version: string,
  acceptedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_terms_acceptances (id, tenant_id, user_id, terms_version, accepted_at, evidence_json)
       VALUES (?, ?, 'test-seller', ?, ?, '{}')`,
    )
    .bind(crypto.randomUUID(), tenantId, version, acceptedAt);
}

/** A bare tenant row (the grace rule needs nothing else). */
export function bareTenantStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tenants (tenant_id, status, shop_name, created_at, updated_at)
       VALUES (?, 'active', 'Test Seller Butik', 0, 0)`,
    )
    .bind(tenantId);
}

/**
 * Three adopted pages, and their canonical form + SHA-256 as the IMPORTER
 * computes them (scripts/cf-port/migrate/lib/typed-json.mjs canonicalStringify
 * under Node, 2026-09-27) — the known-answer vector both sides must agree on.
 */
export const LEGAL_TEXTS = {
  kopvillkor: "<h2>Köpvillkor</h2><p>Säljare: Test Seller</p>",
  angerratt: "<p>Ångerrätt 14 dagar</p>",
  integritetspolicy: '<p>Personuppgifter "test" &amp; \\ ok</p>',
} as const;
export const LEGAL_TEXTS_CANONICAL =
  '{"angerratt":"<p>Ångerrätt 14 dagar</p>","integritetspolicy":"<p>Personuppgifter \\"test\\" &amp; \\\\ ok</p>","kopvillkor":"<h2>Köpvillkor</h2><p>Säljare: Test Seller</p>"}';
export const LEGAL_TEXTS_SHA256 = "fa412aae365174b550bf7530c9625f7797cb2e9ff8bdc9c09b1ff1d26f412d11";

// ── the legal readiness gate ────────────────────────────────────────────────

/** The return address a legally ready fixture shop gets (invented). */
export const FIXTURE_RETURN_ADDRESS = "Testgatan 1, 123 45 Teststad";

/**
 * A tenant_settings row answering the two settings conditions (address + VAT),
 * with the fixture pickup place (D98) in its store identity.
 */
export function readySettingsStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tenant_settings (
         tenant_id, return_address, vat_registered, updated_at, updated_by, store_identity_json
       )
       VALUES (?, ?, 1, '2026-09-07T00:00:00.000Z', 'seed-admin', ?)`,
    )
    .bind(tenantId, FIXTURE_RETURN_ADDRESS, JSON.stringify({ pickupLocations: [FIXTURE_PICKUP_LOCATION] }));
}

/** A Worker legal-pages acceptance by `userId` (a real user), as the route writes it. */
export function pagesAcceptanceStatement(db: D1Database, tenantId: string, userId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, email, accepted_at, template_version,
         is_pod, is_custom, texts_json, texts_sha256, source
       ) VALUES (?, ?, 'legalPages', ?, (SELECT "email" FROM "user" WHERE "id" = ?),
                 '2026-09-07T00:00:00.000Z', '2026-09-07', 0, 0, ?, ?, 'worker')`,
    )
    .bind(crypto.randomUUID(), tenantId, userId, userId, LEGAL_TEXTS_CANONICAL, LEGAL_TEXTS_SHA256);
}

/** Both readiness facts for a tenant whose admin `userId` exists. */
export function legalReadinessStatements(db: D1Database, tenantId: string, userId: string): D1PreparedStatement[] {
  return [readySettingsStatement(db, tenantId), pagesAcceptanceStatement(db, tenantId, userId)];
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The fixture trigger `acceptTermsStatement` relies on (see its comment). It
 * fires only for the helper's own row id; the seller is invented
 * (`seed-seller-<tenant>`, `…@example.com`). Registered as a file-level
 * beforeAll when this module is imported: after the setup file's migrations,
 * before the importing suite's own hooks.
 */
beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS test_fixture_legal_readiness
     AFTER INSERT ON platform_terms_acceptances
     FOR EACH ROW
     WHEN NEW.id = 'seed-terms-' || NEW.tenant_id
     BEGIN
       INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('seed-seller-' || NEW.tenant_id, 'Test Seller',
               'seed-seller+' || NEW.tenant_id || '@example.com', 1, NEW.accepted_at, NEW.accepted_at);
       INSERT OR IGNORE INTO tenant_settings (
         tenant_id, return_address, vat_registered, updated_at, updated_by, store_identity_json
       )
       VALUES (NEW.tenant_id, ${sqlText(FIXTURE_RETURN_ADDRESS)}, 1, NEW.accepted_at, 'seed-admin',
               ${sqlText(JSON.stringify({ pickupLocations: [FIXTURE_PICKUP_LOCATION] }))});
       INSERT OR IGNORE INTO legal_acceptances (
         acceptance_id, tenant_id, type, user_id, email, accepted_at, template_version,
         is_pod, is_custom, texts_json, texts_sha256, source
       ) VALUES (
         'seed-pages-' || NEW.tenant_id, NEW.tenant_id, 'legalPages', 'seed-seller-' || NEW.tenant_id,
         'seed-seller+' || NEW.tenant_id || '@example.com', NEW.accepted_at, '2026-09-07', 0, 0,
         ${sqlText(LEGAL_TEXTS_CANONICAL)}, ${sqlText(LEGAL_TEXTS_SHA256)}, 'worker'
       );
     END`,
  ).run();
});
