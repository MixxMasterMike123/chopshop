# CP9-RV: product reviews ("Recensioner") on Cloudflare

Design only, on branch `cf-port` at HEAD `932b9e1c`, tree clean at the start. Nothing else in the tree was edited. No git write, no network request, no deploy, no test or build run. Every claim about code cites the file and the lines I opened on 2026-10-05. Where I could not check something, the text says "not verified". **No rule of law is stated as fact.** A legal point is given with its source (the old code's comments or texts, a document of this repository, or the owner's notes in the brief) and is marked "not verified"; each one comes back as a decision in §11. The closest model is the abandoned-checkout reminder, `CP9_AC_REPORT.md` (design, build log and deviations), and its code; this design reuses its patterns and says where reviews differ.

## Design (phase 1)

### 0. Read this first

**What exists on Cloudflare: the inputs, not the feature.** A paid order has the buyer's address (`orders.customer_email`, `migrations/0011_orders.sql:75`), a frozen consent with a `marketing` box (`0031_legal_consent.sql:143-158`; copied verbatim from the checkout, `src/legal/consent.ts:273-285`), and its lines (`order_items`, `0011:219-238`). Every fulfilment change of an order, the seller's and the printer's automatic "shipped", writes an append-only history row with `track = 'fulfilment'` (`0046_order_fulfilment.sql:79-121`; `src/commerce/fulfilment.ts:390-488`, `:563-674`). One cron runs every 15 minutes (`src/outbox/scheduled.ts:22`, `:141`). Mail goes through the outbox, the queue and the ledger. The feature key `productReviews` is allowed (`platform/tenant-config.ts:112-119`) and is default ON (`:152-164`), but the storefront and the admin report it off (D81). There is no review table, no route, no page and no mail kind. The storefront's review block is a stub that renders nothing (`src/storefront/replacements/ProductReviews.jsx:1-10`).

**The shape of the port.**
- A review is a row of a new table `product_reviews`: one per product per paid order, written only through the link of that order's review request. The aggregate is computed at read time; no counter is stored, so nothing can drift.
- A cron step decides once per fulfilled order: queue a request, or skip it with a recorded reason (the reminder's `checkout_reminders` pattern, `migrations/0056_checkout_reminders.sql`). A queued request is an outbox row in the same batch; its effect builds one mail of a new ledger kind, `review_request`.
- The mail's links are HMAC tokens derived from an existing secret, so nothing secret is stored (the reminder's pattern, `commerce/checkout-recovery-token.ts:4-29`).
- Three public token routes: resolve (the order's products, nothing personal), submit, unsubscribe. One public read: a product's published reviews. The product reads gain the average and count.
- The shop admin moderates (publish, hide). The platform can remove an unlawful review (final).
- The storefront shows the block, the stars on cards, a statement of how reviews are verified, and `AggregateRating` structured data, only for published reviews and only while the platform's add-on is on.

**What is changed from Firebase, one line each:**
- The request needs consent: a new checkout box OR the marketing box (RV4; Firebase asked no consent).
- Only orders sent after the seller turned requests on are asked; Firebase would mail every buyer of up to 180 days back once the add-on came on (F4).
- The review link and the unsubscribe link are different tokens; Firebase used one token, so the unsubscribe URL in a mail header could also post a review (F1).
- One-click unsubscribe works without JavaScript (F2), and the unsubscribe page tells the truth (F3).
- Reviews show only while the add-on is on (Firebase showed them regardless, F7).
- No counter on the product: the average is computed from the rows, so approve, hide and remove cannot drift it.

**Two units, not one** (§10.0). RV-A: the reviews themselves, their public reads, the storefront display and moderation (no mail). RV-B: the request mails, the checkout box, the review page and unsubscribe. Together the work is about 1.8 times the reminder unit.

**Migration numbers.** The next free number is 0057 (`ls cloudflare/migrations`: the last is `0056_checkout_reminders.sql`; `src/app.ts:503`). The DAC7 design also plans 0057 and 0058 and its own rebuild of `email_deliveries` (`CP9_DAC7_REPORT.md:16-17`, `:503-505`). Each builder takes the next free number at build time; this text calls the two files `00NA_product_reviews.sql` (RV-A) and `00NB_review_requests.sql` (RV-B).

### 1. The old behaviour (Firebase), and what is ported, changed or dropped

#### 1.1 What the old code does

| Rule | Old behaviour | Evidence |
|---|---|---|
| Where a request is born | A Firestore trigger on `orders/{id}` updates. B2C orders only. On the first move into `shipped`, `delivered` or `ready_for_pickup` it writes ONE `reviewRequests/{orderId}` with `create()` (doc id = order id, so a second move or a retry is a no-op). | `functions/src/product-reviews/writeReviewRequest.ts:20-22`, `:45-72`, `:128-151` |
| What it stores | `shopId`, `orderId`, `emailNorm`, `customerEmail`, `customerFirstName`, `language` (`preferredLang` or `sv-SE`), the distinct products of the order (`productId`, `sku`, a flattened name ≤ 200, an image URL), a RAW 32-byte token, `dueAt`, `expiresAt` (180 days), `status: 'scheduled'`, `qualifyingStatus`. It skips an order without shop or address, or without a product. | `writeReviewRequest.ts:74-105`, `:122-147`; `tokens.ts:5-9`, `:19-21` |
| Delay | `shops/{id}.productReviews.requestDelayDays`, rounded, clamped 3–21, default 7, read when the request is written; a read error falls back to 7. | `writeReviewRequest.ts:24-26`, `:107-120` |
| The add-on at write time | Not checked: a request is written for every B2C order, add-on on or off. | the whole trigger, `writeReviewRequest.ts:45-166` |
| Consent | None. The checkout of the old build shows no review text (searched `git show main:src/pages/shop/Checkout.jsx` for `omdöm`, `recens`, `review`: no hit). The sweep checks no consent. | `sweep.ts:118-158` |
| The sweep | Every 60 minutes, up to 50 `scheduled` requests with `dueAt <= now`, each in its own try/catch. | `sweep.ts:21`, `:52-59`, `:91-103`, `:108-209` |
| Checks, in order | invalid doc → expired (180 days) → the add-on (`isShopFeatureEnabled`, default ON, fails OPEN on a read error) → suppression `reviewSuppressions/{shopId}_{sha256(email)}` → the order is missing, `cancelled` or `refunded`. Each skip writes `status` and `suppressionReason`. A partially refunded order is asked. | `sweep.ts:118-158`; `functions/src/config/shopFeatures.ts:21`, `:33-48` |
| Send | Marked `sent` BEFORE sending (at most once). A transport failure reverts to `scheduled`. Mail type `REVIEW_REQUEST`. | `sweep.ts:160-202` |
| Links | `{B2C_SHOP}/{shopId}/recensera/{token}` and `{B2C_SHOP}/{shopId}/avregistrera-recensioner/{token}`: the SAME token. | `sweep.ts:24-32`, `:183-184` |
| The mail | Shop-branded, Swedish or English. Subject "Hej {förnamn}, vad tyckte du om ditt köp hos {brand}?" or "Vad tyckte du om ditt köp hos {brand}?". Product rows with images, no amounts. Button "Lämna ett omdöme". Footer link "Avregistrera dig från recensionsförfrågningar". From `"{shop}" <platform address>`, Reply-To the shop's support address. `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` pointing at the unsubscribe PAGE. | `functions/src/email-orchestrator/templates/reviewRequest.ts:50-117`; `EmailOrchestrator.ts:316-333`, `:857-871`, `:881-896` |
| Retention | Sent, expired and skipped requests deleted after 200 days (up to 400 per run). | `sweep.ts:22`, `:63-88` |
| Resolve | `resolveReviewRequest({shopId, token})`, public: equality query on shop + raw token. Unknown → `invalid`; past `expiresAt` → `expired`; else `open` with `items {productId, name, image}` and `reviewedProductIds`. No personal data. No rate limit, no add-on check. | `functions/src/product-reviews/callables.ts:37-42`, `:64-72`, `:78-116` |
| Submit | `submitReview`, public. Size caps first; `rating` an integer 1–5; the request found and not expired; the product among the request's items; text ≤ 2000 and name ≤ 60 with EVERY control character removed (line breaks too); `anonymous` or an empty name → "Anonym". The filter's verdict: flagged → `pending`, clean → `approved`. In a transaction on doc id `{orderId}_{productId}`: an existing one → `already-exists`. The row: `shopId, productId, orderId, rating, text, displayName, emailHash, verified: true, status, flaggedReasons?, createdAt`. When approved, `products/{id}` gains `reviewCount + 1`, `ratingSum + rating` (`merge: true`). No add-on check. | `callables.ts:44-61`, `:122-203` |
| Content filter | A link (`http(s)://` or `www.`), an e-mail address, or one of 14 words (sv + en) → flagged. Empty text is clean. It never rejects; its header says over-filtering negative reviews "is legally prohibited under the Omnibus/consumer rules" (the old code's claim, not verified). | `functions/src/product-reviews/contentFilter.ts:1-36` |
| Unsubscribe | `unsubscribeReviews`, public. Unknown token → `{ success: true }`. Writes `reviewSuppressions/{shopId}_{hash}` `{shopId, emailHash, createdAt, source}`; a write failure is swallowed and answered as success. | `callables.ts:209-243`; `tokens.ts:24-31` |
| Moderate | `moderateReview({reviewId, action: approve|reject})`: an admin of the REVIEW's shop (from the resource). In a transaction; the aggregate moves only on a real status change. Stamps `moderatedAt`, `moderatedBy`. No audit row. | `callables.ts:251-320` |
| Admin page | `/admin/reviews` behind `AddonGate feature="productReviews"`. Reads all `productReviews` and `products` of the shop through the client SDK. Filters Alla / Publicerade / Väntande / Avpublicerade; metrics Antal omdömen / Snittbetyg / Väntande; columns product, stars, name, text, status, date; buttons Godkänn / Avpublicera; a note "Enligt lag måste moderering vara enhetlig — negativa omdömen får inte döljas selektivt." **No reply, no export, no order number, no address.** | `src/App.jsx:622-629`; `src/pages/admin/AdminReviews.jsx:17-22`, `:65-90`, `:92-105`, `:112-132`, `:134-199`, `:222-235` |
| Admin settings | Inställningar, card "Recensioner" while the add-on is on: one field "Dagar efter leverans innan förfrågan skickas", 3–21, default 7. | `src/pages/admin/AdminSettings.jsx:83`, `:94-98`, `:189-214`, `:1110-1144`; `src/config/shopConfig.js:138-171` |
| Rules | `productReviews` readable when `approved`, or by an admin of its shop; no client write. Requests and suppressions: no client access. | `firestore.rules:854-873` |
| Product page | The native block renders when `product.reviewCount > 0`, with NO add-on check; otherwise the Trustpilot section when a Trustpilot domain is set. | `src/pages/shop/PublicProductPage.jsx:861-878` |
| The block | Average and count from the product's `reviewCount` / `ratingSum`; the statement "Alla omdömen kommer från verifierade köp — kunder får en personlig länk via e-post efter genomfört köp. Vi publicerar både positiva och negativa omdömen."; approved reviews of the shop and product, newest first, 10 per page, "Visa fler"; each with stars, date (`sv-SE`), name or "Anonym", text. | `src/components/shop/ProductReviews.jsx:14-23`, `:54-75`, `:113-186` |
| Cards | Rounded stars and the count when `reviewCount > 0`. | `src/components/shop/NordProductCard.jsx:77-78`, `:146-153` |
| Structured data | The product's JSON-LD (rendered by Helmet) gains `aggregateRating { "@type": "AggregateRating", ratingValue: (ratingSum / reviewCount).toFixed(1), reviewCount }` when `reviewCount > 0`. No `Review` items. | `src/utils/productFeed.js:91-98`; `PublicProductPage.jsx:509-522` |
| Review pages | `/{shopId}/recensera/:token` and `/{shopId}/avregistrera-recensioner/:token`, inside `ShopGate`, no `AddonGate` ("the link must resolve even if the add-on was later disabled"). Invalid → silent redirect to the shop's home; expired → a panel; open → one form per product (stars, optional text ≤ 2000, name ≤ 60, "Visa som anonym"), each sent on its own. The unsubscribe page shows "Du är avregistrerad" whatever the answer. | `src/App.jsx:375-380`; `src/pages/shop/ReviewSubmitPage.jsx:10-22`, `:58-133`, `:202-310`; `src/pages/shop/ReviewUnsubscribePage.jsx:10-43` |
| Not native reviews | `ReviewsSection.jsx` and `csvReviews.js` are the legacy Trustpilot section (a scraped CSV); every CSV row is marked `verified: true` and a missing rating reads as 5. On Cloudflare the alias list already replaces them with an empty list. | `src/components/ReviewsSection.jsx:7-14`, `:163-167`; `src/utils/csvReviews.js:16-50`; `src/storefront/replacements/trustpilotAPI.js:1-35`; `vite.storefront.config.js:66-67` |
| Production data | 0 `productReviews`, 0 `reviewRequests`, 0 `reviewSuppressions` at the 2026-09-27 export. `features.productReviews`: robowatz `true`, melodie-mc `false`, gif-sundsvall, ninetone and sillmans absent (so ON in Firebase). No shop holds `productReviews.requestDelayDays`. | `docs/cf-port/MIGRATION_MANIFEST.md:44`, `:104`, `:108-109`; `~/chopshop-export/export-2026-09-27T15-02-15.414Z/shops/part-00001.jsonl` (read the two fields per shop) |

#### 1.2 The owner's notes, checked against the code

| Note | What the code does | Verdict |
|---|---|---|
| Only verified buyers can review | A review can only be written with the token of a request, which exists only for a paid B2C order that reached a fulfilled status, and only for a product of that order (`writeReviewRequest.ts:57-63`; `callables.ts:145-156`). Every row is stored `verified: true` (`callables.ts:183`). There is no form on the product page. | Verified in the code. "Verified" means: someone who can read the order's mailbox. |
| The display follows the EU "Omnibus" rule (say how reviews are ensured to come from real buyers) | The block carries the statement quoted in §1.1 (`ProductReviews.jsx:134-140`). | The text exists. **That the rule requires it, and that this text satisfies it: the owner's note, not verified.** |
| The request went out 7 days after delivery | The clock starts at the order's first move into `shipped`, `delivered` or `ready_for_pickup` (`writeReviewRequest.ts:22`, `:60-63`), default 7 days (`:24`). So: 7 days after it was SENT or made ready for pickup, not after delivery. The admin text "Dagar efter leverans" (`AdminSettings.jsx:1121`) and the add-on description "efter leverans" (`src/config/addons.js:34`) are therefore inexact. | Partly. |
| Reviews carried JSON-LD | Only `aggregateRating` on the Product, client-side through Helmet (`productFeed.js:91-98`). No `Review` items. | Partly. |

#### 1.3 What exists on Cloudflare today

| Piece | Where | State |
|---|---|---|
| Orders, lines, the money status, `cancelled_at`, refunds | `migrations/0011_orders.sql:35-140`, `:219-238`; `0022_dispatch_state.sql:68`; `0019_money.sql:364-386`; the open-order rule `src/commerce/fulfilment.ts:212-216` (`openSql`) | Built. |
| Fulfilment, two columns two owners | `orders.fulfilment_status` (`0046:50-53`); transitions `unfulfilled → processing | shipped | ready_for_pickup`, `shipped → shipped | delivered | completed`, `ready_for_pickup → delivered | completed`, nothing back (`fulfilment.ts:16-24`, `:83-90`); every change writes `order_status_history` with `track 'fulfilment'` and `created_at` in ms (`fulfilment.ts:390-413`; `0011:317-355`; `0046:79-121`). | Built. |
| The printer's "shipped" | The platform records a POD line's state (`src/dispatch/production-status.ts:5-73`). When the last printer line of an all-printer PARCEL order ships, the same batch records the ORDER `shipped` with a fulfilment history row and the buyer's status mail (`fulfilment.ts:49-57`, `:563-674`). A mixed order waits for the seller, who cannot ship it before the printer lines left (`fulfilment.ts:32-47`, `:186-188`). | Built. |
| Withdrawals (ångerrätt) | `withdrawals`, one per order, `eligible` 0/1, the withdrawn line indexes (`0044_withdrawals.sql:60-90`) | Built. |
| Consent frozen on the order | `orders.consent_json` = the checkout's verbatim (`consent.ts:273-285`); keys `marketing`, `reminder` (CP9-AC), `terms`, `withdrawal` (`consent.ts:24-34`, `:75`) | Built. No review fact. |
| The recipient's name | `order_recipients.name` (`0045_order_recipients.sql:126-131`) | Built. |
| Mail, ledger, consumer, the reminder kind | `email_deliveries.kind` is a CHECK (`0056:207-215`); the consumer gives the reminder kind, and only it, the shop's name as sender, the Reply-To, the two List-Unsubscribe headers, and a last suppression check (`src/email/email-queue-consumer.ts:153-176`, `:258-267`) | Built for reminders. |
| No mail account on staging | The consumer holds every batch (`email-queue-consumer.ts:321-332`); the queue drops it after its retries, about 40 minutes (`CP9_AC_REPORT.md:1152`, Deviation 12) | As AC. |
| Public product reads | `GET /v1/products`, `GET /v1/products/:ref` (`src/routes/public-products.ts:84-110`), shapes `PublicProductSummary` / `PublicProductDetail` (`src/catalog/public-catalog.ts:53-111`), ETag `"<catalog_version>"` with no body revision (`public-products.ts:96`, `:109`; `src/storefront/public-routes.ts:84-108`). Collections embed the same summaries (`src/catalog/collections.ts:1214`, `:1282`; `src/routes/public-collections.ts:154`, `:186`). | Built. |
| catalog_version | Bumped by trigger in the very statement that changes a public input (`0025_takedown_catalog_version.sql:12-20`, `:46-142`; `0043_storefront.sql:115-165`). | Built. |
| SEO and structured data | `GET /v1/seo` builds a Product JSON-LD (`src/storefront/seo.ts:785-868`); the web Worker writes it into the head through `jsonForScript` (`cloudflare/web/src/html.ts:23-30`, `:52-85`). No `aggregateRating`. The client also renders its own Product JSON-LD through Helmet (`PublicProductPage.jsx:521`; `src/storefront/replacements/productFeed.js:49-57`). | Built. |
| Content screening | A pure matcher with `foldText` / `tokenize` (diacritics folded, word boundaries by spaces) (`src/catalog/screening-core.ts:35-45`), fed a platform blocklist of IP terms. | Built; the folding is reusable, the blocklist is not (it is about trademarks). |
| Feature key | `productReviews` allowed, default ON (`tenant-config.ts:112-119`, `:152-164`); not in `PORTED_FEATURE_KEYS` (`src/storefront/public-storefront.ts:55`), so the storefront and the admin read false (`public-storefront.ts:132-145`; `src/routes/admin-session.ts:108-122`). | §9. |
| Storefront | `ProductReviews` is a stub (`src/storefront/replacements/ProductReviews.jsx:1-10`; alias `vite.storefront.config.js:68-69`); the adapter carries no `reviewCount` (`src/storefront/adapters/adapters.test.mjs:135-139`); no `/recensera` route (`src/storefront/StorefrontApp.jsx:18-38`). The two old pages and `AdminReviews.jsx` still import Firebase (`guard/allowlist.txt:165`, `:202`, `:245-246`). | Nothing. |
| Admin | No `/admin/reviews` route (`src/admin-app/AdminApp.jsx:30-51`); the nav item exists, gated on the feature (`src/components/layout/AppLayout.jsx:255-263`, `:484-491`); `loadReviewSettings` answers `{}`, `saveReviewSettings` refuses (`src/admin-app/replacements/shopConfig.js:219-223`). | Nothing. |
| Importer | Product `reviewCount` / `ratingSum` are not carried (`scripts/cf-port/migrate/lib/transform-products.mjs:46-48`). No order history is imported (no file under `scripts/cf-port/migrate/lib/` names `order_status_history`; searched). | §3.7. |

#### 1.4 Ported, changed, dropped

| Rule | Fate | Reason |
|---|---|---|
| Verified buyers only, by a mailed per-order link; one review per product per order; the request once per order; delay 3–21 days default 7, counted from the first sent / ready-for-pickup; skip a cancelled or fully refunded order; per-shop suppression keyed by the address hash; auto-publish clean, hold flagged; the 14-word filter that never rejects; seller publish / hide; newest first, 10 a page; the statement under the block; stars on cards; `AggregateRating` | **Ported** | The behaviour. |
| Consent for the request | **Changed** (RV4): the new box OR the marketing box | Firebase asked none; the reminder's rule (AC4) applies the same reasoning. Legal, not verified. |
| Which orders are asked | **Changed** (RV3): only orders first sent after the seller turned requests on, never more than 7 days late | Firebase wrote requests while the add-on was off and sent them when it came on, up to 180 days back (F4). |
| Where the decision lives | **Changed**: a table `review_requests`, one row per order | Orders carry money-immutable triggers; a separate table touches nothing of the order (the reminder's §3.1 reasoning). |
| The tokens | **Changed**: HMAC-derived, never stored; a `review` purpose and an `unsubscribe` purpose | One shared raw token made the header URL a write capability (F1). |
| The aggregate | **Changed**: computed from the rows at read time | No counter to drift; Firebase's `merge: true` could also create a stub product doc for a deleted product (F9). |
| Moderation states | **Changed**: `pending`, `published`, `hidden`, plus `removed` (platform, final) | The platform's takedown needs a state the seller cannot undo. |
| A title | **Added** (RV11), optional | `schema.org` and the brief ask for it; cheap. |
| Line breaks in the text | **Changed**: kept | Firebase stripped every control character, line breaks included (`callables.ts:59-61`), so `whitespace-pre-line` (`ProductReviews.jsx:162`) never mattered (F8). |
| The filter's reach | **Changed**: title and displayed name screened too | Firebase screened the text only (`callables.ts:162`). |
| Withdrawal | **Added** (RV7): no request for an order with an accepted withdrawal | Not in Firebase (it had no withdrawal records). |
| Display while the add-on is off | **Dropped** (RV17) | Firebase kept showing reviews (F7). |
| English mail | **Dropped** | Every Cloudflare buyer mail is Swedish (`CP9_AC_REPORT.md:85`, AC16). |
| Images in the mail | **Dropped** | No Cloudflare mail carries one (`CP9_AC_REPORT.md:568`). |
| Fail-open add-on read | **Dropped** | `isFeatureEnabled` does not fail open (`tenant-config.ts:179-207`). |
| The 200-day purge of requests | **Not ported** | Retention is D68's question (as the reminder's R10). |
| The Trustpilot CSV section | **Not ported** (already replaced by an empty list) | It is not native reviews; its "verified" badge is unbacked (F10). |

### 2. Who may review what

#### 2.1 The proof that a reviewer bought the product

There are no customer accounts on Cloudflare (D81, `DECISIONS.md:113`): every buyer is a guest, and the mailbox of the order is the only identity. The chain is:

1. **An order exists only as the assertion that money moved.** The Stripe webhook is its only writer (`0011:4-10`).
2. **A request exists only for a fulfilled, open order**: the cron step queues one only after the order's first fulfilment history row (§4) and only when the order is not cancelled or refunded in full (`openSql`, `fulfilment.ts:212-216`).
3. **The link goes only to the order's own address** (`orders.customer_email`), in one mail.
4. **The token is an HMAC over (purpose, tenant, request id)** (§2.2). It binds the request; the request binds the order (`review_requests.order_id`, UNIQUE); the order binds its lines.
5. **A review names one product of that order's lines**: the submit route checks it, and a trigger refuses a row whose product is not a line of its order in its tenant (§3.2).
6. **At most one review per product per order**: `UNIQUE (order_id, product_id)` on `product_reviews`. Two lines of the same product with different variants make one review (Firebase deduplicated by product, `writeReviewRequest.ts:86-92`).

There is no other way to write a review: no form on the product page, no admin "add review", no import (0 Firebase reviews, §3.7).

#### 2.2 The token

The reminder's construction (`commerce/checkout-recovery-token.ts:4-29`, `:59-138`) with its own key and message:

```
key      = HKDF-SHA-256(BETTER_AUTH_SECRET, salt "chopshop/review-link", info "review-link/v1") → HMAC-SHA-256
message  = "review-link/v1\n<purpose>\n<tenantId>\n<requestId>"      purpose ∈ { "review", "unsubscribe" }
token    = "v1." + <requestId> + "." + base64url(HMAC(key, message))  (83 characters, the recovery pattern)
```

- **Nothing secret is stored.** The request id alone opens nothing. The mail effect re-derives the same links on every retry (the ledger's fingerprint).
- **The tenant is inside the signed message**: a token of shop A on shop B's host is a wrong signature.
- **The purpose is inside the signed message**: the unsubscribe link (which travels in a header to mail providers) cannot post a review (F1), nor the review link unsubscribe.
- **The order id never appears in a link.**
- **Implementation.** Extract the HKDF-and-HMAC core of `checkout-recovery-token.ts` into `cloudflare/src/lib/signed-link.ts`, called by both modules with their own salt, info and purposes. First add a golden test that pins a reminder token minted with a fixed test secret, so the refactor provably leaves every mailed reminder link valid. (The alternative is a copy of the 100-line module; the reviewer chooses.)
- **Without `BETTER_AUTH_SECRET`** (`isAuthConfigured`) nothing is minted or verified: the cron step does nothing and the routes answer the opaque 404.
- **Rotating the secret ends every review link already mailed**, 180-day links included (R2; RV10).

#### 2.3 Lifetime and single use

- **The review link** works until `link_expires_at` = the decision + 180 days (Firebase's 180 days counted from the qualifying move, `writeReviewRequest.ts:27`, `:124`; here from the mail). RV10.
- **The unsubscribe link** never expires (the reminder's AC11).
- **Single use per order and product**, not per link: one link serves every product of the order, each once (UNIQUE). A review is final: no edit, no delete by the buyer (RV11).
- A request that was `skipped` or `withdrawn` never had a mail, so its tokens answer 404.

#### 2.4 Refund, cancellation, withdrawal

| Event | Effect on the request | Effect on an existing review |
|---|---|---|
| Cancelled, or refunded to its charge, before the decision | `skipped / order_closed` (`openSql`, `fulfilment.ts:212-216`, as Firebase `sweep.ts:150-158`) | none exists |
| The same between the decision and the mail | the effect withdraws it (`withdrawn / order_closed`), no mail | none exists |
| A partial refund | asked (Firebase too) | stays |
| An accepted withdrawal (`withdrawals.eligible = 1`) before the decision or the mail | `skipped` or `withdrawn` with `order_withdrawn` (RV7) | — |
| Any of these AFTER the mail | the link keeps working: resolve and submit do not re-check the order's money state (RV8) | **stays published** (RV8). Hiding the reviews of refunded orders would remove mostly dissatisfied buyers' reviews: the legal side of that (selective suppression) is the old code's own concern (`contentFilter.ts:5-7`), not verified. |

#### 2.5 Consent for the request mail (legal, not verified)

Firebase sent a request to every buyer of a fulfilled order, with an unsubscribe link and header, and asked no consent (§1.1). Whether a review request is direct marketing under MFL 19 §, and whether the existing-customer exception (19 § second paragraph) covers it, are **not verified**; that exception, as the AC report records the owner's reading, needs the buyer to have been given a clear chance to object when the address was collected (`CP9_AC_REPORT.md:54`), and the Cloudflare checkout says nothing about review mails. **Recommended (RV4): the reminder's rule.** A request is sent only when the order's frozen consent says `reviewRequest: true` OR `marketing: true`.

**The box.** On the checkout's contact step, beside the reminder box (`src/pages/shop/Checkout.jsx:542-560`), pre-unticked, shown only while `useShopFeatures().isEnabled('productReviews')`, which in the storefront is true only while the platform's add-on AND the seller's request switch are on (§9.2).
- Label, key `checkout_review_request`: "Be mig om ett omdöme via e-post efter leveransen"
- Line under it, key `checkout_review_request_help`: "Ett mejl från {{shop}} några dagar efter leveransen. Du kan avregistrera dig i mejlet."
- Code fallbacks under their keys: `src/locales/*.json` is generated by the importer and must not be edited by hand (`CP9_AC_REPORT.md:1144`, Deviation 4).

**The request.** `buildCheckoutRequest` (`src/storefront/adapters/checkout.js:84-106`) sets `consent.reviewRequest = true` only for a literal `true`, and the checkout passes `reviewsOn && ticked` (as `Checkout.jsx:875` does for the reminder). A request without the tick is byte for byte today's, so the payment form's request key and every idempotency fingerprint are unchanged.

**The server** (`src/legal/consent.ts`): `CONSENT_KEYS` gains `reviewRequest` (`:75`); the parse accepts an optional boolean; `freezeConsent` writes `reviewRequest: true` only when ticked; `readFrozenConsent` accepts it only as `true`; a new `reviewRequestConsentGiven(json)` beside `reminderConsentGiven` (`:243-246`): the order's own frozen consent, `reviewRequest === true || marketing === true`; null, unreadable, terms-only and the waiver are no consent. The webhook already copies the consent verbatim to the order (`consent.ts:273-285`), so the cron step reads `orders.consent_json`. An order made before the box exists has no `reviewRequest` key: only its marketing box counts.

**The alternatives** (RV4): (a) Firebase's: every buyer; (b) every buyer, after a line at checkout ("Vi kan be dig om ett omdöme via e-post efter leveransen.") with a box to refuse. Both are one function and one component away from the recommended shape: a frozen consent can only gain keys.

### 3. Data model

#### 3.1 Tables beside the order, not columns on it

`orders` carries money-immutable triggers and is the money path's record (`0011:4-34`; `0046:4-19`); a review request or a review has no business there. Each rule becomes a UNIQUE, a CHECK or a trigger on a table of its own, as 0055 and 0056 did. Time is INTEGER epoch milliseconds, as `orders`, `order_status_history` and 0056.

#### 3.2 Migration RV-A: `00NA_product_reviews.sql`

Point `REQUIRED_MIGRATION` (`src/app.ts:503`) at it and update the two tests that pin it (`test/health.test.ts`, `test/public-catalog.test.ts`; `CP9_AC_REPORT.md:1113`).

```sql
PRAGMA foreign_keys = ON;

-- 00NA — Recensioner on Cloudflare, part A (CP9-RV): the reviews.
-- A review is a buyer's rating of ONE product of ONE paid order, written only
-- through the link of that order's review request (part B,
-- docs/cf-port/CP9_RV_REPORT.md). No address is stored: the order holds it.
-- The average is computed from these rows at read time; nothing counts.

CREATE TABLE product_reviews (
  review_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(review_id) = 36 AND review_id NOT GLOB '*[^0-9a-f-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The proof of purchase. Internal: never in a public or seller answer.
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  rating INTEGER NOT NULL CHECK (typeof(rating) = 'integer' AND rating BETWEEN 1 AND 5),
  title TEXT CHECK (title IS NULL OR (
    length(title) BETWEEN 1 AND 100 AND instr(title, char(10)) = 0 AND instr(title, char(13)) = 0
  )),
  body TEXT CHECK (body IS NULL OR length(body) BETWEEN 1 AND 2000),
  -- What the buyer chose to show. NULL = shown as "Anonym". Never an address.
  display_name TEXT CHECK (display_name IS NULL OR (
    length(display_name) BETWEEN 1 AND 60
    AND instr(display_name, char(10)) = 0 AND instr(display_name, char(13)) = 0
  )),
  -- The filter's reasons at submission: a JSON array of 'link' | 'email' | 'word'.
  flags_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(flags_json) AND json_type(flags_json) = 'array' AND length(flags_json) <= 64
  ),
  -- pending    waits for the seller (flagged, or the shop moderates first)
  -- published  shown on the storefront and counted
  -- hidden     the seller took it down; may be published again
  -- removed    the platform took it down (unlawful content); final
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'hidden', 'removed')),
  removed_reason TEXT CHECK (removed_reason IS NULL OR length(removed_reason) BETWEEN 1 AND 500),
  submitted_at INTEGER NOT NULL,
  moderated_at INTEGER,
  moderated_by TEXT CHECK (moderated_by IS NULL OR length(moderated_by) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  -- One review per product per order (Firebase: doc id {orderId}_{productId}).
  UNIQUE (order_id, product_id),
  CHECK ((state = 'removed') = (removed_reason IS NOT NULL))
);

-- The product is a line of the order, and all three are the review's tenant.
CREATE TRIGGER product_reviews_match_order
BEFORE INSERT ON product_reviews
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM order_items AS line
  WHERE line.order_id = NEW.order_id
    AND line.tenant_id = NEW.tenant_id
    AND line.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'a review names a product of its own order and tenant');
END;

CREATE TRIGGER product_reviews_born
BEFORE INSERT ON product_reviews
FOR EACH ROW
WHEN NEW.state NOT IN ('pending', 'published') OR NEW.moderated_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a review is born pending or published');
END;

-- What the buyer wrote is evidence: frozen.
CREATE TRIGGER product_reviews_frozen
BEFORE UPDATE ON product_reviews
FOR EACH ROW
WHEN NEW.review_id IS NOT OLD.review_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.rating IS NOT OLD.rating
  OR NEW.title IS NOT OLD.title
  OR NEW.body IS NOT OLD.body
  OR NEW.display_name IS NOT OLD.display_name
  OR NEW.flags_json IS NOT OLD.flags_json
  OR NEW.submitted_at IS NOT OLD.submitted_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'a review''s content is frozen');
END;

-- pending → published | hidden | removed; published → hidden | removed;
-- hidden → published | removed; removed → nothing.
CREATE TRIGGER product_reviews_transition
BEFORE UPDATE OF state ON product_reviews
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state AND NOT (
     (OLD.state = 'pending'   AND NEW.state IN ('published', 'hidden', 'removed'))
  OR (OLD.state = 'published' AND NEW.state IN ('hidden', 'removed'))
  OR (OLD.state = 'hidden'    AND NEW.state IN ('published', 'removed'))
)
BEGIN
  SELECT RAISE(ABORT, 'review state transition is not allowed');
END;

CREATE TRIGGER product_reviews_no_delete
BEFORE DELETE ON product_reviews
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'reviews are hidden or removed, never deleted');
END;

-- The public product reads and the review list are built from these rows, so
-- every insert and every state change bumps the shop's catalog_version in the
-- same statement (0025's rule: over-bumping costs a cache miss, under-bumping
-- a stale 304).
CREATE TRIGGER catalog_version_product_reviews_insert
AFTER INSERT ON product_reviews
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_product_reviews_state
AFTER UPDATE OF state ON product_reviews
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

-- The public list and the per-product aggregate; the seller's list.
CREATE INDEX product_reviews_public_idx
  ON product_reviews(tenant_id, product_id, state, submitted_at DESC, review_id DESC);
CREATE INDEX product_reviews_tenant_state_idx
  ON product_reviews(tenant_id, state, submitted_at DESC, review_id DESC);
```

Not here, deliberately: no `request_id` column (the request proves the order, the order proves the line; one link per order); no address hash (the order holds the address, and D68's erasure will start from the order).

#### 3.3 Migration RV-B: `00NB_review_requests.sql`

```sql
PRAGMA foreign_keys = ON;

-- 00NB — Recensioner on Cloudflare, part B (CP9-RV): the request mail.

-- ── 1. The seller's settings ────────────────────────────────────────────────
CREATE TABLE review_settings (
  tenant_id TEXT PRIMARY KEY NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  requests_enabled INTEGER NOT NULL CHECK (requests_enabled IN (0, 1)),
  -- When the switch was last turned ON. Only an order whose FIRST fulfilment
  -- row is at or after it is ever asked (RV3). Kept when turned off.
  requests_enabled_at INTEGER CHECK (requests_enabled_at IS NULL OR requests_enabled_at > 0),
  delay_days INTEGER NOT NULL DEFAULT 7 CHECK (delay_days BETWEEN 3 AND 21),
  -- auto: a review the filter finds clean is published at once (Firebase);
  -- manual: every review waits for the seller (RV12).
  moderation TEXT NOT NULL DEFAULT 'auto' CHECK (moderation IN ('auto', 'manual')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  CHECK (requests_enabled = 0 OR requests_enabled_at IS NOT NULL)
);
-- + review_settings_tenant_immutable, review_settings_no_delete, and
--   catalog_version_review_settings_insert / _update, each exactly as 0056's
--   checkout_reminder_settings triggers (0056:34-64): GET /v1/storefront's
--   features.productReviews reads requests_enabled.

-- ── 2. One decision per order ───────────────────────────────────────────────
CREATE TABLE review_requests (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (length(request_id) = 36 AND request_id NOT GLOB '*[^0-9a-f-]*'),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- sha256 hex of the order's address, trimmed and lower-cased: the ledger's
  -- recipient_hash and Firebase's emailHash (tokens.ts:24-26). The unsubscribe
  -- route keys the suppression on it.
  buyer_hash TEXT NOT NULL CHECK (length(buyer_hash) = 64 AND buyer_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'skipped', 'withdrawn')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'order_closed', 'feature_off', 'switch_off', 'shop_closed', 'no_consent',
    'undeliverable', 'unsubscribed', 'order_withdrawn', 'nothing_to_review'
  )),
  -- The order's first fulfilment history row (§4.1): the clock.
  qualified_at INTEGER NOT NULL,
  decided_at INTEGER NOT NULL CHECK (decided_at >= qualified_at),
  -- decided_at + 180 days; NULL on a skipped row (no link was ever made).
  link_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((state = 'queued') = (reason IS NULL)),
  CHECK ((state = 'skipped') = (link_expires_at IS NULL)),
  CHECK (link_expires_at IS NULL OR link_expires_at > decided_at)
);
-- + review_requests_match_order (the tenant is the order's), review_requests_born
--   (queued | skipped), review_requests_transition (only queued → withdrawn with
--   a reason; every other column frozen), review_requests_no_delete: 0056's
--   checkout_reminders triggers (0056:100-122, :139-160; not its cap, 0056:124-137) with the names changed. No cap
--   trigger: one request per order is the UNIQUE (RV9).
CREATE INDEX review_requests_tenant_decided_idx ON review_requests(tenant_id, state, decided_at);

-- ── 3. Addresses that unsubscribed from review requests, per shop ──────────
CREATE TABLE review_request_suppressions (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
  source TEXT NOT NULL CHECK (source IN ('unsubscribe', 'import')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email_hash)
);
-- + no UPDATE, no DELETE (0056:178-190). Separate from the reminders'
--   suppressions, as Firebase kept them (RV19).

-- ── 4. The cron step's candidate read ──────────────────────────────────────
CREATE INDEX order_status_history_fulfilment_idx
  ON order_status_history(created_at) WHERE track = 'fulfilment';

-- ── 5. email_deliveries: admit 'review_request' ─────────────────────────────
-- 0056's block 5 (0056:195-269) written out in full, the kind list gaining
-- 'review_request' and the copy named email_deliveries_migration_00NB. If
-- DAC7's mail migration lands first, start from its kind list (§0).
```

#### 3.4 The aggregate: computed, and why it cannot race

**One query per read**, on `product_reviews_public_idx`:

```sql
SELECT product_id, COUNT(*) AS n, SUM(rating) AS s
FROM product_reviews
WHERE tenant_id = ? AND state = 'published' AND product_id IN (…)
GROUP BY product_id
```

- **Always right.** Approve, hide, remove and a second moderation of the same review change only `state`. The count and sum are read from the rows as committed, so there is no increment to apply twice and no decrement to miss. Firebase needed a transaction with re-read deltas for this (`callables.ts:270-317`); here the problem does not exist.
- **Cheap at this scale.** A detail read reads one product; a list page at most 100 (`public-catalog.ts:157`), one indexed `GROUP BY`. If it ever matters, a stats table kept by triggers that recompute (not increment) the pair is the next step. Not now.
- **Where it is read.** In `loadParts` (`public-catalog.ts:300-325`) with the other per-page reads, only while the platform's add-on is on (§9.2). The shapes gain an optional member: `reviews?: { count: number; ratingSum: number }`, present only when the add-on is on AND the product has at least one published review. A shop with the add-on off, or a product with no published review, has the body it has today, byte for byte.

**The ETag** (§6.6): the review rows' triggers bump `catalog_version`; the product reads name a new body revision once.

#### 3.5 What personal data a review row holds

- **Shown publicly:** the rating, the optional title and text the buyer wrote, the displayed name the buyer chose (or "Anonym"), and the day it was written.
- **Held, never shown publicly:** `order_id` (the proof of purchase, through which the platform can find the buyer for an erasure request), the filter's flags, the moderation stamps (`moderated_by` is a user id; the seller's list shows only "Butiken" / "Plattformen").
- **Never held:** the address, a hash of it (the order has the address), the order number, the recipient's name.
- The text may contain personal data the buyer typed. The filter flags an e-mail address, and the form asks not to write one (§8.5).

#### 3.6 Tenant scoping

- Every read is by `(tenant_id, …)`.
- The public routes take the tenant from the hostname (`resolveRequestTenant` / `resolveStorefrontTenant`, as `routes/storefront-checkout-recovery.ts:89-92`), never from the request.
- The token's signature includes the tenant.
- The triggers refuse a review whose order, product and tenant disagree, and a request whose tenant is not its order's.
- The outbox row carries the tenant; the effect reads only that tenant's rows (`checkout-reminders.ts:754-777`).
- The seller's routes read the principal's tenant only; a review id of another shop is the same 404 as an unknown one.
- A suppression is per shop.

#### 3.7 Import from Firebase

- **`productReviews`, `reviewRequests`:** 0 documents at the freeze (`MIGRATION_MANIFEST.md:104`, `:108`); archived, not carried. If any appear before a later export, that is a new decision (an imported review would have no Cloudflare order to prove it).
- **`reviewSuppressions`:** 0 documents, "Restore before review mails return" (`MIGRATION_MANIFEST.md:109`). The importer gains one transform: `reviewSuppressions/{shopId}_{hash}` → `review_request_suppressions (tenant_id, email_hash, 'import', createdAt)`, refusing a hash that is not 64 hex characters or a shop not in the plan, with a test. The AC unit left the same transform for `checkoutSuppressions` unbuilt because it could not touch `scripts/cf-port/migrate/lib` (`CP9_AC_REPORT.md:1258`); whoever builds RV-B with that permission builds both.
- **Settings:** no shop holds `productReviews.requestDelayDays` (§1.1). Every shop starts with requests off (RV3).
- **Product aggregates:** not carried (`transform-products.mjs:46-48`); with 0 reviews there is nothing to carry.

### 4. When a request is due, and every reason it is not sent

#### 4.1 What "sent" and "delivered" mean here

Cloudflare has no carrier feed: it knows only what the seller, or the platform for the printer, records. **The clock is the order's FIRST fulfilment history row into `shipped`, `ready_for_pickup`, `delivered` or `completed`** (`order_status_history`, `track = 'fulfilment'`; `0046:79-121`):

- **A parcel order.** Every path to `delivered` or `completed` passes `shipped` (`fulfilment.ts:83-90`), so the clock is the first `shipped`. A second parcel (`shipped → shipped`, `fulfilment.ts:19-20`) does not restart it. "Delivered" is not observable unless the seller records it; the delay stands in for transport (Firebase did the same, §1.2).
- **A pickup order.** The clock is `ready_for_pickup` (Firebase's rule, `writeReviewRequest.ts:22`); `delivered` / `completed` after it change nothing. The alternative, counting from the handover, is RV6.
- **A print-on-demand line the printer shipped.** A line's own `production_state` is not the clock. An all-printer parcel order gets its order-level `shipped` row in the batch that records its last line shipped (`fulfilment.ts:563-674`); that row is the clock. A mixed order is shipped by the seller, who can do so only after every printer line left (`fulfilment.ts:186-188`). A POD pickup order's print goes to the shop and the seller makes it ready (`fulfilment.ts:32-46`). A partly shipped all-printer order has no order-level row yet, so it is not asked until the last line ships.
- **Orders imported from Firebase** have no fulfilment rows (the importer writes no history, §1.3), so they are never asked.

#### 4.2 Due

An order is **due** when all of these hold:
- its first fulfilment row is at or after `review_settings.requests_enabled_at` with `requests_enabled = 1`;
- that row's `created_at + delay_days × 1 day ≤ now`;
- no decision exists for the order.

It **stops being due**, never selected and no row written, once `now ≥ due + 7 days` (the late limit, RV6). The delay is read at decision time, so changing it affects orders not yet decided.

#### 4.3 The candidates

`runReviewRequests(env, now)` in a new `cloudflare/src/commerce/review-requests.ts`:

```sql
SELECT h.tenant_id, h.order_id, h.created_at AS qualified_at
FROM order_status_history AS h
JOIN review_settings AS s ON s.tenant_id = h.tenant_id
WHERE h.track = 'fulfilment'
  AND h.to_status IN ('shipped', 'ready_for_pickup', 'delivered', 'completed')
  AND h.created_at > ?1 - ?2                                  -- now − (21 d + 7 d): the index range
  AND s.requests_enabled = 1
  AND h.created_at >= s.requests_enabled_at
  AND h.created_at + s.delay_days * 86400000 <= ?1            -- due
  AND h.created_at + s.delay_days * 86400000 > ?1 - ?3        -- not more than 7 days late
  AND NOT EXISTS (                                            -- h is the FIRST such row
    SELECT 1 FROM order_status_history AS e
    WHERE e.tenant_id = h.tenant_id AND e.order_id = h.order_id
      AND e.track = 'fulfilment'
      AND e.to_status IN ('shipped', 'ready_for_pickup', 'delivered', 'completed')
      AND (e.created_at < h.created_at OR (e.created_at = h.created_at AND e.history_id < h.history_id))
  )
  AND NOT EXISTS (SELECT 1 FROM review_requests AS r WHERE r.order_id = h.order_id)
ORDER BY h.created_at ASC, h.order_id ASC
LIMIT ?4                                                      -- REVIEW_BATCH = 25
```

The first-row test is not limited to the window, so an order first sent before the window (or before the switch) is never asked because of a later second parcel. The inner query runs on `order_status_history_order_idx` (`0011:354-355`).

#### 4.4 The checks, in order

The first failing check writes a `skipped` row with its reason (`INSERT … ON CONFLICT(order_id) DO NOTHING`). No Stripe call: a paid order is paid.

| # | Check | How | Reason | Re-checked when the mail is built |
|---|---|---|---|---|
| 1 | The order is open | `openSql` (`fulfilment.ts:212-216`): not cancelled, not refunded, not refunded to its charge | `order_closed` | **yes** |
| 2 | The platform's add-on | `isFeatureEnabled(db, tenant, 'productReviews')`, once per tenant per tick | `feature_off` | **yes** |
| 3 | The seller's switch | on, and `qualified_at ≥ requests_enabled_at` (read again with the add-on) | `switch_off` | **yes** |
| 4 | The shop is public | `isPublicShop` (`public-storefront.ts:86-89`): active, published, named. Not `shopTakesOrders`: a review needs no checkout. Once per tenant per tick | `shop_closed` | **yes** |
| 5 | Consent | `reviewRequestConsentGiven(orders.consent_json)` (§2.5) | `no_consent` | **yes** (frozen, asked again anyway, as the reminder's Deviation 1, `CP9_AC_REPORT.md:1141`) |
| 6 | A mailable address | `hashEmailRecipient(orders.customer_email)` does not throw; the row's hash is the plain sha256 for any address (the reminder's Deviation 2, `CP9_AC_REPORT.md:1142`) | `undeliverable` | no |
| 7 | Not unsubscribed | no `review_request_suppressions (tenant, buyer_hash)` | `unsubscribed` | **yes**, and once more by the consumer before a held job leaves |
| 8 | No accepted withdrawal (RV7) | no `withdrawals` row of the order with `eligible = 1` (`0044:60-90`) | `order_withdrawn` | **yes** |
| 9 | Something to review | at least one distinct product of `order_items` that passes THE public predicate now (`catalog/eligibility.ts`, as `buyableLines` reads it, `checkout-reminders.ts:275-299`; variants ignored) | `nothing_to_review` | **yes** (the mail lists only these products) |
| 10 | The write | §4.5 | — | — |

**Why this order:** check 1 first, so a closed order is always recorded as such; 2–4 are about the shop and are cached per tenant; 5–9 are one read each.

#### 4.5 The write

One batch, the reminder's `queueReminder` (`checkout-reminders.ts:344-385`) without the cap:

```sql
INSERT INTO review_requests
  (request_id, tenant_id, order_id, buyer_hash, state, reason,
   qualified_at, decided_at, link_expires_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, ?6, ?6 + 15552000000, ?6, ?6);   -- + 180 days

INSERT INTO outbox_events
  (outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
   dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at)
SELECT ?7, ?2, 'email.review_request', 'review_request', ?1,
       'email.review_request:' || ?1, json_object('requestId', ?1), 'pending', ?6, ?6, ?6
WHERE EXISTS (SELECT 1 FROM review_requests WHERE request_id = ?1 AND state = 'queued');
```

- The outbox row holds the request id only: no address, no link. Its aggregate is the request, not the order (the reminder's Deviation 5, `CP9_AC_REPORT.md:1145`).
- A UNIQUE failure on `review_requests.order_id`: another run decided it; counted, moved on.
- `nudgeOutbox` with the new ids after the loop.
- Nothing is written to `orders` or `order_status_history`.

#### 4.6 What is checked again when the mail is built

A new outbox effect `email.review_request` (added to `OUTBOX_EFFECT_TYPES` and `EFFECTS`), modelled on `runCheckoutReminderEmailEffect` (`checkout-reminders.ts:754-792`):
1. Read the request `(the row's tenant, requestId)`. Missing → terminal `invalid_payload`; not `queued` → complete without a mail.
2. Re-check 1, 2, 3, 4, 5, 7, 8, 9 in order. The first failure withdraws the request (`withdrawn`, its reason) and closes an unclaimed ledger row of an earlier attempt (`E_WITHDRAWN`), in one batch under the claim (`checkout-reminders.ts:620-647`).
3. Build the job (§5.4) and hand it to the shared `deliver` with this kind's lifetime.

#### 4.7 Bounds

- At most `REVIEW_BATCH = 25` candidates per tick, oldest first; every one examined gets a row. About 2 400 decisions a day.
- A step in `scheduled.ts` `CP9_STEPS` after `checkout_reminders` (`scheduled.ts:84-91`), isolated like every step; it throws only on a D1 fault.
- Does nothing (one log line, no failure) without `BETTER_AUTH_SECRET` or a `web` canonical origin (`checkout-reminders.ts:416-427`).
- Returns `{ examined, queued, raced, skipped: { <reason>: n }, disabled? }`; never an address.

### 5. The mail

#### 5.1 What it may and may not contain

**May:** the shop's name; the recipient's name (`order_recipients.name`, read live, never frozen in the job, as the order mails and the reminder do, `checkout-reminders.ts:686-705`); the live public names of the products still public (frozen at the first build); the review link and its last valid day; the unsubscribe links; the shop's support address; why the buyer gets it.

**May not:** a price, a total, a discount or an offer (an incentive for a review is a legal question of its own, not verified); the order number or id; images (no Cloudflare mail carries one).

#### 5.2 The Swedish text (RV5)

```
Subject:  Vad tyckte du om ditt köp hos {shop}?        (no shop name: "Vad tyckte du om ditt köp?")

Vad tyckte du om ditt köp?

Hej {name},                                            (no name: "Hej,")

Tack för att du handlade hos {shop}. Vi vill gärna höra vad du tycker om:
- {product name}
- …

Lämna ett omdöme: {review link}
Det tar en minut. Länken gäller till och med {12 april 2027}.

Ditt omdöme visas på produktsidan med det namn du väljer, eller som "Anonym". Din e-postadress visas aldrig.

Du får det här mejlet eftersom du sa ja till e-post från {shop} när du handlade.
Det här är den enda förfrågan om den här beställningen.
Vill du inte få fler förfrågningar om omdömen från {shop}? Avregistrera dig: {unsubscribe page}
Har du frågor? Kontakta {shop} på {support address}.   (no address: "Har du frågor? Kontakta butiken.")
```

- `{shop}` is "butiken" without a name, as the reminder's template (`checkout-reminder-email.ts:443`).
- The HTML part has the same paragraphs, every value escaped, a link "Lämna ett omdöme" (Firebase's button text, `reviewRequest.ts:98`) and the footer link "Avregistrera dig från recensionsförfrågningar" (Firebase's, `reviewRequest.ts:85-87`).
- The date is the last full Stockholm day the link works, `linkValidUntilOf` (`checkout-reminder-email.ts:398-409`).
- No exclamation marks, no em dashes (the AC unit's copy rule, `CP9_AC_REPORT.md:1194`). Firebase's "Tack för ditt köp!" becomes "Tack för att du handlade hos {shop}."
- The sentence "du sa ja till e-post" holds under RV4 (either box). Under RV4 (a) it must change.

#### 5.3 Sender, Reply-To, headers (RV19)

Exactly what the consumer gives the reminder kind, for this kind too:
- From `"{shop}" <the address of EMAIL_FROM>` with the display name cleaned (`checkoutReminderFrom`, `reminderDisplayName`, `checkout-reminder-email.ts:358-379`; Firebase sent as the shop, `EmailOrchestrator.ts:881-896`).
- `reply_to` the shop's support address (`realShopAddress`).
- `List-Unsubscribe: <one-click URL>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (`checkout-reminder-email.ts:381-387`); the URL is the API route of §6.4 through the web Worker, not a page (F2).
- The last suppression check before a held job leaves, against `review_request_suppressions` (`email-queue-consumer.ts:258-267`'s pattern).

The consumer's reminder-only branches (`email-queue-consumer.ts:157-176`, `:258-267`) become one helper over the two kinds; every other kind's Resend request stays byte for byte (the AC golden, `test/checkout-reminders-off-golden.test.ts`, part c). That Resend accepts the `headers` member is still not verified (`CP9_AC_REPORT.md:611`, `:1260`).

#### 5.4 The job, the ledger, and no mail account

A new `cloudflare/src/email/review-request-email.ts`, the reminder module's shape (`checkout-reminder-email.ts:37-347`):

```ts
export const REVIEW_REQUEST_KIND = "review_request";
interface ReviewRequestEmailJob {
  actionUrl: ""; createdAt: number; deliveryId: string; expiresAt: number;
  kind: "review_request"; locale: "sv"; recipient: string; tenantId: string; version: 1;
  content: {
    items: Array<{ name: string }>;  // 1–50 distinct products, public when first built
    linkValidUntil: string;          // YYYY-MM-DD, Stockholm, the last full day
    oneClickUnsubscribeUrl: string;  // https://<web>/_api/<tenant>/v1/review-requests/<u-token>/unsubscribe
    recipientName: string | null;    // live, never frozen
    reviewUrl: string;               // https://<web>/<tenant>/recensera/<r-token>
    shopName: string | null;
    supportEmail: string | null;
    unsubscribeUrl: string;          // https://<web>/<tenant>/avregistrera-recensioner/<u-token>
  };
}
```

- **Validation** as strict as the reminder's link rules (`checkout-reminder-email.ts:151-180`, `:194-248`): https, no credentials, no query or fragment, the exact path with the job's own tenant and the token shape; the two unsubscribe URLs carry one token, the review URL another of the same request.
- **Wiring:** the kind joins `AuthEmailKind`, `parseAuthEmailJob`, `renderAuthEmail` and `fingerprintAuthEmailJob`, as the reminder did (`CP9_AC_REPORT.md:637`).
- **Delivery id:** `deliveryIdFromKey("email.review_request:<requestId>")`.
- **Frozen at the first build:** everything but `recipientName` (`checkout-reminders.ts:706-750`).
- **Lifetime: 24 hours**, the frame's maximum (`CP9_AC_REPORT.md:643`). A review request is not time-critical, unlike the reminder's 2 hours.
- **No mail account (staging).** The decision, the outbox row and the ledger row are written as with one; the consumer holds the batch and the queue drops it after about 40 minutes; the ledger row stays `pending` (`CP9_AC_REPORT.md:1152`). The request is then never mailed and its link exists nowhere. The seller's card says so (`mailConfigured`, `readEmailDeliveryConfig(env) !== null`, `email-queue-consumer.ts:96-110`).

### 6. Public routes and their contracts

All are storefront routes: mounted inside `app.ts`'s `storefront(...)` wrapper with `onMethods`, no session, the tenant from the verified hostname (`storefront-checkout-recovery.ts:7-10`, `app.ts:2439-2444`).

#### 6.1 Addresses

- Pages on the shared host: `https://<web>/<tenantId>/recensera/<review token>` and `https://<web>/<tenantId>/avregistrera-recensioner/<unsubscribe token>` (Firebase's words, `sweep.ts:24-32`). Every GET page path already reaches the storefront shell (`CP9_AC_REPORT.md:730`).
- One-click target: `https://<web>/_api/<tenantId>/v1/review-requests/<unsubscribe token>/unsubscribe`.
- A shop on its own domain still gets links on the shared host until a later unit (as the reminder, `CP9_AC_REPORT.md:658`).

#### 6.2 `POST /v1/review-requests/:token` (resolve)

- **Request:** no body is read.
- **200** `{ reviewRequest: { items: [{ productId, name, image: { url, alt } | null, reviewed: boolean }] } }`: the order's distinct products in `item_index` order that pass THE predicate now, with the live public name and main image (public facts), and whether a review of that product from THIS order exists (any state). At most 50.
- **404**, the shared opaque response (`routeNotFoundResponse`, identical bytes), for each of: a malformed token; a wrong signature; another shop's token; the unsubscribe purpose; an unknown request; a `skipped` or `withdrawn` request; a link past `link_expires_at`; no secret; **the platform's add-on off** (RV18).
- **429** `rate_limited`. `Cache-Control: no-store`. Writes nothing.
- Firebase distinguished `expired` from `invalid` (`callables.ts:86-91`); here both are the one 404, and the page says the link no longer works (the reminder's rule).

#### 6.3 `POST /v1/review-requests/:token/reviews` (submit)

**Body**, strict keys, read with `readJsonBodyWithin(request, 16 384)` (`src/legal/legal-pages.ts:111`, the withdrawal route's bounded reader, `routes/storefront-withdrawals.ts:69-70`, `:131`):

```
{ productId: string, rating: 1|2|3|4|5, title?: string|null, text?: string|null, displayName?: string|null }
```

- `rating` an integer 1–5, required.
- Text normalisation (pure `normalizeReviewText`): trim; CRLF and CR → LF; other control characters removed; three or more line breaks → two; empty → null. Then `title` ≤ 100 with no line break; `text` ≤ 2000; `displayName` ≤ 60 with no line break; an empty or absent name = anonymous (the UI's "Visa som anonym" sends null). Over a limit → 400, never cut (Firebase cut silently, `callables.ts:59-61`).
- **Who:** the token with the `review` purpose; the request `queued` and within `link_expires_at`; the add-on on (RV18). Else the opaque 404.
- **What:** `productId` must be one of the resolve's items (a line of this order, public now). Else the same 404: the answer cannot tell another order's product from a forged token.
- **The filter** (§7.1) screens title, text and name → `flags`.
- **The state:** `published` when the seller's moderation is `auto` and there is no flag; otherwise `pending`. With no settings row, `auto` (Firebase).
- **The write:** one `INSERT INTO product_reviews …`. The UNIQUE `(order_id, product_id)` decides a double click or a race: the loser gets **409** `already_reviewed`. No outbox, no mail.
- **Answers:** **201** `{ review: { state: "published" | "pending" } }`; **400** `invalid_request` (one body for every malformed shape); **404**; **409**; **429**.
- **What it never answers:** the review id, the order, any name or address, the flags.

#### 6.4 `POST /v1/review-requests/:token/unsubscribe`

The reminder's route (`storefront-checkout-recovery.ts:167-202`): the body is ignored (RFC 8058's form or nothing); the token with the `unsubscribe` purpose; the request `queued` (no expiry, no add-on check); one batch of `INSERT … ON CONFLICT DO NOTHING` into `review_request_suppressions` with the request's `buyer_hash` and, only when new, an `audit_events` row `review_request.unsubscribe` with the request as resource and no actor. **200** `{ unsubscribed: true }` now or before; the opaque 404; 429.

#### 6.5 The public reads

**The aggregate in the product reads.** `GET /v1/products`, `GET /v1/products/:ref`, and the collection reads that embed summaries (§1.3) gain `reviews?: { count, ratingSum }` (§3.4). Absent = no published review, or the add-on off.

**`GET /v1/products/:productId/reviews?cursor=&limit=`** (new; registered in the CP4 block BEFORE the product prefix mount, which answers 404 for every GET under `/v1/products/` of more than one segment, `app.ts:2630-2638`):
- The tenant by hostname, with the preview grant as on every product read (`resolveStorefrontTenant`).
- The product must pass THE predicate (`eligibilityPredicate(tenant)`, `public-catalog.ts:164-192`) and the add-on must be on; else 404.
- `limit` 1–50, default 10 (Firebase's page size, `ProductReviews.jsx:23`). The cursor is base64url of `{ submittedAt, reviewId }`, keyset on `(submitted_at DESC, review_id DESC)`: a review hidden between two pages is simply absent, nothing repeats. An unknown parameter or a cursor this route did not write → 400.
- **200** `{ reviews: [{ reviewId, rating, title, text, displayName, date }], nextCursor }`: `published` only, newest first (Firebase's order, `ProductReviews.jsx:58-66`); `displayName` null means "Anonym"; `date` is the Stockholm day of `submitted_at` (`YYYY-MM-DD`; Firebase printed `sv-SE`, the same form).
- The catalog version and the first page are read in ONE batch, as `listPublicProductPageVersioned` (`public-catalog.ts:598-620`), and answered through `versionedJsonResponse`.

#### 6.6 The ETag: never a stale 304

- **A review published, hidden or removed** changes `state`; `catalog_version_product_reviews_state` bumps the version in the same statement. **A review submitted** (pending or published) bumps it by `catalog_version_product_reviews_insert`. Every product read, collection read and review list reads the version in the same batch as its main row (`public-catalog.ts:578-642`); the summary read that follows is at worst NEWER than its label (the rule stated at `public-catalog.ts:578-587`).
- **The add-on switched** bumps it by 0043's `tenant_features` triggers (`0043_storefront.sql:145-165`). **The seller's settings** bump it by their own triggers (§3.3).
- **The deploy.** The product, list and collection bodies gain an optional member, so the four routes pass a new constant `PRODUCT_BODY_REVISION = 1` to `versionedJsonResponse` (`public-routes.ts:84-91`; `"<v>-r1"`, `"<v>-c-r1"` with the canvas switch). With nothing turned on at the deploy no body changes; the revision keeps a body of this code from ever matching one of the code before, across a rollback too (the reminder's Deviation 9, `CP9_AC_REPORT.md:1149`). The storefront answer moves from `-r3` to `-r4` in RV-B (§9.3).

#### 6.7 What the routes never reveal

No route answers an address, a name of the buyer, the order id or number, a request's dates or reasons, whether an address is suppressed, whether another order exists, or a review's flags or moderation. A malformed, forged, foreign, unknown or expired token gets one answer, byte for byte. The only facts a holder of a valid review link learns are the order's public products and which of them were already reviewed from this order. A test compares the 404 bodies, and a denylist test fails on any of these keys in any public answer: `email`, `customerEmail`, `orderId`, `orderNumber`, `name` outside `items[].name`, `recipient`, `flags`, `state` outside the submit answer, `removedReason`, `moderatedBy`.

#### 6.8 Rate limits

- One scope `review-link-ip` for the three token routes: 30 requests per 10 minutes per visitor (an IPv6 address by its /64, `lib/rate-limit.ts:161-194`), counted before the token is parsed (`storefront-checkout-recovery.ts:94-104`). A buyer reviewing five products needs six requests. No limit per token (it would let a link's holder block the buyer's unsubscribe).
- The review list is a public GET read like the product reads: no limit of its own.

#### 6.9 The web Worker's allowlist

Four rows in `cloudflare/web/src/api-allowlist.ts:35-57`, with their tests in `cloudflare/test/web-routing.test.ts` (allowed method, the other method refused, an encoded slash refused, an extra segment refused):

```ts
{ methods: ["GET"],  segments: ["v1", "products", ID, "reviews"] },          // RV-A
{ methods: ["POST"], segments: ["v1", "review-requests", ID] },               // RV-B
{ methods: ["POST"], segments: ["v1", "review-requests", ID, "reviews"] },    // RV-B
{ methods: ["POST"], segments: ["v1", "review-requests", ID, "unsubscribe"] }, // RV-B
```

The 83-character token passes the id rule (`api-allowlist.ts:59-76`). The admin and platform routes need no row: the admin Worker forwards `/v1/admin/*` and `/v1/platform/*` whole (`cloudflare/admin/src/allowlist.ts:32-35`).

### 7. Moderation

#### 7.1 The filter

A pure `cloudflare/src/commerce/review-filter.ts`: Firebase's three rules (`contentFilter.ts:9-36`) over the title, the text and the displayed name:
- `link`: `https?://` or `www.` (Firebase's `URL_RE`);
- `email`: Firebase's `EMAIL_RE`;
- `word`: Firebase's 14 words, matched on `tokenize()` of the text (`screening-core.ts:42-45`), so "Jävla" and "javla" match alike and word boundaries hold for Swedish letters. The list is folded once (`jävla` → `javla`).

It never rejects; a flag only holds the review for the seller. Known false positives, kept from Firebase: "fan" (also English "a big fan") and "skit" ("skit bra") (F11; RV12).

#### 7.2 The shop admin's routes

A new `cloudflare/src/routes/admin-reviews.ts` under `/v1/admin/`. `404` for every route when there is no session, membership or acting-as grant (`authorizeTenantAdminRequest`), on a cross-origin write (`isSameOriginRequest`), or while the platform's add-on is off (the rule of `admin-checkout-reminders.ts:137-144`).

- **`GET /v1/admin/reviews?state=&cursor=&limit=`** (`state` ∈ all, pending, published, hidden, removed; default all; limit 1–100, default 50) → `{ reviews: [{ reviewId, productId, productName, rating, title, text, displayName, state, flags, submittedAt, moderatedAt, moderatedBy: "shop" | "platform" | null, removedReason }], nextCursor, summary: { published, pending, hidden, removed, average } }`. `average` over published, one decimal, null without any. **Never the order, the order number or the address** (RV14; Firebase showed none, `AdminReviews.jsx:134-199`). `moderatedBy` is a kind, never a user id (the order history's rule, `fulfilment.ts:699-702`).
- **`POST /v1/admin/reviews/:reviewId/moderation`** body exactly `{ action: "publish" | "hide" }` → `200 { review }` as listed. Same state → `200`, no write, no audit (Firebase's double-click rule, `callables.ts:283-294`). A `removed` review → `409 review_removed`. One batch: the guarded update (`… WHERE review_id = ? AND tenant_id = ? AND state = ?`) and an `audit_events` row `product_review.moderate` with `{ from, to }` and, for an acting-as platform user, the grant (`auditMetadataJson`, RV20).

#### 7.3 The page "Recensioner" and its Swedish texts

`/admin/reviews`, route row `{ path: '/admin/reviews', page: 'AdminReviews', guard: 'admin', feature: 'productReviews' }` in `src/admin-app/AdminApp.jsx:30-51`, the export in `src/admin-app/pages.jsx`. The nav item exists (`AppLayout.jsx:255-263`). The page keeps its layout (`<AppLayout>`, `Page`, `MetricsBar`, `DataTable`, `StatusPill`); its Firebase code moves unchanged into `src/pages/admin/adminReviewsData.js` (the older build) and the admin build swaps in `src/admin-app/replacements/adminReviewsData.js` on `src/api/admin/reviews.js`, CP8-DC's pattern (`vite.admin.config.js:140-142`; `CP8_DC_REPORT.md:620-631`).

| Place | Text | |
|---|---|---|
| Title, subtitle | Recensioner · Produktomdömen från verifierade köp. Publicerade omdömen visas på produktsidan. | Firebase's, "Godkända" → "Publicerade" |
| Filters | Alla · Publicerade · Väntande · Avpublicerade · Borttagna | "Borttagna" new |
| Metrics | Antal omdömen · Snittbetyg · Väntande | unchanged |
| Note (RV5, legal) | Dölj aldrig ett omdöme för att det är negativt. Avpublicera bara omdömen som bryter mot reglerna, till exempel med kränkande innehåll, personuppgifter eller reklam. | replaces "Enligt lag måste moderering vara enhetlig — …" (`AdminReviews.jsx:233-234`): the legal claim and the em dash go; whether the law requires it is not verified |
| Flags | Innehåller en länk · Innehåller en e-postadress · Innehåller ett ord som ska granskas | new |
| Status pills | Publicerad · Väntande · Avpublicerad · Borttagen av plattformen | last new |
| Buttons | Publicera · Avpublicera (none on a removed review) | "Godkänn" → "Publicera" |
| Toasts | Omdöme publicerat. · Omdöme avpublicerat. · Kunde inte ändra status. | unchanged |
| Empty | Inga omdömen ännu. | unchanged |
| Removed row | Borttagen av plattformen: {reason} | new |

#### 7.4 The seller's settings (RV-B)

`GET /v1/admin/review-settings` → `{ reviewSettings: { requestsEnabled, requestsEnabledAt, delayDays, moderation, updatedAt, queuedLast30Days, mailConfigured } }` (no row: off, 7, `auto`, nulls); `PUT` body exactly `{ requestsEnabled, delayDays, moderation }` → the same shape, or `400`. The 404 rule of §7.2. One batch: the upsert (`requests_enabled_at = now` on off → on, kept otherwise) and an audit row `review_settings.update` (the reminder's write, `admin-checkout-reminders.ts:91-126`).

The card "Recensioner" in Inställningar (`AdminSettings.jsx:1110-1144`), through `loadReviewSettings` / `saveReviewSettings` of `src/admin-app/replacements/shopConfig.js:219-223`:
- Intro: "Be kunder om ett omdöme via e-post några dagar efter att ordern skickats eller blivit redo att hämtas. Bara kunder som kryssat i rutan för omdömen eller sagt ja till e-post från butiken får mejlet. Högst ett mejl per order."
- Switch "Be kunder om omdömen". Off: "Av: inga förfrågningar skickas." On: "På sedan {datum}: ordrar som skickas från och med då kan få en förfrågan."
- Delay: "Dagar efter att ordern skickats innan förfrågan skickas", help "Mellan 3 och 21 dagar. Standard: 7 dagar." (replaces "Dagar efter leverans…", §1.2).
- Moderation: "Publicera omdömen direkt när inget i texten behöver granskas" / "Granska varje omdöme innan det visas".
- Count: "Förfrågningar de senaste 30 dagarna: {n}".
- No mail (amber, as the reminder's card): "E-post är inte inställd här ännu. Förfrågningar köas men skickas inte förrän plattformen har ställt in e-posten."
- Note (RV5, legal): "Förfrågningarna skickas i butikens namn. Du ansvarar för att de följer marknadsföringslagen."
- In RV-A the card stays hidden: the admin build's `shopConfig.js` exports `REVIEW_SETTINGS_AVAILABLE = false` and the page gates the card on it; RV-B sets it true.

#### 7.5 What the platform can do

- **`GET /v1/platform/tenants/:tenantId/reviews`** (platform session): the seller's list shape.
- **`POST /v1/platform/reviews/:reviewId/takedown`** body exactly `{ reason: string 1–500 }` → `removed`, with `removed_reason`, `moderated_by` = the platform user; final (the trigger refuses every later change); an `audit_events` row `product_review.takedown`. Already removed → `200`, no write.
- **A notice reaches the platform by e-mail** (the shop's or the platform's address); there is no "report this review" link (RV15). Whether the platform or the shop is the host of the reviews under the DSA, and what notice-and-action and a statement of reasons to the reviewer it owes, is **not verified** (RV13; R5).
- **No console page in this unit**: the operator calls the route (documented in the runbook) or acts as the shop to hide. A console list is a later small unit (RV15).

#### 7.6 Audit

`product_review.moderate` (seller or acting-as, with the grant), `product_review.takedown` (platform), `review_settings.update`, `review_request.unsubscribe` (no actor, only when new). None holds an address, a text or a name.

#### 7.7 What each party sees

- **The buyer:** their own link's products and whether each is reviewed; the published reviews of every shop.
- **The seller:** every review of the shop with its flags and state; one count of requests; never the buyer's address, the order, whether an address unsubscribed, or a request's decision.
- **The platform:** the same per shop, plus the takedown. Decisions and suppressions only in D1.

### 8. The storefront

#### 8.1 The product page

- **The block.** `PublicProductPage.jsx:865-868` renders `ProductReviews` when `product.reviewCount > 0`; that line stays. The adapter (`src/storefront/adapters/products.js:70-132`) maps `reviews` to `reviewCount = count` and `ratingSum = ratingSum` only when present, so a product with none has neither key (its test at `adapters.test.mjs:135-139` changes accordingly).
- **The replacement** `src/storefront/replacements/ProductReviews.jsx` becomes the Firebase component's markup (`ProductReviews.jsx:113-186`, NORD tokens `font-display`, `text-ink`, `text-accent`) reading `listProductReviews(productId, cursor)` from a new `src/api/reviews.js`:
  - heading "Omdömen";
  - the average with one decimal, the stars, "{n} omdömen" ("1 omdöme" for one);
  - the statement of §8.2;
  - the list: stars, date, name or "Anonym", title in bold when present, text with its line breaks;
  - "Visa fler" while `nextCursor`;
  - a failed read shows the aggregate and the statement and no list (Firebase logged and showed nothing, `ProductReviews.jsx:87-89`).
- **Nothing shows** for a product without a published review, or while the add-on is off: no block, no stars, no structured data (Firebase showed nothing at 0 too).

#### 8.2 The statement of how reviews are verified (RV5, legal)

Under the aggregate, always with the block:

> "Omdömena kommer från kunder som har köpt produkten i butiken. Efter leveransen får kunden en personlig länk via e-post, och bara med den länken går det att lämna ett omdöme. Butiken kan granska ett omdöme innan det visas. Vi visar både positiva och negativa omdömen."

It replaces Firebase's text (`ProductReviews.jsx:136-139`), which had an em dash and did not say that reviews may be held. Every clause is true by construction except the last, which depends on the seller's moderation (the admin note, §7.3). That the Omnibus rules require such a statement, and that this one satisfies them: the owner's note, **not verified**.

#### 8.3 Cards

`NordProductCard.jsx:77-78`, `:146-153` (shared, unchanged) shows rounded stars and the count from `reviewCount` / `ratingSum`; the list adapter supplies them as for the detail (RV16).

#### 8.4 Structured data

- **Server** (`src/storefront/seo.ts:835-864`): when `product.reviews` is present, the Product gains `aggregateRating: { "@type": "AggregateRating", ratingValue: (ratingSum / count).toFixed(1), reviewCount: count }`, Firebase's two fields and formula (`productFeed.js:91-98`). The readable body gains one line, `<p>Betyg 4,3 av 5 (12 omdömen)</p>`, so the rating is visible without JavaScript too.
- **Client:** the replacement `productFeed.js:49-57` already emits the same object from `reviewCount` / `ratingSum`; with the adapter's mapping both blocks agree.
- **Only published reviews count**, by the query (§3.4). **No `Review` items** (RV16).
- **Not verified, search-engine policy:** that `AggregateRating` without `bestRating` / `worstRating` is read as a 1–5 scale; that a merchant's own product reviews are eligible for rich results; that two Product blocks on one page (server and client, F12) are merged.

#### 8.5 The review page and the unsubscribe page (RV-B)

Routes before `/:slug` in `src/storefront/StorefrontApp.jsx:18-38`: `{ path: '/recensera/:token', page: 'ReviewSubmitPage' }` and `{ path: '/avregistrera-recensioner/:token', page: 'ReviewUnsubscribePage' }`; two swap lines in `src/storefront/pages.jsx`. Both pages are rewritten on `src/api/reviewRequests.js` with no Firebase import, so their two lines leave `guard/allowlist.txt` (`:245-246`; baseline 292 → 290). Both `noindex`; no add-on gate on the page itself (the route answers for the add-on, RV18).

`ReviewSubmitPage` (layout of `ReviewSubmitPage.jsx:137-315`):
- loading "Laddar…";
- 404 → a panel "Länken går inte att använda längre." with "Till butiken" (Firebase redirected silently, `:69-72`);
- open → per product: the name and image; "Ditt betyg" (required; toast "Välj ett betyg först."); "Rubrik (valfritt)"; "Ditt omdöme (valfritt)"; "Namn som visas med omdömet" with "Visa som anonym"; under the form "Skriv inte din e-postadress, ditt telefonnummer eller annat som inte ska synas."; "Skicka omdöme" / "Skickar…";
- after `published`: "Tack. Ditt omdöme visas nu på produktsidan." After `pending`: "Tack. Ditt omdöme visas när butiken har läst det." A 409: "Du har redan lämnat ett omdöme för den här produkten." A reviewed product shows "Omdöme lämnat";
- every product done: "Tack för dina omdömen." / "Ditt omdöme hjälper andra kunder." and "Till butiken";
- an error: "Något gick fel. Försök igen." (Firebase's texts without exclamation marks).

`ReviewUnsubscribePage` calls on mount: 200 → "Du är avregistrerad från förfrågningar om omdömen" / "Vi skickar inga fler förfrågningar om omdömen från {{shop}}. Du kan handla i butiken som vanligt."; 404 → "Länken fungerar inte längre." / "Vill du inte få förfrågningar från {{shop}}? Svara på mejlet eller kontakta butiken på {{email}}." (without an address: "… Svara på mejlet eller kontakta butiken."); an error → "Något gick fel. Försök igen om en stund." with "Försök igen". It never claims a success it did not get (F3).

#### 8.6 The checkout box (RV-B)

§2.5. The contact step's baseline shot changes only for a shop with requests on; for a shop with the add-on off the step must be pixel-identical (the AC unit's proof, `CP9_AC_REPORT.md:1131`).

### 9. The feature flag and D81

#### 9.1 The default today, and what it means

`productReviews` is not in `OPT_IN_KEYS` (`tenant-config.ts:152-158`), so `FEATURE_DEFAULTS.productReviews` is `true` (`:161-164`): **every shop without an explicit row has the add-on ON today.** It is invisible only because D81 keeps the key out of `PORTED_FEATURE_KEYS` (`public-storefront.ts:55`). The importer writes a row only when a shop's value differs from the default (`scripts/cf-port/migrate/lib/transform-shops.mjs:363-384`), so after an import robowatz, gif-sundsvall, ninetone and sillmans read ON (no row) and melodie-mc OFF (an explicit 0), §1.1. **Porting the key as it is would light reviews on four of five shops at once**, and the platform console already shows the add-on "on (default)" for them (`src/admin-app/dev/platform-rest-dev.test.mjs:37` pins `defaultEnabled: true`).

**What to do (RV2): make it opt-in**, as DC2 and AC2 did, in lockstep:
- add `"productReviews"` to `OPT_IN_KEYS` (`tenant-config.ts:152-158`) and to the importer's `OPT_IN_FEATURE_KEYS` (`transform-shops.mjs:102`; `test/tenant-config-keys-pin.test.mjs` fails until both match, `CP9_AC_REPORT.md:1127`);
- consequence at import: robowatz (explicit `true`) gets an explicit ON row; gif-sundsvall, ninetone and sillmans (absent, ON in Firebase) read OFF; melodie-mc OFF;
- **every allowed key is then opt-in**: `FEATURE_DEFAULTS` is all `false`, and the default-ON branch has no key left. The tests that use `productReviews` as "the one default-ON key" (`test/tenant-features.test.ts:46-55`, `:165-222`) must be rewritten: pin that every key defaults off, and keep the explicit-OFF case on an opt-in key turned on. D62's text (`DECISIONS.md:94`) changes;
- staging's explicit rows: not verified (`SELECT tenant_id, enabled FROM tenant_features WHERE feature_key = 'productReviews'`). A staging shop with no row flips from ON to OFF at the deploy; nothing visible changes, since D81 hid it.

**Found while checking: the console's new-shop preset turns the opt-in add-ons ON.** `ProvisionShopModal.jsx:31-43` sets `discountCodes: true`, `abandonedCheckout: true`, `productReviews: true` for every new shop, and the admin build's `provisionShop` PUTs them as explicit rows (`src/admin-app/replacements/provisionShopData.js:37-48`; `src/admin-app/adapters/platformShops.js:169-178`). So DC2, AC2 and RV2 hold for imported shops but not for a shop made in the console (F13; RV21: send only `pod`, the preset's one real choice).

#### 9.2 What each surface reads

| Surface | Value |
|---|---|
| The product reads, the review list (display) | ported AND the add-on |
| `GET /v1/storefront` `features.productReviews` (the checkout box) | ported AND the add-on AND `review_settings.requests_enabled`, read in the existing batch (`public-storefront.ts:170-197`, as the reminder's switch at `:192-196`, `:208-212`). In RV-A it is `false` by one line with a comment, since no switch exists yet. |
| The admin's features (`admin-session.ts:108-122`): the nav item, the page, the card | ported AND the add-on |
| The cron step and the mail effect | the add-on AND the switch (§4.4) |
| Resolve and submit | the add-on (RV18) |
| Unsubscribe | neither |

#### 9.3 Reversing D81 for this key only

D81 (`DECISIONS.md:113`, `:158`) took reviews out ("no review form"). CP8-DC and CP9-AC reversed it for one key each (`public-storefront.ts:46-55`; `public-routes.ts:38-58`).

RV-A:
1. `PORTED_FEATURE_KEYS = ["pod", "discountCodes", "abandonedCheckout", "productReviews"]`.
2. `features.productReviews = false` in the storefront answer, with the comment of §9.2.
3. RV2's opt-in, both sides.
4. `PRODUCT_BODY_REVISION = 1` on the four routes (§6.6).
5. Pins: `test/public-storefront.test.ts:170-182`; `test/admin-session.test.ts:470-493` (now `productReviews: true` after the platform enables it); `test/tenant-features.test.ts` (§9.1); every product and collection ETag pin (grep the tests named in §10.1 step 3); `src/admin-app/dev/platform-rest-dev.test.mjs:37`; the importer's pin.

RV-B:
1. `features.productReviews` ANDed with the switch.
2. `STOREFRONT_BODY_REVISION = 4` with a line in its comment (`public-routes.ts:45-58`): "Revision 4: features.productReviews (CP9-RV): ported, and true only with the seller's request switch on."
3. Every `-r3` pin (the CP8-DC list, `CP8_DC_REPORT.md:856`; the builder greps).

Docs (both units, or the reviewer if the builder may not touch them, `CP9_AC_REPORT.md:1257`): a numbered decision in `DECISIONS.md` (the next number is not verified: D99–D103 appear only outside the file, `CP9_AC_REPORT.md:1102`); `PLAN.md:106` ("Reviews" leaves §3.2); `CP5_GAP_ANALYSIS.md:43`, `:111`; `MIGRATION_MANIFEST.md:104`, `:109`; `src/config/addons.js:34` ("efter leverans" → "efter att ordern skickats"); `HANDOVER.md`.

#### 9.4 Cached responses

§6.6. With the add-on off a shop's every public body is byte for byte today's; only the ETag's revision moves once per read (product reads at RV-A, the storefront answer at RV-B).

### 10. Build plan

#### 10.0 How large, and why two units

The reminder unit built six Worker modules and a migration (about 2 000 lines), ten test files (+177 Worker tests, +22 frontend), two storefront pages, one checkout box and one settings card, with 43 mutations (`CP9_AC_REPORT.md:1108-1124`, `:1196-1243`, `:1302-1304`). Reviews need all of that: a cron decision, a mail kind, tokens, three token routes, a suppression, a switch, a consent box. On top of that come a public read with pagination, the aggregate in four product-bearing reads with an ETag revision, server and client structured data, the product-page block and cards, a moderation API and page, a platform takedown, a filter, and a state machine. **About 1.8 times the reminder unit.** Two units, each with its own review round and its own staging smoke:

- **RV-A — the reviews and their display** (about 0.8×): migration A, the public reads and the aggregate, the JSON-LD, the storefront block and cards, moderation (seller and platform), D81 for display. Nothing in production can write a review yet, so everything ships dark; it moves the riskiest public change (every product ETag, the catalogue shapes) into a unit of its own.
- **RV-B — the requests and the review page** (about 1.1×): migration B, consent, tokens, mail kind, cron, effect, the three token routes, the filter and submit, the settings route and card, the checkout box, the two pages, the storefront flag.

RV-A first: RV-B's submit writes RV-A's table. **Models** (the owner's rule): Opus for both units' Worker steps (schema, consent, tokens, public surface, legal texts); Sonnet for the pages and the admin frontend, the reviewer reading the consent box, the submit page and the moderation page. **Every step ends with** `cd cloudflare && npx tsc --noEmit && npx vitest run <the step's files>`.

#### 10.1 RV-A steps

| # | Step | Files | Tests (rule → test) |
|---|---|---|---|
| 0 | Golden | new `test/reviews-off-golden.test.ts`, run on the tree before any change | `GET /v1/products`, `/v1/products/:ref`, a collection read and `GET /v1/storefront` of a shop with the add-on off: bodies byte for byte, ETags with version and revision masked. Passes before and after. |
| 1 | Migration A | `migrations/00NA_product_reviews.sql`; `app.ts:503`; the two pins | New `test/product-reviews-schema.test.ts`: a product not in the order refused; another tenant's order or product refused; born hidden / removed / with `moderated_at` refused; the UNIQUE; every frozen column refused; every allowed edge admitted and every other refused, `removed` final; `removed` ⇔ reason; no delete; rating 0, 6 and 4.5 refused; title with a line break refused; the two catalog bumps (insert, state) and none on a non-state update that the frozen trigger would refuse anyway. |
| 2 | Aggregate | `catalog/public-catalog.ts` (`loadParts`, the shapes), `routes/public-products.ts`, `routes/public-collections.ts`, `storefront/public-routes.ts` (`PRODUCT_BODY_REVISION`) | New `test/review-aggregate.test.ts`: only `published` counts (pending, hidden, removed do not); another tenant's rows never; absent with the add-on off, and absent at 0; a hide moves the count and the ETag (no 304 with the old tag); a submit (insert) moves the ETag; the revision on all four routes; the golden of step 0 unchanged. Grep and update the ETag pins in `public-catalog`, `public-collections`, `seo`, `product-images`, `storefront-preview`, `product-variants`, `pod-publish`, `stand-in-frames-seller-storefront`, `web-worker` tests. |
| 3 | Review list | new `routes/public-reviews.ts`; `app.ts` mount before the product prefix (`:2630-2638`); `web/src/api-allowlist.ts`; `test/web-routing.test.ts` | New `test/public-reviews.test.ts`: published only, newest first, keyset (hide between pages: nothing repeats or is skipped); 404 for a product THE predicate refuses (draft, taken down, another shop's, canvas stand-in) and with the add-on off; limit and cursor validation; the denylist of §6.7; a preview grant reads an unpublished shop no-store. |
| 4 | Structured data | `storefront/seo.ts:835-864` | Extend `test/seo.test.ts`: `aggregateRating` with Firebase's formula when present, absent at 0 and with the add-on off; the body line. |
| 5 | Moderation | new `routes/admin-reviews.ts`, `routes/platform-reviews.ts`; `app.ts` | New `test/admin-reviews.test.ts`: list shape and the denylist (no `orderId`, no address); summary counts and average; publish / hide, idempotent, audit with the grant for acting-as; a removed review 409; another tenant's id 404; cross-origin 404; add-on off 404. Platform: takedown needs a reason, is final, audited; a seller cannot undo it. |
| 6 | D81, display | `storefront/public-storefront.ts`, `platform/tenant-config.ts`, `scripts/cf-port/migrate/lib/transform-shops.mjs:102`; the pins of §9.3 | `test/tenant-features.test.ts` rewritten (every key opt-in); `public-storefront.test.ts` (`features.productReviews` false in RV-A whatever the add-on); `admin-session.test.ts`; `node --test scripts/cf-port/migrate/test/*.test.mjs`. |
| 7 | Storefront | `src/storefront/replacements/ProductReviews.jsx`; `src/api/reviews.js`; `src/storefront/adapters/products.js` (+ test); `src/storefront/dev/dev-api.mjs` + `fixtures.json` (an invented shop with reviews) | `src/api/api.test.mjs` (the list client, 404 → none); `adapters.test.mjs` (keys only when sent; ratingSum / count verbatim); dev API tests. |
| 8 | Admin frontend | `src/pages/admin/adminReviewsData.js` (Firebase code moved unchanged), `src/admin-app/replacements/adminReviewsData.js`, `src/api/admin/reviews.js` (+ test), `src/pages/admin/AdminReviews.jsx` (imports the seam, texts of §7.3), `src/admin-app/AdminApp.jsx`, `pages.jsx`, `vite.admin.config.js`, `src/admin-app/replacements/shopConfig.js` (`REVIEW_SETTINGS_AVAILABLE = false`), `src/config/shopConfig.js` (`true`), `AdminSettings.jsx` (the card's gate), admin dev API | `src/api/admin/reviews.test.mjs`; dev API tests; `guard/allowlist.txt` swaps `AdminReviews.jsx` for `adminReviewsData.js` (count unchanged, the CP8-DC precedent, `CP8_DC_REPORT.md:631`). |
| 9 | Platform fix (RV21) | `src/admin-app/adapters/platformShops.js` `provisionFeaturesOf` sends `pod` only (+ test) | `platformShops.test.mjs:163-165` changes. |
| 10 | Docs | §9.3 | none |

#### 10.2 RV-B steps

| # | Step | Files | Tests |
|---|---|---|---|
| 0 | Golden | extend the AC golden (`test/checkout-reminders-off-golden.test.ts`) or a twin | the checkout rows of an unticked checkout, the storefront body with the add-on off, every existing mail kind's Resend request: byte for byte before and after. |
| 1 | Migration B | `migrations/00NB_review_requests.sql`; `app.ts:503`; pins | New `test/review-requests-schema.test.ts`: tenant mismatch; born withdrawn; UNIQUE per order; the CHECK pairs; queued → withdrawn only; no delete on the three tables; suppressions append-only per shop; settings CHECKs and catalog bumps; the partial index exists; `email_deliveries` admits `review_request`, refuses an unknown kind, keeps every row of a seeded copy (`diff` against the previous kind list). |
| 2 | Consent | `legal/consent.ts` | New `test/review-request-consent.test.ts`: an unticked consent byte-identical; ticked carries `"reviewRequest":true` and never false; non-boolean → 400; `sameConsent` across the change; a replay with the box flipped 409; the order copy verbatim; `reviewRequestConsentGiven` for null, unreadable, terms-only, marketing-only, review-only, both. |
| 3 | Tokens | `lib/signed-link.ts`, `commerce/review-link-token.ts`, `commerce/checkout-recovery-token.ts` (on the core) | First a golden reminder token with a fixed secret (passes before and after). New `test/review-link-token.test.ts`: round trip per purpose; the other purpose, another tenant, another request, one flipped character refused; malformed shapes; no secret; a reminder token never verifies here, nor the reverse. |
| 4 | Mail kind | `email/review-request-email.ts`; `auth-email-job.ts`; `email-delivery-store.ts`; `email-queue-consumer.ts` (the helper over the two kinds) | New `test/review-request-email.test.ts`: create, parse and fingerprint agree; every URL rule; 1–50 items; lifetime ≤ 24 h; the Swedish text with and without shop name, recipient and support address; no digit-plus-"kr"; escaping. Consumer: From, Reply-To, both headers for this kind; a suppressed address → `failed E_UNSUBSCRIBED`; every other kind byte-identical (golden). |
| 5 | Effect | `commerce/review-requests.ts` (effect); `outbox/outbox.ts`, `outbox/effects.ts` | New `test/review-request-effect.test.ts`: each re-check of §4.6 withdraws with its reason, no job, an earlier unclaimed ledger row closed; happy path one ledger row `pending`, `frozen_json` without the name, a retry builds the identical job; only public products listed; another tenant's request never read. |
| 6 | Cron | `commerce/review-requests.ts` (`runReviewRequests`); `outbox/scheduled.ts` | New `test/review-requests-cron.test.ts`: one test per check with its reason; the order (a closed AND non-consenting order records `order_closed`); due / not yet / more than 7 days late (no row); the first fulfilment row is the clock (a second parcel later does not re-qualify an older order, a pickup's ready row, the printer's automatic shipped row); before `requests_enabled_at` → no row; 25 oldest first, the 26th next tick; the UNIQUE race; `orders` and `order_status_history` unchanged; the payload holds only `requestId`; nothing without the secret or the web origin. |
| 7 | Filter and token routes | `commerce/review-filter.ts`, `commerce/review-input.ts` (normalisation, parse), `routes/storefront-review-requests.ts`; `app.ts`; `web/src/api-allowlist.ts` (3 rows) + `test/web-routing.test.ts` | `test/review-filter.test.ts` (each rule, folded words, the known false positives pinned, never a rejection). New `test/review-request-routes.test.ts`: resolve lists only public products and `reviewed`; the denylist; every 404 case byte-equal (incl. add-on off, expired, skipped, withdrawn, purpose, tenant); submit: a product of another order or not public → the same 404; rating, lengths, line breaks, unknown keys, a 17 KB body → 400; auto vs manual vs flags; the 409 race; nothing else written; unsubscribe idempotent, works with the add-on off and an old link, the RFC 8058 form; the 31st request 429. |
| 8 | Settings route | `routes/admin-review-settings.ts`; `app.ts` | New `test/admin-review-settings.test.ts`: defaults; off → on sets `requests_enabled_at`; strict body; delay 2 and 22 → 400; moderation values; add-on off → 404; cross-origin 404; acting-as audited; the 30-day count; `mailConfigured`. |
| 9 | D81, requests | `public-storefront.ts`, `public-routes.ts` (revision 4); pins | `test/review-requests-storefront.test.ts`: the five combinations of add-on and switch; a switch change never meets a stale 304; the admin's value is the add-on alone. |
| 10 | Storefront | `src/api/reviewRequests.js` (+ test); `src/pages/shop/ReviewSubmitPage.jsx`, `ReviewUnsubscribePage.jsx`; `StorefrontApp.jsx`; `pages.jsx`; `Checkout.jsx` (the box), `StripePaymentForm.jsx`, `adapters/checkout.js` (+ test); dev API; `guard/allowlist.txt` (−2) | `checkout.test.mjs`: no `reviewRequest` unless shown AND ticked; a pure `adapters/reviewForm.js` (the form → the body: anonymous → null, trimming) with its test; dev API tests. |
| 11 | Admin card | `AdminSettings.jsx:1110-1144`; `src/api/admin/reviewSettings.js` (+ test); `replacements/shopConfig.js` (`REVIEW_SETTINGS_AVAILABLE = true`, load / save) | client and dev API tests. |
| 12 | Importer | `scripts/cf-port/migrate/lib` (both suppression transforms, §3.7) + tests | `node --test scripts/cf-port/migrate/test/*.test.mjs`. Only if the unit may touch that directory; otherwise listed as unfinished, as AC did. |
| 13 | Docs | §9.3 | none |

#### 10.3 Mutations to run

Each must fail at least one test; restore and `cmp` after each.

RV-A:
1. The aggregate counts `pending`.
2. The aggregate counts `hidden` or `removed`.
3. The tenant term dropped from the aggregate.
4. The aggregate served with the add-on off.
5. The review list serves a product THE predicate refuses.
6. The list serves a non-published review.
7. The list ordered ascending, or without `LIMIT`.
8. The insert bump trigger removed.
9. The state bump trigger removed.
10. `PRODUCT_BODY_REVISION` dropped from one of the four routes.
11. JSON-LD `aggregateRating` at count 0, or with the add-on off.
12. The transition trigger admits `removed → published`.
13. The frozen trigger admits a rating change.
14. A review born `hidden`.
15. The order-line trigger removed.
16. The seller's moderation reaches another tenant's review.
17. The seller publishes a removed review.
18. Moderation writes no audit row.
19. A takedown without a reason.
20. The admin list answers `orderId`.
21. `PORTED_FEATURE_KEYS` without `productReviews`.
22. `productReviews` not opt-in (or the importer's set without it).
23. `features.productReviews` true in the RV-A storefront answer.
24. The adapter adds `reviewCount: 0` for a product without reviews.

RV-B:
1. The consent check removed at the decision; 1b at send.
2. The consent accepts `terms` alone.
3. `reviewRequest: false` written into the frozen JSON.
4. The suppression check removed at the decision and at send; 4b the consumer's last check.
5. The `order_closed` check removed; 5b at send.
6. The withdrawal check removed.
7. The `requests_enabled_at` term removed.
8. The first-row `NOT EXISTS` removed.
9. The late limit removed.
10. `ORDER BY` descending, or the `LIMIT` removed.
11. The add-on check removed.
12. The switch check removed.
13. `nothing_to_review` removed.
14. The token's signature not verified.
15. The tenant left out of the signed message.
16. The purpose ignored (an unsubscribe token submits a review).
17. Link expiry not applied to resolve or submit.
18. Link expiry applied to unsubscribe.
19. One 404 case with different bytes.
20. The resolve answers a name or the order id.
21. Submit accepts a product of another order.
22. Submit accepts a product that is no longer public.
23. The UNIQUE dropped: a second review of one product per order.
24. Auto mode publishes a flagged review.
25. Manual mode publishes a clean one.
26. Rating 0, 6 or 4.5 accepted.
27. A title over 100 cut instead of refused.
28. The body cap removed.
29. The rate limit removed.
30. Submit accepted with the add-on off.
31. The List-Unsubscribe headers dropped, or the From not cleaned.
32. `review_request` missing from the ledger CHECK.
33. `STOREFRONT_BODY_REVISION` left at 3.
34. The storefront flag ignores the switch.
35. `buildCheckoutRequest` always sends `reviewRequest`.
36. A decision writes to `orders`.

#### 10.4 Gates (each unit, at the end)

The AC set (`CP9_AC_REPORT.md:1297-1308`):
- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`.
- `npx vitest run`: the summary line, only added tests.
- `npm run types:check`.
- `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs`.
- The three builds with `check-storefront-build.mjs` and `check-admin-build.mjs`.
- `node guard/guards.test.mjs` (RV-A: 292 unchanged; RV-B: 290).
- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`.
- **The design gate.** RV-A: the product page with reviews and with none, a card with stars, the admin page in each filter, at 375 px and desktop. RV-B: the checkout contact step (a shop with the add-on off pixel-identical; one with requests on with the box), the review page in each state, the unsubscribe page, the settings card. Looked at, not only taken (NORD for the storefront, the admin's neutral system).
- Codex as second reviewer before each deploy (the owner's rule).

#### 10.5 Staging smoke of RV-A (no mail account)

After the reviewer's yes; production never.
1. `scripts/cf-preflight.sh staging`; bookmark; apply migration A; deploy API, web, admin. `GET /ready` names it. `GET /_api/<shop>/v1/products/<id>` answers `ETag: "<v>-r1"` (or `-c-r1`) with the body unchanged.
2. `SELECT tenant_id, enabled FROM tenant_features WHERE feature_key = 'productReviews'`: a shop without a row now reads off. The admin has no "Recensioner"; `/v1/admin/reviews` answers 404.
3. As the platform user, turn "Recensioner" on for the slice shop in Tillägg. The admin page shows "Inga omdömen ännu."; the storefront is unchanged; `GET /v1/storefront` still says `productReviews: false`.
4. **One seeded review, staging only.** Without RV-B no review can be written through the product, so one row is inserted by `wrangler d1 execute --remote` for a product of a paid staging order (the AC smoke's paid order), `state 'published'`. This is a write to staging D1; it needs the operator's go even with staging autonomy. Then:
   - the product read carries `reviews: { count: 1, ratingSum: … }` and a new version;
   - the product page shows the block, the statement and the review; the card shows stars;
   - `curl` of the product page's HTML has `AggregateRating`;
   - `GET /_api/<shop>/v1/products/<id>/reviews` lists it.
5. In the admin: "Avpublicera" → the storefront drops it after a reload (a new ETag, no 304); an audit row; "Publicera" again.
6. The platform takedown by `curl` → the seller sees "Borttagen av plattformen" and no button; a publish answers 409.
7. Turn the add-on off → the block, the stars and the JSON-LD are gone; the list and admin routes answer 404.
8. Look at the block, a card and the admin page at a phone width.

#### 10.6 Staging smoke of RV-B (no mail account)

1. Deploy as above; migration B; `GET /v1/storefront` `ETag "<v>-r4"`, body unchanged for a shop with the add-on off.
2. The settings card: off, 7, "Publicera … direkt", count 0, the amber no-mail notice. Turn requests on.
3. The checkout contact step shows "Be mig om ett omdöme via e-post efter leveransen"; switch off once, gone after a reload; on again.
4. Four test buyers pay with 4242: A ticks the review box; B ticks nothing; C ticks the marketing box only; D ticks the review box and is refunded in full afterwards.
5. D1 right away: `json_extract(consent_json,'$.reviewRequest')` is 1 for A and D, NULL for B and C.
6. The seller marks all four shipped.
7. **The minimum delay is 3 days.** The decisions can only be read after 3 days and 15 minutes; the test suite's cron tests are the proof until then. On day 3: A `queued`; B `skipped/no_consent`; C `queued`; D `skipped/order_closed`; `email_deliveries` `review_request` rows `pending` (and they stay so, §5.4); `outbox_events` `email.review_request` `done` with `{"requestId": …}` only.
8. The routes with a forged token (no real link exists without mail): resolve, submit and unsubscribe answer 404, a garbage token the same bytes; the 31st call within 10 minutes 429; a GET refused by the web Worker.
9. The pages with a forged token: `/<shop>/recensera/x` → "Länken går inte att använda längre."; `/<shop>/avregistrera-recensioner/x` → "Länken fungerar inte längre." with the shop's address line; both `noindex`.
10. Switch off; a new shipped order → no row after its delay.

#### 10.7 What must wait for a mail account

A Resend key and `EMAIL_FROM` on staging (waiting for Mikael):
- the mail in Gmail and Outlook: sender, Reply-To, product names, no price, the links, the footer;
- the real review link: resolve, a published review on the storefront, a flagged one waiting, a 409 on a second try, manual moderation;
- Gmail's one-click unsubscribe, then a new order of that address → `skipped/unsubscribed`;
- that Resend accepts the `headers` member.

### 11. Decisions for Mikael

Yes / no; "defaults" accepts all. **Legal** marks those whose source is the old code, your note or general practice, not verified law.

| # | Question | Recommended | Alternative |
|---|---|---|---|
| RV1 | Bring "Recensioner" back on Cloudflare (reverse D81 for this feature only)? | **Yes** | No: it stays PORT-LATER. |
| RV2 | Make the add-on opt-in per shop, importer in lockstep (robowatz on; gif-sundsvall, ninetone and sillmans off although on in Firebase; melodie-mc off)? Every add-on is then opt-in. | **Yes** | Keep the default ON: four of five shops get reviews at once. |
| RV3 | Give the seller their own switch for the request mails, off by default, and ask only about orders first sent after it was turned on? | **Yes** | The add-on alone (Firebase): turning it on would mail buyers of orders up to 180 days old. |
| RV4 | **Legal.** Send a request only when the buyer ticked a new box "Be mig om ett omdöme via e-post efter leveransen" OR the marketing box (your reminder rule)? | **Yes** | (a) Every buyer, with an unsubscribe link in each mail (Firebase); (b) every buyer, after a line at checkout and a box to refuse. |
| RV5 | **Legal.** Use the wording of §2.5 (box), §5.2 (mail), §8.2 (the statement under the reviews) and §7.3–7.4 (the admin notes)? | **Yes** | Kent or a lawyer words them first. |
| RV6 | The clock: the first "Skickad" (the printer's automatic one counts) or "Redo att hämtas"; delay 3–21 days, default 7; never more than 7 days late? | **Yes** | Pickup orders counted from "Levererad" / "Slutförd" (they may never be marked). |
| RV7 | No request for a cancelled or fully refunded order (Firebase), nor for an order with an accepted withdrawal (new)? | **Yes** | Ask after a withdrawal too. |
| RV8 | **Legal.** A written review stays published if its order is later refunded or cancelled, and the link keeps working after a refund? | **Yes** | Hide such reviews automatically (they are mostly unhappy buyers'). |
| RV9 | One request per order, no further limit per buyer (Firebase)? | **Yes** | At most one per buyer per shop per 30 days (later orders then cannot be reviewed). |
| RV10 | The review link works 180 days (Firebase), the unsubscribe link forever; signed with the same secret as the reminders? | **Yes** | 60 days; a dedicated secret (rotating the shared one ends every link). |
| RV11 | A review: rating 1–5 required, an optional title (new, ≤ 100), an optional text (≤ 2000, line breaks kept), a name (≤ 60) or "Anonym"; one per product per order; final? | **Yes** | No title (Firebase); editable by the buyer. |
| RV12 | Publish a clean review at once; hold one with a link, an e-mail address or a word of Firebase's 14 (title and name screened too); the seller may choose "Granska varje omdöme"; the filter never rejects? | **Yes** | Always moderate first; no filter. |
| RV13 | **Legal.** The seller publishes and hides (never deletes); the platform removes (final, audited, with a reason); the reviewer is not told for now? | **Yes** | Tell the reviewer why (a DSA statement of reasons may be owed, not verified). |
| RV14 | The seller's list shows no address and no order number (Firebase)? | **Yes** | Link each review to its order. |
| RV15 | Leave out for now: seller replies, CSV export, a "report this review" link, a console page for takedowns, buyer edits, photos, a second request? | **Yes** | Build some of them. |
| RV16 | Stars and count on product cards, and `AggregateRating` only in the structured data (Firebase), no individual reviews there? | **Yes** | Product page only; or add `Review` items. |
| RV17 | Show reviews only while the platform's add-on is on (Firebase showed them even when off)? | **Yes** | Always show published reviews. |
| RV18 | **Legal.** While the add-on is off the review link answers "the link no longer works" and accepts nothing; unsubscribe always works? | **Yes** | Accept reviews whatever the add-on (Firebase). |
| RV19 | **Legal.** The mail shows the shop's name as sender, replies go to the shop, one-click unsubscribe; unsubscribing is permanent for that shop and separate from the reminders' unsubscribe; Swedish only? | **Yes** | One shared unsubscribe for all of a shop's mails; English for English visitors. |
| RV20 | A platform user acting as the shop may moderate and change the switch (audited)? | **Yes** | Only the shop's own admin. |
| RV21 | Fix the console's new-shop preset, which turns discount codes, reminders and reviews on for every new shop (F13): send only the shop type's `pod`? | **Yes** | Keep the preset. |
| RV22 | Build in two units: RV-A (reviews, display, moderation) first, then RV-B (requests, the review page, the checkout box)? | **Yes** | One unit of about 1.8 reminder units. |

### 12. Risks, what is left out, and what I found wrong

#### 12.1 Risks

1. **R1 — A forwarded mail.** Whoever holds the link can review each product of that order once, under any name. Bounded by one per product per order, the 180 days, and the seller's moderation.
2. **R2 — Rotating `BETTER_AUTH_SECRET`** ends every review link already mailed (up to 180 days old) and every unsubscribe link (RV10).
3. **R3 — A suspended or unpublished shop's pages are unreachable**: its review and unsubscribe links answer 404 until it is public again (as the reminder's R3, `CP9_AC_REPORT.md:1052`).
4. **R4 — Low volume under RV4.** Only buyers who ticked a box are asked; fewer reviews than Firebase would have collected.
5. **R5 — Legal, not verified:** whether a review request is marketing (MFL 19 §); what the Omnibus rules require of the statement and of moderation; the DSA's notice-and-action and statement-of-reasons duties and who carries them; Google's structured-data policies; whether an incentive may ever be offered.
6. **R6 — Erasure.** Reviews cannot be deleted (trigger), and an erasure request today can only be met by a platform takedown, which keeps the text. D68 must add an erasure path that blanks or deletes the content.
7. **R7 — A seller hiding negative reviews.** The platform sees it only in the audit rows; the legal exposure is the shop's (§7.3's note).
8. **R8 — A repeat buyer** can review the same product once per order (Firebase too).
9. **R9 — Sender reputation**: every shop's requests leave from the platform's one domain (the reminder's R9).
10. **R10 — Staging cannot show a real link** until mail exists; RV-A's display smoke needs one seeded row (§10.5), and RV-B's decisions need three days (§10.6).
11. **R11 — Held mails are lost on staging after ~40 minutes** (`CP9_AC_REPORT.md:1152`, `:1265`); in production the same is true of every kind during a long Resend outage.
12. **R12 — catalog_version is bumped by every submission and moderation**, so every cached catalogue body of the shop revalidates once. Cheap at this scale.
13. **R13 — Two Product JSON-LD blocks** on one page (server and client, F12); both carry the same rating after this unit.

#### 12.2 Left out

Seller replies; CSV export (Firebase had neither); a "report this review" link; a console page for takedowns; buyer edits or deletion; photos; helpful votes; sorting other than newest first; the variant bought shown on the review; reviews per variant; a second request mail; a notice to the seller of a review waiting; import of Trustpilot or CSV reviews; English; links on a shop's own domain (CP7); a notice to the reviewer when a review is hidden (RV13); the 200-day purge (D68).

#### 12.3 Found wrong in the existing code

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **One token for writing a review and for unsubscribing.** The same raw token is in the review link and the unsubscribe link, and the unsubscribe URL is also sent as `List-Unsubscribe`, which mail providers and clients read. Whoever sees that header URL can post a review in the buyer's name. | `sweep.ts:183-184`; `EmailOrchestrator.ts:316-333`; `callables.ts:145-147` | Medium (old build; 0 requests in production by the export). Fixed by §2.2. |
| F2 | **The one-click unsubscribe pointed at a page.** `List-Unsubscribe-Post: List-Unsubscribe=One-Click` named `/{shopId}/avregistrera-recensioner/{token}`, which unsubscribes only when its JavaScript runs (the reminder's F1). | `sweep.ts:29-32`, `:184`; `EmailOrchestrator.ts:316-327`; `ReviewUnsubscribePage.jsx:27-43` | Medium. Fixed by §5.3 and §6.4. |
| F3 | **The unsubscribe always claimed success**: an unknown token answers success, a failed write is swallowed, and the page says "Du är avregistrerad" whatever happened. | `callables.ts:216-243`; `ReviewUnsubscribePage.jsx:31-41` | Medium. Fixed by §6.4 and §8.5. |
| F4 | **Turning the add-on on mailed old buyers.** The trigger writes a request for every B2C order whatever the add-on, and the sweep checks the add-on only when sending, with no lower bound but the 180-day expiry. A shop whose add-on was off and then turned on would mail every buyer of the last six months. | `writeReviewRequest.ts:45-166` (no feature check); `sweep.ts:91-103`, `:124-137` | Medium (old build). Fixed by RV3. |
| F5 | **No consent asked for the request mail**, and no text at checkout tells the buyer one will come. | `sweep.ts:118-158`; `git show main:src/pages/shop/Checkout.jsx` (searched) | Legal, not verified. RV4. |
| F6 | **The add-on check failed open**, as for every Firebase add-on. | `shopFeatures.ts:21`, `:42-48` | Low. Not ported. |
| F7 | **Reviews stayed on the storefront with the add-on off.** The product page, the block and the cards read `reviewCount` with no feature check; resolve and submit ignore the add-on too. | `PublicProductPage.jsx:865`; `ProductReviews.jsx:54-75`; `NordProductCard.jsx:77-78`; `callables.ts:78-203` | Low. RV17, RV18. |
| F8 | **Line breaks were stripped from every review**: `sanitizeText` removes `\x00-\x1F`, newline included, so `whitespace-pre-line` in the block never applied. | `callables.ts:59-61`; `ProductReviews.jsx:162` | Low. §6.3. |
| F9 | **The aggregate write could create a stub product.** `products/{productId}` is written with `set(…, { merge: true })`, which creates the document if the product was deleted. | `callables.ts:189-199`, `:306-316` | Low. No counter on Cloudflare. |
| F10 | **The legacy Trustpilot section marks every scraped row "Verifierat köp"** and reads a missing rating as 5, a claim the shop cannot back. The fabricated five-star tile is DESIGN_CONTRACT IN-1. | `csvReviews.js:31`, `:45`; `ReviewsSection.jsx:163-167`; `docs/cf-port/DESIGN_CONTRACT.md:358` | Low on Cloudflare (already replaced by an empty list). Not ported. |
| F11 | **The filter holds positive reviews**: "fan" matches English "a big fan" and "skit" matches "skit bra". Advisory only, so it costs moderation work, not a lost review. | `contentFilter.ts:17-23` | Low. Kept (RV12). |
| F12 | **Two Product JSON-LD blocks on Cloudflare's product page**: the web Worker writes the server's into the head and the client adds its own through Helmet. Not verified how search engines merge them. | `cloudflare/web/src/html.ts:81-83`; `seo.ts:835-864`; `PublicProductPage.jsx:521` | Low. Noted (R13). |
| F13 | **The console's new-shop preset turns opt-in add-ons on.** `discountCodes`, `abandonedCheckout` and `productReviews` are `true` in the preset, and the admin build writes them as explicit rows for every new shop, so DC2 and AC2 do not hold for a shop made in the console. | `src/components/platform/ProvisionShopModal.jsx:31-43`, `:47-59`; `src/admin-app/replacements/provisionShopData.js:37-48`; `src/admin-app/adapters/platformShops.js:169-178` | Medium (a new shop gets add-ons the platform did not choose). RV21. |
| F14 | **Texts say "after delivery" where the clock starts at shipping.** | `AdminSettings.jsx:1115-1121`; `src/config/addons.js:34`; `writeReviewRequest.ts:22` | Copy. §7.4, §9.3. |
| F15 | **The old admin note states a legal rule as fact** ("Enligt lag måste moderering vara enhetlig") with an em dash. | `AdminReviews.jsx:230-235` | Copy, legal not verified. §7.3. |

Seen, outside scope:
- `PublicProductPage.jsx:95` keeps a placeholder `useState(16)` review count, passed as a prop that `ReviewsSection` does not accept (`ReviewsSection.jsx:7-14`). Dead; harmless.
- The guard allowlist's "never add a line" rule and its practice differ (CP8-DC's F11, `CP8_DC_REPORT.md:837`); RV-A swaps one line, as CP8-DC did.
- The importer's `checkoutSuppressions` transform is still unbuilt (`CP9_AC_REPORT.md:1258`).
