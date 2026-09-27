# CP3-F report — Stripe Connect onboarding

Builder: CP3-F. Branch `cf-port`, working tree only: no git write, no network, no wrangler, **no call to the Stripe API** (every test runs against a fake gateway or a stubbed SDK client; the pool's outbound backstop would answer 599). Brief inputs: CP3 gap analysis §1g, §1h rows 2–3, §4, §5 risk 7; DECISIONS D37, D39, D49; HANDOVER "Staging run, first attempt" / "seed complete"; CP2-A report.

## Files

| File | What |
|---|---|
| `cloudflare/migrations/0038_connect_onboarding.sql` | new: 4 `tenants` columns + 2 triggers; `connect_onboarding_ops` + partial UNIQUE index + 5 triggers |
| `cloudflare/src/commerce/connect-gateway.ts` | new: the seam (`ConnectGateway`, `ConnectGatewayError`, `CONNECT_GATEWAY_OVERRIDE`, `resolveConnectGateway`, `selectConnectAccountsApi`), the **v1 adapter** (staging-proven calls), the **v2 adapter (UNVERIFIED)**, fact sanitizers |
| `cloudflare/src/commerce/connect-onboarding.ts` | new: reserve-first create/reuse, onboarding link, login link, ordered refresh, platform opt-in, payout delay, views, ops history |
| `cloudflare/src/routes/connect-admin.ts` | new: the five seller handlers |
| `cloudflare/src/routes/connect-platform.ts` | new: the four platform handlers |
| `cloudflare/src/app.ts` | only inside `CP3-IMPORTS-F` and `CP3-ROUTES-F` (9 exact-path mounts, all `onMethods([...])`) |
| `cloudflare/test/connect-fixtures.ts` | new: `FakeConnectStripe` (Stripe idempotency semantics) + shops built through the real routes, **without** a Connect account |
| `cloudflare/test/connect-gateway.test.ts` | new: 43 tests — adapter selection, error mapping, caps, v1 params vs the seed script, v2 shapes |
| `cloudflare/test/connect-onboarding.test.ts` | new: 47 tests — access matrix, reserve-first under every failure, links, refresh ordering, platform routes, the one-number walk |

The fake lives in `test/connect-fixtures.ts`, not in `connect-gateway.ts` as the brief's layout suggested: a fake must not ship in the Worker bundle (the existing `FakeMoneyStripe` lives in `test/money-fixtures.ts` for the same reason). No other file touched. No env var, binding or secret declared (see Reviewer wiring).

---

## Routes

All guard failures answer the opaque `404 {"error":{"code":"not_found","message":"Route not found"}}`. State changes (POST/PUT) also require a same-origin `Origin` (missing / `null` / foreign → 404), exactly like the existing tenant-admin and platform routes. Stripe-calling seller POSTs also 404 when the gateway is unavailable (no `STRIPE_SECRET_KEY`).

### Seller (tenant-admin session + `X-Shop-Id`; acting-as admitted except the login link)

| Method, path | Request | Responses |
|---|---|---|
| `GET /v1/admin/payments/connect` | — | `200 { connect: SellerConnectView }` — D1 only, never Stripe |
| `POST /v1/admin/payments/connect/account` | no body read | `201 { connect }` created now · `200 { connect }` shop already has one (Stripe not called) · `202 { connect, accountCreation: "pending" }` + `Retry-After: 5` (another request holds the operation, or Stripe's answer was lost) · `409 connect_account_conflict` (recorded nothing, alert raised) · `502 connect_account_refused` (Stripe refused; the next call starts a new operation) · `404` Connect not enabled / guards |
| `POST /v1/admin/payments/connect/onboarding-link` | no body read | `200 { onboarding: { url, expiresAt } }` · `409 connect_account_missing` · `502 connect_unavailable` · `404` Connect not enabled, no valid `CANONICAL_ORIGINS`, guards |
| `POST /v1/admin/payments/connect/refresh` | no body read | `200 { connect }` · `502 connect_unavailable` · `404` |
| `POST /v1/admin/payments/connect/login-link` | no body read | `200 { dashboard: { url } }` · `409 connect_onboarding_incomplete` (no account, or `charges_enabled` 0) · `502` · `404` — **including a platform user acting as the shop** |

`SellerConnectView = { enabled, hasAccount, status, chargesEnabled, payoutsEnabled, detailsSubmitted, requirementsDue: string[], syncedAt: ISO | null }`. `status` ∈ `none | onboarding | pending | restricted | active` (Firebase `deriveStatus` + `none`). **Not** in it: account id, disabled reason, payout delay, commission, operations, resync mark.

The four POSTs share one per-shop limiter (`scope "connect-tenant"`, key = tenant id, **12 per 60 s**, the existing `enforceRateLimit`), checked after authorization and before Stripe; over → `429 rate_limited` + `Retry-After`.

### Platform (platform session; POST/PUT same-origin; a request carrying `X-Shop-Id` is refused — D70, the shared guard since review round 1)

| Method, path | Request | Responses |
|---|---|---|
| `GET /v1/platform/tenants/:tenantId/connect` | — | `200 { connect: PlatformConnectView, operations: ConnectOperationView[] }` (≤ 50, newest first) |
| `POST …/:tenantId/connect/enable` | no body read | `200 { connect }`, audited `connect.enable` |
| `POST …/:tenantId/connect/disable` | no body read | `200 { connect }`, audited `connect.disable` |
| `PUT …/:tenantId/connect/payout-delay` | exactly `{ "delayDays": 0..365 \| "minimum" }` | `200 { connect }` (Stripe accepted, then stored + audited `connect.payout_delay`) · `400 invalid_request` · `409 connect_account_missing` · `422 connect_payout_delay_refused` · `502 connect_unavailable` · `404` unknown shop |

`PlatformConnectView = { tenantId, enabled, accountId, status, chargesEnabled, payoutsEnabled, detailsSubmitted, requirementsDue, disabledReason, syncedAt, resyncNeeded, payoutDelayDays (null = Stripe's default = the country minimum) }`. `ConnectOperationView = { opId, state, accountsApi, accountId, attempts, errorCode, createdBy, createdAt, updatedAt, settledAt, leaseExpiresAt }`.

Mounts: the platform paths sit under the tenant prefix whose older handler is POST-only with a terminal 404, so they are exact paths with `onMethods` in my anchor block; every other method falls through (tested: `PUT …/connect`, `GET …/enable`, `POST …/payout-delay`, and wrong methods on the seller paths all end in the ordinary 404). The tenant segment is taken from the raw pathname and decoded once (`decodeSegment` + `parseTenantIdPathSegment`), like `ACTING_AS_ROUTE`.

### Audit rows

| Action | When | Actor / metadata |
|---|---|---|
| `connect.account.reserve` | in the reservation batch | seller or acting platform user; `{ opId, accountsApi }` (+ `actingAsGrantId`) |
| `connect.account.created` | in the settling batch, for exactly that transition (`transition_id`) | `{ opId, accountId }` |
| `connect.account.refused` / `.abandoned` | in the closing batch | `{ opId, errorCode }` |
| `connect.onboarding_link`, `connect.login_link` | after Stripe answered | `{ accountId }` — **never the URL** |
| `connect.enable`, `connect.disable`, `connect.payout_delay` | in the write batch | platform user; payout: `{ accountId, delayDays }` |

The refresh is not audited: it writes Stripe's facts, not a human decision.

---

## Migration `0038_connect_onboarding.sql`

Additive only; nothing from 0001–0031 is dropped or recreated.

**`tenants`** — 0019 already stores the account, the three flags and `stripe_account_synced_at`; 0027 the resync mark. Reused, not duplicated. New:
- `connect_enabled INTEGER NOT NULL DEFAULT 0 CHECK IN (0,1)` — the platform's opt-in.
- `stripe_requirements_due_json TEXT` — NULL or a JSON array, ≤ 50 entries, ≤ 8192 bytes (the writer caps at 50 × 120 chars, control characters removed, deduplicated).
- `stripe_disabled_reason TEXT` — NULL or a code `[a-z0-9_.]{1,64}` (anything else is stored as `other`).
- `payout_delay_days INTEGER` — NULL or 0..365 (Firebase's accepted range; Stripe enforces the country floor and refuses below it → 422). NULL = Stripe's default, which is `minimum`.
- Triggers `tenants_connect_facts_need_account_{insert,update}`: requirements / disabled reason / payout delay need an account (0019's reasoning for the flags).

**`connect_onboarding_ops`** — `op_id` (PK, = the Stripe idempotency key), `tenant_id` FK, `state`, `stripe_account_id`, `accounts_api` (`v1|v2`), `business_name` (frozen), `attempts ≥ 1`, `lease_expires_at`, `error_code` (a code), `transition_id`, `created_by`, `created_at`, `updated_at`, `settled_at` (ISO TEXT with the round-trip CHECK). Row CHECKs: account iff `succeeded`; `settled_at` iff not `reserved`; no lease once settled; `failed`/`abandoned` carry an error code.
- **`connect_onboarding_ops_one_reserved_idx`**: `UNIQUE (tenant_id) WHERE state = 'reserved'` — one operation per tenant at a time.
- Triggers: **birth** (born `reserved`, attempts 1, holding nothing, and only for a tenant with `connect_enabled = 1` and **no account** — a second account cannot even be attempted), identity immutable (attempts only grow), state machine, finals frozen, no delete.

Columns added beyond the brief's list, and why: `attempts` + `lease_expires_at` (one request talks to Stripe at a time; a crashed one is taken over by CAS), `business_name` (a retry under an idempotency key must send **identical** parameters, and the shop may be renamed in between), `transition_id` (audit/alert rows fire for exactly one transition), `settled_at`.

---

## The onboarding operation — state machine

```
            (reserve: INSERT … WHERE connect_enabled = 1 AND stripe_account_id IS NULL,
             partial UNIQUE index, lease = now + 90 s, attempts = 1, audit)
                                   │
                                   ▼
                               reserved ──── lease held, Stripe being asked
            ┌─────────────┬────────┴──────────┬──────────────────────────────┐
            ▼             ▼                   ▼                              ▼
       succeeded       failed            abandoned                    stays reserved
```

| From → to | Trigger | Effect |
|---|---|---|
| (none) → `reserved` | a seller/acting-as POST finds no account and no reserved op | reservation + audit in one batch; the partial UNIQUE index makes a concurrent second INSERT fail (it re-reads and answers 202) |
| `reserved` → `reserved` (claim) | a request finds the op with its lease expired (or released) | CAS `attempts = attempts+1, lease = now+90 s WHERE attempts = <read> AND lease <= now` — one winner, the loser answers 202 |
| `reserved` → `succeeded` | Stripe returned an account (create, a replay under the same key, or the recovery listing's single match) | ONE batch: op `succeeded` + account; `UPDATE tenants SET stripe_account_id = A WHERE tenant_id = T AND stripe_account_id IS NULL AND NOT EXISTS (another tenant holding A)`; a critical `connect_account_conflict` alert whenever the shop then does not hold A — also when another request had already closed the operation (this batch transitions nothing, but the account must not be orphaned silently); the audit row for exactly this transition |
| `reserved` → `failed` | Stripe **refused** (4xx other than 408/409/429 and other than an idempotency error) | `error_code = stripe_refused[:<stripe code>]`; the key is dead (Stripe replays the refusal for 24 h); **the next request reserves a new `op_id`** |
| `reserved` → `abandoned` | the op is older than the retry window **and** a complete listing of the platform's accounts finds none whose metadata names this tenant | `error_code = idempotency_window_expired`; the same request then reserves a new op |
| `reserved` stays, lease released at once | outcome unknown: network, timeout, 5xx, 408/409/429, idempotency error, an unreadable 2xx, a failed/incomplete recovery listing | `error_code` = `outcome_unknown` / `recovery_listing_failed` / `recovery_listing_incomplete` / `duplicate_accounts`; answers 202 (409 for duplicates); the next request retries under the SAME key (or lists again) |
| `reserved` stays, lease held | the worker died between Stripe's success and the batch | the next request within 90 s answers 202 without calling Stripe; after it, the claim + a retry under the same key returns the same account |

Every account is created with `metadata = { tenant_id, onboarding_op_id }`, so the recovery listing can find it after Stripe has pruned the key.

## Retry and abandonment numbers

- **SDK timeout 30 s** (`CONNECT_STRIPE_TIMEOUT_MS`, the adapters' own client; `maxNetworkRetries: 0` — retries are the operation's, never the SDK's).
- **Lease 90 s** (`CONNECT_ATTEMPT_LEASE_MS`): outlasts the 30 s timeout plus the millisecond batch that follows, so a slow but live request is never overtaken; and bounds how long a crashed request blocks the shop (≤ 90 s, answered 202 + `Retry-After: 5` meanwhile). Released immediately after an unknown outcome, so a lost answer is retried on the next click.
- **Retry window 20 h** (`CONNECT_KEY_RETRY_WINDOW_MS`, from the op's `created_at` = its first call): Stripe keeps an idempotency key for at least 24 h and prunes it afterwards; a key younger than 24 h is guaranteed to replay the first answer, an older one may run as a new request and **create a second account**. 20 h leaves 4 h for clock skew between the Worker and Stripe and a request in flight at the boundary. The margin costs nothing: past the window the recovery listing decides, which is exact, only more expensive. A seller who retries the same day never reaches it.
- **After the window** the old key is never sent again: one account carrying `tenant_id = T` → adopted (`succeeded`); two or more → critical `connect_account_duplicate` alert, 409, stays reserved; none from a **complete** listing → `abandoned` + a new op; an incomplete (> 2000 accounts scanned) or failed listing proves nothing → 202, stays reserved.
- At most 3 rounds per request (abandon → re-reserve → attempt).

## Status refresh — the ordering rule

The refresh uses the rule of `stripe-events.ts` `account.updated` and the 0027 reconciliation resync (`crons.ts`), both read-only for me:
- `stripe_account_synced_at` is read **before** the Stripe call; the write is guarded `AND stripe_account_synced_at IS <read value>`. An event applied meanwhile moved it, so its newer facts are never overwritten (the refresh then changes nothing and answers what is stored).
- The watermark written is the call's **start**, floored to its second (`secondWatermark` imported from `crons.ts`): an event created in an earlier second is older than what Stripe returned and is dropped as stale; one in the same second is a tie the handler merges fail-closed and marks for resync. `MAX(COALESCE(synced_at, 0), watermark)` never moves it backwards.
- The resync mark is cleared (this retrieve is the authoritative read the mark waits for, as the cron's resync clears it).
- Requirements and the disabled reason are written in the same guarded UPDATE.

## What disabling Connect does to checkout

**Nothing.** The payment gate (`src/commerce/payment.ts` `loadConnectAccount`, read, not edited) requires `stripe_account_id` and `stripe_charges_enabled = 1` only; `connect_enabled` is not consulted — the same as Firebase, whose money path keyed on `chargesEnabled` and whose admin page says so (`AdminPayments.jsx`: "A live account keeps charging via Connect regardless of the connectEnabled invite flag"). Disabling closes the seller's **create** and **onboarding-link** routes (404); status, refresh and the dashboard login link keep working; the account, its facts and Stripe are untouched (tested). To stop a shop taking payments the platform suspends the tenant (existing route) — or, if a Connect-level stop is wanted, that is a payment-path change (open question 3).

## The login link and acting-as: refused

A platform user acting as the shop gets the opaque 404 on `login-link`. Reasoning: the link opens the **seller's own** Express dashboard (bank account, payouts, personal details); Stripe's guidance is that login links go only to the authenticated account holder; the platform has its own view of connected accounts in its Stripe dashboard. Firebase admitted a platform operator here only because `createConnectLoginLink` reused the generic `requireAdminOfShop` guard — its header documents the platform bypass for *onboarding*, not for the dashboard — so the Firebase code does not clearly show otherwise. Onboarding link, create, refresh and status stay admitted under acting-as (brief).

## v1 and v2 adapters

**v1 (default)**: the seed script's `ensureConnectAccount` calls, key for key — `accounts.create({ business_profile: { name }, capabilities: { card_payments: {requested: true}, transfers: {requested: true} }, country: "SE", metadata, type: "express" }, { idempotencyKey: op_id })` and `accountLinks.create({ account, refresh_url, return_url, type: "account_onboarding" })`. The test compares the parameter objects a stubbed SDK client receives with a literal copy of the seed's (the only difference is the metadata keys, by design). Retrieve, `createLoginLink`, `update({ settings: { payouts: { schedule: { delay_days } } } })` (Firebase's exact call) and `list({ limit: 100, starting_after })` (the seed's lookup) complete it. `business_profile` is omitted when the shop has no name.

**v2 — ⚠️ UNVERIFIED.** Written from the SDK 22.5.0 type definitions only (`esm/resources/V2/Core/Accounts.d.ts`, `AccountLinks.d.ts`); no call has ever reached Stripe. Create: `dashboard: "express"`, `identity.country: "se"`, `defaults: { currency: "sek", responsibilities: { fees_collector: "application_express", losses_collector: "application" } }`, **both** configurations — `recipient.capabilities.stripe_balance.stripe_transfers` (Stripe's documented configuration for destination charges without `on_behalf_of`, D37) and `merchant.capabilities.card_payments` (so the v1 `charges_enabled` the payment gate reads can become true) — `display_name`, metadata, `include` of the configurations and requirements. Link: `use_case.account_onboarding` with both configurations. Login link and payout delay use the v1 calls (v2 has neither). Facts mapping: charges ← `merchant…card_payments.status === "active"`, payouts ← `stripe_balance.payouts.status === "active"`, requirements ← entries awaiting the **user** that are `currently_due`/`past_due` (their `description` — v2 has no v1 field codes), detailsSubmitted ← nothing awaits the user (no v2 field), disabledReason ← card_payments `restricted` ⇒ its first status code.

**Staging proof required before `CONNECT_ACCOUNTS_API=v2` may be set anywhere**, each with a sandbox account created through the v2 adapter:
1. The existing payment code (unchanged) makes a destination charge to it: `transfer_data.destination` = the account, no `on_behalf_of`, application fee collected — and the reconciliation balances.
2. The existing `account.updated` handling still receives a **v1** `account.updated` for it on the Connect endpoint (D39) and applies `charges_enabled` / `payouts_enabled`.
3. The `v2Facts` mapping agrees with `GET /v1/accounts/{id}` for the same account before, during and after onboarding (charges, payouts, details submitted, requirements, disabled reason).
4. The v1 interop calls work on a v2 account: `POST /v1/accounts/{id}/login_links` and `POST /v1/accounts/{id}` with `settings.payouts.schedule.delay_days`.
5. `identity.country: "se"` (lowercase), `dashboard: "express"` and the responsibility pair are accepted together; `GET /v2/core/accounts` returns `metadata` (the recovery listing depends on it).
6. Existing **v1** accounts still work after the var flips: refresh (`GET /v2/core/accounts/{id}`) and onboarding links (`/v2/core/account_links`) on a v1-created account. (A reserved operation always retries through its own API — `accounts_api` on the row — but refresh and links use the configured one.)
7. Whether the LIVE platform account still allows Accounts v1 at all (D49).

## Deviations from the brief or from Firebase

1. ~~**No monthly payout schedule at creation.**~~ **Reversed in review round 1: the schedule is now sent** (see "Review round 1"). Round-0 text: Firebase created accounts with `settings.payouts.schedule { interval: "monthly", monthly_anchor: 1 }`; the brief requires the v1 parameters to equal the staging-proven seed call, which did not send it, and the refusal-replay incident is why unproven parameters on this one call are costly. New shops therefore get Stripe's default schedule. To port it: add that object to the v1 create params (`connect-gateway.ts`, one line; the param names exist in the SDK types) after proving it on staging, and update the equality test. → open question 1.
2. **Connect not enabled blocks the platform too.** Firebase let a platform operator create an account without the opt-in; here `connect_enabled = 0` is a 404 for everyone (brief), and the platform enables it with one call.
3. **The onboarding link is gated by the opt-in too** (Firebase's `createConnectAccountLink` was not). An onboarding link is onboarding; with the invitation withdrawn it closes with create. Status, refresh and the dashboard stay open.
4. **Create and link are two calls** (Firebase's create returned the link too). The UI calls `account` then `onboarding-link`.
5. **Login link refused for acting-as** (above).
6. **The rate limit covers all four Stripe-calling seller POSTs** (the brief asked for refresh): one shared per-shop budget, 12/min.
7. **The seller does not see** the account id, the disabled reason or the payout delay (Firebase's page showed status + requirements; the delay editor was platform-only).
8. **Not ported**: `getConnectBalance` (balance/payout-risk panel), `onboardingCompletedAt` / `onboardingStartedAt` timestamps, `setShopCommission` (CP3-A owns `commission_bps`).
9. **Return URLs** use `/admin/payments?return=1|refresh=1&shopId=` on the canonical **web** origin (Firebase: `ADMIN_BASE`). The allowlist has only `api` and `web`; if an `admin` surface is added, it is used automatically (the same fallback CP3-B's `resetPageOrigin` uses). The page itself is CP3b.
10. Two alert kinds are written with their own statement in the money-alerts shape (one open per kind + resource, ids only): `connect_account_conflict`, `connect_account_duplicate`. They are not in `MoneyAlertKind` (`money-alerts.ts` is not mine); the digest groups by kind generically, so they reach it.

## Reviewer wiring

1. **`REQUIRED_MIGRATION`** → `0038_connect_onboarding.sql` (at consolidation, with the readiness tests), and apply 0038 to staging.
2. **`CONNECT_ACCOUNTS_API`** — optional var, read defensively (`raw === "v2"` → v2, anything else → v1). **Leave it unset** until the v2 staging proof above passes. If declared, add it to `src/env.d.ts` as `CONNECT_ACCOUNTS_API?: string` and to `wrangler.jsonc` vars per env.
3. **Done in review round 1** (see "Review round 1", follow-up 1). Round-0 text: **`account.updated` should also write the two new facts** (`stripe-events.ts`, money path — not edited). In `handleAccountUpdated`'s strictly-newer UPDATE add `stripe_requirements_due_json = ?` (`JSON.stringify(requirementsFrom(object.requirements?.currently_due))`) and `stripe_disabled_reason = ?` (`disabledReasonFrom(object.requirements?.disabled_reason)`), both exported from `connect-gateway.ts`. Until then a webhook moves the flags while the requirement list / disabled reason keep the last refresh's values (the status stays correct when charges are enabled; a restriction arriving only by webhook shows `pending`/`onboarding` instead of `restricted` until the next refresh). The 0027 resync in `crons.ts` would need the same two columns (its `AccountView` has flags only).
4. **Built in review round 1** (`raiseStuckOnboardingAlerts`, 24 h; the reviewer wires it into `scheduled()`). Round-0 text: **Stuck reservations**: no cron looks at `connect_onboarding_ops`. An operation left `reserved` (lost answer, then the seller walks away) is recovered only by the next seller request. Optional: a reconciliation step alerting on `state = 'reserved' AND created_at <= now − 30 min`.
5. **Stripe dashboard**: Accounts v1 must stay enabled on the platform account the v1 adapter talks to (D49 — enabled in the sandbox and Testläge on 2026-09-27). No new webhook event is needed: `account.updated` already reaches the Connect endpoint.
6. **Staging proof of the v1 routes** (the reviewer's): as the platform, `POST …/connect/enable` for the slice tenant's sibling; as its admin `POST /connect/account` (201 + an `acct_` in the ops row with `tenant_id`/`onboarding_op_id` metadata in Stripe), `POST /connect/onboarding-link` (a `connect.stripe.com` URL whose return URL is the web origin), complete onboarding, `POST /connect/refresh` (status `active`), `POST /connect/login-link`, `PUT …/payout-delay {7}` then `{"minimum"}`. This replaces the seed script's two raw D1 statements and its direct Stripe calls (gap §1h rows 2–3).

## Open questions

1. ~~Port Firebase's monthly payout schedule?~~ Answered: yes — done in review round 1.
2. `delayDays` range: Firebase's 0..365 is kept; Stripe's own maximum for SE is not known here (Stripe refuses out-of-range values → 422). Confirm on staging if a tighter CHECK is wanted.
3. Should the platform be able to stop a live shop's Connect charges without suspending the tenant? Today only suspension does (disabling Connect does not). A Connect-level stop would be a `payment.ts` change.
4. `tenants.stripe_account_id` has no write-once trigger (the create path only ever sets it `WHERE … IS NULL`). A trigger would make "no second account, ever" a schema fact for every writer (importer, hand fixes) — but it also blocks re-binding after an incident like Firebase's 2026-07-06 one. Not added; the reviewer's call.
5. Operations of a tenant that is later disabled stay `reserved` until it is re-enabled (create answers 404 meanwhile). Acceptable?

## Tests

| Suite | Tests | Covers |
|---|---|---|
| `test/connect-gateway.test.ts` | 43 | selection (absent, `v1`, `v2`, 7 unknown values, explicit API wins, no key → null, money fake without Connect fake → null, partial override → null); error mapping (14 cases incl. idempotency error and 409 = unknown); caps; v1 params = the seed's (create, link, list), link https check, unreadable 2xx = unknown; v2 create/retrieve/link/interop/listing shapes and fact mapping |
| `test/connect-onboarding.test.ts` | 47 | access matrix: 9 routes × {no session, other shop's admin, own admin, acting-as, platform without grant}, each 404 asserted opaque and Stripe-free; cross-origin and origin-less state changes (7 routes) → 404, no write, no audit; wrong methods fall through; create: not enabled → 404; create once + second = 200 with zero calls; acting-as audited with the grant; two concurrent creates (held and raw race) → one account, one call; crash after Stripe success (worker dies on the settle batch) → 202 during the lease, then the SAME account; lost answer → same key, same account; refusal → `failed`, new `op_id` each time, stored refusals never replayed; guarded update (tenant got another account meanwhile; account held by another shop; an account returned for an operation another request already closed) → no overwrite, no UNIQUE abort, alert; live lease → 202 no call; window expiry → abandoned + new op, adopt by metadata, incomplete/failed listing, duplicates; a retry uses the op's own API; schema refusals; link URLs from the allowlist only (request host/Origin never used), no allowlist → 404, link never stored (every table scanned) nor logged; refresh facts + deriveStatus, a newer event during the call is never downgraded, watermark = call start floored, older event stale / newer applies after a refresh, 12/min limit per shop; login link 409 before onboarding, acting-as 404; enable/disable audited and checkout gate untouched; payout delay stored/`minimum` = NULL, 400/409/422/502/404; platform read with history; **the one-number walk** over every tenant-session body in the file (allowlisted keys only, denylist `commission|fee|withh|bps|delay|operation|opId|attempt|lease|createdBy|acting|grant|resync|disabledReason|accountId|metadata|platform|internal|errorCode|tenant`) |

**Self-review finding, fixed:** the conflict alert first fired only for the settling batch's own transition, so an account Stripe returned for an operation another request had already closed (only possible around the 20 h boundary) would have been orphaned with no alert. The alert now depends only on "the shop does not hold the account Stripe returned" (still one open alert per operation); test added.

**Mutation checks: 21 of 21 killed** (each applied to my own source, the two suites run, the file restored and verified byte-identical by hash): the conflict alert tied to this batch's transition only (the finding above — the added test fails on the old code); tenant guard `IS NULL` removed; a fresh key per attempt; a refusal kept `reserved`; the lease ignored (JS **and** SQL); refresh ordering guard removed; watermark late (+60 s); watermark taken after the call; old key retried forever; incomplete listing trusted; other-shop guard removed; duplicates adopted; refresh leaves the resync mark; refresh URL off the allowlist; login link for acting-as; seller POST without same-origin; no rate limit; create ignoring the opt-in; 409 as a refusal; idempotency error as a refusal; login link before onboarding. Two first attempts did not count: the lease check mutated in JS only **survived**, honestly — the SQL claim repeats it (a deliberate double guard), so the pair was mutated together; and a first "refresh guard removed" mutation broke the statement's bind count (invalid, redone as `OR 1 = 1`). One restore failed because another process replaced my scratch backup directory mid-run; I restored the single mutated line by hand and verified the file's SHA-1 equals the pre-mutation one (`56ebcfa9…`). **Note for the other builders:** during this window (≈ 17:23–17:31) my source files were briefly mutated; a concurrent full run could have seen my suites fail or tsc errors in `connect-onboarding.ts` (CP3-A's report mentions exactly two such observations: a 502 answered 202 = my mutation "refusal kept reserved", and tsc at `connect-onboarding.ts:802,804` = "login link before onboarding"). Everything is restored; tsc is clean.

One test was fixed for flakiness found this way: the watermark assertion compared against the test's own clock second; it now bounds the value.

### Output

Targeted (mine + the five money suites named in the brief):

```
npx vitest run test/payment-connect.test.ts test/payment.test.ts test/stripe-events.test.ts \
  test/money-crons.test.ts test/webhook-money.test.ts test/connect-onboarding.test.ts test/connect-gateway.test.ts
 Test Files  7 passed (7)
      Tests  238 passed (238)
```

Mine alone: `test/connect-gateway.test.ts` 43 + `test/connect-onboarding.test.ts` 47 = **90 passed**.

`npx tsc --noEmit` → exit 0 (whole project, including the other builders' current files).

Guard: the guard scans tracked files only, so my untracked files were scanned with its three pattern families directly → clean (8 files).

Full suite, last run (17:43, working tree with all six builders' files):

```
 Test Files  2 failed | 67 passed (69)
      Tests  37 failed | 2348 passed (2385)
   Duration  124.92s
 ❯ test/slice/vertical-slice.test.ts (1 test | 1 failed)
 ❯ test/slice/failure-injection.test.ts (39 tests | 36 failed)
```

All 37 failures are in the slice suites and have exactly two causes, both from CP3-E's in-progress legal gate, not from this work:
- 36 × `checkout: {"error":{"code":"not_found","message":"Checkout not found"}}: expected 404 to be 201` — `createCheckout` now also requires `isLegallyReady` (`src/commerce/checkout.ts` diff, `src/legal/legal-pages.ts`), which the slice harness's shops do not satisfy (CP3-A's fixtures have a `makeLegallyReady` helper for it).
- 1 × `vertical-slice.test.ts:190` — `termsStatus` now returns CP3-E's new fields (`acceptedVersion`, `graceDeadline`, `inGrace`, `readiness`).

Nothing in `test/slice/` or the harness references a column, table or route of mine (`grep` of `connect_enabled`, `payout_delay_days`, `stripe_requirements_due_json`, `stripe_disabled_reason`, `connect_onboarding_ops` finds only my files), and the harness's own Connect SQL (`UPDATE tenants SET stripe_account_id …, stripe_charges_enabled = 1 …`) passes my new triggers (they fire only on requirements / disabled reason / payout delay without an account). An earlier full run under heavy concurrent load (260 s) also showed 5 s / 10 s timeouts in unrelated suites and one CP3-B `invites.test.ts` assertion; they did not recur in the quiet run above.

## Not done / not tested

- Nothing ran against Stripe (by rule). The v1 adapter's parameters are proven equal to the seed's calls, not proven live; the v2 adapter is unverified end to end.
- The slice suites (`test/slice/*`) are red in the full run for a reason outside my files (see Output); I could not show them green with my change in place, only that nothing in them references my columns or routes and that the five named money suites are green.
- No UI (CP3b). No balance read. No cron for stuck reservations.

---

## Review round 1 (2026-09-27)

Rulings: deviations 2–9 accepted; deviation 1 (no payout schedule) reversed → follow-up 2. Answers: `delayDays` stays 0..365 with Stripe's refusal mapped to 422 (already so: `connect_payout_delay_refused`, never a 500); no Connect-level stop this checkpoint; no write-once trigger; disabled shops' reservations stay reserved and are now made visible (follow-up 3). No mutation checks this round (shared tree).

### Follow-up 1 — `account.updated` and the 0027 resync write the requirement list and the disabled reason

**`src/commerce/stripe-events.ts`** — only `handleAccountUpdated` (+ its doc comment) and one import line (`requirementsFrom`, `disabledReasonFrom` from `connect-gateway.ts`). The two columns are written in the SAME two statements, under the SAME conditions as the flags; the ordering rule is unchanged:
- **Strictly newer** event (`synced_at IS NULL OR synced_at < eventAt`): the event's list (`requirements.currently_due`, capped by `requirementsFrom`) and reason (`requirements.disabled_reason` via `disabledReasonFrom`) replace the stored ones.
- **Same-second tie** (`synced_at = eventAt`): merged fail-closed like the flags — a disabled reason reported by either event survives (`COALESCE(stored, event)`), the longer requirement list is kept (a union was not used: two lists at the 50-entry / 8 KiB cap can exceed the 0038 CHECK, which would abort the webhook batch and make Stripe retry forever) — and any disagreement in list or reason now also sets `stripe_account_resync_needed = 1`, so the authoritative resync repairs it within one reconciliation.
- **Older** event: neither statement matches — nothing changes (tested).
- An event whose account object has **no `requirements` object** leaves both facts as they are (it says nothing about them); the flags behave as before.

**`src/commerce/crons.ts`** — `resyncConnectAccounts` + one import block + **one argument at its call site in `runReconciliation`** (`…, alert, resolveConnectGateway(env))`). That argument is the only line outside the function: the resync receives no `env`, and the brief's preferred route ("read the account through your own gateway's status call inside the resync") needs the Connect gateway handed in. `stripe-client.ts` is untouched: its `AccountView` has the flags only, so:
- with a Connect gateway (every deployed Worker with a Stripe key: no overrides) the resync reads through `ConnectGateway.retrieveAccount` and writes flags **and** list **and** reason in the SAME guarded statement as before (`resync_needed = 1 AND synced_at IS <read>`, second-aligned watermark);
- without one (a test env holding only the money fake — every existing money suite) it reads the flags through the money gateway exactly as before and leaves the two facts as they are (`CASE WHEN known = 1 …`).

Tests (`connect-onboarding.test.ts`, real signed webhooks through `postEvent`): an event that adds a requirement (and the seller sees it); an event that clears the list; a disabled reason arriving (status `restricted`) and leaving; an older event after a newer one overwrites neither; an event without `requirements` leaves both; a same-second tie merges fail-closed + marks, then `runReconciliation` writes Stripe's authoritative list/reason through the Connect fake and never asks the money fake; an identical same-second duplicate needs no resync; the money-fake-only fallback writes the flags and leaves the facts. The existing `stripe-events`, `money-crons`, `money-review-fixes` (the 0027 resync tests), `money-codex-fixes`, `money-followups`, `payment-connect`, `webhook-money`, `webhook`, `refunds`, `payment` suites pass unchanged.

### Follow-up 2 — the monthly payout schedule

`MONTHLY_PAYOUT_SCHEDULE = { interval: "monthly", monthly_anchor: 1 }` (`connect-gateway.ts`), Firebase's `settings.payouts.schedule` verbatim. The comment beside it records that it is part of the idempotent request and that no operation reserved before the change exists anywhere (an old one retried after it would get Stripe's idempotency error, which this worker already treats as an unknown outcome, never a refusal).

**The exact v1 create call now sent:**

```ts
stripe.accounts.create(
  {
    business_profile: { name: "<shop name>" },          // omitted when the shop has no name
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    country: "SE",
    metadata: { onboarding_op_id: "<op_id>", tenant_id: "<tenant_id>" },
    settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 1 } } },
    type: "express",
  },
  { idempotencyKey: "<op_id>" },
)
```

The v1 test now asserts: the parameters equal the seed script's staging-proven set **plus `settings`** (Firebase's schedule) — nothing else added, nothing dropped. (Firebase's `default_currency: "sek"` and `email` are still not sent: SE defaults to SEK, and the brief asked for the schedule only.)

**v2 (still UNVERIFIED):** v2 accounts have no payout-schedule parameter (none in the SDK's `V2/Core/Accounts.d.ts`), so the equivalent is the v1 interop `accounts.update(id, { settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 1 } } } })` immediately after the create, inside `createAccount`. Once the account exists, a failure of that update is reported as an **unknown outcome, never a refusal** (tested with a 400): the operation stays reserved and its retry replays the create under the same key and re-applies the schedule; a refusal would have let a second account be created. Known gap: an account ADOPTED by the recovery listing (past the 20 h window) does not get the schedule re-applied — acceptable only because v2 is not in use.

### Follow-up 3 — one warning per operation reserved over 24 hours

`raiseStuckOnboardingAlerts(db, nowMs, limit = 50): Promise<number>` in `src/commerce/connect-onboarding.ts` (exported with `CONNECT_STUCK_RESERVATION_MS = 24 h`, `CONNECT_STUCK_ALERT_BATCH = 50`, `CONNECT_STUCK_ALERT_KIND = "connect_onboarding_stuck_24h"`). One `INSERT … SELECT … WHERE state = 'reserved' AND created_at < now − 24 h AND NOT EXISTS (open alert of this kind for this operation) ORDER BY created_at, op_id LIMIT ?` — atomic, so every 15 minutes (or two runs at once) writes no duplicate; severity `warning`, `resource_type = 'connect_onboarding_op'`, `resource_id = op_id`; the message carries the tenant id, op id, attempt count and last error code only. Returns how many it raised. **Reviewer:** call it from `scheduled()` (e.g. after `runReconciliation`, before the digest, so its alerts are in the same tick's digest) with `ScheduledController.scheduledTime`; `src/outbox/scheduled.ts` is untouched.

Tests (injected clock): nothing at 23 h 59 min; one alert after 24 h; none on the next run; after the alert is resolved (`resolveAlert`) and the operation is still reserved, a new one; settled operations never alert; `limit` bounds a run (2, then 1, then 0), oldest first.

### A contract change that landed meanwhile — D70

While this round ran, the shared platform guard (`authorizePlatformRequest`) started refusing any request that carries `X-Shop-Id` (DECISIONS D70). My routes call that guard, so they follow it with no code change. My test helper sent the platform session's calls to platform paths WITH `X-Shop-Id`; it no longer does, and the access matrix's "acting-as" column on the four platform routes now expects the opaque 404 (a platform user working inside a shop is in the shop's context, not a platform request). That is the only assertion whose expected value changed, and it changed because the contract did.

### Extended staging proof list (v1, the reviewer's run)

1. As the platform, `POST /v1/platform/tenants/<t>/connect/enable`; as the shop's admin `POST /v1/admin/payments/connect/account` → 201; the ops row is `succeeded` with an `acct_…`; in Stripe the account carries `metadata.tenant_id` / `onboarding_op_id`.
2. **The created account shows the monthly schedule:** `GET /v1/accounts/<acct>` → `settings.payouts.schedule.interval = "monthly"`, `monthly_anchor = 1`. (The one parameter not yet proven on staging; if Stripe refuses it, the operation ends `failed` with `stripe_refused:<code>` and the next request starts a new operation — no account is created twice.)
3. `POST …/connect/onboarding-link` → a `connect.stripe.com` URL; its return URL is the canonical web origin `/admin/payments?return=1&shopId=<t>`.
4. During onboarding, the Connect endpoint's `account.updated` events fill `stripe_requirements_due_json` / `stripe_disabled_reason` without any refresh (follow-up 1); `GET /v1/admin/payments/connect` shows them.
5. Complete onboarding; `POST …/connect/refresh` → `active`; `POST …/connect/login-link` → a dashboard URL.
6. `PUT …/connect/payout-delay {7}` then `{"minimum"}` → stored 7, then NULL; a value Stripe refuses → 422.
7. After the reviewer wires `raiseStuckOnboardingAlerts` into `scheduled()`: it raises nothing on a healthy staging DB.
8. v2: the proof list in "v1 and v2 adapters" plus item 6 there (the v1 schedule update on a v2 account leaves it monthly on the 1st).

### Files changed this round

- `src/commerce/stripe-events.ts` — `handleAccountUpdated` + one import (money path, by the review's permission).
- `src/commerce/crons.ts` — `resyncConnectAccounts` + one import block + one argument at its call site (disclosed above).
- `src/commerce/connect-gateway.ts` — `MONTHLY_PAYOUT_SCHEDULE`; v1 create sends it; v2 applies it after create; v2 proof item 6.
- `src/commerce/connect-onboarding.ts` — `raiseStuckOnboardingAlerts` + constants; the refresh re-sanitizes the facts it writes (`requirementsFrom` / `disabledReasonFrom`), as the resync does.
- `test/connect-gateway.test.ts` (44), `test/connect-onboarding.test.ts` (57), `test/connect-fixtures.ts` (D70: no `X-Shop-Id` on platform paths).

### Totals (this round)

- My suites: `test/connect-gateway.test.ts` **44** + `test/connect-onboarding.test.ts` **57** = **101 passed**.
- Money suites, unchanged and green in the full run: `stripe-events`, `money-crons`, `money-review-fixes` (the 0027 resync tests), `money-codex-fixes`, `money-followups`, `payment-connect`, `payment`, `webhook-money`, `webhook`, `refunds`. The two slice suites (`test/slice/vertical-slice`, `test/slice/failure-injection`) are **green** in this run as well (the shared harness has been updated meanwhile).
- `npx tsc --noEmit` → exit 0.
- **Full suite, run once at the end (19:46, 75 s):**

```
 Test Files  3 failed | 66 passed (69)
      Tests  5 failed | 2376 passed | 24 skipped (2405)
```

Every failure is in CP3-E's legal suites, none in a file of mine, none touching a Connect table, column or route:
- `test/legal.test.ts` (13 skipped) and `test/legal-grace.test.ts` (11 skipped) — their `beforeAll` aborts: `Error: D1_ERROR: UNIQUE constraint failed: tenant_settings.tenant_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)` at `test/legal.test.ts:88` and `test/legal-grace.test.ts:120` (their seed batch inserts a `tenant_settings` row that now already exists).
- `test/legal-pages.test.ts`, 5 failed: "none before; the admin adopts; …" and "only the shop's own admin adopts: acting-as, …" — both `expected { acceptance: { …(10) } } to deeply equal { acceptance: null }`; "the legal readiness gate at checkout …" — `expected { legalPagesAccepted: true, …(3) } to deeply equal { legalPagesAccepted: false, …(3) }`; "the evidence is append-only …" — `expected 'worker' to be 'import'`; "at most 20 well-formed adoptions per shop per hour …" — `adoption 20: {"error":{"code":"rate_limited","message":"Too many requests"}}: expected 429 to be 201`.

Not fixed (not mine), listed as asked.

### Not done this round

- No mutation checks (as instructed). The new webhook/resync/stuck-alert tests were written to fail on the pre-change code (each asserts a value only the new statements write), but that was not demonstrated by mutation.
- Nothing against Stripe: the monthly schedule on a real account is staging proof item 2.
- `raiseStuckOnboardingAlerts` is not wired into `scheduled()` (the reviewer's, as instructed).
