import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { mintRecoveryToken } from "../src/commerce/checkout-recovery-token";
import { deliveryIdFromKey, hashEmailRecipient, parseAuthEmailJob, renderAuthEmail } from "../src/email/auth-email-job";
import {
  type CheckoutReminderContent,
  checkoutReminderFrom,
  createCheckoutReminderEmailJob,
  linkValidUntilOf,
  REMINDER_JOB_LIFETIME_MS,
  reminderDisplayName,
  swedishDate,
} from "../src/email/checkout-reminder-email";
import { fingerprintAuthEmailJob } from "../src/email/email-delivery-store";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";
import { seedReminderShop } from "./reminder-fixtures";

/**
 * CP9-AC build step 4: the reminder's job, its Swedish text, and what the
 * consumer sends for THIS kind (the shop's name as sender, Reply-To, the two
 * List-Unsubscribe headers, never to an unsubscribed address). That every
 * other kind leaves exactly as before is test/checkout-reminders-off-golden.test.ts.
 */

const TENANT = "tenant-ac-mail";
const WEB = "https://web.test.invalid";
const REMINDER = "5c4b3a2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const HOUR_MS = 60 * 60 * 1_000;

let resume = "";
let unsubscribe = "";

beforeAll(async () => {
  await seedReminderShop(TENANT, { seller: null });
  resume = (await mintRecoveryToken(env, TENANT, REMINDER, "resume")) as string;
  unsubscribe = (await mintRecoveryToken(env, TENANT, REMINDER, "unsubscribe")) as string;
});

function content(overrides: Partial<CheckoutReminderContent> = {}): CheckoutReminderContent {
  return {
    items: [
      { label: "Svart, M", name: "T-shirt Fjäll", quantity: 2 },
      { label: null, name: "Mugg", quantity: 1 },
    ],
    linkValidUntil: "2026-10-11",
    oneClickUnsubscribeUrl: `${WEB}/_api/${TENANT}/v1/checkout-recovery/${unsubscribe}/unsubscribe`,
    recipientName: "Anna Andersson",
    resumeUrl: `${WEB}/${TENANT}/aterta/${resume}`,
    shopName: "Fjällboden",
    supportEmail: "hej@fjallboden.test",
    unsubscribeUrl: `${WEB}/${TENANT}/avregistrera/${unsubscribe}`,
    ...overrides,
  };
}

async function job(overrides: Partial<CheckoutReminderContent> = {}, frame: { createdAt?: number; expiresAt?: number } = {}) {
  const createdAt = frame.createdAt ?? Date.now();
  return createCheckoutReminderEmailJob({
    content: content(overrides),
    createdAt,
    deliveryId: await deliveryIdFromKey(`email.checkout_reminder:${crypto.randomUUID()}`),
    expiresAt: frame.expiresAt ?? createdAt + REMINDER_JOB_LIFETIME_MS,
    recipient: "Anna@Buyer.TEST",
    tenantId: TENANT,
  });
}

describe("the job", () => {
  it("creates, parses and fingerprints as one: the queued copy is the producer's", async () => {
    const created = await job();
    expect(created.recipient).toBe("anna@buyer.test");
    const queued = JSON.parse(JSON.stringify(created)) as unknown;
    const parsed = parseAuthEmailJob(queued, env.AUTH_BASE_URL);
    expect(parsed).toEqual(created);
    expect(await fingerprintAuthEmailJob(parsed)).toBe(await fingerprintAuthEmailJob(created));
    // Every rendered field is covered.
    const renamed = { ...created, content: { ...created.content, shopName: "Annan butik" } };
    expect(await fingerprintAuthEmailJob(renamed)).not.toBe(await fingerprintAuthEmailJob(created));
    const moved = { ...created, content: { ...created.content, oneClickUnsubscribeUrl: created.content.oneClickUnsubscribeUrl.replace("web.test", "webb.test") } };
    expect(await fingerprintAuthEmailJob(moved)).not.toBe(await fingerprintAuthEmailJob(created));
  });

  it("lives at most 2 hours", async () => {
    const now = Date.now();
    await expect(job({}, { createdAt: now, expiresAt: now + REMINDER_JOB_LIFETIME_MS })).resolves.toBeDefined();
    await expect(job({}, { createdAt: now, expiresAt: now + REMINDER_JOB_LIFETIME_MS + 1 })).rejects.toThrow();
    expect(REMINDER_JOB_LIFETIME_MS).toBe(2 * HOUR_MS);
  });

  it("carries 1 to 50 lines", async () => {
    const line = { label: null, name: "Mugg", quantity: 1 };
    await expect(job({ items: [] })).rejects.toThrow();
    await expect(job({ items: Array.from({ length: 50 }, () => line) })).resolves.toBeDefined();
    await expect(job({ items: Array.from({ length: 51 }, () => line) })).rejects.toThrow();
    await expect(job({ items: [{ ...line, quantity: 0 }] })).rejects.toThrow();
    await expect(job({ items: [{ ...line, name: "Mugg\nX" }] })).rejects.toThrow();
  });

  it.each([
    ["http", (c: CheckoutReminderContent) => ({ resumeUrl: c.resumeUrl.replace("https:", "http:") })],
    ["credentials", (c: CheckoutReminderContent) => ({ resumeUrl: c.resumeUrl.replace("https://", "https://u:p@") })],
    ["a query", (c: CheckoutReminderContent) => ({ resumeUrl: `${c.resumeUrl}?x=1` })],
    ["a fragment", (c: CheckoutReminderContent) => ({ unsubscribeUrl: `${c.unsubscribeUrl}#x` })],
    ["another shop", (c: CheckoutReminderContent) => ({ resumeUrl: c.resumeUrl.replace(`/${TENANT}/`, "/other-shop/") })],
    ["another path", (c: CheckoutReminderContent) => ({ resumeUrl: c.resumeUrl.replace("/aterta/", "/checkout/") })],
    ["a malformed token", (c: CheckoutReminderContent) => ({ resumeUrl: `${c.resumeUrl.slice(0, -1)}` })],
    ["another host for one link", (c: CheckoutReminderContent) => ({ unsubscribeUrl: c.unsubscribeUrl.replace("web.test.invalid", "evil.test.invalid") })],
    ["two unsubscribe tokens", (c: CheckoutReminderContent) => ({ oneClickUnsubscribeUrl: c.oneClickUnsubscribeUrl.replace(unsubscribe, resume) })],
    ["the resume token as the unsubscribe link", (c: CheckoutReminderContent) => ({ unsubscribeUrl: c.unsubscribeUrl.replace(unsubscribe, resume), oneClickUnsubscribeUrl: c.oneClickUnsubscribeUrl.replace(unsubscribe, resume) })],
    ["the one-click link to the page", (c: CheckoutReminderContent) => ({ oneClickUnsubscribeUrl: c.unsubscribeUrl })],
    ["a link with a trailing slash", (c: CheckoutReminderContent) => ({ resumeUrl: `${c.resumeUrl}/` })],
  ])("refuses a link with %s", async (_label, change) => {
    await expect(job(change(content()))).rejects.toThrow();
  });

  it("refuses a malformed day, a bad support address and a control character in a name", async () => {
    await expect(job({ linkValidUntil: "2026-02-30" })).rejects.toThrow();
    await expect(job({ linkValidUntil: "12 oktober" })).rejects.toThrow();
    await expect(job({ supportEmail: "Hej@Shop.test" })).rejects.toThrow();
    await expect(job({ supportEmail: "no-dot@localhost" })).rejects.toThrow();
    await expect(job({ shopName: "Fjäll\rboden" })).rejects.toThrow();
    await expect(job({ recipientName: "" })).rejects.toThrow();
  });
});

describe("the Swedish text (AC5, AC8)", () => {
  it("says what the design says, with every value", async () => {
    const message = renderAuthEmail(await job());
    expect(message.subject).toBe("Du glömde något i kassan hos Fjällboden");
    expect(message.text).toBe(
      [
        "Din varukorg väntar",
        "",
        "Hej Anna Andersson,",
        "",
        "Du påbörjade ett köp hos Fjällboden men slutförde det inte. Vi har sparat varorna åt dig:",
        "- 2 st T-shirt Fjäll (Svart, M)",
        "- 1 st Mugg",
        "",
        `Slutför köpet: ${WEB}/${TENANT}/aterta/${resume}`,
        "Länken gäller till och med 11 oktober 2026. Priser och frakt visas i kassan.",
        "",
        "Du får det här mejlet eftersom du gav Fjällboden lov att mejla dig när du handlade.",
        "Det här är den enda påminnelsen om det här köpet.",
        `Vill du inte få fler påminnelser från Fjällboden? Avregistrera dig: ${WEB}/${TENANT}/avregistrera/${unsubscribe}`,
        "Har du frågor? Kontakta Fjällboden på hej@fjallboden.test.",
      ].join("\n"),
    );
    expect(message.html).toContain(`<a href="${WEB}/${TENANT}/aterta/${resume}">Slutför köpet</a>`);
    expect(message.html).toContain(`<a href="${WEB}/${TENANT}/avregistrera/${unsubscribe}">Avregistrera dig från påminnelser</a>`);
  });

  it("falls back without a shop name, a recipient name or a support address", async () => {
    const message = renderAuthEmail(await job({ recipientName: null, shopName: null, supportEmail: null }));
    expect(message.subject).toBe("Du glömde något i kassan");
    expect(message.text).toContain("\nHej,\n");
    expect(message.text).toContain("Du påbörjade ett köp hos butiken men slutförde det inte.");
    expect(message.text).toContain("Vill du inte få fler påminnelser från butiken?");
    expect(message.text).toContain("Har du frågor? Kontakta butiken.");
  });

  it("names no price, total, carriage, VAT, discount or code anywhere", async () => {
    const message = renderAuthEmail(await job());
    for (const part of [message.subject, message.text, message.html]) {
      expect(part).not.toMatch(/\d\s*kr\b/);
      expect(part).not.toMatch(/moms|rabatt|totalt|delsumma|kod/i);
    }
  });

  it("escapes every value in the HTML part", async () => {
    const message = renderAuthEmail(await job({
      items: [{ label: "<b>", name: "Mugg & \"Kopp\"", quantity: 1 }],
      recipientName: "<script>x</script>",
      shopName: "Fjäll <boden>",
    }));
    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toContain("<b>");
    expect(message.html).toContain("Hej &lt;script&gt;x&lt;/script&gt;,");
    expect(message.html).toContain("Mugg &amp; &quot;Kopp&quot; (&lt;b&gt;)");
    expect(message.html).toContain("Fjäll &lt;boden&gt;");
  });

  it("writes the last FULL Stockholm day the link works", () => {
    // 2026-10-12 14:23 Stockholm (CEST, UTC+2) → the 11th.
    expect(linkValidUntilOf(Date.UTC(2026, 9, 12, 12, 23))).toBe("2026-10-11");
    // Just after midnight on the 12th → still the 11th (the 11th is whole).
    expect(linkValidUntilOf(Date.UTC(2026, 9, 11, 22, 30))).toBe("2026-10-10");
    // Across the autumn change (25 October 2026 has 25 hours): expiry 00:30 on
    // the 26th (CET) → the 25th, which ends at 23:00 UTC, before the expiry.
    expect(linkValidUntilOf(Date.UTC(2026, 9, 25, 23, 30))).toBe("2026-10-25");
    // Expiry 23:30 on the 25th (CET): 25 h back is 23:30 on the 24th (CEST).
    expect(linkValidUntilOf(Date.UTC(2026, 9, 25, 22, 30))).toBe("2026-10-24");
    expect(swedishDate("2026-10-12")).toBe("12 oktober 2026");
    expect(swedishDate("2027-01-01")).toBe("1 januari 2027");
  });
});

describe("the sender of THIS kind (AC13)", () => {
  it("is the shop's name over the platform's address, cleaned", () => {
    expect(checkoutReminderFrom("ChopShop Test <no-reply@mail.test.invalid>", "Fjällboden")).toBe(
      '"Fjällboden" <no-reply@mail.test.invalid>',
    );
    expect(checkoutReminderFrom("no-reply@mail.test.invalid", "Fjällboden")).toBe('"Fjällboden" <no-reply@mail.test.invalid>');
    expect(checkoutReminderFrom("ChopShop Test <no-reply@mail.test.invalid>", null)).toBe(
      "ChopShop Test <no-reply@mail.test.invalid>",
    );
    expect(reminderDisplayName('Fjäll "boden" <x@y.se>\r\nBcc: z@w.se\\')).toBe("Fjäll boden x@y.se Bcc: z@w.se");
    expect(reminderDisplayName("   ")).toBeNull();
    expect(reminderDisplayName("x".repeat(150))).toHaveLength(100);
  });
});

describe("the consumer, for this kind", () => {
  function batchOf(bodies: unknown[]) {
    const acks: string[] = [];
    const retries: string[] = [];
    return {
      acks,
      batch: {
        messages: bodies.map((body, index) => ({
          ack: () => acks.push(`m${index}`),
          attempts: 1,
          body,
          id: `m${index}`,
          retry: () => retries.push(`m${index}`),
          timestamp: new Date(),
        })),
        queue: "chopshop-test-email",
        retryAll: () => {
          throw new Error("never retries a whole batch");
        },
      } as unknown as MessageBatch<unknown>,
      retries,
    };
  }

  function resend() {
    const calls: Request[] = [];
    return {
      calls,
      env: {
        ...env,
        [RESEND_FETCH_OVERRIDE]: async (request: Request) => {
          calls.push(request);
          return Response.json({ id: `re_${crypto.randomUUID()}` });
        },
      } as unknown as Env,
    };
  }

  it("sends the shop's name as sender, the support address as Reply-To and both List-Unsubscribe headers", async () => {
    const reminder = await job({ shopName: 'Fjäll "<boden>"' });
    const fake = resend();
    const { acks, batch } = batchOf([reminder]);
    await worker.queue(batch, fake.env);
    expect(acks).toEqual(["m0"]);
    expect(fake.calls).toHaveLength(1);
    const body = await fake.calls[0]!.json<Record<string, unknown>>();
    expect(body).toEqual({
      from: '"Fjäll boden" <no-reply@mail.test.invalid>',
      headers: {
        "List-Unsubscribe": `<${WEB}/_api/${TENANT}/v1/checkout-recovery/${unsubscribe}/unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      html: renderAuthEmail(reminder).html,
      reply_to: "hej@fjallboden.test",
      subject: renderAuthEmail(reminder).subject,
      text: renderAuthEmail(reminder).text,
      to: ["anna@buyer.test"],
    });
    expect(fake.calls[0]!.headers.get("idempotency-key")).toBe(reminder.deliveryId);
  });

  it("sends nothing to an address that unsubscribed after the job was built", async () => {
    const reminder = await job();
    await env.DB.prepare(
      "INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at) VALUES (?, ?, 'unsubscribe', ?) ON CONFLICT DO NOTHING",
    )
      .bind(TENANT, await hashEmailRecipient(reminder.recipient), Date.now())
      .run();
    const fake = resend();
    const { acks, batch } = batchOf([reminder]);
    await worker.queue(batch, fake.env);
    expect(acks).toEqual(["m0"]);
    expect(fake.calls).toHaveLength(0);
    const ledger = await env.DB.prepare("SELECT status, last_error_code FROM email_deliveries WHERE delivery_id = ?")
      .bind(reminder.deliveryId)
      .first();
    expect(ledger).toEqual({ last_error_code: "E_UNSUBSCRIBED", status: "failed" });
  });
});
