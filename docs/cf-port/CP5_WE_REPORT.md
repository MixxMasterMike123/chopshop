claude-opus-5-5

# CP5-WE — the order mails on the Worker

Built on HEAD `464b6af8`, branch `cf-port`. Nothing committed and nothing deployed; no network was used. FN1 had changes in `src/**` during the run. I touched none of them.

## What was built

Three new mail kinds, each an outbox effect in the existing pattern:

1. The outbox row is written in the same transaction as the fact it reports.
2. The effect builds ONE deterministic job, with its delivery id derived from the dedupe key. In one batch under the claim, it records the ledger row (`email_deliveries`), freezes whatever is live and moves the row to `submitting`.
3. The job goes on `EMAIL_QUEUE`.
4. The existing `-email` consumer claims the ledger row and sends through Resend with `Idempotency-Key: <deliveryId>`.

So a retry never sends twice. Retries are bounded: the outbox allows 10 attempts with backoff, and the ledger allows 8 attempts within a 24-hour job lifetime. A dead mail is visible: the outbox row is `failed` and an `outbox_failed` alert is raised, and a ledger row the provider refused is `failed`/`expired`.

| Kind | Trigger (written where) | Recipient | Content | Idempotency (dedupe key → delivery id) |
|---|---|---|---|---|
| `order_notice_shop` | A new paid order. One `outbox_events` row (`event_type 'email'`, payload `{orderId, kind}`) **inside the webhook's order batch** (`webhook.ts`, one `outboxStatement`). It is nudged with the order's other rows. | The shop's `tenants.support_email` if it is a real address (not `@example.com/org/net/se`). Otherwise the shop's **oldest active admin** (one address, so one job). If there is neither, the row is marked `failed` with `no_shop_address` and an `outbox_failed` alert. The chosen address is frozen on the row. | Order number; delivery ("Frakt till Sverige" or "Upphämtning: <place>"); the lines (qty, name, line total); **what the buyer paid** (subtotal, shipping, discount, total, VAT included); a "Hantera order" link `<CANONICAL_ORIGINS.admin>/admin/orders/<orderId>` (validated: https, exactly that path, no query). It has **no fee, commission, withholding, printer cost or payout**, and the content type has no key one could hide in. It has no buyer name, address or e-mail either (see the open questions). | `email:order_notice_shop:<orderId>` |
| `refund_notice` | A refund **settles**. One statement in `refunds.ts` `orderEffectStatements`, in the batch that moves the operation. It inserts only when THIS transition made the op `succeeded` (`r.transition_id = ?` and `r.state = 'succeeded'` and `r.prev_state IS NOT 'succeeded'`). Reserved (202), submitted (pending) and failed refunds write nothing. A dashboard refund that arrives as succeeded writes one row. `ON CONFLICT DO NOTHING`, so a mail row can never abort a money batch. Payload `{kind, orderId, operationId, full}`. `full` is computed in SQL after the money moved (`refund_succeeded ≥ charged`). The outbox id `email-refund-notice:<opId>` is deterministic. | The buyer (`orders.customer_email`). Reply-To is the shop's support address. | Greeting by the recipient's name, if any; full or partial; order number; **refunded amount = the operation's `amount_minor`**, formatted sv-SE; "Pengarna når dig inom några bankdagar …"; the shop's contact line. If the op is no longer `succeeded` when the effect runs (it failed after succeeding), the row is done and nothing is mailed. | `email:refund_notice:<operationId>` |
| `order_status_update` | CP5-WB's `email.order_status` rows (`fulfilment.ts`, payload `{historyId, orderId}`). This unit adds the event type to `OUTBOX_EFFECT_TYPES` and the effect `runOrderStatusEmailEffect`. | The buyer (`orders.customer_email`). Reply-To is the shop's support address. | Greeting by the recipient's name; "uppdatering om din beställning hos <shop>"; order number and status; the per-step lines in the table below; the shop's contact line. | `email.order_status:<historyId>` (WB's key) |

What is live is frozen on the outbox row at the first build (`frozen_json`, write-once since 0022): the shop name, the support address, the notice's recipient and the admin link. A rename or address change between a recorded attempt and its retry therefore cannot turn into a fingerprint conflict that silently drops the mail.

**The buyer's name and address are never frozen** (D68/D98). The name is re-read from `order_recipients`, which is insert-once. The buyer's address is `orders.customer_email`. Payloads carry ids and a flag only. Nothing new is logged. The ledger keeps what it already kept: a recipient hash and a fingerprint.

**Locale:** orders carry no locale column, so every job is `sv`, as the confirmation is. The job frame pins `locale: "sv"`; adding `en` later means adding a column and a copy table.

### Step → mail

Decided from what the Firebase function sent (`sendOrderStatusUpdateEmail` was called on every status change, with copy for processing, ready_for_pickup, shipped and delivered) and from what `fulfilment.ts` emits (one row per change, `completed` included):

| Fulfilment change | Mail? | Says |
|---|---|---|
| → `processing` | yes | "Behandlas"; you will get a new mail when it ships or can be collected |
| → `shipped` | yes | "Skickad"; tracking number and carrier when given ("Använd spårningsnumret …" only when there is one) |
| `shipped` → `shipped` (another parcel) | yes | "Ytterligare ett paket … är nu på väg"; subject "… – ytterligare ett paket skickat"; the new tracking number |
| → `ready_for_pickup` | yes | "Redo att hämtas"; the place's name and address as frozen at checkout (`order_recipients`); "Ta med ditt ordernummer" |
| → `delivered` | yes | "Levererad" |
| → `completed` | **no** | The row is marked `done` with no job and `result_ref` NULL. Firebase had no such status; it is the seller's bookkeeping close, and the buyer has already heard. |

The seller's `note` is **not** in the buyer's mail. Firebase showed `notes` to the buyer, but on Cloudflare the note goes to the history `reason` and the audit row, and the seller may write internal text there (see the open questions).

Every value is plain text in the text part and HTML-escaped in the HTML part: shop name, line names, place, tracking number, carrier and the buyer's name. Validation refuses control characters and length overruns. The builders clean stored text first (`mailText`), so an odd stored value cannot block a mail. Status mail content is cross-checked: shipment facts are only allowed on `shipped`, and the place only on `ready_for_pickup`.

## Migration 0050_email_kinds.sql

This is a rebuild of `email_deliveries` to add the three kinds to its `kind` CHECK. It uses the exact recipe of 0022, 0029 and 0044:

1. `CREATE TABLE …_migration_0050 AS SELECT *`.
2. `DROP`.
3. `CREATE` the identical shape with the three kinds added.
4. `INSERT … SELECT`, column by column and by name.
5. `DROP` the copy.
6. Re-declare the two triggers (`tenant_immutable`, `fingerprint_required`) and the three indexes exactly as 0044 did.

No foreign key references the table, and no migration from 0045 to 0049 touches it. `REQUIRED_MIGRATION` in `src/app.ts` and the two tests that pin it (`health`, `public-catalog`) now point to `0050_email_kinds.sql`.

**How it was verified against existing rows.** The test `migration 0050 keeps every ledger row` in `test/order-emails.test.ts` stages it:

1. It runs 0044's own `email_deliveries` statements (from `env.TEST_MIGRATIONS`), which puts the table back in the shape 0050 meets. The test asserts that 0045–0049 never mention the table, and that the old shape refuses `order_status_update`.
2. It inserts one row of each of the six existing kinds, in every status (pending; processing with a lease; sent with a provider id; failed; expired; tenant NULL and non-NULL).
3. It runs 0050's statements as wrangler would.
4. It reads the rows back `toEqual` the "before" rows and checks the total count is unchanged. The three new kinds are admitted, unknown kinds are refused, both triggers fire, and `sqlite_master` lists exactly the three indexes and two triggers with no `_migration_` table left behind.

The mutation `WHERE kind <> 'alert_digest'` in the copy makes this test fail.

## Files

New:
- `cloudflare/migrations/0050_email_kinds.sql`
- `cloudflare/src/email/order-emails.ts`: the kinds, job create/parse/validate, fingerprint, Reply-To and the Swedish templates
- `cloudflare/test/order-emails.test.ts`: 25 tests

Changed:
- `cloudflare/src/outbox/email-effect.ts`: refactored to one `deliver()` path plus builders for the confirmation (behaviour unchanged, still frozen under `confirmation`), the shop notice, the refund notice and the status update. Adds `runOrderStatusEmailEffect`.
- `cloudflare/src/outbox/outbox.ts`: `"email.order_status"` added to `OUTBOX_EFFECT_TYPES`.
- `cloudflare/src/outbox/effects.ts`: its effect added to the effect map.
- `cloudflare/src/email/auth-email-job.ts`: the kinds in `AuthEmailKind`/`AuthEmailJob`, delegation in parse and render, and `COUNTRY_NAMES_SV` exported.
- `cloudflare/src/email/email-delivery-store.ts`: delegation in the fingerprint. The golden fingerprints of the auth kinds are unchanged; the existing test still pins them.
- `cloudflare/src/email/email-queue-consumer.ts`: `reply_to` = the shop's support address for the two buyer mails only.
- `cloudflare/src/commerce/webhook.ts`: ONE statement (the notice row) in the order batch, plus a comment.
- `cloudflare/src/commerce/refunds.ts`: ONE statement in `orderEffectStatements`.
- `cloudflare/src/app.ts`: `REQUIRED_MIGRATION`.
- Tests updated for one more outbox row per order:
  - `test/webhook-money.test.ts`: the row counts and the payload of the new row.
  - `test/slice-harness.ts`: `buyProduct` tells the confirmation from the notice by dedupe key, delivers both, and returns `noticeId`.
  - `test/slice/failure-injection.test.ts`: counts. The "queue is down" test sweeps leftovers first, because earlier tests' refund notices now share the sweep's 10-row inline limit.
  - `test/slice/vertical-slice.test.ts`: three outbox inserts in the order batch. Two mails are delivered, and the notice goes to the shop's only admin (the slice shop has no support address), naming the buyer's total and none of fee, withholding or payout.
  - `test/health.test.ts`, `test/public-catalog.test.ts`: the migration pin.

No env vars, bindings or `wrangler.jsonc` changes.

## Tests and mutations

`test/order-emails.test.ts` covers:
- **The migration**, staged as above.
- **The notice is in the order's batch.** A batch that dies on `INSERT INTO orders` leaves no order, no notice and no orphan outbox row. On Stripe's retry the instrumented DB shows that the one batch writing the order holds both `email` inserts, and that no outbox row is written anywhere else.
- **The notice effect:** it goes to the support address with exact content keys. The rendered text and HTML contain the buyer's total and **none of** the fee (13 300), withholding (12 300), payout (6 700) or production cost (9 840), and no word of avgift/provision/utbetal/tryck/inköp. The shop name is escaped and the admin link exact.
- **Notice recipients:** the oldest-admin fallback; no address at all gives `failed` and an alert.
- **Cross-tenant:** a row filed under shop B naming shop A's order gives `order_not_found` with nothing queued, and A's own notice goes to A's address only.
- **Frozen recipient:** an address changed between a recorded attempt and its retry is still mailed once, to the first address.
- **Refund:**
  - A settled full refund gives one row with `full: true`; the mail carries the server's amount and Reply-To.
  - Partial then completing gives `[false, true]`.
  - A **reserved (202) refund writes nothing**; its webhook settlement writes one, and replays plus `refund.updated` write no more.
  - Pending refunds write nothing; the failed one never writes, and the succeeded one writes once.
  - A dashboard refund is noticed once.
- **Status:** the whole table above through the real admin route.
  - processing, shipped with tracking and carrier, a further parcel and delivered each mail; completed is done with no job.
  - The greeting by name is escaped, and the carrier `<b>PostNord</b>` is escaped.
  - Neither the buyer's name nor their address is in `frozen_json`.
  - Pickup names the place. Reply-To is set.
- **A retry never sends twice:** a crash after enqueue is re-claimed and re-queues the identical job; the consumer given both sends ONE (one Resend call, with the right Idempotency-Key), and a done row is `settled`.
- **Status edge cases:** a forged cross-tenant status row gives `history_not_found`. A malformed payload gives `invalid_payload`. A row past 24 h gives `email_expired` plus an alert.
- **No sender configured:**
  - `EMAIL_QUEUE` unbound: the webhook (200), the refund (201) and the fulfilment (200) answer as always and write their rows. Each effect retries with `email_queue_not_configured` and never throws.
  - Queue bound but no `RESEND_API_KEY`/`EMAIL_FROM`: the consumer does `retryAll(300)`, sends nothing and the ledger row stays `pending` (the auth mails' "not configured" state). Configured later, it sends once.
- **Templates:** a parse round trip and tampering refused; field cross-checks; admin link validation; the fingerprint covers the content.

Each behaviour was broken once (patch applied, the file's tests run, file restored):

| Mutation | Caught by |
|---|---|
| Notice removed from the order batch | "is written with the order …" |
| Notice written by a separate statement after the batch | "is written with the order …" (no outbox row outside the order batch) |
| Refund insert without its `state = 'succeeded'` guard | "a pending refund writes nothing …" |
| Delivery id random per attempt instead of from the dedupe key | "retry after a crash … ONE email", "freezes its recipient …" |
| `readOrder` without the tenant condition | "never mails another shop …" |
| Notice reads `application_fee_minor` as its VAT | "… no platform figure" |
| 0050 copy drops `alert_digest` rows | "migration 0050 keeps every ledger row" |
| Unbound queue throws instead of retrying | "the webhook, the refund and the fulfilment answer as always …" |
| HTML escaping removed | 3 tests (notice, status, pickup) |
| `completed` added to the mailed steps | "… completed mails nothing" |

## Gates (summary lines)

- `npx tsc --noEmit`, `-p web`, `-p admin`: all clean.
- `npx vitest run`: **Test Files 102 passed (102), Tests 4317 passed (4317)**. HEAD was 101/4292; the difference is +1 file and +25 tests. Nothing skipped.
- `npm run types:check`: "Types at worker-configuration.d.ts are up to date."
- `node guard/guards.test.mjs`: **exit 1, and not from this unit.** The failure is `(b) 1 stale guard/allowlist.txt entry — remove it: src/wagons/pod-wagon/studio/DesignStudio.jsx`. That is FN1's uncommitted edit, which removed the matched word, so its allowlist line must go in FN1's change. None of this unit's files match a guard pattern (checked by grepping the guard's patterns over every new or changed file under `cloudflare/`: no hit).

## What staging needs for mails to actually arrive (for Mikael)

The code is all in place: the `chopshop-stg-email` queue and consumer are bound and the cron sweeper runs every 15 minutes. What is missing is the sender:

1. A **Resend account with a verified sending domain**: DNS records for SPF and DKIM, plus DMARC, on a domain ChopShop owns (not melodiemc.com).
2. `cd cloudflare && npx wrangler secret put RESEND_API_KEY --env staging` (the Resend API key).
3. `EMAIL_FROM` for staging, e.g. `ChopShop <no-reply@<verified domain>>`, as a secret (`wrangler secret put EMAIL_FROM --env staging`) or as a var in `env.staging.vars`. The consumer refuses a malformed value and sends nothing.

These are the same two values the password reset and invite mails already wait for. Until they exist, every mail is recorded `pending` in the ledger and the queue retries it 8 × 300 s. After that the queue message is dropped while the ledger row stays `pending`. This is existing behaviour for all mails: a mail requested while staging has no key will not be sent once the key arrives, only later ones will.

## Open questions

1. **Status and refund mails arrive at the next sweep (≤ 15 min), not within seconds.** The fulfilment route (`routes/admin-orders.ts`) and the refund route (`routes/money-orders.ts`) do not nudge the outbox, and neither file is mine. The ids are deterministic, so the reviewer can add one line after a committed change: `nudgeOutbox(env, [\`email-order-status:${historyId}\`])` in the fulfilment route, and `email-refund-notice:<refundId>` beside the existing printer-cancellation nudge in the refund route. The webhook's notice is already nudged.
2. **Rows WB wrote before WE lands.** On staging, any `email.order_status` row older than 24 h will be claimed by the sweeper, marked `failed` with `email_expired`, and raise one `outbox_failed` alert each. That is correct, since a stale status mail should not go out, but it is noise. If unwanted, mark such rows `superseded` before the deploy. A read-only count: `SELECT COUNT(*) FROM outbox_events WHERE event_type='email.order_status' AND status='pending'`.
3. **The notice's recipient** is the support address, then the oldest active admin. There is no separate "order-notice address" setting on Cloudflare (Firebase had `storeIdentity.notificationEmail`), and D99 keeps `supportEmail` platform-set. Should the seller get their own notification address?
4. **The notice carries no buyer data** (no name, e-mail, phone or address), deliberately (D68). The seller opens the order in the admin. Firebase's notice included them. Add the name if Mikael wants it.
5. **The seller's `note` is not shown to the buyer** (Firebase did show it). If the note is meant for the buyer, WB's input needs a "visible to the customer" distinction first.
6. **No legal identity or footer** in the three mails. Firebase's templates had none either. The shop's name and support address are included, and the support address is the buyer mails' Reply-To.
7. **The refund notice does not mention a withdrawal.** Firebase's said "Detta slutför din utövade ångerrätt" when the order had a withdrawal. That needs a `withdrawals` read in the builder: small, but left out.
8. **Stale comment.** `src/commerce/fulfilment.ts`'s comment "the consumer and the template are unit WE's, so this row waits" (around line 436) is now stale. That file is WB's, so I did not edit it.

## Codex round 1

This round started from HEAD `a0034343`, which includes the reviewer's nudges in `routes/admin-orders.ts` and `routes/money-orders.ts`, `pendingOrderMailIds` in `outbox/nudge.ts`, and its extra test. I touched none of those, and none of the other builder's files (`pod/studio-files.ts`, `test/pod-studio-assets.test.ts`, `scripts/cf-port/migrate/**`).

1. **[P2] The notice's admin link now selects the order's shop.**
   - **The link.** `adminOrderUrl(env, orderId, tenantId)` builds `<admin>/admin/orders/<orderId>?shopId=<tenantId>`. The admin build ranks `?shopId=` first when it picks the active shop (`src/admin-app/providers/ActiveShop.jsx`, `activeShopStore.js` `shopIdOnArrival`). An admin of several shops therefore opens the order in the shop that owns it, and its requests carry the right `X-Shop-Id`.
   - **When there is no link.** A tenant id that does not fit the admin's own shape (`/^[a-z0-9][a-z0-9-]{0,62}$/`, exported as `ADMIN_SHOP_ID_PATTERN`) gets no link. The notice then says "Hantera ordern under Ordrar i butikens admin."
   - **The validator.** The job validator `isAdminUrl(value, tenantId)` is now told the job's tenant. It permits exactly one parameter, `shopId`, and its value must be the job's own tenant id in that shape. These are refused:
     - another shop's id;
     - a second parameter or a repeated `shopId`;
     - a fragment;
     - an encoded or uppercase value;
     - the old link without `shopId`.
2. **[P2] A pickup address keeps its full 500 characters.**
   - `MAX_PICKUP_ADDRESS_LENGTH = 500` (`order-emails.ts`) is the limit of the recipient schema (0045) and of the store identity's places. It is used by the builder (`mailText(…, MAX_PICKUP_ADDRESS_LENGTH)` in `email-effect.ts`) and by the matching `validatedStatus` check.
   - The place's name and the other texts keep 200, which is what their sources allow.

**Tests (`test/order-emails.test.ts`):**
- The notice test now expects the `?shopId=` link in the job, the HTML and the text.
- The admin-link test accepts the own-shop link and refuses the seven bad shapes listed above.
- A new test, "names a pickup address of the full 500 characters whole", runs a 500-character address through the real fulfilment route. It is checked in the job, in the rendered text, and after a round trip through the consumer's parser.

Each fix was reverted once, and each reversion fails its test:

| Reverted | Fails |
|---|---|
| Link without `shopId` (builder and validator) | the notice test and the admin-link test |
| Validator accepts any `shopId` | the admin-link test |
| Builder cuts the address at 200 | the 500-character test |
| Validator caps the address at 200 | the 500-character test |

**Gates:**
- tsc main, web and admin: clean.
- `npx vitest run test/order-emails.test.ts`: 27 passed (26 at HEAD plus 1).
- Full `npx vitest run`: **Test Files 102 passed (102), Tests 4321 passed (4321)**, nothing skipped. HEAD's 4318 plus this round's 1 makes 4319; the other 2 come from the builder working in parallel.
- `node guard/guards.test.mjs`: **exit 0, PASS**. FN1's stale allowlist entry from round 0 has since been resolved.

Files changed this round:
- `cloudflare/src/email/order-emails.ts`
- `cloudflare/src/outbox/email-effect.ts`
- `cloudflare/test/order-emails.test.ts`
- this report
