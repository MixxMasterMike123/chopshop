# CP1-B report — Hono router, entrypoints, active shop + acting-as, password reset via Resend, guest receipts, R2 jurisdiction

Branch `cf-port`, worker in `cloudflare/`. Nothing committed and nothing deployed (reviewer commits). No `wrangler` command reached Cloudflare.

**Tests:** baseline `npm run check` green at **916 tests / 26 files** → final **1094 tests / 31 files**, green (types:check, tsc, vitest). Guard (`node --test guard/guards.test.mjs`) passes; forbidden-string grep over every new/changed file is clean.

```
 Test Files  31 passed (31)
      Tests  1094 passed (1094)
   Start at  20:45:08
   Duration  31.98s (transform 21.90s, setup 214.25s, import 1.73s, tests 22.99s, environment 1ms)
```

| Stage | Tests after | Delta |
|---|---|---|
| Baseline | 916 | — |
| 1 Hono router | 916 (+116 temporary parity cases, deleted after stage 2) | 0 |
| 2 Entrypoints | 931 | +15 `entrypoints.test.ts` |
| 3 X-Shop-Id + acting-as | 975 | +38 `acting-as.test.ts`, +6 active-shop cases in `admin-catalog.test.ts` |
| 4 Origins + reset + consumer | 1063 | +26 `origins`, +19 `password-reset`, +39 `email-queue-consumer`, +5 net `auth-routes`, −1 (`disabled-email-queue.test.ts` removed) |
| 5 Receipts | 1092 | +29 `receipts.test.ts` |
| 6 R2 jurisdiction | 1094 | +2 in `pod-artwork.test.ts` |

---

## Stage 1 — Hono router, zero behaviour change

**Files:** `src/app.ts` (new; all handler functions from the old `index.ts` moved verbatim, plus `createApp()`), `src/lib/responses.ts` (new; the shared `notFoundResponse`/`invalidRequestResponse`/`rateLimitedResponse`/`decodeSegment`/`readJsonBody`, moved verbatim), `src/index.ts` (now only the entry exports + re-exported rate-limit constants), `package.json`/`package-lock.json` (`hono` **4.13.9**, exact).

Decisions that keep the route table identical:
- **Routing on the raw pathname.** Hono's default `getPath` runs `decodeURI` on any path containing `%`, so `/v1/%70roducts` would route as `/v1/products`. `getPath` is pinned to `new URL(request.url).pathname`, which is what the if-chain compared.
- **Every route is `app.all(path)`, in the old order.** The five routes whose method check lived in the dispatcher (`/health`, `/ready`, `/v1/storefront`, `/v1/products`, `/v1/products/*`) are wrapped in `getOnly()`, which falls through (`next()`) on any other method exactly as the chain did. It checks the **raw** method, so Hono's HEAD→GET routing cannot make HEAD a 200.
- **Errors rethrow** (`app.onError(e => { throw e })`). The webhook suite pins that a D1 fault makes the handler *reject* (Stripe retries); Hono's default would have returned a 500.
- The Better Auth namespace stays the last resort (`app.all("*")` → `handleAuthRoute` → else 404).
- The Stripe raw body is untouched: nothing reads `c.req` beyond method/URL; handlers get `c.req.raw`.

**Verification:** before rewriting, the old `index.ts` was copied aside and a temporary parity suite ran old vs new over 58 paths × 2 hosts × 7 methods (status, body, `content-type`/`cache-control`/`retry-after`/`x-content-type-options`/`location`): 116/116 identical. Then all 916 existing tests passed with **no test edits**. Harness and copy deleted after stage 2.

**Only observable difference:** a HEAD response now has an empty body (Hono strips it). Status and headers are unchanged, and over HTTP a HEAD body is never sent anyway.

## Stage 2 — Two entrypoints + header stripping (PLAN §2.1)

**Files:** `src/index.ts`, `src/app.ts`, `src/lib/tenant-headers.ts` (new), `test/entrypoints.test.ts` (new).

- `export default { fetch, queue }` is the public entrypoint: `stripTenantHeaders()` removes every header matching `/^x-tenant-/i` before routing. It returns the *same* Request object when there is nothing to strip (the common case, and the webhook's raw body stays on the runtime's object).
- `export class Internal extends WorkerEntrypoint<Env>`: `fetch(request)` strips the same way (chopshop-web relays browser headers) and runs the app built with `surface: "internal"`. The tenant resolves from the received request's hostname exactly as before.
- The surface is set per app instance (`createApp({ surface })`, one router each), not read from the request. Storefront routes (`/v1/storefront`, `/v1/products*`, `/v1/checkout*`, and stage 5's receipt/order routes) go through `storefront()`, which serves `internal` always and `public` only while **`PUBLIC_STOREFRONT_ALLOWED = true`** (TODO constant in `src/app.ts` pointing at PLAN §2.1). Flipping it makes those routes 404 on the public entrypoint; that is tested with `createApp({ publicStorefrontAllowed: false })`.
- **How "the header never reaches handlers" is proven without a test-only route:** the app itself refuses (opaque 404) any request that still carries an `X-Tenant-*` header. So a public request with `X-Tenant-Id: <other shop>` can only be served as the *hostname's* shop if the entrypoint stripped the header first. A mutation check with the strip removed failed all 6 entrypoint tests.
- **The named entrypoint is tested for real:** `exports.Internal.fetch(...)` from `cloudflare:workers` works in pool 0.21.3, so no direct-instantiation fallback was needed.

## Stage 3 — Explicit active shop + acting-as (PLAN §2.1)

**Files:** `migrations/0013_acting_as.sql` (new), `src/platform/acting-as.ts` (new), `src/routes/acting-as.ts` (new), `src/auth/request-authorization.ts`, `src/auth/live-authorization.ts`, `src/catalog/admin-catalog.ts`, `src/commerce/admin-discount-codes.ts`, `src/pod/artwork-store.ts`, `src/app.ts` (`REQUIRED_MIGRATION` → `0013`, then `0014` in stage 5).

**Contract change:** `authorizeTenantAdminRequest` no longer consults the hostname. The active shop is `X-Shop-Id`, parsed with the tenant-id grammar before any session or DB work. It is accepted when either:
- the session user has an active `admin` membership in that shop (identity and shop both active), or
- the session user is a live `platform_admin` holding an unexpired, unrevoked acting-as grant on that shop (and the shop is active).

A missing, malformed, unknown or unauthorised header gets the same null, and therefore the same opaque 404.

**Acting-as:**
- Table `acting_as_grants(id, platform_user_id, tenant_id, created_at, expires_at, revoked_at, reason)`. Times are **ISO-8601 TEXT** (§2.8).
  - Shape CHECK: `x IS strftime('%Y-%m-%dT%H:%M:%fZ', x)`. A GLOB would read more naturally, but D1 caps GLOB pattern length ("pattern too complex").
  - Triggers: tenant immutable, terms immutable, revocation final, no delete.
  - Indexes: `(platform_user_id, tenant_id, expires_at)` and `(tenant_id, created_at DESC)`.
- `POST /v1/platform/tenants/:tenantId/acting-as` (platform session + same-origin):
  - Optional body `{ reason }`, 1–500 characters.
  - Active shops only.
  - Mints a 60-minute grant plus an `audit_events` row (`acting_as.granted`, actor = platform user, resource = tenant, `metadata {grantId, expiresAt}`) in one batch.
  - Returns 201 `{ tenantId, expiresAt }` and no grant id: the client just sends `X-Shop-Id`.
- `DELETE …/acting-as` revokes the **caller's own** live grants on that shop (a colleague's are untouched) and audits `acting_as.revoked` with `{grantIds}`. Returns 204, or 404 when there was nothing live.
- The returned principal carries `actingAs: { grantId }`. The three tenant-admin audit writers (catalog, discount codes, POD artwork) now add `actingAsGrantId` to `metadata_json` through `auditMetadataJson()`. A member admin's audit metadata is byte-identical to before (tested).
- The tenant segment is taken from the raw pathname, not `c.req.param()`, which percent-decodes and would double-decode (`%2574…`, tested).

**Test changes (deliberate):**
- The admin request helpers in `admin-catalog`, `admin-discount-codes`, `object-routes` and `pod-artwork` now send `X-Shop-Id` for the shop their fixture host stood for (`SHOP_BY_HOST`), overridable per call. Three hand-built requests got the header inline. Every existing cross-tenant assertion keeps its meaning (admin B + shop B header + A's product id → 404).
- `provision-tenants`/`provision-users` pass `shopId` on their two admin-write calls.
- `request-authorization`: "binds tenant authorization to both session and request hostname" was rewritten as "…the session and the X-Shop-Id it names". It now pins the new contract: shared admin host, header decides; the host carries no authority.
- `health`/`public-catalog`: the `/ready` migration pin was bumped.
- New admin-catalog cases: the hostname is ignored, and a missing/malformed/unknown/foreign `X-Shop-Id` → 404.
- New `acting-as.test.ts`:
  - Only a platform admin can mint; missing or cross-site Origin refused; audit rows written.
  - The grant opens only its shop; no grant → 404.
  - Expired → 404; revoked → 404 immediately; demoted platform admin → 404; suspended shop → 404 (and back after reactivation).
  - Body validation; schema triggers.

## Stage 4 — Origin allowlist, password reset through the email queue with Resend

**Files:**
- New: `src/lib/origins.ts`, `src/auth/password-reset.ts`, `src/email/email-queue-consumer.ts`, `src/queues.ts`.
- Changed: `src/auth/create-auth.ts`, `src/auth/auth-routes.ts`, `src/email/email-delivery-store.ts`, `src/env.d.ts`, `src/index.ts`, `vitest.config.ts`, `test/env.d.ts`.
- Deleted: `src/email/disabled-email-queue.ts` and `test/disabled-email-queue.test.ts` (replaced; their assertions — hold with a 300 s retry, never log a body — live on in the new dispatcher tests).

**Origins:** `parseCanonicalOrigins` accepts the object var or a JSON string and requires exactly `{api, web}`. Each value must satisfy `new URL(v).origin === v` and be https. That rejects paths including a bare trailing `/`, query, fragment, credentials, an explicit `:443`, and an uppercase host; an unknown key is also refused. `canonicalOrigin()` throws; `readCanonicalOrigins()` returns null for the route gates. Errors never echo the value.

**Better Auth endpoints mounted — verified against the installed 1.6.29, not guessed.** Defined in `node_modules/better-auth/dist/api/routes/password.mjs` and registered in `dist/api/index.mjs` (lines 120–131):
- `POST /api/auth/request-password-reset` (body `email`, `redirectTo?`; always 200 `{status:true, message}`)
- `GET /api/auth/reset-password/:token` (`?callbackURL=`; 302 to `callbackURL?token=` or `?error=INVALID_TOKEN`)
- `POST /api/auth/reset-password` (body `newPassword`, `token`)

`/forget-password` does not exist in core 1.6.29 (only in the uninstalled email-otp plugin) and stays unmounted (still tested 404). Allowlist and gate:
- The reset routes exist only when the auth secret, the `EMAIL_QUEUE` binding and valid `CANONICAL_ORIGINS` are all present; otherwise they give the same 404 as unmounted routes (tested for each missing piece).
- The link segment is held to `[A-Za-z0-9_-]{16,128}`.

**Request path:**
- Per-IP limit 5 / 10 min runs before the body is read; per-email limit 3 / hour runs on the normalised address. Both count known and unknown addresses alike.
- The request Better Auth sees is **rebuilt**: only `{ email, redirectTo: <web>/reset-password }`. A client-sent `redirectTo`/`callbackURL` never reaches it.
- The emailed link's `callbackURL` is **overwritten** with the canonical web page before Better Auth sees the GET.
- `resetPasswordTokenExpiresIn` is 1 h.
- `sendResetPassword` sends nothing inline. It builds the link from `AUTH_BASE_URL` + token + canonical web origin (never from the request, and never from the `url` Better Auth offers), then:
  - creates the job with `createAuthEmailJob` (kind `password_reset`, locale `sv`, validated against `AUTH_BASE_URL`),
  - records a `pending` row with `recordAuthEmailDelivery` (new; the same insert-if-absent + fingerprint the claim uses),
  - sends `EMAIL_QUEUE.send(job, {contentType:"json"})`.
- The hook never throws, because a 500 only an existing account could produce would be an account oracle. If the enqueue fails, the ledger row is closed `failed/E_ENQUEUE` (`abandonAuthEmailDelivery`).
- The known-vs-unknown response is tested byte-identical.
- **The queue message carries the whole job, not just the delivery id.** The ledger (0003) by design stores no recipient, URL or token, so an id alone could not be rendered. The producer-recorded fingerprint binds the message to what was recorded.

**Better Auth IP header (bug fix; changes existing behaviour):** Better Auth's own limiter keyed on `X-Forwarded-For` by default. That header is caller-controlled — the repo's own `clientIp()` test says so — so the sign-in limiter was bypassable by rotating it. With no header it falls back to one shared bucket, which would have been 3 reset requests per minute platform-wide. It now keys on `cf-connecting-ip`. The canonical web origin is also added to Better Auth's `trustedOrigins` (it validates the redirect against that list).

**Consumer** (`src/email/email-queue-consumer.ts`):
1. Parses the job; a malformed one is logged without its body and acked.
2. Claims the ledger row with the existing lease (`not_claimed` → retry 30 s; any terminal status → ack, so no second send).
3. Renders with `renderAuthEmail` (Swedish).
4. `POST https://api.resend.com/emails` with `Bearer RESEND_API_KEY`, `Idempotency-Key: <deliveryId>` (closes the crash-after-send window; Resend dedupes for 24 h, longer than any job lives), `from: EMAIL_FROM`.
5. Handles the answer:
   - 2xx → `sent` + provider id, ack.
   - 408/409/429/5xx/network → ledger back to `pending` with `next_attempt_at`, then `message.retry({delaySeconds})`. Uses Retry-After when present, else 30 s × 2^(attempts−1), capped at 1 h. 409 counts as retryable because Resend returns it for concurrent requests under one idempotency key.
   - Other 4xx → `failed` (new `failAuthEmailDelivery`), ack.
6. Missing or malformed `RESEND_API_KEY`/`EMAIL_FROM` → no attempt, log, `retryAll({delaySeconds:300})`, ledger untouched.

HTTP goes through the `RESEND_FETCH_OVERRIDE` symbol seam (same convention as the Stripe seams). "Sent at" is the existing `resolved_at` on a `sent` row; no new column.

**Queue dispatch** (`src/queues.ts`): one `queue()` export, routed by **suffix** of `batch.queue`:
- `-email` → the consumer.
- `-outbox` and `-render-jobs` → held (`retryAll` 300 s, bodies never read), since there are no consumers yet.
- Anything else → held. That includes the legacy `…-email-auth` queue (`AUTH_EMAIL_QUEUE` stays declared optional, unused) and any `-dlq`.

**Test infrastructure** (`vitest.config.ts`, `test/env.d.ts`):
- Queues: `queueProducers` `EMAIL_QUEUE`/`OUTBOX_QUEUE`/`RENDER_JOBS_QUEUE` → `chopshop-test-{email,outbox,render-jobs}`, plus `queueConsumers` for all three.
- Bindings:
  - `CANONICAL_ORIGINS` (`https://api.test.invalid` / `https://web.test.invalid`), `RESEND_API_KEY`, `EMAIL_FROM`.
  - `APP_ENV`, `AUTH_BASE_URL`, `AUTH_TRUSTED_ORIGINS`, `SERVICE_NAME`, pinned to their current values so the suites do not depend on which env section of `wrangler.jsonc` carries them.
  - Stage 6's `R2_JURISDICTION`.
- A miniflare **`outboundService` that refuses all outbound HTTP** (599). It is a backstop so no test can reach api.resend.com (or any API) even if a seam were missed. All 1094 tests pass with it, so nothing relied on the network.

**Contract change in `auth-routes.test.ts`:** `POST /api/auth/reset-password` moved out of the "unmounted" list because it is now mounted. The list gained the negative space around the new routes: token-less and short links, wrong methods, trailing slashes; `/forget-password` stays.

**Tests:**
- End to end: request → ledger `pending` → job link = `AUTH_BASE_URL` + `callbackURL=<web>/reset-password` even when the client sent evil `redirectTo`/`callbackURL` → consumer sends through the fake Resend (headers/body checked) → `sent` → redelivery sends nothing → link 302s to the web page even with a tampered `callbackURL` → reset → old password 401, new 200, old session revoked → token replay 400.
- Real `EMAIL_QUEUE` binding used when nothing is injected.
- Both rate limits.
- Per-outcome consumer tests (happy, 429 + Retry-After, 5xx/408/409 backoff, network, 400/401/403/422 permanent, expired job, malformed job, duplicate within one batch, missing key/from); one test on the pool's real `MessageBatch` (`createMessageBatch`/`getQueueResult`). The pool's result drops `delaySeconds`, so the delay assertions use a recording batch.
- Suffix routing.

## Stage 5 — Guest receipt capability (PLAN §2.1 + §2.3)

**Files:** `migrations/0014_receipt_tokens.sql` (new), `src/commerce/receipts.ts` (new), `src/routes/receipts.ts` (new), `src/commerce/webhook.ts`, `src/app.ts`.

**Schema:**
- `orders` gains `receipt_token_hash` (64 lowercase hex) and `receipt_token_expires_at` (ISO TEXT), with triggers requiring both-or-neither, plus index `(tenant_id, receipt_token_hash)`.
- New `order_receipt_handoffs(checkout_id PK, tenant_id, order_id UNIQUE, receipt_token, expires_at, created_at)`. Triggers:
  - tenant immutable,
  - write-once (no UPDATE),
  - tenant/checkout must match the order.

**Design (the single-read hand-off), and why:** the order is born in the webhook, which has no browser to answer. Two alternatives were rejected:
- Minting at checkout creation would put the only copy in a response the idempotent-replay path must re-serve unchanged, which cannot be done without storing the raw token anyway.
- An encrypted stored token needs key management for no gain.

So:
1. **Mint** in the webhook's existing single batch: 32 random bytes → base64url (43 chars). SHA-256 hex plus a 30-day expiry go on the order row; the raw token goes into a hand-off row keyed by the checkout id with a **1-hour** TTL. A rolled-back or duplicate delivery leaves neither behind.
2. **Hand off** via `POST /v1/checkout/:checkoutId/receipt` (storefront route; tenant from hostname; the checkout id is the capability, the same trust model as the payment route; per-IP 60/min, which fits the §2.9 2-second poll). One batch runs a bounded sweep of expired hand-offs, then `DELETE … WHERE checkout_id=? AND tenant_id=? AND expires_at>? RETURNING`, so exactly one poll receives the token and the raw value then stops existing server-side. Responses:
   - `{receipt:{status:"pending"}}` — checkout still open;
   - `{receipt:{status:"ready", orderId, receiptToken}}` — once;
   - `{receipt:{status:"issued"}}` — already taken or lapsed;
   - 404 — anything else, including another shop's hostname, which also does not consume the token.

   It is POST, not GET, because a read that deletes state is one prefetch away from losing a receipt.
3. **Read** via `GET /v1/orders/:orderId` with `Authorization: Bearer <token>`: tenant from hostname, a UUID order id, per-IP 30/min (counted before the token check, so probing costs the same as reading). One query must match tenant + order + hash + unexpired. Every miss is the same 404 (`Order not found`).

**Buyer schema, built field by field from named columns:**
- `{ orderId, orderNumber, status, createdAt (ISO), currency, items[{name, quantity, unitPriceMinor, lineTotalMinor}], totals{subtotalMinor, shippingMinor, discountMinor, vatMinor, totalMinor}, delivery{method, country}, email (masked "b***@domain") }`.
- `orderNumber` goes beyond the brief's list; it is the buyer-facing reference printed for support. Say if you want it dropped.

**Tests:**
- Minting in the batch (hash matches the handed-off token; 30-day expiry); tokens unique.
- pending → ready once → issued; 6 concurrent polls → exactly one `ready`.
- Cross-shop claim → 404 without consuming; GET claim → 404 without consuming; swept after 1 h.
- Reads: exact key sets; a **recursive denylist walk** (`cost, printer, connect, snapshot, production, stripe, application_fee, applicationfee, withhold`) plus value checks (no intent id, checkout id, raw email, tenant id, SKU, product id, token).
- 404 for: another shop's hostname, another order's token, expired, no/wrong/malformed/lowercase-scheme/Basic credentials, non-UUID or unknown id, write method.
- Per-IP limit; schema triggers.
- **Mutation checks:** adding a `productionCostMinor` field failed the denylist test; dropping the tenant predicate failed the cross-shop test.

## Stage 6 — R2 EU jurisdiction (reviewer addendum)

**Files:** `src/pod/render-farm-client.ts`, `src/env.d.ts`, `vitest.config.ts`, `test/env.d.ts`, `test/pod-artwork.test.ts`.

- `r2S3Endpoint(env)` returns `https://{account}.eu.r2.cloudflarestorage.com` when `R2_JURISDICTION === "eu"`, and the plain host when it is unset or empty. Both still satisfy the farm's `.r2.cloudflarestorage.com` suffix allowlist.
- **Any other value makes `isPodConfigured` false**, so the POD surface goes dark instead of signing for the wrong jurisdiction. This interprets "otherwise the plain host" as "when unset" under the fail-closed rule; tell me if you want an unknown value to fall back to the plain host instead.
- Tests: the binding is `"eu"`; the existing presigner assertion now expects the `.eu.` host; new tests cover the non-EU default host and the fail-closed behaviour for unknown values (`EU`, `fedramp`, `eu `, `us`).
- Confirmed that all three queues share the one `queue()` export and are routed by suffix (Stage 4).

## Things to know / not done

- **Process slip, disclosed:** during stage 4 I accidentally ran `git rm -q --cached src/email/disabled-email-queue.ts`, which staged a deletion. I immediately ran `git restore --staged` on that one path to put the index back. `git diff --cached` is empty again, the same state as at the start. No other git write happened; the two removed files were deleted with plain `rm` and show as unstaged ` D`.
- **Timing:** the known-vs-unknown reset response is identical in status and body, but a known address still does more work (verification row, ledger insert, queue send), so a timing side channel remains. Closing it would mean running `sendResetPassword` via `ctx.waitUntil` (Better Auth `advanced.backgroundTasks`), which needs the execution context threaded into `createAuth`.
- **Stranded rows:** a ledger row whose queue message reaches the DLQ after `max_retries` stays `pending`, and an uncollected hand-off whose shop gets no more polls is only swept by the next poll. Both belong to the 15-minute sweeper (PLAN §2.2), which is not built yet.
- **Object-store audit rows** (`stored_object`) still write `actor_user_id NULL` with no grant id, because that store receives a tenant context rather than the principal. Acting-as uploads are therefore not grant-tagged there yet.
- **Email copy** in `auth-email-job.ts` still says "MeteorShop" (memory says the display brand is ChopShop). Copy was out of scope, so it is untouched.
- **Timestamp formats:** new tables and columns use ISO TEXT per §2.8. `audit_events.created_at` and `email_deliveries` keep their existing INTEGER ms, and "sent at" is `resolved_at` on a `sent` row.
- **`CANONICAL_ORIGINS` strictness:** the parser refuses unknown keys. If the config owner adds `admin`/`platform` keys later, the parser must learn them first, otherwise reset goes dark.
- **Test origin:** the vitest-pinned `AUTH_BASE_URL`/`AUTH_TRUSTED_ORIGINS` keep the existing test origin, which the suites hardcode. They are independent of `wrangler.jsonc` on purpose.
