/**
 * CP13 — the affiliate terms (design §8, D28, R2-21): THE canonical text. The
 * storefront's application form and the affiliate portal both read it through
 * the routes (`GET /v1/affiliate-terms`, `GET /v1/affiliate/terms`), so no
 * frontend copy can drift from what an affiliate accepts.
 *
 * VERSIONED AS THE PLATFORM TERMS ARE (0031): `affiliate_terms_versions`
 * holds one row per published version with the SHA-256 of its template;
 * migration 0059 seeds the first one with the hash of the template below
 * (`affiliateTermsSha256`, pinned by test/affiliate-schema.test.ts). The hash
 * is taken over the UTF-8 of `JSON.stringify({ version, template })` — the
 * TEMPLATE, before the merge fields are filled, so one hash covers every shop.
 * A new version = a new template here AND a new row by migration; the portal
 * then asks every affiliate to accept again (`termsOutdated`).
 *
 * MERGE FIELDS, filled per shop at read time (renderAffiliateTerms):
 *   {{shop_name}}           the shop's name
 *   {{commission_percent}}  the affiliate's commission (the default before approval)
 *   {{discount_percent}}    the buyer discount (likewise)
 *   {{support_email}}       the shop's support address
 *
 * The final Swedish copy is unit A4's (CP13_BRIEFS.md): it replaces the
 * template below and, while 0059 is not yet applied anywhere, the seeded hash
 * with it (the pin test names the new value). It is flagged for Mikael's legal
 * read. This module imports nothing.
 */

export const AFFILIATE_TERMS_VERSION = "2026-10-22";

/** When the first version took effect (0059's seed). */
export const AFFILIATE_TERMS_PUBLISHED_AT = "2026-10-22T00:00:00.000Z";

/** The defaults an approval writes when the shop names no rates (design A6). */
export const DEFAULT_COMMISSION_BP = 1_500;
export const DEFAULT_DISCOUNT_BP = 1_000;

export const AFFILIATE_TERMS_TEMPLATE = [
  "Affiliatevillkor för {{shop_name}}",
  "1. Parter. Avtalet gäller mellan dig som affiliate och {{shop_name}} (butiken). Plattformen är teknisk leverantör och är inte part i avtalet.",
  "2. Kod och länk. Du får en personlig rabattkod och en länk. Köpare som använder koden eller länken får {{discount_percent}} % rabatt på varorna (inte på frakten).",
  "3. Provision. Du får {{commission_percent}} % provision på orderns varuvärde efter rabatt, exklusive moms och frakt.",
  "4. Ångerfrist och återföring. Provisionen kan betalas ut tidigast 14 dagar efter köpet och så länge ordern inte är bestriden. Återbetalas en order helt eller delvis justeras provisionen i proportion till återbetalningen. En förlorad tvist återför hela provisionen.",
  "5. Utbetalning. Du begär utbetalning i portalen med faktura eller underlag. Butiken betalar ut. Är du privatperson kan ersättningen vara skattepliktig inkomst; du ansvarar för din deklaration.",
  "6. Marknadsföring. Du måste tydligt märka inlägg, videor och länkar som reklam/annons (t.ex. 'Reklam' eller 'Annons') enligt marknadsföringslagen. Vilseledande påståenden om produkterna är inte tillåtna. Du får inte köpa sökord med butikens namn.",
  "7. Egna köp. Du får inte använda din egen kod eller länk för egna köp. Sådana köp ger ingen provision.",
  "8. Uppsägning. Båda parter kan avsluta samarbetet. Intjänad provision som inte har återförts betalas ut enligt punkt 4 och 5.",
  "9. Personuppgifter. Butiken ser dina kontaktuppgifter, din kod, dina provisioner och utbetalningar. Du ser aldrig uppgifter om köparna. Plattformen lagrar antal länkbesök per dag utan personuppgifter.",
  "10. Ändringar. Nya villkor gäller först när du har godkänt dem i portalen.",
  "Frågor: {{support_email}}",
].join("\n\n");

export interface AffiliateTermsContext {
  commissionBp: number;
  discountBp: number;
  shopName: string | null;
  supportEmail: string | null;
}

/** Basis points as a Swedish percent: 1500 → "15", 1250 → "12,5". */
export function percentText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = bp % 100;
  if (rest === 0) {
    return String(whole);
  }
  return `${whole},${String(rest).padStart(2, "0").replace(/0$/, "")}`;
}

/** The template with the shop's merge fields filled. Plain text, never HTML. */
export function renderAffiliateTerms(context: AffiliateTermsContext): string {
  return AFFILIATE_TERMS_TEMPLATE.replaceAll("{{shop_name}}", context.shopName ?? "butiken")
    .replaceAll("{{commission_percent}}", percentText(context.commissionBp))
    .replaceAll("{{discount_percent}}", percentText(context.discountBp))
    .replaceAll("{{support_email}}", context.supportEmail ?? "butiken");
}

/** SHA-256 hex of the template as 0059 seeds it (see the module comment). */
export async function affiliateTermsSha256(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({ template: AFFILIATE_TERMS_TEMPLATE, version: AFFILIATE_TERMS_VERSION }),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface CurrentAffiliateTerms {
  publishedAt: string;
  sha256: string;
  version: string;
}

/**
 * The CURRENT version: the latest row published by `now` (0031's rule). Null
 * only on a database without 0059's seed.
 */
export async function readCurrentAffiliateTerms(
  db: D1Database,
  now: number,
): Promise<CurrentAffiliateTerms | null> {
  const row = await db
    .prepare(
      `SELECT version, published_at, text_sha256
       FROM affiliate_terms_versions
       WHERE published_at <= ?
       ORDER BY published_at DESC, version DESC
       LIMIT 1`,
    )
    .bind(new Date(now).toISOString())
    .first<{ published_at: string; text_sha256: string; version: string }>();
  return row === null
    ? null
    : { publishedAt: row.published_at, sha256: row.text_sha256, version: row.version };
}
