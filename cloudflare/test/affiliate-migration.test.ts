import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { count, refusal, seedUser } from "./affiliate-fixtures";
import { payCheckout } from "./money-fixtures";
import { seedTenant } from "./dispatch-fixtures";

/**
 * CP13 — 0058 and 0059 applied to a database that ALREADY HOLDS ROWS, as
 * wrangler applies them to staging and production (design §2.3 R2-2, §1.1).
 * Each replay first puts the table back into the shape the migration meets on
 * a deployed database, writes rows of every relevant kind into it, then runs
 * the migration's OWN statements (env.TEST_MIGRATIONS) over them.
 *
 * Its own file: the replays rebuild tables, which must not disturb another
 * suite's rows (each file has its own database).
 */

const TENANT = "aff-mig";

function migration(name: string): { queries: string[] } {
  const found = env.TEST_MIGRATIONS.find((m) => m.name === name);
  if (found === undefined) {
    throw new Error(`no migration ${name}`);
  }
  return found;
}

const exec = (queries: string[]) => env.DB.batch(queries.map((q) => env.DB.prepare(q)));

beforeAll(async () => {
  await seedTenant(TENANT);
});

describe("0058 on a database holding identities", () => {
  it("keeps every identity_access row, column for column, and its index; admits 'affiliate' after", async () => {
    // Nothing after 0033 touched identity_access before 0058.
    for (const m of env.TEST_MIGRATIONS.filter((m) => m.name.slice(0, 4) > "0033" && m.name.slice(0, 4) < "0058")) {
      expect(m.queries.some((q) => q.includes("identity_access")), m.name).toBe(false);
    }

    // 1. Back to the 0002 + 0033 shape (the CHECK without 'affiliate').
    await exec([
      "DROP TABLE identity_access",
      `CREATE TABLE identity_access (
        user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
        account_type TEXT NOT NULL CHECK (
          account_type IN ('ordinary', 'tenant_admin', 'platform_admin', 'print_operator')
        ),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        status_change_id TEXT
      )`,
      "CREATE INDEX identity_access_type_status_idx ON identity_access(account_type, status)",
    ]);
    const rows: Array<[string, string, string | null]> = [
      ["ordinary", "active", null],
      ["tenant_admin", "active", "change-1"],
      ["tenant_admin", "suspended", "change-2"],
      ["platform_admin", "active", null],
      ["print_operator", "revoked", "change-3"],
    ];
    const ids: string[] = [];
    for (const [type, status, stamp] of rows) {
      const id = await seedUser(`mig-${type}-${status}-${ids.length}@identity.test`);
      ids.push(id);
      await env.DB.prepare(
        `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at, status_change_id)
         VALUES (?, ?, ?, 100, 200, ?)`,
      )
        .bind(id, type, status, stamp)
        .run();
    }
    const probe = await seedUser("mig-probe@identity.test");
    // The old shape refuses the new kind: this really is the pre-0058 table.
    expect(
      await refusal(
        env.DB.prepare(
          "INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at) VALUES (?, 'affiliate', 'active', 1, 1)",
        ).bind(probe),
      ),
    ).toMatch(/CHECK/);
    const read = () =>
      env.DB.prepare(`SELECT * FROM identity_access WHERE user_id IN (${ids.map(() => "?").join(", ")}) ORDER BY user_id`)
        .bind(...ids)
        .all();
    const before = (await read()).results;
    expect(before).toHaveLength(rows.length);

    // 2. 0058's identity_access statements, as wrangler applies them.
    await exec(migration("0058_affiliate_identity.sql").queries.filter((q) => q.includes("identity_access")));

    expect((await read()).results).toEqual(before);
    expect(
      await refusal(
        env.DB.prepare(
          "INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at) VALUES (?, 'affiliate', 'active', 1, 1)",
        ).bind(probe),
      ),
    ).toBeNull();
    const objects = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE tbl_name = 'identity_access' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'",
    ).all<{ name: string }>();
    expect(objects.results.map((o) => o.name)).toEqual(["identity_access_type_status_idx"]);
    expect(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'identity_access_migration_%'")).toBe(0);
  });
});

describe("0058 on a database holding email deliveries (Codex round 4)", () => {
  it("keeps every email_deliveries row column for column (fingerprint, lease, terminal states), its triggers and indexes; admits the affiliate kinds after", async () => {
    const touches = (q: string) => q.includes("email_deliveries");
    // 1. Back to 0056's shape (the kind list without the affiliate kinds):
    //    0056's own §5 statements, which copy the table through.
    await exec(migration("0056_checkout_reminders.sql").queries.filter(touches));
    const hash = (c: string) => c.repeat(64);
    const t0 = 1_787_000_000_000;
    const rows: Array<Record<string, unknown>> = [
      // pending, never tried
      { attempts: 0, delivery_id: "mig-ed-pending", kind: "order_confirmation", lease_token: null, lease_until: null, last_error_code: null, provider_message_id: null, resolved_at: null, status: "pending" },
      // processing: a live lease
      { attempts: 1, delivery_id: "mig-ed-processing", kind: "password_reset", lease_token: "lease-1", lease_until: t0 + 60_000, last_error_code: null, provider_message_id: null, resolved_at: null, status: "processing" },
      // terminal: sent, with the provider's id
      { attempts: 1, delivery_id: "mig-ed-sent", kind: "checkout_reminder", lease_token: null, lease_until: null, last_error_code: null, provider_message_id: "re_mig_1", resolved_at: t0 + 1_000, status: "sent" },
      // terminal: failed after retries, with its error
      { attempts: 8, delivery_id: "mig-ed-failed", kind: "refund_notice", lease_token: null, lease_until: null, last_error_code: "E_PROVIDER", provider_message_id: null, resolved_at: t0 + 2_000, status: "failed" },
      // terminal: expired, platform-wide (no tenant)
      { attempts: 2, delivery_id: "mig-ed-expired", kind: "alert_digest", lease_token: null, lease_until: null, last_error_code: "E_EXPIRED", provider_message_id: null, resolved_at: t0 + 3_000, status: "expired", tenant_id: null },
    ];
    for (const [index, row] of rows.entries()) {
      await env.DB.prepare(
        `INSERT INTO email_deliveries (
           delivery_id, tenant_id, kind, recipient_hash, status, attempts, max_attempts, next_attempt_at,
           lease_token, lease_until, provider_message_id, expires_at, last_error_code, resolved_at,
           created_at, updated_at, job_fingerprint
         ) VALUES (?, ?, ?, ?, ?, ?, 8, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          row.delivery_id,
          "tenant_id" in row ? row.tenant_id : TENANT,
          row.kind,
          hash(String(index)),
          row.status,
          row.attempts,
          t0 + index,
          row.lease_token,
          row.lease_until,
          row.provider_message_id,
          t0 + 86_400_000,
          row.last_error_code,
          row.resolved_at,
          t0,
          t0 + 5_000,
          hash("f"),
        )
        .run();
    }
    // The old shape refuses an affiliate kind: this really is the pre-0058 table.
    const affiliateKind = () =>
      env.DB.prepare(
        `INSERT INTO email_deliveries (delivery_id, tenant_id, kind, recipient_hash, next_attempt_at, expires_at,
           created_at, updated_at, job_fingerprint)
         VALUES ('mig-ed-affiliate', ?, 'affiliate_conversion', ?, 1, 2, 1, 1, ?)`,
      ).bind(TENANT, hash("a"), hash("b"));
    expect(await refusal(affiliateKind())).toMatch(/CHECK/);

    const read = () => env.DB.prepare("SELECT * FROM email_deliveries WHERE delivery_id LIKE 'mig-ed-%' ORDER BY delivery_id").all();
    const objects = () =>
      env.DB.prepare(
        "SELECT type, name FROM sqlite_master WHERE tbl_name = 'email_deliveries' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all();
    const before = (await read()).results;
    expect(before).toHaveLength(rows.length);
    const objectsBefore = (await objects()).results;

    // 2. 0058's email_deliveries statements, as wrangler applies them.
    await exec(migration("0058_affiliate_identity.sql").queries.filter(touches));

    expect((await read()).results).toEqual(before);
    expect((await objects()).results).toEqual(objectsBefore);
    expect(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'email_deliveries_migration_%'")).toBe(0);
    expect(await refusal(affiliateKind())).toBeNull();
    // The provider id is still unique, the fingerprint still required.
    expect(
      await refusal(
        env.DB.prepare("UPDATE email_deliveries SET provider_message_id = 're_mig_1' WHERE delivery_id = 'mig-ed-pending'"),
      ),
    ).toMatch(/UNIQUE/);
  });
});

describe("0059 on a database holding a campaign-discounted checkout and order", () => {
  const OWN = /\b(ALTER TABLE|UPDATE|ON) (checkouts|orders)\b/;
  const COLUMNS = [
    "affiliate_self_referral",
    "affiliate_discount_bp",
    "affiliate_commission_bp",
    "affiliate_attribution",
    "affiliate_code",
    "affiliate_id",
    "discount_authority",
  ];

  async function backToPre0059(): Promise<void> {
    const statements = [
      "DROP TRIGGER checkouts_discount_authority_coherent_insert",
      "DROP TRIGGER checkouts_discount_authority_coherent_update",
      "DROP TRIGGER orders_discount_authority_coherent_insert",
      "DROP TRIGGER orders_discount_authority_coherent_update",
      "DROP TRIGGER checkouts_affiliate_facts_frozen",
      "DROP TRIGGER orders_affiliate_facts_frozen",
      "DROP INDEX orders_tenant_affiliate_idx",
    ];
    for (const table of ["checkouts", "orders"]) {
      for (const column of COLUMNS) {
        statements.push(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }
  }

  async function seedPre0059(codeId: string | null): Promise<{ checkoutId: string; intentId: string; orderId: string | null }> {
    const checkoutId = crypto.randomUUID();
    const intentId = `pi_mig_${checkoutId.replaceAll("-", "")}`;
    const productId = `prod-${checkoutId}`;
    const now = Date.now();
    const discount = codeId === null ? 0 : 1000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO products (product_id, tenant_id, status, sku, name, b2c_price_minor, currency, created_at, updated_at)
         VALUES (?, ?, 'active', ?, 'Mugg', 10000, 'SEK', ?, ?)`,
      ).bind(productId, TENANT, `SKU-${productId}`, now, now),
      env.DB.prepare(
        `INSERT INTO checkouts (checkout_id, tenant_id, status, customer_email, currency, delivery_method,
           shipping_country, subtotal_minor, shipping_minor, vat_minor, vat_rate_bp, discount_minor, discount_code_id,
           total_minor, payment_intent_id, idempotency_key_hash, expires_at, created_at, updated_at)
         VALUES (?, ?, 'open', 'b@buyer.test', 'SEK', 'pickup', NULL, 10000, 0, 0, 2500, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(checkoutId, TENANT, discount, codeId, 10000 - discount, intentId, `h-${checkoutId}`, now + 86_400_000, now, now),
      env.DB.prepare(
        `INSERT INTO checkout_items (checkout_item_id, checkout_id, tenant_id, item_index, product_id, variant_id,
           sku, name, quantity, unit_price_minor, line_total_minor, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, NULL, ?, 'Mugg', 1, 10000, 10000, ?, ?)`,
      ).bind(`ci-${checkoutId}`, checkoutId, TENANT, productId, `SKU-${productId}`, now, now),
    ]);
    return { checkoutId, intentId, orderId: null };
  }

  it("backfills 'campaign' where an id is frozen, NULL elsewhere; the paid pre-deploy checkout still burns its use", async () => {
    // Nothing after 0059's columns exist is touched here but the columns themselves.
    await backToPre0059();
    const codeId = "dc-mig-campaign";
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO discount_codes (discount_code_id, tenant_id, code, active, type, value_minor, percent_bp,
         used_count, scope, created_at, updated_at)
       VALUES (?, ?, 'MIGRATE10', 1, 'fixed', 1000, NULL, 0, 'all', ?, ?)`,
    )
      .bind(codeId, TENANT, now, now)
      .run();

    // A campaign checkout ALREADY PAID (an order exists), one still OPEN (it
    // will pay after the deploy), and a checkout without a code.
    const paid = await seedPre0059(codeId);
    const paidOrderId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO orders (order_id, tenant_id, checkout_id, payment_intent_id, order_number, status,
         customer_email, currency, delivery_method, shipping_country, subtotal_minor, shipping_minor, vat_minor,
         vat_rate_bp, discount_minor, discount_code_id, total_minor, captured_minor, charged_minor,
         refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'MIG-1', 'paid', 'b@buyer.test', 'SEK', 'pickup', NULL, 10000, 0, 0, 2500, 1000, ?,
         9000, 9000, 9000, 0, 'evt_mig', ?, ?, ?)`,
    )
      .bind(paidOrderId, TENANT, paid.checkoutId, paid.intentId, codeId, now, now, now)
      .run();
    await env.DB.prepare("UPDATE checkouts SET status = 'completed' WHERE checkout_id = ?").bind(paid.checkoutId).run();
    const open = await seedPre0059(codeId);
    const plain = await seedPre0059(null);

    // 0059's statements on checkouts and orders, as wrangler applies them.
    const own = migration("0059_affiliate.sql").queries.filter((q) => OWN.test(q));
    expect(own.length).toBeGreaterThanOrEqual(2 + 2 + 12 + 6 + 1);
    await exec(own);

    const authority = async (table: string, column: string, id: string) =>
      (
        await env.DB.prepare(`SELECT discount_authority FROM ${table} WHERE ${column} = ?`)
          .bind(id)
          .first<{ discount_authority: string | null }>()
      )?.discount_authority;
    expect(await authority("checkouts", "checkout_id", paid.checkoutId)).toBe("campaign");
    expect(await authority("checkouts", "checkout_id", open.checkoutId)).toBe("campaign");
    expect(await authority("checkouts", "checkout_id", plain.checkoutId)).toBeNull();
    expect(await authority("orders", "order_id", paidOrderId)).toBe("campaign");

    // From here on the rule holds for new rows and the facts are frozen.
    expect(
      await refusal(env.DB.prepare("UPDATE checkouts SET discount_authority = 'affiliate' WHERE checkout_id = ?").bind(open.checkoutId)),
    ).toMatch(/incoherent|frozen|CHECK/);
    expect(
      await refusal(env.DB.prepare("UPDATE orders SET discount_authority = NULL WHERE order_id = ?").bind(paidOrderId)),
    ).toMatch(/incoherent|immutable/);

    // The open pre-deploy checkout pays AFTER the deploy: the webhook copies
    // 'campaign' and burns the use, as before (R2-2: the burn is gated on
    // IS NOT 'affiliate').
    const orderId = await payCheckout(
      { checkoutId: open.checkoutId, paymentIntentId: open.intentId, totalMinor: 9000 },
      TENANT,
    );
    expect(await authority("orders", "order_id", orderId)).toBe("campaign");
    const used = await env.DB.prepare("SELECT used_count FROM discount_codes WHERE discount_code_id = ?")
      .bind(codeId)
      .first<{ used_count: number }>();
    expect(used?.used_count).toBe(1);
  });

  it("the deploy window: the OLD Worker's checkout and order INSERTs (no authority column) succeed, and the burn fires", async () => {
    // The schema is 0059's here (the replay above re-applied it). The
    // pre-0059 Worker names discount_code_id but not discount_authority.
    const codeId = "dc-mig-window";
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO discount_codes (discount_code_id, tenant_id, code, active, type, value_minor, percent_bp,
         used_count, scope, created_at, updated_at)
       VALUES (?, ?, 'WINDOW10', 1, 'fixed', 1000, NULL, 0, 'all', ?, ?)`,
    )
      .bind(codeId, TENANT, now, now)
      .run();

    // Its checkout INSERT (seedPre0059 is that INSERT, column for column).
    const legacy = await seedPre0059(codeId);
    expect(
      await env.DB.prepare("SELECT discount_authority, discount_code_id FROM checkouts WHERE checkout_id = ?")
        .bind(legacy.checkoutId)
        .first(),
    ).toEqual({ discount_authority: null, discount_code_id: codeId });

    // Its webhook's order INSERT (no authority column).
    const other = await seedPre0059(codeId);
    const oldOrderId = crypto.randomUUID();
    expect(
      await refusal(
        env.DB.prepare(
          `INSERT INTO orders (order_id, tenant_id, checkout_id, payment_intent_id, order_number, status,
             customer_email, currency, delivery_method, shipping_country, subtotal_minor, shipping_minor, vat_minor,
             vat_rate_bp, discount_minor, discount_code_id, total_minor, captured_minor, charged_minor,
             refunded_total_minor, stripe_event_id, paid_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'MIG-W', 'paid', 'b@buyer.test', 'SEK', 'pickup', NULL, 10000, 0, 0, 2500, 1000, ?,
             9000, 9000, 9000, 0, 'evt_mig_w', ?, ?, ?)`,
        ).bind(oldOrderId, TENANT, other.checkoutId, other.intentId, codeId, now, now, now),
      ),
    ).toBeNull();

    // The NEW Worker pays the legacy checkout: the order copies the NULL
    // authority (a legacy campaign id) and the burn fires (IS NOT 'affiliate').
    const orderId = await payCheckout(
      { checkoutId: legacy.checkoutId, paymentIntentId: legacy.intentId, totalMinor: 9000 },
      TENANT,
    );
    expect(
      await env.DB.prepare("SELECT discount_authority, discount_code_id FROM orders WHERE order_id = ?").bind(orderId).first(),
    ).toEqual({ discount_authority: null, discount_code_id: codeId });
    const used = await env.DB.prepare("SELECT used_count FROM discount_codes WHERE discount_code_id = ?")
      .bind(codeId)
      .first<{ used_count: number }>();
    expect(used?.used_count).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_ledger WHERE order_id = ?", orderId)).toBe(0);
    // (Still refused — an authority without an id, an affiliate authority
    // whose id is not the affiliate's: affiliate-schema.test.ts.)
  });
});

describe("0060 on a database holding a page a shop already named 'affiliate' (round 3)", () => {
  it("does not fail, leaves the row as it is and editable; no new or renamed page can take the slug", async () => {
    const iso = new Date().toISOString();
    const page = (id: string, slug: string) =>
      env.DB.prepare(
        `INSERT INTO pages (page_id, tenant_id, slug, title_json, content_json, created_at, updated_at)
         VALUES (?, ?, ?, '{"sv-SE":"Rubrik"}', '{"sv-SE":"<p>x</p>"}', ?, ?)`,
      ).bind(id, TENANT, slug, iso, iso);

    // Back to 0042's triggers (the list without 'affiliate'), then the row.
    await exec(["DROP TRIGGER pages_reserved_slug_insert", "DROP TRIGGER pages_reserved_slug_update"]);
    await exec(migration("0042_pages.sql").queries.filter((q) => q.includes("pages_reserved_slug_")));
    expect(await refusal(page("legacy-affiliate", "affiliate"))).toBeNull();
    const before = await env.DB.prepare("SELECT * FROM pages WHERE page_id = 'legacy-affiliate'").first();

    // 0060, as wrangler applies it.
    await exec(migration("0060_reserved_slug_affiliate.sql").queries);
    expect(await env.DB.prepare("SELECT * FROM pages WHERE page_id = 'legacy-affiliate'").first()).toEqual(before);

    // Still editable, its slug unchanged (even when the UPDATE names it) …
    expect(
      await refusal(env.DB.prepare(`UPDATE pages SET title_json = '{"sv-SE":"Ny"}' WHERE page_id = 'legacy-affiliate'`)),
    ).toBeNull();
    expect(await refusal(env.DB.prepare("UPDATE pages SET slug = 'affiliate' WHERE page_id = 'legacy-affiliate'"))).toBeNull();
    // … and renamed away freely; it cannot come back, and nothing new takes it.
    expect(
      await refusal(env.DB.prepare("UPDATE pages SET slug = 'affiliate-gammal' WHERE page_id = 'legacy-affiliate'")),
    ).toBeNull();
    expect(await refusal(env.DB.prepare("UPDATE pages SET slug = 'affiliate' WHERE page_id = 'legacy-affiliate'"))).toMatch(
      /reserved by the storefront/,
    );
    expect(await refusal(page("new-affiliate", "affiliate"))).toMatch(/reserved by the storefront/);
    expect(await refusal(page("still-checkout", "checkout"))).toMatch(/reserved by the storefront/);
  });
});

