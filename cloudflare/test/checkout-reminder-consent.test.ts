import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  freezeConsent,
  orderConsentOf,
  parseCheckoutConsent,
  readFrozenConsent,
  reminderConsentGiven,
  sameConsent,
} from "../src/legal/consent";
import { buyerRecipientFor } from "./legal-fixtures";
import { consentJson, seedProduct, seedReminderShop } from "./reminder-fixtures";

/**
 * CP9-AC build step 2: the reminder box in the frozen consent, and THE rule a
 * reminder is sent under (consent.ts reminderConsentGiven, AC4). The
 * byte-identity of an unticked checkout through the real route is
 * test/checkout-reminders-off-golden.test.ts.
 */

const NOW = 1_790_000_000_000;
const UNTICKED_BEFORE =
  '{"marketing":false,"recordedAt":"2026-09-21T14:13:20.000Z","terms":true,"v":1,' +
  '"withdrawal":{"disclosureSha256":null,"disclosureVersion":null,"personalizedItems":[],"waived":false}}';

describe("parseCheckoutConsent: the optional reminder box", () => {
  it("adds no key when the box is absent or unticked, and `reminder: true` when ticked", () => {
    expect(parseCheckoutConsent({ terms: true })).toEqual({
      disclosureVersion: null,
      marketing: false,
      terms: true,
      withdrawalWaiver: false,
    });
    expect(parseCheckoutConsent({ reminder: false, terms: true })).not.toHaveProperty("reminder");
    expect(parseCheckoutConsent({ reminder: true, terms: true })).toMatchObject({ reminder: true });
  });

  // null reads as absent, as `marketing` always has (the parser's `?? false`).
  it.each([["yes"], [1], [{}], [[true]]])("refuses a reminder of %j", (value) => {
    expect(parseCheckoutConsent({ reminder: value, terms: true })).toBeNull();
  });
});

describe("freezeConsent", () => {
  it("freezes an unticked checkout's consent byte for byte as before the box", async () => {
    for (const consent of [
      { disclosureVersion: null, marketing: false, terms: true as const, withdrawalWaiver: false },
      { disclosureVersion: null, marketing: false, reminder: false, terms: true as const, withdrawalWaiver: false },
    ]) {
      const frozen = await freezeConsent(consent, [], NOW);
      expect(frozen).toEqual({ json: UNTICKED_BEFORE, status: "ok" });
    }
  });

  it("freezes `reminder: true` when ticked, and never `reminder: false`", async () => {
    const frozen = await freezeConsent(
      { disclosureVersion: null, marketing: false, reminder: true, terms: true, withdrawalWaiver: false },
      [],
      NOW,
    );
    expect(frozen.status).toBe("ok");
    const json = (frozen as { json: string }).json;
    expect(json).toBe(UNTICKED_BEFORE.replace('"terms":true', '"reminder":true,"terms":true'));
    expect(json).not.toContain('"reminder":false');
  });

  it("reads back only `reminder: true` or no key; anything else is unreadable", () => {
    expect(readFrozenConsent(consentJson({ reminder: true }))?.reminder).toBe(true);
    expect(readFrozenConsent(consentJson())).not.toHaveProperty("reminder");
    expect(readFrozenConsent(consentJson().replace('"terms"', '"reminder":false,"terms"'))).toBeNull();
    expect(readFrozenConsent(consentJson().replace('"terms"', '"reminder":"yes","terms"'))).toBeNull();
  });

  it("matches a replay across the change (sameConsent), and not a replay that flipped the box", async () => {
    const fresh = await freezeConsent(
      { disclosureVersion: null, marketing: false, terms: true, withdrawalWaiver: false },
      [],
      NOW + 1_000,
    );
    expect(sameConsent(UNTICKED_BEFORE, (fresh as { json: string }).json)).toBe(true);
    const ticked = await freezeConsent(
      { disclosureVersion: null, marketing: false, reminder: true, terms: true, withdrawalWaiver: false },
      [],
      NOW + 2_000,
    );
    expect(sameConsent(UNTICKED_BEFORE, (ticked as { json: string }).json)).toBe(false);
  });

  it("is copied onto the order verbatim", () => {
    const json = consentJson({ reminder: true });
    expect(orderConsentOf(json)).toEqual({ consentJson: json, isPersonalized: 0 });
  });
});

describe("reminderConsentGiven (AC4): the reminder box OR the marketing box, of THIS checkout", () => {
  const waiverOnly = JSON.stringify({
    marketing: false,
    recordedAt: "2026-10-05T10:00:00.000Z",
    terms: true,
    v: 1,
    withdrawal: { disclosureSha256: "f".repeat(64), disclosureVersion: "v1-2026-06", personalizedItems: [0], waived: true },
  });

  it.each([
    ["no consent frozen", null, false],
    ["an unreadable consent", "{not json", false],
    ["a consent of another shape", JSON.stringify({ marketing: true }), false],
    ["terms alone", consentJson(), false],
    ["the withdrawal waiver alone", waiverOnly, false],
    ["the marketing box", consentJson({ marketing: true }), true],
    ["the reminder box", consentJson({ reminder: true }), true],
    ["both boxes", consentJson({ marketing: true, reminder: true }), true],
  ])("%s → %s", (_label, json, expected) => {
    expect(reminderConsentGiven(json)).toBe(expected);
  });
});

describe("POST /v1/checkout carries the box", () => {
  const TENANT = "tenant-ac-consent";
  let ip = 0;
  let host = "";

  beforeAll(async () => {
    host = (await seedReminderShop(TENANT, { addOn: null, seller: null })).host;
    await seedProduct(TENANT, "acc-mug");
  });

  function post(consent: unknown, idempotencyKey = `ac-consent-${crypto.randomUUID()}`): Promise<Response> {
    ip += 1;
    return exports.default.fetch(
      new Request(`https://${host}/v1/checkout`, {
        body: JSON.stringify({
          consent,
          deliveryMethod: "shipping",
          email: "box@buyer.test",
          idempotencyKey,
          items: [{ productId: "acc-mug", quantity: 1 }],
          recipient: buyerRecipientFor("shipping", "SE"),
          shippingCountry: "SE",
        }),
        headers: { "cf-connecting-ip": `198.51.100.${ip}`, "content-type": "application/json" },
        method: "POST",
      }),
    );
  }

  async function frozenOf(response: Response): Promise<string | null> {
    const { checkout } = await response.json<{ checkout: { checkoutId: string } }>();
    const row = await env.DB.prepare("SELECT consent_json FROM checkouts WHERE checkout_id = ?")
      .bind(checkout.checkoutId)
      .first<{ consent_json: string | null }>();
    return row?.consent_json ?? null;
  }

  it("freezes a ticked box, even on a shop that does not send reminders", async () => {
    const response = await post({ reminder: true, terms: true });
    expect(response.status).toBe(201);
    expect(readFrozenConsent(await frozenOf(response))?.reminder).toBe(true);
  });

  it("answers 400 for a box that is not a boolean", async () => {
    expect((await post({ reminder: "on", terms: true })).status).toBe(400);
  });

  it("answers 409 for a replay of the key with the box flipped", async () => {
    const key = `ac-consent-replay-${crypto.randomUUID()}`;
    expect((await post({ terms: true }, key)).status).toBe(201);
    expect((await post({ terms: true }, key)).status).toBe(200);
    expect((await post({ reminder: true, terms: true }, key)).status).toBe(409);
  });
});
