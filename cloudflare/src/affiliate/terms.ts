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
 * NO FIGURE IN A TERM (A4 round 1): the numbered clauses never name a rate —
 * an affiliate may be approved at other rates and the shop may change them.
 * The rates appear only in the last, informational line, rendered per
 * affiliate; the hash covers the template, so it never moves with a rate.
 *
 * MERGE FIELDS, filled per shop at read time (renderAffiliateTerms):
 *   {{shop_name}}           the shop's name
 *   {{commission_percent}}  the affiliate's commission (the default before approval)
 *   {{discount_percent}}    the buyer discount (likewise)
 *   {{support_email}}       the shop's support address
 *
 * The Swedish copy below is unit A4's final text (CP13_BRIEFS.md, design §8,
 * the MFL sentence verbatim). It replaced A1's draft under the SAME version
 * while 0059 was applied nowhere, so 0059's seeded hash changed with it
 * (test/affiliate-schema.test.ts pins both). It is flagged for Mikael's legal
 * read. From the first applied 0059 on, a wording change is a NEW version.
 * This module imports nothing.
 */

export const AFFILIATE_TERMS_VERSION = "2026-10-22";

/** When the first version took effect (0059's seed). */
export const AFFILIATE_TERMS_PUBLISHED_AT = "2026-10-22T00:00:00.000Z";

/** The defaults an approval writes when the shop names no rates (design A6). */
export const DEFAULT_COMMISSION_BP = 1_500;
export const DEFAULT_DISCOUNT_BP = 1_000;

export const AFFILIATE_TERMS_TEMPLATE = [
  "Affiliatevillkor för {{shop_name}}",
  "1. Parter. Villkoren gäller mellan dig som affiliate och {{shop_name}} (butiken). Plattformen som driver butikens webbshop är teknisk leverantör och är inte part i avtalet.",
  "2. Kod och länk. Du får en personlig kod och en länk till butiken. Ett köp räknas till dig när köparen kommer via din länk (koden sparas då i köparens varukorg i upp till 30 dagar) eller själv anger din kod i kassan. Har köparen kommit via en annan affiliates länk gäller den länken.",
  "3. Rabatt till köparen. Köpare som använder din kod eller länk får den rabatt på varorna som butiken anger för dig och som visas i affiliateportalen. Rabatten gäller inte frakten och kan inte kombineras med en annan rabattkod.",
  "4. Provision. Du får den provision som butiken anger för dig (visas i affiliateportalen), beräknad på orderns varuvärde efter rabatt, exklusive moms och frakt. Butiken kan ändra rabatt och provision; en ändring gäller köp som görs efter ändringen.",
  "5. Ångerfrist och återföring. Provisionen kan betalas ut tidigast 14 dagar efter köpet och bara så länge betalningen inte är bestriden. Återbetalas en order helt eller delvis minskar provisionen i samma proportion. Förlorar butiken en tvist om betalningen återförs hela provisionen för ordern.",
  "6. Utbetalning. Du begär utbetalning i affiliateportalen och bifogar faktura eller annat underlag. Butiken betalar ut beloppet och registrerar utbetalningen i portalen. Är du privatperson kan ersättningen vara skattepliktig inkomst; du ansvarar för din deklaration.",
  "7. Marknadsföring. Du måste tydligt märka inlägg, videor och länkar som reklam/annons (t.ex. 'Reklam' eller 'Annons') enligt marknadsföringslagen; vilseledande påståenden om produkterna är inte tillåtna. Du får inte köpa annonser på sökord med butikens namn eller utge dig för att vara butiken.",
  "8. Egna köp. Du får inte använda din kod eller länk för egna köp. Köp där du själv eller någon som administrerar butiken är köpare ger ingen provision.",
  "9. Uppsägning. Både du och butiken kan avsluta samarbetet när som helst. Din kod slutar då att ge rabatt. Intjänad provision som inte har återförts betalas ut enligt punkt 5 och 6.",
  "10. Personuppgifter. Butiken ser ditt namn, dina kontaktuppgifter, din kod, antal länkbesök och dina provisioner och utbetalningar. Du ser ordernummer, belopp och provision för köp med din kod eller länk, men aldrig vem köparen är. Plattformen räknar länkbesök per dag utan att spara uppgifter om besökarna.",
  "11. Ändringar. Villkoren kan ändras. Nya villkor gäller för dig först när du har godkänt dem i affiliateportalen.",
  "Frågor om villkoren: {{support_email}}",
  // Information beside the terms, not a term: the rates in force when the
  // text is shown (rendered per affiliate). The numbered clauses name no
  // figure, so a rate change never changes what was accepted (A4 round 1).
  "Information (inte en del av villkoren): just nu gäller {{discount_percent}} % rabatt till köparen och {{commission_percent}} % provision till dig. Aktuella nivåer visas alltid i affiliateportalen.",
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
    .replaceAll("{{support_email}}", context.supportEmail ?? "kontakta butiken");
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
