# Inventory — `cloudflare-migration` branch (what the hybrid attempt already delivers)

**Written:** 2026-09-26, read-only inventory. Nothing on the branch was checked out, edited, or deployed.
**Sources read:** `git show cloudflare-migration:<path>` for every file under `cloudflare/` (except `package-lock.json`) plus `docs/CLOUDFLARE_HANDOVER.md`, `docs/RENDER_FARM_CONTRACT.md`, `docs/CLOUDFLARE_FUNCTION_MAP.md`, `docs/CLOUDFLARE_DATA_MODEL.md`, `docs/CLOUDFLARE_CUTOVER_CHECKLIST.md`, `docs/CLOUDFLARE_MIGRATION.md`; for comparison, main's `functions/src/index.ts`, `functions/src/payment/*`, `firestore.rules`, `storage.rules`.
**Independent verification run:** `git archive cloudflare-migration cloudflare` extracted to a scratch directory (node_modules symlinked from the untracked `cloudflare/node_modules` leftover in the main worktree; versions checked equal to `package.json` pins), then `npx vitest run`, `npx tsc --noEmit`, `npx wrangler types worker-configuration.d.ts --check`. Results in section 0.

---

## Summary

### A. Reusable as-is (port these modules/patterns, don't rewrite them)

Condition for all of A: first repair the committed test gate (see B1). The source code itself is sound.

1. **Hostname-only tenant resolution** — `src/tenancy/resolve-tenant.ts` (verified domain JOIN active tenant; client `shopId`/`X-Shop-Id`/forwarded-host ignored).
2. **Live D1 authorization model** — tables `identity_access` (one account kind per user), `tenant_memberships`, `print_memberships` (0002) + `src/auth/live-authorization.ts` + `src/auth/request-authorization.ts` (session → live principal; no claims in cookies; `revokeUserSessions`).
3. **Better Auth 1.6.29 on D1** — `src/auth/create-auth.ts` (cookieCache off, `autoSignIn:false`, hashed verification identifiers, DB rate limit, 7-day session) + generated schema in 0002 + sign-in-only allowlist `src/auth/auth-routes.ts`.
4. **Fail-closed conventions** — opaque JSON 404 for every unauthorized/unconfigured surface, "config gate runs before method/path/D1/limiter", strict same-origin `Origin` check (`src/lib/same-origin.ts`), `jsonResponse` with `no-store` + `nosniff` (`src/lib/http.ts`).
5. **Immutable-tenant schema discipline** — `tenant_id` immutability triggers on every table, parent-tenant-match triggers (FKs to global PKs are not tenant-safe), byte-exact `substr()` key-prefix CHECKs (never `LIKE`), append-only `audit_events`.
6. **Durable D1 rate limiter** — 0008 `rate_limit_windows` + `src/lib/rate-limit.ts` (hashed keys, atomic upsert `RETURNING`, skew-safe, fail-closed, `CF-Connecting-IP` only).
7. **R2 object ownership model** — 0006 `stored_objects` + `src/storage/object-store.ts` + `src/storage/object-routes.ts` (reserve → streamed PUT with R2-verified sha256 → authorized delivery → tombstone-then-delete; freeze/`immutable`).
8. **Shipping + VAT engine** — `src/commerce/shipping.ts`. Term-for-term parity with main's `computeOrderTotalsSek` shipping/VAT math (region map, first-line base tariff, 29/49 SEK fallback, `ceil((Σ(weight||10)·qty + 20 g)/50)` tiers, VAT-inclusive `vat = total − total/(1+rate)` with exact integer rounding). Main's math has not changed since the branch base: `computeOrderTotalsSek` (137 lines) is byte-identical between `019a0b7` and main HEAD, and `src/contexts/CartContext.jsx` is unchanged. Only gates were added around it.
9. **Campaign discount math** — `src/commerce/discount-codes.ts` + 0010 `discount_codes` (window, `max_uses`, min-spend on full subtotal, `all`/`products` scope, fixed clamp, percent `ceil`). Parity with main's campaign branch.
10. **Stripe on workerd** — `src/commerce/stripe-client.ts` (SDK 22.5.0 via `createFetchHttpClient`, `constructEventAsync` mandatory on workerd, opaque gateway errors, symbol-keyed test seams), deterministic PI idempotency key `checkout:{id}` and guarded attach (one PI per checkout, client secret never stored).
11. **Webhook machinery** — `src/commerce/webhook.ts` + 0011: raw-body signature verification, `payment_events` append-only ledger (processed/ignored/rejected + reason code), one `db.batch` for order + lines + history + checkout transition + discount burn + audit + ledger, collision-safe order numbers `YYYYMMDD-XXXXXXXX` (Crockford), amount/metadata consistency assertions, "never 4xx a validly signed event".
12. **Render-farm seam** — `docs/RENDER_FARM_CONTRACT.md` v0 + `src/pod/render-farm-client.ts` (aws4fetch SigV4 presign with `allHeaders:true` so content-type is actually signed; 900 s job TTL; 330 s farm timeout; every farm response shape handled; verify-before-ready via R2 HEAD) + the branch-only Firebase half (`functions/src/pod/artworkPipelineCore.ts`, `functions/src/render-farm/processArtworkJob.ts`). The extraction is still aligned with main: main's `functions/src/pod/processArtwork.ts` is unchanged since `ed4645a` (2026-08-18), before the cp26 extraction.
13. **Auth-email contract + delivery ledger** — `src/email/auth-email-job.ts`, `src/email/email-delivery-store.ts`, 0003/0004 (recipient hash only, SHA-256 job fingerprint, leases, bounded retry). Library only — nothing produces or sends.
14. **Platform ops** — one-time bootstrap (`src/platform/bootstrap.ts`, already used and dead), tenant provisioning (`provision-tenants.ts`), user provisioning for `tenant_admin`/`print_operator` (`provision-users.ts`).
15. **Test harness + practices** — `@cloudflare/vitest-pool-workers` `cloudflareTest()` config with `readD1Migrations`/`applyD1Migrations`, real Better Auth sessions in tests, real Stripe signature verification in tests, the mutation-log practice, operator smoke scripts `cloudflare/scripts/stg-*.sh`.
16. **Ready-but-unused schema** — `idempotency_keys` and `outbox_events` (0001) exist with leases/dedupe constraints but no code touches them yet.

### B. Exists but needs update before reuse

1. **The committed test gate is red (new finding).** At branch HEAD: `wrangler types --check` fails, `tsc --noEmit` reports 64 errors (all in `test/`, 14 files), `vitest run` = **868 passed / 48 failed of 916** (all failures in `test/pod-artwork.test.ts`, "POD render farm is not configured"). Cause: checkpoint 27's commit `6c7fb77` never included the edits to `vitest.config.ts` (the four POD test bindings), `test/env.d.ts`, or a regenerated `worker-configuration.d.ts` that the handover lists. The handover's "916/916" was true only for the builder's uncommitted working tree. Fix = add the four test-only POD bindings to miniflare `bindings`, the six keys to `test/env.d.ts`, rerun `npm run types`.
2. **`POST /v1/checkout`** — core mechanics reusable, but the business surface is behind main: collects only `email` (no name, address, phone, language, marketing consent), no pickup-location id/date resolution (main P1-06 `resolvePickupLocation`), no shop-live gate (main `shopCheckoutBlockReason`: `status==='disabled'`, `published===false`), no withdrawal-consent gate for personalized/POD items (`withdrawalConsentBlockReason`), no affiliate discount branch (main: affiliate checked first and wins), no add-on gating (`discountCodes`/`affiliate` features), no POD production-snapshot freeze or unresolved-line 409, no Turnstile — **all of these already existed on main at the branch base** (deferred, not drift). **New on main since the branch:** the legal checkout gate (`legalCheckoutBlockReason`, `354990a`, 2026-09-07: `returnAddress`, boolean `vatRegistered`, `legal.acceptance.acceptedAt`), `podEnabled` skip for non-POD shops (`ed4645a`, 2026-08-18), and the SnapWear routing blocks. Allows any 3-letter currency per product (main: SEK only).
3. **`POST /v1/checkout/{id}/payment`** — PI params are `{amount, currency, automatic_payment_methods:{enabled:true}, metadata:{checkout_id, tenant_id}}` + idempotency key only. Main additionally sends `receipt_email`, `description` (`{tenantName} Order - N items`), `statement_descriptor_suffix` (sanitized ≤12 chars) and Connect destination-charge params `transfer_data.destination` + `application_fee_amount` — **all four already existed on main at the branch base `019a0b7`** (deliberately deferred by the branch as the "Connect seam"; SnapWear A9 was later marked "already built"). **New on main since the branch:** the frozen POD production withholding folded into `application_fee_amount` (SnapWear A1, `de5fa3c`, 2026-09-25) and 409 blocks `no-printer-for-garment`, `routed-line-unpriced`, `pod-requires-connect`, `production-exceeds-gross`. API version drift: branch pins `2026-07-29.dahlia`; main pins `2023-10-16`.
4. **`POST /v1/webhooks/stripe`** — handles only `payment_intent.succeeded`. Main also handles `payment_intent.payment_failed`, `account.updated`, `charge.dispute.created`, `charge.dispute.closed`, consumes the frozen production snapshot, and hands off to order-completion side effects (emails, affiliate commission) and the print outbox — all present at the branch base. **New on main since the branch:** the webhook splits money into the private `orderProduction/{piId}` breakdown (A13 one-number / A1b, `59da67a`, 2026-09-26) and freezes `printerUid` + cost per production line (`cd8fac9`, 2026-08-30). Order status vocabulary differs (`paid` vs main `confirmed`).
5. **`orders` schema (0011)** — no customer/shipping/pickup snapshot, no withdrawal-consent proof, no Connect fee/transfer/withholding fields, no production-snapshot link, no per-line printer routing/cost. Refund columns exist (`refunded_total_minor`, `partially_refunded`/`refunded`) but nothing writes them.
6. **Catalogue** — admin can create/patch/publish/unpublish only. Missing: any admin GET (list/detail), variant CRUD (`product_variants` rows only ever created by direct SQL in tests), images/media, `is_pod` and every POD field (column exists, always 0), categories/collections, public pagination (hard cap 100 products, 100 variants).
7. **Discount codes** — no list endpoint, no advisory validate endpoint, wire field `percentBp` (main UI sends float `value`), no add-on flag gate, `MAX_DISCOUNT_PRODUCT_IDS=500` (main has none).
8. **Tenants** — `tenants` holds `shop_name`, `support_email`, locale, currency, `settings_json` (unused), `vat_rate_bp`. Main's `shops/{id}` carries storeIdentity (legal, return address, VAT status, pickup locations, menu, branding, template), `features`, `payments` (Connect), `published`, `status`, commission. Domains are created `verified` by the platform (no DNS proof-of-control).
9. **POD profiles (0012 `pod_profiles`)** — one platform-level profile list with a single print area per profile. Main now has per-printer print areas + capability gating (SnapWear A2–A4, `0eb9c78`) and front print area 300 mm (`500a664`, was 250). Must be remodelled around printers.
10. **POD artwork dispatch** — deployed dark; the four secrets were never set; "does R2 accept the SigV4 signature" is unproven live; no reprocess verb, no reference check on delete, synchronous 330 s request.
11. **Render-farm Firebase half (cp26)** — exists only on the branch; never deployed; not cherry-picked to main. Branch `functions/src` lags main by 26 files (`git diff --stat main cloudflare-migration -- functions/src`: 835 insertions, 2625 deletions) — cherry-pick only, never deploy `functions/` from the branch. (Only relevant if the new plan keeps a Firebase render farm; the full-port plan names a separate render service instead — the pure core `artworkPipelineCore.ts` is the reusable part.)
12. **Auth flows** — only sign-in/sign-out/get-session are mounted. Password reset, email verification, invitations, platform-admin creation beyond bootstrap, and user suspend/revoke routes are not built.
13. **Docs drift** — `cloudflare/README.md` still says auth routes are not mounted; handover cp24 still says "awaiting Fable review"; cp27 section says both "DEPLOYED DARK… migration 0012 applied" (header line, commit `14425cb`) and "applied only to the local… nothing was deployed" (body); handover says the Stripe gateway seam uses `Symbol.for` — code uses plain `Symbol(...)`.

### C. Missing — no Cloudflare counterpart at all

Of main's **82** Firebase exports, only 11 have any counterpart (5 partial, 3 replaced by design, 3 stale — section 9.1); **71 have none**. The branch's own function map covered 75; the 7 added on main since are all missing: `quotePodCost`, `syncPrintersPublicOnWrite`, `submitInfringementReport`, `takedownProduct`, `screenProductOnWrite`, `rescreenProductsOnMappingWrite`, `rescreenProductsOnArtworkWrite`.

- **POD studio + production:** `podMappings`, `pod3dModels`, mockup/template data, production snapshot (`orderProduction`), print queue/job/export/artwork library/download (`getPrint*`), `setPrintJobStatus`, print outbox + sweep (`onOrderProductionReady`, `sweepPrintNotifyOutbox`, `printNotifications`), print-shop user assignment (`print_memberships` has no writer; `authorizePrintRequest` is unused).
- **SnapWear/printer domain:** `printers/{uid}` (garment list, ex-moms price tiers), `printersPublic` projection, per-garment routing, per-printer print areas, production-cost withholding, one-number quote (`quotePodCost`, `orderMoney` split).
- **Screening + takedown:** content screening on product/mapping/artwork write, infringement reports, takedown.
- **Legal:** seller legal-page ownership, platform-terms acceptance evidence, checkout legal gate, `[[IF pod]]` template rendering, withdrawal (`submitWithdrawal`) and consent proof.
- **Email:** every transactional email (order confirmation, status update, admin notification, password reset, credentials, verification, affiliate emails). The auth-email Queue consumer is deliberately disabled; no provider (Resend or Cloudflare Email Sending) is wired.
- **Stripe Connect:** account create/link/refresh/login link/commission/balance/payout delay; refunds (`refundOrder`, Connect reversal); disputes.
- **Customers:** `b2cCustomers`, `b2bCustomers`, customer accounts/deletion/status, customer documents, `adminCustomerDocuments`.
- **Growth add-ons:** abandoned cart (sweep, recovery token, unsubscribe, suppressions), reviews (qualify, sweep, resolve, submit, unsubscribe, moderate), affiliates (clicks, applications, approve, payouts, commission reversal), campaigns, marketing materials, leads, content studio (copy, video, handoff).
- **Platform:** DAC7 (9 functions), impersonation (+ `impersonationAudit`), platform users delete/super-admin, `adminUIDs`/`adminPresence`, shop add-on flags (`features`), published/kill-switch, migrators (Shopify, Woo, `migrations` progress), geo (`getGeoDataV2`), website scraper, B2B orders (retired in UI).
- **Storefront content:** `pages`, `collections` + menu builder, `productGroups`, translations, branding/favicon, templates, public images (the `meteorshop-stg-public` bucket exists but is unbound).
- **Runtime pieces:** no cron trigger, no Durable Object, no KV, no static-assets/web Worker (`meteorshop-stg-web` planned, never created), no commerce/print/media/maintenance Queues (planned only), no frontend changes (the SPA still talks to Firebase directly).

---

## 0. Branch facts and gate status

| Fact | Value |
|---|---|
| Branch HEAD | `2b13d05` 2026-08-27 "fix(studio): don't block mockup update of existing product on prisgolv" (studio fix, not Cloudflare work) |
| Last Cloudflare commit | `711ae34` 2026-08-22 (handover: money loop live-verified) |
| Last Cloudflare code commit | `6c7fb77` 2026-08-22 (checkpoint 27) |
| Merge-base with main | `019a0b7` 2026-08-15 "Harden checkout and print production pipeline" |
| Branch-only commits | 46 |
| Main commits not on branch | 80 (incl. SnapWear A1–A13, legal gate, screening/takedown, shop-type selector, per-printer areas) |
| Handover "Last updated" | 2026-08-22 late |
| cp26 on main? | No — `functions/src/render-farm/` and `artworkPipelineCore.ts` do not exist on main |
| Untracked `cloudflare/` in main's worktree | leftovers only: `node_modules/` (usable for running the branch suite), `.wrangler/state`, `worker-startup.cpuprofile`, empty `test/` |

**Gate re-run at branch HEAD (2026-09-26, scratch copy):**

| Step | Result |
|---|---|
| `wrangler types worker-configuration.d.ts --check` | FAIL — "Types at worker-configuration.d.ts are out of date" (cp27 added two vars to `wrangler.jsonc` without regenerating) |
| `tsc --noEmit` | FAIL — 64 errors, all `test/*.ts`: `Cloudflare.Env` missing `RENDER_FARM_URL`, `RENDER_FARM_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_PRIVATE_BUCKET_NAME` |
| `vitest run` | 26 files: 25 passed, 1 failed; tests 868 passed, 48 failed (916 total) — all in `pod-artwork.test.ts` |

The four secret-shaped POD values appear nowhere in the committed tree except `src/env.d.ts`, `src/pod/render-farm-client.ts` and the test file itself (`git grep` confirms). `.dev.vars` is gitignored and absent.

---

## 1. Checkpoint ledger (handover SSOT, cross-checked against `git log`)

"Deployed" = staging Worker `meteorshop-stg-api` in the personal account. Test counts are the handover's recorded local gate at that checkpoint.

| # | Commit(s) | What it delivered | Staging state | Verified how |
|---|---|---|---|---|
| 1 | `4a70cba` | `CLOUDFLARE_MIGRATION.md` plan; branch created | docs only | — |
| 2 | `0de5e79` | `cloudflare/` package scaffold, pinned toolchain, `/health`, fail-closed 404, vitest-pool-workers; three companion docs (function map, data model, cutover checklist) | not deployed (dry-run only) | 2/2 tests, dry-run 0.98 KiB, startup profile |
| 3 | `c512754` | 0001 tenancy/audit/idempotency/outbox; `/ready`; D1 binding; account id pinned | D1 `meteorshop-stg-db` created (WEUR); 0001 applied remote; Worker version `2ab9878c-fec8-4a54-a4fd-5cca643731d9` | live `/health` + `/ready` 200, unknown routes 404; remote readback 5 tables / 10 indexes / 6 triggers |
| 4 | `e9045ba` | Better Auth 1.6.29 + 0002 (auth tables + `identity_access`, `tenant_memberships`, `print_memberships`) | 0002 applied remote (20 commands); code not deployed | 13/13; readback 8 tables, 0 users |
| 5 | `4398c8f` | hostname tenant resolver; live platform/tenant/print guards | local only | 19/19 (hostile headers, suspended domains, cross-tenant) |
| 6 / 6.1 | `9569762`, `a0c28ce` | session → live principal bridge; `revokeUserSessions`; hashed verification identifiers | local only | 23/23 with real Better Auth sessions |
| 7 | `762a074` | auth-email Queue job contract; 0003 email delivery ledger | 0003 applied remote (7 commands) | 29/29; readback |
| 8 | `9f8e631` | job fingerprint, lease state machine; 0004 | 0004 applied remote | 35/35; 8-way concurrent claim test |
| 9 | `88ee458` | auth-email Queue + DLQ bound; disabled consumer | Queues created; Worker version `7099d7e1-4a18-4f12-baba-5d977c2b7a8f` | 36/36; live `/health` `/ready` 200 |
| 10 | `a04c32d` | `GET /v1/storefront` | deployed in 13.1 | 39/39 |
| 11 | `27e4c6b` | 0005 catalogue; `GET /v1/products`, `GET /v1/products/{id}` | 0005 applied + deployed in 13.1 | 61/61 (21 adversarial) |
| 12 | `23492aa` | tenant-admin product write path + same-origin check | deployed in 13.1 | 102/102; 3 guard tests mutation-tested |
| 13 | `cc4b014` | platform tenant provisioning routes | deployed in 13.1 | 157/157; one-kind guard mutation-tested |
| 13.1 | `ec36930` (+`81faeab`) | fix: missing `BETTER_AUTH_SECRET` caused error 1101 → fail-closed | first deploy `369b60ad` broken; fixed deploy `8b01035c` | 163/163; live smoke of all surfaces |
| 14 | `4ce82d7` | `/api/auth/*` sign-in-only allowlist | deployed (dark until secret) | 181/181; mutation-verified |
| 15 | `46dd32c` | 0006 `stored_objects` + object-store library | 0006 applied; deployed | 204/204 |
| 16 | `1f76c8f` | admin object routes (reserve/upload/meta/deliver/delete) | deployed (dark until bucket) | 242/242 |
| 17 | `6aca0f8` | one-time `POST /v1/platform/bootstrap` | deployed; `BETTER_AUTH_SECRET` set 2026-08-16; bootstrap has RUN (1 platform admin, route now dead) | 280/280; live sign-in 401/403/404 checks; replay 404 |
| 18 | `823f86f` | 0007 checkouts; `POST /v1/checkout` | 0007 applied; deployed | 356/356; live smoke |
| 19 | `ef4d3bd` | 0008 rate limits on checkout + bootstrap | 0008 applied; deployed | 384/384; live 429 |
| 20 | `1d0f871` | R2 buckets `-public/-private/-temp` created; `PRIVATE_BUCKET` bound | Worker version `899ceb15-5c0b-45f4-8582-d37610edf7d9` | 384/384; live smoke |
| 21 | `3f96401` | 0009 VAT-inclusive totals v2, delivery method, shipping engine | 0009 applied; version `008f89a6` | 533/533; tier-boundary parity walk; mutation-tested |
| 22 | `45d9cb2` | 0010 campaign discount engine + admin CRUD | 0010 applied; version `0eed0cc9` | 646/646; 15-mutation kill log |
| 23 | `d87284e` (+`0a9eca8`, `ebf6f0b`, `71ba670`) | `POST /v1/platform/users`; `autoSignIn:false`; smoke scripts | version `1a317c60` | 702/702; **live e2e 2026-08-16** `stg-e2e.sh` 28/28 (money 19900/5800/1990/23710/4742) |
| 24 | `7adccef` | `POST /v1/checkout/{id}/payment` | version `00c9491b` (broken live: edge `Content-Length: 0`) | 747/747; 8/8 mutations killed |
| 24.1 | `0925796`, `0f39df2` | accept edge-normalized bodyless POST; defuse frozen-`NOW` fixtures | version `ac1a0f05-9bea-454f-a57f-a1f612f434ce` | 749/749; live 9/9, first test PI `pi_3U7JGuKAaBMOW5AC0UQYvjiI`, same-PI idempotency |
| 25 | `b27481a` (+`c2b128d`, `711ae34`) | 0011 orders + `POST /v1/webhooks/stripe` + discount burn | 0011 applied; version `5d9cdeec-92ea-4625-bcdb-091740bfccf8`; `STRIPE_WEBHOOK_SECRET` set | 816/816; 11 mutations (9 killed, 1 equivalent, 3 gaps closed); **live money loop 2026-08-22**: order `20260822-S2K41A2E` (17910 total, VAT 3582), SMOKE10 burned once, dashboard resend → zero change |
| — | `1ed03e7` | HYBRID decision + `RENDER_FARM_CONTRACT.md` v0 | docs | — |
| 26 | `b9b5870` (+`39e28ff`) | Firebase side: `artworkPipelineCore.ts` (pure sharp core), `render-farm/processArtworkJob.ts` (dark `onRequest`), export `renderFarmProcessArtwork` | **not deployed; not on main** | `tsc` green; `verify-pipeline-core.mjs` 8/8 (incl. byte-identical determinism); mechanical 122-line move diff; read-only reviewer |
| 27 | `6c7fb77` (+`14425cb`) | 0012 `pod_profiles`/`pod_artwork`; POD routes; render-farm client | 0012 applied; version `1878e6a8-7dd6-499f-9608-9304bae28e9f`; **dark** (4 secrets never set) | handover 916/916 (not reproducible from the commit, see section 0); 14 mutations (13 killed, 1 equivalent, 2 gaps closed); dark smoke only — R2 signature acceptance never tested live |

---

## 2. Worker layout

- **One Worker:** `meteorshop-stg-api`, entry `cloudflare/src/index.ts`, `export default { fetch, queue } satisfies ExportedHandler<Env>`.
- **Router:** hand-written `if` chain in `fetch` (no framework, no middleware stack). Path parsers `decodeSegment`, `*FromPath` do strict segment counts + safe percent-decoding; anything malformed → the same 404.
- **Module map (`src/`):** `auth/` (Better Auth, guards), `catalog/` (public + admin), `commerce/` (checkout, shipping, discounts, payment, Stripe client, webhook), `email/` (auth-email contract, ledger, disabled consumer), `lib/` (http, rate-limit, same-origin), `platform/` (bootstrap, tenant + user provisioning), `pod/` (profiles, artwork store, farm client), `storage/` (object store + routes), `storefront/`, `tenancy/`.
- **Middleware-equivalents (called per route):** `resolveRequestTenant`, `authorizeTenantAdminRequest` / `authorizePlatformRequest` / `authorizePrintRequest` (last one unused), `isSameOriginRequest`, `enforceRateLimit` + `clientIp`, config gates `isAuthConfigured` (secret ≥32), `isBootstrapConfigured`, `isStripeConfigured` (≥8), `isStripeWebhookConfigured` (≥8), `isPodConfigured` (all six values).
- **Durable Objects:** none. **Cron / `scheduled`:** none (no `triggers.crons`). **KV:** none. **Workflows:** none. **Service bindings:** none. **Static assets:** none. **Containers:** none.

### 2.1 HTTP routes (every one)

Auth column: **anon** = no session; **host** = tenant from verified hostname; **TA** = live session + active `tenant_admin` identity + active same-tenant `admin` membership + active tenant (hostname-derived); **PA** = live session + active `platform_admin`; **CSRF** = strict same-origin `Origin`. All failures are opaque JSON 404 unless stated.

| Method | Path | Auth | Purpose / notes |
|---|---|---|---|
| GET | `/health` | anon | `{environment, service, status}` |
| GET | `/ready` | anon | 200 when `d1_migrations` contains `0012_pod_artwork.sql`, else 503 |
| GET | `/v1/storefront` | anon + host | `{name, locale, currency}` only |
| GET | `/v1/products` | anon + host | published + `status='active'` products, max 100, ordered by name |
| GET | `/v1/products/{productId}` | anon + host | detail + active variants (max 100) |
| POST | `/v1/checkout` | anon + host | body keys `deliveryMethod, discountCode, email, idempotencyKey, items[{productId, quantity, variantId?}], shippingCountry`; 10/min/IP before parse, 30/h/email after; 201 new / 200 replay / 409 key reuse / 422 opaque bad line / 400 / 429; 24 h TTL, ≤50 items, qty ≤999 |
| POST | `/v1/checkout/{checkoutId}/payment` | anon + host; needs `STRIPE_SECRET_KEY` | no body allowed (`Content-Length: 0` accepted); 20/min/IP; 201 minted / 200 re-served `{clientSecret, paymentIntentId}`; 502 opaque gateway failure |
| POST | `/v1/webhooks/stripe` | Stripe signature; needs `STRIPE_WEBHOOK_SECRET` **and** `STRIPE_SECRET_KEY` | platform-level (tenant from checkout row); 400 bad signature, 500 D1 fault, 200 everything else; no rate limit by design |
| POST | `/api/auth/sign-in/email` | Better Auth (needs `BETTER_AUTH_SECRET`) | trustedOrigins CSRF (403 `INVALID_ORIGIN`) |
| POST | `/api/auth/sign-out` | Better Auth | — |
| GET | `/api/auth/get-session` | Better Auth | — |
| any | other `/api/auth/*` | — | 404 (sign-up, reset, verification, social all unmounted) |
| POST | `/v1/admin/products` | TA + CSRF | create (keys `allowPickup, allowShipping, currency, description, name, priceMinor, shippingRates, sku, weightGrams`) |
| PATCH | `/v1/admin/products/{id}` | TA + CSRF | update (adds `status`; refreshes published projection in same batch) |
| POST | `/v1/admin/products/{id}/publish` | TA + CSRF | requires `status='active'` (409 otherwise) |
| POST | `/v1/admin/products/{id}/unpublish` | TA + CSRF | idempotent |
| POST | `/v1/admin/objects` | TA + CSRF | reserve (`contentType, fileName, kind, sha256, sizeBytes`); private kinds only: `artwork_original, document, export, print_file` |
| PUT | `/v1/admin/objects/{id}/content` | TA + CSRF; needs `PRIVATE_BUCKET` | streamed upload ≤100,000,000 bytes; R2 verifies sha256 |
| GET | `/v1/admin/objects/{id}` | TA | metadata (object key never exposed) |
| GET | `/v1/admin/objects/{id}/content` | TA | authorized delivery, `no-store` + `nosniff` |
| DELETE | `/v1/admin/objects/{id}` | TA + CSRF | tombstone row then delete bytes; 204; frozen objects 409 |
| POST | `/v1/admin/discount-codes` | TA + CSRF | create (keys `active, code, endsAt, maxUses, minSpendMinor, percentBp, productIds, scope, startsAt, type, valueMinor`) |
| GET | `/v1/admin/discount-codes/{id}` | TA | read one (no list endpoint; GET on the collection path is 404) |
| PATCH | `/v1/admin/discount-codes/{id}` | TA + CSRF | update (same keys; `used_count` never writable) |
| GET | `/v1/admin/pod/profiles` | POD-configured + TA | active profiles |
| GET | `/v1/admin/pod/artwork` | POD-configured + TA | tenant's artwork list |
| POST | `/v1/admin/pod/artwork` | POD-configured + TA + CSRF | dispatch `{objectId, profileId}` to the farm; 5/min/IP before parse; 201 ready / 200 rejected / 409 duplicate / 502 farm failure (row deleted, replay = retry) |
| GET | `/v1/admin/pod/artwork/{id}` | POD-configured + TA | detail + `previewUrl` (presigned GET, 300 s; null unless ready) |
| DELETE | `/v1/admin/pod/artwork/{id}` | POD-configured + TA + CSRF | row + both `pod/` objects; original kept; 204 |
| PUT | `/v1/platform/pod/profiles` | POD-configured + PA + CSRF | full replace of profile list |
| POST | `/v1/platform/bootstrap` | `x-bootstrap-token` (`BOOTSTRAP_TOKEN` ≥32) + zero platform_admin rows + 5/10 min/IP | body `email, name, password`; **already used — permanently 404 now** |
| POST | `/v1/platform/users` | PA + CSRF | body `accountType (tenant_admin|print_operator), email, password`; `platform_admin` not creatable |
| POST | `/v1/platform/tenants` | PA + CSRF | body `defaultCurrency, defaultLocale, hostname, shopName, tenantId`; creates tenant + verified storefront domain + audit |
| POST | `/v1/platform/tenants/{tenantId}/domains` | PA + CSRF | body `hostname, kind (storefront|admin)`; created `verified` |
| POST | `/v1/platform/tenants/{tenantId}/admins` | PA + CSRF | body `userId`; one-account-kind boundary (409) |
| POST | `/v1/platform/tenants/{tenantId}/suspend` | PA + CSRF | status → suspended |
| POST | `/v1/platform/tenants/{tenantId}/activate` | PA + CSRF | status → active |
| any | anything else | — | `404 {"error":{"code":"not_found"}}` |

### 2.2 Queue consumers

| Queue | Consumer | Behaviour |
|---|---|---|
| `meteorshop-stg-email-auth` | this Worker (`queue()` → `handleDisabledAuthEmailQueue`) | deliberately disabled: logs count, `retryAll({delaySeconds: 300})`, never reads bodies. Batch 10, timeout 5 s, 8 retries, concurrency 2, DLQ `meteorshop-stg-email-auth-dlq` (no consumer). Producer binding `AUTH_EMAIL_QUEUE` exists but **no code enqueues**. |

---

## 3. Bindings — `cloudflare/wrangler.jsonc` (verbatim values; no secrets in file)

| Key | Value |
|---|---|
| `name` | `meteorshop-stg-api` |
| `account_id` | `0d392e5c79e386966a98a214ac91a133` |
| `main` | `src/index.ts` |
| `compatibility_date` | `2026-08-15` |
| `compatibility_flags` | `["nodejs_compat"]` |
| `workers_dev` / `preview_urls` | `true` / `true` |
| vars | `APP_ENV="staging"`, `AUTH_BASE_URL="https://meteorshop-stg-api.micke-ohlen.workers.dev"`, `AUTH_TRUSTED_ORIGINS="https://meteorshop-stg-api.micke-ohlen.workers.dev"`, `R2_ACCOUNT_ID="0d392e5c79e386966a98a214ac91a133"`, `R2_PRIVATE_BUCKET_NAME="meteorshop-stg-private"`, `SERVICE_NAME="meteorshop-stg-api"` |
| `r2_buckets` | `PRIVATE_BUCKET` → `meteorshop-stg-private` (only binding; `-public` and `-temp` exist but are unbound) |
| `d1_databases` | `DB` → `meteorshop-stg-db`, `database_id` `d709e702-17f6-4107-ad45-060f2b24dc89`, `migrations_dir: migrations` |
| queues.producers | `AUTH_EMAIL_QUEUE` → `meteorshop-stg-email-auth` |
| queues.consumers | `meteorshop-stg-email-auth`, `max_batch_size 10`, `max_batch_timeout 5`, `max_retries 8`, `dead_letter_queue meteorshop-stg-email-auth-dlq`, `max_concurrency 2` |
| observability | enabled, logs enabled, `head_sampling_rate 1`, `invocation_logs true` |
| Environments | none defined (`env.*` absent) — the file IS staging |
| Queue ids (from handover) | primary `6f77ddb4e3bb4fe08ce5638ab468eaea`, DLQ `06386088cd4443d9b6f22990e5b55f69` |

Toolchain pins (`package.json`): wrangler `4.123.0`, `@cloudflare/workers-types` `5.20260815.1`, `@cloudflare/vitest-pool-workers` `0.21.3`, vitest `4.1.10`, typescript `7.0.2`; runtime deps `better-auth 1.6.29`, `stripe 22.5.0`, `aws4fetch 1.0.20`. Scripts: `check` = `types:check && build (tsc) && test`; `deploy:staging` = `wrangler deploy`; `deploy:dry-run`; `startup` = `wrangler check startup`.

## 4. Secrets and tokens referenced by name (values never in git)

| Name | Where | State per handover |
|---|---|---|
| `BETTER_AUTH_SECRET` | Worker secret | set 2026-08-16 |
| `BOOTSTRAP_TOKEN` | Worker secret | set for bootstrap; deletion was optional — current existence unknown (route is dead either way) |
| `STRIPE_SECRET_KEY` | Worker secret | set; a key of the Stripe **sandbox** "Meteor Public Relations AB-sandlåda" (`acct_1Tp7gtKAaBMOW5AC`), not classic test mode |
| `STRIPE_WEBHOOK_SECRET` | Worker secret | set; signing secret of webhook destination `captivating-celebration` (`we_1U7LyAKAaBMOW5ACdF27I05U`), URL `https://meteorshop-stg-api.micke-ohlen.workers.dev/v1/webhooks/stripe`, event `payment_intent.succeeded`, API version `2026-07-29.dahlia` |
| `RENDER_FARM_URL`, `RENDER_FARM_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Worker secrets | **never set** → POD surface dark |
| `RENDER_FARM_TOKEN` | Firebase Secret Manager | never created |
| R2 Account API token (Object Read & Write, scoped to `meteorshop-stg-private`) | dashboard | never created |

`vitest.config.ts` contains only fake test-only placeholder strings (a 32+ char dummy auth secret, dummy bootstrap token, `sk_test_…fake…`, `whsec_…fake…`) — not credentials. Wrangler auth is Wrangler's local OAuth credential store (handover); no Cloudflare env var names are set in this shell. Cross-reference (memory, not the branch): an env `CLOUDFLARE_API_TOKEN` belonging to an unrelated "igpholding" account has existed on this machine and must never be used for this project.

## 5. D1 schema (`cloudflare/migrations/`, all applied to `meteorshop-stg-db` per handover)

| File | Tables / changes |
|---|---|
| `0001_platform_foundation.sql` | `tenants`, `tenant_domains`, `audit_events`, `idempotency_keys`, `outbox_events` |
| `0002_auth_identity.sql` | `user`, `session`, `account`, `verification`, `rateLimit` (Better Auth), `identity_access`, `tenant_memberships`, `print_memberships` |
| `0003_email_delivery_ledger.sql` | `email_deliveries` |
| `0004_email_delivery_fingerprint.sql` | `email_deliveries.job_fingerprint` + required-on-insert trigger |
| `0005_catalogue.sql` | `products`, `product_variants`, `product_publications` |
| `0006_object_store.sql` | `stored_objects` |
| `0007_checkout.sql` | `checkouts`, `checkout_items` (v1 totals) |
| `0008_rate_limits.sql` | `rate_limit_windows` (WITHOUT ROWID) |
| `0009_checkout_totals_v2.sql` | rebuilds `checkouts` + `checkout_items` (v2 VAT-inclusive totals, delivery method); adds `tenants.vat_rate_bp`, `products.weight_grams/allow_shipping/allow_pickup/shipping_json` |
| `0010_discount_codes.sql` | `discount_codes`; adds `checkouts.discount_code_id` (no FK) |
| `0011_orders.sql` | `orders`, `order_items`, `order_status_history`, `payment_events` |
| `0012_pod_artwork.sql` | `pod_profiles`, `pod_artwork` |

Columns (final state after 0012). All `*_at` are epoch-ms INTEGER unless noted; every tenant-owned table has a `tenant_id` immutability trigger; every table with `updated_at` has `CHECK (updated_at >= created_at)`.

- **`tenants`** — `tenant_id` PK, `status` (provisioning|active|suspended|closed), `shop_name`, `support_email`, `default_locale` (default `sv-SE`), `default_currency` (default `SEK`, len 3), `settings_json`, `created_at`, `updated_at`, `vat_rate_bp` (default 2500, 0–10000).
- **`tenant_domains`** — `domain_id` PK, `tenant_id` FK, `hostname` UNIQUE (lowercase, no space), `kind` (storefront|admin|platform|print|custom|preview), `status` (pending|verified|disabled), `verified_at`, `created_at`, `updated_at`.
- **`audit_events`** — `event_id` PK, `tenant_id` FK nullable, `actor_user_id`, `action`, `resource_type`, `resource_id`, `reason`, `request_id`, `metadata_json`, `created_at`. Append-only (UPDATE/DELETE triggers).
- **`idempotency_keys`** (unused) — `scope` PK, `tenant_id`, `actor_user_id`, `key_hash`, `operation`, `request_hash`, `response_status`, `response_json`, `state` (processing|completed|failed), `expires_at`, `created_at`, `updated_at`; UNIQUE `(COALESCE(tenant_id,'__platform__'), operation, key_hash)`.
- **`outbox_events`** (unused) — `outbox_id` PK, `tenant_id`, `event_type`, `aggregate_type`, `aggregate_id`, `dedupe_key` UNIQUE, `payload_json`, `status` (pending|processing|sent|skipped|failed), `attempts`, `max_attempts` (10), `next_attempt_at`, `lease_token`, `lease_until`, `last_attempt_at`, `resolved_at`, `last_error`, `created_at`, `updated_at`; processing ⇒ lease set.
- **`user`** — `id` PK, `name`, `email` UNIQUE, `emailVerified`, `image`, `createdAt`, `updatedAt` (DATE).
- **`session`** — `id` PK, `expiresAt`, `token` UNIQUE, `createdAt`, `updatedAt`, `ipAddress`, `userAgent`, `userId` FK cascade.
- **`account`** — `id` PK, `accountId`, `providerId`, `userId` FK cascade, `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `password`, `createdAt`, `updatedAt`.
- **`verification`** — `id` PK, `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`.
- **`rateLimit`** — `id` PK, `key` UNIQUE, `count`, `lastRequest` (Better Auth's own limiter).
- **`identity_access`** — `user_id` PK FK, `account_type` (ordinary|tenant_admin|platform_admin|print_operator), `status` (active|suspended|revoked), `created_at`, `updated_at`.
- **`tenant_memberships`** — `membership_id` PK, `tenant_id`, `user_id`, `role` (admin|customer|b2b_customer|affiliate), `status`, `created_at`, `updated_at`; UNIQUE `(tenant_id,user_id,role)`.
- **`print_memberships`** — `membership_id` PK, `tenant_id`, `user_id`, `status`, `created_at`, `updated_at`; UNIQUE `(tenant_id,user_id)`. No writer.
- **`email_deliveries`** — `delivery_id` PK, `tenant_id`, `kind` (email_verification|password_reset), `recipient_hash` (64 hex), `status` (pending|processing|sent|failed|expired), `attempts`, `max_attempts` (8), `next_attempt_at`, `lease_token`, `lease_until`, `provider_message_id` UNIQUE, `expires_at`, `last_error_code`, `resolved_at`, `created_at`, `updated_at`, `job_fingerprint` (64).
- **`products`** — `product_id` PK, `tenant_id`, `status` (draft|active|archived), `sku`, `name`, `description`, `b2c_price_minor` (≥0), `currency` (len 3), `is_pod` (0/1, never set to 1), `internal_json` (never selected publicly), `created_at`, `updated_at`, `weight_grams` (0–1,000,000), `allow_shipping` (default 1), `allow_pickup` (default 0), `shipping_json`; UNIQUE `(tenant_id, sku)`.
- **`product_variants`** — `variant_id` PK, `tenant_id`, `product_id` FK (immutable), `sku`, `label`, `price_minor`, `active`, `attributes_json`, `created_at`, `updated_at`; UNIQUE `(tenant_id, sku)`; tenant must match product.
- **`product_publications`** — `product_id` PK/FK (immutable), `tenant_id`, `published`, `public_name`, `public_description`, `public_price_minor`, `currency`, `projection_version` (≥1), `published_at`, `updated_at`; published ⇒ `published_at`.
- **`stored_objects`** — `object_id` PK, `tenant_id`, `bucket` (public|private|temp), `object_key`, `kind` (artwork_original|print_file|preview_image|product_media|shop_branding|document|export|temp_upload), `content_type`, `size_bytes`, `sha256`, `status` (pending|active|deleted), `immutable` (0/1; frozen rows cannot be re-pointed/re-hashed/deleted/unfrozen), `created_at`, `updated_at`; UNIQUE `(bucket, object_key)`; key must start `shops/{tenant_id}/`.
- **`checkouts`** (v2) — `checkout_id` PK, `tenant_id`, `status` (open|expired|abandoned|completed), `customer_email`, `currency`, `delivery_method` (shipping|pickup), `shipping_country` (A–Z ×2; NULL iff pickup), `subtotal_minor`, `shipping_minor`, `vat_minor`, `vat_rate_bp`, `discount_minor`, `total_minor`, `payment_intent_id` UNIQUE, `idempotency_key_hash`, `expires_at`, `created_at`, `updated_at`, `discount_code_id`; CHECKs `total = subtotal + shipping − discount`, `0 ≤ vat ≤ total`, pickup ⇒ shipping 0, discount>0 ⇒ code id, discount ≤ subtotal; UNIQUE `(tenant_id, idempotency_key_hash)`.
- **`checkout_items`** — `checkout_item_id` PK, `checkout_id` FK, `tenant_id`, `item_index`, `product_id` FK, `variant_id` FK, `sku`, `name`, `quantity` (1–999), `unit_price_minor`, `line_total_minor` (= qty × unit), `created_at`, `updated_at`; UNIQUE `(checkout_id, item_index)`; snapshot immutable; tenant/product/variant match triggers.
- **`rate_limit_windows`** — PK `(scope, key_hash, window_start)`, `count` (≥1), `created_at`, `updated_at`. No tenant, disposable.
- **`discount_codes`** — `discount_code_id` PK, `tenant_id`, `code` (1–50, uppercase), `active`, `type` (fixed|percent), `value_minor` (0–100,000,000), `percent_bp` (1–10000), `starts_at`, `ends_at`, `max_uses`, `used_count`, `min_spend_minor`, `scope` (all|products), `product_ids_json` (JSON array iff scope products), `created_at`, `updated_at`; UNIQUE `(tenant_id, code)`.
- **`orders`** — `order_id` PK, `tenant_id`, `checkout_id` UNIQUE FK, `payment_intent_id` UNIQUE, `order_number`, `status` (paid|processing|printed|shipped|ready_for_pickup|delivered|completed|partially_refunded|refunded|cancelled), `customer_email`, `currency`, `delivery_method`, `shipping_country`, `subtotal_minor`, `shipping_minor`, `vat_minor`, `vat_rate_bp`, `discount_minor`, `discount_code_id`, `total_minor`, `captured_minor`, `refunded_total_minor` (≤ captured), `stripe_event_id`, `paid_at`, `created_at`, `updated_at`; all checkout money CHECKs restated; UNIQUE `(tenant_id, order_number)`; `orders_money_immutable` freezes everything except `status`, `refunded_total_minor`, `updated_at`.
- **`order_items`** — `order_item_id` PK, `order_id` FK, `tenant_id`, `item_index`, `product_id`, `variant_id`, `sku`, `name`, `quantity`, `unit_price_minor`, `line_total_minor`, `created_at`, `updated_at`; snapshot immutable.
- **`order_status_history`** — `history_id` PK, `order_id`, `tenant_id`, `from_status`, `to_status`, `actor_user_id`, `reason`, `created_at`; append-only.
- **`payment_events`** — `event_id` PK (Stripe event id), `tenant_id` nullable, `provider` (stripe), `event_type`, `object_id`, `outcome` (processed|ignored|rejected), `reason_code`, `received_at`, `created_at`; append-only.
- **`pod_profiles`** (platform-level, no tenant) — `profile_id` PK (1–64), `label`, `min_dpi` (1–2400), `print_area_w_mm`, `print_area_h_mm` (1–10000), `max_file_mb` (1–200), `accepted_formats_json` (non-empty array), `sort_order`, `active`, `created_at`, `updated_at`.
- **`pod_artwork`** — `artwork_id` PK, `tenant_id`, `original_object_id` FK `stored_objects`, `profile_id` (frozen string, no FK), `status` (processing|ready|rejected; terminal once decided), `width_px`, `height_px`, `effective_dpi`, `max_print_w_mm`, `max_print_h_mm`, `pipeline_version`, `notices_json`, `reasons_json`, `print_object_key` (prefix `pod/{tenant}/print/`), `preview_object_key` (prefix `pod/{tenant}/preview/`), `print_sha256`, `print_bytes`, `preview_sha256`, `preview_bytes`, `created_at`, `updated_at`; ready ⇒ all 12 output/verdict fields; rejected ⇒ non-empty reasons; processing ⇒ no keys; keys write-once; UNIQUE `(tenant_id, original_object_id, profile_id)`.

Staging data present (handover, not re-queried): 1 platform admin (owner), tenant `demo` bound to `meteorshop-stg-api.micke-ohlen.workers.dev`, tenant admin `tenant-admin@demo.invalid`, stg-e2e catalogue, discount code `SMOKE10`, checkouts, order `20260822-S2K41A2E`, its `payment_events` row.

## 6. R2 buckets and object-key contracts

| Bucket | Bound as | Used for |
|---|---|---|
| `meteorshop-stg-private` | `PRIVATE_BUCKET` | admin objects + POD outputs |
| `meteorshop-stg-public` | unbound | nothing yet |
| `meteorshop-stg-temp` | unbound | nothing yet |

All three created with location hint WEUR.

- **Owned objects:** key `shops/{tenantId}/{kind}/{objectId}/v1/{safeFileName}` (lowercased, `[a-z0-9._-]`, ≤100 chars, fallback name). Kind → bucket map: `artwork_original`, `document`, `export`, `print_file` → private; `preview_image`, `product_media`, `shop_branding` → public; `temp_upload` → temp. The D1 row is the sole authority; the key is never authorization.
- **POD outputs (server-owned, not `stored_objects` rows):** `pod/{tenantId}/print/{artworkId}.png` (`image/png`) and `pod/{tenantId}/preview/{artworkId}.webp` (`image/webp`) in the private bucket. Unreachable through `/v1/admin/objects/*` by construction.
- **Presigned URLs:** path-style `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{bucket}/{key}?X-Amz-Expires=…`, region `auto`, service `s3`, `signQuery:true`, `allHeaders:true`. TTL 900 s for farm job URLs, 300 s for preview GETs.

## 7. Render-farm contract (branch-only)

- Contract v0 (`docs/RENDER_FARM_CONTRACT.md`): Worker → farm HTTPS POST, `Authorization: Bearer RENDER_FARM_TOKEN`, envelope `{contract:1, jobType:"pod.process_artwork", jobId, input:{url, maxBytes}, profile:{id, min_dpi, print_area_mm:{w,h}, max_file_mb, accepted_formats:[{ext}]}, output:{printPngPutUrl, previewWebpPutUrl}}`; 200 `{ok:true,…}` with sha256/bytes double-report, 200 `{ok:false, reasons}` for gate rejections (Swedish messages), 400/401/404/502 constant bodies. Farm allowlists `.r2.cloudflarestorage.com` for input and both outputs, streams with a cap, `redirect:'error'`, logs no URLs. `studio.render_video` reserved (needs an async revision).
- Firebase half: `functions/src/pod/artworkPipelineCore.ts` (only sharp importer; `sharp.cache(false)`, `concurrency(1)`), `functions/src/render-farm/processArtworkJob.ts`, export `renderFarmProcessArtwork`, `functions/scripts/verify-pipeline-core.mjs`. Not on main, not deployed.

## 8. Test surface

- **Runner:** `@cloudflare/vitest-pool-workers` 0.21.3 `cloudflareTest()` plugin (Vitest 4), reads `wrangler.jsonc`, applies all migrations to a miniflare D1 in `test/apply-migrations.ts` (`beforeAll` → `applyD1Migrations`), miniflare R2 `PRIVATE_BUCKET`, fake secrets as miniflare bindings. Stripe and the farm are replaced through symbol-keyed env overrides (`STRIPE_GATEWAY_OVERRIDE`, `STRIPE_WEBHOOK_VERIFIER_OVERRIDE`, `RENDER_FARM_OVERRIDE`, `R2_PRESIGNER_OVERRIDE` — plain `Symbol(...)`); webhook tests sign with the SDK's own `generateTestHeaderStringAsync` and verify for real. No test touches real Stripe, R2 S3 endpoint, or the farm.
- **Files:** 26 `*.test.ts` (+ `apply-migrations.ts`, `env.d.ts`); 916 test cases at runtime (≈488 static `it`/`test` declarations expanded by `.each` and loops). Coverage by file: `health`, `platform-foundation` (tenancy triggers), `auth-identity`, `tenant-authorization`, `request-authorization`, `unconfigured-auth`, `auth-routes`, `auth-email-job`, `email-delivery-store`, `disabled-email-queue`, `public-storefront`, `public-catalog`, `admin-catalog`, `provision-tenants`, `provision-users`, `bootstrap`, `same-origin`, `object-store`, `object-routes`, `rate-limit`, `checkout` (71 decl.), `discount-codes`, `admin-discount-codes`, `payment`, `webhook`, `pod-artwork`.
- **Current state:** 868/916 at HEAD (section 0).
- **Mutation-log practice:** manual (no mutation tool installed). The builder deliberately weakens one guard at a time, runs the suite, and records whether named tests fail ("killed"), stay green ("survived" → a suite gap, closed with a new test and re-run), or cannot change behaviour ("equivalent mutant", stated honestly). Logged tables in the handover: cp22 (15 mutations), cp23 (8), cp24 (8/8 killed; one initially survived → non-idempotent-gateway race tests added), cp25 (11: 9 killed, 1 equivalent, gaps #6b/#11 closed), cp27 (14: 13 killed, 1 equivalent, gaps #4/#5b-vs-#5). Earlier checkpoints mutation-tested specific guards (cp12, cp13, cp14, cp21). Companion rituals per checkpoint: control-byte scan (python), `npm audit`, dry-run bundle size, `wrangler check startup`.
- **Operator scripts (`cloudflare/scripts/`):** `stg-smoke.sh` (platform sign-in, demo tenant, storefront, suspend/activate), `stg-e2e.sh` (full tenant/product/discount/R2/checkout loop with exact money), `stg-payment-e2e.sh` (checkout → PI → confirm with `sk_test_` prompted locally → replay). All hard-code `BASE=https://meteorshop-stg-api.micke-ohlen.workers.dev`.

## 9. Gap analysis versus main

### 9.1 Main's 82 Firebase exports → Cloudflare status

Status: **—** none; **P** partial; **S** exists but stale; **R** replaced by design.

| Domain | Export | CF |
|---|---|---|
| Email | `sendOrderConfirmationEmail`, `sendOrderStatusUpdateEmail`, `sendOrderNotificationAdmin`, `sendPasswordResetEmail`, `sendLoginCredentialsEmail`, `sendAffiliateWelcomeEmail`, `sendAffiliateApplicationEmails`, `sendCustomEmailVerification`, `verifyEmailCode`, `confirmPasswordReset`, `confirmPasswordResetV2` | — (auth-email contract/ledger library only) |
| Identity/admin | `createShopUser` | P (`POST /v1/platform/users` + `/tenants/{id}/admins`; no credentials email) |
| | `createPlatformSuperAdmin` | P (one-time bootstrap only) |
| | `createAdminUserV2` | P (same as createShopUser) |
| | `syncUserClaimsOnWrite`, `syncAdminClaims` | R (live D1 authorization, no claims) |
| | `deletePlatformUser`, `deleteCustomerAccountV2`, `deleteB2CCustomerAccountV2`, `toggleCustomerActiveStatusV2` | — |
| | `approveAffiliate` | — |
| Migrators | `migrateFromShopify`, `migrateFromWoo` | — |
| Commerce | `validateDiscountCode` | P (checkout returns applied discount; no advisory endpoint; no affiliate) |
| | `logAffiliateClickV2`, `processB2COrderCompletionHttpV2`, `reverseAffiliateCommissionOnCancel`, `createB2BOrder`, `cancelB2BOrder`, `getGeoDataV2`, `submitLead`, `submitWithdrawal` | — |
| Payments | `createPaymentIntentV2` | S (see 9.3) |
| | `stripeWebhookV2` | S (see 9.3) |
| | `createConnectAccount`, `createConnectAccountLink`, `refreshConnectStatus`, `createConnectLoginLink`, `setShopCommission`, `getConnectBalance`, `setConnectPayoutDelay`, `refundOrder` | — |
| DAC7 | `saveDac7SellerProfile`, `getDac7SellerProfile`, `pullDac7FromStripe`, `aggregateDac7Year`, `exportDac7Report`, `getOwnDac7`, `correctOwnDac7Contact`, `requestDac7Correction`, `resolveDac7Correction` | — |
| Utility | `scrapeWebsiteMetaV2` | — |
| Print | `getPrintQueue`, `getPrintJob`, `getPrintQueueExport`, `getPrintArtworkLibrary`, `getPrintArtworkDownload`, `setPrintJobStatus`, `onOrderProductionReady`, `sweepPrintNotifyOutbox`, `syncPrintersPublicOnWrite` | — |
| | `createPrintShopUser` | P (`print_operator` creatable; no tenant assignment, no printer profile) |
| POD | `processPodArtwork` | S (dark; single-profile model predates per-printer areas) |
| | `quotePodCost` | — |
| Screening | `submitInfringementReport`, `takedownProduct`, `screenProductOnWrite`, `rescreenProductsOnMappingWrite`, `rescreenProductsOnArtworkWrite` | — |
| Catalogue | `syncProductsPublicOnWrite` | R (`product_publications` maintained in the same batch) |
| Recovery | `sweepAbandonedCheckouts`, `resolveCheckoutRecovery`, `unsubscribeCheckout` | — |
| Reviews | `onOrderReviewQualify`, `sweepReviewRequests`, `resolveReviewRequest`, `submitReview`, `unsubscribeReviews`, `moderateReview` | — |
| Content studio | `generateSocialCopy`, `renderSocialVideo`, `getHandoffPackage` | — |

Branch-only export (not on main): `renderFarmProcessArtwork`.

### 9.2 Main's Firestore collections → D1

| Firestore | D1 counterpart |
|---|---|
| `shops` | `tenants` + `tenant_domains` (P — most shop fields absent) |
| `users` | Better Auth `user` + `identity_access` + memberships (P) |
| `products` | `products` + `product_variants` (P — main embeds variants in the product doc keyed by `variantSku`; no images/POD/category fields) |
| `productsPublic` | `product_publications` |
| `checkouts` | `checkouts` + `checkout_items` (different meaning: main's doc is keyed by PI id and carries recovery + production snapshot) |
| `orders` | `orders` + `order_items` + `order_status_history` (P) |
| `discountCodes` | `discount_codes` |
| `podArtwork` | `pod_artwork` |
| `settings` (`podProfiles`) | `pod_profiles` (P) |
| `auditLogs`, `impersonationAudit` | `audit_events` could host them; nothing writes those events |
| `rateLimits` | `rate_limit_windows` |
| `passwordResets`, `emailVerifications` | Better Auth `verification` (unmounted) |
| `printNotifications` | `outbox_events` exists, unused |
| **none:** `activities`, `adminCustomerDocuments`, `adminPresence`, `adminUIDs`, `affiliateApplications`, `affiliateClicks`, `affiliatePayouts`, `affiliates`, `ambassadorActivities`, `appSettings`, `b2bCustomers`, `b2cCustomers`, `campaigns`, `campaignParticipants`, `campaignRevenueTracking`, `checkoutSuppressions`, `collections`, `customerDocuments`, `dac7CorrectionRequests`, `dac7Sellers`, `deferredActivities`, `followUps`, `infringementReports`, `leads`, `marketingMaterials`, `migrations`, `orderProduction`, `orderStatuses`, `pages`, `pod3dModels`, `podMappings`, `printers`, `printersPublic`, `productGroups`, `productReviews`, `reviewRequests`, `reviewSuppressions`, `socialPosts`, `translations_*`, `userMentions`, `userWagonSettings` | — |

Firebase Storage paths with no R2 contract yet: `branding/{shopId}`, `collections/{shopId}`, `content-studio*/{shopId}`, `marketing-materials/…`, `orders/{orderId}`, `pages/{shopId}/…`, `pod-3d-models`, `products/{shopId}`, `admin-documents/…`, `affiliates/…/invoices`, `users/{uid}/profile.jpg`. `pod-artwork/{shopId}` maps onto `shops/{tenant}/artwork_original/…` + `pod/{tenant}/print|preview/…`.

### 9.3 Stale versus main's current business rules

"At base?" = already present in main's code at the branch base `019a0b7` (2026-08-15), i.e. a gap the branch deferred on purpose rather than drift. Checked with `git show 019a0b7:functions/src/payment/createPaymentIntent.ts` / `stripeWebhook.ts`.

| Area | Branch | Main now | At base? |
|---|---|---|---|
| Legal gate (`354990a`, 2026-09-07) | none | PI refused unless `storeIdentity.returnAddress`, boolean `vatRegistered`, `legal.acceptance.acceptedAt`; seller acceptance evidence, platform terms gate, copy-on-write legal pages | **no — new** |
| Shop-live gate | tenant `status='active'` only | also `status==='disabled'` kill-switch and `published===false` go-live gate | yes |
| Pickup | per-product `allow_pickup`; no location | server-resolved pickup location id + date from shop config (P1-06) | yes |
| Withdrawal (ångerrätt) | none | personalized items require consent proof (`noticeVersion`, fingerprint) stamped into metadata/order | yes |
| Discount | campaign only, no flags | affiliate first (wins), then campaign; both gated by add-on flags | yes |
| POD production snapshot | none | frozen before PI (atomic), unresolved → 409; `productionSnapshotRequired` marker | yes; the `podEnabled` skip for non-POD shops is **new** (`ed4645a`, 2026-08-18) |
| Routing/withholding (SnapWear A1–A4: `9e2e671`, `cd8fac9`, `de5fa3c`, `0eb9c78`) | none | per-garment routing to a printer, printer price tiers, frozen `printerUid` + cost per line, withholding inside `application_fee_amount`, four 409 block reasons | **no — new** (2026-08-30 → 2026-09-25) |
| One-number money (A13/A1b, `59da67a`, 2026-09-26) | none | webhook splits money into private `orderProduction/{piId}`; `quotePodCost`; seller sees one number | **no — new** |
| PI params | `amount, currency, automatic_payment_methods, metadata{checkout_id, tenant_id}` | + `receipt_email`, `description`, `statement_descriptor_suffix`, `transfer_data.destination`, `application_fee_amount`, rich metadata | yes (all five params); only the withholding share of the fee is new |
| Stripe API version | `2026-07-29.dahlia` | `2023-10-16` (account + live webhook) | yes |
| Webhook events | `payment_intent.succeeded` | + `payment_intent.payment_failed`, `account.updated`, `charge.dispute.created`, `charge.dispute.closed` | yes |
| Print areas | one profile list, single area per profile (seed from `POD_PRINT_SPEC.md`) | per-printer areas + capability gating (`0eb9c78`); front width 300 mm (`500a664`) | **no — new** |
| Screening/takedown (`89de8af`, `557c63d`) | none | pre-publish brand screening + notice-and-takedown | **no — new** |

What did **not** change on main (so the branch stays in parity): shipping-tier math, VAT derivation, campaign discount math, and `processArtwork.ts` pipeline behaviour (unchanged since `ed4645a`, 2026-08-18).

## 10. Which Cloudflare account staging lives in

- `account_id` **`0d392e5c79e386966a98a214ac91a133`** — pinned in `wrangler.jsonc` and used as `R2_ACCOUNT_ID`.
- Docs call it the owner's **personal Cloudflare account**, designated for non-production (`CLOUDFLARE_MIGRATION.md` §1 names it `MeteorShop Non-Production`; whether the account was actually renamed is not recorded).
- Workers subdomain **`micke-ohlen.workers.dev`** (`https://meteorshop-stg-api.micke-ohlen.workers.dev`).
- The same account has Email Sending enabled for **`outpost.mohlenmedia.com`** (unrelated; handover says never reuse or change it). The account also holds other unrelated personal resources (cutover checklist 1.1).
- Branch commits are authored as `micke@mohlenmedia.com`.
- A production account (`MeteorShop Production` / `Meteor Production`) was planned but **does not exist**; no production resources, DNS, routes, or custom domains were created.
- Resources in the account (per handover; not re-queried): Worker `meteorshop-stg-api`; D1 `meteorshop-stg-db` (`d709e702-17f6-4107-ad45-060f2b24dc89`, WEUR); Queues `meteorshop-stg-email-auth` + `-dlq`; R2 `meteorshop-stg-public`, `-private`, `-temp`. Planned but never created: `meteorshop-stg-web`, `-jobs`, `-media`, `-media-jobs`, `-email`, `-commerce`, `-print`, `-maintenance` (+ DLQs).
- Stripe staging lives in the sandbox **"Meteor Public Relations AB-sandlåda"** (`acct_1Tp7gtKAaBMOW5AC`), not classic test mode and not Mohlen Media.
- To confirm before any remote step: `npx wrangler whoami` from `cloudflare/` (never with the unrelated `CLOUDFLARE_API_TOKEN`).
