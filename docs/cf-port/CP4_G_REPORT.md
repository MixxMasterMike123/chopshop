# CP4-G report — the withdrawal function

Builder: CP4-G. Branch `cf-port`, working tree only: no git write, no network, no wrangler, no deploy. Brief: `CP4_BRIEFS.md` §0 and §G, DECISIONS D11, D46, D68, D96. Source: `functions/src/withdrawal/functions.ts` (the guest path), `src/pages/shop/WithdrawalPage.jsx`, `src/components/shop/OrderWithdrawal.jsx`, `src/utils/withdrawal.js`. Builders A, C and D worked in the same tree at the same time; none of their files are touched here.

**Status: built and tested locally.** A buyer without an account can withdraw on the shop's own site. The server stamps the time the message arrived, records it once and for good, answers with the receipt, and puts the receipt mail and the shop's notice in the outbox in the same batch. No money moves. **The mails are not sent until the reviewer wires two modules into the outbox and the email consumer** ("Reviewer wiring" 1–4). Until then the outbox rows wait untouched. The wiring was applied and run in a scratch copy of `cloudflare/` (§9).

---

## 1. Files

| File | |
|---|---|
| `cloudflare/migrations/0044_withdrawals.sql` | new: the `withdrawals` table; the email ledger rebuilt to admit two kinds |
| `cloudflare/src/commerce/withdrawals.ts` | new: the input rule, the lookup, what the function answers, the one write, the receipt, the admin view, the `withdrawal_email` outbox effect |
| `cloudflare/src/routes/storefront-withdrawals.ts` | new: `POST /v1/withdrawals`, the tenant by hostname, the rate limit |
| `cloudflare/src/email/withdrawal-email.ts` | new: the job of the two mails (build, parse, fingerprint, ledger row) and the two Swedish templates |
| `cloudflare/test/withdrawals.test.ts` | new: 72 tests |
| `cloudflare/src/app.ts` | only the two blocks `CP4-IMPORTS-G` and `CP4-ROUTES-G`, each added after the D block's end line |

Not touched: every existing file under `src/commerce/`, `src/outbox/`, `src/email/`, `src/routes/`; `wrangler.jsonc`, both `env.d.ts`, `vitest.config.ts`, `pinned.*.json`, `REQUIRED_MIGRATION`, `scripts/`, `web/`, `src/api/`. No new binding, variable or secret.

The mail templates live in a file of their own (`withdrawal-email.ts`), not in `auth-email-job.ts`, because that file may not be edited here. The consumer reaches them through the wiring.

---

## 2. Schema (0044)

### `withdrawals`: one row per order, append-only

| Column | |
|---|---|
| `withdrawal_id` | TEXT PK, a UUID (36 characters `[0-9a-f-]`) |
| `tenant_id` | FK `tenants` |
| `order_id` | FK `orders`, **UNIQUE**: one message per order |
| `eligible` | 0/1 |
| `reason` | NULL, `'personalized_exempt'` or `'window_passed'`; `CHECK ((eligible = 1) = (reason IS NULL))` |
| `withdrawn_items_json` | JSON array of `order_items.item_index`: the lines the withdrawal covers; `CHECK (eligible = 1 OR withdrawn_items_json = '[]')` |
| `exempt_items_json` | JSON array: the personalised lines whose right was waived at checkout |
| `consumer_name` | 1–200: the name the buyer stated |
| `contact_email` | 3–254, `LIKE '%_@_%'`: the purchase address the buyer stated, trimmed and in lower case |
| `shop_name` | the shop's name when the message arrived (the receipt names it; `tenants.shop_name` can change) |
| `shop_notice_email` | the shop's support address when the message arrived; NULL = none, and an alert was raised instead |
| `received_at` | **the time of receipt**, ISO-8601 with the strftime round-trip CHECK |

The item lists are frozen in the row, so a second message gets the first one's receipt whatever later code decides. The lines' names, SKUs and quantities come from `order_items`, which 0011 freezes at payment.

Triggers:

- `withdrawals_tenant_matches_order` (BEFORE INSERT): the row's shop must be the order's shop.
- `withdrawals_insert_once` (BEFORE INSERT): aborts when a row with the same id **or the same order** exists. This covers `INSERT`, `INSERT OR IGNORE`, `INSERT OR REPLACE` and `REPLACE`: the guard fires before any conflict resolution could delete the first row.
- `withdrawals_no_update`, `withdrawals_no_delete`: every UPDATE and DELETE aborts.

Index `(tenant_id, received_at DESC, withdrawal_id DESC)` for a future list. The admin read goes by `order_id`, which the UNIQUE constraint indexes.

### `email_deliveries`: two new kinds

The 0022/0029 recipe (SQLite cannot alter a CHECK): snapshot, drop, create the same shape with `'withdrawal_receipt', 'withdrawal_notice'` added to the kind list, copy every row, then re-declare the two triggers and three indexes exactly as 0029 declared them. None of 0040–0043 touches this table (checked).

---

## 3. The route

`POST /v1/withdrawals`: a storefront route mounted in `onMethods(["POST"], storefront(…))`. It has no session and no same-origin check (as for checkout and the report intake). The tenant comes from the hostname only.

**Request**, exactly these keys (anything else, including `shopId` or a time, is a 400):

```json
{ "orderNumber": "20260928-ABCD1234", "statement": { "name": "…", "contactEmail": "…" } }
```

- `orderNumber`: trimmed, one leading `#` removed, 1–64 characters, no control character. It is looked up as typed or in upper case (the source's rule).
- `name`: trimmed, 1–200, no control character.
- `contactEmail`: trimmed and put in lower case. It must be an address of at most 254 characters, and it must be the address the purchase was made with.
- The body is read under a 4 096-byte cap (`readJsonBodyWithin`).

**Answers**

| Status | Body | When |
|---|---|---|
| 201 | `{ "withdrawal": { "acknowledgement", "alreadyReceived": false, "eligible", "reason" } }` | the message is recorded now, whether eligible or not |
| 200 | the same shape with `"alreadyReceived": true` | a message for this order is already on record: **its** receipt; nothing is written |
| 400 | `{"error":{"code":"invalid_request","message":"Request is not valid"}}` | any malformed body, including over the cap (one answer) |
| 404 | `{"error":{"code":"not_found","message":"Route not found"}}` | no such order in this shop, an address that is not the purchase address, an order of another shop, a hostname that is no verified domain, or another method: **one answer, same bytes and headers** |
| 429 | `{"error":{"code":"rate_limited","message":"Too many requests"}}` + `Retry-After` | the 11th request from one visitor address within 10 minutes |

A D1 fault throws (the app rethrows), and the runtime answers 500, as on every route.

`withdrawal` in full:

```json
{
  "acknowledgement": {
    "consumerName": "Test Köpare",
    "contactEmail": "buyer@example.test",
    "exemptItems": [ { "name": "…", "quantity": 1, "sku": "…" } ],
    "orderNumber": "20260928-ABCD1234",
    "shopName": "Butik A",
    "statement": "Jag, Test Köpare, ångrar härmed mitt köp av order 20260928-ABCD1234. Detta meddelande togs emot 2026-09-28T10:15:30.123Z.",
    "submittedAt": "2026-09-28T10:15:30.123Z",
    "withdrawnItems": [ { "name": "…", "quantity": 2, "sku": "…" } ]
  },
  "alreadyReceived": false,
  "eligible": true,
  "reason": null
}
```

`reason` is `null`, `"personalized_exempt"` or `"window_passed"`. The keys the source's page reads (`eligible`, `reason`, `acknowledgement.{submittedAt, orderNumber, withdrawnItems[].{name, sku, quantity}, statement}`) are kept with the same names. `shopName`, `exemptItems` and `alreadyReceived` are added; the page ignores them.

### The lookup: one answer for "no such order" and "wrong address"

One query: `SELECT order_id, customer_email FROM orders WHERE tenant_id = ? AND order_number IN (?, ?)`. It returns one row or none. The stated address and the order's address (trimmed, lower case) are then compared with `secretMatches` (`src/lib/bearer.ts`): SHA-256 of both sides, compared with `timingSafeEqual`. When there is no order, the comparison is made against the empty string, so both misses run the same statements and the same digests. Nothing is written on either.

### The rate limit

The source's 10 per 10 minutes per visitor address, durable in D1 through `src/lib/rate-limit.ts` (the source's counter was in memory, per instance). Scope `withdrawal-ip`.

- It runs **before the body is read**. Every attempt counts, the refused ones included.
- The key is `CF-Connecting-IP`, which the edge sets and the caller cannot. `X-Forwarded-For` is never read. A request without the header joins the one shared `unknown` bucket, which is stricter, not looser.
- **An IPv6 address counts by its /64** (`withdrawalRateKey`, in canonical form, so every spelling of one network is one key). A subscriber holds a whole /64, so without this, rotating addresses inside one's own network would buy unlimited attempts. An IPv4-mapped address counts as its IPv4 address.
- One handler serves both entrypoints. There is no second path: other methods, spellings and prefixes are 404.
- **No limit per order number, on purpose** (deviation 6).

### The tenant (rule 10)

`resolveWithdrawalTenant`: the tenant of a **verified** domain, whatever the tenant's status. It uses the same hostname rule as `resolveRequestTenant`, without its `tenant.status = 'active'` condition. The order is always looked up under that one tenant.

---

## 4. The receipt and the two mails

**The receipt** (`acknowledgement`) is built from the immutable row and the order's frozen lines only. It holds:

- the time of receipt;
- the order number and the shop's name;
- the buyer's name and address;
- the goods the withdrawal covers, and any personalised goods listed apart;
- the buyer's statement, in the source's words, with the time in it.

The page shows it and lets the buyer print or save it. A second message returns the same bytes.

**`withdrawal_receipt`**, to the stated purchase address. Subject `Mottagningsbevis – ångrat köp, order <nr>`, or `Mottagningsbevis – meddelande om ångrat köp, order <nr>` when not eligible. It contains:

- `Mottaget: <ISO> (UTC)`, `Butik`, `Order`, `Namn`;
- "Varor som ångras:" and, when there are any, the personalised lines under their own heading;
- "Ditt meddelande: <statement>";
- then one of three endings:
  - eligible: "Spara detta mottagningsbevis. Återbetalning hanteras enligt butikens villkor.";
  - `personalized_exempt`: the order holds only made-to-order goods whose right the buyer waived at checkout; the right to complain about faults always applies; the shop has the message;
  - `window_passed`: the order is older than 450 days; the shop has the message.

**`withdrawal_notice`**, to the shop's support address as it was when the message arrived. Subject `Ångrat köp: order <nr>`, or `Meddelande om ångrat köp: order <nr>`. It contains:

- the same facts, plus "Kundens e-post";
- what the function answered: when eligible, "Kunden har fått ett mottagningsbevis. Bedöm om ångern kom i tid: ångerfristen är 14 dagar från den dag kunden tog emot varan.";
- "Inga pengar har flyttats. En återbetalning gör du själv under Ordrar i butikens admin."

Every value is HTML-escaped (tested with `<svart>`, `& <Co>`, `<b>`).

**The path.** In the intake batch, the row, one outbox row per mail and, when the shop has no support address, an alert are written together. Each extra statement is conditioned on `EXISTS (SELECT 1 FROM withdrawals WHERE withdrawal_id = <this call's id>)`, so a message that lost a race writes nothing at all. An outbox row is `event_type 'withdrawal_email'`, `aggregate_type 'withdrawal'`, `dedupe_key withdrawal_email:<kind>:<withdrawalId>`, and `payload {kind, withdrawalId}`: ids only; the recipient is read from the row.

The effect `runWithdrawalEmailEffect` mirrors the order confirmation's effect:

- The job is deterministic: the delivery id comes from the dedupe key, `createdAt` from the outbox row, the content from the immutable row. No `frozen_json` is needed: nothing it renders is live.
- The ledger row and the move to `submitting` go in one batch under the claim. Then the job is enqueued, then the row is marked `done`.
- The ledger fingerprint covers the content.
- A missing queue or a failed enqueue is retried. Past the ledger's 24 hours, the row fails with an `outbox_failed` alert, which carries ids only.

**The withdrawal is recorded before any of this runs.** The route nudges the outbox only when the effect type is one the consumer runs; a nudge for an unknown type would be retried and dropped.

---

## 5. How each rule of the brief is met

| Rule | How | Test(s) (`withdrawals.test.ts`) |
|---|---|---|
| 1. `POST /v1/withdrawals`, storefront, no session, the source's fields | exact path, `onMethods(["POST"])` + `storefront(…)`; strict parser of `{ orderNumber, statement: { name, contactEmail } }` | "answers only POST…", "obeys the public-entrypoint rule…", "refuses %s with the one 400…" (19 cases), "refuses a body over 4096 bytes…", "takes no tenant from the caller…", "parseWithdrawalInput keeps exactly the three stated facts" |
| 2. One answer for no order / wrong address; rate limit | one query and one constant-time digest comparison on both misses; the opaque 404; the per-visitor limit before the body | "…byte-identical 404s that write nothing" (unknown number, wrong address, another shop's order, the same number in another shop), "…run the very same statements…" (the SQL of both misses is recorded and must be equal; the SHA-256 count is 3 on both), "compares the address normalised…", "finds the order number as a buyer types it…", "limits one IP to 10…" (refused attempts count, `X-Forwarded-For` ignored), "puts every request without an edge address into ONE shared bucket", "counts an IPv6 visitor by its /64…", "keys a visitor address canonically…", "is enforced on the mounted route, and keeps no raw address in D1" |
| 3. Server time, written once; append-only with the three guards | `received_at = new Date(now).toISOString()` of the request; no time accepted from the body; the four triggers | "is recorded with the server's time…", the "a client time" refusals, "refuses every UPDATE and DELETE…", "refuses a second row for the order or the id — INSERT, OR IGNORE and OR REPLACE alike", "refuses a row that files one shop's order under another shop", the 9 CHECK cases |
| 4. The 450-day cap is the only age limit | `(now − orders.created_at) / day > 450` → `window_passed`; nothing else refuses | "the 450-day cap is the only age limit: 449 days is received, 451 days is 'window_passed' (recorded too)" |
| 5. A personalised order: not eligible, with the reason, recorded | `orders.is_personalized` + the frozen consent's `personalizedItems`; line by line (deviation 1) | "a wholly personalised order…", "a MIXED order…", "a personalised flag whose consent cannot be read…" |
| 6. A second message answers the first receipt, writes nothing | `INSERT … WHERE NOT EXISTS`, then read back; every other statement conditioned on this call's row | "a second message writes nothing and answers the first one's receipt, byte for byte (200)", "two first messages at once: one record, one 201, the other gets its receipt (200)" |
| 7. The receipt in the answer and by mail, through the outbox, in the same batch; a failing mail never fails the withdrawal | §4 | "is recorded with the server's time…" (outbox rows in the batch, `created_at` = the time of receipt), "the receipt: ONE deterministic job…", "a retry after a failed enqueue builds the identical job…", "holds (retries) while the email queue is not bound…", "gives up with an alert (ids only)…", "a mail path that is down never fails the withdrawal", "is wired on both sides or on neither…", "after the wiring, the -email consumer sends each mail once…" (runs once wired; see §9) |
| 8. The shop is told; the admin read shows it; no money moves | the notice mail; `readAdminOrderWithdrawal` (wiring 5); no statement touches `orders`, refunds or Stripe | "the notice: to the shop's support address as it was…", "a shop with no support address: the receipt still goes, the platform is alerted by ids only", "shows the withdrawal with its time to the order's own shop, and to no other", "is recorded…" (the whole `orders` row is identical before and after; no `refund_operations` or `order_status_history` row) |
| 9. Personal data: name and address in the row, no IP | columns as in §2; the IP is the limiter's hashed key only; outbox payloads and alerts carry ids only; nothing is logged | "is recorded…" (the IP is absent from the row), "is enforced on the mounted route, and keeps no raw address in D1", "no log line carries the buyer's name or address…" |
| 10. Another shop, a suspended shop, an unpublished shop | the tenant of a verified domain whatever its status; the order only under that tenant | "rule 10: a suspended, a closed and an unpublished shop's buyer can still withdraw on the shop's address" (plus another shop's order through the suspended host: 404), the unknown/pending/disabled hostname test |

Two mutation checks were run and reverted, to prove that two of the tests can fail. With an early return on an unknown order, "…the very same statements…" fails (fewer digests on the unknown order than on the wrong address). With the raw IP as the limiter's key, the IPv6 /64 test fails.

---

## 6. What was NOT done

- **The wiring** into `auth-email-job.ts`, `email-delivery-store.ts`, `outbox.ts`, `effects.ts`, `money-orders.ts`, the web Worker's allowlist and the client (§8). None of it is written; all of it was tried in a scratch copy.
- No path for account holders (`OrderWithdrawal.jsx` with `orderId` and a session): B2C accounts are PORT-LATER (D11, D81). The component can call this same route with the order's number and the prefilled purchase address.
- No admin list of withdrawals and no admin action on one. The refund is the existing refund route.
- No erase or redact path for the name and address (D68, open).
- No `audit_events` row (deviation 8).
- No DECISIONS entry, no `REQUIRED_MIGRATION` bump.
- No change for suspended or closed shops on the shared host's web Worker (open question 1).

---

## 7. Deviations from the brief and from the source, with the reason

1. **A mixed order is withdrawn line by line.** The brief (rule 5) and the source refuse an order whose `is_personalized = 1` as a whole. But that flag means "at least one line was personalised and waived", and the other lines of such an order keep the 14-day right (DAL 2 kap. 11 § 3 exempts only the made-to-order goods). Refusing the whole order refuses a right that exists. Built: `personalized_exempt` only when **every** line is personalised; a mixed order is eligible, `withdrawnItems` lists the lines that keep the right and `exemptItems` the others. An unreadable consent is read consumer-safe: no line is exempt. (CP2-E open question 9 is the same matter on the receipt read.)
2. **Every answered message is recorded and receipted, refusals included.** The source did not record a refusal and sent no mail. The brief says a refusal is "recorded too". Built: a refusal is recorded with its time, carries the receipt in the answer, is mailed to the buyer, and the shop is told. The reason is that the personalisation comes from the seller's product flag, and the flag can be wrong. If it is, the message the buyer sent at that time is a valid withdrawal, and the buyer needs the receipt as proof (the "always gets a receipt" rule of the task). The answer still says `eligible: false` with the reason, so the page shows exactly what it showed before.
3. **Three fields, not four.** The brief lists "the address the purchase was made with" and "the address the receipt shall go to" apart. The source and the page have one field (`contactEmail`, labelled "E-postadress (samma som vid köpet)", hint "Hit skickar vi mottagningsbeviset"). It must be the purchase address, and the receipt goes there. Kept, deliberately: a message sent by someone who knows the order number and the address then always reaches the owner of that address. With a separate receipt address, a stranger could withdraw someone else's purchase and send the receipt to themselves. The law's minimum is met: the buyer states, or confirms, the address for the receipt.
4. **The name is required.** The source fell back to the order's customer name. Orders on Cloudflare hold no name, the law requires the consumer to state it, and the page does not submit without it.
5. **The mails are an outbox effect of their own type, `withdrawal_email`,** not the existing `email` type. The existing `email` effect handles only `order_confirmation` and fails any other payload terminally, with an alert. A new type waits untouched until it is wired. The ledger needed two new kinds (the rebuild in 0044).
6. **No rate limit per order number.** I built one (10 per hour per order number, from any address) and removed it. Any limit keyed on an order lets whoever knows the order number keep its buyer out of the function for as long as they send 10 requests an hour: the under-availability the law forbids. The brief asks for a limit per visitor address (rule 2), and that is what stands, made durable, counted before the body, and keyed by /64 for IPv6. A test pins that 30 wrong guesses on one order from 30 addresses leave the buyer able to withdraw. What stays open: an attacker with many IPv4 addresses and a known order number can try addresses at 10 per 10 minutes per IPv4 address. Trying out order numbers themselves is bounded by the number space: 8 random characters of 32, per day.
7. **Rule 10: the tenant is resolved without the `active` condition** (the default the brief proposes). This departs from the one tenant rule of `resolveRequestTenant` in one respect only, the tenant's status. The hostname rule and the verified domain stay.
8. **No `audit_events` row** (rule 5 of §0 says writes are audited in the batch). The intake has no actor, it follows the report intake (CP3-D), which writes none, and the withdrawal row itself is the append-only evidence.
9. **Not stored from the source:** `channel` (only the public path exists) and `orderAgeDaysAtSubmission`. The admin view computes the age from `received_at` and the order's `created_at`.
10. **Statuses:** 201 for a new record and 200 for an existing one. The callable had one kind of success. The client (`request()`) accepts any 2xx.
11. **A 4 KiB cap on the body** (not in the brief). The body is three short strings.

---

## 8. Reviewer wiring

Wiring items 1–4 are one change: the test "is wired on both sides or on neither" fails on a half wiring. A half wiring would enqueue jobs that the consumer drops as malformed while the outbox row goes `done`, and the receipt would be lost without a trace. Every item below was applied, exactly as written, in a scratch copy of `cloudflare/` (§9).

1. **`src/email/auth-email-job.ts`**
   - At the top: `import { isWithdrawalEmailJob, isWithdrawalEmailKind, parseWithdrawalEmailJob, renderWithdrawalEmail, type WithdrawalEmailJob } from "./withdrawal-email";`
   - `AuthEmailKind`: add `| "withdrawal_notice" | "withdrawal_receipt"`.
   - `AuthEmailJob`: add `| WithdrawalEmailJob`.
   - `parseAuthEmailJob`: before the `order_confirmation` branch, add `if (isWithdrawalEmailKind((value as { kind?: unknown }).kind)) { return parseWithdrawalEmailJob(value); }`
   - `renderAuthEmail`: first statement `if (isWithdrawalEmailJob(job)) { return renderWithdrawalEmail(job); }`

   This creates an import cycle (`withdrawal-email.ts` imports `hashEmailRecipient` from here). It is harmless: both sides call each other only at run time, and it was verified in the wired run.
2. **`src/email/email-delivery-store.ts`**: `import { fingerprintWithdrawalEmailJob, isWithdrawalEmailJob } from "./withdrawal-email";` and, as the first statement of `fingerprintAuthEmailJob`, `if (isWithdrawalEmailJob(job)) { return fingerprintWithdrawalEmailJob(job); }`. The producer (the effect) and the consumer then compute the same fingerprint by construction. Every other kind's fingerprint is unchanged: the golden test in `outbox-email.test.ts` passed wired.
3. **`src/outbox/outbox.ts`**: `OUTBOX_EFFECT_TYPES` gains `"withdrawal_email"`.
4. **`src/outbox/effects.ts`**: `import { runWithdrawalEmailEffect } from "../commerce/withdrawals";` and `withdrawal_email: runWithdrawalEmailEffect` in `EFFECTS`. From then on, the route nudges the rows itself (`isWithdrawalEmailEffectRunnable()`).
5. **The admin order read**, `src/routes/money-orders.ts` `handleAdminOrderRoute`: `import { readAdminOrderWithdrawal } from "../commerce/withdrawals";`, then `const withdrawalRequest = await readAdminOrderWithdrawal(env.DB, principal.tenantId, orderId);` and `withdrawalRequest,` in the `order` object beside `withdrawal`.

   The value is `null`, or `{ consumerName, contactEmail, eligible, exemptItems, orderAgeDays, reason, receivedAt, shopNotified, statement, withdrawalId, withdrawnItems }`. It holds no money figure.

   Pin to update: `test/refunds.test.ts` › "GET /v1/admin/orders/:orderId" › "returns the money facts with ONE fee figure and the payout card": add `withdrawalRequest: null,` after `withdrawal: { waived: false },`.

   Note: this read shows the seller the buyer's name and address. The admin order read shows no buyer address today. Drop the two keys if the seller should not see them there; the notice mail carries them anyway.
6. **The web Worker's allowlist**, `web/src/api-allowlist.ts`:
   - add `{ methods: ["POST"], segments: ["v1", "withdrawals"] }` after the reports row;
   - drop the header's sentence "The withdrawal intake is not here…";
   - in `test/web-routing.test.ts`, add `["POST", "/v1/withdrawals"]` to "passes" and `["GET", "/v1/withdrawals"]`, `["POST", "/v1/withdrawals/x"]` to "refuses".
7. **The client**, `src/api/withdrawal.js`: the request and the return value already match (`{ orderNumber, statement: { name, contactEmail } }` → `data.withdrawal`). Only the header comment changes: "NOT BACKED YET" becomes the shapes of §3 (201/200, 400, the one 404, 429). F reads `eligible`, `reason` and `acknowledgement` from the returned object. An `ApiError` with status 404 maps to the page's "withdrawal_page_not_found" text, and 429 to "withdrawal_page_rate_limited".
8. **`REQUIRED_MIGRATION`** → `"0044_withdrawals.sql"` at the consolidation (in `app.ts` and the two tests that pin it).
9. **DECISIONS**: D68 gains the `withdrawals` table (the buyer's name and address in append-only evidence, with no erase path). Deviations 1, 2 and 6 and open question 1 are Mikael's to confirm.

---

## 9. Test numbers

- **`test/withdrawals.test.ts`: 72 tests.** In the tree as it stands: 71 passed, 1 skipped. The skipped test is "after the wiring, the -email consumer sends each mail once…", which runs only when the consumer can read the job.
- **Wired** (wiring items 1–7 applied in a scratch copy of `cloudflare/`, node_modules linked): `tsc` reports no error in any file of this builder or of the wiring. The only errors were builder A's `product-variants.ts` as copied at that moment, and test imports that point outside `cloudflare/` (`../../docs/…`, `../render/…`). Run together, `withdrawals` (**72/72**, the consumer test included), `refunds` (with the updated pin), `web-routing` (the new allowlist rows), `outbox-email` (the golden fingerprints), `outbox`, `email-queue-consumer`, `email-delivery-store`, `auth-email-job`, `money-crons` and `dispatch` gave 498 passed and 1 failed. The failure is "reserves exactly the non-shop first segments of src/config/tenancy.js", which imports `../../src/config/tenancy.js` and cannot resolve outside the repository. It is an artefact of the copy.
- **The gate in the tree** (05:49, after the last change): `cd cloudflare && npx tsc --noEmit` is clean. `npx vitest run` ran **84 files, 3586 tests: 3583 passed, 1 skipped (above), 2 failed.** Both failures are in files this builder does not own:
  - `test/admin-settings.test.ts` › "nothing in tenant_settings reaches a public response" › "the storefront, the product list and the product page carry none of it": `/v1/storefront` now carries `identity.heroHeadline` and `pickupLocations` (builder D's storefront response).
  - `test/web-worker.test.ts` › "a navigation" › "serves the application through the real API, which has no head route yet": the head route now exists (builder D).

  Both fail identically in a copy of the same tree with every file of this builder removed and the two G blocks taken out of `app.ts`. They are reported here and not repaired. (An earlier full run also failed in `public-catalog` and `public-legal`, the work of A and C at that moment; both passed in the later runs, with and without this builder's files.)
- `node guard/guards.test.mjs`: PASS. A grep of the five new files for the guard's patterns finds nothing. The new files are untracked, so the guard script itself will scan them only once they are committed.

---

## 10. Open questions

1. **Rule 10: suspended and closed shops.** The API takes the withdrawal: the tenant of a verified domain whatever its status (deviation 7, tested). But on the shared host the web Worker never forwards: `Internal.fetchForShop` → `shopStorefrontHostname` requires `tenant.status = 'active'`, so `/_api/<shop>/v1/withdrawals` of a suspended or closed shop is a 404 before it reaches the route. The page itself depends on D's storefront response for such a shop. **Proposal:** `fetchForShop` maps a suspended or closed shop for `POST /v1/withdrawals` only, and the `/angra` page renders for such a shop without the catalogue. The law requires the function to be available throughout the withdrawal period, and a buyer's right does not end when the platform suspends the seller. Another shop's order: never reachable through this shop's address, as the source had it (shop parity). An unpublished shop: taken, as today. Needs Mikael, and E, D and F for the pieces.
2. **Refusals get a receipt and the shop is told** (deviation 2). Confirm, or keep the source's silent refusal. The change is one condition in `submitWithdrawal`.
3. **Mixed orders line by line** (deviation 1). Confirm; it is a legal reading.
4. **No per-order-number limit** (deviation 6). Confirm the trade-off: availability over a second barrier against guessing an address.
5. **The seller sees the buyer's name and address** in the admin order read (wiring 5), which today shows no buyer address.
6. **A withdrawal received near the end of the 24-hour mail window** (a queue outage longer than a day) is recorded, but its mails fail with an alert and are not re-sent. The receipt on screen and the row stand, as the source's header says. A resend from the admin is not built.

---

## Review round 1 (reviewer, 2026-09-28)

Read line by line: the migration (the rebuilt mail ledger compared with 0029's text: it differs in the two new kinds and nothing else), `withdrawals.ts`, `storefront-withdrawals.ts`, `withdrawal-email.ts`. Run by the reviewer after the wiring: `tsc` clean for both projects; ten suites, 499 tests passed (withdrawals 72 of 72, the mail and outbox suites, refunds, the web Worker's routing).

**Wiring applied by the reviewer (items 1–7), in one commit:** the two mail kinds in `auth-email-job.ts` and `email-delivery-store.ts`; the `withdrawal_email` effect in `outbox.ts` and `effects.ts`; `withdrawalRequest` in the admin order read with the pinned shape in `refunds.test.ts`; `POST /v1/withdrawals` on the web Worker's allowlist with its three test rows; the header of `src/api/withdrawal.js`. Item 8 waits for the consolidation.

**Deviations:** 3–5 and 7–11 accepted. **1, 2 and 6 are Mikael's to confirm (D97)**, built as G proposes meanwhile, because each is the reading that gives the buyer more: a mixed order is withdrawn line by line; a refusal is recorded and gets its receipt; there is no limit per order number.

**Open question 1** (a suspended or closed shop on the shared host): the route takes the withdrawal, the web Worker does not forward it, and the page does not render for a shop that is not active. Recorded in D97 for Mikael. **Open question 5:** the admin order read shows the name and the address the buyer stated in the withdrawal, since the shop must answer it. **Open question 6:** a mail that the queue could not take within 24 hours fails with an alert; the record and the receipt on screen stand. A resend route is not built.
