# CP9-AC: abandoned-cart reminders ("Övergiven kassa") on Cloudflare

Design only, on branch `cf-port` at HEAD `de39e82e`, tree clean at the start. Nothing else in the tree was edited. No git write, no network request, no deploy, no test or build run. Every claim about code cites the file and the lines I opened on 2026-10-05. Where I could not check something, the text says "not verified". **No rule of law is stated as fact here.** A legal point is given with its source: the old code's own comments, a document of this repository, or the owner's notes (the owner's memory note `abandoned_cart_direction.md` of 2026-07-06, which is not in the repository). Each one is marked "not verified" and comes back as a decision in §11.

## Design (phase 1)

### 0. Read this first

**What exists on Cloudflare: the inputs, not the feature.** A checkout row holds the buyer's address and its expiry, and freezes a consent that has a `marketing` box. One cron runs every 15 minutes. Mail goes through the outbox, the mail queue and a delivery ledger. The feature key `abandonedCheckout` is allowed per shop, but the storefront reports it off (D81). There is no reminder table, no route, no page, no mail kind and no "remind me" box.

**The shape of the port.**
- A cron step decides once per checkout: remind, or skip with a recorded reason.
- A reminder is an outbox row in the same batch as the decision. Its effect builds ONE mail of a new ledger kind, `checkout_reminder`.
- The mail carries two links. Their tokens are HMACs derived from an existing secret, so nothing secret is stored.
- Two public routes: one rebuilds the cart (line references only), one unsubscribes (keyed on a hash of the address).
- The storefront rebuilds the cart through the normal cart path. The normal checkout prices it from scratch. No price is carried over.
- The seller has an on/off switch and a delay on the settings page. The platform keeps its add-on switch.

**What is changed from Firebase, in one line each:**
- Consent: the purpose-specific box comes back. The rule stays Firebase's: that box OR the marketing box (AC4).
- A newer checkout of the same buyer supersedes an older one whatever its state, including a paid one. Firebase only looked at newer open ones (F3).
- Stripe is asked, right before deciding to send, whether the payment is still in progress. Firebase did not ask (F4).
- No prices in the mail (AC8).
- One-click unsubscribe works without JavaScript (F1).

**Migration number.** The next free number today is 0056 (`HANDOVER.md:78`, `:87`). The DAC7 design also plans 0056, 0057 and 0058 (`CP9_DAC7_REPORT.md:204`, `:503`, `:508`). The builder takes the next free number at build time. This text calls the file `00NN_checkout_reminders.sql`.

### 1. The old behaviour (Firebase), and what is ported, changed or dropped

#### 1.1 What the old code does

| Rule | Old behaviour | Evidence |
|---|---|---|
| Where the record is born | After the PaymentIntent exists, `createPaymentIntent` writes recovery fields onto `checkouts/{piId}` (best effort; a failure never touches the payment). | `functions/src/payment/createPaymentIntent.ts:1031-1056`; `functions/src/checkout-recovery/writeCheckoutDoc.ts:93-160` |
| What it stores | `customerEmail`, `emailNorm` (lower case), name, first name, language (`preferredLang` or `sv-SE`), `consent {marketing, remindMe}`, the server-priced items (productId, variantSku, sku, name, label, price, quantity), totals, a RAW 32-byte `recoveryToken`, `remindAt`, `expiresAt` (7 days), `status: 'open'`. It skips a checkout with no address. | `writeCheckoutDoc.ts:100-159`; `tokens.ts:16-19` |
| Delay | `shops/{id}.cartRecovery.delayHours`, rounded and clamped to 1–24, default 1. Read when the checkout is written. A read error falls back to 1. | `writeCheckoutDoc.ts:11-15`, `:81-91`, `:126-128` |
| Consent sources | The checkout showed two pre-unticked boxes: "Skicka mig nyheter och erbjudanden via e-post" (`marketing`) and "Påminn mig via e-post om jag inte slutför köpet" (`remindMe`). They were shown on every shop, add-on on or off. Both went to the PaymentIntent and its metadata. | `git show main:src/pages/shop/Checkout.jsx` `:161-168`, `:775-800`, `:1131-1139`; `createPaymentIntent.ts:374-375`, `:855-856` |
| Webhook | `payment_intent.succeeded` marks the doc `completed`. `payment_intent.payment_failed` marks it `failed`, so it is never reminded (the commit calls this the card-testing filter). | `functions/src/payment/stripeWebhook.ts:641-657`, `:718-737`; commit `a74f4891` message |
| The sweep | Every 15 minutes, up to 50 docs with `status == 'open'` and `remindAt <= now`. Each in its own try/catch. | `functions/src/checkout-recovery/sweep.ts:45-53`, `:151-164`, `:169-315` |
| Checks, in order | invalid doc → order `orders/{piId}` exists (marked `completed`) → status re-read → expired (7 days) → consent `marketing OR remindMe` → suppression → superseded (a NEWER OPEN checkout of the same shop + email) → frequency cap (a `reminded` doc for shop + email in the last 24 h) → add-on flag (default ON). Each skip writes `status: 'skipped'` and a `suppressionReason`. | `sweep.ts:179-268` |
| Send | Marked `reminded` BEFORE sending (at most once). A transport failure reverts to `open` for the next sweep. Mail type `ABANDONED_CHECKOUT_REMINDER`. | `sweep.ts:270-308` |
| Links | `{B2C_SHOP}/{shopId}/aterta/{token}` and `{B2C_SHOP}/{shopId}/avregistrera/{token}`: the SAME token for both. | `sweep.ts:28-36`, `:289-290` |
| The mail | Shop-branded. Swedish, or English for an `en` language. "Hej {first name}," / "Hej,". Item rows WITH prices, shipping, discount and total. Subject "Du glömde något i kassan hos {brand}". Button "Slutför köpet". Footer link "Avregistrera dig från påminnelser". From `"{shop name}" <platform address>`, Reply-To the shop's support address. `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` pointing at the unsubscribe PAGE. | `functions/src/email-orchestrator/templates/abandonedCheckoutReminder.ts:45-123`; `EmailOrchestrator.ts:316-333`, `:840-853`, `:881-885` |
| Resolve | `resolveCheckoutRecovery({shopId, token})`: equality query on shop + raw token. Unknown → `invalid`. `completed` → `completed`. Past `expiresAt` → `invalid`. Anything else (open, reminded, failed, skipped) → `open` + line refs `{productId, variantSku, sku, quantity}`. No prices, no personal data. No rate limit in its definition. | `functions/src/checkout-recovery/callables.ts:36-44`, `:57-86` |
| Unsubscribe | `unsubscribeCheckout({shopId, token})`: unknown token → `not-found`. Writes `checkoutSuppressions/{shopId}_{sha256(emailNorm)}` `{shopId, emailHash, createdAt, source}`. A write failure is swallowed and answered as success. Works whatever the checkout's status. | `callables.ts:92-132`; `tokens.ts:21-29` |
| Recovery page | `/{shopId}/aterta/:token`. Resolves on mount. Invalid → silent redirect to the shop's home. Completed → "Köpet är redan genomfört". Open → `clearCart()`, then for each line reads `productsPublic/{id}` (same shop, active, sold to consumers), matches the variant by sku, `addToCart`; any line missing → toast "Vissa varor har uppdaterats sedan du var här sist."; then to `/{shopId}/checkout`. `noindex`. No add-on gate ("the recovery link must never dead-end"). | `src/pages/shop/CheckoutRecoveryPage.jsx:13-108`, `:110-160` |
| Unsubscribe page | `/{shopId}/avregistrera/:token`. Calls on mount. Shows "Du är avregistrerad från påminnelser" whatever the answer. | `src/pages/shop/CheckoutUnsubscribePage.jsx:10-44`, `:56-70` |
| Admin | Inställningar, card "Övergiven kassa" when the add-on is on: one number field "Fördröjning innan påminnelse (timmar)", 1–24, default 1. **No list of checkouts and no buyer address anywhere in the admin.** | `src/pages/admin/AdminSettings.jsx:82-88`, `:160-176`, `:209-222`, `:1021-1052`; `src/config/shopConfig.js:99-135`; no file under `src/` reads `checkouts` (searched) |
| Rules | `checkouts` and `checkoutSuppressions`: no client access. | `firestore.rules:828-852` |
| Add-on default | ON unless explicitly false. Fails OPEN on a read error. | `functions/src/config/shopFeatures.ts:22`, `:33-48` |
| Retention | Recovery docs without a production snapshot deleted after 30 days. Snapshot docs deleted after their PI is cancelled. | `sweep.ts:56-81`, `:87-149`; `writeCheckoutDoc.ts:16`, `:70-73` |
| Production data | 0 `checkouts`, 0 `checkoutSuppressions` at the 2026-09-27 export. The manifest says suppressions "must be restored before reminders are re-enabled". In that export no shop holds `cartRecovery` (searched the five shop documents). `abandonedCheckout` is explicitly `true` on melodie-mc and robowatz and absent (so ON in Firebase) on gif-sundsvall, ninetone and sillmans. | `docs/cf-port/MIGRATION_MANIFEST.md:44`, `:72-73`; `~/chopshop-export/export-2026-09-27T15-02-15.414Z/shops/part-00001.jsonl` |

The owner's consent decision of 2026-07-06 (memory note, not in the repository; not verified as law): soft opt-in under MFL 19 § second paragraph does not cover a buyer who did not complete a purchase, so a reminder needs the marketing box OR the purpose-specific box; every mail carries an unsubscribe link (MFL 20 §) and the List-Unsubscribe header. The repository restates the rule as the source of `consent.marketing` (`docs/cf-port/CP2_E_REPORT.md:169`) and records that `remindMe` was left for this port (same line; `docs/cf-port/CP4_F_REPORT.md:24` lists the box as removed by D81).

#### 1.2 What exists on Cloudflare today

| Piece | Where | State |
|---|---|---|
| Checkout row with the address (lower-cased by the parser), `created_at`, `expires_at` (24 h), `status`, `payment_intent_id`, `payment_intent_status` | `cloudflare/src/commerce/checkout.ts:204`, `:255-271`, `:1410-1447`; `migrations/0009_checkout_totals_v2.sql:76`, `:193-194`; `migrations/0019_money.sql:110-118` | Built. Status `open` → `completed` (webhook) or `abandoned` (retention sweep). Nothing writes `expired` (searched). |
| One checkout per distinct request | `src/components/shop/StripePaymentForm.jsx:281-301`, `:312-409` | A changed country, delivery method, code or withdrawal tick makes a NEW checkout and a new intent. One buyer often has several checkouts. |
| Consent frozen on the checkout | `cloudflare/src/legal/consent.ts:19-27`, `:65`, `:73-104`, `:143-181`; `migrations/0031_legal_consent.sql:143-158` | `terms`, `marketing`, the withdrawal waiver. No reminder fact. Frozen by trigger. |
| The retention sweep | `cloudflare/src/commerce/crons.ts:113-250` | Cancels an intent only after expiry AND 7 days without a change (`:132-146`). Clears only `production_snapshot_json` (`:226-231`). |
| The cron | `cloudflare/src/outbox/scheduled.ts:20`, `:77-80`, `:82-142` | One `*/15` cron. Steps are isolated; the digest runs last. |
| Outbox + mail | `cloudflare/src/outbox/outbox.ts:38-46`; `outbox/effects.ts:24-30`; `outbox/email-effect.ts:32-77`, `:595-645`; `email/email-queue-consumer.ts:136-200`, `:288-303` | Built. `outbox_events.event_type` is NOT an enum (`migrations/0021_outbox_claims.sql:64-69`). `email_deliveries.kind` IS a CHECK (`migrations/0050_email_kinds.sql:34-38`). |
| No mail account on staging | `email-queue-consumer.ts:85-99`, `:292-303`; `platform/invites.ts:105-107` | The consumer holds every job (retry every 300 s); the ledger row stays `pending`. |
| Feature key | `platform/tenant-config.ts:111-118`, `:151-162`; `storefront/public-storefront.ts:54`, `:104-117` | Allowed, default ON, reported off to the storefront and the admin (`routes/admin-session.ts:108-122`). |
| `ordersOpen` | `storefront/public-storefront.ts:68-75`, `:200`; `commerce/payment.ts:239-244` | The legal gate AND the account's destination-charge test. |
| Old pages | `src/storefront/StorefrontApp.jsx:19-36`; `src/storefront/pages.jsx` | No `/aterta` or `/avregistrera` route: such an address shows the not-found page. Both old pages still import Firebase (`guard/allowlist.txt:238-239`). |
| Admin | `src/admin-app/replacements/shopConfig.js:35-36`, `:199-203` | `loadCartRecovery` answers `{}`; `saveCartRecovery` refuses ("Övergiven kassa" not available). |

#### 1.3 Ported, changed, dropped

| Rule | Fate | Reason |
|---|---|---|
| One reminder per checkout, consent-gated, suppression per shop + address hash, supersede, frequency cap, add-on switch, delay 1–24 h (default 1), line refs only, the cart rebuilt through the normal path, no add-on gate on the two pages | **Ported** | The behaviour, and the owner's decision. |
| The purpose-specific box | **Ported back** (AC4) | Removed in CP4-F only because the feature was not ported (`CP4_F_REPORT.md:24`). |
| Where the decision is recorded | **Changed**: a table `checkout_reminders`, not fields on the checkout | A reminder must not move the checkout's retention clock (`crons.ts:141`) and must not fight the frozen-column triggers (§3.1). |
| The token | **Changed**: an HMAC derived from `BETTER_AUTH_SECRET`, never stored. Separate purposes for "resume" and "unsubscribe" | The token travels in a mail job that must be byte-identical on every retry, and an outbox row may hold no secret or personal data (`email-effect.ts:65-73`). |
| Supersede | **Changed**: ANY newer checkout of the same address in the shop, whatever its state | Firebase only looked at newer OPEN checkouts: a buyer who paid in a later checkout was reminded about the earlier one (F3). |
| Payment in progress | **Changed** (new check): Stripe is asked before sending (AC10) | Cloudflare never records `processing` (`stripe-events.ts:96-97` handles only failed and cancelled). Firebase did not check either (F4). |
| Frequency cap | **Changed**: 7 days instead of 24 h (AC6), enforced by a trigger as well as by the check | The abuse case (§12.1, R1) and the "one nudge" intent. |
| Which checkouts count | **Changed**: only checkouts made while the seller's switch was on, and never more than 24 h late (AC3, AC7) | Turning the switch on must not mail yesterday's buyers. Firebase's 7-day window existed because its sweep could lag. |
| Prices and totals in the mail | **Dropped** (AC8) | They can be stale. The checkout prices the rebuilt cart again. The old template also showed a "Rabatt" row although its header says "no discount language" (F7). |
| English mail | **Dropped** (AC16) | Every Cloudflare buyer mail is Swedish (`email/order-emails.ts:101-114`); the storefront is Swedish only (`src/storefront/providers/Translation.jsx:9-10`). |
| First name | **Changed**: the recipient's name as the checkout froze it (`checkout_recipients`, `commerce/recipient.ts:350-364`), read live, as the order mails do | Cloudflare stores one name field (D98). |
| Unsubscribe page that claims success on failure | **Changed**: it says what happened (F2) | Honesty. |
| One-click unsubscribe | **Changed**: the header points at an API route that acts on POST (F1) | A mail client's POST cannot run a page's JavaScript. |
| Fail-open add-on read | **Dropped** | `isFeatureEnabled` does not fail open (`tenant-config.ts:177-205`). |
| The box shown on every shop | **Changed**: shown only while the shop actually sends reminders (§8.1) | Consent should not be asked for something that will not happen (F6). |
| The 30-day purge of recovery docs | **Not ported** (§12.1, R10) | Cloudflare's checkout rows are not purged at all today; that is D68's question, not this unit's. |

### 2. Consent

#### 2.1 What the buyer is shown and ticks today on Cloudflare

- **Contact step** (`src/pages/shop/Checkout.jsx:501-542`): the e-mail field and ONE pre-unticked box, "Skicka mig nyheter och erbjudanden via e-post" (`:522-533`; key `checkout_marketing_opt_in`, also in `src/locales/sv-SE.json:266`). State `contactInfo.marketing` (`:140-143`).
- **Payment step**: the withdrawal waiver box, only for a personalised line (`Checkout.jsx:799-811`). The terms are accepted by the sentence under the payment form, not by a box (`:868-870`; `src/storefront/adapters/checkout.js:73-78`).
- **What is sent.** `StripePaymentForm` builds the body with `marketing: customerInfo?.marketing` (`StripePaymentForm.jsx:289-302`). The adapter sends `consent: { terms: true, marketing: marketing === true }`, plus the waiver when required and ticked (`adapters/checkout.js:84-104`).
- **When it is sent.** The checkout row is created only on the payment step (`StripePaymentForm.jsx:312-364`). A buyer who leaves at the contact or delivery step leaves no checkout and gets no reminder, as in Firebase, whose record also came after the PaymentIntent.

#### 2.2 What is frozen

`checkouts.consent_json`: `{ v: 1, terms: true, marketing, withdrawal: {…}, recordedAt }` (`consent.ts:22-26`, `:161-180`). It is written once (`checkout.ts:1394-1401`, `:1445`) and frozen by trigger (`0031:152-158`). The webhook copies it verbatim to the order (`consent.ts:240-253`). The consent is part of the idempotency fingerprint (`checkout.ts:910-912`; `consent.ts:219-231`).

#### 2.3 The rule: which consent a reminder requires

**A reminder is sent only when the checkout's frozen consent says `reminder: true` OR `marketing: true`** (AC4, the owner's 2026-07-06 rule). The rule:
- A missing or unreadable `consent_json` (`readFrozenConsent` → null, `consent.ts:184-213`) is **no consent**.
- `terms` alone is no consent.
- The withdrawal waiver is no consent.
- The rule is read only from the checkout being reminded, never from another checkout of the same buyer.

The rule lives in ONE function, `reminderConsentGiven(json)` in `consent.ts`. The cron step calls it; a test pins every case. Consent is not re-checked at send time: it is frozen and cannot change (`0031:152-158`).

#### 2.4 The box, its text and where the text lives

**The box.** On the contact step, under the marketing box, pre-unticked, shown only while `useShopFeatures().isEnabled('abandonedCheckout')` (the storefront provider, `src/storefront/providers/ShopFeatures.jsx:14-21`). That is true only while the platform's add-on AND the seller's switch are both on (§8.1). The text is a code fallback in `Checkout.jsx` under a translation key, as every checkout text is. The storefront's language files are static per language (D16, `Translation.jsx:1-10`); the key is also added to `src/locales/sv-SE.json` beside `checkout_marketing_opt_in`.

**Proposed wording (AC5, legal):**
- Label, key `checkout_remind_me`: "Påminn mig via e-post om jag inte slutför köpet" (Firebase's, verbatim).
- Line under it, new key `checkout_remind_me_help`: "Högst ett mejl från {{shop}}. Du kan avregistrera dig i mejlet." `{{shop}}` is the shop's name, the same seller name the terms sentence already uses (`Checkout.jsx:130-131`).

**What the text must state (the owner's note and general consent practice; not verified as law):**
1. Who sends: the shop.
2. What: an e-mail about this purchase if it is not completed.
3. That it is optional: the box is unticked, and the purchase does not depend on it.
4. How to withdraw: the unsubscribe link in the mail.

That pre-ticked boxes do not count as consent is general EU practice; not verified in this repository.

**The request.** `buildCheckoutRequest` gains `reminder` and adds `consent.reminder = true` only when ticked. A request without the tick is byte for byte what it is today. So the payment form's request key (`StripePaymentForm.jsx:310`) and the idempotency fingerprint of every unticked checkout are unchanged.

**The server** (`consent.ts`):
- `CONSENT_KEYS` gains `reminder` (`:65`).
- `parseCheckoutConsent` accepts an optional boolean `reminder` (`:73-104`).
- `freezeConsent` writes `reminder: true` only when it is true and leaves the key out otherwise (`:161-180`). An unticked checkout's `consent_json` is byte-identical to today's, and `sameConsent` keeps matching replays across the deploy.
- `readFrozenConsent` accepts an optional `reminder` that must be `true` when present (`:184-213`).
- `FrozenConsent` gains `reminder?: true`.
- The order copy carries it verbatim.

The server accepts `reminder: true` even when the shop's switch is off. Refusing it would make a tab opened before the seller turned the switch off fail at payment. The cron step does not send in that case anyway.

#### 2.5 What is a legal claim here and what is not

- **Legal claims, all not verified:**
  - MFL 19 § (prior consent for e-mail marketing to consumers; the soft opt-in does not cover a buyer who did not buy).
  - MFL 20 § (an easy opt-out in every message).
  - That a reminder is marketing at all.
  - That the sender must be identifiable.
  - Whether the mail must also name the shop's legal name and address.

  Sources: the owner's memory note, the old commit message (`a74f4891`), the old template's comment (`abandonedCheckoutReminder.ts:2-5`), and the CP2-E report (`CP2_E_REPORT.md:169`). They become AC4, AC5, AC13 and AC14.
- **Not legal claims:** the one-reminder rule, the cap, the delay, supersede. These are product rules.

### 3. Data model

#### 3.1 Why a table beside `checkouts`, not columns on it

1. The retention sweep's clock is `COALESCE(payment_intent_status_at, updated_at)` (`crons.ts:141`, `:211`). Any reminder write to the checkout row would either bump `updated_at` (the convention of every writer: `crons.ts:181`, `stripe-events.ts:228`, `webhook.ts:744`) and delay the intent's cancellation, or break that convention. A separate table never touches it.
2. `checkouts` carries several frozen-column triggers (`0019:123-155`, `0023:245-252`, `0031:152-158`) that a reminder has no business near.
3. The one-reminder and cap rules become a UNIQUE and a trigger on a table of their own, the way 0055 put the discount cap on `discount_code_holds` (`migrations/0055_discount_code_holds.sql:1-12`).

#### 3.2 Migration `00NN_checkout_reminders.sql`

Point `REQUIRED_MIGRATION` (`cloudflare/src/app.ts:492`) at it. Update the two tests that pin the latest migration, `cloudflare/test/health.test.ts` and `cloudflare/test/public-catalog.test.ts` (as CP8-DC did, `CP8_DC_REPORT.md:83`). Never edit a migration that has been applied anywhere.

```sql
PRAGMA foreign_keys = ON;

-- 00NN — Övergiven kassa on Cloudflare (CP9-AC). ONE reminder e-mail to a
-- buyer who reached payment and left, only with consent, with a link that
-- rebuilds the cart (docs/cf-port/CP9_AC_REPORT.md).
--
-- Nothing on `checkouts` changes: a reminder must never move a checkout's
-- retention clock (src/commerce/crons.ts). No address is copied anywhere
-- here: the address stays on the checkout; these tables hold its sha256.
--
-- TIME: INTEGER epoch milliseconds, as checkouts and 0055.

-- ── 1. The seller's switch ──────────────────────────────────────────────
CREATE TABLE checkout_reminder_settings (
  tenant_id TEXT PRIMARY KEY NOT NULL
    REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  delay_hours INTEGER NOT NULL DEFAULT 1 CHECK (delay_hours BETWEEN 1 AND 24),
  -- When the switch was last turned ON. Only a checkout created at or after
  -- it is ever a candidate: turning the switch on mails nobody from before.
  -- Kept as it is when the switch is turned off.
  enabled_at INTEGER CHECK (enabled_at IS NULL OR enabled_at > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  CHECK (enabled = 0 OR enabled_at IS NOT NULL)
);

CREATE TRIGGER checkout_reminder_settings_tenant_immutable
BEFORE UPDATE OF tenant_id ON checkout_reminder_settings
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- GET /v1/storefront's features.abandonedCheckout reads `enabled`, so a
-- change bumps the shop's catalog_version, as 0043 does for tenant_features.
CREATE TRIGGER catalog_version_checkout_reminder_settings_insert
AFTER INSERT ON checkout_reminder_settings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_checkout_reminder_settings_update
AFTER UPDATE ON checkout_reminder_settings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER checkout_reminder_settings_no_delete
BEFORE DELETE ON checkout_reminder_settings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder settings are switched off, never deleted');
END;

-- ── 2. One decision per checkout ────────────────────────────────────────
CREATE TABLE checkout_reminders (
  reminder_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(reminder_id) = 36 AND reminder_id NOT GLOB '*[^0-9a-f-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- UNIQUE: one decision per checkout, so at most one reminder per checkout.
  checkout_id TEXT NOT NULL UNIQUE
    REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- sha256 hex of the checkout's address as the checkout parser stored it
  -- (lower case), = src/email/auth-email-job.ts hashEmailRecipient, = the
  -- ledger's recipient_hash, = Firebase's emailHash. The cap and the
  -- unsubscribe key on it.
  buyer_hash TEXT NOT NULL CHECK (length(buyer_hash) = 64 AND buyer_hash NOT GLOB '*[^0-9a-f]*'),
  -- queued     an outbox row exists in the same batch; the mail is (being) built
  -- skipped    decided not to remind; `reason` says why
  -- withdrawn  queued, then the mail effect found a reason not to mail
  state TEXT NOT NULL CHECK (state IN ('queued', 'skipped', 'withdrawn')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'paid', 'feature_off', 'switch_off', 'orders_closed', 'no_consent',
    'undeliverable', 'unsubscribed', 'superseded', 'frequency_cap',
    'payment_failed', 'unavailable', 'payment_in_progress', 'intent_gone'
  )),
  decided_at INTEGER NOT NULL,
  -- The recovery link's end (decided_at + 7 days). NULL on a skipped row,
  -- for which no link was ever made.
  link_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((state = 'queued') = (reason IS NULL)),
  CHECK ((state = 'skipped') = (link_expires_at IS NULL)),
  CHECK (link_expires_at IS NULL OR link_expires_at > decided_at)
);

-- The decision belongs to a checkout of the same tenant.
CREATE TRIGGER checkout_reminders_match_checkout
BEFORE INSERT ON checkout_reminders
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM checkouts AS c
  WHERE c.checkout_id = NEW.checkout_id AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder tenant must match its checkout');
END;

CREATE TRIGGER checkout_reminders_born
BEFORE INSERT ON checkout_reminders
FOR EACH ROW
WHEN NEW.state = 'withdrawn'
BEGIN
  SELECT RAISE(ABORT, 'a checkout reminder is born queued or skipped');
END;

-- THE CAP (AC6): at most one queued reminder per shop and address within
-- 7 days (604800000 ms = src/commerce/checkout-reminders.ts REMINDER_CAP_MS;
-- a test pins the two). Decided at the INSERT, so two cron runs racing for
-- one buyer cannot both queue: the batch that commits second is aborted
-- whole, its outbox row with it.
CREATE TRIGGER checkout_reminders_cap
BEFORE INSERT ON checkout_reminders
FOR EACH ROW
WHEN NEW.state = 'queued' AND EXISTS (
  SELECT 1 FROM checkout_reminders AS r
  WHERE r.tenant_id = NEW.tenant_id
    AND r.buyer_hash = NEW.buyer_hash
    AND r.state = 'queued'
    AND r.decided_at > NEW.decided_at - 604800000
)
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder frequency cap');
END;

-- The only move: queued → withdrawn, with a reason. Everything else frozen.
CREATE TRIGGER checkout_reminders_transition
BEFORE UPDATE ON checkout_reminders
FOR EACH ROW
WHEN NOT (OLD.state = 'queued' AND NEW.state = 'withdrawn' AND NEW.reason IS NOT NULL)
  OR NEW.reminder_id IS NOT OLD.reminder_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.checkout_id IS NOT OLD.checkout_id
  OR NEW.buyer_hash IS NOT OLD.buyer_hash
  OR NEW.decided_at IS NOT OLD.decided_at
  OR NEW.link_expires_at IS NOT OLD.link_expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'a checkout reminder only moves from queued to withdrawn');
END;

CREATE TRIGGER checkout_reminders_no_delete
BEFORE DELETE ON checkout_reminders
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminders are append-only');
END;

CREATE INDEX checkout_reminders_cap_idx
  ON checkout_reminders(tenant_id, buyer_hash, state, decided_at);
CREATE INDEX checkout_reminders_tenant_decided_idx
  ON checkout_reminders(tenant_id, state, decided_at);

-- ── 3. Addresses that unsubscribed, per shop ────────────────────────────
CREATE TABLE checkout_reminder_suppressions (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- sha256 hex of the lower-cased address: Firebase's emailHash
  -- (functions/src/checkout-recovery/tokens.ts), so an archived
  -- suppression carries over unchanged.
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
  source TEXT NOT NULL CHECK (source IN ('unsubscribe', 'import')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email_hash)
);

CREATE TRIGGER checkout_reminder_suppressions_no_update
BEFORE UPDATE ON checkout_reminder_suppressions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder suppressions are append-only');
END;

CREATE TRIGGER checkout_reminder_suppressions_no_delete
BEFORE DELETE ON checkout_reminder_suppressions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder suppressions are append-only');
END;

-- ── 4. The cron step's candidate read ───────────────────────────────────
CREATE INDEX checkouts_status_created_idx ON checkouts(status, created_at);

-- ── 5. email_deliveries: admit 'checkout_reminder' ──────────────────────
-- The recipe of 0022, 0029, 0044 and 0050: copy, drop, recreate with the
-- identical shape and the one new kind, copy back column by column, drop
-- the copy, re-declare the two triggers and three indexes. Every line is
-- 0050_email_kinds.sql:27-92 except the kind list, which becomes:
--   kind TEXT NOT NULL CHECK (kind IN (
--     'email_verification', 'password_reset', 'order_confirmation', 'alert_digest',
--     'withdrawal_receipt', 'withdrawal_notice',
--     'order_status_update', 'order_notice_shop', 'refund_notice',
--     'checkout_reminder'
--   )),
-- and the temporary table is email_deliveries_migration_00NN.
```

The builder writes block 5 out in full (no `--` shorthand in the real file), copied from 0050 and diffed against it, so that the only difference is the kind and the table name. If DAC7's mail migration lands first and also recreates `email_deliveries`, block 5 starts from that migration's kind list instead.

**The one-reminder rule** is `UNIQUE (checkout_id)` (at most one decision per checkout), and `queued` happens at most once per checkout.

**The cap** is the trigger plus the same check in code, which only records the reason.

#### 3.3 The consent field

There is no schema change: `consent_json` is free JSON under a size cap (`0031:143-150`). The shape change is in `consent.ts` (§2.4).

#### 3.4 The link tokens: derived, never stored

**The pattern.** This is the pattern of the storefront preview grant (`cloudflare/src/storefront/preview.ts:12-37`, `:152-231`). A new module, `cloudflare/src/commerce/checkout-recovery-token.ts`:

```
key       = HKDF-SHA-256(BETTER_AUTH_SECRET,
                         salt "chopshop/checkout-recovery",
                         info "checkout-recovery-link/v1") → HMAC-SHA-256 key
message   = "checkout-recovery/v1\n<purpose>\n<tenantId>\n<reminderId>"
            purpose ∈ { "resume", "unsubscribe" }
token     = "v1." + <reminderId> + "." + base64url(HMAC(key, message))   (83 characters)
pattern   = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/
```

**Why this shape.**
- **Nothing secret is stored.** The reminder id alone opens nothing.
- **The mail job stays deterministic.** The effect re-derives the same links on every retry, which the ledger's fingerprint needs (`email-effect.ts:55-63`).
- **The tenant is inside the signed message, not in the token.** A token of shop A on shop B's host is simply a wrong signature, as with the preview (`preview.ts:23-28`).
- **The purpose is inside the signed message.** An unsubscribe link (which travels in a header to mail providers) cannot rebuild the cart, and the cart link cannot unsubscribe. Firebase used one token for both (`sweep.ts:289-290`).
- **The checkout id is never in a link.** It is the bearer capability of the payment and receipt routes (`app.ts:1335-1345`; `0014_receipt_tokens.sql:48-57`).

**Verification.** Pattern → `crypto.subtle.verify` (constant time) against the hostname's tenant → the row `(tenant_id, reminder_id)` with `state = 'queued'`. The resume link must also have `link_expires_at > now`. The unsubscribe link has no expiry (AC11).

**Without a configured secret** (`isAuthConfigured`, `preview.ts:153-155`) no token can be minted or verified. The cron step then does nothing (§4.6), and both routes answer the opaque 404.

**Rotating `BETTER_AUTH_SECRET`** ends every link in every mail already sent (§12.1, R2).

#### 3.5 The address hash

- **Derivation.** `buyer_hash = email_hash = hashEmailRecipient(checkouts.customer_email)` (`cloudflare/src/email/auth-email-job.ts:326-334`): sha256 hex of the trimmed, lower-cased address. The checkout parser has already lower-cased it and refuses whitespace (`checkout.ts:255-271`).
- **The same digest elsewhere.** It is the ledger's `recipient_hash` (`email-delivery-store.ts:105-112`) and Firebase's `emailHash` (`tokens.ts:21-24`, `writeCheckoutDoc.ts:100-106`), so an archived suppression is importable as it is (§3.7).
- **The tenant is a column, not part of the digest.** This differs from the discount's `buyer_key` (`checkout.ts:488-504`), deliberately, for the import.
- **Undeliverable addresses.** `hashEmailRecipient` throws for an address without a dot after the `@`, which the checkout parser accepts (F9). Such a checkout is skipped as `undeliverable`.

#### 3.6 Tenant scoping

- Every read in the cron step, the effect and the routes is by `(tenant_id, …)`.
- The routes take the tenant from the hostname (`resolveRequestTenant`, inside app.ts's `storefront(...)` wrapper, `app.ts:2284`), never from the request.
- The token's signature includes the tenant.
- `checkout_reminders` refuses a row whose tenant is not its checkout's (trigger).
- The outbox row carries the tenant, and the effect reads only that tenant's rows (the rule of `email-effect.ts:75-76`).
- A suppression is per shop: unsubscribing from shop A changes nothing at shop B.

#### 3.7 Import from Firebase

- **Suppressions.** `checkoutSuppressions` had 0 documents at the 2026-09-27 export, with the instruction to restore any before reminders are re-enabled (`MIGRATION_MANIFEST.md:73`). The importer gains one transform: `checkoutSuppressions/{shopId}_{hash}` → `(tenant_id = shopId, email_hash = emailHash, source 'import', created_at = createdAt)`. It refuses a document whose `emailHash` is not 64 hex characters or whose `shopId` is not a tenant of the plan, plus a test. With 0 documents at the freeze, it writes nothing.
- **Settings.** `cartRecovery` exists on no shop (§1.1): nothing to carry. Every shop starts with the seller's switch off (AC3).
- **Recovery data.** `checkouts` (0 documents) carries no recovery data worth bringing: an old token would point at Firebase's host.

### 4. When a reminder is due, and every reason it is not sent

#### 4.1 Due

A checkout is **due** when all of these hold:
- `created_at + delay_hours × 1 h ≤ now`;
- the seller's switch is on, and was turned on at or before the checkout's creation (`created_at ≥ enabled_at`);
- the checkout is `open` and has an intent (the buyer saw the payment form);
- no decision exists for it.

It **stops being due** (never selected again, no row written) once `now ≥ due + 24 h` (AC7). The delay is read at decision time, so changing it affects checkouts not yet decided; Firebase froze it at checkout time (`writeCheckoutDoc.ts:126-128`).

#### 4.2 The candidates

`runCheckoutReminders(env, now)` in a new `cloudflare/src/commerce/checkout-reminders.ts`:

```sql
SELECT c.checkout_id, c.tenant_id, c.customer_email, c.created_at,
       c.status, c.payment_intent_id, c.payment_intent_status, c.consent_json
FROM checkouts AS c
JOIN checkout_reminder_settings AS s ON s.tenant_id = c.tenant_id
WHERE c.status = 'open'
  AND c.payment_intent_id IS NOT NULL
  AND c.created_at > ?1 - 172800000                         -- now − 48 h: the index range
  AND s.enabled = 1
  AND c.created_at >= s.enabled_at
  AND c.created_at + s.delay_hours * 3600000 <= ?1          -- due
  AND c.created_at + s.delay_hours * 3600000 > ?1 - ?2      -- not more than 24 h late
  AND NOT EXISTS (SELECT 1 FROM checkout_reminders AS r WHERE r.checkout_id = c.checkout_id)
ORDER BY c.created_at ASC, c.checkout_id ASC
LIMIT ?3                                                    -- REMINDER_BATCH = 25
```

The 48 h lower bound (the longest delay plus the late limit) keeps the read on `checkouts_status_created_idx`.

#### 4.3 The checks, in order

Each candidate is decided in this order. The first failing check writes a `skipped` row with its reason. The tick never writes a second row for the same checkout.

| # | Check | How | Reason | Re-checked when the mail is built |
|---|---|---|---|---|
| 1 | Not paid | No `orders` row with this `checkout_id` (UNIQUE, `0011_orders.sql:48`), `status = 'open'`, `payment_intent_status <> 'succeeded'` | `paid` | **yes** |
| 2 | The platform's add-on | `isFeatureEnabled(db, tenant, 'abandonedCheckout')` (`tenant-config.ts:177-205`), once per tenant per tick | `feature_off` | **yes** |
| 3 | The seller's switch | The settings row (already in the SQL; read again with the add-on) | `switch_off` | **yes** |
| 4 | The shop can take an order now | The public shop (active, published, named: `isPublicShop`, `public-storefront.ts:85-88`) AND `isCheckoutLegallyOpen` (`legal/legal-pages.ts:588-590`) AND `takesDestinationCharges` (`payment.ts:239-244`). One exported helper, `shopTakesOrders(db, tenantId, now)`, also used to compute `ordersOpen` in `getPublicStorefrontVersioned` (`public-storefront.ts:200`), so the two cannot drift. Once per tenant per tick | `orders_closed` | **yes** |
| 5 | Consent | `reminderConsentGiven(consent_json)`, §2.3 | `no_consent` | no (frozen) |
| 6 | A mailable address | `hashEmailRecipient(customer_email)` does not throw | `undeliverable` | no |
| 7 | Not unsubscribed | No row `(tenant_id, buyer_hash)` in `checkout_reminder_suppressions` | `unsubscribed` | **yes** |
| 8 | Not superseded | No other checkout of the same tenant and `customer_email` created later (`created_at >` this one's, ties broken by `checkout_id`), **whatever its status or intent** (index `checkouts_tenant_email_idx`, `0009:194`) | `superseded` | **yes** |
| 9 | Under the cap | No `queued` reminder of the same `(tenant_id, buyer_hash)` with `decided_at > now − 7 days` | `frequency_cap` | no; the trigger guards the insert |
| 10 | No declined attempt (AC9) | No `payment_events` row with `object_id = payment_intent_id` and `event_type = 'payment_intent.payment_failed'` (`0011_orders.sql:380-421`, index `payment_events_object_idx`) | `payment_failed` | no |
| 11 | Something left to buy | At least one `checkout_items` line whose product passes THE public predicate now (`catalog/eligibility.ts`, as `resolveLine` reads it, `checkout.ts:536-569`) and whose variant, if any, is `active = 1` (`checkout.ts:575-597`). A per-line helper, not `resolveLines`, which is all-or-nothing (`checkout.ts:640-669`) | `unavailable` | **yes** (the mail lists only these lines) |
| 12 | The intent is not being paid (AC10) | `retrievePaymentIntent` (`commerce/stripe-client.ts:34-40`, the retention sweep's gateway, `crons.ts:66-68`). `requires_payment_method` or `requires_confirmation` → send. `succeeded` → `paid`. `processing`, `requires_capture`, `requires_action` → `payment_in_progress`. `canceled`, or Stripe answers that the intent does not exist → `intent_gone`. A network error, a 5xx or 429 → **no row**: the candidate stays for the next tick, and the step stops calling Stripe for the rest of this tick | as listed | no |
| 13 | The write | §4.4. The cap trigger refusing it → a `skipped` row with `frequency_cap` | `frequency_cap` | n/a |

**Why this order.**
- Check 1 comes first, so a paid checkout is always recorded as `paid`, whatever else is also true.
- Checks 2–4 are about the shop and are cached per tenant.
- Checks 5–11 are D1 reads per checkout.
- Check 12 is the only network call, made only when everything else passed.

**What the reasons map to.**
- Expired checkout: the late limit of §4.1.
- Purged snapshot: §9.
- Product no longer buyable: check 11, and the page drops a missing line (§6.7).
- Payment still processing: check 12.

#### 4.4 The write

One batch, in this order:

```sql
INSERT INTO checkout_reminders
  (reminder_id, tenant_id, checkout_id, buyer_hash, state, reason,
   decided_at, link_expires_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, ?5 + 604800000, ?5, ?5);

INSERT INTO outbox_events
  (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
   dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at)
SELECT ?6, ?2, 'email.checkout_reminder', 'checkout', ?3,
       'email.checkout_reminder:' || ?1, json_object('reminderId', ?1),
       'pending', ?5, ?5, ?5
WHERE EXISTS (SELECT 1 FROM checkout_reminders WHERE reminder_id = ?1 AND state = 'queued');
```

**After the batch.**
- `nudgeOutbox` with the new ids, after the loop (`outbox/nudge.ts:1-40`).
- A refusal whose message names `checkout reminder frequency cap` → insert the `skipped` row instead.
- A UNIQUE failure on `checkout_reminders.checkout_id` → another run decided it; count it and move on.
- Any other error throws, and the step fails for this tick.

**Skipped rows.** `INSERT … ON CONFLICT(checkout_id) DO NOTHING`.

**The outbox payload** holds the reminder id only: no address, no link (`email-effect.ts:65-73`).

#### 4.5 What is checked again when the mail is built

A new outbox effect type, `email.checkout_reminder`, is added to `OUTBOX_EFFECT_TYPES` (`outbox.ts:38-46`) and to `EFFECTS` (`effects.ts:24-30`). Under its claim, it:

1. Reads the reminder `(tenant of the row, reminderId from the payload)`. Missing → `fail` terminal, `invalid_payload`. `withdrawn` → complete without a mail.
2. Re-checks 1, 2, 3, 4, 7, 8 and 11 of §4.3. On the first failure it sets `UPDATE checkout_reminders SET state = 'withdrawn', reason = ?, updated_at = ? WHERE reminder_id = ? AND tenant_id = ? AND state = 'queued'`, then completes the outbox row without a job. Same order, so a retry after a crash finds `withdrawn` and completes.
3. Builds the job (§5.4) and hands it to the shared `deliver` (`email-effect.ts:595-645`): ledger + freeze + `submitting` in one batch, then the queue, then `done`. `deliver` gains a lifetime parameter (the reminder's is 2 h; §5.4).

Not re-checked at send time:
- Consent (frozen).
- The address shape (fixed).
- The cap (decided by the trigger at the insert).
- The declined attempt and the live intent. The decision is seconds old when the nudge works. If the effect runs late (the sweeper, `outbox/sweeper.ts`), check 1 still catches a success the webhook recorded.

After the job is queued nothing is checked again. The consumer sends it as it sends every job (`email-queue-consumer.ts:206-286`). The job's 2-hour lifetime bounds how late a held mail can go out (§12.1, R4).

#### 4.6 Bounds

- **Per tick.** At most `REMINDER_BATCH = 25` candidates, oldest first. Every candidate examined gets a row except on a Stripe network error, so the next tick sees the next ones. The rest wait 15 minutes. A candidate that passes the late limit while waiting is never sent and gets no row.
- **Throughput.** About 25 × 96 = 2 400 decisions a day. Enough for the five shops (a risk line all the same, R7).
- **Stripe calls.** At most 25 per tick, only for candidates that passed checks 1–11. After the first network error in a tick, none.
- **Placement.** A step in `scheduled.ts` after `runRetentionSweep` and before the digest (`scheduled.ts:121-137`): `["checkout_reminders", (env, now) => runCheckoutReminders(env, now)]` in the step list beside `CP3_STEPS` (`:77-80`). It is isolated like every step (`:61-75`): it throws only on a D1 fault, and the next tick retries.
- **Does nothing** (no row, one log line, no failure) when `BETTER_AUTH_SECRET` is absent (no link can be minted), when `CANONICAL_ORIGINS` has no `web` origin (`lib/origins.ts:139-145`), or when Stripe is not configured (`crons.ts:66-68`; every candidate has an intent, so none can pass check 12).
- **Returns a summary** `{ examined, queued, skipped: { <reason>: n }, retried, disabled? }`, as the money crons do (`crons.ts:83-91`). It never names an address.

### 5. The mail

#### 5.1 What it may and may not contain

**May:**
- the shop's name;
- the recipient's name as the checkout froze it (read live, never frozen in the job, as the order mails do: `email-effect.ts:70-73`);
- the names and quantities of the lines still buyable, with the variant label (`product_variants.label`, `0005_catalogue.sql:34`) — live names at build time, frozen with the job;
- the resume link and its last valid day;
- the unsubscribe link;
- the shop's support address;
- why the buyer gets the mail.

**May not:**
- any price, total, shipping, VAT or discount (AC8): they can be stale, and the new checkout prices everything again;
- a discount code or any offer: no discount language, Firebase's choice (`abandonedCheckoutReminder.ts:2-3`);
- the checkout id, the intent, or the order number;
- images: no Cloudflare mail carries one (`email/order-emails.ts:720-753`).

#### 5.2 The Swedish text (AC5)

```
Subject:  Du glömde något i kassan hos {shop}          (no shop name: "Du glömde något i kassan")

Din varukorg väntar

Hej {name},                                             (no name: "Hej,")

Du påbörjade ett köp hos {shop} men slutförde det inte. Vi har sparat varorna åt dig:
- {quantity} st {name} ({variant label})
- …

Slutför köpet: {resume link}
Länken gäller till och med {12 oktober 2026}. Priser och frakt visas i kassan.

Du får det här mejlet eftersom du gav {shop} lov att mejla dig när du handlade.
Det här är den enda påminnelsen om det här köpet.
Vill du inte få fler påminnelser från {shop}? Avregistrera dig: {unsubscribe page}
Har du frågor? Kontakta {shop} på {support address}.   (no address: "Har du frågor? Kontakta butiken.")
```

**The HTML part** has the same paragraphs, every value escaped (`order-emails.ts:541-548`), a link "Slutför köpet" and the footer link "Avregistrera dig från påminnelser" (Firebase's label, `abandonedCheckoutReminder.ts:94`).

**The date** is the Stockholm calendar day of `link_expires_at`, written as "12 oktober 2026".

**Mailbox-safe values.** Every text a seller or buyer wrote goes through `mailText` (`order-emails.ts:173-179`).

#### 5.3 Sender, Reply-To, headers

**From (AC13).** `"{shop name}" <the address of EMAIL_FROM>`.
- The display name is the shop's `mailText` name, with `"`, `\`, `<`, `>` and control characters removed, at most 100 characters.
- No shop name means `EMAIL_FROM` as it is.
- The consumer builds it for this kind only (`email-queue-consumer.ts:151-158` sends `config.from` for every job today). Firebase sent customer mail the same way (`EmailOrchestrator.ts:881-885`).

**Reply-To.** The shop's support address (`realShopAddress`, `order-emails.ts:195-205`), as the order mails (`email-queue-consumer.ts:143-145`; `order-emails.ts:534-537`).

**Headers (AC14).**
- `List-Unsubscribe: <{one-click URL}>`.
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- They go in a `headers` member of the Resend request body, for this kind only. Firebase passed `headers` the same way (`functions/src/email-orchestrator/services/EmailService.ts:105-107`). That Resend accepts the member is not verified in this session (no network).
- The one-click URL is the API route of §6.3 through the web Worker, not a page (F1).

#### 5.4 The job, the ledger, and no mail account

**A new module, `cloudflare/src/email/checkout-reminder-email.ts`.** It follows the pattern of `withdrawal-email.ts` (`:1-28`) and `order-emails.ts`:

```ts
export const CHECKOUT_REMINDER_KIND = "checkout_reminder";
interface CheckoutReminderEmailJob {
  actionUrl: ""; createdAt: number; deliveryId: string; expiresAt: number;
  kind: "checkout_reminder"; locale: "sv"; recipient: string; tenantId: string; version: 1;
  content: {
    items: Array<{ label: string | null; name: string; quantity: number }>;  // 1–50
    linkValidUntil: string;          // YYYY-MM-DD, Stockholm
    oneClickUnsubscribeUrl: string;  // https://<web>/_api/<tenant>/v1/checkout-recovery/<token>/unsubscribe
    recipientName: string | null;    // live, never frozen
    resumeUrl: string;               // https://<web>/<tenant>/aterta/<token>
    shopName: string | null;
    supportEmail: string | null;
    unsubscribeUrl: string;          // https://<web>/<tenant>/avregistrera/<token>
  };
}
```

**Validation.** Strict, like `isAdminUrl` (`order-emails.ts:224-248`): https, no credentials, no query or fragment, the exact path shape with the job's own tenant and the token pattern. The `<web>` origin is `readCanonicalOrigins(env).web` (`lib/origins.ts:139-145`; staging `https://chopshop-web-stg.kent-ee2.workers.dev`, `cloudflare/pinned.staging.json`).

**Wiring.** The kind joins `AuthEmailKind` (`auth-email-job.ts:18-29`), the dispatch of `parseAuthEmailJob` (`:266-288`), `renderAuthEmail` (`:357-372`) and `fingerprintAuthEmailJob` (`email-delivery-store.ts:33-41`). The fingerprint covers every rendered field and the headers.

**Delivery id.** `deliveryIdFromKey("email.checkout_reminder:<reminderId>")` (`auth-email-job.ts:575-587`).

**Frozen at the first build.** Everything but `recipientName` is written to the outbox row's `frozen_json`, the order mails' rule (`email-effect.ts:65-74`, `:214-273`). A rename between attempts cannot cause a fingerprint conflict.

**Lifetime: 2 hours** (`REMINDER_JOB_LIFETIME_MS`; the frame allows up to 24 h, `order-emails.ts:127`). After that the ledger marks the job `expired` and nothing is sent (`email-delivery-store.ts:238-252`). A reminder held through a long outage is dropped rather than arriving after the buyer may have paid.

**No mail account (staging today).** The decision, the outbox row and the ledger row are written exactly as with one. The consumer holds the job (`email-queue-consumer.ts:292-303`), and the ledger row stays `pending` until its 2 hours end, then `expired`. The seller's page says no mail is sent (§7.2), with the boolean `mailConfigured` computed as `readEmailDeliveryConfig(env) !== null` — the invite routes' rule (`platform/invites.ts:105-107`).

**If a key is added within a job's 2 hours, that job is sent.** On staging that means a test address.

### 6. The recovery link and the public routes

#### 6.1 Addresses

- **Pages, on the shared host** (D77: the shop is the first path segment, and the segment is the tenant id: `tenancy/shop-hostname.ts:14-17`, `:28-52`):
  - `https://<web>/<tenantId>/aterta/<resume token>`
  - `https://<web>/<tenantId>/avregistrera/<unsubscribe token>`
  - The address words are Firebase's (`src/App.jsx:373-374`).
- **One-click target:** `https://<web>/_api/<tenantId>/v1/checkout-recovery/<unsubscribe token>/unsubscribe`. The web Worker forwards `/_api/<shop>/…` to the API under the shop's hostname (`cloudflare/web/src/routing.ts:57-76`). The API origin alone would not do: it names no shop.
- **Custom domains (CP7):** a shop on its own domain would get links on the shared host until a later unit builds links on the shop's own domain (§12.2).

#### 6.2 `POST /v1/checkout-recovery/:token` (resolve)

**Request.** No body is read; anything sent is ignored. The token is the path segment (`decodeSegment`, as `checkoutPaymentIdFromPath`, `app.ts:1314-1333`).

**Answers:**
- `200 { recovery: { status: "open", items: [{ productId, quantity, variantId? }] } }`. The lines of `checkout_items` in `item_index` order (at most 50, `checkout.ts:205`). `variantId` is present only when the line had one.
- `200 { recovery: { status: "completed" } }` when an `orders` row exists for the reminded checkout (also one paid late, after the sweep: `webhook.ts:120-131`).
- `404` — the shared `notFoundResponse`, identical bytes — for each of these:
  - a malformed token;
  - a wrong signature;
  - another shop's token;
  - the unsubscribe purpose;
  - an unknown reminder;
  - a `skipped` or `withdrawn` decision (no link was ever mailed);
  - a link past `link_expires_at`;
  - no `BETTER_AUTH_SECRET`.
- `429 rate_limited` (§6.5).
- `Cache-Control: no-store`.

**It writes nothing.** It never touches the checkout, its intent or its hold, and it works whatever the add-on's state (Firebase's "never dead-ends", `CheckoutRecoveryPage.jsx:23-25`).

#### 6.3 `POST /v1/checkout-recovery/:token/unsubscribe`

**Request.** The body is ignored: RFC 8058's `List-Unsubscribe=One-Click` form from a mail provider, or nothing from the page. There is no same-origin check: the surface is anonymous and carries no ambient credential, as with the withdrawal intake (`routes/storefront-withdrawals.ts:35-36`).

**What it does.**
1. Rate limit.
2. Token with the `unsubscribe` purpose.
3. Reminder `(tenant, id)` in state `queued` (no expiry).
4. In one batch: `INSERT INTO checkout_reminder_suppressions (tenant_id, email_hash, source, created_at) VALUES (?, <buyer_hash>, 'unsubscribe', ?) ON CONFLICT DO NOTHING`, and an `audit_events` row `checkout_reminder.unsubscribe` with the reminder id as resource and no actor. Neither row holds an address.

**Answers.**
- `200 { unsubscribed: true }` whether the row was written now or before (idempotent).
- The same opaque `404` as §6.2 otherwise.
- `429`.

It works whatever the add-on's state and the link's age.

#### 6.4 What they never reveal

Neither route answers with:
- an address, a name or any recipient field;
- a price, a total, a discount or a code;
- the checkout id, the intent or the reminder's dates and reasons;
- whether an address is suppressed or has other checkouts.

A malformed, forged, foreign, unknown or expired token gets one answer, byte for byte. The only fact a holder of a valid resume link learns beyond the lines is `completed`: that this checkout became an order.

A test compares the bodies, and a denylist test fails on any of these keys: `email`, `customerEmail`, `name`, `priceMinor`, `unitPriceMinor`, `totalMinor`, `discountCode`, `checkoutId`, `paymentIntentId`.

#### 6.5 Rate limits

- **Limit.** One scope, `checkout-recovery-ip`: 30 requests per 10 minutes per visitor (an IPv6 address by its /64, `lib/rate-limit.ts:165`), for both routes together.
- **Order.** Counted before the token is parsed, so every attempt counts (the withdrawal route's rule, `storefront-withdrawals.ts:38-45`).
- **Purpose.** A flood shield. A 256-bit signature cannot be guessed.
- **No limit per token or per reminder.** It would let whoever holds a link keep its buyer from unsubscribing.

#### 6.6 The web Worker's allowlist

Two rows in `cloudflare/web/src/api-allowlist.ts:35-53`:

```ts
{ methods: ["POST"], segments: ["v1", "checkout-recovery", ID] },
{ methods: ["POST"], segments: ["v1", "checkout-recovery", ID, "unsubscribe"] },
```

**The token passes the id-segment rule.** It is unreserved characters only (`A–Z a–z 0–9 . - _`), 83 characters, under the 512 cap (`api-allowlist.ts:55-73`).

**Tests.** `cloudflare/test/web-routing.test.ts` gains rows for both: allowed POST; GET refused; a token with `%2F` refused; a fifth segment refused.

**Pages.** The two page addresses need no row: every GET page path already reaches the storefront shell (`routing.ts:86-105`). An unknown path's SEO answer is 404, and the shell is served `noindex` (`web/src/index.ts:195-204`).

#### 6.7 The storefront pages and the cart rebuild

**Routes.** `src/storefront/StorefrontApp.jsx` gains two rows before `/:slug`: `{ path: '/aterta/:token', page: 'CheckoutRecoveryPage' }` and `{ path: '/avregistrera/:token', page: 'CheckoutUnsubscribePage' }`. `src/storefront/pages.jsx` gains the two swap lines.

**The pages.** Both are rewritten to read from a new `src/api/checkoutRecovery.js`:
- `resolveCheckoutRecovery(token)` → `{ status: 'open' | 'completed' | 'invalid', items }`;
- `unsubscribeCheckoutReminders(token)` → `true | false`.

No Firebase import is left, so their two lines leave `guard/allowlist.txt` (`:238-239`; baseline 294 → 292).

**The rebuild (`CheckoutRecoveryPage`).**
1. Resolve.
2. `invalid` → a panel "Länken till din varukorg fungerar inte längre." with "Till butiken". Firebase redirected silently (`CheckoutRecoveryPage.jsx:47-50`); a panel tells the buyer why their cart is not there.
3. `completed` → Firebase's panel, texts unchanged (`:128-143`).
4. `open` →
   - `clearCart()` (`src/storefront/providers/Cart.jsx:446-451`; AC12);
   - for each line, `getProduct(productId)` (`src/api/products.js:40-43`, the normal public read, which applies THE predicate); a 404 means a missing line;
   - when the line has a `variantId`, the variant with that id in `product.variants`, or a missing line;
   - `addToCart(product, quantity, variant, { quiet: true })` — the provider's own `addToCart` (`Cart.jsx:333-375`), which takes the price shown from the LIVE product (`unitPriceOf`). `{ quiet: true }` is a new fourth parameter that skips the "added to cart" modal (`:372`), so a five-line cart does not open five modals;
   - any missing line → toast "Vissa varor finns inte längre och togs bort ur varukorgen.";
   - then `navigate(<root>/checkout, { replace: true })`.
5. A network error → Firebase's error panel (`:145-157`).

**Fresh totals.** The checkout page then asks for contact and delivery again. The payment step creates a NEW checkout through `POST /v1/checkout`, which prices every line from the catalogue (`checkout.ts:521-632`). Nothing of the old checkout's money reaches the new one.

**`CheckoutUnsubscribePage`.** Calls on mount (AC14).
- `200` → "Du är avregistrerad från påminnelser" / "Vi skickar inga fler påminnelser om varukorgar från {shop}. Du kan handla i butiken som vanligt." (Firebase's texts with the shop named, `CheckoutUnsubscribePage.jsx:58-63`).
- `404` → "Länken fungerar inte längre." / "Vill du inte få påminnelser från {shop}? Svara på mejlet eller kontakta butiken på {supportEmail}." (from the storefront identity).
- An error → "Något gick fel. Försök igen om en stund." with a retry button.

It never claims success it did not get (F2).

**Both pages** stay `noindex` and have no add-on gate.

#### 6.8 The discount code and its hold

**The code is not carried (AC12; Firebase's page also cleared the cart, code included, `CheckoutRecoveryPage.jsx:58`).** The checkout row holds only the code's id, never the code (`checkout.ts:803-811`). The resolve route does not reveal it. The buyer may enter it again; the cart's normal preview then decides (`Cart.jsx:1-11`).

**The old checkout's hold (0055)** lives at most 60 minutes (`discount-codes.ts:29`; `checkout.ts:1485-1511`), so with a delay of at least one hour it has normally run out before the reminder. If it is still live, it does not block this buyer: a buyer's own holds are excluded from the count (`discount-codes.ts:363`). It is released when the old intent is cancelled (`crons.ts:170-189`; `stripe-events.ts:246-269`) or runs out by itself. The recovery creates no hold until the buyer applies a code again.

### 7. The shop's settings and what each party sees

#### 7.1 The admin route

A new `cloudflare/src/routes/admin-checkout-reminders.ts`, mounted under `/v1/admin/` (the admin Worker forwards the whole family: `cloudflare/admin/src/allowlist.ts:30-35`).

**Endpoints:**
- `GET /v1/admin/checkout-reminders` →
  `200 { checkoutReminders: { enabled, delayHours, updatedAt, queuedLast30Days, mailConfigured } }`.
  With no settings row: `enabled: false`, `delayHours: 1`, `updatedAt: null`. `queuedLast30Days` counts this tenant's `queued` decisions of the last 30 days (`checkout_reminders_tenant_decided_idx`). `mailConfigured` is the §5.4 boolean.
- `PUT /v1/admin/checkout-reminders`, body exactly `{ enabled: boolean, delayHours: integer 1–24 }` →
  `200` with the same shape, or `400 invalid_request` on any other shape.

**`404` for both** when there is no session, membership or acting-as grant (`authorizeTenantAdminRequest`, as `routes/admin-settings.ts:61-66`), on a cross-origin PUT, or while the platform's add-on is off (CP8-DC's rule DC14, `CP8_DC_REPORT.md:786`).

**The write.** One batch:
- the upsert, with `enabled_at = now` when `enabled` goes from 0 (or no row) to 1, and kept otherwise;
- an `audit_events` row `checkout_reminders.settings` with `{ enabled, delayHours }` and, for an acting-as platform user, the grant id (AC15, as store settings do: `admin-settings.ts:46-49`).

The settings trigger bumps the shop's `catalog_version` (§3.2).

#### 7.2 The page and its Swedish texts

**Where.** Inställningar, the existing card "Övergiven kassa" (`AdminSettings.jsx:1021-1052`). It shows only while `isEnabled('abandonedCheckout')` (`:82`), which in the admin build is the platform's add-on AND ported (`routes/admin-session.ts:108-122`, §8.2). The admin build's `loadCartRecovery` / `saveCartRecovery` (`src/admin-app/replacements/shopConfig.js:199-203`) call the route through a new `src/api/admin/checkoutReminders.js`. The page's load and save (`AdminSettings.jsx:160-176`, `:209-222`) gain `enabled`.

**The texts:**
- Intro (replaces `:1025-1029`): "Skicka ett påminnelsemejl till kunder som kom till betalningen men inte slutförde köpet. Högst en påminnelse per kassa och högst en per kund och vecka. Bara kunder som kryssat i påminnelserutan eller sagt ja till e-post från butiken får mejlet."
- Switch: "Skicka påminnelser". Off: "Av: inga påminnelser skickas." On: "På sedan {datum}: kassor från och med då kan få en påminnelse."
- Delay (unchanged): "Fördröjning innan påminnelse (timmar)", help "Mellan 1 och 24 timmar. Standard: 1 timme."
- Count: "Köade påminnelser de senaste 30 dagarna: {n}".
- Without mail (`mailConfigured: false`, amber, as CP9-OB's invite notice): "E-post är inte inställd här ännu. Påminnelser köas men skickas inte förrän plattformen har ställt in e-posten."
- Save: "Spara". Toasts unchanged: "Inställningar för övergiven kassa sparade." / "Fel vid sparande av inställningar för övergiven kassa" (`:215`, `:218`).
- A note under the intro (the owner's note, not verified as law; AC5): "Påminnelserna skickas i butikens namn. Du ansvarar för att de följer marknadsföringslagen."

**The older build** (Firestore `shopConfig.js:99-135`) keeps its seam. The shared page writing `{ delayHours, enabled }` there is harmless: the Firebase sweep ignores `enabled`.

#### 7.3 What the seller sees and never sees

**The seller sees:** the switch, the delay, one count and the mail notice.

**The seller never sees:**
- a buyer's address, name or cart from an unpaid checkout;
- a list of abandoned checkouts;
- whether a given address unsubscribed.

The old admin showed none of these either (§1.1: the card held one number field, and nothing under `src/` reads `checkouts`). A paid order's consent is visible as it is today (`consent.ts:255-281`). `reminder` could be added to that view later (§12.2).

#### 7.4 What the platform sees

**In the console:** the add-on "Övergiven kassa" per shop in Tillägg (exists: `src/admin-app/adapters/platformConsole.js:18`, `src/admin-app/adapters/platformShops.js:178`; the description in `src/config/addons.js:33` still fits).

**Not in the console:** decisions and suppressions; those are in D1. The step's summary lands in the cron log with counts and no addresses.

### 8. The feature flag and D81

#### 8.1 The two switches

**The platform's add-on** is `tenant_features` key `abandonedCheckout`, toggled by `PUT /v1/platform/tenants/:id/features`.
- Its default today is ON (`tenant-config.ts:151-162`).
- **Recommended: opt-in (AC2)**, as CP8-DC made `discountCodes` (DC2). Add the key to `OPT_IN_KEYS` (`tenant-config.ts:151-156`) and, in lockstep, to the importer's `OPT_IN_FEATURE_KEYS` (`scripts/cf-port/migrate/lib/transform-shops.mjs:101-102`, "pinned by the same test").
- Consequence at import: melodie-mc and robowatz (explicit `true` in Firebase) get an explicit row ON; gif-sundsvall, ninetone and sillmans (absent, so ON in Firebase) get OFF (`transform-shops.mjs:363-372`, `:380-384`).
- Staging's explicit rows: not verified (`SELECT tenant_id, enabled FROM tenant_features WHERE feature_key = 'abandonedCheckout'`).

**The seller's switch** is `checkout_reminder_settings.enabled`, default off (AC3).

**What each surface reads:**
- `GET /v1/storefront` `features.abandonedCheckout` = ported AND the add-on AND the seller's switch. Only then does the checkout show the box (§2.4). `getPublicStorefrontVersioned` reads the settings row in its existing batch (`public-storefront.ts:142-163`); `publicFeatures` stays as it is and its value is ANDed with the switch.
- The admin's features (`admin-session.ts:108-122`) = ported AND the add-on, without the seller's switch, so the card shows while the platform allows the feature.
- The cron step (§4.3, checks 2 and 3) and the mail effect read both.
- The two public routes read neither.

#### 8.2 Reversing D81 for this key only

D81 (`DECISIONS.md:113`, `:158`) reports a not-ported feature as off and took its pages out of the build. CP8-DC reversed it for `discountCodes` with one constant and a body revision (`CP8_DC_REPORT.md:653-681`, `:856`, `:872`; `public-storefront.ts:46-54`; `public-routes.ts:38-54`). Here:

1. `cloudflare/src/storefront/public-storefront.ts:54`: `PORTED_FEATURE_KEYS = ["pod", "discountCodes", "abandonedCheckout"]`. This drives the storefront's `features` and the admin's.
2. `cloudflare/src/storefront/public-routes.ts:54`: `STOREFRONT_BODY_REVISION = 3`, with a line in its comment (`:38-50`): "Revision 3: features.abandonedCheckout (CP9-AC)".
3. AC2: `OPT_IN_KEYS` and the importer's set.
4. **Tests that pin the old values:**
   - `cloudflare/test/public-storefront.test.ts:180` (`on.abandonedCheckout` false);
   - `cloudflare/test/admin-session.test.ts:470`;
   - `cloudflare/test/tenant-features.test.ts:47` (`EXPECTED_DEFAULTS`) and `:167-218`, which use `abandonedCheckout` as their default-ON example key (CP8-DC moved them there, `CP8_DC_REPORT.md:856`). Move them to `productReviews`, the one default-ON key left;
   - every ETag pin that names `-r2`: `web-worker.test.ts`, `discount-storefront.test.ts`, `stand-in-frames-seller-storefront.test.ts`, `pod-publish.test.ts` (the CP8-DC list, `CP8_DC_REPORT.md:856`; the builder greps `-r2`);
   - the importer's test that pins the opt-in set.
5. **The storefront:** the two routes and pages (§6.7) and the checkout box (§2.4).
6. **The admin:** the card (§7.2).
7. **Design gate.** The checkout's contact step gains a box, so its storefront baseline shot changes; re-shoot it. Shoot the two new pages and the admin card at 375 px and at desktop width (the working method's design gate: storefront NORD, admin neutral).
8. **Docs:**
   - `DECISIONS.md`: a numbered decision for this reversal (the number after the last in use; D99–D103 appear only outside `DECISIONS.md`, `HANDOVER.md`; not verified as the last);
   - `PLAN.md:106`: "abandoned-cart reminder emails" leaves §3.2;
   - `CP5_GAP_ANALYSIS.md:111`: the row;
   - `MIGRATION_MANIFEST.md:73`: the suppression import of §3.7;
   - `HANDOVER.md`.

Nothing else of D81 moves. Reviews, affiliate, B2B and customer accounts stay off.

#### 8.3 The cached storefront response

**The deploy.** Raising the revision makes every ETag kept from before the deploy miss once (`public-routes.ts:38-44`). No catalogue bump is needed.

**Later switch changes.** The settings triggers bump `catalog_version` (§3.2), so neither the seller's switch nor the add-on (0043's triggers, `migrations/0043_storefront.sql:144-165`) can leave a stale 304 behind.

### 9. Interaction with the retention sweep and with payment intents

1. **A reminder writes nothing to `checkouts`.** No status, no `updated_at`, no intent column. The sweep's clock (`crons.ts:141`, `:211`) and its cancel rule (`:132-146`) are exactly as before.
2. **Timing never meets.**
   - A decision is made between 1 h and 48 h after the checkout's creation (§4.1).
   - The sweep cancels an intent no earlier than the checkout's expiry (24 h, `checkout.ts:204`) AND 7 days after the intent's last change (`crons.ts:50`, `:140-141`), and it purges a snapshot no earlier than 7 days after that (`:202-247`). So no decision ever finds its checkout cancelled by the sweep or its snapshot purged.
   - The reminder never reads `production_snapshot_json`.
   - The resolve route reads `checkout_items`, which no sweep touches, so a link works for its 7 days whatever the sweep did.
3. **A reminder never resurrects an intent.**
   - Neither the mail nor the routes call Stripe for writing. The cron step's only Stripe call is a READ (check 12).
   - The link rebuilds a cart. The buyer's next payment step makes a new checkout with a new id and a new intent (`StripePaymentForm.jsx:345-364`).
   - The old checkout is never reopened: the payment route refuses an expired or non-open checkout (`payment.ts:363-371`).
   - The old intent stays `requires_payment_method` until the sweep cancels it, which also releases its discount hold (`crons.ts:170-189`).
4. **A cancelled intent** (in Stripe's dashboard, or by the sweep after a link's 7 days) changes nothing for the link: the cart is rebuilt and priced anew.
5. **A late success on the old intent** (the buyer pays in the old tab after the reminder) creates the order as the webhook always does (`webhook.ts:120-131`). From then on, the resolve answers `completed` for that link. If the buyer has ALSO paid the recovered checkout, there are two orders, as in Firebase (R8).

### 10. Build plan

**Models:**
- Opus for steps 1–9: schema, consent, cron, tokens and the public surface; legal and money-adjacent.
- Sonnet for steps 10–11 (the pages), with the reviewer reading the consent box and the rebuild.

This follows the owner's model rule (memory: Opus for money, tenancy, legal and schema; Sonnet for mechanical work).

**Coordinate first.** The DAC7 unit plans migrations and may also touch `email_deliveries`. Whichever unit builds second takes the next free number and rebases block 5 of §3.2 on the other's kind list.

**Every step ends with** `cd cloudflare && npx tsc --noEmit && npx vitest run <the step's files>`.

#### 10.1 Steps

| # | Step | Files | Tests (rule → test) |
|---|---|---|---|
| 1 | Migration | `migrations/00NN_checkout_reminders.sql`; `src/app.ts:492`; `test/health.test.ts`, `test/public-catalog.test.ts` (the pin) | New `test/checkout-reminders-schema.test.ts`: tenant mismatch refused; born `withdrawn` refused; a second decision for one checkout refused (UNIQUE); the cap at 7 days − 1 ms refuses and at 7 days + 1 ms admits; a `skipped` or `withdrawn` row does not count toward the cap; another tenant's or another address's row does not count; the cap's literal equals `REMINDER_CAP_MS`; the only update allowed is queued → withdrawn with a reason, every frozen column refused; no delete (all three tables); both CHECK pairs; suppressions append-only; settings `enabled = 1` without `enabled_at` refused; the settings insert and update bump `catalog_version`; `email_deliveries` admits `checkout_reminder`, still refuses an unknown kind, and keeps every row of a seeded copy (the 0050 test pattern). |
| 2 | Consent | `src/legal/consent.ts` (`reminder`, `reminderConsentGiven`) | Extend `test/legal.test.ts` and `test/checkout.test.ts`: a body without `reminder` freezes byte-identical `consent_json` to today's; `reminder: true` frozen, `reminder: false` absent from the JSON; a non-boolean `reminder` → 400; a replay across the change matches (`sameConsent`); the order copy carries it; `reminderConsentGiven` for null, unreadable, terms-only, marketing-only, reminder-only and both. |
| 3 | Tokens | `src/commerce/checkout-recovery-token.ts` | New `test/checkout-recovery-token.test.ts`: round trip per purpose; the other purpose refused; another tenant refused; one flipped character refused; malformed shapes refused; no secret → mint null, verify false; the key differs from the preview's (a preview grant's signature never verifies here). |
| 4 | Mail kind | `src/email/checkout-reminder-email.ts`; `src/email/auth-email-job.ts` (union, parse, render); `src/email/email-delivery-store.ts` (fingerprint); `src/email/email-queue-consumer.ts` (From display name, Reply-To, `headers` for this kind only) | New `test/checkout-reminder-email.test.ts`: create, parse and fingerprint agree; every URL rule (https, own tenant, path shape, no query); 1–50 lines; lifetime ≤ 2 h; Swedish text with and without a shop name, a recipient name and a support address; no digit-plus-"kr" string anywhere (no price); HTML escaping. Extend `test/email-queue-consumer.test.ts`: the Resend body for this kind has `from` = `"<shop>" <address>`, `reply_to`, both `List-Unsubscribe` headers; a shop name holding `"`, `<`, CR or LF is cleaned; every other kind's body is byte-identical to today's. |
| 5 | Mail effect | `src/commerce/checkout-reminders.ts` (the effect); `src/outbox/outbox.ts:38-46`; `src/outbox/effects.ts:24-30`; `src/outbox/email-effect.ts` (`deliver` takes a lifetime) | New `test/checkout-reminder-effect.test.ts`: each send-time re-check (paid, add-on off, switch off, orders closed, unsubscribed, superseded, nothing buyable) → `withdrawn` with its reason, outbox `done`, no job, no ledger row; the happy path → one ledger row `checkout_reminder` `pending`, `frozen_json` without the name, the retry builds the identical job; the lines listed are only the buyable ones; a reminder row of another tenant is never read; the 2 h lifetime passed → terminal failure with an alert that names no address. |
| 6 | Cron step | `src/commerce/checkout-reminders.ts` (`runCheckoutReminders`, constants); `src/storefront/public-storefront.ts` (export `shopTakesOrders`, used for `ordersOpen`); `src/outbox/scheduled.ts` (the step) | New `test/checkout-reminders-cron.test.ts`, one test per row of §4.3 with its reason; the order (a paid AND non-consenting checkout records `paid`); due vs. not yet due vs. more than 24 h late (no row); `enabled_at` (a checkout from before the switch was turned on → no row); no intent → no row; Stripe each status; Stripe 5xx → no row and no further Stripe call this tick; the batch of 25 oldest first, the 26th next tick; the cap race (two decisions for one buyer in one tick → one `queued`, one `frequency_cap`); a UNIQUE race tolerated; `checkouts.updated_at` and `payment_intent_status_at` unchanged after a decision; the outbox payload holds only `reminderId`; nothing at all without a secret, a web origin or Stripe. Extend `test/outbox.test.ts` (the step list and its isolation). Extend `test/public-storefront.test.ts` (`ordersOpen` unchanged in every case). |
| 7 | Public routes | `src/routes/storefront-checkout-recovery.ts`; `src/app.ts` (mount inside `storefront(...)`, scope constants); `web/src/api-allowlist.ts`; `test/web-routing.test.ts` | New `test/checkout-recovery-routes.test.ts`: `open` with the lines and nothing else (the denylist of §6.4); `completed`; 404 byte-equal for each case of §6.2; the resolve writes nothing (row counts before and after); unsubscribe writes one suppression and one audit row, a second call is idempotent, an 8-day-old link still unsubscribes, an RFC 8058 form body is accepted; a `withdrawn` or `skipped` reminder's token → 404; the 31st request → 429; another shop's host → 404. |
| 8 | Admin route | `src/routes/admin-checkout-reminders.ts`; `src/app.ts` mount | New `test/admin-checkout-reminders.test.ts`: the GET defaults without a row; PUT on → `enabled_at = now`; on → on keeps it; off keeps it; strict body; delay 0 and 25 → 400; the add-on off → 404 for both; cross-origin PUT → 404; acting-as allowed and its grant in the audit row; the count of 30 days; `mailConfigured` true/false. |
| 9 | D81 | §8.2 items 1–4 | The listed pins; `test/tenant-features.test.ts` (AC2); a new case in `test/public-storefront.test.ts`: add-on on + switch off → false, both on → true, add-on off + switch on → false. The importer: `node --test scripts/cf-port/migrate/test/*.test.mjs` with the opt-in set and the suppression transform (§3.7). |
| 10 | Storefront | `src/api/checkoutRecovery.js`; `src/pages/shop/CheckoutRecoveryPage.jsx`, `CheckoutUnsubscribePage.jsx`; `src/storefront/StorefrontApp.jsx`, `pages.jsx`; `src/storefront/providers/Cart.jsx` (`{ quiet }`); `src/pages/shop/Checkout.jsx` (the box); `src/components/shop/StripePaymentForm.jsx`; `src/storefront/adapters/checkout.js` (`reminder`); `src/locales/sv-SE.json`; `src/storefront/dev/dev-api.mjs` + `fixtures.json`; `guard/allowlist.txt` (−2 lines) | `src/storefront/adapters/checkout.test.mjs`: no `reminder` key unless ticked; `true` when ticked; never from another field. A pure `src/storefront/adapters/recovery.js` (the line-to-cart plan: product 404 → missing, unknown variant → missing, quantity kept, no price read from the answer) with its `recovery.test.mjs`. `src/api/api.test.mjs` for the client (404 → `invalid` / `false`). Dev API tests for the two routes. |
| 11 | Admin frontend | `src/api/admin/checkoutReminders.js`; `src/admin-app/replacements/shopConfig.js:199-203`; `src/pages/admin/AdminSettings.jsx:82-88`, `:160-176`, `:209-222`, `:1021-1052`; `src/admin-app/dev/*` | `src/api/admin/checkoutReminders.test.mjs`; dev API tests. |
| 12 | Docs | §8.2 item 8 | none |

#### 10.2 Mutations to run

Each must fail at least one test. Restore and `cmp` after each.

1. The consent check removed.
2. The consent check accepts `terms` alone.
3. `reminder: false` written into the frozen JSON.
4. The suppression check removed, at decision AND at send.
5. Supersede limited to newer `open` checkouts (Firebase's rule, F3).
6. The cap trigger made a no-op.
7. The cap counts `skipped` rows.
8. `REMINDER_CAP_MS` changed without the trigger.
9. The `paid` check reads only `status` (an order on a late-paid checkout missed).
10. Stripe `processing` treated as sendable.
11. A Stripe 5xx writes a final row.
12. The add-on check removed.
13. The `enabled_at` term removed from the candidate SQL.
14. The `orders_closed` check removed.
15. The late limit removed.
16. `ORDER BY` made descending, or the `LIMIT` removed.
17. The send-time re-check of `paid` removed.
18. The send-time re-check of the suppression removed.
19. The token's signature not verified.
20. The tenant left out of the signed message.
21. The purpose ignored.
22. The resolve answers a price or the address.
23. One 404 case answers different bytes.
24. The resume link served after `link_expires_at`.
25. The link expiry applied to unsubscribe.
26. The rate limit removed.
27. The decision updates `checkouts.updated_at`.
28. The `List-Unsubscribe` headers dropped.
29. The From display name not cleaned.
30. `PORTED_FEATURE_KEYS` without `abandonedCheckout`.
31. The public feature ignores the seller's switch.
32. `STOREFRONT_BODY_REVISION` left at 2.
33. `abandonedCheckout` not opt-in.
34. `buildCheckoutRequest` always sends `reminder`.
35. The recovery plan takes a price from the answer.
36. `checkout_reminder` missing from the ledger CHECK.

#### 10.3 Gates (all, at the end)

The CP8-DC set (`CP8_DC_REPORT.md:736-744`):
- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`
- `cd cloudflare && npx vitest run` (read the summary line; expect only added tests)
- `cd cloudflare && npm run types:check`
- `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs`
- `npx vite build`; `npx vite build --config vite.storefront.config.js && node cloudflare/web/check-storefront-build.mjs`; `npx vite build --config vite.admin.config.js && node cloudflare/admin/check-admin-build.mjs`
- `node guard/guards.test.mjs` (allowlist count = the new baseline 292)
- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`
- The design gate of §8.2 item 7 (shots looked at, not only taken).
- Codex as second reviewer before the deploy (the owner's working rule).

#### 10.4 Staging smoke with no mail account

After the reviewer's yes; production never. D1 reads are `SELECT`s only.

1. `scripts/cf-preflight.sh staging`; bookmark; apply the migration to staging D1; deploy API, web, admin. `GET /ready` names the new migration. `GET /v1/storefront` for the test shop answers `ETag: "<v>-r3"` (or `-r3-x`).
2. As the platform user, in Tillägg, turn "Övergiven kassa" on for the test shop (opt-in, AC2). As its admin (or acting as it), in Inställningar, the card shows the switch off, delay 1, count 0, and the amber no-mail sentence. Turn it on and save.
3. Storefront: the contact step shows "Påminn mig via e-post om jag inte slutför köpet" under the marketing box. With the add-on on and the switch off it does not show (check once, then turn the switch back on).
4. Three test buyers at their own test addresses:
   - **A** ticks the reminder box, reaches the payment form, and leaves.
   - **B** ticks nothing, reaches the payment form, and leaves.
   - **C** ticks the box and pays with 4242.
   - **D** ticks the box, reaches the payment form, goes back, changes the country, reaches the payment form again, and leaves. That makes two checkouts.
5. D1, right away: `SELECT json_extract(consent_json,'$.reminder') FROM checkouts WHERE …` → 1 for A, C and D's two, NULL for B.
6. Wait at least 1 h 15 min (the minimum delay plus one tick). Then D1:
   - `SELECT state, reason FROM checkout_reminders WHERE tenant_id = ?`:
     - A: `queued`.
     - B: `skipped/no_consent`.
     - C: no row. Its checkout is `completed`, and the candidate SQL takes only `open` checkouts. (`skipped/paid` appears only when the webhook is slower than the step.)
     - D: the older checkout `skipped/superseded`, the newer one `queued`.
   - `SELECT kind, status FROM email_deliveries WHERE kind = 'checkout_reminder'`: the queued ones `pending`, and `expired` 2 h later.
   - `SELECT status, result_ref FROM outbox_events WHERE event_type = 'email.checkout_reminder'`: `done`, `result_ref` = the delivery id.
7. The card's count reads the number of queued rows.
8. **The cap.** Buyer A abandons a second checkout → after the delay, `skipped/frequency_cap`.
9. **Turning off.** Switch off, then a new abandoned checkout → no row after the delay.
10. **The routes, with a forged token** (no real link exists without the mail):
    - `curl -X POST https://chopshop-web-stg.kent-ee2.workers.dev/_api/<shop>/v1/checkout-recovery/v1.00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` → 404, and a garbage token → the same bytes;
    - the same with `/unsubscribe` → 404;
    - the 31st call in 10 minutes → 429;
    - a GET → refused by the web Worker.
11. **The pages, with a forged token:** `/<shop>/aterta/x` → "Länken till din varukorg fungerar inte längre."; `/<shop>/avregistrera/x` → "Länken fungerar inte längre."; both `noindex`.
12. Look at the checkout box, the two pages and the card on a phone width.

#### 10.5 What must wait for a mail account

A Resend key and `EMAIL_FROM` as staging secrets (HANDOVER.md:171 lists them as waiting for Mikael). Then:

- The mail itself: subject, From showing the shop's name, Reply-To, the list of lines without prices, the two links, the footer, how it looks in Gmail and in Outlook.
- The real resume link: the cart rebuilt with the live prices, a missing line dropped with the toast, the checkout's fresh totals, a NEW checkout id in D1, the old intent untouched.
- The real unsubscribe:
  - the page, and Gmail's unsubscribe control (the one-click POST);
  - then a new abandoned checkout of that address → `skipped/unsubscribed`;
  - an 8-day-old unsubscribe link still works (or the test suite's proof is accepted).
- That Resend accepts the `headers` member (not verified, §5.3).

### 11. Decisions for Mikael

Yes/no. "Defaults" accepts all. **Legal** marks those where the source is your note or general practice, not verified law.

| # | Question | Recommended | Alternative |
|---|---|---|---|
| AC1 | Bring "Övergiven kassa" back on Cloudflare (reverse D81 for this feature only: the checkout box, the two pages, the settings card)? | **Yes** | No: it stays PORT-LATER. |
| AC2 | Make the add-on opt-in per shop (off until the platform turns it on)? | **Yes** | No: keep D62's default ON (every shop without a row shows the card). |
| AC3 | Give the seller their own on/off switch, off by default, and remind only checkouts made after the seller turned it on? | **Yes** | No switch: the platform's add-on alone decides (Firebase). |
| AC4 | **Legal.** Bring back the box "Påminn mig via e-post om jag inte slutför köpet", and send a reminder only when the buyer ticked it OR ticked the marketing box (your 2026-07-06 rule)? | **Yes** | (a) Only the reminder box counts; (b) no new box, the marketing box alone. |
| AC5 | **Legal.** Use the wording of §2.4 (box) and §5.2 (mail), including "Du får det här mejlet eftersom du gav {shop} lov att mejla dig", and the seller's note "Du ansvarar för att de följer marknadsföringslagen"? | **Yes** | Kent or a lawyer words them first. |
| AC6 | At most one reminder per buyer per shop per 7 days? | **Yes, 7 days** | 24 hours (Firebase). |
| AC7 | Delay 1–24 hours, default 1 hour, and never send a reminder that is more than 24 hours late? | **Yes** | Send up to 7 days late (Firebase's window). |
| AC8 | No prices, totals or discount in the mail, only the product names and quantities? | **Yes** | Show today's prices (they can still change before the buyer pays). |
| AC9 | Do not remind a checkout whose card payment was declined (Firebase's card-testing rule)? | **Yes** | Remind them too. |
| AC10 | Ask Stripe right before sending, and skip a payment that is still being processed or waiting on 3-D Secure? | **Yes** | No Stripe call: a buyer paying by a slow method may be reminded. |
| AC11 | The cart link works 7 days; the unsubscribe link never stops working? | **Yes** | Other periods. |
| AC12 | The link replaces the visitor's current cart and does not bring back a discount code (as Firebase)? | **Yes** | Merge with the current cart, or re-apply the code through the normal preview. |
| AC13 | **Legal.** The mail shows the shop's name as the sender (the platform's address underneath) and replies go to the shop? | **Yes** | The platform's name as on every other Cloudflare mail. |
| AC14 | **Legal.** An unsubscribe is permanent for that shop (ticking the box again later does not undo it); one-click unsubscribe in the mail header; the unsubscribe page acts as soon as it opens? | **Yes** | A later tick clears it; or the page asks for a click. |
| AC15 | A platform user acting as the shop may change the seller's switch (it is audited), as with store settings? | **Yes** | Only the shop's own admin. |
| AC16 | Swedish only, as every other Cloudflare buyer mail? | **Yes** | English for English-speaking visitors (the storefront has no English today). |

### 12. Risks, what is left out, and what I found wrong

#### 12.1 Risks

1. **R1 — Mail to a stranger.** Anyone can type any address, tick the box and reach the payment form, and the shop then mails that address once. Bounded:
   - by the checkout's limits (10 a minute per IP, 30 an hour per address: `app.ts:500-505`);
   - by the 7-day cap per shop;
   - by the unsubscribe;
   - by the need to reach a payment form (a Stripe intent per attempt).

   There is no double opt-in. Consent of the address holder cannot be proven (legal, not verified).
2. **R2 — Rotating `BETTER_AUTH_SECRET`** ends every link already mailed, unsubscribe included. The page's 404 text then points the buyer at replying or at the shop's address. A dedicated secret would decouple it, at the cost of a new secret to keep.
3. **R3 — A suspended or unpublished shop's pages are unreachable.** The web Worker forwards only an active shop with a verified domain (`tenancy/shop-hostname.ts:14-17`). Its unsubscribe page and one-click route answer 404 until it is active again. It sends no reminders meanwhile (`orders_closed`). D97(d) has the same gap for withdrawals (`DECISIONS.md:131`).
4. **R4 — A late mail.** A job the provider delays can arrive up to 2 h after the decision, possibly after the buyer paid.
5. **R5 — The cap constant lives in SQL and in code.** A test pins them.
6. **R6 — Stripe on the cron path.** Up to 25 reads per tick. While Stripe is unreachable no reminder is sent, and those due more than 24 h earlier are lost.
7. **R7 — Throughput.** About 2 400 decisions a day.
8. **R8 — Two orders.** A buyer who pays the old tab's intent AND the recovered checkout gets two orders (as in Firebase). The old intent stays payable until the sweep cancels it.
9. **R9 — Sender reputation.** Marketing mail of every shop leaves from the platform's one sending domain, so one shop's complaints affect all.
10. **R10 — Retention (D68, open).**
    - `checkout_reminders` and the suppressions hold address hashes with no end. A suppression must never end while reminders can be sent.
    - The checkout row itself keeps the address and the recipient indefinitely: the sweep clears only the snapshot (`crons.ts:226-231`). Firebase deleted recovery docs after 30 days (`sweep.ts:56-81`), and your note mentions a "30-day retention purge".
    - The manifest's 7-year rule for archived checkouts (`MIGRATION_MANIFEST.md:262`) points the other way.
    - For D68.
11. **R11 — Evidence of wording.** The frozen consent records that the box was ticked, not the words shown, like the marketing box today.
12. **R12 — Legal, not verified.** Whether a reminder must carry the shop's legal name and address. Whether the 7-day cap and one mail per checkout satisfy every reading of MFL.
13. **R13 — Staging can show the decision and the ledger, not the link,** until mail exists (§10.5).

#### 12.2 Left out

- A sequence of reminders.
- A discount in a reminder.
- Editable mail text per shop.
- A list of abandoned carts for the seller.
- Platform reporting.
- SMS.
- Reminders for buyers who never reached the payment form.
- Links on a shop's own domain (CP7).
- Double opt-in.
- Recording the consent wording's version.
- `reminder` in the seller's view of an order's consent.
- Prefilling the address on the rebuilt checkout (it would put the address behind the link).
- English mail.
- A per-checkout "remind me again" for the buyer.

#### 12.3 Found wrong in the existing code

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **Firebase's one-click unsubscribe pointed at a page.** `List-Unsubscribe-Post: List-Unsubscribe=One-Click` named the URL `/{shopId}/avregistrera/{token}`, a single-page route that unsubscribes only when its JavaScript runs on mount. A mail client's POST runs no JavaScript, so the one-click control most likely never unsubscribed anyone. Not verified live: how Firebase Hosting answers a POST to that path. | `sweep.ts:33-36`, `:290`; `EmailOrchestrator.ts:316-326`; `src/App.jsx:374`; `CheckoutUnsubscribePage.jsx:27-44` | Medium (old build; 0 reminders in production by the export). Fixed by §5.3 and §6.3. |
| F2 | **Firebase's unsubscribe page always said "Du är avregistrerad".** It said so even when the token was unknown (the callable throws not-found) or when the write failed (the callable swallows it and answers success). | `CheckoutUnsubscribePage.jsx:36-41`; `callables.ts:100-103`, `:125-131` | Medium (a buyer told they are out when they are not). Fixed in §6.7. |
| F3 | **A buyer who paid in a later checkout was reminded about the earlier one.** Supersede looked only at newer OPEN checkouts, and the order check only at this PaymentIntent's order. A paid newer checkout is `completed`. Every changed input (country, delivery, code) made a new PaymentIntent (`StripePaymentForm.jsx` `paymentInputsKey`, then as now), so the case is ordinary. | `sweep.ts:185-192`, `:227-242`; `stripeWebhook.ts:647-650` | Medium (old build). Fixed by §4.3 check 8. |
| F4 | **A payment still processing got a reminder.** Only an existing order stops it. A PaymentIntent in `processing` (a slower method) has no order yet. The Cloudflare Worker cannot see `processing` either (no handler records it), so the design asks Stripe. Not verified: which methods were enabled; Cloudflare creates intents with `automatic_payment_methods` (`stripe-client.ts:837`). | `sweep.ts:185-192`; `cloudflare/src/commerce/stripe-events.ts:96-97` | Medium. Fixed by §4.3 check 12. |
| F5 | **The add-on check failed open.** A Firestore read error enabled the add-on, so a marketing mail could go out for a shop the platform had turned off. | `functions/src/config/shopFeatures.ts:45-48` | Low (old build). Not ported. |
| F6 | **The "Påminn mig" box was shown on every shop,** add-on on or off: consent asked for a mail that would never come. | `git show main:src/pages/shop/Checkout.jsx` `:787-800` (no feature check in the file) | Low. Fixed by §2.4. |
| F7 | **The template contradicts its own header.** "NO discount language" in the header, then a "Rabatt" row with the old discount, plus item prices and totals that can be stale by the time the mail is read. | `abandonedCheckoutReminder.ts:2-3`, `:59-84` | Low. Dropped (AC8). |
| F8 | **The Cloudflare consent module's header** says it ported "the abandoned-checkout consent model", but `remindMe` was left out. Separately, `handleIntentStatus` says "there are no reminders here", which becomes stale with this unit. | `cloudflare/src/legal/consent.ts:2-4`; `CP2_E_REPORT.md:169`; `stripe-events.ts:186-191` | Doc only. Both comments updated in step 2 / step 6. |
| F9 | **The Cloudflare checkout accepts an address that no Cloudflare mail can be sent to.** The parser requires one `@` with non-empty sides (`anna@localhost` passes). Every mail job requires a dot after the `@`. Such a buyer can pay, and their order confirmation then fails terminally (`INVALID` → `failEmail` terminal) with an `outbox_failed` alert. | `cloudflare/src/commerce/checkout.ts:255-271`; `cloudflare/src/email/auth-email-job.ts:178-189`; `order-emails.ts:123`, `:182-188`; `outbox/email-effect.ts:294-322`, `:597-598` | Low (a typo'd address, but a paid order without a confirmation). Out of this unit: the checkout parser could require the mail shape. Here the reminder skips it as `undeliverable`. |
| F10 | **Cloudflare buyer mails do not carry the shop's name as sender.** Every job leaves as `EMAIL_FROM`; Firebase sent customer mail as `"<shop>" <address>`. | `email-queue-consumer.ts:151-158`; `EmailOrchestrator.ts:881-885` | Not necessarily wrong; noted for AC13, which changes it for this kind only. The order mails are left as they are. |

Seen, outside scope:
- `checkouts.status` documents `'expired'` but nothing writes it (`0009:76`; searched `cloudflare/src`). The retention sweep treats `('open', 'expired')` alike (`crons.ts:136`, `:183`). Harmless; noted.
- `D99`–`D103` exist only outside `DECISIONS.md`, so the next decision number is not verified.
