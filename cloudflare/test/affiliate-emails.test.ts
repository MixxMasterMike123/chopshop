import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { parseApplyInput, submitApplication } from "../src/affiliate/applications";
import { AFFILIATE_TERMS_VERSION } from "../src/affiliate/terms";
import { createCheckout } from "../src/commerce/checkout";
import { applyRefundFact } from "../src/commerce/refunds";
import {
  AFFILIATE_EMAIL_KINDS,
  type AffiliateEmailContent,
  type AffiliateEmailJob,
  type AffiliateEmailKind,
  affiliateReplyTo,
  affiliateSenderName,
  createAffiliateEmailJob,
  fingerprintAffiliateEmailJob,
  parseAffiliateEmailJob,
  renderAffiliateEmail,
  stockholmDay,
  swedishGenitive,
} from "../src/email/affiliate-emails";
import { fingerprintAuthEmailJob } from "../src/email/email-delivery-store";
import { processOutboxRowById } from "../src/outbox/effects";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import { featureStatement, nextId, seedAffiliate, seedPublicShop } from "./affiliate-fixtures";
import { seedPlainProduct, seedShop } from "./discount-fixtures";
import { quietEnv } from "./dispatch-fixtures";
import { payCheckout } from "./money-fixtures";

/**
 * CP13 — the affiliate mails (design §9): every kind's job parses, renders
 * and fingerprints stably, an unknown kind or a stray field is refused, and
 * the outbox effect builds the job from the rows (content frozen on first
 * build: a retry after a shop rename sends the identical job).
 */

const SAMPLES: Record<AffiliateEmailKind, AffiliateEmailContent> = {
  affiliate_application_denied: { reason: "Nej tack", shopName: "Butik", supportEmail: "hej@butik.test" },
  affiliate_application_notice: {
    adminUrl: "https://admin.test/admin/affiliates/applications/x",
    applicantEmail: "sara@x.test",
    applicantName: "Sara",
    promotionMethod: "blog",
    shopName: "Butik",
  },
  affiliate_application_received: { shopName: "Butik", supportEmail: null },
  affiliate_conversion: {
    availableAt: "2026-11-05T10:00:00.000Z",
    commissionMinor: 5_400,
    currency: "SEK",
    orderNumber: "1001",
    shopName: "Butik",
    supportEmail: "hej@butik.test",
  },
  affiliate_payout: {
    amountMinor: 10_000,
    currency: "SEK",
    outcome: "paid",
    reason: null,
    reference: "Swish 1",
    shopName: "Butik",
    supportEmail: "hej@butik.test",
  },
  affiliate_payout_requested: {
    adminUrl: null,
    affiliateName: "Sara",
    amountMinor: 10_000,
    currency: "SEK",
    shopName: "Butik",
  },
  affiliate_reversal: {
    amountMinor: 2_700,
    cause: "refund",
    currency: "SEK",
    direction: "reversed",
    orderNumber: "1001",
    shopName: "Butik",
    supportEmail: "hej@butik.test",
  },
  affiliate_welcome: {
    affiliateName: "Sara",
    code: "SARA-25",
    commissionBp: 1_500,
    discountBp: 1_000,
    portalUrl: "https://admin.test/affiliate?shopId=x",
    refLink: "https://web.test/x/?ref=SARA-25",
    shopName: "Butik",
    supportEmail: "hej@butik.test",
  },
};

const SHOP_FACING = new Set<AffiliateEmailKind>(["affiliate_application_notice", "affiliate_payout_requested"]);

function jobOf(kind: AffiliateEmailKind, overrides: Partial<Parameters<typeof createAffiliateEmailJob>[0]> = {}): AffiliateEmailJob {
  const now = Date.now();
  return createAffiliateEmailJob({
    content: SAMPLES[kind],
    createdAt: now,
    deliveryId: crypto.randomUUID(),
    expiresAt: now + 60_000,
    kind,
    locale: "sv",
    recipient: "Sara@X.test",
    tenantId: "shop",
    ...overrides,
  });
}

describe("the job of every kind", () => {
  it.each(AFFILIATE_EMAIL_KINDS.map((kind) => [kind]))("%s parses back to itself, renders in both locales, fingerprints stably", async (kind) => {
    const job = jobOf(kind);
    expect(job.recipient).toBe("sara@x.test");
    const parsed = parseAffiliateEmailJob(JSON.parse(JSON.stringify(job)));
    expect(parsed).toEqual(job);
    expect(await fingerprintAffiliateEmailJob(parsed)).toBe(await fingerprintAffiliateEmailJob(job));
    // Key order of the content does not move the fingerprint.
    const reversed = { ...job, content: Object.fromEntries(Object.entries(job.content).reverse()) };
    expect(await fingerprintAffiliateEmailJob(parseAffiliateEmailJob(reversed))).toBe(await fingerprintAffiliateEmailJob(job));
    // The consumer's store fingerprints it the same way.
    expect(await fingerprintAuthEmailJob(job as never)).toBe(await fingerprintAffiliateEmailJob(job));
    for (const locale of SHOP_FACING.has(kind) ? (["sv"] as const) : (["sv", "en"] as const)) {
      const message = renderAffiliateEmail({ ...job, locale });
      expect(message.subject.length, locale).toBeGreaterThan(0);
      for (const text of [message.subject, message.text, message.html]) {
        expect(text).not.toMatch(/undefined|null|NaN|\{\{/);
      }
    }
    if (SHOP_FACING.has(kind)) {
      expect(affiliateSenderName(job)).toBeNull();
      expect(affiliateReplyTo(job)).toBeNull();
      expect(() => parseAffiliateEmailJob({ ...job, locale: "en" })).toThrow();
    } else {
      expect(affiliateSenderName(job)).toBe("Butik");
    }
  });

  it("refuses an unknown kind, a missing or stray field, a wrong type, an http link", () => {
    const job = jobOf("affiliate_welcome");
    expect(() => parseAffiliateEmailJob({ ...job, kind: "affiliate_bonus" })).toThrow();
    const { code: _code, ...missing } = job.content;
    expect(() => parseAffiliateEmailJob({ ...job, content: missing })).toThrow();
    expect(() => parseAffiliateEmailJob({ ...job, content: { ...job.content, extra: "x" } })).toThrow();
    expect(() => parseAffiliateEmailJob({ ...job, content: { ...job.content, commissionBp: 10_001 } })).toThrow();
    expect(() => parseAffiliateEmailJob({ ...job, content: { ...job.content, refLink: "http://web.test/x/?ref=A" } })).toThrow();
    expect(() => parseAffiliateEmailJob({ ...job, actionUrl: "https://x.test" })).toThrow();
    expect(() => parseAffiliateEmailJob({ ...job, expiresAt: job.createdAt + 25 * 60 * 60 * 1_000 })).toThrow();
  });

  it("formats money and rates in Swedish", () => {
    const conversion = renderAffiliateEmail(jobOf("affiliate_conversion"));
    expect(conversion.text).toContain("54");
    const welcome = renderAffiliateEmail(jobOf("affiliate_welcome"));
    expect(welcome.text).toContain("15 %");
    expect(welcome.text).toContain("SARA-25");
    expect(welcome.text).toContain("https://web.test/x/?ref=SARA-25");
  });
});

describe("the final copy (A4)", () => {
  const SV_SUBJECTS: Record<AffiliateEmailKind, string> = {
    affiliate_application_denied: "Din ansökan till Butiks affiliateprogram",
    affiliate_application_notice: "Ny affiliate-ansökan: Sara",
    affiliate_application_received: "Tack för din ansökan till Butiks affiliateprogram",
    affiliate_conversion: "Ny provision: 54,00\u00a0kr",
    affiliate_payout: "Utbetalning registrerad: 100,00\u00a0kr",
    affiliate_payout_requested: "Sara begär utbetalning: 100,00\u00a0kr",
    affiliate_reversal: "Provision justerad: −27,00\u00a0kr",
    affiliate_welcome: "Du har lagts till som affiliate hos Butik",
  };

  it.each(AFFILIATE_EMAIL_KINDS.map((kind) => [kind]))("%s has its Swedish subject", (kind) => {
    expect(renderAffiliateEmail(jobOf(kind)).subject).toBe(SV_SUBJECTS[kind]);
  });

  it("every English mail is English, and the subject is never the Swedish one", () => {
    for (const kind of AFFILIATE_EMAIL_KINDS.filter((k) => !SHOP_FACING.has(k))) {
      const message = renderAffiliateEmail(jobOf(kind, { locale: "en" }));
      expect(message.subject, kind).not.toBe(SV_SUBJECTS[kind]);
      expect(message.text, kind).not.toMatch(/[åäö]/i);
    }
  });

  it("the Swedish genitive: a name ending in s, x or z takes no extra s; no name reads 'butikens'", () => {
    const named = (shopName: string | null) =>
      renderAffiliateEmail(jobOf("affiliate_application_received", { content: { shopName, supportEmail: null } })).subject;
    expect(named("Lars")).toBe("Tack för din ansökan till Lars affiliateprogram");
    expect(named("Max")).toBe("Tack för din ansökan till Max affiliateprogram");
    expect(named("Kent")).toBe("Tack för din ansökan till Kents affiliateprogram");
    expect(named(null)).toBe("Tack för din ansökan till butikens affiliateprogram");
  });

  it("the genitive (round 1): trimmed; a digit, a non-letter or an all-caps last word takes ':s'", () => {
    expect(swedishGenitive("  Kent  ")).toBe("Kents");
    expect(swedishGenitive("Lars")).toBe("Lars");
    expect(swedishGenitive("Fritz")).toBe("Fritz");
    expect(swedishGenitive("Meteor PR AB")).toBe("Meteor PR AB:s");
    expect(swedishGenitive("IKEA")).toBe("IKEA:s");
    expect(swedishGenitive("Shop24")).toBe("Shop24:s");
    expect(swedishGenitive("Kaffe & Co.")).toBe("Kaffe & Co.:s");
    expect(swedishGenitive("Åsas Ö")).toBe("Åsas Ös");
    expect(swedishGenitive("   ")).toBe("butikens");
  });

  it("the payable day is the Swedish calendar day, not the UTC one (round 1)", () => {
    // Winter (CET, UTC+1): 23:30Z is 00:30 the next day; 22:30Z is still the same day.
    expect(stockholmDay("2026-11-05T23:30:00.000Z")).toBe("2026-11-06");
    expect(stockholmDay("2026-11-05T22:30:00.000Z")).toBe("2026-11-05");
    // Summer (CEST, UTC+2): 22:30Z is 00:30 the next day.
    expect(stockholmDay("2026-07-05T22:30:00.000Z")).toBe("2026-07-06");
    expect(stockholmDay("2026-11-05T10:00:00.000Z")).toBe("2026-11-05");
    const late = renderAffiliateEmail(
      jobOf("affiliate_conversion", { content: { ...SAMPLES.affiliate_conversion, availableAt: "2026-11-05T23:15:00.000Z" } }),
    );
    expect(late.text).toContain("tidigast 2026-11-06");
    expect(late.text).not.toContain("2026-11-05");
  });

  it("a mail under the shop's name closes with its support address and its name; the shop's own mails do not", () => {
    const conversion = renderAffiliateEmail(jobOf("affiliate_conversion"));
    expect(conversion.text).toContain("hej@butik.test");
    expect(conversion.text).toContain("Hälsningar, Butik");
    expect(conversion.text).toContain("14 dagar");
    expect(conversion.text).toContain("2026-11-05");
    expect(conversion.text).toContain("order 1001");
    const notice = renderAffiliateEmail(jobOf("affiliate_application_notice"));
    expect(notice.text).not.toContain("Hälsningar");
    expect(notice.text).toContain("Kanal: Blogg");
    expect(notice.text).toContain("Öppna ansökan: https://admin.test/admin/affiliates/applications/x");
  });

  it("each reversal says why: a refund, a lost dispute, a refund that failed", () => {
    const of = (cause: string, direction: string) =>
      renderAffiliateEmail(jobOf("affiliate_reversal", { content: { ...SAMPLES.affiliate_reversal, cause, direction } }));
    expect(of("refund", "reversed").text).toMatch(/återbetalats helt eller delvis/);
    expect(of("dispute", "reversed").text).toMatch(/förlorade tvisten/);
    const restored = of("refund", "restored");
    expect(restored.subject).toBe("Provision återställd: +27,00\u00a0kr");
    expect(restored.text).toMatch(/gick inte igenom/);
  });

  it("a declined payout keeps the reason out of the subject and in the body", () => {
    const declined = renderAffiliateEmail(
      jobOf("affiliate_payout", { content: { ...SAMPLES.affiliate_payout, outcome: "void", reason: "Fakturan saknar org.nr", reference: null } }),
    );
    expect(declined.subject).toBe("Begäran om utbetalning avvisad");
    expect(declined.text).toContain("Orsak: Fakturan saknar org.nr");
    expect(declined.text).toContain("finns kvar i ditt saldo");
  });

  it("the applicant's mails cannot carry what the applicant typed: no such field exists", () => {
    for (const kind of ["affiliate_application_received", "affiliate_application_denied"] as const) {
      for (const typed of ["applicantName", "applicantEmail", "promotionMethod", "message", "name"]) {
        expect(() => jobOf(kind, { content: { ...SAMPLES[kind], [typed]: "Ada" } }), `${kind}.${typed}`).toThrow();
      }
    }
  });

  // The values were cross-checked outside the Worker: SHA-256 of the canonical
  // JSON (frame keys in fingerprintAuthEmailJob order, then the content in
  // CONTENT order), computed independently.
  it("the fingerprint is pinned (a field or frame-order change shows here)", async () => {
    const fixed = (kind: AffiliateEmailKind) =>
      createAffiliateEmailJob({
        content: SAMPLES[kind],
        createdAt: 1_787_300_000_000,
        deliveryId: "4f6c2a8e-1b3d-4c5e-9f70-a1b2c3d4e5f6",
        expiresAt: 1_787_300_060_000,
        kind,
        locale: "sv",
        recipient: "sara@x.test",
        tenantId: "shop",
      });
    expect(await fingerprintAffiliateEmailJob(fixed("affiliate_welcome"))).toBe("fe5774dfb087acb3dcf5676bf8244a170182746ad6189d15ff10f4c4a9107a3f");
    expect(await fingerprintAffiliateEmailJob(fixed("affiliate_conversion"))).toBe("6fb29fda4d13fb184da6f705a3ef9b1975eba69034628d73279cc860721994b1");
  });
});

describe("the effect builds the job from the rows", () => {
  const SHOP = "aff-mail";
  const ORDERS = "aff-mail-orders";
  const ORDERS_CONTEXT: TenantContext = { domainKind: "storefront", hostname: "aff-mail-orders.test", tenantId: ORDERS };

  beforeAll(async () => {
    await seedPublicShop(SHOP, "aff-mail.shop.test");
    await seedShop(ORDERS, "aff-mail-orders.test", { discountCodes: false });
    await env.DB.prepare("UPDATE tenants SET support_email = 'hej@aff-mail-orders.test' WHERE tenant_id = ?").bind(ORDERS).run();
    await seedPlainProduct(ORDERS, `${ORDERS}-goods`, 50_000);
    await featureStatement(ORDERS, "affiliate", true).run();
    await seedAffiliate({ code: "MAILME", tenantId: ORDERS });
  });

  async function outboxIdsOf(aggregateId: string): Promise<Array<{ outbox_id: string; payload_json: string }>> {
    const rows = await env.DB.prepare("SELECT outbox_id, payload_json FROM outbox_events WHERE aggregate_id = ? ORDER BY outbox_id")
      .bind(aggregateId)
      .all<{ outbox_id: string; payload_json: string }>();
    return rows.results;
  }

  it("an application: the received mail to the applicant (shop as sender), the notice to the shop in Swedish", async () => {
    const input = parseApplyInput({
      email: "Applicant@Mail.test",
      message: "Spam me https://spam.example",
      name: "Ada Applicant",
      preferredLang: "en",
      promotionMethod: "instagram",
      termsAccepted: true,
      termsVersion: AFFILIATE_TERMS_VERSION,
    });
    if (input === null) {
      throw new Error("input");
    }
    const result = await submitApplication(env.DB, { domainKind: "storefront", hostname: "aff-mail.shop.test", tenantId: SHOP }, input, Date.now());
    if (result.status !== "accepted") {
      throw new Error(result.status);
    }
    const rows = await outboxIdsOf(result.applicationId);
    expect(rows).toHaveLength(2);
    const jobs: AffiliateEmailJob[] = [];
    for (const row of rows) {
      const { emails, env: quiet } = quietEnv();
      expect(await processOutboxRowById(quiet, row.outbox_id)).toEqual({ kind: "ran", outcome: { kind: "done" } });
      jobs.push(...(emails.sent as AffiliateEmailJob[]));
    }
    const received = jobs.find((job) => job.kind === "affiliate_application_received");
    const notice = jobs.find((job) => job.kind === "affiliate_application_notice");
    expect(received).toMatchObject({
      content: { shopName: `Butik ${SHOP}`, supportEmail: `hej@aff-mail.shop.test` },
      locale: "en",
      recipient: "applicant@mail.test",
    });
    // Nothing the applicant typed goes back to the address they typed (round 1).
    const rendered = renderAffiliateEmail(received as AffiliateEmailJob);
    for (const typed of ["Ada", "Applicant", "Spam me", "instagram"]) {
      expect(JSON.stringify([received, rendered]), typed).not.toContain(typed);
    }
    expect(notice?.content).toMatchObject({ applicantName: "Ada Applicant" });
    expect(notice).toMatchObject({ content: { applicantEmail: "applicant@mail.test", promotionMethod: "instagram" }, locale: "sv", recipient: "hej@aff-mail.shop.test" });
  });

  it("a conversion and a reversal: the affiliate's mails, the order's number, never the buyer", async () => {
    const created = await createCheckout(
      env.DB,
      ORDERS_CONTEXT,
      {
        deliveryMethod: "pickup",
        discountCode: null,
        email: "buyer-secret@buyer.test",
        idempotencyKey: nextId("idem"),
        items: [{ productId: `${ORDERS}-goods`, quantity: 1 }],
        refCode: "MAILME",
        shippingCountry: null,
      },
      Date.now(),
    );
    if (created.status !== "ok") {
      throw new Error(created.status);
    }
    const intent = `pi_mail_${created.checkout.checkoutId.replaceAll("-", "")}`;
    await env.DB.prepare("UPDATE checkouts SET payment_intent_id = ? WHERE checkout_id = ?").bind(intent, created.checkout.checkoutId).run();
    const orderId = await payCheckout(
      { checkoutId: created.checkout.checkoutId, paymentIntentId: intent, totalMinor: created.checkout.totalMinor },
      ORDERS,
    );
    await applyRefundFact(
      env.DB,
      { amount: Math.floor(created.checkout.totalMinor / 2), operationId: null, paymentIntentId: intent, status: "succeeded", stripeRefundId: `re_mail_${Date.now()}` },
      Date.now(),
    );
    const rows = (await outboxIdsOf(orderId)).filter((row) => row.payload_json.includes("affiliate_"));
    expect(rows).toHaveLength(2);
    const jobs: AffiliateEmailJob[] = [];
    for (const row of rows) {
      const { emails, env: quiet } = quietEnv();
      expect(await processOutboxRowById(quiet, row.outbox_id)).toEqual({ kind: "ran", outcome: { kind: "done" } });
      jobs.push(...(emails.sent as AffiliateEmailJob[]));
    }
    const conversion = jobs.find((job) => job.kind === "affiliate_conversion");
    const reversal = jobs.find((job) => job.kind === "affiliate_reversal");
    expect(conversion?.content).toMatchObject({ commissionMinor: 5_400, currency: "SEK", shopName: `Shop ${ORDERS}` });
    expect(reversal?.content).toMatchObject({ amountMinor: 2_700, cause: "refund", direction: "reversed" });
    expect(JSON.stringify(jobs)).not.toContain("buyer-secret");
    expect(jobs.every((job) => job.recipient.endsWith("@affiliate.test"))).toBe(true);
  });

  it("a retry sends the job frozen at first build (a renamed shop changes nothing)", async () => {
    const input = parseApplyInput({
      email: "retry@mail.test",
      name: "Rita Retry",
      preferredLang: "sv",
      promotionMethod: "blog",
      termsAccepted: true,
      termsVersion: AFFILIATE_TERMS_VERSION,
    });
    const result = await submitApplication(env.DB, { domainKind: "storefront", hostname: "aff-mail.shop.test", tenantId: SHOP }, input as never, Date.now());
    if (result.status !== "accepted") {
      throw new Error(result.status);
    }
    const row = (await outboxIdsOf(result.applicationId)).find((entry) => entry.payload_json.includes("application_received"));
    const outboxId = row?.outbox_id ?? "";
    const failing = quietEnv({ EMAIL_QUEUE: { send: async () => Promise.reject(new Error("down")), sendBatch: async () => Promise.reject(new Error("down")) } });
    expect(await processOutboxRowById(failing.env, outboxId)).toMatchObject({ outcome: { kind: "retry" } });
    await env.DB.prepare("UPDATE tenants SET shop_name = 'Nytt namn' WHERE tenant_id = ?").bind(SHOP).run();
    const { emails, env: quiet } = quietEnv();
    expect(await processOutboxRowById(quiet, outboxId, () => Date.now() + 10 * 60_000)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect((emails.sent[0] as AffiliateEmailJob).content.shopName).toBe(`Butik ${SHOP}`);
    await env.DB.prepare("UPDATE tenants SET shop_name = ? WHERE tenant_id = ?").bind(`Butik ${SHOP}`, SHOP).run();
  });
});
