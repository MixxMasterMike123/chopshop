# CP4-R report — the recipient of an order (D98)

Builder: CP4-R, the only builder running. Branch `cf-port`, working tree only on top of `4c1db34e`: no git write, no network, no wrangler, no deploy. Brief: `CP4_BRIEFS.md` §0 and §R, DECISIONS D98, D68.

**Status: built and tested locally.** `POST /v1/checkout` now takes `recipient` and refuses a checkout without a valid one (400 `invalid_request`). The recipient is frozen with the checkout, is part of what the idempotency key stands for, is copied to the order in the batch that creates the order, is answered by the buyer's, the seller's and the platform's order reads, and goes into the printer's job of a shipped order. The storefront sends what the checkout form already collects, and the confirmation page gets the name, the address and the pickup place in the shape it already reads. `REQUIRED_MIGRATION` is `0045_order_recipients.sql` (the one exception brief R makes to rule 0.2).

---

## 1. Files

### Worker (`cloudflare/`)

| File | |
|---|---|
| `migrations/0045_order_recipients.sql` | new: `checkout_recipients`, `order_recipients`, their triggers |
| `src/commerce/recipient.ts` | new: the request shape and validation, the pickup-place check, the statements, the reads, the printer's `ShipTo` |
| `test/recipient.test.ts` | new: 55 tests |
| `src/commerce/checkout.ts` | `recipient` in the parser's allowlist and required; `invalid_recipient` result; resolve before the lines; the row in the checkout batch; the recipient in the replay fingerprint |
| `src/app.ts` | the checkout route answers `invalid_recipient` with `invalidRequestResponse()`; `REQUIRED_MIGRATION` |
| `src/commerce/webhook.ts` | one statement in the order batch: copy the checkout's row to the order |
| `src/commerce/receipts.ts` | the buyer's order read answers `recipient` |
| `src/routes/money-orders.ts` | the seller's order read answers `recipient` |
| `src/routes/platform-orders.ts` | the platform's order list answers `recipient` per order (chunked read) |
| `src/dispatch/dispatch-effect.ts` | reads the order's `ShipTo` and puts it on the job |
| `src/dispatch/printer-client.ts` | `PrinterJob.shipTo?`; `toSnapwearJobBody` adds `shipping_address` when there is one |
| `src/dispatch/snapwear-wire.ts` | `SnapwearShippingAddress` and `snapwearShippingAddress()`: the ONE place the wire shape of the address is built |
| `test/health.test.ts`, `test/public-catalog.test.ts` | the migration name |
| `test/slice-harness.ts` | `SLICE_PICKUP_LOCATION` set with the store settings in `makeLegallyReady`; `openCheckout` sends `SLICE_RECIPIENT` by default (or `options.recipient`) |
| `test/tenant-fixtures.ts` | its own `makeLegallyReady` sets the same pickup place (see Deviations) |
| `test/legal-fixtures.ts` | `FIXTURE_PICKUP_LOCATION`, `BUYER_RECIPIENT_PICKUP`, `buyerRecipientShipping()`, `buyerRecipientFor()`, `withBuyerRecipient()`; the fixture trigger and `readySettingsStatement` write the pickup place into the store identity |
| `test/checkout.test.ts`, `discount-codes`, `admin-discount-codes`, `admin-catalog`, `legal`, `legal-grace`, `legal-pages`, `pod-publish`, `product-variants`, `slice/vertical-slice` | their checkout bodies carry a recipient (see Deviations) |
| `test/receipts.test.ts`, `test/refunds.test.ts`, `test/slice/vertical-slice.test.ts` | their exact-shape assertions of the order reads include `recipient` |

### Client

| File | |
|---|---|
| `src/storefront/adapters/checkout.js` | `toApiRecipient()`; `buildCheckoutRequest` takes `shippingInfo`, `pickupLocationId`, `pickupDate` and sends `recipient` |
| `src/storefront/adapters/checkout.test.mjs` | the request with a recipient; `toApiRecipient` (4 tests) |
| `src/storefront/adapters/order.js` | `toPageOrder` maps `recipient` to `shippingInfo` / `pickupLocation` |
| `src/storefront/adapters/order.test.mjs` | 3 tests |
| `src/components/shop/StripePaymentForm.jsx` | only the three props it hands to `buildCheckoutRequest` (+ its comment) |
| `src/api/checkout.js` | `createCheckout` forwards `recipient` (see Deviations) |
| `src/api/api.test.mjs` | 1 test |
| `src/storefront/dev/money-fixtures.json`, `money-api.mjs` | the dev order carries an invented recipient; comment |

Not touched: `src/pages/shop/*.jsx`, `wrangler.jsonc`, both `env.d.ts`, `vitest.config.ts`, `pinned.*.json`, `scripts/`, the fake printer (`src/dispatch/fake-printer.ts`, `src/routes/fake-printer.ts`: it stores unknown top-level fields verbatim, as CP1-C built it to).

---

## 2. The request

`POST /v1/checkout` — the body as before plus `recipient` (required):

```
shipping  { name, addressLine1, addressLine2?, postalCode, city, country, phone? }
          country: two upper-case letters, EQUAL to shippingCountry
pickup    { name, phone?, pickupLocationId, pickupDate? }
          the place: one of the shop's own (tenant_settings.store_identity_json
          `pickupLocations`, read through the storefront's own projection);
          the date: required and one of the place's dates when the place has
          dates, refused when it has none
```

Validation (`parseRecipient`): every text trimmed; refused if the RAW text holds a C0 character, DEL, a C1 character, U+2028 or U+2029 (so a trailing line break is refused, not trimmed away); lengths in code points (as SQLite's `length()`): name 1–100, address lines 1–100, postal code 1–16, city 1–100, phone 0–30 of `0-9 space + - ( )` (empty = none, stored NULL); country `^[A-Z]{2}$`; `pickupDate` a real calendar date `YYYY-MM-DD`; `pickupLocationId` 1–128. Unknown keys refused, including a pickup key on a parcel and an address key on a pickup. Required as the checkout page requires (`Checkout.jsx` `validateStep`): a name always (the page's first + last name); street, postal code and city for a parcel; the pickup place, and the date when the place has dates. `addressLine2` and `phone` are optional (the page has no phone field).

Every fault is **400 `invalid_request`** with nothing written. A pickup place that is not the shop's is decided in `createCheckout` (it needs the database) as the result `invalid_recipient`, which the route answers with the same 400 — after the legal gates (a gated shop still answers its opaque 404) and before any line is resolved.

**Idempotency:** the stored row is compared column by column with the freshly frozen recipient, including the pickup place's copied name and address. The same key with another name, address, phone, place or date — or with a place the shop renamed in between — is the route's 409 `conflict`. A checkout from before 0045 (no row) replayed with a recipient conflicts too.

The checkout's response is unchanged (it does not echo the recipient).

## 3. The reads

`recipient` in all three, always every key, a key that does not apply is null, `null` for an order made before 0045:

```
{ deliveryMethod: "shipping" | "pickup", name, phone,
  addressLine1, addressLine2, postalCode, city, country,
  pickupLocationId, pickupLocationName, pickupLocationAddress, pickupDate }
```

| Read | Where |
|---|---|
| `GET /v1/orders/:orderId` + receipt token (buyer) | `order.recipient`, read only after hostname tenant + order id + token hash + expiry matched |
| `GET /v1/admin/orders/:orderId` (seller) | `order.recipient`, tenant from the principal |
| `GET /v1/platform/orders?tenantId=…` (platform) | `orders[].recipient`, one chunked `IN (…)` read per page, tenant-scoped |

A pickup's place name and address are those copied into the row when the checkout was made, not the shop's settings of today (tested: the shop renames and moves the place after the purchase; all three reads show the old ones).

## 4. The schema (0045)

`checkout_recipients` (PK `checkout_id` → `checkouts`) and `order_recipients` (PK `order_id` → `orders`), identical columns: `tenant_id`, `delivery_method`, `name`, `phone`, `address_line1`, `address_line2`, `postal_code`, `city`, `country`, `pickup_location_id`, `pickup_location_name` (≤200), `pickup_location_address` (≤500), `pickup_date`, `created_at` (ISO-8601 TEXT, round-trip CHECK). CHECKs: the lengths, the phone alphabet, the country, a real date, no line feed / carriage return in the one-line texts, and the shape per delivery method (a parcel has an address and no place; a pickup a place and no address).

Triggers, per table: **BEFORE INSERT** — the parent exists with the same tenant, the same delivery method and (for a parcel) the same country; **insert once** — a second INSERT for the same parent (plain, OR IGNORE, OR REPLACE) aborts; **BEFORE UPDATE** — every UPDATE aborts (so the tenant is immutable too). A DELETE is allowed by the schema (D68: the recipient must be removable one day without touching the order) and done by no route. FKs `ON DELETE RESTRICT` to the parents, so a parent is never removed from under a row.

Copy to the order: `INSERT INTO order_recipients … SELECT … FROM checkout_recipients WHERE tenant_id = ? AND checkout_id = ?` in the order batch — no row, nothing copied, the order is created exactly as before.

## 5. The printer's job

`dispatch-effect.ts` reads the order's `ShipTo` (`readDispatchShipTo`: the order's recipient when the order AND its recipient row are `shipping`, else null) and puts it on `PrinterJob.shipTo`. `toSnapwearJobBody` adds, only when there is one:

```
shipping_address: { name, address1, address2, zip, city, country_code, phone }
```

built by `snapwearShippingAddress()` in `snapwear-wire.ts` — the one function to change when SnapWear's real field names are known. A collected order's job, and the job of an order made before 0045, carries no `shipping_address` (the key is absent, so every existing exact-body test is unchanged). Tested through the real dispatch into the fake printer's stored payload.

## 6. Nothing of a recipient is logged

The checkout audit row stays `{ items }`, the order audit row `{ items, paymentIntentId }`, the outbox payloads ids only, no alert text names a recipient, nothing is `console.*`-logged. Proven by one test: a whole shipped POD purchase (checkout, payment, the webhook's order, the dispatch to the printer, the confirmation mail) with every `console` method captured, then every row of `audit_events`, `alerts`, `outbox_events`, `payment_events`, `email_deliveries`, `deferred_payment_events` and every captured line searched for seven distinctive values of the test's recipient; the control asserts the search does find them in `order_recipients`. A mutation run (recipient name put into the checkout audit row, and the recipient taken out of the fingerprint) made that test and both 409 tests fail; the mutation was reverted.

## 7. The client

`buildCheckoutRequest({ …, shippingInfo, pickupLocationId, pickupDate })` → `recipient` by `toApiRecipient`: name = trimmed first + last name joined by a space; a parcel's `addressLine1` from `address`, `addressLine2` from `apartment` only when not blank, `postalCode`, `city`, `country` = the request's shipping country; a pickup's `pickupLocationId` and `pickupDate` only when not blank; `phone` only when the form ever has one. Nothing is invented: an empty name is sent empty for the server to refuse. `StripePaymentForm` passes `shippingInfo`, `deliveryInfo.pickupLocation.id`, `deliveryInfo.pickupDate`. The request is also the payment effect's fingerprint and the idempotency map's key, so a changed recipient is a new checkout with a new key, as a changed basket is.

`toPageOrder`: with a recipient, `shippingInfo = { firstName: name, lastName: '', address, apartment, postalCode, city, country }` for a parcel, `shippingInfo = { firstName: name, lastName: '' }` and `pickupLocation = { id, name, address, date }` for a pickup — the keys `OrderConfirmation.jsx` reads. The API has ONE name, so it is printed as the first name with an empty last name. Without a recipient, exactly as before.

---

## 8. What was NOT done (brief rule 9 and more)

- The address in the order confirmation mail.
- The route that removes a recipient (D68), and any retention rule: `checkout_recipients` rows of checkouts that are never paid stay (the checkout sweep only purges the production snapshot).
- Validation of a postal code against its country.
- A pickup date in the past is not refused as such: it is accepted while the shop still lists it (the page hides past dates by the browser's clock; the server has no time zone rule yet).
- The checkout response does not echo the recipient; the admin order LIST (none exists on the Worker) has nothing to show.
- No change to the fake printer: it does not validate `shipping_address`.

## 9. Deviations from the brief, with the reason

1. **Files outside "Owns"**, each the smallest change:
   - `src/api/checkout.js` (+ one test in `src/api/api.test.mjs`): `createCheckout` copies named fields into the body and dropped `recipient`, so without this the recipient never left the browser. The existing byte-for-byte adapter test caught it.
   - `test/tenant-fixtures.ts`: it has its own `makeLegallyReady` (used by `platform-tenants.test.ts`); its shops needed the pickup place the harness's default recipient names.
   - `test/legal-fixtures.ts`: the SQL-seeded suites get their pickup place the way they get legal readiness — through the existing fixture trigger and `readySettingsStatement` — and shared recipient helpers.
   - Ten older suites that post `/v1/checkout` themselves (not through the harness) now send a recipient; three exact-shape assertions of the order reads now include `recipient` (`receipts`, `refunds`: `null` for their SQL-seeded checkouts; `vertical-slice`: the harness recipient). No assertion was loosened.
   - The Worker files of the reads, the order creation and the printer job are the ones brief R names by function (`receipts.ts`, `money-orders.ts`, `platform-orders.ts`, `webhook.ts`, `dispatch-effect.ts`, `printer-client.ts`, `snapwear-wire.ts`); `app.ts` is touched outside a CP4 block for the checkout route's one new refusal branch, and for `REQUIRED_MIGRATION`.
2. **The harness's shops now have a pickup place** in their store identity (set through `PUT /v1/admin/settings` in `makeLegallyReady`), because the harness buys by pickup and brief R requires the place to be the shop's. Its id is the same (`fixture-pickup`) as the SQL fixture's, so one default recipient fits both kinds of shop.
3. **One `name`**, not first + last: brief R says `name`; the page's two fields are joined. SnapWear's DPA speaks of first and last name (open question 2).
4. **The platform order list** said in its comment "no buyer email (reconciliation does not need personal data)". Brief R asks for the recipient there; built, and the comment now says why. See open question 4.
5. **The buyer's read shows the recipient unmasked**, while the e-mail address beside it is masked (`b***@…`). Brief R asks for the recipient there; built as asked. See open question 5.

## 10. Open questions

1. **With SnapWear, the address on the job** (all provisional in `snapwear-wire.ts`): the field names (`shipping_address`, `name`, `address1`, `address2`, `zip`, `city`, `country_code`, `phone` are guesses); whether they want first and last name apart; whether telephone and the buyer's e-mail are required (the DPA lists both as data the carrier receives — the job carries no e-mail today); their length and character limits; and **one parcel per order**: the dispatch sends one job per order LINE (`{orderId}-{lineNo}`), each now with the address — does SnapWear group jobs of one order into one parcel, or must the order be one job with many items?
2. **A collected POD order**: its job carries no address. Where does SnapWear send it — to the shop's return address, a pickup place, or is POD with pickup to be refused at checkout?
3. **An order from before 0045** that ships would reach the printer without an address. On Cloudflare no such paid order exists; on SnapWear it would likely be a 422 → `dispatch_failed` alert. Should a shipped order without a recipient be held instead?
4. **The platform list carries personal data** now (reconcile-staging reads it). Keep it there, or give the platform only a single-order read?
5. **Mask the recipient on the buyer's read** as the e-mail is masked (a leaked receipt link shows the address for 30 days)? The confirmation page then shows less.
6. **D68**: how long `checkout_recipients` of never-paid checkouts and `order_recipients` are kept, and the erasure route.

## 11. Reviewer wiring

None beyond this tree: the migration name is already set (brief R), no binding, variable or secret is new. Deploy order as for any migration: 0045 applied before the Worker that requires it.

## 12. The gate (run on the final tree)

```
cd cloudflare && npx tsc --noEmit                → no output (pass)
npx tsc --noEmit -p web                          → no output (pass)
npx vitest run                                   → Test Files  90 passed (90)
                                                   Tests  3893 passed (3893)
node --test src/api/*.test.mjs src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
                                                 → # tests 120 / # pass 120 / # fail 0
node cloudflare/web/check-storefront-build.mjs   → storefront build: 9 files (5 text) checked, no Firebase code, every file servable.
npx vite build                                   → ✓ built in 11.71s (exit 0)
node guard/guards.test.mjs                       → guard: PASS (2058 tracked files scanned)
```

Before this step: 89 files / 3838 tests; Node 112. +1 file, +55 Worker tests (all in `recipient.test.ts`), +8 Node tests. The three new files are untracked, so the guard does not scan them; they were searched by hand for the source system's earlier brand and its resale feature: no match.

## Review round 1 (the reviewer, 2026-09-28)

Read line by line: the migration, `recipient.ts`, every changed line of the Worker's source and of the client. The gate was run again by the reviewer: Worker 90 files, 3893 tests, 0 failed; 120 tests under Node; both builds; guard PASS. Nothing was changed by the review.

**Accepted deviations:** `src/api/checkout.js` (the client dropped the recipient without it); the older suites' bodies and the harness's pickup place; one name instead of two.

**Open, for Mikael (none blocks the staging deploy):**

1. **The checkout form has no telephone field.** The API takes one and the printer's job carries one, but nothing collects it. SnapWear's carrier may need it (the DPA names it). A field is a change of markup: decided with SnapWear's answer.
2. **The printer's address format is a guess** until SnapWear answers: field names, first and last name apart or not, telephone and e-mail required or not, and one parcel for an order of several lines (a job is sent per line, each with the address).
3. **A collected order's printed goods:** the job carries no address. Where SnapWear sends them (to the shop?) is not decided.
4. **The platform's order LIST now shows every order's name and address.** Asked for by the brief so the operator can see where an order goes; the list said before that it holds no personal data. Less would do (the single order only): Mikael's and Kent's to weigh under D68.
5. **A shipped order without a recipient is sent to the printer without an address.** It cannot arise through the checkout route (the recipient is required); it would take an order made before 0045, and none that is paid and waiting exists. A refusal in the dispatch would close it for good.
6. **Recipients of checkouts that were never paid stay in the table.** No purge exists (D68: how long, and who removes them).
7. **A pickup date that has passed** is taken while the shop still lists it.
