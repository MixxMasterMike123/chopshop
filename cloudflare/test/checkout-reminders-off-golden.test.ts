import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import {
  createAlertDigestEmailJob,
  createAuthEmailJob,
  createOrderConfirmationEmailJob,
  deliveryIdFromKey,
} from "../src/email/auth-email-job";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";
import { createOrderEmailJob } from "../src/email/order-emails";
import { createWithdrawalEmailJob } from "../src/email/withdrawal-email";
import { acceptTermsStatement, buyerRecipientFor } from "./legal-fixtures";

/**
 * CP9-AC hard rule: with the add-on off for a shop (the default), NOTHING
 * changes for it. The same checkout requests through the real route must give
 * byte-identical checkout rows (the frozen consent included, its timestamp
 * masked), lines, recipient and audit row; the storefront body must be the
 * same (its ETag names the body revision, which this unit raises on purpose:
 * masked here, pinned in public-storefront.test.ts); and the Resend request
 * of every mail kind that existed before must be the same bytes.
 *
 * GOLDEN_* were produced by running this file, unchanged, against the tree
 * at d729691f (before CP9-AC), docs/cf-port/CP9_AC_REPORT.md build log
 * step 0. Ids and timestamps are left out because they are fresh per run.
 */

const TENANT = "tenant-ac-golden";
const HOST = "ac-golden.test";
const NOW = 1_787_200_000_000;

const CONSENTS: Array<[label: string, consent: Record<string, unknown>]> = [
  ["terms only", { terms: true }],
  ["marketing ticked", { marketing: true, terms: true }],
  ["marketing unticked", { marketing: false, terms: true }],
];

const GOLDEN_CHECKOUTS = "{\"terms only\":{\"audit\":[{\"actor_user_id\":null,\"action\":\"checkout.create\",\"resource_type\":\"checkout\",\"metadata_json\":\"{\\\"items\\\":1}\"}],\"items\":[{\"item_index\":0,\"product_id\":\"ac-mug\",\"variant_id\":null,\"sku\":\"SKU-AC-MUG\",\"name\":\"Mugg\",\"quantity\":2,\"unit_price_minor\":15000,\"line_total_minor\":30000}],\"recipient\":{\"tenant_id\":\"tenant-ac-golden\",\"delivery_method\":\"shipping\",\"name\":\"Testa Köpare\",\"phone\":null,\"address_line1\":\"Provvägen 2\",\"address_line2\":null,\"postal_code\":\"123 45\",\"city\":\"Teststad\",\"country\":\"SE\",\"pickup_location_id\":null,\"pickup_location_name\":null,\"pickup_location_address\":null,\"pickup_date\":null},\"row\":{\"status\":\"open\",\"customer_email\":\"golden-ac-0@buyer.test\",\"currency\":\"SEK\",\"delivery_method\":\"shipping\",\"shipping_country\":\"SE\",\"subtotal_minor\":30000,\"shipping_minor\":37700,\"vat_minor\":13540,\"vat_rate_bp\":2500,\"discount_minor\":0,\"discount_code_id\":null,\"total_minor\":67700,\"payment_intent_id\":null,\"payment_intent_status\":null,\"production_snapshot_json\":null,\"consent_json\":\"{\\\"marketing\\\":false,\\\"recordedAt\\\":\\\"<t>\\\",\\\"terms\\\":true,\\\"v\\\":1,\\\"withdrawal\\\":{\\\"disclosureSha256\\\":null,\\\"disclosureVersion\\\":null,\\\"personalizedItems\\\":[],\\\"waived\\\":false}}\",\"ttl\":86400000,\"updated_delta\":0}},\"marketing ticked\":{\"audit\":[{\"actor_user_id\":null,\"action\":\"checkout.create\",\"resource_type\":\"checkout\",\"metadata_json\":\"{\\\"items\\\":1}\"}],\"items\":[{\"item_index\":0,\"product_id\":\"ac-mug\",\"variant_id\":null,\"sku\":\"SKU-AC-MUG\",\"name\":\"Mugg\",\"quantity\":2,\"unit_price_minor\":15000,\"line_total_minor\":30000}],\"recipient\":{\"tenant_id\":\"tenant-ac-golden\",\"delivery_method\":\"shipping\",\"name\":\"Testa Köpare\",\"phone\":null,\"address_line1\":\"Provvägen 2\",\"address_line2\":null,\"postal_code\":\"123 45\",\"city\":\"Teststad\",\"country\":\"SE\",\"pickup_location_id\":null,\"pickup_location_name\":null,\"pickup_location_address\":null,\"pickup_date\":null},\"row\":{\"status\":\"open\",\"customer_email\":\"golden-ac-1@buyer.test\",\"currency\":\"SEK\",\"delivery_method\":\"shipping\",\"shipping_country\":\"SE\",\"subtotal_minor\":30000,\"shipping_minor\":37700,\"vat_minor\":13540,\"vat_rate_bp\":2500,\"discount_minor\":0,\"discount_code_id\":null,\"total_minor\":67700,\"payment_intent_id\":null,\"payment_intent_status\":null,\"production_snapshot_json\":null,\"consent_json\":\"{\\\"marketing\\\":true,\\\"recordedAt\\\":\\\"<t>\\\",\\\"terms\\\":true,\\\"v\\\":1,\\\"withdrawal\\\":{\\\"disclosureSha256\\\":null,\\\"disclosureVersion\\\":null,\\\"personalizedItems\\\":[],\\\"waived\\\":false}}\",\"ttl\":86400000,\"updated_delta\":0}},\"marketing unticked\":{\"audit\":[{\"actor_user_id\":null,\"action\":\"checkout.create\",\"resource_type\":\"checkout\",\"metadata_json\":\"{\\\"items\\\":1}\"}],\"items\":[{\"item_index\":0,\"product_id\":\"ac-mug\",\"variant_id\":null,\"sku\":\"SKU-AC-MUG\",\"name\":\"Mugg\",\"quantity\":2,\"unit_price_minor\":15000,\"line_total_minor\":30000}],\"recipient\":{\"tenant_id\":\"tenant-ac-golden\",\"delivery_method\":\"shipping\",\"name\":\"Testa Köpare\",\"phone\":null,\"address_line1\":\"Provvägen 2\",\"address_line2\":null,\"postal_code\":\"123 45\",\"city\":\"Teststad\",\"country\":\"SE\",\"pickup_location_id\":null,\"pickup_location_name\":null,\"pickup_location_address\":null,\"pickup_date\":null},\"row\":{\"status\":\"open\",\"customer_email\":\"golden-ac-2@buyer.test\",\"currency\":\"SEK\",\"delivery_method\":\"shipping\",\"shipping_country\":\"SE\",\"subtotal_minor\":30000,\"shipping_minor\":37700,\"vat_minor\":13540,\"vat_rate_bp\":2500,\"discount_minor\":0,\"discount_code_id\":null,\"total_minor\":67700,\"payment_intent_id\":null,\"payment_intent_status\":null,\"production_snapshot_json\":null,\"consent_json\":\"{\\\"marketing\\\":false,\\\"recordedAt\\\":\\\"<t>\\\",\\\"terms\\\":true,\\\"v\\\":1,\\\"withdrawal\\\":{\\\"disclosureSha256\\\":null,\\\"disclosureVersion\\\":null,\\\"personalizedItems\\\":[],\\\"waived\\\":false}}\",\"ttl\":86400000,\"updated_delta\":0}}}";
const GOLDEN_STOREFRONT = "{\"body\":\"{\\\"storefront\\\":{\\\"accent\\\":null,\\\"branding\\\":{\\\"emailLogo\\\":null,\\\"favicon\\\":null,\\\"hero\\\":null,\\\"logo\\\":null},\\\"currency\\\":\\\"SEK\\\",\\\"features\\\":{\\\"abandonedCheckout\\\":false,\\\"contentStudio\\\":false,\\\"discountCodes\\\":false,\\\"marketingMaterials\\\":false,\\\"pod\\\":false,\\\"productReviews\\\":false},\\\"identity\\\":{\\\"supportEmail\\\":\\\"hej@golden-ac.test\\\"},\\\"locale\\\":\\\"sv-SE\\\",\\\"menu\\\":[],\\\"name\\\":\\\"Golden AC\\\",\\\"ordersOpen\\\":true,\\\"pickupLocations\\\":[{\\\"address\\\":\\\"Testgatan 1, 123 45 Teststad\\\",\\\"dates\\\":[],\\\"id\\\":\\\"fixture-pickup\\\",\\\"name\\\":\\\"Testbutikens utlämning\\\"}],\\\"templateId\\\":null,\\\"theme\\\":{}}}\",\"etag\":\"\\\"<v>-r<n>\\\"\",\"status\":200}";
const GOLDEN_MAILS = "{\"email_verification\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p>Bekräfta din e-postadress för ChopShop.</p><p><a href=\\\\\\\"https://meteorshop-stg-api.micke-ohlen.workers.dev/api/auth/verify-email?token=abc\\\\\\\">Verifiera e-postadress</a></p>\\\",\\\"subject\\\":\\\"Verifiera din e-postadress\\\",\\\"text\\\":\\\"Bekräfta din e-postadress för ChopShop.\\\\n\\\\nVerifiera e-postadress: https://meteorshop-stg-api.micke-ohlen.workers.dev/api/auth/verify-email?token=abc\\\",\\\"to\\\":[\\\"verify@buyer.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"password_reset\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p>Du har begärt att återställa ditt lösenord för ChopShop.</p><p><a href=\\\\\\\"https://meteorshop-stg-api.micke-ohlen.workers.dev/api/auth/reset-password/tokengolden0001\\\\\\\">Återställ lösenord</a></p>\\\",\\\"subject\\\":\\\"Återställ ditt lösenord\\\",\\\"text\\\":\\\"Du har begärt att återställa ditt lösenord för ChopShop.\\\\n\\\\nÅterställ lösenord: https://meteorshop-stg-api.micke-ohlen.workers.dev/api/auth/reset-password/tokengolden0001\\\",\\\"to\\\":[\\\"reset@buyer.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"password_reset invite\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p>Ett konto har skapats åt dig på ChopShop.</p><p>Välj ett lösenord för att logga in.</p><p><a href=\\\\\\\"https://meteorshop-stg-api.micke-ohlen.workers.dev/api/auth/reset-password/tokengolden0002\\\\\\\">Välj lösenord</a></p><p>Länken gäller i 72 timmar och kan bara användas en gång.</p><p>Om du inte väntade dig det här mejlet kan du bortse från det.</p>\\\",\\\"subject\\\":\\\"Välj ditt lösenord för ChopShop\\\",\\\"text\\\":\\\"Ett konto har skapats åt dig på ChopShop.\\\\nVälj ett lösenord för att logga in.\\\\n\\\\nVälj lösenord: https://meteorshop-stg-api.micke-ohlen.workers.dev/api/auth/reset-password/tokengolden0002\\\\n\\\\nLänken gäller i 72 timmar och kan bara användas en gång.\\\\nOm du inte väntade dig det här mejlet kan du bortse från det.\\\",\\\"to\\\":[\\\"invite@buyer.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"order_confirmation\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p>Tack för din beställning hos Golden AC!</p><p>Vi har tagit emot din beställning och börjar behandla den direkt.</p><p>Ordernummer: <strong>CS-AC-0001</strong><br>Leverans: Leverans till Sverige</p><table><tr><td>2 st Mugg</td><td>300,00 kr</td></tr></table><table><tr><td>Delsumma</td><td>300,00 kr</td></tr><tr><td>Frakt</td><td>49,00 kr</td></tr><tr><td>Totalt</td><td>349,00 kr</td></tr><tr><td>varav moms</td><td>69,80 kr</td></tr></table>\\\",\\\"subject\\\":\\\"Orderbekräftelse CS-AC-0001\\\",\\\"text\\\":\\\"Tack för din beställning hos Golden AC!\\\\n\\\\nVi har tagit emot din beställning och börjar behandla den direkt.\\\\n\\\\nOrdernummer: CS-AC-0001\\\\nLeverans: Leverans till Sverige\\\\n\\\\n2 st Mugg: 300,00 kr\\\\n\\\\nDelsumma: 300,00 kr\\\\nFrakt: 49,00 kr\\\\nTotalt: 349,00 kr\\\\nvarav moms: 69,80 kr\\\",\\\"to\\\":[\\\"order@buyer.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"alert_digest\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p>1 nya larm sedan förra sammanställningen, 1 öppna totalt.</p><ul><li>outbox_failed (varning): 1 öppna, 1 nya, äldst 2026-10-05 09:00 UTC<br>Resurser: ob-1</li></ul><p>Larmen hanteras i plattformens admin. Sammanställningen innehåller inga belopp eller kunduppgifter.</p>\\\",\\\"subject\\\":\\\"Plattformslarm: 1 nya, 1 öppna\\\",\\\"text\\\":\\\"1 nya larm sedan förra sammanställningen, 1 öppna totalt.\\\\n\\\\noutbox_failed (varning): 1 öppna, 1 nya, äldst 2026-10-05 09:00 UTC\\\\n  Resurser: ob-1\\\\n\\\\nLarmen hanteras i plattformens admin. Sammanställningen innehåller inga belopp eller kunduppgifter.\\\",\\\"to\\\":[\\\"ops@platform.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"withdrawal_receipt\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p><strong>Mottagningsbevis – ångrat köp</strong></p><p>Vi har tagit emot ditt meddelande om att du ångrar ditt köp.</p><p>Mottaget: 2026-10-05T10:00:00.000Z (UTC)<br>Butik: Golden AC<br>Order: CS-AC-0001<br>Namn: Anna Andersson</p><p>Varor som ångras:</p><ul><li>Mugg (SKU-AC-MUG) × 1</li></ul><p>Ditt meddelande: Jag ångrar mitt köp.</p><p>Spara detta mottagningsbevis. Återbetalning hanteras enligt butikens villkor.</p>\\\",\\\"subject\\\":\\\"Mottagningsbevis – ångrat köp, order CS-AC-0001\\\",\\\"text\\\":\\\"Mottagningsbevis – ångrat köp\\\\n\\\\nVi har tagit emot ditt meddelande om att du ångrar ditt köp.\\\\n\\\\nMottaget: 2026-10-05T10:00:00.000Z (UTC)\\\\nButik: Golden AC\\\\nOrder: CS-AC-0001\\\\nNamn: Anna Andersson\\\\n\\\\nVaror som ångras:\\\\n- Mugg (SKU-AC-MUG) × 1\\\\n\\\\nDitt meddelande: Jag ångrar mitt köp.\\\\n\\\\nSpara detta mottagningsbevis. Återbetalning hanteras enligt butikens villkor.\\\",\\\"to\\\":[\\\"anna@buyer.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"withdrawal_notice\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p><strong>Ångrat köp</strong></p><p>En kund har använt ångerfunktionen (&quot;Ångra avtalet här&quot;) i din butik.</p><p>Mottaget: 2026-10-05T10:00:00.000Z (UTC)<br>Order: CS-AC-0001<br>Namn: Anna Andersson<br>Kundens e-post: anna@buyer.test</p><p>Varor som ångras:</p><ul><li>Mugg (SKU-AC-MUG) × 1</li></ul><p>Kunden har fått ett mottagningsbevis. Bedöm om ångern kom i tid: ångerfristen är 14 dagar från den dag kunden tog emot varan.</p><p>Inga pengar har flyttats. En återbetalning gör du själv under Ordrar i butikens admin.</p>\\\",\\\"subject\\\":\\\"Ångrat köp: order CS-AC-0001\\\",\\\"text\\\":\\\"Ångrat köp\\\\n\\\\nEn kund har använt ångerfunktionen (\\\\\\\"Ångra avtalet här\\\\\\\") i din butik.\\\\n\\\\nMottaget: 2026-10-05T10:00:00.000Z (UTC)\\\\nOrder: CS-AC-0001\\\\nNamn: Anna Andersson\\\\nKundens e-post: anna@buyer.test\\\\n\\\\nVaror som ångras:\\\\n- Mugg (SKU-AC-MUG) × 1\\\\n\\\\nKunden har fått ett mottagningsbevis. Bedöm om ångern kom i tid: ångerfristen är 14 dagar från den dag kunden tog emot varan.\\\\n\\\\nInga pengar har flyttats. En återbetalning gör du själv under Ordrar i butikens admin.\\\",\\\"to\\\":[\\\"hej@golden-ac.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"order_status_update\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p><strong>Orderuppdatering</strong></p><p>Hej Anna Andersson,</p><p>Vi har en uppdatering om din beställning hos Golden AC.</p><p>Ordernummer: CS-AC-0001<br>Status: Skickad<br>Spårningsnummer: TRACK-1<br>Fraktbolag: PostNord</p><p>Vad händer nu:</p><ul><li>Din beställning är nu på väg till dig.</li><li>Använd spårningsnumret för att följa leveransen.</li></ul><p>Har du frågor om din beställning? Kontakta Golden AC på hej@golden-ac.test.</p>\\\",\\\"reply_to\\\":\\\"hej@golden-ac.test\\\",\\\"subject\\\":\\\"Orderuppdatering: CS-AC-0001 – Skickad\\\",\\\"text\\\":\\\"Orderuppdatering\\\\n\\\\nHej Anna Andersson,\\\\n\\\\nVi har en uppdatering om din beställning hos Golden AC.\\\\n\\\\nOrdernummer: CS-AC-0001\\\\nStatus: Skickad\\\\nSpårningsnummer: TRACK-1\\\\nFraktbolag: PostNord\\\\n\\\\nVad händer nu:\\\\n- Din beställning är nu på väg till dig.\\\\n- Använd spårningsnumret för att följa leveransen.\\\\n\\\\nHar du frågor om din beställning? Kontakta Golden AC på hej@golden-ac.test.\\\",\\\"to\\\":[\\\"anna@buyer.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"order_notice_shop\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p><strong>Ny beställning</strong></p><p>En ny betald beställning har kommit in i Golden AC.</p><p>Ordernummer: CS-AC-0001<br>Leverans: Frakt till Sverige</p><p>Varor:</p><ul><li>2 st Mugg: 300,00 kr</li></ul><p>Kunden betalade:</p><ul><li>Delsumma: 300,00 kr</li><li>Frakt: 49,00 kr</li><li>Totalt: 349,00 kr</li><li>varav moms: 69,80 kr</li></ul><p>Hantera ordern under Ordrar i butikens admin.</p>\\\",\\\"subject\\\":\\\"Ny beställning: CS-AC-0001\\\",\\\"text\\\":\\\"Ny beställning\\\\n\\\\nEn ny betald beställning har kommit in i Golden AC.\\\\n\\\\nOrdernummer: CS-AC-0001\\\\nLeverans: Frakt till Sverige\\\\n\\\\nVaror:\\\\n- 2 st Mugg: 300,00 kr\\\\n\\\\nKunden betalade:\\\\n- Delsumma: 300,00 kr\\\\n- Frakt: 49,00 kr\\\\n- Totalt: 349,00 kr\\\\n- varav moms: 69,80 kr\\\\n\\\\nHantera ordern under Ordrar i butikens admin.\\\",\\\"to\\\":[\\\"hej@golden-ac.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]},\"refund_notice\":{\"body\":\"{\\\"from\\\":\\\"ChopShop Test <no-reply@mail.test.invalid>\\\",\\\"html\\\":\\\"<p><strong>Återbetalning genomförd</strong></p><p>Hej Anna Andersson,</p><p>Vi har genomfört en delåterbetalning av din beställning hos Golden AC.</p><p>Order: CS-AC-0001<br>Återbetalat belopp: 150,00 kr</p><p>Pengarna når dig inom några bankdagar, beroende på din bank.</p><p>Har du frågor om din beställning? Kontakta Golden AC på hej@golden-ac.test.</p>\\\",\\\"reply_to\\\":\\\"hej@golden-ac.test\\\",\\\"subject\\\":\\\"Återbetalning – order CS-AC-0001\\\",\\\"text\\\":\\\"Återbetalning genomförd\\\\n\\\\nHej Anna Andersson,\\\\n\\\\nVi har genomfört en delåterbetalning av din beställning hos Golden AC.\\\\n\\\\nOrder: CS-AC-0001\\\\nÅterbetalat belopp: 150,00 kr\\\\n\\\\nPengarna når dig inom några bankdagar, beroende på din bank.\\\\n\\\\nHar du frågor om din beställning? Kontakta Golden AC på hej@golden-ac.test.\\\",\\\"to\\\":[\\\"anna@buyer.test\\\"]}\",\"headers\":[\"authorization\",\"content-type\",\"idempotency-key\"]}}";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, created_at, updated_at, stripe_account_id,
        stripe_charges_enabled, stripe_payouts_enabled
      ) VALUES (?, 'active', 'Golden AC', 'hej@golden-ac.test', 'sv-SE', 'SEK', ?, ?, 'acct_ac_golden', 1, 1)`,
    ).bind(TENANT, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${TENANT}`, TENANT, HOST, NOW, NOW),
    acceptTermsStatement(env.DB, TENANT),
    env.DB.prepare(
      `INSERT INTO products (
        product_id, tenant_id, status, sku, name, description,
        b2c_price_minor, currency, is_pod, internal_json, weight_grams,
        allow_shipping, allow_pickup, shipping_json, created_at, updated_at
      ) VALUES ('ac-mug', ?, 'active', 'SKU-AC-MUG', 'Mugg', NULL, 15000, 'SEK', 0, NULL, 300, 1, 0, NULL, ?, ?)`,
    ).bind(TENANT, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO product_publications (
        product_id, tenant_id, published, public_name, public_description,
        public_price_minor, currency, projection_version, published_at, updated_at
      ) VALUES ('ac-mug', ?, 1, 'Mugg', NULL, 15000, 'SEK', 1, ?, ?)`,
    ).bind(TENANT, NOW, NOW),
  ]);
});

let ip = 0;

async function postCheckout(index: number, consent: Record<string, unknown>): Promise<string> {
  ip += 1;
  const response = await exports.default.fetch(
    new Request(`https://${HOST}/v1/checkout`, {
      body: JSON.stringify({
        consent,
        deliveryMethod: "shipping",
        email: `golden-ac-${index}@buyer.test`,
        idempotencyKey: `golden-ac-${index}-${crypto.randomUUID()}`,
        items: [{ productId: "ac-mug", quantity: 2 }],
        recipient: buyerRecipientFor("shipping", "SE"),
        shippingCountry: "SE",
      }),
      headers: { "cf-connecting-ip": `203.0.113.${ip}`, "content-type": "application/json" },
      method: "POST",
    }),
  );
  if (response.status !== 201) {
    throw new Error(`checkout ${index}: ${response.status}`);
  }
  const body = await response.json<{ checkout: { checkoutId: string } }>();
  return body.checkout.checkoutId;
}

async function checkoutFacts(index: number, consent: Record<string, unknown>) {
  const checkoutId = await postCheckout(index, consent);
  const row = await env.DB.prepare(
    `SELECT status, customer_email, currency, delivery_method, shipping_country,
            subtotal_minor, shipping_minor, vat_minor, vat_rate_bp, discount_minor,
            discount_code_id, total_minor, payment_intent_id, payment_intent_status,
            production_snapshot_json, consent_json, expires_at - created_at AS ttl,
            updated_at - created_at AS updated_delta
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<Record<string, unknown> & { consent_json: string | null }>();
  const items = await env.DB.prepare(
    `SELECT item_index, product_id, variant_id, sku, name, quantity,
            unit_price_minor, line_total_minor
     FROM checkout_items WHERE checkout_id = ? ORDER BY item_index`,
  )
    .bind(checkoutId)
    .all();
  const recipient = await env.DB.prepare(
    `SELECT * FROM checkout_recipients WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<Record<string, unknown>>();
  const audit = await env.DB.prepare(
    `SELECT actor_user_id, action, resource_type, metadata_json FROM audit_events
     WHERE resource_id = ? ORDER BY created_at`,
  )
    .bind(checkoutId)
    .all();
  const { checkout_id: _id, created_at: _created, ...recipientFacts } = recipient ?? {};
  return {
    audit: audit.results,
    items: items.results,
    recipient: recipientFacts,
    row: {
      ...row,
      // The one fresh value inside the frozen consent.
      consent_json:
        row?.consent_json === null || row?.consent_json === undefined
          ? null
          : row.consent_json.replace(/"recordedAt":"[^"]*"/, '"recordedAt":"<t>"'),
    },
  };
}

describe("CP9-AC: a shop with the add-on off checks out exactly as before", () => {
  it("freezes byte-identical checkout rows, consent, lines, recipient and audit row", async () => {
    const facts: Record<string, unknown> = {};
    for (const [index, [label, consent]] of CONSENTS.entries()) {
      facts[label] = await checkoutFacts(index, consent);
    }
    expect(JSON.stringify(facts)).toBe(GOLDEN_CHECKOUTS);
  });

  it("answers the same storefront body (the revision in the ETag masked)", async () => {
    const response = await exports.default.fetch(new Request(`https://${HOST}/v1/storefront`));
    const etag = (response.headers.get("etag") ?? "").replace(/^"\d+/, '"<v>').replace(/-r\d+/, "-r<n>");
    const body = await response.text();
    expect(JSON.stringify({ body, etag, status: response.status })).toBe(GOLDEN_STOREFRONT);
  });
});

// ── every mail kind of before, through the consumer ───────────────────────────

const HOUR_MS = 60 * 60 * 1_000;

async function frame(key: string) {
  const createdAt = Date.now();
  return {
    createdAt,
    deliveryId: await deliveryIdFromKey(`${key}:${crypto.randomUUID()}`),
    expiresAt: createdAt + HOUR_MS,
  };
}

async function everyKindOfBefore(): Promise<Array<[string, unknown]>> {
  const base = env.AUTH_BASE_URL;
  const ack = {
    consumerName: "Anna Andersson",
    contactEmail: "anna@buyer.test",
    exemptItems: [],
    orderNumber: "CS-AC-0001",
    shopName: "Golden AC",
    statement: "Jag ångrar mitt köp.",
    submittedAt: "2026-10-05T10:00:00.000Z",
    withdrawnItems: [{ name: "Mugg", quantity: 1, sku: "SKU-AC-MUG" }],
  };
  return [
    ["email_verification", createAuthEmailJob({
      actionUrl: `${base}/api/auth/verify-email?token=abc`,
      expiresAt: Date.now() + HOUR_MS,
      kind: "email_verification",
      locale: "sv",
      recipient: "verify@buyer.test",
    }, base)],
    ["password_reset", createAuthEmailJob({
      actionUrl: `${base}/api/auth/reset-password/tokengolden0001`,
      expiresAt: Date.now() + HOUR_MS,
      kind: "password_reset",
      locale: "sv",
      recipient: "reset@buyer.test",
    }, base)],
    ["password_reset invite", createAuthEmailJob({
      actionUrl: `${base}/api/auth/reset-password/tokengolden0002`,
      expiresAt: Date.now() + HOUR_MS,
      kind: "password_reset",
      locale: "sv",
      recipient: "invite@buyer.test",
      variant: "invite",
    }, base)],
    ["order_confirmation", createOrderConfirmationEmailJob({
      ...(await frame("confirmation")),
      order: {
        currency: "SEK",
        deliveryMethod: "shipping",
        discountMinor: 0,
        items: [{ lineTotalMinor: 30_000, name: "Mugg", quantity: 2 }],
        orderNumber: "CS-AC-0001",
        shippingCountry: "SE",
        shippingMinor: 4_900,
        shopName: "Golden AC",
        subtotalMinor: 30_000,
        totalMinor: 34_900,
        vatMinor: 6_980,
      },
      recipient: "order@buyer.test",
      tenantId: TENANT,
    })],
    ["alert_digest", createAlertDigestEmailJob({
      ...(await frame("digest")),
      digest: {
        bucketStart: "2026-10-05T10:00:00.000Z",
        kinds: [{ count: 1, kind: "outbox_failed", newCount: 1, oldestAt: "2026-10-05T09:00:00.000Z", resourceIds: ["ob-1"], severity: "warning" }],
        newCount: 1,
        omittedKinds: 0,
        openCount: 1,
      },
      recipient: "ops@platform.test",
    })],
    ["withdrawal_receipt", createWithdrawalEmailJob({
      ...(await frame("receipt")),
      kind: "withdrawal_receipt",
      recipient: "anna@buyer.test",
      tenantId: TENANT,
      withdrawal: { acknowledgement: ack, eligible: true, reason: null },
    })],
    ["withdrawal_notice", createWithdrawalEmailJob({
      ...(await frame("notice")),
      kind: "withdrawal_notice",
      recipient: "hej@golden-ac.test",
      tenantId: TENANT,
      withdrawal: { acknowledgement: ack, eligible: true, reason: null },
    })],
    ["order_status_update", createOrderEmailJob({
      ...(await frame("status")),
      content: {
        additionalParcel: false,
        carrier: "PostNord",
        orderNumber: "CS-AC-0001",
        pickupPlaceAddress: null,
        pickupPlaceName: null,
        recipientName: "Anna Andersson",
        shopName: "Golden AC",
        status: "shipped",
        supportEmail: "hej@golden-ac.test",
        trackingNumber: "TRACK-1",
      },
      kind: "order_status_update",
      recipient: "anna@buyer.test",
      tenantId: TENANT,
    })],
    ["order_notice_shop", createOrderEmailJob({
      ...(await frame("shop-notice")),
      content: {
        adminUrl: null,
        currency: "SEK",
        deliveryMethod: "shipping",
        discountMinor: 0,
        items: [{ lineTotalMinor: 30_000, name: "Mugg", quantity: 2 }],
        orderNumber: "CS-AC-0001",
        pickupPlaceName: null,
        shippingCountry: "SE",
        shippingMinor: 4_900,
        shopName: "Golden AC",
        subtotalMinor: 30_000,
        totalMinor: 34_900,
        vatMinor: 6_980,
      },
      kind: "order_notice_shop",
      recipient: "hej@golden-ac.test",
      tenantId: TENANT,
    })],
    ["refund_notice", createOrderEmailJob({
      ...(await frame("refund")),
      content: {
        amountMinor: 15_000,
        currency: "SEK",
        full: false,
        orderNumber: "CS-AC-0001",
        recipientName: "Anna Andersson",
        shopName: "Golden AC",
        supportEmail: "hej@golden-ac.test",
      },
      kind: "refund_notice",
      recipient: "anna@buyer.test",
      tenantId: TENANT,
    })],
  ];
}

describe("CP9-AC: every mail of before leaves through Resend exactly as before", () => {
  it("sends byte-identical request bodies and the same request headers", async () => {
    const jobs = await everyKindOfBefore();
    const sent: Array<{ body: string; headers: string[] }> = [];
    const testEnv = {
      ...env,
      [RESEND_FETCH_OVERRIDE]: async (request: Request) => {
        sent.push({
          body: await request.text(),
          headers: [...request.headers.keys()].sort(),
        });
        return Response.json({ id: `re_${crypto.randomUUID()}` });
      },
    } as unknown as Env;
    const acks: string[] = [];
    await worker.queue(
      {
        messages: jobs.map(([label, body]) => ({
          ack: () => acks.push(label),
          attempts: 1,
          body,
          id: label,
          retry: () => {
            throw new Error(`${label} was retried`);
          },
          timestamp: new Date(),
        })),
        queue: "chopshop-test-email",
        retryAll: () => {
          throw new Error("never retries a whole batch");
        },
      } as unknown as MessageBatch<unknown>,
      testEnv,
    );
    expect(acks).toEqual(jobs.map(([label]) => label));
    const byKind = Object.fromEntries(jobs.map(([label], index) => [label, sent[index]]));
    expect(JSON.stringify(byKind)).toBe(GOLDEN_MAILS);
  });
});
