# CP13 — Affiliate on the Cloudflare port: design

Status: DRAFT 2026-10-22 on `485a6ec9` (branch `cf-port`), written after the Codex audit of step 1 (`CP13_AFFILIATE_CODEX_AUDIT.md`; its findings A/B/C are each answered below, marked **[CX-§]**). Waits for a Codex round on this document and Mikael's go before any unit is built (kickoff §5 step 2).

**Correction to the kickoff (CX-A):** the retained defaults are **15 % commission to the affiliate and 10 % discount to the buyer** (spec §2.2, §3.5); kickoff §2.3 reverses the labels.

Inputs (not re-derived here): `CP13_AFFILIATE_KICKOFF.md` (§2 launch scope, §3 D24–D30 taken, §4 Q1 decided), `specs/AFFILIATE.md` (the Firebase behaviour; "§x.y" below points there), `DECISIONS.md` D24–D30, the audit. Money is integer öre and basis points everywhere; time on new tables is ISO-8601 UTC text (PLAN §2.8); every table is tenant-scoped with an immutable `tenant_id`.

**The rule applied:** Firebase parity is the baseline. Every deviation is tagged **[DEV-n]** with its reason (a §7/§8 gap, a D24–D30 default, or a clearly better solution). Everything untagged is the Firebase behaviour rebuilt on the port's spine.

---

## 0. The decisions in one table

| # | Decision | Source |
|---|---|---|
| A1 | An affiliate is an `identity_access.account_type = 'affiliate'` identity on the ADMIN host with Better Auth sessions; one user, one `tenant_memberships` row with `role = 'affiliate'` per shop. The storefront keeps the public application form and the `?ref=` landing only. | Q1 (Mikael 2026-10-22) |
| A2 | An address already held by ANY other identity kind (tenant admin, platform admin, print operator) cannot become an affiliate, and an affiliate's address cannot become a tenant admin: one refusal, `not_addable`, as tenant-members.ts rules today. A shop admin who wants to be an affiliate of another shop uses another address. | [DEV-1] §8.1: approval must never touch an existing account |
| A3 | Approval invites (password-set link, 72 h, the reset mechanism); nothing ever stores or mails a password. "Send credentials" and manual-create-without-login are gone; "Bjud in affiliate" (admin creates + invites, no application) replaces manual create. | [DEV-2] §7.4, §8.2 |
| A4 | Attribution is code-only: `?ref=CODE` puts the code into the per-shop cart (already strictly necessary storage) as the cart's `refCode`; no separate 30-day key, no cookie, no click row with IP/UA. Clicks are counted server-side per affiliate and day with no identifier. | D27 [DEV-3] §3.3, §8.7 |
| A5 | At checkout the link code wins over a typed code; a typed affiliate code earns (attribution `code`); one code per cart at the money level; affiliate resolves before a Rabattkod on a string collision; collisions are refused at creation in both directions. | D24, D30, §4 |
| A6 | Commission base = (paid total − shipping) ex VAT at the ORDER's frozen rate; amount = round-half-up(base × commission_bp / 10 000). Defaults 15 % commission / 10 % buyer discount kept. The accrual is one append-only ledger row in the webhook's order batch, a pure function of facts frozen at quote time (including the self-referral verdict); nothing is re-resolved after payment. | D25, D30, §3.5 [DEV-4] §3.5 non-transactional award; CX-B2 |
| A7 | Reversal follows MONEY that went back: pro-rata on every settled refund (cumulative formula, idempotent per refund transition, restored when a succeeded refund later fails), full on a lost dispute (capped at the accrual). A cancel that moves no money reverses nothing; the refund that follows does. "Reverse iff accrued", never flag-gated. | D26 [DEV-5] §3.6; CX-B3 |
| A8 | Hold: an accrual becomes payable 14 days after `paid_at` (the port's `WITHDRAWAL_WINDOW_MS`) and only while the order has no open dispute. | D26 |
| A9 | Payout rail at launch = MANUAL against the affiliate's invoice (the Firebase rail), rebuilt as a reserve-first state machine (`requested → paid`, or `void` by a compensating row). The Connect rail (D29) is designed in §6.3 and built as unit A5 after launch, on Mikael's go. | [DEV-6] from D29's default, argued in §6.3 |
| A10 | Affiliate terms (platform template with shop merge fields, versioned) are accepted with a checkbox at application and again in the portal at first login when the version moved; the MFL ad-marking duty is in the text. | D28 |
| A11 | Mails: application received (applicant), new application (shop), invite/welcome (affiliate), denial (applicant), conversion / reversal / payout (affiliate). Every mail to an affiliate or applicant is sent under the SHOP's display name. No mail leaves staging; the smoke reads the ledger. | D30, Q4, §5 [DEV-7] (shop sender, F05's rule) |
| A12 | Feature key `affiliate`: allowed, OPT-IN (off by default), platform-switched. OFF = stop new activity (no form, no `?ref=`, no discount, no accrual, no approval, admin menu hidden), keep data, reversals and payouts still work. | D62 pattern, §2.8 |
| A13 | Campaigns, revenue share, `?campaign=`, the ambassador CRM, the admin "view portal" URL trick, client-side commission maths and "verify" helpers are not built. | D30, §7, §8.6 |
| A14 | The seller sees ONE number stays: the affiliate commission is the SHOP's own cost to its affiliate and IS shown to the shop admin per order (labelled "Affiliate-provision", never "intäkt"); the platform fee stays one figure; an affiliate never sees buyer data (allowlisted projection). | memory, §8.9 |

---

## 1. Identity and sessions (Q1)

### 1.1 The identity

- `identity_access.account_type` gains `'affiliate'`. SQLite cannot alter a CHECK, so migration 0058 rebuilds `identity_access` under the same name (the 0050 recipe: copy to `identity_access_migration_0058`, drop, create with the widened CHECK and the 0033 column `status_change_id`, copy back column by column, re-create `identity_access_type_status_idx` and every trigger 0033 declared on it — the builder lists them from the migrations before writing). Nothing references `identity_access` by foreign key (verified: only 0002 creates it, 0033 adds a column); every FK points at `"user"`.
- The membership: `tenant_memberships(role = 'affiliate')`, a value the 0002 CHECK already admits; `UNIQUE (tenant_id, user_id, role)` gives one membership per shop. Status `active | suspended | revoked` is the membership's; the AFFILIATE's program status (`active | inactive | suspended`, §2.2) lives on the `affiliates` row (§3.1) and gates the money paths. The membership gates the login.
- `authorizeAffiliateRequest(env, request)` (new, `src/auth/request-authorization.ts`): `X-Shop-Id` named shop → session → `authorizeAffiliate(db, userId, tenantId)` (new, live-authorization.ts): `account_type = 'affiliate' AND status = 'active'` joined to an active `affiliate` membership of an active tenant. Same null-for-everything rule, same opaque 404. No acting-as: a platform user never acts as an affiliate (the admin's detail page shows what the affiliate sees, §8.6 is not ported).
- `/v1/me` (session-self.ts) serves a third `ServedAccountType = 'affiliate'`: `memberships` carry `role: 'affiliate'` for that type (the predicate re-used with the role parameter). The admin SPA reads `accountType` and mounts the affiliate shell (§7.3).
- Every place that enumerates the account types gains the value or refuses it explicitly; the audit's table B5 is the builder's checklist, with these decisions: `user-directory.ts ACCOUNT_TYPES` (listed, filterable; the platform console's user list, which today asks for admins only, gains an "Affiliates" filter); `user-lifecycle.ts` deactivate/reactivate admit the new type generically (sessions revoked on suspension), and a NEW tenant-scoped `revokeAffiliateMembership` is added (`revokeTenantAdmin` is not reused); `tenant-members.ts` keeps `not_addable` for an affiliate address (A2) and the affiliate approval applies the symmetric refusal; `provision-users.ts createInvitedUser` admits `affiliate`, the platform's create-user route keeps refusing it; `invites.ts inviteSurfaceFor` maps `affiliate` to the EXISTING `admin` surface and `INVITABLE_TARGET_SQL` admits the type (no new reset surface or origin: the admin reset page serves affiliates, `password-reset.ts` is untouched); `provision-tenants.ts grantTenantAdmin` keeps refusing to convert another kind; `auth-email-job.ts` gains the `affiliate_invite` variant carrying validated shop context (§9.3): the plain invite hard-codes the platform name and is not reused as is.

### 1.2 Login and the password-set link

- Login page: the admin host's existing login (`src/pages/LoginPage.jsx`), unchanged; after sign-in `/v1/me` says `affiliate` and the SPA routes to `/affiliate`. Password reset: the ordinary reset, unchanged (it lands on the admin surface, which now serves affiliates; it stays platform-branded, as a shared multi-shop credential has no one shop).
- **D30 "per-shop logins" is read as ONE affiliate credential (one email, one password) with one scoped membership per shop**, the kickoff's membership reading. Literally separate credentials per shop would need separate addresses or an auth redesign (Better Auth's email UNIQUE); not done. [CX-C2]
- The invite: `issueInvite` with the new surface; the token is the reset token (single use, 72 h, previous unused token superseded). The mail is the affiliate welcome (§9.3) carrying the link, the code, the `?ref=` link and the rates. Resend from the admin's affiliate detail page while the person has not set a password (tenant-members.ts's `ownPasswordSql` rule reused).

### 1.3 The collision rule (A2) and why

One `"user"` row per email (Better Auth UNIQUE), one `identity_access` row per user, one `account_type`. So an address is EITHER an admin's or an affiliate's. The alternative (a second user row per affiliate) is forbidden by the UNIQUE; the alternative (`account_type = 'ordinary'` + role) would make an affiliate indistinguishable from a future customer account in the directory, the lifecycle and `/v1/me`. Refusing the collision costs one line of copy on the approval screen: "Adressen används redan av ett annat konto på plattformen. Be personen ansöka med en annan e-postadress." A shop admin of shop A may still be an affiliate of shop B — with another address. Self-referral (§5.4) is unaffected.

---

## 2. Attribution (Q2, Q3, D24, D27)

### 2.1 The `?ref=` landing (storefront, A4)

- Anywhere on `<shop>.flippinstuff.se/...?ref=CODE` (the web Worker already serves the SPA shell for every page). The SPA (`AffiliateRef` hook mounted in the storefront app, replacing `AffiliateTracker.jsx`) normalises the code (trim, upper-case; §7.6's case bug cannot recur), stores `{ refCode }` in the per-shop cart (`CartContext`'s existing per-shop `localStorage` key) and strips the parameter from the address. Nothing else is stored: no expiry key, no click id, no global key (§8.5's cross-shop leak cannot recur).
- The storefront reports `features.affiliate` in `GET /v1/storefront` (`PORTED_FEATURE_KEYS` gains `affiliate`); with it OFF the hook is inert and the form page answers the shop's 404 page.
- The click count [CX-B9]: the WEB WORKER counts, not the browser. When `servePage` serves a storefront page whose URL carries `?ref=`, it calls the API over the service binding (`POST /v1/internal/affiliate/ref { code }`, NOT on the browser allowlist, so no browser can inflate it directly) with the normalised code and the tenant from routing; the API resolves `(tenant, code)` to an ACTIVE affiliate of a shop with the add-on ON and upserts `affiliate_click_days(tenant_id, affiliate_id, day) += 1`; the page is served whatever the answer (the count never delays or fails a page: `ctx.waitUntil`). Only page landings count: never assets, HEAD, API calls. No IP, UA or referrer is read for it. What this gives: referral-link landings per affiliate per day, labelled so in the UI ("Länkbesök"), never "unika besökare". What it does NOT give: unique visitors, conversion per click. Conversions come from orders attributed by code; the ratio shown is "beställningar per länkbesök", an aggregate, not a click-conversion rate.
- A later consent-gated 30-day cookie (D27's "only with consent") is NOT built: the storefront has no consent banner because it runs no trackers (memory `cookie_consent_own_solution`), and a cookie would need one; if it ever is, it is set by the WEB WORKER's page response (the API's `Set-Cookie` is stripped by forward.ts). The cart-carried code lives with the cart (the port's cart `src/storefront/providers/Cart.jsx`, per-shop `localStorage`; it stores a normalised code today and gains `refCode` + `source`); the hook stamps `refCode` with its time and drops it after 30 days, and a completed checkout clears it. No 30-day promise is made to affiliates beyond that. [DEV-3]
- The link an affiliate copies is built from the shop's CANONICAL origin as the API reports it (the storefront's own `shopUrl`), never from a hostname transform assumed here: CP14 owns the `<shop>.flippinstuff.se` shape [CX-B9].

### 2.2 Which code is sent, which wins (A5)

The checkout body (`POST /v1/checkout`) gains `refCode` (optional, same grammar as `discountCode`) beside `discountCode`. The server's resolution, in `resolveDiscount` (the seam at discount-codes.ts ~L314), with `codes = { typed, ref }`:

1. If `ref` resolves to an ACTIVE affiliate of this tenant (add-on ON) → that affiliate wins: `discountMinor = ceil(subtotal × discount_bp / 10 000)` (percentDiscountMinor, the port's integer form of Firebase's `Math.ceil`), `attribution = 'link'`. The typed code is ignored and the answer says so (`discount.overriddenBy: 'link'`), so the storefront can show "Länkkoden ANNA10 används".
2. Else if `typed` resolves to an active affiliate → it wins, `attribution = 'code'`. [DEV: §3.4 by accident paid nothing for a typed code; D24 says it earns]
3. Else the campaign lookup (unchanged, only when `discountCodes` is ON), no attribution.
4. Else `discountMinor = 0`, as today.

An affiliate discount applies to the whole subtotal (never shipping) and has no cap, window or minimum spend (§4.7). Inactive/suspended affiliates and the add-on OFF fall through to step 3 on BOTH the preview and the checkout (§4.2's disagreement cannot recur: one function serves both).

**The representation [CX-B1, CX-C3]: a discriminated authority in the existing id column.** `ResolvedDiscount` gains `authority: 'campaign' | 'affiliate' | null` and `affiliate: { affiliateId, code, attribution, commissionBp, discountBp } | null`; **`discountCodeId` carries the affiliate's id for an affiliate hit** (the seam's stated contract, "the id of whatever authorized it"), which satisfies the 0010/0011 CHECK "discounted money was authorised by something" without rebuilding `checkouts` or `orders`. Every consumer of that id is made authority-aware; the audit's list is the checklist:
- `resolveDiscount` takes BOTH gates (`affiliate`, `discountCodes`) and runs each branch under its own; `checkout.ts` (~L1357) and `discount-preview.ts` (~L98) no longer skip resolution when only `discountCodes` is off, so an affiliate-only shop gets its discount.
- The checkout's HOLD insert (~L1522, FK to `discount_codes`) runs ONLY for `authority = 'campaign'`; an affiliate code is uncapped and holds nothing.
- The webhook's burn and hold statements (~L780–820) are re-gated on the frozen `discount_authority = 'campaign'`.
- `matchesExisting` (~L860–900) compares authority, affiliate id, both rates and the self-referral verdict beside amount and id: two affiliates with the same discount are never interchangeable under one idempotency key.
- The preview answers the same `{ applies, code, discountMinor }` for an affiliate hit as for a campaign hit; no identity, rate or reason leaves it (its DISPLAY-ONLY rule and the no-oracle rule both hold); `overriddenBy: 'link'` is the one new field, on the checkout answer only.
- The viability checks (minimum charge, fee coverage, ~L1401) run after resolution as today; when they discard the discount, the affiliate facts are discarded with it.
- `discount_authority` (new column, both tables) is the discriminator every reader uses; the Rabattkoder admin reads join `discount_codes` by tenant and never see an affiliate id.

### 2.3 Frozen on the checkout, copied to the order (Q2)

New nullable columns (ADD COLUMN with CHECKs, no FK — the 0010 reasoning for `discount_code_id`: a deleted or re-coded affiliate must not change a historical order):

| Column (both tables) | Meaning |
|---|---|
| `discount_authority` | `'campaign' \| 'affiliate' \| NULL`; NULL iff `discount_code_id IS NULL` (CHECK) |
| `affiliate_id` | the affiliate row's id; NOT NULL iff `discount_authority = 'affiliate'` (CHECK) |
| `affiliate_code` | the code as resolved (upper-case), for display without a join |
| `affiliate_attribution` | `'link' \| 'code'` |
| `affiliate_commission_bp`, `affiliate_discount_bp` | the rates frozen at quote time; the accrual is a pure function of frozen facts |
| `affiliate_self_referral` | `0 \| 1`, decided at QUOTE time from the checkout's buyer email (§4.3) and frozen, so a profile change between quote and payment cannot change the award [CX-B2] |

Written in the checkout INSERT (checkout.ts ~L1450); the replay-parity check compares them (above). The webhook's INSERT INTO orders copies them (~L525–560). Frozen from the moment they are written: a new BEFORE UPDATE trigger on each table aborts any change to the six columns (the 0019 `checkouts_connect_facts_frozen` shape, but with no "first non-null" exception: a checkout is quoted once) [CX-B2]. Coherence CHECKs tie them together (authority ⇔ id; affiliate ⇔ the five affiliate columns non-null).

Projections: the tenant admin's order list/detail (`admin-orders.ts`, `admin-order-list.ts`) add `affiliate: { code, attribution, commissionMinor, ledgerState } | null` (A14); the public order read (`/v1/orders/:id`, the buyer's receipt page) adds NOTHING (§8.7: the guest page must not learn the affiliate's id or commission); the confirmation page keeps its discount row labelled with the code only.

---

## 3. Data model (migration 0058)

One migration, sections in this order; the builder may split 0058 (identity + feature key) / 0059 (affiliate tables + columns) if the rebuild of `identity_access` deserves its own bookmark.

### 3.1 `affiliates`

```
affiliate_id        TEXT PRIMARY KEY
tenant_id           TEXT NOT NULL REFERENCES tenants  (immutable trigger)
user_id             TEXT NOT NULL REFERENCES "user"   (the login; UNIQUE (tenant_id, user_id))
code                TEXT NOT NULL CHECK (length 3..20 AND code = upper(code) AND code NOT GLOB '*[^A-Z0-9-]*')
status              TEXT NOT NULL CHECK IN ('active','inactive','suspended')
commission_bp       INTEGER NOT NULL CHECK 0..10000   (default 1500 written by the app)
discount_bp         INTEGER NOT NULL CHECK 0..10000   (default 1000)
name, phone, address_line1, address_line2, postal_code, city, country (TEXT, country 'SE' default, bounded)
socials_json        TEXT CHECK json object            ({ website, instagram, youtube, facebook, tiktok })
promotion_method    TEXT CHECK IN ('blog','youtube','instagram','facebook','tiktok','forum','other')
preferred_lang      TEXT NOT NULL CHECK IN ('sv','en')  (Firebase sv-SE/en-GB/en-US collapse to two)
terms_version       TEXT NOT NULL                     (the version accepted, §8)
terms_accepted_at   TEXT NOT NULL (ISO)
application_id      TEXT                               (NULL for an invited affiliate)
created_by          TEXT NOT NULL                      (the approving/inviting admin)
created_at, updated_at TEXT (ISO)
UNIQUE (tenant_id, code)
```

Code uniqueness across the two code families is a trigger pair: `BEFORE INSERT/UPDATE OF code ON affiliates` aborts when `discount_codes(tenant_id, code)` exists; `BEFORE INSERT/UPDATE OF code ON discount_codes` aborts when `affiliates(tenant_id, code)` exists (D30: refused at creation, both directions; the routes answer `conflict` as the Rabattkoder route does for its own name clash). Reserved words refused app-side: `ADMIN, TEST, REF, AFFILIATE, FLIPPINSTUFF, METEORPR` + the shop's tenant id.

**Status semantics (§2.2, §3.8):** only `active` resolves at checkout, counts clicks or accrues. Reversals, the ledger and payouts ignore status. The admin's toggle is explicit (three buttons), not Firebase's cycle. Delete is NOT offered: an affiliate with history is set `inactive`; an affiliate with no ledger rows may be deleted (the membership revoked, the identity left for the user-lifecycle) — [DEV-8] §3.8 delete left orphans.

### 3.2 `affiliate_applications`

```
application_id      TEXT PRIMARY KEY
tenant_id           TEXT NOT NULL (immutable)
status              TEXT NOT NULL CHECK IN ('pending','approved','denied')
name, email (lower-cased, parseEmail), phone, socials_json, promotion_method, message (≤ 2000), preferred_lang
terms_version, terms_accepted_at                     (the checkbox, §8)
decided_by, decided_at, decision_reason               (NULL while pending; a denial's reason is mailed)
affiliate_id                                           (set on approval)
created_at, updated_at
```

Lifecycle `pending → approved | denied` (a state machine, not deletion: §2.1 "nothing records who denied"). Retention: a daily cron deletes `denied` rows older than 12 months and `approved` rows are kept (they are the affiliate's own data). One pending application per `(tenant_id, email)` (partial UNIQUE index `WHERE status = 'pending'`): a second submission answers the same `202` and sends nothing (no oracle on whether an address applied).

Address fields are NOT on the public form: they are collected in the portal profile before the first payout request (less PII in an anonymous write). [DEV-9] §8.3

### 3.3 `affiliate_terms_versions`

`version TEXT PK, published_at, text_sha256` — the 0031 shape; the text is the platform template `src/config/affiliateTerms.js` (new; Swedish, merge fields `{{shop_name}}`, `{{commission_percent}}`, `{{discount_percent}}`, `{{support_email}}`), rendered per shop at read time. First version `2026-10-22`. The portal gate (§8) compares `affiliates.terms_version` with the current version.

### 3.4 `affiliate_click_days`

`(tenant_id, affiliate_id, day TEXT 'YYYY-MM-DD', count INTEGER) PRIMARY KEY (tenant_id, affiliate_id, day)`. An upsert per landing. No other column. Nothing to purge.

### 3.5 `affiliate_ledger` (append-only)

```
entry_id        TEXT PRIMARY KEY
tenant_id       TEXT NOT NULL (immutable)
affiliate_id    TEXT NOT NULL
kind            TEXT NOT NULL CHECK IN ('accrual','reversal','payout','payout_void','adjustment')
amount_minor    INTEGER NOT NULL              (accrual > 0; reversal, payout < 0; payout_void > 0; adjustment ≠ 0)
order_id        TEXT                           (accrual, reversal)
ref             TEXT NOT NULL                  (the idempotency key: accrual = order_id; reversal = the refund operation id or the dispute id; payout/void = payout_id; adjustment = a fresh id)
available_at    TEXT                           (accrual only: paid_at + 14 days)
reason          TEXT                           (adjustment: required, ≤ 500)
created_by      TEXT                           (admin user id, or 'system')
created_at      TEXT NOT NULL
UNIQUE (tenant_id, affiliate_id, kind, ref)
```

Triggers: no UPDATE, no DELETE (the 0031 append-only pair). Balances are sums (§4.4). `UNIQUE (…, kind, ref)` makes every writer idempotent by construction: a replayed webhook, a replayed refund fact, a double-clicked payout request each insert nothing the second time (the writers use `INSERT … SELECT … WHERE NOT EXISTS`, so a batch never aborts on the replay).

### 3.6 `affiliate_payouts`

```
payout_id         TEXT PRIMARY KEY
tenant_id, affiliate_id
amount_minor      INTEGER NOT NULL CHECK > 0
status            TEXT NOT NULL CHECK IN ('requested','paid','void')
rail              TEXT NOT NULL CHECK IN ('manual','connect')     (launch: manual only)
invoice_object_id TEXT                       (private `document` object, nullable: a private person cannot invoice)
invoice_number    TEXT CHECK length 1..50
requested_by      TEXT NOT NULL              (the affiliate's user id, or the admin's)
requested_at      TEXT NOT NULL
paid_at, paid_by, paid_reference (≤ 100), notes (≤ 1000)
voided_at, voided_by, void_reason
created_at, updated_at
```

State machine by trigger: `requested → paid`, `requested → void`; `paid` and `void` are final. The ledger `payout` row is written in the SAME batch as the `requested` row; a void writes a `payout_void` row (+amount) in the batch that sets `void`. One open request per affiliate (partial UNIQUE `WHERE status = 'requested'`).

### 3.7 Columns on `checkouts` / `orders`

§2.3. Plus `email_deliveries.kind` rebuilt (the 0050 recipe applied to the LATEST shape: 0056 added `checkout_reminder`, which must survive) with the new kinds of §9.

### 3.8 Feature key

The two 0032 allowlist triggers are replaced with `affiliate` added; `tenant-config.ts`: `affiliate` moves from `NOT_PORTED_FEATURE_KEYS` to `FEATURE_KEYS` and into `OPT_IN_KEYS`; `test/tenant-features.test.ts`'s expected map gains `affiliate: false`; `admin-session.ts` and `public-storefront.ts PORTED_FEATURE_KEYS` serve it.

---

## 4. The commission ledger

### 4.1 Accrual (A6), in the webhook's order batch

Condition: the checkout's frozen `discount_authority = 'affiliate'` AND frozen `affiliate_self_referral = 0`. Nothing else [CX-B2, CX-C8]: the webhook honours the checkout row ("The `checkouts` row is. Nothing else.") and does not re-check the add-on, the affiliate's status or the code at payment time, exactly as it does not reprice a lapsed quote. Switching the add-on off or suspending an affiliate stops NEW quotes (§2.2); a quote already accepted settles. This is a deliberate correction of Firebase's award-time gate (§3.5). The row is `INSERT … SELECT … WHERE NOT EXISTS (same tenant, affiliate, kind, ref)`, so a replayed delivery inserts nothing and never raises a UNIQUE violation that the deliberately narrow `isDuplicateDelivery` would have to classify. The Firebase order of operations (claim, then loose writes) cannot recur: the accrual either lands with the order or the order does not land. The conversion mail's outbox row (§9) is in the same batch.

Formula, integer only:

```
G       = max(0, total_minor − shipping_minor)       // discounted goods, VAT-inclusive (shipping's own VAT leaves with shipping)
B       = G − vatMinor(G, vat_rate_bp)               // goods ex VAT in öre: shipping.ts vatMinor (half-up on the net), the ORDER's frozen rate
amount  = floor((B × commission_bp + 5000) / 10000)  // half-up to the öre, Firebase's Math.round
```

The base is rounded to the öre BEFORE the rate is applied (Firebase rounded only the final commission off a fractional base): the result can differ from Firebase by one öre on some orders, and this is the one versioned rule (`formula_version = 1` recorded on the accrual row) [CX-B10, CX-C9]. `B × bp` stays below 2^53 for every total the checkout admits (MAX_VAT_SAFE_TOTAL_MINOR); the helper asserts it.

Worked example (§3.5): 500 kr cart, 10 % → 50 kr off, shipping 29 kr: `total 47 900, shipping 2 900 → G 45 000 → VAT 9 000 → B 36 000 → 15 % = 5 400 öre = 54,00 kr` (the order's whole VAT is 9 580, of which 580 is shipping's). Same as Firebase. Difference from Firebase (D25): a zero-rated or 6 %/12 % tenant is computed at ITS rate, not a global 25 %.

`available_at = paid_at + 14 d` (A8). The row's `created_by = 'system'`.

### 4.2 Reversal (A7)

Hook points, each inserting `kind = 'reversal'` with the cumulative formula below, in the SAME batch as the money fact [CX-B3]:

- `refunds.ts orderEffectStatements` (~L135), the statement builder every refund transition runs through (`transitionOperation` for known operations, and the INSERT path that births a dashboard refund from `charge.refunded` or the reconciliation cron). The ledger statement is appended right after the `refund_succeeded_minor` UPDATE and is guarded by the same `transition_id` EXISTS, so it fires exactly when THIS batch moved the money. `ref = <transition_id>`; the amount is the DIFFERENCE between the required cumulative reversal (from the updated `refund_succeeded_minor`) and the sum already reversed: negative on a refund, POSITIVE when a succeeded refund later fails (`succeeded → failed` subtracts the amount again; the ledger restores the same way). Never keyed on `orders.status` (a partial refund of a shipped order keeps its fulfilment status).
- `stripe-events.ts applyDisputeFact` (~L556): its guarded order UPDATE becomes a two-statement batch, the UPDATE plus, when the status became `lost`, a reversal row with `ref = <dispute id>` and amount = −(accrual − already reversed), guarded on the UPDATE's own `dispute_recovery IS ?` read. An open dispute blocks payout (§4.4) and reverses nothing; `won`/`warning_closed`/`prevented` reverse nothing.

Cumulative, so partial refunds in any order sum exactly and a full refund reverses exactly the accrual:

```
required = roundHalfUp(accrual × min(refund_succeeded_minor_after, charged_minor) / charged_minor)   // lost dispute: accrual
row      = −(required − already_reversed)                                                           // written when ≠ 0; total reversal never exceeds the accrual
```

"Pro-rata" is against the CHARGED total [CX-C5]: the port's refund carries an amount, not a goods/shipping allocation, so a shipping-only refund also reverses its share. Deterministic, never over-reverses, never inferred from the free-text reason; a structured allocation (then: shipping-only ⇒ reverse nothing) is a later change to the refund input, not this scope. Stated in the admin's ledger copy: "Provisionen justeras i proportion till återbetalningen."

A cancel (`cancellation.ts cancelOrder`, invariant "CANCELLING MOVES NO MONEY", `moneyMoved: false`) inserts nothing; the refund the shop then makes reverses. While an order is cancelled and not yet refunded its accrual is HELD (§4.4), so it cannot be paid out in between. If the shop cancels and never refunds, the shop kept the money and the affiliate keeps the commission (the ledger follows money, [DEV-5] from §3.6; spec §9.2's "reverse in the cancel endpoint" is rejected for this reason). An already paid-out commission that reverses makes the balance negative: the next payout request is refused until it is positive again (§3.6's claw-back kept; the shop bears the debt when an affiliate never earns again, recorded, not pursued, as in Firebase) [CX-C7].

### 4.3 Self-referral (§3.5)

Decided at QUOTE time (the checkout parser owns the normalised buyer email) and frozen as `affiliate_self_referral`: the buyer's email equals the affiliate user's email, OR equals any ACTIVE admin's email of the shop → `1` → no accrual; the buyer keeps the discount; the admin's order detail shows "Självköp – ingen provision". A cheap guard, not a proof: two addresses of one person cannot be told apart on an anonymous checkout; the terms (§8) forbid self-purchase and the shop can void by adjustment. [DEV-10] §8.5

### 4.4 Balances (the portal, the admin, the payout gate)

```
balance        = Σ amount_minor                                            (all kinds)
held           = Σ accrual.amount_minor WHERE available_at > now
                 + Σ accrual.amount_minor WHERE the order has an open dispute (payouts.ts isDisputeOpen),
                   a refund operation in 'reserved'/'submitted', or cancelled_at set with refund_succeeded_minor < charged_minor
payable        = max(0, balance − held)
earned_total   = Σ accrual + Σ reversal
paid_total     = −Σ payout (status paid) 
```

One SQL aggregate per read; nothing stored, nothing to reconcile (§2.2's "nothing reconciles the balance" cannot recur).

### 4.5 Add-on OFF (A12)

No `?ref=` count, no discount (step 1–2 of §2.2 skipped, campaign codes still work — §4.2's unusable Rabattkod cannot recur), no accrual, no approvals, form page gone, admin menu item gone and `/v1/admin/affiliates/*` answers 404. Reversals and payouts keep working (they read nothing gated). The affiliate can still log in and see the ledger and request a payout (the portal is gated on the membership, not the add-on; copy: "Programmet är pausat av butiken").

---

## 5. Application → approval → code

### 5.1 The public form (storefront, NORD) — `<shop>.flippinstuff.se/affiliate`

Route `POST /v1/affiliate/apply` (storefront, web allowlist). Rate limit 5 / hour per visitor + 20 / day per tenant (hashed keys, 0008). Body: `name, email, phone?, socials?, promotionMethod, message?, preferredLang, termsVersion, termsAccepted: true`. Validation app-side (bounded strings, the email rule, the current terms version). Answer `202 { applicationId }` always after validation (a duplicate pending address also 202; nothing sent). One batch: the application row + two outbox `email` rows (§9). The form page shows the terms (rendered for the shop) with the checkbox and the privacy line; the thank-you says "Vi hör av oss inom 1–3 arbetsdagar" (one figure, §6.2 had two).

### 5.2 The admin queue and the decision

`GET /v1/admin/affiliates/applications` (pending first, newest first, cursor). `POST …/applications/:id/approve { code?, discountPercent?, commissionPercent? }` and `POST …/applications/:id/deny { reason }`.

Approve, one logical operation in this order (the batch shape of tenant-members.ts):
1. `parseEmail`; the address is looked up in `"user"` + `identity_access`: an existing identity of another kind, or a suspended/revoked one → `not_addable` (A2). An existing ACTIVE `affiliate` identity (an affiliate of another shop, or re-approved here) → reuse the user row; it just gains this shop's membership.
2. `createInvitedUser` (password-less, `account_type = 'affiliate'`) when the user is new.
3. One batch: `tenant_memberships (role affiliate)` INSERT (or re-activate), `affiliates` INSERT with the code (vanity from the body or `NAME3 + 6 random base32`, upper-case; the trigger pair refuses a collision → `conflict`, the admin retries with another code), the application `pending → approved` guarded on `status = 'pending'`, the audit row `affiliate.approve`.
4. `issueInvite` (surface `affiliate`) → the welcome mail with the link (§9.3). `mailConfigured: false` in the answer on staging, as the members route says it.

Deny: `pending → denied` with `decided_by/at/reason` + the denial mail (outbox) in one batch. Nothing is deleted.

"Bjud in affiliate" (`POST /v1/admin/affiliates { name, email, code?, …rates }`): steps 1–4 without an application row (`application_id NULL`). Replaces manual create [DEV-2].

### 5.3 Editing

`PATCH /v1/admin/affiliates/:id` — rates (whole percent in the UI, bp in the row), status, code, contact, socials, preferred language. A code change is allowed; the page warns "Gamla länkar med den tidigare koden slutar fungera" (Firebase stranded old links too, §3.2; aliases are not built). Rates apply to FUTURE checkouts only (frozen at quote).

---

## 6. Payout

The manual rail is itself reserve-first [CX-B4]: the request RESERVES (the ledger `payout` row, guarded in SQL on `payable ≥ amount` in the same batch), `paid` is the shop's recorded EVIDENCE of a payment made outside the system (reference, date, who), and `void` releases by a compensating row. A recorded request is never treated as a payment; an uploaded invoice is never treated as a payment.

### 6.1 The affiliate's request (portal)

`POST /v1/affiliate/payouts { amountMinor?, invoiceObjectId?, invoiceNumber? }` — amount defaults to `payable`; refused when `amountMinor > payable`, when an open request exists, or when the profile lacks name + address (the invoice's counterparty). The invoice PDF: the affiliate reserves a private `document` object (`/v1/affiliate/objects`, the admin object route's reserve→upload→activate shape re-used with the affiliate principal, PDF only, 10 MB). One batch: the `affiliate_payouts (requested)` row + the `ledger(payout, −amount)` row, both guarded on `payable >= amount` computed inside the batch (the SQL aggregate of §4.4 in the WHERE). The admin is notified (§9.6).

### 6.2 The shop's side (admin)

`POST /v1/admin/affiliates/:id/payouts` (the admin records a payout it initiated — a request is created and paid in one go, invoice optional), `POST …/payouts/:payoutId/paid { reference?, notes? }` (`requested → paid`, mail to the affiliate), `POST …/payouts/:payoutId/void { reason }` (`requested → void` + `payout_void` row, mail). Money moves outside the system (bank/Swish) exactly as in Firebase §3.7; the port records it with a state and never deletes (§3.7's "only completed, no undo" cannot recur). An invoice whose request never lands stays a `pending` object: no sweep exists today for pending reservations (verified: object-store.ts has none; the "garbage for the sweep" comment in object-routes.ts is not a cleanup), a pending object is never served, and A4 adds the bounded sweep.

### 6.3 The Connect rail (D29) — designed, built later as A5 [DEV-6]

Why not at launch [CX-B4, CX-C1]: the order's money sits on the SHOP's connected account (destination charge, transfer = gross, D9). The port's only transfer primitive (`StripeMoneyGateway.createTransfer`, a platform-context `transfers.create`) spends the PLATFORM's balance: a platform→affiliate transfer would turn "no platform cut" into "the platform pays the shop's commission", and `source_transaction` names a funding charge, not an account to debit. The shop-funded shape is two reconciled legs: (1) an **Account Debit**, a charge whose `source` is the shop's connected account, moving the amount to the platform balance (Stripe's documented flow for debiting a connected account; subject to eligibility, consent, same-region/currency and cost, all to be PROVEN on the sandbox before A5 is briefed), then (2) a platform→affiliate transfer; each leg reserve-first, executed in the reconciliation cron, idempotency key = the leg's row id, unknown outcomes kept (withholding-release.ts's discipline, D38). It also needs the affiliate's own Express onboarding (connect-onboarding.ts's pattern with an affiliate-owned account mapping, never the shop's) and decisions on who bears Stripe's costs and how a later reversal recovers paid money. Changing the charge model (separate charges and transfers) is a far larger review of refunds, fees and payouts and is out of the question for this checkpoint. ≈1–1½ units of money code with Codex rounds; the manual rail ships the program on day one with the same ledger, and `affiliate_payouts.rail` already distinguishes the two. Recommendation: build A5 when the first affiliate asks for it, and never enable an automatic payout merely because an affiliate holds a Connect account.

---

## 7. Routes and surfaces

### 7.1 API (all new; prefix per principal)

| Principal | Route | Notes |
|---|---|---|
| storefront | `POST /v1/affiliate/ref` | §2.1, 204 always |
| storefront | `POST /v1/affiliate/apply` | §5.1 |
| storefront | `GET /v1/affiliate/terms` | the rendered terms for the shop + version (the form page) |
| storefront | `POST /v1/checkout` (+`refCode`), `POST /v1/discount-codes/preview` (+`refCode`) | §2.2 |
| tenant admin | `GET/POST /v1/admin/affiliates`, `GET/PATCH /v1/admin/affiliates/:id`, `POST …/:id/invite` (resend) | |
| tenant admin | `GET …/applications`, `GET …/applications/:id`, `POST …/approve`, `POST …/deny` | |
| tenant admin | `GET …/:id/ledger`, `GET …/:id/orders` (the shop's own orders attributed to this affiliate: number, date, total, commission, state), `GET …/:id/payouts`, `POST …/:id/payouts`, `POST …/payouts/:payoutId/paid`, `POST …/payouts/:payoutId/void` | |
| tenant admin | `GET /v1/admin/affiliates/analytics?since=` | totals + ranking from the ledger and click days |
| affiliate | `GET /v1/affiliate/me` (`X-Shop-Id`): rates, code, link, balances, terms state; `GET /v1/affiliate/orders`: the ALLOWLISTED projection (order number, paid date, base ex VAT, commission, state `held/payable/reversed`, currency); `GET /v1/affiliate/ledger`; `GET/POST /v1/affiliate/payouts`; `PATCH /v1/affiliate/profile`; `POST /v1/affiliate/terms/accept`; `POST/PUT /v1/affiliate/objects` (invoice: PDF only, ≤ 10 MB, checked server-side beyond the generic private upload's rules), `GET …/payouts/:id/invoice` (the affiliate's own, checked payout→affiliate, not tenant only) | never a buyer field (§8.9); built field by field from named columns; the suites walk the answer against the buyer-field denylist; the admin Worker's API allowlist (`cloudflare/admin/src/routing.ts`) gains the `/v1/affiliate/*` rows |
| internal | `POST /v1/internal/affiliate/ref` | web Worker only (service binding); on no browser allowlist |
| platform | `PUT /v1/platform/tenants/:id/features` | unchanged; `affiliate` is now a legal key |

Every admin route is behind `isFeatureEnabled(tenantId, 'affiliate')` except the payout and ledger reads/writes (A12). All routes in `src/routes/affiliate-*.ts`, mounted in `app.ts` at `CP13-ROUTES-x` anchors. The storefront route table (`cloudflare/web/src/api-allowlist.ts`) gains `POST /v1/affiliate/apply` and `GET /v1/affiliate/terms` only. `GET /v1/storefront` reports `features.affiliate` (its body revision is bumped, as its header requires).

### 7.2 Shop admin pages (admin build, Admin-Neutral, `<AppLayout>` — the design gate applies)

| Route | Page | Content (Swedish copy) |
|---|---|---|
| `/admin/affiliates` | `AdminAffiliates` (port of the Firebase page) | KPI strip: "Väntande ansökningar", "Klick (30 dagar)", "Konverteringar (30 dagar)", "Upplupen provision"; the applications table (Namn, E-post, Kanal, Inkom, [Granska]); the affiliates table (Kod, Namn, Status pill, Provision %, Rabatt %, Klick, Konv., Intjänat, Att betala, [Hantera] [Utbetalning]) + "Bjud in affiliate" button; "Testlänk" copies `https://<shop host>/?ref=CODE` |
| `/admin/affiliates/applications/:id` | `AdminAffiliateApplication` | the application; approve form (Kod (valfri), Kundrabatt %, Provision %) → "Godkänn och bjud in"; deny form (Orsak) → "Avslå" |
| `/admin/affiliates/:id` | `AdminAffiliateEdit` (port) | header with code + status; cards: "Statistik" (klick per dag-graf 30 d, konverteringar, intjänat/återfört/utbetalt/saldo), "Beställningar" (projection), "Reskontra" (ledger rows with kind labels: Provision, Återföring, Utbetalning, Återkallad utbetalning, Justering), "Utbetalningar", "Uppgifter" (edit form), "Konto" (invite state: "Inbjudan skickad, lösenord ej satt" + "Skicka inbjudan igen"), status buttons Aktiv/Inaktiv/Avstängd, "Lägg till justering" (amount ± with reason) |
| `/admin/affiliates/new` | `AdminAffiliateInvite` | Namn, E-post, Kod (valfri), rates → "Bjud in" |
| `/admin/affiliates/:id/payout` | `AdminAffiliatePayout` (port) | the open request if any (belopp, faktura-PDF link, "Markera som betald" with Referens/Anteckning, "Avvisa" with Orsak); "Registrera utbetalning" form (Belopp ≤ att betala, Fakturanummer (valfritt), Faktura-PDF (valfritt), Anteckning) |
| `/admin/affiliates/analytics` | `AdminAffiliateAnalytics` (port, simplified) | period selector (30/90/365 d, REAL), totals (klick, konverteringar, konverteringsgrad, provision, obetald provision, aktiva affiliates), ranking table by Konverteringar / Provision / Klick |
| `/admin/orders/:id` | existing detail | pill "Affiliate: CODE (länk/kod)" + row "Affiliate-provision 54,00 kr" + ledger state; "Självköp – ingen provision" when blocked |
| `/admin` dashboard | existing | tile "Affiliate-provision (30 dagar)" — a cost, named so; "Aktiva affiliates" |

The menu item "Affiliate" below the add-on divider, gated on the key (AppLayout.jsx already does this for the Firebase build; the admin build's `pages.jsx` swaps the five pages in).

### 7.3 The affiliate portal (admin build, a THIRD shell: `AffiliateApp.jsx`, the Admin-Neutral tokens, its own minimal layout with a shop picker when the user has several memberships)

| Route | Content (Swedish copy) |
|---|---|
| `/affiliate` (Översikt) | "Din kod" with copy; "Din länk" `https://<shop host>/?ref=CODE` with copy + QR; "Dina villkor": "Kundrabatt 10 % · Din provision 15 % av nettovärdet (exkl. moms och frakt)"; balances: "Att betala", "Under ångerfrist (14 dagar)", "Utbetalt", "Intjänat totalt"; last 10 orders (projection); "Begär utbetalning" button (disabled with the reason: belopp 0 / öppen begäran / profil saknar adress) |
| `/affiliate/orders` | the projection, paged |
| `/affiliate/payouts` | request form (Belopp (förifyllt), Fakturanummer, Faktura-PDF) + history with status pills "Begärd / Betald / Avvisad" |
| `/affiliate/profile` | name, phone, address (required before payout), socials, language; "Byt lösenord" = the ordinary reset link |
| `/affiliate/terms` | the current terms rendered for the shop; the acceptance gate (§8) lands here |
| sign-in | the admin host's login; the invite link lands on the reset page then `/affiliate` |

Not built from §6.2: the success guide (fishing copy), materials tab (the `marketingMaterials` add-on is a separate thing), campaigns tab, "30 dagar" mislabels, live stats.

### 7.4 Storefront (NORD)

- `/affiliate`: "Bli affiliate hos {{shop_name}}" — intro (from a platform default text, editable later under the de-brand direction), the form (Namn*, E-post*, Telefon, Kanal* (select), Länkar (Webbplats/Instagram/YouTube/Facebook/TikTok), Berätta om dig (textarea), Språk*, checkbox "Jag godkänner affiliatevillkoren (version X) och att mina uppgifter behandlas enligt integritetspolicyn"*), "Skicka ansökan"; thank-you state. Footer link "Bli affiliate" when the feature is on.
- `?ref=` hook (§2.1); the cart/checkout: the code box pre-filled with the link code and a line "Länkkod ANNA10 tillagd – 10 % rabatt"; a typed code while a link code is live shows "Länkkoden ANNA10 används i stället" when the server overrides; the discount row at checkout labelled "Rabatt (ANNA10)" — the campaign-vs-affiliate label split of §6.2 ("Affiliate rabatt") is dropped: the buyer does not need to know which family a code belongs to [DEV-11, less leakage].
- Order confirmation: the "registrerats för affiliate-provision" sentence is dropped (§6.2; it tells the buyer nothing useful and names a third party's money).

---

## 8. Terms and MFL (D28)

- `src/config/affiliateTerms.js`: `AFFILIATE_TERMS_VERSION = '2026-10-22'` + the Swedish template: parties (affiliate ↔ the shop; the platform is the technical provider), the code and the link, the buyer discount, the commission base and rate, the 14-day hold and the reversal rule, the payout (invoice/underlag, the shop pays, private persons: "ersättningen kan vara skattepliktig inkomst; du ansvarar för din deklaration"), **marketing law: "Du måste tydligt märka inlägg, videor och länkar som reklam/annons (t.ex. 'Reklam' eller 'Annons') enligt marknadsföringslagen; vilseledande påståenden om produkterna är inte tillåtna"**, no self-purchase, no bidding on the shop's name, termination, data processing (what the shop sees, what the platform stores), changes (a new version must be accepted in the portal).
- Acceptance evidence: the application row (checkbox + version + time); `affiliates.terms_version/accepted_at` copied at approval; in the portal, `GET /v1/affiliate/me` answers `termsOutdated: true` when the current version is newer and the shell routes every page to `/affiliate/terms` until `POST /v1/affiliate/terms/accept` lands (an audit row per acceptance). A new version = a new row in `affiliate_terms_versions` by migration, as platform terms.
- The shop's privacy policy template gains a sentence on affiliate links (the code in the cart, click counts without personal data) — a template text change under the de-brand direction, flagged for Mikael's legal read, not a code dependency.

---

## 9. Mails (Q4, A11)

All through the existing queue + `email_deliveries` ledger; kinds added to the 0050 CHECK; templates in `src/email/affiliate-emails.ts`; delivery ids derived from the outbox dedupe key as the order mails do. Sender display name = the SHOP's (shopSenderName), Reply-To = the shop's support address; the invite keeps the auth sender (it is a credential mail) but its wording names the shop.

| Kind | To | When | Body (Swedish, sv/en by preferred_lang where the recipient is known) |
|---|---|---|---|
| `affiliate_application_received` | applicant | the apply batch | "Tack för din ansökan till {{shop_name}}s affiliateprogram" + what happens next (1–3 arbetsdagar) |
| `affiliate_application_notice` | the shop (support address, else active admins) | the apply batch | "Ny affiliate-ansökan: {{name}}" + the data + link to `/admin/affiliates/applications/:id` |
| `password_reset` variant `affiliate_invite` | affiliate | approval / invite / resend | "Välkommen som affiliate hos {{shop_name}}" + set-password link (72 h) + code + `?ref=` link + rates + "Logga in på admin.flippinstuff.se" |
| `affiliate_application_denied` | applicant | deny batch | "Din ansökan till {{shop_name}}" + the reason |
| `affiliate_conversion` | affiliate | the order batch (outbox email row beside the accrual) | "Ny provision: 54,00 kr" + order number + "betalas ut efter ångerfristen (14 dagar)" |
| `affiliate_reversal` | affiliate | the reversal batch | "Provision justerad: −X kr" + why (återbetalning/tvist) |
| `affiliate_payout` | affiliate | `paid` / `void` | "Utbetalning registrerad: X kr" / "Begäran avvisad: orsak" |
| `affiliate_payout_requested` | the shop | the request batch | "{{name}} begär utbetalning: X kr" + link |

Sender rule [CX-B8]: F05's shop-sender mechanism covers buyer mails today; this unit extends `shopSenderName` to the affiliate business kinds above (the tenant id on the job selects it). The invite keeps the configured auth sender, with the shop named in its body. Every job is built once, in its mutation batch, with the display data frozen then (the email-effect's rule), delivery id derived from the outbox dedupe key.

Staging: no Resend → every row sits `pending`; the smoke proves the ledger rows and their `kind`/recipient hash, as CP10 does; the invite answer carries `mailConfigured: false`.

---

## 10. Security map (spec §8 → mechanism)

| § | Firebase defect | Port mechanism |
|---|---|---|
| 8.1 | approval overwrites any account's password | A2: existing identity of another kind → `not_addable`; an existing affiliate identity is reused WITHOUT touching its credential; invite = reset token, never a password |
| 8.2 | plaintext password at rest | nothing stores a password; `createInvitedUser` is password-less |
| 8.3 | open application create | validated body, bounded fields, rate limits per visitor and per tenant, one pending per address, 202 always |
| 8.4 | mutable counters, client payouts | append-only ledger (triggers), sums; payouts are server batches guarded in SQL; adjustments are rows with a reason and an audit event |
| 8.5 | forgeable attribution | the server resolves both codes; nothing from the client but two code strings; frozen on the checkout; the order copies; no click id exists |
| 8.6 | admin view by URL param | not built; the admin's detail page shows the same projection the portal reads |
| 8.7 | IP/UA/referer forever | no click rows; day counters only; rate-limit keys hashed (0008) |
| 8.8 | legacy flat invoice path | invoices are private objects keyed under the tenant, served to the affiliate (own) or the shop admin only |
| 8.9 | rules too tight → PII | projections with allowlists; denylist-walking tests |
| 4.3 | collisions | trigger pair + `conflict` |
| 7.6 | case bug | one normaliser on both sides (`normalizeDiscountCode`) |

---

## 11. Tests the units must write (spec §9.3 "test first" + the port's own)

Lower-case `?ref=`; the feature-key pin in `test/tenant-features.test.ts` (its hard-coded `affiliate` refusal at ~L126 flips to acceptance) and the public-storefront feature expectations; an affiliate-only shop (Rabattkoder OFF) gets the discount; no hold row for an affiliate code and the burn touches no campaign row; the same code in two tenants (never crosses); link wins over typed; typed affiliate code earns with `attribution = 'code'`; a Rabattkod of the same string never resolves while the affiliate is active and DOES resolve when the affiliate is inactive or the add-on is OFF; the preview and the checkout answer identically; replay parity conflicts on a changed rate; the accrual lands in the order batch and a replayed delivery inserts nothing; the worked example in öre; a zero-rated tenant; self-referral (buyer = affiliate, buyer = shop admin); partial refund ×2 then full → reversals sum to the accrual; dashboard refund reverses; lost dispute reverses; cancel without refund reverses nothing; negative balance blocks a request; `payable` excludes held and disputed accruals; payout request race (two requests, one wins); void writes the compensating row; approval of an address held by a tenant admin / platform admin / print operator → `not_addable`; approval of an existing affiliate of another shop adds a membership and no second user; the invite token single-use; `/v1/me` for an affiliate lists only `affiliate` memberships; every affiliate projection walked against the buyer-field denylist; the admin routes 404 with the add-on OFF except ledger/payouts; feature allowlist pin; `identity_access` rebuild keeps every row and index; the ledger's no-UPDATE/no-DELETE triggers.

---

## 12. Units (builder units, Opus; Codex round per unit; attestation; staging deploy; smoke with full URLs)

| Unit | Content | Size |
|---|---|---|
| A1 | Migration 0058 (+0059); identity: `affiliate` type end to end (§1); the seam (§2.2) + frozen columns (§2.3); the ledger: accrual in the webhook batch, reversal hooks, balances; applications/approve/deny/invite; payouts manual rail; all `/v1/admin/affiliates/*` and `/v1/affiliate/*` routes; mails' jobs + kinds; feature key; tests | ≈2 |
| A2 | Shop-admin pages (§7.2) + order detail/dashboard additions; the admin build's swap table; design gate on every page rendered | ≈1 |
| A3 | Storefront: `/affiliate` form page, the `?ref=` hook, cart/checkout wiring (`refCode`, labels); the affiliate shell + pages (§7.3); design gate (NORD / Admin-Neutral) | ≈1 |
| A4 | Templates (§9) + `affiliateTerms.js` + privacy sentence; platform add-on toggle shows the key; a bounded sweep of `pending` object reservations older than 7 days (none exists today, CX-B7) that never touches an object a payout references; `seed-staging-slice.mjs --affiliate` (a test shop with the add-on ON, one affiliate invited, one application pending); the smoke script | ≈½ |
| A5 (later) | Connect rail (§6.3) after the sandbox proof | ≈1–1½, on go |

Order A1 → A4 (seed) → A2 ‖ A3. Parity check (kickoff §5.4) against spec §3 step by step on staging with the seeded shop, the fake printer and the Stripe sandbox.

---

## 13. For Mikael (short)

1. A9 — manual payout rail at launch, Connect as A5 later: confirm (deviation from D29's default, argued in §6.3).
2. A2 — one address = one kind of account; a shop admin uses another address to be an affiliate elsewhere: confirm.
3. A7 — a cancel with no refund keeps the commission (the ledger follows money): confirm.
4. The terms text (§8) and the privacy sentence want your legal read before A4 ships them; the design does not wait for it.
5. Kickoff §2.3's "15 % affiliate discount / 10 % commission" is the other way round (spec §2.2); the design uses 15 % commission / 10 % discount. Say if you meant to change them.
