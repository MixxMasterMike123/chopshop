# CP8-DC: campaign discount codes ("Rabattkoder") on Cloudflare

Design only, on branch `cf-port` at HEAD `e162f2c4`. Nothing else in the tree was edited. No git write, no network request, no deploy, no test run. Another agent was building in `cloudflare/src`, `cloudflare/test` and `src/` at the same time (uncommitted CP6-PS4 work, `docs/cf-port/CP6_PS4_REPORT.md`). The line numbers below are those of HEAD as read on 2026-10-04; in `checkout.ts`, `app.ts` and `public-routes.ts` they have since moved by a few lines. Every claim about code cites the file and the lines I opened. Where I could not check something, the text says "not verified".

## Design (phase 1)

### 0. Read this first: most of the back end already exists

This is not a port from nothing. Checkpoints 15 to 25 of the first Cloudflare branch built the discount engine, and it came over unchanged into `cf-port` (`git log`: `83080edb`, `db66555a`). What exists today:

| Piece | Where | State |
|---|---|---|
| Table `discount_codes`, and `checkouts.discount_code_id` with its CHECK | `cloudflare/migrations/0010_discount_codes.sql` (whole file) | Built. Codes are per tenant, stored in upper case, unique per tenant (`:107-110`). |
| `orders.discount_minor`, `orders.discount_code_id`, their CHECKs and the money freeze | `0011_orders.sql:99-136`, `:157-172` | Built. |
| The discount math: normalise, shape, base, eligibility, amount, resolve | `cloudflare/src/commerce/discount-codes.ts:23-356` | Built. The affiliate seam is marked at `:314`. |
| The checkout applying a code | `cloudflare/src/commerce/checkout.ts:384-397` (parse), `:1169-1182` (resolve), `:1184-1192` (close the quote), `:1229-1266` (freeze), `:839-853` (replay) | Built. It does **not** check the feature flag (finding F1). |
| The use counted at payment ("the burn") | `cloudflare/src/commerce/webhook.ts:752-783` | Built. It counts one use per paid order and accepts going over the cap (`:764-771`). |
| Admin create, read one, edit | `cloudflare/src/commerce/admin-discount-codes.ts:291-808`; routes `cloudflare/src/app.ts:466-467`, `:1056-1119`, `:2595-2598` | Built. There is **no list route**, no feature check and no delete. |
| The discount on the buyer's receipt, the seller's order view and both mails | `receipts.ts:206-212,320`; `admin-orders.ts:99-105,257-263`; `email/order-emails.ts:654`; `email/auth-email-job.ts:704-705` | Built, as an amount. No code name. |
| Tests | `cloudflare/test/discount-codes.test.ts` (1175 lines), `admin-discount-codes.test.ts` (882 lines), webhook seeds (`webhook.test.ts:222-307`) | Built. |

What is **missing** is what this design adds:

- holding a use during checkout;
- the feature flag on the money path;
- the rule that keeps a discount from leaving the shop's payout below zero (POD) or the charge below Stripe's minimum;
- the storefront's preview route;
- the admin list route, plus three admin rules: a used code cannot be renamed, a fixed amount of 0 is refused, the admin routes follow the flag;
- the code's name in the order views;
- reversing D81 for this one feature;
- both frontends.

### 1. The old behaviour (Firebase), and what is ported, changed or dropped

#### 1.1 What the old code does

| Rule | Old behaviour | Evidence |
|---|---|---|
| Who creates codes | The shop's admin, client-side Firestore writes to `discountCodes`, stamped with `shopId`. | `src/pages/admin/AdminDiscountCodes.jsx:195-224` |
| The code string | Trimmed and upper-cased (`normalizeAffiliateCode`). Uniqueness per shop is a query before the write, which can race. | `AdminDiscountCodes.jsx:142,180-193`; `src/utils/affiliateCalculations.js:92-97` |
| Types | `percent`: 0 < value ≤ 100, fractions allowed (12.5). `fixed`: kronor, > 0. | `AdminDiscountCodes.jsx:147-155`, `:404-416` |
| Scope | `all` (the whole cart) or `products` (a list of product ids, at least one). The picker lists active products. | `AdminDiscountCodes.jsx:156-159`, `:74-86`, `:419-455` |
| Minimum order | Optional, floored to whole kronor, compared with the **full** subtotal, even for a products-scoped code. | `AdminDiscountCodes.jsx:165-169`; `functions/src/payment/createPaymentIntent.ts:292-295` |
| Validity window | Two `<input type="date">` fields, each saved as **local midnight at the start of that day**, compared inclusively (`now >= startsAt && now <= endsAt`). So a code with end date 31 October stops at 00:00 on 31 October: its last day is excluded. Re-opening the form shows the date through `toISOString` (UTC), one day earlier in Swedish time, so every edit-and-save moves the dates a day back. | `AdminDiscountCodes.jsx:170-175`, `:526-538`; `createPaymentIntent.ts:285-290` |
| Usage limit | Optional `maxUses ≥ 1`. Checked as `usedCount < maxUses` when the payment is created. `usedCount + 1` is written by the webhook **after** the order exists, as a separate best-effort write: a crash loses the count, and two buyers can both use the last use. | `AdminDiscountCodes.jsx:160-164`; `createPaymentIntent.ts:288-289`; `functions/src/payment/stripeWebhook.ts:658-676` |
| Active / delete | Active is a toggle. Delete is a hard `deleteDoc`. | `AdminDiscountCodes.jsx:235-258` |
| Feature gate | The server ignores the code unless the shop's `discountCodes` add-on is on (default on). Affiliate codes are tried first and win a collision. | `createPaymentIntent.ts:251-273`; `functions/src/affiliate/callable/validateDiscountCode.ts:41-75` |
| Discount math | Base = subtotal or the matching lines. `fixed`: `min(value, base)`. `percent`: `Math.ceil(base × value / 100)` on **kronor**, so it rounds up to whole kronor. Total = subtotal − discount + shipping. VAT is taken out of that total. Shipping is never discounted. | `createPaymentIntent.ts:297-316`, `:337-338` |
| The fee | Stripe Connect destination charge. The application fee = commission on the **discounted** gross (the charged amount) + the POD production withholding. A fee above the gross refuses the payment (409 `production-exceeds-gross`). | `createPaymentIntent.ts:745-771`, `:787-803` |
| What the order stores | Flat `discountAmount` (SEK), plus `discount: {source: 'campaign', code, codeId}`. The PaymentIntent metadata carries `discountCode`, `discountPercentage`, `discountSource`, `discountCodeId`. | `stripeWebhook.ts:452`, `:488-497`; `createPaymentIntent.ts:885-898` |
| Buyer validation | The callable `validateDiscountCode` returns `{valid: false}` for unknown, inactive, expired or full codes. For a valid one it returns its **whole terms** (type, value, scope, product ids, minimum) to any anonymous caller, with no rate limit in its definition. The cart recomputes the amount and says "Ogiltig rabattkod.", "Koden gäller vid köp över X kr." or "Rabatt på X tillämpad!". | `validateDiscountCode.ts:17-21`, `:82-119`; `src/contexts/CartContext.jsx:426-510` |
| Re-validation | The stored code is re-validated on every cart change. | `CartContext.jsx:211-214` |
| The two security fixes (2026-08-15 audit) | The discount is computed server-side before the PaymentIntent is created. The payment form re-creates the payment only when a priced input changes ("PI per keystroke"). | `createPaymentIntent.ts:588-604`; `src/components/shop/StripePaymentForm.jsx:302-310`; described again at `cloudflare/src/commerce/payment.ts:441-466` |
| Production data | Firebase production holds **0** `discountCodes` documents (archived empty). | `docs/cf-port/MIGRATION_MANIFEST.md:44`, `:83` |

#### 1.2 Ported, changed, dropped

| Rule | Fate | Reason |
|---|---|---|
| Two types, two scopes, minimum on the full subtotal, inclusive window, usage cap, one code per cart, shipping never discounted | **Ported** (already in `discount-codes.ts:203-278`) | The behaviour sellers know. |
| Rounding of a percentage | **Changed** (already): up to the **öre**, not the krona (`discount-codes.ts:140-161`). See DC10. | Exact integer money. The difference is at most 99 öre less discount. No live code is affected (0 documents). |
| Window dates | **Changed**: the start is 00:00 Stockholm on the start day, the end is 23:59:59.999 Stockholm on the end day (inclusive), and dates are shown in Stockholm time. See DC15. | Fixes both old date bugs. PLAN §2.8. |
| The usage count | **Changed**: a use is **held** at checkout and counted at payment (§2.3). See DC3/DC4. | The brief's race (two buyers, one use left). The old count could be lost or overshot. |
| Code shape | **Changed** (already): 1–50 characters, no whitespace or control characters (`discount-codes.ts:39-52`). A fixed amount of 0 is refused (new, parity with the old form). | A code with a space in it cannot be told to a buyer. |
| Uniqueness | **Changed** (already): `UNIQUE (tenant_id, code)` (`0010:110`). | The old check could race. |
| Delete | **Dropped**: a code is deactivated, never deleted. See DC12. | Orders name the code by id. Deleting it would orphan the name on the order views. |
| Rename of a used code | **Changed**: refused. See DC13. | The order views show the code's current name by join. |
| The validate callable's full terms | **Dropped**. The preview answers only "applies, and how much". See DC11. | It was an oracle for a shop's campaign terms. |
| Affiliate codes | **Not ported** (PLAN §3.2). The namespace stays compatible: §2.6. | Out of scope. |
| `discountPercentage` and metadata on the PaymentIntent | **Dropped** (already) | The Cloudflare webhook reads the checkout row, not metadata (`webhook.ts:43-61`, `payment.ts:555-576`). |

### 2. Data model

#### 2.1 What stays as it is

- `discount_codes` (0010). The usage counter stays `used_count`, written only by the webhook.
- `checkouts.discount_minor` and `discount_code_id`, with their CHECKs: a discount needs a code id, and the discount never exceeds the subtotal (`0010:156-159`).
- `orders.discount_minor` and `discount_code_id` (`0011:99-136`), frozen by `orders_money_immutable` (`0011:157-172`).
- No new column on `checkouts`, `orders`, `checkout_items` or `order_items`. The code's name reaches the views by join (§4.4). No per-line split is stored (DC9).

#### 2.2 Migration `0055_discount_code_holds.sql`

If 0055 is taken when the builder starts: use the next free number. Name the file `00NN_discount_code_holds.sql`. Point `REQUIRED_MIGRATION` (`cloudflare/src/app.ts:484`) at it, and update the two tests that pin the latest migration, `cloudflare/test/health.test.ts` and `cloudflare/test/public-catalog.test.ts`. Never edit a migration that has been applied anywhere.

```sql
PRAGMA foreign_keys = ON;

-- 0055 — Rabattkoder on Cloudflare (CP8-DC). A code's use is HELD while a
-- buyer is paying and COUNTED when the payment succeeds. The counter stays
-- discount_codes.used_count (the webhook's, 0010). A hold is one row per
-- checkout that froze a discount.
--
-- WHY A HOLD AND NOT A CAP CHECK ON THE COUNTER. The webhook must never fail
-- for a paid intent (src/commerce/webhook.ts header). A CHECK such as
-- used_count <= max_uses would abort the order batch of a buyer who paid
-- after their hold expired. So the cap is enforced where refusing is
-- harmless: at the INSERT of a hold, when nobody has paid yet.

CREATE TABLE discount_code_holds (
  hold_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  discount_code_id TEXT NOT NULL REFERENCES discount_codes(discount_code_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- sha256 hex of `${tenant_id}:${customer_email}`, the email as the checkout
  -- parser lowercased it. One buyer's several checkouts count as ONE hold for
  -- everyone else. No second copy of the address.
  buyer_key TEXT NOT NULL CHECK (length(buyer_key) = 64 AND buyer_key NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'used')),
  -- The order that used it. A breadcrumb with no foreign key, as
  -- checkouts.discount_code_id (0010): nothing on the webhook's path may abort.
  order_id TEXT,
  -- ms epoch. A hold counts while state = 'held' AND expires_at > now.
  -- Expiry needs no write.
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK ((state = 'used') = (order_id IS NOT NULL))
);

CREATE TRIGGER discount_code_holds_tenant_immutable
BEFORE UPDATE OF tenant_id ON discount_code_holds
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER discount_code_holds_born_held
BEFORE INSERT ON discount_code_holds
FOR EACH ROW
WHEN NEW.state <> 'held' OR NEW.order_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a discount hold is born held');
END;

-- The hold belongs to a checkout of the same tenant that froze a discount
-- from THIS code, and lives no longer than that checkout.
CREATE TRIGGER discount_code_holds_match_checkout
BEFORE INSERT ON discount_code_holds
FOR EACH ROW
WHEN NOT EXISTS (
       SELECT 1 FROM checkouts AS c
       WHERE c.checkout_id = NEW.checkout_id
         AND c.tenant_id = NEW.tenant_id
         AND c.discount_code_id = NEW.discount_code_id
         AND c.discount_minor > 0
         AND c.expires_at >= NEW.expires_at)
  OR NOT EXISTS (
       SELECT 1 FROM discount_codes AS d
       WHERE d.discount_code_id = NEW.discount_code_id
         AND d.tenant_id = NEW.tenant_id)
BEGIN
  SELECT RAISE(ABORT, 'discount hold does not match its checkout');
END;

-- THE CAP. Uses counted (used_count) + live holds of OTHER buyers, each buyer
-- once. The same predicate as resolveDiscount's read (§2.3). The message is
-- matched by createCheckout (isDiscountExhausted).
CREATE TRIGGER discount_code_holds_capacity
BEFORE INSERT ON discount_code_holds
FOR EACH ROW
WHEN (SELECT max_uses FROM discount_codes WHERE discount_code_id = NEW.discount_code_id) IS NOT NULL
  AND (SELECT used_count FROM discount_codes WHERE discount_code_id = NEW.discount_code_id)
      + (SELECT COUNT(DISTINCT h.buyer_key) FROM discount_code_holds AS h
         WHERE h.discount_code_id = NEW.discount_code_id
           AND h.state = 'held'
           AND h.expires_at > NEW.created_at
           AND h.buyer_key <> NEW.buyer_key)
      >= (SELECT max_uses FROM discount_codes WHERE discount_code_id = NEW.discount_code_id)
BEGIN
  SELECT RAISE(ABORT, 'discount code exhausted');
END;

-- held → released | used; released → used (a payment that succeeded after
-- its hold was released still counts). Nothing leaves 'used'.
CREATE TRIGGER discount_code_holds_transition
BEFORE UPDATE OF state ON discount_code_holds
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
  AND NOT ((OLD.state = 'held' AND NEW.state IN ('released', 'used'))
           OR (OLD.state = 'released' AND NEW.state = 'used'))
BEGIN
  SELECT RAISE(ABORT, 'discount hold transition refused');
END;

CREATE TRIGGER discount_code_holds_frozen
BEFORE UPDATE ON discount_code_holds
FOR EACH ROW
WHEN NEW.hold_id IS NOT OLD.hold_id
  OR NEW.discount_code_id IS NOT OLD.discount_code_id
  OR NEW.checkout_id IS NOT OLD.checkout_id
  OR NEW.buyer_key IS NOT OLD.buyer_key
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.order_id IS NOT NULL AND NEW.order_id IS NOT OLD.order_id)
BEGIN
  SELECT RAISE(ABORT, 'discount hold facts are immutable');
END;

CREATE TRIGGER discount_code_holds_no_delete
BEFORE DELETE ON discount_code_holds
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'discount holds are kept');
END;

-- DC13 backstop: a code's name is frozen once it has been used or held. The
-- admin route answers 409 first. The webhook's burn never sets `code`, so
-- this trigger cannot touch the order batch.
CREATE TRIGGER discount_codes_code_frozen_once_used
BEFORE UPDATE OF code ON discount_codes
FOR EACH ROW
WHEN NEW.code IS NOT OLD.code
  AND (OLD.used_count > 0
       OR EXISTS (SELECT 1 FROM discount_code_holds
                  WHERE discount_code_id = OLD.discount_code_id))
BEGIN
  SELECT RAISE(ABORT, 'discount code in use');
END;

CREATE INDEX discount_code_holds_capacity_idx
  ON discount_code_holds(discount_code_id, state, expires_at);
CREATE INDEX discount_code_holds_buyer_idx
  ON discount_code_holds(tenant_id, discount_code_id, buyer_key);
```

Notes for the builder:

- **Tenant scoping.** Every hold carries `tenant_id`, immutable. The insert trigger proves that the code and the checkout belong to that tenant. Every query names the tenant (or the checkout id, which is tenant-bound).
- **Style.** One trigger per rule, with a message the code can match, like the variant limit (`0040_product_catalogue.sql:210-230`, matched at `src/catalog/product-variants.ts:298`).
- **Not probed on D1.** `COUNT(DISTINCT …)` inside a trigger's `WHEN` is ordinary SQLite. The migration test must prove the trigger on the D1 test instance, as 0010 did for its CHECKs (`0010:137-146`).
- **No catalogue-version bump in the migration.** See §8.3 for why it happens after the deploy.

#### 2.3 Counting a use without a race, and releasing it

**The rule.** A code with a cap `max_uses` is available to buyer *b* at time *now* exactly when

```
used_count + COUNT(DISTINCT buyer_key of holds with state='held', expires_at > now, buyer_key ≠ b) < max_uses
```

The read and the trigger use the same predicate. A code without a cap still gets a hold row (uniform code, and the seller's "i kassan" count), but its trigger never refuses.

**Lifetime.** `expires_at = min(now + DISCOUNT_HOLD_TTL_MS, checkout.expires_at)`. `DISCOUNT_HOLD_TTL_MS = 60 min` (DC3). The checkout lives 24 h (`checkout.ts:199`).

**Where each state change happens.**

| Event | Statement | Where |
|---|---|---|
| A checkout freezes a discount | `INSERT INTO discount_code_holds (…, state='held', expires_at, buyer_key, …)` **in the checkout's own batch**, after the items. The capacity trigger runs there. | `createCheckout`, `checkout.ts:1229-1323` |
| The trigger refuses (the race) | The whole batch rolls back; nothing is written. `createCheckout` catches `discount code exhausted` and runs **once more** with the discount forced off. The buyer gets a checkout with `discountMinor: 0`, the code echoed. | `checkout.ts:1325-1366` (the catch) |
| The payment succeeds | In the order batch, before the `used_count` burn: (1) `UPDATE discount_code_holds SET state='used', order_id=?, updated_at=MAX(updated_at,?) WHERE checkout_id=? AND tenant_id=? AND state IN ('held','released')`; (2) the same buyer's other holds on this code are released: `UPDATE … SET state='released' … WHERE tenant_id=? AND discount_code_id=? AND state='held' AND checkout_id<>? AND buyer_key=(SELECT buyer_key FROM discount_code_holds WHERE checkout_id=?)`; (3) the existing `used_count + 1`, unchanged. All three are guarded so they cannot trip a trigger, and for a checkout made before 0055 (no hold) they match nothing. | `webhook.ts:752-783` |
| The PaymentIntent is cancelled | `UPDATE discount_code_holds SET state='released', updated_at=MAX(updated_at,?) WHERE checkout_id=? AND state='held' AND EXISTS (SELECT 1 FROM checkouts WHERE checkout_id=? AND payment_intent_status='canceled')`, after the checkout update in the same batch. | `handleIntentStatus`, `stripe-events.ts:194-239` (only when `status === 'canceled'`); `runRetentionSweep` step 1, `crons.ts:171-184` (turn the single `.run()` into a batch of the two statements) |
| The payment fails (`requires_payment_method`) | **No release** (DC4). The buyer may retry another card on the same intent (`crons.ts:99`: not terminal). | none |
| The buyer leaves | Nothing is written. The hold stops counting at `expires_at`. | none |

**Worked race.** Code `CAP3`, `max_uses 3`, `used_count 2`.

1. Buyer A reaches payment. Read: 2 + 0 = 2 < 3, so the code applies. Hold A1 is inserted; the trigger sees 2 + 0 < 3.
2. Buyer B reaches payment. Read: 2 + 1 (A) = 3 ≥ 3. B's checkout has `discountMinor 0` and no hold.
3. **The real race.** A and B both read 2 + 0 before either writes. A's batch commits first. B's trigger sees 2 + 1 ≥ 3 and aborts B's batch. `createCheckout` reruns B with the discount off, and B gets 201 with `discountMinor 0`.
4. A ticks the marketing box. That is a new request, so a new checkout. Read: 2 + 0, because A's own hold is excluded. Hold A2 is inserted.
5. A pays checkout 2. A2 becomes `used`, A1 becomes `released`, `used_count` becomes 3.
6. Buyer C. Read: 3 + 0 ≥ 3. Not applied.

**Where the cap can still be overshot (accepted, and stated to the seller).**

- A payment that succeeds after its hold expired (more than 60 min after the buyer reached payment), when other buyers took the remaining uses meanwhile.
- One buyer who pays two of their own checkouts (two tabs).

In both cases the order is honoured and `used_count` ends above `max_uses`. That is the same trade the webhook comment makes (`webhook.ts:764-771`): a paid order is never refused.

#### 2.4 Retention

Holds are kept, like the checkouts they belong to (`crons.ts:93-111` purges only snapshots). They hold a hash, no personal data in clear.

#### 2.5 Data import

Firebase production has 0 `discountCodes` (`MIGRATION_MANIFEST.md:83`). Nothing is imported. The restore script leaves the collection untransformed (`scripts/cf-port/migrate/restore-archive.mjs:30,93`). The builder adds one line to the cutover runbook: "if the freeze count of `discountCodes` is above 0, stop: the transform does not exist."

#### 2.6 Affiliates later: one namespace per shop

- A code string is unique per tenant (`0010:110`). When affiliates port, D30's default ("reject collisions at creation") holds both ways: one trigger on each table refuses a code that exists in the other table for the same tenant.
- `resolveDiscount` keeps its seam: the affiliate branch goes ahead of the campaign lookup (`discount-codes.ts:283-314`). With collisions impossible, the order of the two lookups no longer matters.
- Holds are campaign-only (affiliate codes had no cap).
- The affiliate migration adds `orders.discount_source`, defaulting to `'campaign'` wherever `discount_code_id` is set. Nothing in 0055 is in its way.

### 3. Money: every figure, the invariants, worked examples, and the rules to choose

#### 3.1 The invariants that must keep holding

| # | Invariant | Where it is enforced today |
|---|---|---|
| I1 | **Total parity.** `total = subtotal + shipping − discount`. The PaymentIntent amount is that total, the webhook's amount check proves Stripe captured it, and `charged = total`. | CHECKs `0009_checkout_totals_v2.sql:131`, `0011:129`; `payment.ts:549`; `webhook.ts:559-575` |
| I2 | A discount needs a code id and never exceeds the subtotal, so it never eats shipping. | `0010:156-159`; `0011:132-136` |
| I3 | **The fee never exceeds the gross.** `application_fee = commission + withholding ≤ charged`, otherwise refused, never clamped. | `payment.ts:120-135`, `:532-544` |
| I4 | **The withholding is frozen from cost, never from price.** `W = round_half_up((Σ line cost + printer parcel) × 1.25)`. It is frozen in the snapshot, attached with the intent, and copied to the order. | `checkout.ts:1099-1103`; `pod-quote.ts:273-277`; `payment.ts:367-392`; `webhook.ts:576-577` |
| I5 | **Refunds are cumulative and capped at what was charged.** Each refund reserves first, so `charged − succeeded − reserved ≥ amount`. | `refunds.ts:19-32` |
| I6 | VAT is derived once from the total, at the shop's one rate, rounded half up. | `checkout.ts:704-739`; `shipping.ts:357-376` |
| I7 | **The seller sees one fee number.** | `admin-orders.ts:11-29`, `:234-236`; `payouts.ts:115-122` |
| I8 | The order batch never fails for a paid intent, except on a database fault. | `webhook.ts:63-73` |
| I9 (new) | A discounted total is at least `MIN_CHARGE_MINOR` (300) and leaves `fee ≤ gross`. | §3.4 |
| I10 (new) | A held use counts against the cap. `used_count` changes only in the order batch. | §2.3 |

#### 3.2 Every figure, before and after

S = subtotal, H = shipping, D = discount, T = total, W = withholding, c = commission rate (bp), r = refunds.

| Figure | Without a code | With a code (this design) | Code |
|---|---|---|---|
| Subtotal S | Σ unit price × quantity | **unchanged** (always undiscounted) | `checkout.ts:666-669` |
| Shipping H | the shop's carriage, or 0 for pickup | **unchanged**, never discounted (DC8) | `checkout.ts:661-692` |
| Discount D | 0 | `fixed`: min(value, base). `percent`: ⌈base × bp / 10 000⌉ to the öre. **0 if any rule of §3.4 fails.** | `discount-codes.ts:269-278` |
| Total T | S + H | S + H − D | `checkout.ts:715` |
| VAT | vat(S + H) | vat(S + H − D), one rate | `shipping.ts:357-376` |
| Stripe amount | T | T | `payment.ts:549` |
| Commission | ⌊T × c / 10 000⌋ | ⌊(S + H − D) × c / 10 000⌋, on what the buyer pays (DC7) | `payment.ts:94-104` |
| Withholding W | from cost | **unchanged**, from cost | `checkout.ts:1099-1103` |
| Application fee | commission + W | commission(T) + W | `payment.ts:120-135` |
| Shop payout | T − r − (fee − released) | the same formula on the discounted T | `payouts.ts:130-138` |
| Full refund | T | T, the discounted charge, never S + H | `refunds.ts:21-24` |
| Partial refund | ≤ T − succeeded − reserved | the same | as above |
| Refund after a partial one | ≤ what remains | the same | as above |

#### 3.3 Worked examples

Fixture: shop VAT 25 % (2 500 bp); commission 500 bp (platform default, no shop override; the default on staging is not verified); prices in öre.

- **Tee (POD):** shelf price 29 900. Printer tier: blank 6 000 + front print 4 000 + platform cut 4 000 = cost 14 000 ex VAT (`pod-quote.ts:18,108`). Printer parcel 4 900 ex VAT.
  - Withholding for one tee: W = ⌊(18 900 × 12 500 + 5 000) / 10 000⌋ = **23 625** (`pod-quote.ts:273-277`).
  - D41 price floor: ⌈(18 900 × 12 500 + 500 × 10 000) / 920 000⌉ kr = ⌈262.23⌉ = **26 300** (`pod-quote.ts:199-212`, `:247-266`).
- **Mug (not POD):** 20 000.
- **Buyer's carriage for a parcel:** 4 900.

**A. Not POD: two mugs, parcel, 20 % on the whole cart**

| | No code | SOMMAR20 |
|---|---|---|
| S / H / D | 40 000 / 4 900 / 0 | 40 000 / 4 900 / **8 000** |
| T (Stripe amount) | 44 900 | **36 900** |
| VAT | 8 980 | 7 380 |
| Commission (= fee, W = 0) | 2 245 | 1 845 |
| Payout | 42 655 | 35 055 |

Refunds with the code:

- Full refund of 36 900: payout 36 900 − 36 900 − 1 845 = **−1 845** (the commission is not returned, D9, `refunds.ts:52-55,78`).
- Partial refund of 10 000: payout 25 055, with 26 900 left to refund.
- A refund of 26 900 after that: total refunded 36 900 = charged, payout −1 845. Any further refund is refused.
- A refund of 44 900 (the undiscounted price) is refused: the cap is 36 900.

**B. POD: one tee, parcel, 20 %**

| | No code | 20 % |
|---|---|---|
| S / H / D | 29 900 / 4 900 / 0 | 29 900 / 4 900 / **5 980** |
| T | 34 800 | **28 820** |
| VAT | 6 960 | 5 764 |
| Commission | 1 740 | 1 441 |
| W (from cost) | 23 625 | **23 625** |
| Fee | 25 365 ≤ 34 800 ✓ | 25 066 ≤ 28 820 ✓ |
| Payout | 9 435 | 3 754 |

The printer's cost and the platform's cut are inside W and do not move. The platform earns 299 öre less commission (5 % of 5 980).

Refunds with the code:

- Full refund before the printer accepted: D36 returns W, so the payout is 28 820 − 28 820 − (25 066 − 23 625) = **−1 441**.
- Full refund after the printer accepted: **−25 066**. The shop pays for the production, as today.
- Partial refund of 5 000 after acceptance: payout −1 246, with 23 820 left to refund.

**C. The hard case: the tee priced at its floor, 26 300, pickup**

Is there a price floor today? Yes: the publish and price-edit gates (D41, `pod-quote.ts:214-266`). Nothing re-checks it under a discount.

| Code | D | T | Today | This design |
|---|---|---|---|---|
| none | 0 | 26 300 | fee 1 315 + 23 625 = 24 940; payout 1 360 | the same |
| 5 % | 1 315 | 24 985 | fee 1 249 + 23 625 = 24 874 ≤ T; payout **111** | **applies**, the same numbers |
| 10 % | 2 630 | 23 670 | Checkout **201** (it checks only W ≤ T, `checkout.ts:1104`). Payment: 1 183 + 23 625 = 24 808 > T, so **404**, and the storefront says "Butiken tar inte emot beställningar ännu." (`StripePaymentForm.jsx:374-379`). | **The code does not apply.** T = 26 300, the buyer is told why (§7.1). |
| 20 % | 5 260 | 21 040 | W 23 625 > T, so checkout **422**, "Något i varukorgen är inte längre tillgängligt…" | **The code does not apply.** T = 26 300. |

The same applies to a 35 % code in example B: D 10 465, T 24 335. Today the checkout answers 201, then the payment 404s (fee 24 841 > T). In this design the code does not apply.

**D. Mixed basket, pickup: mug 20 000 + tee 26 300, 20 % on the whole cart**

- S 46 300, D 9 260, T 37 040, VAT 7 408.
- Fee 1 852 + 23 625 = 25 477 ≤ T, payout 11 563. **Applies.**
- In proportion, the tee carries 5 260 of the discount and sells for 21 040, below its W of 23 625. The basket still covers it. The rule is per basket (§3.4), so this is allowed.
- The same code scoped to the tee only: D 5 260, T 41 040, payout 15 363.

**E. The payment minimum**

- Mug 20 000, pickup, a fixed code worth 20 000: D 20 000, T **0**.
  - Today the checkout answers 201 (a test pins it, `discount-codes.test.ts:556-565`). Then a PaymentIntent of 0 öre cannot be created, so the payment route answers 502.
  - In this design T < 300, so the code does not apply.
- The same code with a parcel: D 20 000 (never the carriage), T 4 900, VAT 980, commission 245, payout 4 655. **Applies.**

#### 3.4 The rules to choose (the öre consequence of each; the recommended default is the most conservative one for the platform)

**R1. Does the discount reduce the commission's base?** (DC7)

- (a) **Default.** The commission is on what the buyer pays (S + H − D). This is today's code and Firebase's (`createPaymentIntent.ts:750-751`): the platform shares the cost of the campaign. Example A: 1 845; B: 1 441.
- (b) The commission is on the price before the discount (S + H). The platform earns +400 öre in A and +299 in B. The fee becomes a percentage of money that was never charged; more baskets fail R2 (C at 5 % keeps a payout of 45 instead of 111); and it changes the sellers' price list.
- (a) is the conservative choice: no change to the money engine, and the fee is a share of money that actually moved.

**R2. Can a code make a POD order unprofitable?** (DC5)

- **For the platform: no.** W covers the printer and the platform's cut from cost (I4), and fee ≤ gross is enforced (I3).
- **For the shop:** a payout can reach 0 on an order but never go below at the sale. After refunds it can go negative exactly as today (D9, `payouts.ts:21-26`).

The rule is evaluated at checkout: once D is resolved, if the basket has a withholding (W > 0), compute `buildConnectCharge(S + H − D, bps, W)` with the same commission the payment will use (`resolveCommissionBps(tenants.commission_bps, readDefaultCommissionBps(db) ?? DEFAULT_COMMISSION_BPS)`, as `payment.ts:522-531`). If `feeExceedsGross`, **D = 0**.

- (a) **Default.** The code does not apply (C at 10 %: the buyer pays 26 300).
- (b) Clamp D to the largest value that still fits. C at 10 %: D = 1 432 instead of 2 630 (T 24 868, shop payout 0).
- (c) POD lines are never discounted.
- (d) Every POD line must stay at or above its own floor. That needs a per-line split, and the cart-level rule already protects the platform.

(a) is conservative: no partial amount the seller never offered, the payout never goes below 0 at sale, and it replaces the opaque payment 404 with an honest answer. A basket without POD cannot fail this rule (`computeCommissionMinor` clamps the commission to the amount, `payment.ts:94-104`), so it is skipped when W = 0.

**R3. The payment minimum.** (DC6)

- (a) **Default.** If D > 0 and S + H − D < `MIN_CHARGE_MINOR` = 300, D = 0. Example E: the buyer pays 20 000.
- (b) Clamp so that exactly 300 remain (D = 19 700).

300 is Stripe's published minimum charge for SEK, 3,00 kr: **not verified** against the account (no network). The constant is one value for every currency. That is conservative for SEK, NOK, DKK and EUR (Stripe's EUR minimum is lower).

**R4. Is shipping discounted?** (DC8) No. This is enforced by the CHECK (I2) and was Firebase's rule. A free-shipping code is a new feature, not a port.

**R5. Is the cart-level discount spread over the lines?** (DC9)

- **VAT:** no spread is needed. A shop has one rate (`tenants.vat_rate_bp`, `checkout.ts:751-761`), so VAT(T) is exact whatever the spread. Example D spread proportionally: mug 16 000 → VAT 3 200, tee 21 040 → VAT 4 208; together 7 408 = VAT(37 040). With other numbers, per-line rounding could differ by 1 öre per line, and the order stores only VAT(T).
- **Partial refunds:** the engine is amount-based and capped at the charge (I5). The seller's UI offers only a whole-order refund (`AdminOrderDetail.jsx:305-311`, `refundWholeOrder`), and a withdrawal moves no money (`withdrawals.ts:43-45`). So nothing reads a spread today.
  - Consequence of no spread, example D: if the buyer returns the mug and the seller refunds its shelf price 20 000 by API instead of its share 16 000, the buyer gets 4 000 öre more than they paid for it. The shop funds that (D9 reverse transfer). The platform is not at risk, and the total stays capped at 37 040.
- (a) **Default:** store no spread. No consumer exists, and adding columns to the four frozen line tables is risk without use.
- (b) Freeze a spread now on `checkout_items.discount_minor` and `order_items.discount_minor`: proportional to `line_total_minor` over the base lines, floor each share, then hand the remaining öre to the largest remainders (ties to the lower `item_index`). Use BigInt: `line_total × D` can exceed 2^53. This is the only way to know a products-scoped code's lines later, once the seller has edited the scope.

**R6. Rounding of a percentage.** (DC10)

- (a) **Default.** Up to the öre (the code as it is). 35 % of 29 900 = 10 465.
- (b) Up to the krona, as Firebase did: 10 500 (35 öre more discount).

(a) is exact and gives the lesser discount.

### 4. Routes and their contracts

All money in integer minor units. All refusals use the existing shapes (`src/lib/responses.ts`).

#### 4.1 Storefront: preview a code against a cart (new)

`POST /v1/discount-codes/preview`. Mounted exactly, inside `storefront(...)` with `onMethods(["POST"], …)`, as the withdrawal intake is (`app.ts:2353`). New file `cloudflare/src/routes/storefront-discount-preview.ts`, engine `cloudflare/src/commerce/discount-preview.ts`. Add the row `{ methods: ["POST"], segments: ["v1", "discount-codes", "preview"] }` to the web Worker's allowlist (`cloudflare/web/src/api-allowlist.ts:34-51`), with its test in `cloudflare/test/web-routing.test.ts`.

Request (strict keys; the items are parsed exactly as the checkout parses them, `checkout.ts:316-333`, 1–50, no duplicate product/variant):

```json
{ "code": "sommar20 ", "items": [ { "productId": "p1", "quantity": 2, "variantId": "v1" } ] }
```

Responses:

| Status | Body | When |
|---|---|---|
| 200 | `{ "discount": { "code": "SOMMAR20", "applies": true, "discountMinor": 5980 } }` | The code applies to these lines. |
| 200 | `{ "discount": { "code": "SOMMAR20", "applies": false, "discountMinor": 0 } }` | **Every** other case: unknown code, another shop's code, inactive, not started, ended, cap reached by `used_count`, minimum not met, no matching line, worth 0, the shop's switch off. One shape, one query. |
| 400 `invalid_request` | | Malformed body or code (not a string, empty after trim, over 50 characters, whitespace or control inside). This is decided without the database. |
| 404 (opaque) | | No tenant for the hostname; any method but POST. |
| 422 `unprocessable` | | A line cannot be bought (the checkout's own answer). |
| 429 `rate_limited` | + `Retry-After` | The 31st preview from one visitor within 10 minutes. |

The lines are resolved with the checkout's own `resolveLines`, passing `printCanvasEnabled(env)` exactly as the checkout route does. The uncommitted CP6-PS4 work in the tree adds that `refuseStandInFrames` argument (`git diff cloudflare/src/commerce/checkout.ts`). So the preview prices exactly the lines the checkout would accept.

What the preview checks: the switch, the row, the window, `used_count < max_uses` **without holds**, the minimum, base > 0, and amount > 0. It does **not** check holds, R2 or R3: they depend on carriage, production and other buyers. It is display-only, as Firebase's callable was (`validateDiscountCode.ts:71-74`). The checkout's answer is authoritative and can only be stricter.

Rate limit: scope `discount-preview-ip`, 30 per 10 minutes, key `visitorRateKey(clientIp(request))` (an IPv6 address counts by its /64, `src/lib/rate-limit.ts:153-175`). It runs **before** the body is read.

#### 4.2 Storefront: apply at checkout (existing route, new behaviour)

`POST /v1/checkout`. The request is unchanged; `discountCode` is already optional (`checkout.ts:216-225`, `:384-397`). The response is unchanged (`checkout.ts:110-136`): `discountCode` echoes the normalised code whenever one was sent, and `discountMinor` is 0 when it did not apply.

The refusals are unchanged: 400, 404, 409, 422, 429 (`app.ts:1157-1252`). One new limit: when the body carries a code, scope `discount-attempt-ip`, 20 per 10 minutes per visitor, after parsing, beside the existing per-IP and per-email limits (`app.ts:492-497`). This closes the checkout as a faster oracle than the preview (10 per minute today).

`POST /v1/checkout/:id/payment` is **unchanged**. It reads the frozen total (`payment.ts:472-583`) and keeps its fee check as the backstop.

#### 4.3 Admin

The gate order for every request, unchanged: `authorizeTenantAdminRequest` (a member of the shop, or a platform user with an open acting-as grant), same-origin on writes, then **new**: `isFeatureEnabled(env.DB, principal.tenantId, "discountCodes")` (`tenant-config.ts:180-200`). If it is false, the opaque admin 404 for every method (DC14). Then the body.

| Route | Request | Answers |
|---|---|---|
| `GET /v1/admin/discount-codes` (**new**) | none | 200 `{ discountCodes: AdminDiscountCode[], truncated: boolean }`, newest first, at most 200 (read 201 to set `truncated`), on index `discount_codes_tenant_created_idx` (`0010:124-125`). |
| `POST /v1/admin/discount-codes` | the existing create body (`admin-discount-codes.ts:61-73`) | 201 `{ discountCode }`; 400 `invalid_request`; 409 `conflict` (name taken). |
| `GET /v1/admin/discount-codes/:id` | none | 200 `{ discountCode }`; 404. |
| `PATCH /v1/admin/discount-codes/:id` | any subset of the create keys | 200; 400; 404; 409 `conflict`; **409 `discount_code_in_use`** (a new name for a code with `used_count > 0` or any hold). |
| `DELETE …` | | 404, as any other method (DC12). |

`AdminDiscountCode` = the existing shape (`admin-discount-codes.ts:39-55`) **plus** `heldCount`, the number of distinct buyers with a live hold:

```sql
SELECT d.discount_code_id, d.code, d.active, d.type, d.value_minor, d.percent_bp,
       d.starts_at, d.ends_at, d.max_uses, d.used_count, d.min_spend_minor,
       d.scope, d.product_ids_json,
       (SELECT COUNT(DISTINCT h.buyer_key) FROM discount_code_holds AS h
        WHERE h.discount_code_id = d.discount_code_id
          AND h.state = 'held' AND h.expires_at > ?2) AS held_count
FROM discount_codes AS d
WHERE d.tenant_id = ?1
ORDER BY d.created_at DESC, d.discount_code_id DESC
LIMIT 201
```

The body rules are the existing parsers (`admin-discount-codes.ts:291-528`), with two changes:

- `valueMinor` minimum **1**, not 0 (`:307-317`, `:443-453`). The old form refused ≤ 0 (`AdminDiscountCodes.jsx:147-151`).
- The rename lock in `updateAdminDiscountCode` (`:700-808`): read `used_count` and `EXISTS(hold)`, and answer `{status: "in_use"}` before the write. The trigger of §2.2 is the backstop; map its message to `in_use` too.

Audit: the existing `discount_code.create` and `discount_code.update`, with field names only and no code string (`admin-discount-codes.ts:570-598`). Reads are not audited, as elsewhere.

#### 4.4 The views (existing routes, one field each)

- `GET /v1/admin/orders/:id`: `totals.discountCode: string | null`, from `LEFT JOIN discount_codes AS dc ON dc.discount_code_id = o.discount_code_id AND dc.tenant_id = o.tenant_id` (`admin-orders.ts:140-155`, `:257-263`). The rename lock (DC13) and no delete (DC12) keep the join faithful.
- The buyer receipt `GET /v1/orders/:id`: `totals.discountCode`, the same join (`receipts.ts:206-212`, `:271-285`, `:319-325`). The buyer typed it, and the receipt is token-bound (PLAN §2.1).
- Both order mails: the same join in `readOrder`, `src/outbox/email-effect.ts:150-172`. The line reads `Rabatt (SOMMAR20): -59,80 kr` in `email/order-emails.ts:654` and `email/auth-email-job.ts:704-705`, falling back to `Rabatt` when null.

#### 4.5 What a buyer never learns

- Whether a code exists, here or on another shop. The lookup is tenant-scoped (`discount-codes.ts:316-328`), and every miss has the same answer and the same single query.
- Why a code does not apply. Its type, value, window, cap, use count, holds, scope or minimum.
- No code string in a log line or in `audit_events`.

The checkout response already says nothing more (`checkout.ts:114-127`).

### 5. The checkout flow, step by step

1. **Cart.** The buyer types a code and presses "Applicera". The cart normalises it and checks its shape. It calls the preview (§4.1) **once per press**, never per keystroke. If the answer is `applies: true`, the cart stores the normalised code (in localStorage per shop root) and shows "Rabatt −X kr". It re-previews when the lines change, once per change after 500 ms. No checkout, no hold, no payment.
2. **Contact and delivery steps.** Nothing about the code.
3. **The payment step.** The payment form builds the checkout request and now includes the stored code (`StripePaymentForm.jsx:290-300`; `buildCheckoutRequest`, `adapters/checkout.js:79-110`). The effect fires only when the request's JSON changes (`StripePaymentForm.jsx:302-310`, `:410`). So the payment is created again only when the code is added or removed, never per keystroke.
4. **`POST /v1/checkout`** (`createCheckout`, `checkout.ts:1111-1400`), in this order:
   1. legal gate (`:1130`); recipient (`:1134-1143`); lines (`:1145-1148`); currency (`:1150-1153`); VAT rate (`:1155`); carriage (`:1156-1167`);
   2. **new:** `buyerKey = sha256hex(\`${tenantId}:${email}\`)`;
   3. the discount (`:1169-1182`), now only if `isFeatureEnabled(…, "discountCodes")` and not forced off by a retry. `resolveDiscount` reads the row **with** `held_by_others` (the §2.3 predicate, as a subquery in the same single read);
   4. the snapshot: `freezeProductionSnapshot(…, S + H, …)`, i.e. the **undiscounted** total as its ceiling (`:1197-1208`). For a cart without a code nothing changes. The snapshot's JSON holds costs only, never the total (`:1100-1108`), so it is the same with or without a code;
   5. **new**, only if D > 0: R3, then (if W > 0, read with `readWithholdMinor`, `payment.ts:168-195`) R2. If either fails, D = 0 and code id = null;
   6. `closeQuote(S, H, D, rate)` (`:1184-1192`), its range check unchanged;
   7. consent (`:1210-1220`);
   8. the batch (`:1229-1323`): checkout row, items, recipient, **the hold (new, only when a code id was frozen)**, audit.
   9. On `discount code exhausted`: run once more with the discount forced off (pass a private flag, not a public `CheckoutOptions` member), and return that.
   10. On an idempotency collision: the existing replay comparison (`:1332-1365`). The fresh discount it compares already went through steps 3–5, and the buyer's own hold is excluded from the cap, so an identical replay matches.
5. **What is frozen at checkout:** `discount_minor`, `discount_code_id` (existing), and the hold (state, expiry, buyer key). The commission rate is **not** frozen here: the payment route reads it again and freezes the fee with the intent (`payment.ts:367-392`).
6. **`POST /v1/checkout/:id/payment`:** unchanged. One intent per checkout, amount = the frozen total (`payment.ts:441-466`). Its fee check stays as the backstop, for a commission that changed between checkout and payment.
7. **The webhook:** the order copies `discount_minor` and `discount_code_id` (`webhook.ts:556-557`). The hold becomes `used`; the buyer's other holds on the code are released; `used_count + 1`. All in the order's one batch (§2.3).
8. **Replayed checkout** (same key, same request): the stored row is returned (`checkout.ts:1357-1365`), with no second hold. **Resumed checkout** (the page reloaded, so a new key): a new checkout and a new hold. The buyer's earlier hold does not count against them, so the code still applies to them.
9. **Changed request** (a box ticked, the address changed, the code removed): a new checkout and a new intent, as today for any priced input. The old intent is left to the retention sweep (`crons.ts:130-194`). The old hold expires or is released when another of the buyer's checkouts is paid.

### 6. What each party sees

**Buyer**

| Place | What |
|---|---|
| Cart | The "Rabattkod" box: field, "Applicera", and "Ta bort" once a code is stored. A "Rabatt" row with the preview's amount. "Koden kan inte användas för den här varukorgen." when the answer is `applies: false`. The cart shows no total (`ShoppingCart.jsx:22-28`). |
| Payment step | The server's figures (`Checkout.jsx:155-164`): "Rabatt −X kr" (`:895-905`) and "🎉 Rabatt aktiverad! Kod: X" (`:945-975`, existing). **New:** when the code was sent and `discountMinor` is 0, "Rabattkoden X kunde inte användas för den här beställningen." with "Ta bort koden". |
| Confirmation page | "Rabatt (SOMMAR20) −59,80 kr" (§7.1 replaces the affiliate label, finding F6). |
| Receipt mail | "Rabatt (SOMMAR20): -59,80 kr". |

**Seller**

| Place | What |
|---|---|
| The code list | Code, value, scope (+ minimum), period, "Använt 3 / 10" plus "(1 i kassan)" when held, status. |
| Order detail | Subtotal, "Rabatt (SOMMAR20)" −X, shipping, VAT, total. Then the **one fee** "Avgift (plattform & produktion)" and the payout (`OrderPaymentCard.jsx:63-80`), unchanged. The discount is the seller's own campaign, not a platform fact. The one-number rule is untouched: no field of the fee's split is added (I7). |
| Order list, dashboard | Totals only, unchanged. |
| Shop notice mail | "Rabatt (SOMMAR20): -X". |

**Platform**

- No new screen.
- The add-on switch per shop in "Tillägg" (`PlatformAddons`, key already allowed: `tenant-config.ts:111-118`).
- Acting as a shop, the platform user uses the seller's page.
- Reconciliation, payouts, DAC7 and alerts are unchanged: all run on charged amounts and frozen fees.

### 7. Frontend

#### 7.1 Storefront (both builds share these pages)

| File | Change |
|---|---|
| `src/api/discountCodes.js` (new, + `.test.mjs`) | `previewDiscountCode({ code, items }, { signal })` → `POST /v1/discount-codes/preview`; resolves the `discount` object. |
| `src/storefront/providers/Cart.jsx` | Replace the stubs (`:4-7`, `:39`, `:197-215`). `cart.discountCode` is persisted (`emptyCart`/`loadStoredCart`, `:43-54`); the last preview `{ code, applies, discountMinor }` is kept in state. `applyDiscountCode(raw)` returns `{ success, message }`, the contract the shared page reads (`CartContext.jsx:426-510`). `removeDiscount()`. A debounced re-preview when the items change. Clear the stored code when `useShopFeatures().isEnabled('discountCodes')` is false once the storefront is ready (the provider sits inside `ShopFeaturesProvider`, `Providers.jsx:18-20`). `calculateTotals()` returns `discountAmount` (kronor, from an applying preview), `discountCode`, and `discountSource: 'campaign'` when above 0. |
| `src/pages/shop/ShoppingCart.jsx` | Restore the "Discount Code Section" removed in `f26d616e` (`git show f26d616e -- src/pages/shop/ShoppingCart.jsx`, the block before "Order Summary"), gated on `isEnabled('discountCodes')`. Add "Ta bort" when a code is stored, and the not-applying notice. The input's state stays local to the page; only "Applicera" reaches the cart. |
| `src/storefront/adapters/checkout.js` (+ test) | `buildCheckoutRequest({ …, discountCode })` adds `discountCode` when it is a non-empty string. Update the comments at `:124-125`. |
| `src/api/checkout.js` | Pass `discountCode` through (`:30-50`); drop the "No discount code is sent" comment (`:18-19`). |
| `src/components/shop/StripePaymentForm.jsx` | `discountCode: cart.discountCode` into `buildCheckoutRequest` (`:290-300`). Nothing else. |
| `src/pages/shop/Checkout.jsx` | The not-applied notice and "Ta bort koden" (`cart.removeDiscount()`), beside `:945-975`. |
| `src/storefront/adapters/order.js` (+ test) | `discountCode: totals.discountCode ?? null` (`:49`). |
| `src/pages/shop/OrderConfirmation.jsx` | `:389-403` (and `:303-324`): when `order.discountCode`, the label is `Rabatt ({{code}})`; otherwise the existing affiliate wording. |
| `src/storefront/dev/*` | Dev API answers the preview; `fixtures.json:45` `discountCodes: true` for one invented shop; money fixtures with a discounted checkout. |
| `src/locales/{sv-SE,en-US,en-GB}.json` | New keys below. |

New storefront texts (Swedish; the existing keys `discount_code` "Rabattkod", `enter_your_code` "Ange din kod" and `apply_button` "Applicera" stay):

| Key | sv-SE |
|---|---|
| `discount_code_added` | Rabattkoden är tillagd. |
| `discount_code_not_applicable` | Koden kan inte användas för den här varukorgen. |
| `discount_code_invalid_format` | Ange koden utan mellanslag. |
| `discount_code_rate_limited` | För många försök. Vänta en stund och försök igen. |
| `discount_code_unavailable` | Koden kunde inte kontrolleras just nu. Försök igen. |
| `discount_code_remove` | Ta bort |
| `checkout_discount_not_applied` | Rabattkoden {{code}} kunde inte användas för den här beställningen. |
| `checkout_discount_remove` | Ta bort koden |
| `order_confirmation_discount_code` | Rabatt ({{code}}) |

#### 7.2 Admin

The CP5 pattern (`19b0488e`): the page's Firebase code moves unchanged into a data module beside it, which the older build keeps, and the admin build aliases that module to an API implementation.

| File | Change |
|---|---|
| `src/pages/admin/adminDiscountCodesData.js` (new, older build) | The Firebase code of `AdminDiscountCodes.jsx`, moved **unchanged**: the two reads (`:63-86`), the duplicate check and `addDoc`/`updateDoc` (`:180-224`, now throwing `{ code: 'conflict' }` on a clash), the toggle (`:237`), the delete (`:251`), `normalizeAffiliateCode`, and the three date helpers as they are (`:526-545`). `SUPPORTS_DELETE = true`. |
| `src/admin-app/replacements/adminDiscountCodesData.js` (new) | The same names on the API. `loadDiscountCodes` → the list. `loadDiscountProducts` → `listAllProducts` (`src/api/admin/products.js:44`), not archived, sorted by name. `saveDiscountCode({ id, form })` → POST or a full PATCH carrying only the type's own value key. `setDiscountCodeActive`. `SUPPORTS_DELETE = false`. `normalizeCode`. Dates: `startsAt = stockholmDayStart(day)`; `endsAt = stockholmDayStart(next day) − 1` (`src/api/admin/time.js:37-50`); `dayInputOf(ms)` and `formatDay(ms)` in `Europe/Stockholm`. Money: kronor → öre rounded half up, percent → basis points rounded half up, minimum floored to whole kronor × 100 (as the old form, `:165`). A 409 is thrown with its `code` (`conflict` or `discount_code_in_use`). |
| `src/api/admin/discountCodes.js` (new, + test) | `listDiscountCodes`, `getDiscountCode`, `createDiscountCode`, `updateDiscountCode`, through `adminRequest` (`src/api/admin/client.js:242`). |
| `src/admin-app/adapters/discountCode.js` (new, + test) | `discountCodeRowFromApi` (öre/bp → the page's kronor/percent, `heldCount`) and `discountCodeBodyFromForm`. |
| `src/pages/admin/AdminDiscountCodes.jsx` | Imports from `./adminDiscountCodesData` only. This drops lines 2–14 and 18–19: `affiliateCalculations.js:123-124` would drag a Firebase chunk into the admin build. The data calls go through the module. The date helpers come from the module. The duplicate check leaves the page (server 409, or the old module). The trash button shows only when `SUPPORTS_DELETE`. "Använt" adds "(N i kassan)" when `heldCount > 0`. The end date's help text is "Valfritt. Koden gäller till och med detta datum." The 409 texts are "En kod med detta namn finns redan." and "Koden har redan använts och kan inte byta namn. Skapa en ny kod i stället." A code with whitespace gets "Koden får inte innehålla mellanslag." |
| `src/admin-app/pages.jsx` | `export { default as AdminDiscountCodes } from '../pages/admin/AdminDiscountCodes.jsx';` |
| `src/admin-app/AdminApp.jsx` | `{ path: '/admin/discount-codes', page: 'AdminDiscountCodes', guard: 'admin', feature: 'discountCodes' }` in `ADMIN_ROUTES` (`:29-50`); update the header comment (`:1-6`). |
| `vite.admin.config.js` | One alias row in `ADMIN_ALIASES` (`:41`): `['src/pages/admin/adminDiscountCodesData.js', 'src/admin-app/replacements/adminDiscountCodesData.js', 'AdminDiscountCodes: the codes by /v1/admin/discount-codes; deactivate, never delete; dates as Stockholm days, the end day inclusive']`. |
| `src/components/admin/OrderPaymentCard.jsx` | `:63-67`: `order.discountCode ? \`Rabatt (${order.discountCode})\` : <the existing affiliate label>`. |
| `src/admin-app/adapters/order.js` (+ test) | `discountCode: totals.discountCode ?? null` beside `:234`. |
| `src/admin-app/dev/*` | Dev API and fixtures for the four routes. |
| `guard/allowlist.txt` | Remove `src/pages/admin/AdminDiscountCodes.jsx` (`:201`); add `src/pages/admin/adminDiscountCodesData.js`. Count unchanged; baseline 294 stays. Precedent: `19b0488e` ("fifteen page files out, fourteen old-build data modules in"), although the file's header says lines are never added. The reviewer confirms. |

The menu entry needs no edit. `AppLayout.jsx:246-253`, `:474-481` and `:600-609` already gate it on `isAddonEnabled('discountCodes')`, and `adminShellScope` lets feature-gated entries open by themselves (`src/admin-app/replacements/adminShellScope.js:4-9`).

### 8. The feature flag and D81

#### 8.1 The switch

`tenant_features` key `discountCodes`, already allowed (`tenant-config.ts:111-118`), toggled by the platform (`PUT /v1/platform/tenants/:id/features`). Its default:

- D62's default is ON (`tenant-config.ts:154-157`).
- **Recommended: make it opt-in (DC2).** Add the key to `OPT_IN_KEYS` and update `EXPECTED_DEFAULTS` in `test/tenant-features.test.ts:49`. Then a code field appears only on shops the platform turned on.
- Not verified: which staging tenants have an explicit row. Check with `SELECT tenant_id, enabled FROM tenant_features WHERE feature_key = 'discountCodes'`.

Who reads it:

- The checkout and the preview (`isFeatureEnabled`; off → the code is worth 0, the code echoed).
- The admin routes (off → 404).
- The storefront and admin responses (§8.2).

When the platform turns it off, checkouts already open keep their frozen discount.

#### 8.2 Reversing D81 for discount codes: exactly what it touches

D81 (`DECISIONS.md:113`, `:158`) has two parts. (1) The public storefront reports every feature that is not ported as off. (2) The pages of features that are not ported left the build. Discount codes have no storefront page; their storefront part was the cart box and the cart provider's stubs. The admin page left the admin build (`CP5_GAP_ANALYSIS.md:42`).

The reversal touches:

1. `cloudflare/src/storefront/public-storefront.ts:46`: `PORTED_FEATURE_KEYS = ["pod", "discountCodes"]`. That one constant drives both the public `features` (`:88-102`) and the admin's (`src/routes/admin-session.ts:102-122`).
2. The tests that pin the old value:
   - `cloudflare/test/public-storefront.test.ts:172-176` (`on.discountCodes` false);
   - `cloudflare/test/admin-session.test.ts:475`, `:486-492`, `:512-516`.
3. The storefront cart, cart page, payment form, checkout page and confirmation page of §7.1. Note `Cart.jsx:4-7`, its message `:39`, and the comments in `api/checkout.js:18-19` and `adapters/checkout.js:124-125`.
4. The admin route, page line, alias and data module of §7.2.
5. **Design gate.** The cart page gains the "Rabattkod" box, so its storefront baseline changes. The 2026-10-04 storefront shots explained the box's absence by D81 (`HANDOVER.md:111`, `CP4_F_REPORT.md`). Re-shoot the cart page.
6. **Docs.**
   - `DECISIONS.md`: a new numbered decision recording the reversal for this key only (the number after the last one in use; D99–D103 appear in `HANDOVER.md`, not verified as the last).
   - `PLAN.md:106`: "discount-code admin" leaves §3.2.
   - `CP5_GAP_ANALYSIS.md:42`: the row.
   - `MIGRATION_MANIFEST.md:83`: nothing to transform.
   - `HANDOVER.md`.

Nothing else of D81 moves: reviews, checkout recovery, affiliate, B2B and customer accounts stay off.

#### 8.3 The cached storefront response

`GET /v1/storefront` answers an ETag built by `etagFor` with `no-cache` (`src/storefront/public-routes.ts`, `etagFor` and `versionedJsonResponse`). At HEAD the ETag is `"<catalog_version>"`. The uncommitted CP6-PS4 work makes it `"<catalog_version>-c"` while the print canvas is on, for the same staleness reason. A deploy that changes `PORTED_FEATURE_KEYS` does not bump `catalog_version`. So a browser that revalidates gets a 304 with its stale body (`discountCodes: false`) until the next bump for that shop.

Fix: **after** the API deploy, run once `UPDATE tenants SET catalog_version = catalog_version + 1 WHERE status <> 'closed';` on the environment's D1. Not inside 0055: the migration runs before the deploy, so the old code would serve the new version number with the old body. The `tenants` update triggers do not stop this (`0019_money.sql:65-72` and `0038_connect_onboarding.sql:86-95` refuse only rows that are already incoherent).

A lasting fix is a follow-up (finding F10): a response-revision constant in `etagFor`, beside PS4's `-c`, bumped whenever a code change alters a public body.

### 9. Build plan

**Model:** Opus. Money, schema and checkout are all in it (memory: Opus for money/schema).

**Coordinate first:** this touches `app.ts`, `checkout.ts`, `webhook.ts`, `stripe-events.ts` and `crons.ts`. When this design was finished, the tree held uncommitted CP6-PS4 changes to `app.ts`, `checkout.ts` (`resolveLines` gains `refuseStandInFrames`) and `public-routes.ts` (`etagFor` gains the tenant). Start only after that unit is committed, and re-read the cited lines against the new HEAD.

Steps, in order. Each ends with `cd cloudflare && npx tsc --noEmit && npx vitest run <the step's files>`.

| # | Step | Files | Tests (rule → test) |
|---|---|---|---|
| 1 | Migration | `migrations/0055_discount_code_holds.sql`; `app.ts:484`; `test/health.test.ts`, `test/public-catalog.test.ts` (the pin) | New `test/discount-code-holds-schema.test.ts`: each trigger refuses its case and lets the legal cases through (born held; match checkout, including another tenant's code and a checkout of another code; capacity at cap−1 / cap, with the same buyer excluded, distinct buyers counted once, expired and released holds not counted, no cap means no refusal; transitions, all 9 pairs; frozen columns; no delete; the code-frozen trigger, including that the burn's `UPDATE used_count` still passes on a code with holds); both CHECKs. |
| 2 | Engine | `src/commerce/discount-codes.ts`: `isEligible(row, subtotal, now, heldByOthers)`; `resolveDiscount(…, holds: { buyerKey } \| null)` with the subquery; `DISCOUNT_HOLD_TTL_MS`, `MIN_CHARGE_MINOR`; `discountViable({ subtotalMinor, shippingMinor, discountMinor, withholdMinor, commissionBps })`; `isDiscountExhausted(error)`. `src/commerce/payment.ts`: export `readCheckoutCommissionBps(db, tenantId)` (the `:522-531` resolution, for a tenant id). | Extend `test/discount-codes.test.ts`: held-by-others arithmetic; `discountViable` on examples B, C (5 %, 10 %, 20 %), D, E, the 35 % case, each with the öre of §3.3. **Change** `:556-565` ("allows a full-value code to zero the basket"): now `discountMinor 0`, `totalMinor 2000`. |
| 3 | Checkout | `src/commerce/checkout.ts` (flag check, buyer key, undiscounted snapshot ceiling, R2/R3, hold insert, the one retry; export `resolveLines`, `resolveCurrency`); `app.ts` `handleCheckoutRoute` (the `discount-attempt-ip` limit and its constants) | New `test/checkout-discount-holds.test.ts`. Without a code: byte-identical rows and snapshot to today. Flag off: code echoed, 0, no hold. A hold row with the right expiry and buyer key. Two buyers, one use: sequential, and **the race**, by wrapping `env.DB` so the first `batch` throws `discount code exhausted`, then 201 with `discountMinor 0` and no hold. Same buyer twice: both apply. Replay with a hold: 200, no second hold. R2 on C at 10 %: 201, `discountMinor 0`, total 26 300, `production_snapshot_json` identical. R3 on E. Example D applies. The attempt limit: the 21st code-carrying checkout answers 429, and code-less checkouts are not counted. |
| 4 | Lifecycle | `src/commerce/webhook.ts:752-783`; `src/commerce/stripe-events.ts:194-239`; `src/commerce/crons.ts:171-184` | Extend `test/webhook.test.ts`: held → used with `order_id`; released → used (a late success counts, `used_count` above `max_uses`, order created); the same buyer's other holds released; a checkout without a hold (pre-0055) burns as today; **the order batch never fails because of a hold**, in every state. `payment_intent.canceled` releases; `payment_failed` does not; the sweep's cancel releases; a late `succeeded` after the sweep's cancel attempt (Stripe refused) leaves the hold to the webhook. |
| 5 | Preview route | `src/commerce/discount-preview.ts`, `src/routes/storefront-discount-preview.ts`, `app.ts` mount; `web/src/api-allowlist.ts` + `test/web-routing.test.ts` | New `test/discount-preview.test.ts`: the uniform answer for each of the ten misses (byte-equal bodies); another tenant's code; holds ignored; 400, 404, 422, 429 (the 31st); nothing written (row counts before and after). |
| 6 | Admin | `src/commerce/admin-discount-codes.ts` (list, `heldCount`, rename lock, `valueMinor ≥ 1`), `app.ts` `handleAdminDiscountCodeRoute` (GET list, flag gate) | Extend `test/admin-discount-codes.test.ts`: list order, bound and `truncated`; `heldCount`; flag off → 404 for all four; rename refused after use and after a hold, allowed before; `valueMinor: 0` → 400; acting-as allowed. |
| 7 | Views | `src/commerce/admin-orders.ts`, `src/commerce/receipts.ts`, `src/outbox/email-effect.ts`, `src/email/order-emails.ts`, `src/email/auth-email-job.ts` | `discountCode` in each view, null without a code; the existing denylist suites (admin-orders, receipts) still pass; the mails' text. |
| 8 | D81 | `src/storefront/public-storefront.ts:46`; (DC2) `src/platform/tenant-config.ts` `OPT_IN_KEYS` | Update `test/public-storefront.test.ts:172-176`, `test/admin-session.test.ts:475-516`, (DC2) `test/tenant-features.test.ts:49`. |
| 9 | Storefront | §7.1 | `src/api/discountCodes.test.mjs`; `src/storefront/adapters/checkout.test.mjs` (`buildCheckoutRequest` with and without a code; never from the input's text); `order.test.mjs`; dev API tests. |
| 10 | Admin frontend | §7.2 | `src/api/admin/discountCodes.test.mjs`; `src/admin-app/adapters/discountCode.test.mjs` (12.5 % → 1250 bp; 49,90 kr → 4990; minimum 199,90 → 19900; start `2026-10-01` → the Stockholm midnight instant; end `2026-10-31` → `stockholmDayStart('2026-11-01') − 1`, including across the DST change on 2026-10-25; and back); dev API tests. |
| 11 | Docs | §8.2 item 6 | none |

**Mutations to run** (each must fail at least one test; restore and `cmp` after each):

1. The capacity trigger is a no-op.
2. The trigger counts the same buyer.
3. The trigger counts `COUNT(*)` instead of `COUNT(DISTINCT buyer_key)`.
4. It counts expired holds.
5. It counts released holds.
6. The resolver ignores holds.
7. The resolver includes the buyer's own hold.
8. The exhausted catch is removed (the race answers 500).
9. The retry keeps the discount.
10. The retry loops more than once.
11. The flag check is removed.
12. R2 is skipped.
13. R2 is checked against the undiscounted total.
14. R3 is skipped.
15. The snapshot ceiling uses the discounted total (C at 20 % becomes 422).
16. The webhook's `used` update is removed.
17. The same-buyer release is removed.
18. The `used` update without `'released'` (a late success stays released).
19. The cancel release is removed.
20. A `payment_failed` release is added.
21. The preview reveals a reason (one body differs).
22. The preview limit is removed.
23. The attempt limit counts code-less checkouts.
24. The rename lock is removed (app level, and the trigger alone).
25. `valueMinor: 0` is accepted.
26. The admin flag gate is removed.
27. `PORTED_FEATURE_KEYS` without `discountCodes`.
28. `buildCheckoutRequest` sends the code when empty.

**Gates (all, at the end):**

- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`
- `cd cloudflare && npx vitest run` (read the summary line; expect only added tests)
- `cd cloudflare && npm run types:check`
- `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs`
- `npx vite build`; `npx vite build --config vite.storefront.config.js && node cloudflare/web/check-storefront-build.mjs`; `npx vite build --config vite.admin.config.js && node cloudflare/admin/check-admin-build.mjs`
- `node guard/guards.test.mjs` (allowlist count = baseline 294)
- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`

**Staging smoke** (after the reviewer's yes; production never):

1. Apply 0055 to staging D1 (the runbook's migration command, through `scripts/cf-preflight.sh staging`). Bookmark before. Deploy API, web, admin. `/ready` reads 0055.
2. The catalogue bump of §8.3 on staging D1.
3. As the platform user: in "Tillägg", turn "Rabattkoder" on for the test shop (if DC2).
4. In the admin, acting as the shop, create:
   - `SMOKE20`: 20 %, whole cart, max 2 uses;
   - `FIXED50`: 50 kr;
   - `POD10`: 10 % on a POD product priced at its floor (melodie-mc, if a sellable POD product exists on staging: not verified).
5. In the storefront cart:
   - "smoke20 " → "Rabattkoden är tillagd." and a "Rabatt" row;
   - "NOPE" → the uniform text;
   - the 31st preview within 10 minutes → the rate-limit text.
6. Pay with card 4242:
   - the payment step shows the discount; the confirmation reads "Rabatt (SMOKE20)";
   - the seller's order shows the discount, one fee and the payout;
   - D1: the hold is `used` and `used_count` is 1.
7. The race: browser A reaches payment with `SMOKE20` (1 use left), then browser B → B's payment step says "kunde inte användas" and B's total has no discount. A pays → `used_count` 2.
8. `POD10` on the floor-priced product → 201, `discountMinor 0`, the notice. A 5 % code on it applies.
9. Refund 10 kr, then the rest → payout = charged − refunds − fee. A third refund is refused.
10. Cancel an open test PaymentIntent in the Stripe test dashboard → its hold is `released`.
11. If Resend is configured on staging (not verified): both mails carry "Rabatt (SMOKE20)".

### 10. Decisions for Mikael (yes/no; "defaults" accepts all)

| # | Question | Recommended | Alternative |
|---|---|---|---|
| DC1 | Bring Rabattkoder back on Cloudflare (reverse D81 for this feature only: the cart's code box and the admin page return)? | **Yes** | No: stays PORT-LATER. |
| DC2 | Make Rabattkoder opt-in per shop (off until the platform turns it on)? | **Yes** | No: keep D62's default ON, so every shop without its own setting shows the box. |
| DC3 | Hold a use for 60 minutes from the moment a buyer reaches payment, so two buyers can never both take the last use? | **Yes, 60 min** | Hold for the checkout's 24 h (fewer overshoots, longer blocks), or no hold (count at payment as Firebase did; caps can be overshot). |
| DC4 | Keep the hold when a card is declined (the buyer can try another card), and release it only when the payment is cancelled or the hold runs out? | **Yes** | Release on every failed attempt. |
| DC5 | If a code would leave the shop less than the platform fee and the print cost, does the code simply not apply (the buyer pays full price and is told)? | **Yes** | Shrink the discount until it fits (the shop earns 0 on that order). |
| DC6 | Not apply a code that would leave less than 3,00 kr to pay? | **Yes** | Shrink it so 3,00 kr remain. |
| DC7 | Commission on what the buyer actually pays, after the discount (as today and in Firebase)? | **Yes** | On the price before the discount. |
| DC8 | Never discount shipping? | **Yes** | Add free-shipping codes later as a new feature. |
| DC9 | Store no per-line split of a discount now? | **Yes** | Freeze a per-line split on every order now, for future line refunds. |
| DC10 | Round a percentage discount to the öre (Firebase rounded up to whole kronor)? | **Yes** | Whole kronor, at most 99 öre more discount. |
| DC11 | Give one answer for every code that does not apply ("Koden kan inte användas för den här varukorgen.")? | **Yes** | Say the minimum order value when that is the only reason (Firebase did; it confirms the code exists). |
| DC12 | Deactivate codes, never delete them (the trash button leaves the page)? | **Yes** | Allow deleting a code nobody has used. |
| DC13 | Refuse renaming a code once it has been used or reserved? | **Yes** | Allow it (old orders would then show the new name). |
| DC14 | The admin's discount-code routes answer "not found" while the shop's switch is off? | **Yes** | Let the seller edit codes while the add-on is off. |
| DC15 | An end date counts through 23:59:59 Stockholm time on that day (Firebase stopped at the start of the day)? | **Yes** | Keep Firebase's meaning. |
| DC16 | Limits against code guessing: 30 code checks and 20 checkouts carrying a code per visitor per 10 minutes? | **Yes** | Other numbers. |
| DC17 | For the affiliate port later: one code namespace per shop, and a collision between an affiliate code and a campaign code is refused when the second one is created (D30's default)? | **Yes** | Affiliate wins at checkout, as Firebase. |

### 11. Risks and what is left out

**Risks**

1. **The cap is soft at its edges.** A payment after its 60-minute hold, or one buyer paying two of their own checkouts, can take `used_count` above `max_uses` (§2.3). The seller sees "11 / 10". A hard cap would need manual capture of the payment (authorise, then capture after a check). That is not in this design.
2. **Holds block during a rush.** An abandoned checkout blocks one use for up to 60 minutes. A "first 50 buyers" campaign can read as full while some of the 50 are still deciding.
3. **Hold release by email.** Someone who knows a buyer's email and the code can, by paying a checkout under that email, release that buyer's other holds. Effect: an overshoot by one. Bounded by the per-email checkout limit (`app.ts:495-497`).
4. **Preview and checkout can disagree.** The preview ignores holds, R2 and R3. The payment step then says the code could not be used. This is rare: a race, a POD basket near its floor, or a total under 3 kr.
5. **Code guessing stays possible** across many addresses. Campaign codes are guessable by design ("SOMMAR20"). The limits slow a single network (the /64 for IPv6).
6. **The hot path costs one more subquery,** `COUNT(DISTINCT)` over live holds of one code, on its index. A viral code's live holds are bounded by 60 minutes of checkouts.
7. **The commission is read twice.** The checkout's R2 reads it; the payment reads it again and freezes it. If the platform changes it in between, the payment's backstop answers the opaque 404, as today.
8. **Parallel work.** Five Worker files overlap with what other builders touch.
9. **Legal, not verified.** Whether an advertised percentage code on named products is a price-reduction announcement under prisinformationslagen 7 a § (the 30-day lowest price). The seller's own responsibility, but worth a line in the help text.
10. **ETag staleness** after the deploy, if the step in §8.3 is forgotten.

**Left out**

- Affiliate codes.
- Per-customer limits ("once per buyer").
- Stacking several codes.
- Automatic (codeless) discounts.
- Free-shipping codes.
- Variant-level scope.
- Line refunds and a per-line split (DC9).
- Discount reporting.
- A platform alert on overshoot.
- Several VAT rates per shop.
- Importing codes from Firebase (0 exist).
- Cancelling a superseded checkout's intent early.
- Freezing the commission at checkout.
- The general fix for an undiscounted POD basket that fails the fee check (F2).

### 12. Found wrong in the existing code

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **The checkout applies a code without checking the shop's `discountCodes` switch.** `isFeatureEnabled` has no caller in `cloudflare/src` at all. The storefront reports the feature off (D81), but `POST /v1/admin/discount-codes` is reachable through the admin Worker's `/v1/admin/` prefix today. A seller or platform user can create a code, and a crafted checkout body gets the discount. Firebase checked the switch. | `checkout.ts:1172-1182`; `tenant-config.ts:180-200`; `cloudflare/admin/src/allowlist.ts:30-35`; `createPaymentIntent.ts:273` | Medium: real money, but only on a code the shop created itself. |
| F2 | **A POD basket can pass checkout and then be refused at payment with the opaque 404.** The checkout refuses only W > T; the payment refuses commission + W > T. The storefront then says "Butiken tar inte emot beställningar ännu." A discount makes this reachable (example C at 10 %). So does an undiscounted product whose tier price rose after it was published. | `checkout.ts:1104`; `payment.ts:532-544`; `StripePaymentForm.jsx:374-379` | Medium: a lost sale with a wrong message. Fixed for discounts by R2. Undiscounted: follow-up. |
| F3 | **A full-value code makes a checkout of 0 öre**, accepted and pinned by a test. Its PaymentIntent cannot be created (Stripe's minimum, not verified live), so the payment route answers 502. | `discount-codes.test.ts:556-565`; `checkout.ts:728`; `app.ts:1417-1427` | Low (no codes today). Fixed by R3. |
| F4 | **The rounding parity claim is wrong in its unit.** The comment says production's `Math.ceil` is reproduced exactly; production rounded kronor, so whole kronor, while Cloudflare rounds öre. | `discount-codes.ts:109-116`; `createPaymentIntent.ts:312` | Doc only; DC10. |
| F5 | **The old admin page's dates** exclude the end day (local midnight at its start) and shift a day back on every edit (UTC display). | `AdminDiscountCodes.jsx:526-538` | Low (the old build; 0 codes). Fixed for the new build by DC15. |
| F6 | **Every discount is labelled as an affiliate's.** The seller sees "Affiliate-rabatt (AFFILIATE), 0%"; the buyer sees "Rabatt (AFFILIATE) 0%". Latent while no discount exists. | `OrderPaymentCard.jsx:63-67`; `OrderConfirmation.jsx:389-403` | Low; fixed in §7. |
| F7 | **The admin parser accepts a fixed code worth 0,** which then silently discounts nothing. The old form refused it. | `admin-discount-codes.ts:307-317`; `AdminDiscountCodes.jsx:147-151` | Low. |
| F8 | **The old validate callable** gives any anonymous caller a valid code's whole terms, with no rate limit in its definition. | `validateDiscountCode.ts:17-21`, `:110-119` | Old build only; not ported. |
| F9 | **The old page imports `normalizeAffiliateCode`** from a module with a dynamic Firebase import. Porting the page as it is would put Firebase into the admin build. | `AdminDiscountCodes.jsx:19`; `affiliateCalculations.js:123-124` | Build blocker if missed; §7.2. |
| F10 | **The storefront ETag carries no code revision.** At HEAD it is the catalogue version only; CP6-PS4 adds `-c` for its own switch. A deploy that changes the response in code (here `PORTED_FEATURE_KEYS`) leaves revalidating browsers on a stale 304 until the shop's next bump. | `public-routes.ts` `etagFor`, `versionedJsonResponse` | Low; the §8.3 step now, a revision constant as follow-up. |
| F11 | **The guard allowlist's rule and its practice differ.** The header says a line is never added; CP5 swapped page files out and data modules in. | `guard/allowlist.txt:3-7`; commit `19b0488e` | Process. The reviewer decides the wording. |

Seen, outside scope: `isFeatureEnabled` having no caller also means no Worker path checks the `pod` switch (D62 says one will). Not investigated further.
