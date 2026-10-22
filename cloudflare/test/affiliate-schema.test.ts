import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { affiliateTermsSha256, AFFILIATE_TERMS_VERSION } from "../src/affiliate/terms";
import {
  count,
  iso,
  nextId,
  refusal,
  seedAccess,
  seedAffiliate,
  seedUser,
} from "./affiliate-fixtures";
import { seedCode } from "./discount-fixtures";
import { seedTenant } from "./dispatch-fixtures";

/**
 * CP13 — migrations 0058 and 0059, one refusal per CHECK and trigger (design
 * §3, §2.3). Every refusal is tried on an otherwise valid row, so the named
 * constraint is the only one that can fire. The staged replays of both
 * migrations on a database holding rows are test/affiliate-migration.test.ts.
 */

const TENANT = "aff-schema";
const OTHER = "aff-schema-other";
const T0 = "2026-10-22T10:00:00.000Z";

let userId = "";
let affiliateId = "";
let otherAffiliateId = "";

beforeAll(async () => {
  await seedTenant(TENANT);
  await seedTenant(OTHER);
  userId = await seedUser("schema-aff@affiliate.test");
  await seedAccess(userId, "affiliate");
  affiliateId = (await seedAffiliate({ code: "SCHEMA1", tenantId: TENANT, userId })).affiliateId;
  otherAffiliateId = (await seedAffiliate({ code: "OTHERAFF", tenantId: OTHER })).affiliateId;
});

type Row = Record<string, unknown>;

function insert(table: string, row: Row, verb = "INSERT"): D1PreparedStatement {
  const columns = Object.keys(row);
  return env.DB.prepare(
    `${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).bind(...columns.map((column) => row[column]));
}

function affiliateRow(overrides: Row = {}): Row {
  return {
    affiliate_id: crypto.randomUUID(),
    code: `C${Math.floor(Math.random() * 1e6)}`,
    commission_bp: 1500,
    created_at: T0,
    created_by: "test",
    currency: "SEK",
    discount_bp: 1000,
    name: "Anna",
    preferred_lang: "sv",
    status: "active",
    tenant_id: TENANT,
    terms_accepted_at: T0,
    terms_version: "2026-10-22",
    updated_at: T0,
    user_id: userId,
    ...overrides,
  };
}

describe("0058: identity_access admits 'affiliate'; the feature key; the mail kinds", () => {
  it("admits an affiliate identity and still refuses an unknown kind", async () => {
    const id = await seedUser(`${nextId("k")}@affiliate.test`);
    await expect(seedAccess(id, "affiliate")).resolves.toBeUndefined();
    const other = await seedUser(`${nextId("k")}@affiliate.test`);
    await expect(seedAccess(other, "partner")).rejects.toThrow(/CHECK/);
  });

  it("keeps the one index and declares no trigger on identity_access", async () => {
    const objects = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE tbl_name = 'identity_access' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all<{ name: string; type: string }>();
    expect(objects.results).toEqual([{ name: "identity_access_type_status_idx", type: "index" }]);
    expect(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'identity_access_migration_%'")).toBe(0);
  });

  it("admits every affiliate mail kind in the delivery ledger, and not an unknown one", async () => {
    const kinds = [
      "affiliate_application_received",
      "affiliate_application_notice",
      "affiliate_application_denied",
      "affiliate_welcome",
      "affiliate_conversion",
      "affiliate_reversal",
      "affiliate_payout",
      "affiliate_payout_requested",
      "checkout_reminder",
    ];
    for (const kind of [...kinds, "affiliate_newsletter"]) {
      const message = await refusal(
        env.DB.prepare(
          `INSERT INTO email_deliveries (delivery_id, tenant_id, kind, recipient_hash, status, attempts,
             max_attempts, next_attempt_at, expires_at, created_at, updated_at, job_fingerprint)
           VALUES (?, ?, ?, ?, 'pending', 0, 8, 1, 100, 50, 60, ?)`,
        ).bind(crypto.randomUUID(), TENANT, kind, "a".repeat(64), "b".repeat(64)),
      );
      if (kind === "affiliate_newsletter") {
        expect(message, kind).toMatch(/CHECK/);
      } else {
        expect(message, kind).toBeNull();
      }
    }
  });
});

describe("0059 affiliates", () => {
  it("accepts a valid row, and an invited affiliate without terms (both NULL)", async () => {
    const other = await seedUser(`${nextId("x")}@affiliate.test`);
    expect(await refusal(insert("affiliates", affiliateRow({ user_id: other })))).toBeNull();
    const invited = await seedUser(`${nextId("x")}@affiliate.test`);
    expect(
      await refusal(insert("affiliates", affiliateRow({ terms_accepted_at: null, terms_version: null, user_id: invited }))),
    ).toBeNull();
  });

  it.each([
    ["a lower-case code", { code: "anna10" }],
    ["a code of 2", { code: "AB" }],
    ["a code of 21", { code: "A".repeat(21) }],
    ["a code with a space", { code: "ANNA 10" }],
    ["a code with an underscore", { code: "ANNA_10" }],
    ["a code with a letter outside A-Z", { code: "ÅSA10" }],
    ["an unknown status", { status: "deleted" }],
    ["a commission over 100 %", { commission_bp: 10001 }],
    ["a negative discount", { discount_bp: -1 }],
    ["an unknown language", { preferred_lang: "de" }],
    ["a version without its time", { terms_accepted_at: null }],
    ["a time without its version", { terms_version: null }],
    ["a lower-case currency", { currency: "sek" }],
    ["an unknown promotion method", { promotion_method: "billboard" }],
    ["socials that are not an object", { socials_json: "[1]" }],
    ["a time that is not ISO", { created_at: "2026-10-22 10:00:00" }],
  ])("refuses %s", async (_label, overrides) => {
    const other = await seedUser(`${nextId("r")}@affiliate.test`);
    expect(await refusal(insert("affiliates", affiliateRow({ user_id: other, ...overrides })))).toMatch(/CHECK/);
  });

  it("refuses a second affiliate row for one person in one shop, and a taken code", async () => {
    expect(await refusal(insert("affiliates", affiliateRow({ code: "SCHEMA2" })))).toMatch(/UNIQUE/);
    const other = await seedUser(`${nextId("u")}@affiliate.test`);
    expect(await refusal(insert("affiliates", affiliateRow({ code: "SCHEMA1", user_id: other })))).toMatch(/UNIQUE/);
    // The same code in another shop is another shop's.
    const third = await seedUser(`${nextId("u")}@affiliate.test`);
    expect(await refusal(insert("affiliates", affiliateRow({ code: "SCHEMA1", tenant_id: OTHER, user_id: third })))).toBeNull();
  });

  it("refuses a code a Rabattkod of the shop already has (insert and rename), never another shop's", async () => {
    await seedCode({ code: "SOMMAR20", tenantId: TENANT });
    const other = await seedUser(`${nextId("c")}@affiliate.test`);
    expect(await refusal(insert("affiliates", affiliateRow({ code: "SOMMAR20", user_id: other })))).toMatch(
      /affiliate code collides with a discount code/,
    );
    expect(
      await refusal(env.DB.prepare("UPDATE affiliates SET code = 'SOMMAR20' WHERE affiliate_id = ?").bind(affiliateId)),
    ).toMatch(/affiliate code collides with a discount code/);
    // An inactive Rabattkod still holds its name.
    await seedCode({ active: false, code: "VINTER", tenantId: TENANT });
    expect(
      await refusal(env.DB.prepare("UPDATE affiliates SET code = 'VINTER' WHERE affiliate_id = ?").bind(affiliateId)),
    ).toMatch(/collides/);
    // Another shop's Rabattkod is not this shop's.
    await seedCode({ code: "OTHERSHOP", tenantId: OTHER });
    const third = await seedUser(`${nextId("c")}@affiliate.test`);
    expect(await refusal(insert("affiliates", affiliateRow({ code: "OTHERSHOP", user_id: third })))).toBeNull();
  });

  it("refuses a Rabattkod an affiliate of the shop already has (insert and rename), inactive affiliates too", async () => {
    await expect(seedCode({ code: "SCHEMA1", tenantId: TENANT })).rejects.toThrow(
      /discount code collides with an affiliate code/,
    );
    const codeId = await seedCode({ code: "FREECODE", tenantId: TENANT });
    expect(
      await refusal(env.DB.prepare("UPDATE discount_codes SET code = 'SCHEMA1' WHERE discount_code_id = ?").bind(codeId)),
    ).toMatch(/discount code collides with an affiliate code/);
    const inactiveUser = await seedUser(`${nextId("i")}@affiliate.test`);
    expect(await refusal(insert("affiliates", affiliateRow({ code: "SLEEPY", status: "inactive", user_id: inactiveUser })))).toBeNull();
    await expect(seedCode({ code: "SLEEPY", tenantId: TENANT })).rejects.toThrow(/collides/);
    // The other shop's affiliate code is free here.
    await expect(seedCode({ code: "OTHERAFF", tenantId: TENANT })).resolves.toBeTypeOf("string");
  });

  it("is never deleted; its tenant, person, currency and creation never change", async () => {
    expect(await refusal(env.DB.prepare("DELETE FROM affiliates WHERE affiliate_id = ?").bind(affiliateId))).toMatch(
      /never deleted/,
    );
    expect(
      await refusal(env.DB.prepare("UPDATE affiliates SET tenant_id = ? WHERE affiliate_id = ?").bind(OTHER, affiliateId)),
    ).toMatch(/immutable/);
    const other = await seedUser(`${nextId("p")}@affiliate.test`);
    for (const [column, value] of [
      ["user_id", other],
      ["currency", "EUR"],
      ["created_at", "2026-10-21T10:00:00.000Z"],
      ["created_by", "someone-else"],
    ] as const) {
      expect(
        await refusal(env.DB.prepare(`UPDATE affiliates SET ${column} = ? WHERE affiliate_id = ?`).bind(value, affiliateId)),
        column,
      ).toMatch(/affiliate identity is immutable/);
    }
    // What the program changes: status, rates, code, contact.
    expect(
      await refusal(
        env.DB.prepare(
          "UPDATE affiliates SET status = 'suspended', commission_bp = 2000, code = 'SCHEMA9', city = 'Lund' WHERE affiliate_id = ?",
        ).bind(affiliateId),
      ),
    ).toBeNull();
    await env.DB.prepare("UPDATE affiliates SET status = 'active', commission_bp = 1500, code = 'SCHEMA1' WHERE affiliate_id = ?")
      .bind(affiliateId)
      .run();
  });
});

function applicationRow(overrides: Row = {}): Row {
  return {
    application_id: crypto.randomUUID(),
    created_at: T0,
    email: `${nextId("app")}@applicant.test`,
    name: "Bo",
    preferred_lang: "sv",
    promotion_method: "instagram",
    status: "pending",
    tenant_id: TENANT,
    terms_accepted_at: T0,
    terms_version: "2026-10-22",
    updated_at: T0,
    ...overrides,
  };
}

describe("0059 affiliate_applications", () => {
  it("is born pending, with no decision", async () => {
    expect(await refusal(insert("affiliate_applications", applicationRow()))).toBeNull();
    expect(await refusal(insert("affiliate_applications", applicationRow({ status: "approved", affiliate_id: "x", decided_at: T0, decided_by: "u", decision_id: "d" })))).toMatch(
      /born pending/,
    );
  });

  it.each([
    ["an upper-case address", { email: "Bo@Applicant.test" }],
    ["no promotion method", { promotion_method: null }],
    ["a message over 2 000", { message: "x".repeat(2001) }],
    ["a decision time on a pending row", { decided_at: T0, decided_by: "u", decision_id: "d" }],
  ])("refuses %s", async (_label, overrides) => {
    expect(await refusal(insert("affiliate_applications", applicationRow(overrides)))).toMatch(/CHECK|NOT NULL/);
  });

  it("keeps one pending application per address and shop", async () => {
    const email = `${nextId("dup")}@applicant.test`;
    expect(await refusal(insert("affiliate_applications", applicationRow({ email })))).toBeNull();
    expect(await refusal(insert("affiliate_applications", applicationRow({ email })))).toMatch(/UNIQUE/);
    expect(await refusal(insert("affiliate_applications", applicationRow({ email, tenant_id: OTHER })))).toBeNull();
  });

  it("moves pending → approved (with its affiliate) or denied (with a reason), once; what was sent never changes", async () => {
    const approved = applicationRow();
    await insert("affiliate_applications", approved).run();
    const id = approved.application_id as string;
    // Approved without an affiliate, or denied without a reason: the row's own CHECKs.
    expect(
      await refusal(
        env.DB.prepare(
          "UPDATE affiliate_applications SET status = 'approved', decided_at = ?, decided_by = 'u', decision_id = 'd' WHERE application_id = ?",
        ).bind(T0, id),
      ),
    ).toMatch(/CHECK/);
    expect(
      await refusal(
        env.DB.prepare(
          "UPDATE affiliate_applications SET status = 'denied', decided_at = ?, decided_by = 'u', decision_id = 'd' WHERE application_id = ?",
        ).bind(T0, id),
      ),
    ).toMatch(/CHECK/);
    expect(
      await refusal(
        env.DB.prepare(
          "UPDATE affiliate_applications SET status = 'approved', decided_at = ?, decided_by = 'u', decision_id = 'd', affiliate_id = ? WHERE application_id = ?",
        ).bind(T0, affiliateId, id),
      ),
    ).toBeNull();
    // Final.
    expect(
      await refusal(
        env.DB.prepare(
          "UPDATE affiliate_applications SET status = 'denied', decision_reason = 'no', affiliate_id = NULL WHERE application_id = ?",
        ).bind(id),
      ),
    ).toMatch(/only moves from pending/);
    // What the applicant sent.
    const pending = applicationRow();
    await insert("affiliate_applications", pending).run();
    expect(
      await refusal(
        env.DB.prepare("UPDATE affiliate_applications SET email = 'other@applicant.test' WHERE application_id = ?").bind(
          pending.application_id,
        ),
      ),
    ).toMatch(/only moves from pending/);
  });

  it("deletes only a denied row (the retention), never a pending or an approved one", async () => {
    const pending = applicationRow();
    await insert("affiliate_applications", pending).run();
    expect(
      await refusal(env.DB.prepare("DELETE FROM affiliate_applications WHERE application_id = ?").bind(pending.application_id)),
    ).toMatch(/only a denied/);
    await env.DB.prepare(
      "UPDATE affiliate_applications SET status = 'denied', decided_at = ?, decided_by = 'u', decision_id = 'd', decision_reason = 'Nej' WHERE application_id = ?",
    )
      .bind(T0, pending.application_id)
      .run();
    expect(
      await refusal(env.DB.prepare("DELETE FROM affiliate_applications WHERE application_id = ?").bind(pending.application_id)),
    ).toBeNull();
  });
});

describe("0059 affiliate_terms_versions", () => {
  it("is seeded with the canonical template's hash (src/affiliate/terms.ts)", async () => {
    const row = await env.DB.prepare("SELECT version, published_at, text_sha256 FROM affiliate_terms_versions")
      .first<{ published_at: string; text_sha256: string; version: string }>();
    expect(row).toEqual({
      published_at: "2026-10-22T00:00:00.000Z",
      text_sha256: await affiliateTermsSha256(),
      version: AFFILIATE_TERMS_VERSION,
    });
  });

  it("is append-only", async () => {
    expect(await refusal(env.DB.prepare("UPDATE affiliate_terms_versions SET text_sha256 = ?").bind("c".repeat(64)))).toMatch(
      /append-only/,
    );
    expect(await refusal(env.DB.prepare("DELETE FROM affiliate_terms_versions"))).toMatch(/append-only/);
  });
});

describe("0059 affiliate_click_days", () => {
  it("counts per affiliate and day of its own shop only", async () => {
    expect(
      await refusal(insert("affiliate_click_days", { affiliate_id: affiliateId, count: 1, day: "2026-10-22", tenant_id: TENANT })),
    ).toBeNull();
    expect(
      await refusal(insert("affiliate_click_days", { affiliate_id: otherAffiliateId, count: 1, day: "2026-10-22", tenant_id: TENANT })),
    ).toMatch(/must match its affiliate/);
    expect(
      await refusal(insert("affiliate_click_days", { affiliate_id: affiliateId, count: 1, day: "2026-13-01", tenant_id: TENANT })),
    ).toMatch(/CHECK/);
    expect(
      await refusal(insert("affiliate_click_days", { affiliate_id: affiliateId, count: 0, day: "2026-10-23", tenant_id: TENANT })),
    ).toMatch(/CHECK/);
  });
});

async function seedOrder(tenantId: string): Promise<string> {
  const checkoutId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const now = Date.now();
  const intent = `pi_schema_${orderId.replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO checkouts (checkout_id, tenant_id, status, customer_email, currency, delivery_method,
         shipping_country, subtotal_minor, shipping_minor, vat_minor, vat_rate_bp, discount_minor, total_minor,
         payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, 'completed', 'b@buyer.test', 'SEK', 'pickup', NULL, 10000, 0, 2000, 2500, 0, 10000, ?, ?, ?, ?, ?)`,
    ).bind(checkoutId, tenantId, intent, `h-${checkoutId}`, now + 86_400_000, now, now),
    env.DB.prepare(
      `INSERT INTO orders (order_id, tenant_id, checkout_id, payment_intent_id, order_number, status,
         customer_email, currency, delivery_method, shipping_country, subtotal_minor, shipping_minor, vat_minor,
         vat_rate_bp, discount_minor, total_minor, captured_minor, charged_minor, refunded_total_minor,
         stripe_event_id, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'paid', 'b@buyer.test', 'SEK', 'pickup', NULL, 10000, 0, 2000, 2500, 0, 10000,
         10000, 10000, 0, 'evt_schema', ?, ?, ?)`,
    ).bind(orderId, tenantId, checkoutId, intent, `S-${orderId.slice(0, 8)}`, now, now, now),
  ]);
  return orderId;
}

function ledgerRow(overrides: Row = {}): Row {
  return {
    affiliate_id: affiliateId,
    amount_minor: 100,
    available_at: null,
    created_at: T0,
    created_by: "system",
    currency: "SEK",
    entry_id: crypto.randomUUID(),
    formula_version: null,
    kind: "adjustment",
    order_id: null,
    reason: "Rättelse",
    ref: crypto.randomUUID(),
    tenant_id: TENANT,
    ...overrides,
  };
}

describe("0059 affiliate_ledger", () => {
  let orderId = "";
  let freshOrderId = "";
  beforeAll(async () => {
    orderId = await seedOrder(TENANT);
    // An order with no accrual yet, so a refused accrual is refused by its
    // CHECK and not by the one-row-per-(kind, ref) guard.
    freshOrderId = await seedOrder(TENANT);
  });

  it("states each kind's sign and shape", async () => {
    const accrual = { available_at: T0, formula_version: 1, kind: "accrual", order_id: orderId, reason: null };
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ ...accrual, ref: orderId })))).toBeNull();
    for (const [label, overrides] of [
      ["an accrual of 0", { ...accrual, amount_minor: 0, order_id: freshOrderId, ref: freshOrderId }],
      ["an accrual whose ref is not its order", { ...accrual, order_id: freshOrderId, ref: "x" }],
      ["an accrual without formula", { ...accrual, formula_version: null, order_id: freshOrderId, ref: freshOrderId }],
      ["a reversal of 0", { amount_minor: 0, kind: "reversal", order_id: orderId, reason: null }],
      ["a reversal without an order", { amount_minor: -5, kind: "reversal", reason: null }],
      ["a positive payout", { amount_minor: 5, kind: "payout" }],
      ["a negative payout void", { amount_minor: -5, kind: "payout_void" }],
      ["an adjustment without a reason", { amount_minor: 5, reason: null }],
      ["an adjustment of 0", { amount_minor: 0 }],
      ["an unknown kind", { kind: "bonus" }],
    ] as const) {
      // A payout's sign is refused by its CHECK or, first, by the trigger
      // that ties the row to its payout (no payout has a negative amount).
      expect(await refusal(insert("affiliate_ledger", ledgerRow(overrides as Row))), label).toMatch(
        label.includes("payout") ? /CHECK|must match its payout/ : /CHECK/,
      );
    }
    // A reversal of either sign (R2-1).
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: -40, kind: "reversal", order_id: orderId, reason: null })))).toBeNull();
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: 40, kind: "reversal", order_id: orderId, reason: null })))).toBeNull();
  });

  it("is append-only: no UPDATE, no DELETE, no REPLACE, no second row per (kind, ref)", async () => {
    const row = ledgerRow();
    await insert("affiliate_ledger", row).run();
    expect(await refusal(env.DB.prepare("UPDATE affiliate_ledger SET amount_minor = 1 WHERE entry_id = ?").bind(row.entry_id))).toMatch(
      /append-only/,
    );
    expect(await refusal(env.DB.prepare("DELETE FROM affiliate_ledger WHERE entry_id = ?").bind(row.entry_id))).toMatch(
      /append-only/,
    );
    expect(await refusal(insert("affiliate_ledger", { ...row, amount_minor: 999 }, "INSERT OR REPLACE"))).toMatch(/append-only/);
    expect(
      await refusal(insert("affiliate_ledger", { ...row, amount_minor: 999, entry_id: crypto.randomUUID() }, "INSERT OR REPLACE")),
    ).toMatch(/append-only/);
    const stored = await env.DB.prepare("SELECT amount_minor FROM affiliate_ledger WHERE entry_id = ?")
      .bind(row.entry_id)
      .first<{ amount_minor: number }>();
    expect(stored?.amount_minor).toBe(100);
  });

  it("belongs to its affiliate's and its order's tenant", async () => {
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ affiliate_id: otherAffiliateId })))).toMatch(
      /must match its affiliate/,
    );
    const foreignOrder = await seedOrder(OTHER);
    expect(
      await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: -1, kind: "reversal", order_id: foreignOrder, reason: null }))),
    ).toMatch(/must match its affiliate and order/);
  });

  it("writes a payout row only as its payout's own amount, a void only for a void payout", async () => {
    const payoutId = crypto.randomUUID();
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: -500, kind: "payout", reason: null, ref: payoutId })))).toMatch(
      /must match its payout/,
    );
    await insert("affiliate_payouts", payoutRow({ amount_minor: 500, payout_id: payoutId })).run();
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: -400, kind: "payout", reason: null, ref: payoutId })))).toMatch(
      /must match its payout/,
    );
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: -500, kind: "payout", reason: null, ref: payoutId })))).toBeNull();
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: 500, kind: "payout_void", reason: null, ref: payoutId })))).toMatch(
      /must match its payout/,
    );
    await env.DB.prepare(
      "UPDATE affiliate_payouts SET status = 'void', voided_at = ?, voided_by = 'u', void_reason = 'Fel' WHERE payout_id = ?",
    )
      .bind(T0, payoutId)
      .run();
    expect(await refusal(insert("affiliate_ledger", ledgerRow({ amount_minor: 500, kind: "payout_void", reason: null, ref: payoutId })))).toBeNull();
  });
});

function payoutRow(overrides: Row = {}): Row {
  return {
    affiliate_id: affiliateId,
    amount_minor: 1000,
    created_at: T0,
    currency: "SEK",
    payout_id: crypto.randomUUID(),
    rail: "manual",
    requested_at: T0,
    requested_by: "u",
    status: "requested",
    tenant_id: TENANT,
    updated_at: T0,
    ...overrides,
  };
}

describe("0059 affiliate_payouts", () => {
  it("is born requested, for an affiliate of its tenant, with a positive amount", async () => {
    expect(await refusal(insert("affiliate_payouts", payoutRow({ paid_at: T0, paid_by: "u", status: "paid" })))).toMatch(/born requested/);
    expect(await refusal(insert("affiliate_payouts", payoutRow({ affiliate_id: otherAffiliateId })))).toMatch(/born requested/);
    expect(await refusal(insert("affiliate_payouts", payoutRow({ amount_minor: 0 })))).toMatch(/CHECK/);
    expect(await refusal(insert("affiliate_payouts", payoutRow({ rail: "swish" })))).toMatch(/CHECK/);
  });

  it("keeps one open request per affiliate", async () => {
    const first = await seedAffiliate({ code: nextId("P").replaceAll("-", "").slice(0, 12).toUpperCase(), tenantId: TENANT });
    expect(await refusal(insert("affiliate_payouts", payoutRow({ affiliate_id: first.affiliateId })))).toBeNull();
    expect(await refusal(insert("affiliate_payouts", payoutRow({ affiliate_id: first.affiliateId })))).toMatch(/UNIQUE/);
  });

  it("moves requested → paid | void with its evidence, final after that; what was requested never changes", async () => {
    const owner = await seedAffiliate({ code: nextId("Q").replaceAll("-", "").slice(0, 12).toUpperCase(), tenantId: TENANT });
    const row = payoutRow({ affiliate_id: owner.affiliateId });
    await insert("affiliate_payouts", row).run();
    const id = row.payout_id;
    expect(await refusal(env.DB.prepare("UPDATE affiliate_payouts SET status = 'paid' WHERE payout_id = ?").bind(id))).toMatch(/CHECK/);
    expect(await refusal(env.DB.prepare("UPDATE affiliate_payouts SET amount_minor = 5 WHERE payout_id = ?").bind(id))).toMatch(
      /only moves from requested/,
    );
    expect(
      await refusal(env.DB.prepare("UPDATE affiliate_payouts SET status = 'paid', paid_at = ?, paid_by = 'u' WHERE payout_id = ?").bind(T0, id)),
    ).toBeNull();
    expect(
      await refusal(
        env.DB.prepare("UPDATE affiliate_payouts SET status = 'void', voided_at = ?, voided_by = 'u', void_reason = 'x' WHERE payout_id = ?").bind(
          T0,
          id,
        ),
      ),
    ).toMatch(/only moves from requested/);
    expect(await refusal(env.DB.prepare("DELETE FROM affiliate_payouts WHERE payout_id = ?").bind(id))).toMatch(/never deleted/);
  });
});

describe("0059 affiliate_invoice_objects", () => {
  async function seedObject(tenantId: string, kind: string): Promise<string> {
    const objectId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO stored_objects (object_id, tenant_id, bucket, object_key, kind, content_type, status, immutable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'application/pdf', 'pending', 0, ?, ?)`,
    )
      .bind(objectId, tenantId, kind === "document" ? "private" : "public", `shops/${tenantId}/${kind}/${objectId}/v1/f`, kind, now, now)
      .run();
    return objectId;
  }

  it("lists a document of the affiliate's own tenant only, append-only", async () => {
    const doc = await seedObject(TENANT, "document");
    expect(await refusal(insert("affiliate_invoice_objects", { affiliate_id: affiliateId, created_at: T0, object_id: doc, tenant_id: TENANT }))).toBeNull();
    expect(await refusal(env.DB.prepare("DELETE FROM affiliate_invoice_objects WHERE object_id = ?").bind(doc))).toMatch(/append-only/);
    const foreign = await seedObject(OTHER, "document");
    expect(
      await refusal(insert("affiliate_invoice_objects", { affiliate_id: affiliateId, created_at: T0, object_id: foreign, tenant_id: TENANT })),
    ).toMatch(/document of the affiliate/);
    const media = await seedObject(TENANT, "product_media");
    expect(
      await refusal(insert("affiliate_invoice_objects", { affiliate_id: affiliateId, created_at: T0, object_id: media, tenant_id: TENANT })),
    ).toMatch(/document of the affiliate/);
    const other = await seedObject(TENANT, "document");
    expect(
      await refusal(insert("affiliate_invoice_objects", { affiliate_id: otherAffiliateId, created_at: T0, object_id: other, tenant_id: TENANT })),
    ).toMatch(/document of the affiliate/);
  });
});

describe("0059 checkouts and orders: the frozen affiliate facts", () => {
  function checkoutRow(overrides: Row = {}): Row {
    const id = crypto.randomUUID();
    return {
      checkout_id: id,
      created_at: Date.now(),
      currency: "SEK",
      customer_email: "b@buyer.test",
      delivery_method: "pickup",
      discount_minor: 1000,
      expires_at: Date.now() + 86_400_000,
      idempotency_key_hash: `h-${id}`,
      shipping_minor: 0,
      status: "open",
      subtotal_minor: 10000,
      tenant_id: TENANT,
      total_minor: 9000,
      updated_at: Date.now(),
      vat_minor: 1800,
      vat_rate_bp: 2500,
      ...overrides,
    };
  }
  const affiliateFacts = (): Row => ({
    affiliate_attribution: "link",
    affiliate_code: "SCHEMA1",
    affiliate_commission_bp: 1500,
    affiliate_discount_bp: 1000,
    affiliate_id: affiliateId,
    affiliate_self_referral: 0,
    discount_authority: "affiliate",
    discount_code_id: affiliateId,
  });

  it("accepts a campaign row, an affiliate row, an affiliate row worth 0, and a row without a discount", async () => {
    expect(await refusal(insert("checkouts", checkoutRow({ discount_authority: "campaign", discount_code_id: "dc-1" })))).toBeNull();
    expect(await refusal(insert("checkouts", checkoutRow(affiliateFacts())))).toBeNull();
    expect(
      await refusal(insert("checkouts", checkoutRow({ ...affiliateFacts(), affiliate_discount_bp: 0, discount_minor: 0, total_minor: 10000, vat_minor: 2000 }))),
    ).toBeNull();
    expect(await refusal(insert("checkouts", checkoutRow({ discount_minor: 0, total_minor: 10000, vat_minor: 2000 })))).toBeNull();
    // A legacy campaign id: an id with NO authority, as the pre-0059 Worker
    // writes it in the deploy window (round 1, MUST-1).
    expect(await refusal(insert("checkouts", checkoutRow({ discount_authority: null, discount_code_id: "dc-1" })))).toBeNull();
  });

  it.each([
    ["an authority without an id", { discount_authority: "campaign", discount_code_id: null, discount_minor: 0, total_minor: 10000 }, /incoherent/],
    ["an affiliate authority whose id is not the affiliate's", { ...{ discount_code_id: "dc-1" } }, /incoherent/],
    ["an unknown authority", { discount_authority: "gift", discount_code_id: "dc-1" }, /CHECK/],
  ])("refuses %s", async (_label, overrides, pattern) => {
    const base = _label.startsWith("an affiliate authority") ? affiliateFacts() : {};
    expect(await refusal(insert("checkouts", checkoutRow({ ...base, ...overrides })))).toMatch(pattern);
  });

  it("refuses affiliate facts without the affiliate authority, and the authority without its facts", async () => {
    expect(
      await refusal(
        insert("checkouts", checkoutRow({ affiliate_code: "SCHEMA1", discount_authority: "campaign", discount_code_id: "dc-1" })),
      ),
    ).toMatch(/CHECK/);
    for (const column of [
      "affiliate_attribution",
      "affiliate_code",
      "affiliate_commission_bp",
      "affiliate_discount_bp",
      "affiliate_self_referral",
    ]) {
      expect(await refusal(insert("checkouts", checkoutRow({ ...affiliateFacts(), [column]: null }))), column).toMatch(/CHECK/);
    }
  });

  it("freezes the seven facts on the checkout and on the order from the moment they are written", async () => {
    const row = checkoutRow(affiliateFacts());
    await insert("checkouts", row).run();
    for (const [column, value] of [
      ["discount_authority", "campaign"],
      ["affiliate_code", "OTHER1"],
      ["affiliate_attribution", "code"],
      ["affiliate_commission_bp", 2000],
      ["affiliate_discount_bp", 500],
      ["affiliate_self_referral", 1],
    ] as const) {
      expect(
        await refusal(env.DB.prepare(`UPDATE checkouts SET ${column} = ? WHERE checkout_id = ?`).bind(value, row.checkout_id)),
        column,
      ).toMatch(/frozen|incoherent|CHECK/);
    }
    // Every other column the lifecycle moves still moves.
    expect(
      await refusal(env.DB.prepare("UPDATE checkouts SET status = 'expired', updated_at = updated_at + 1 WHERE checkout_id = ?").bind(row.checkout_id)),
    ).toBeNull();

    const orderId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO orders (order_id, tenant_id, checkout_id, payment_intent_id, order_number, status,
         customer_email, currency, delivery_method, shipping_country, subtotal_minor, shipping_minor, vat_minor,
         vat_rate_bp, discount_minor, discount_code_id, total_minor, captured_minor, charged_minor, refunded_total_minor,
         stripe_event_id, paid_at, created_at, updated_at, discount_authority, affiliate_id, affiliate_code,
         affiliate_attribution, affiliate_commission_bp, affiliate_discount_bp, affiliate_self_referral)
       VALUES (?, ?, ?, ?, ?, 'paid', 'b@buyer.test', 'SEK', 'pickup', NULL, 10000, 0, 1800, 2500, 1000, ?, 9000,
         9000, 9000, 0, 'evt_x', ?, ?, ?, 'affiliate', ?, 'SCHEMA1', 'link', 1500, 1000, 0)`,
    )
      .bind(orderId, TENANT, row.checkout_id, `pi_${orderId.replaceAll("-", "")}`, `F-${orderId.slice(0, 6)}`, affiliateId, now, now, now, affiliateId)
      .run();
    expect(
      await refusal(env.DB.prepare("UPDATE orders SET affiliate_commission_bp = 3000 WHERE order_id = ?").bind(orderId)),
    ).toMatch(/order affiliate facts are immutable/);
    expect(await refusal(env.DB.prepare("UPDATE orders SET affiliate_self_referral = 1 WHERE order_id = ?").bind(orderId))).toMatch(
      /immutable/,
    );
    expect(await refusal(env.DB.prepare("UPDATE orders SET status = 'processing', updated_at = updated_at + 1 WHERE order_id = ?").bind(orderId))).toBeNull();
    expect(iso(now)).toBeTypeOf("string");
  });
});
