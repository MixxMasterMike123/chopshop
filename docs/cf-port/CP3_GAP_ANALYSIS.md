# CP3 gap analysis — what exists, what is missing, how the work is split

Status: read-only investigation at HEAD `066b7e5d` (2026-09-27), before any CP3 code. Input for the CP3 builders and the reviewer. Rulings on the open questions are in `DECISIONS.md` D50–D59.

`$CF` = `cloudflare/`. Line numbers in `$CF/src/app.ts` were taken BEFORE the CP3 anchors were inserted (`d7b4b85`); from the import section onward they are now about 15 lines higher, and from the route table onward about 60 lines higher. Search for the symbol, do not trust the number.

**Two findings that shape everything:**
1. **None of the CP3 target tables exist.** No hit in `$CF/migrations`, `$CF/src` or `$CF/test` for `platform_settings`, `tenant_settings`, `tenant_features`, `legal_acceptances`, `infringement_reports`, `printer_catalog`, `legacy_id_map`, `import_runs`. The manifest marks several as "new, CP2" (rows 65, 67, 72); they were not built in CP2.
2. Migrations are `0001–0031` with **no `0020`**. The next free number is `0032`. **Never use `0020`**: tests apply files in name order (`$CF/vitest.config.ts`), staging already holds 0001–0031 and would apply a new 0020 last, which gives two different histories.

---

## 1. Gap table

### a. Tenant config, features, live gate, hostnames

| | |
|---|---|
| **Exists** | `tenants` (`0001_platform_foundation.sql:3-13`; status CHECK `provisioning/active/suspended/closed`; a `settings_json` column with no reader), `vat_rate_bp` (`0009`), Connect columns + `commission_bps` (`0019_money.sql:28-45`), `catalog_version` + `published` default 1 (`0025:40-44`, comment: "the writer is CP3's live-gate route"). `tenant_domains` with UNIQUE hostname and an immutable `tenant_id` trigger (`0001:25-42`). POST-only routes in `$CF/src/platform/provision-tenants.ts:296-590`: create tenant, `…/:id/activate`, `/suspend`, `/admins`, `/domains` (add). Acting-as `$CF/src/routes/acting-as.ts` + `0013`. Live-gate reader `$CF/src/catalog/eligibility.ts:53`. Tests: `provision-tenants.test.ts`, `platform-foundation.test.ts`, `tenant-authorization.test.ts`. |
| **Missing** | `tenant_settings`, `tenant_features`. Any GET on `/v1/platform/tenants*` (the handler 404s every non-POST). Writer for `tenants.published`. Domain list / disable / move / delete. Writer for `commission_bps`, `shop_name`, `support_email`, `vat_rate_bp`. No route reaches status `closed`. |
| **Firebase source** | `src/components/platform/ProvisionShopModal.jsx:100-133`; `src/pages/platform/PlatformShopDetail.jsx:98-156`; `src/pages/platform/PlatformAddons.jsx`; `src/config/addons.js:26-59` (catalogue, `OPT_IN_KEYS`); `functions/src/config/shopFeatures.ts:22-48`; `src/config/shopConfig.js:40-91`; `functions/src/payment/createPaymentIntent.ts:45-50` (`shopCheckoutBlockReason`); `src/components/shop/ShopGate.jsx:87-125`. |

A hostname "move" cannot be an UPDATE of `tenant_id` (trigger). It is DELETE old row + INSERT new row in one audited batch; nothing references `tenant_domains` by foreign key.

### b. Users + memberships

| | |
|---|---|
| **Exists** | Better Auth tables + `identity_access`, `tenant_memberships`, `print_memberships` (`0002_auth_identity.sql:62-101`). `POST /v1/platform/bootstrap`. `POST /v1/platform/users` creating `tenant_admin` or `print_operator` with an operator-chosen password (`$CF/src/platform/provision-users.ts:56-82`). Tenant-admin grant (`provision-tenants.ts:464-590`). `revokeUserSessions` helper, used by no route (`$CF/src/auth/request-authorization.ts:130-140`). Tests: `provision-users.test.ts`, `bootstrap.test.ts`. |
| **Missing** | List users. Deactivate / reactivate. Membership revoke. Last-platform-admin guard. Invite / reset-link flow (the module header calls the password model interim). `legacy_id_map`. Migration-only 72 h reset expiry (TTL is 1 h, `$CF/src/auth/password-reset.ts:37`). Platform-admin creation is deliberately refused (`provision-users.ts:27-37`) and stays refused (D51). |
| **Firebase source** | `functions/src/email-orchestrator/functions/platformUsers.ts:45` (create), `:158-260` (delete with self-delete and last-admin guards); `createShopUser.ts:30-110`; `src/pages/platform/PlatformUsers.jsx`; `src/components/platform/AddShopUserModal.jsx`. |

Every user foreign key is `ON DELETE RESTRICT`, so "delete" on Cloudflare means deactivate.

### c. Printers, tiers, areas, routing, price-free read, catalogue

| | |
|---|---|
| **Exists** | `printers`, `printer_sku_tiers`, `pod_mappings` (`0023_pod_printers_mappings.sql`). `PUT /v1/platform/printers`, replace-all (`$CF/src/routes/pod-platform.ts:53-79`, `$CF/src/pod/printers.ts:536`). **The price-free seller read already exists**: `GET /v1/admin/pod/printers` returns `{capabilities, name, printerId}` only (`printers.ts:436-466`, `$CF/src/routes/pod-admin.ts:75-79`); the one-number rule is tested in `pod-mappings.test.ts`. `pod_profiles` (`0012`) with a platform PUT. |
| **Missing** | `GET /v1/platform/printers` with tiers and shipping. The PUT is replace-all with no read, so an operator cannot edit safely (the seed script needs `SLICE_ALLOW_PRINTER_REPLACE` for this reason). Per-printer partial edit. Default printer. `printer_catalog`. `garments[]` and `provisionalAreas` are absent from the tenant view (the Firebase projection has them, `functions/src/print/projectPrinterPublic.ts:22-30`). |
| **Firebase source** | `functions/src/print/printRouting.ts:34-59`; `projectPrinterPublic.ts:66-78`; `printProjection.ts:147-160`; `src/pages/platform/PlatformPrinters.jsx:89-92,177-275`; `scripts/seed-snapwear-printer.cjs:256-289`. |

**Model mismatch:** Firebase prices per garment and routes by garment. Cloudflare prices per printer SKU and the mapping names printer + SKU directly ("routing is the printer set itself", `printers.ts:7-13`). No routing table is built (D52).

### d. Settings

| | |
|---|---|
| **Exists** | `content_screening_terms(term, kind, hard_block, created_at)` (`0024:96-101`), read by `$CF/src/catalog/screening.ts:100-113`. `platform_state` single row, digest bookkeeping only (`0029`). Code constants: `DEFAULT_COMMISSION_BPS = 500` (`$CF/src/commerce/payment.ts:64`), `REFUND_APPLICATION_FEE = false` (`refunds.ts:78`), `REVERSE_DISPUTE_ON_CREATED = true` (`stripe-events.ts:85`), `REVIEW_FIRST_PRODUCTS = 2` (`$CF/src/catalog/screening-core.ts:220`). Screening queue routes (`pod-platform.ts:81-126`). |
| **Missing** | `platform_settings`. Any write route for terms (`0024:93`: "The write route is CP3"). A `note` column. **Global `hardBlock` is not wired**: Cloudflare computes `hits.some(hit => hit.hardBlock)` (`screening.ts:334`), Firebase computes `settings.hardBlock === true || hits.some(...)` (`functions/src/catalog/screenProductOnWrite.ts:119`). |
| **Firebase source** | `functions/src/payment/platformConfig.ts:43-67`; `functions/src/catalog/contentScreening.ts`; `screenProductOnWrite.ts:94-127`; `scripts/seed-content-screening.cjs`. |

Store all three money values, but keep `refund_application_fee` pinned to 0 by CHECK: the D36 withholding release assumes a non-refundable fee (`$CF/src/commerce/withholding-release.ts:25`). Only `default_commission_bps` is editable in CP3; `resolveCommissionBps` already takes a platform default parameter (`payment.ts:78`, call site near `:522`).

### e. Legal / terms

| | |
|---|---|
| **Exists** | `platform_terms_versions` (seeded `2026-09-07`) and `platform_terms_acceptances`, both append-only (`0031_legal_consent.sql:48-141`). Gate `hasAcceptedCurrentTerms` (`$CF/src/legal/platform-terms.ts:64-70`), called in `$CF/src/commerce/checkout.ts` (near `:1058`). Routes `GET /v1/admin/legal/status`, `POST /v1/admin/legal/accept-terms` (`$CF/src/routes/legal-admin.ts`). Buyer consent (`$CF/src/legal/consent.ts`). Tests `legal.test.ts`. |
| **Missing** | `legal_acceptances` (manifest row 65). Seller legal-PAGES acceptance route. Legal-pages readiness gate at checkout (`returnAddress`, boolean `vatRegistered`, acceptance). **D47 grace**: `readTermsStatus` is strict current-version (`platform-terms.ts:38-61`). Platform route to publish a terms version (today a migration row). Archived text per version (evidence holds only a hash). |
| **Firebase source** | `src/utils/legalAcceptance.js:78-116` (legal pages), `:120-160` (platform terms); `src/utils/legalPageReadiness.js:60`; `functions/src/payment/createPaymentIntent.ts:62-71`; `src/config/legalTemplates.js`; `src/config/platformTerms.js`; `src/components/admin/PlatformTermsGate.jsx:99-121`. |

The two acceptances are different contracts. 0031 is platform ↔ seller. Row 65's `legalPages` type is the seller adopting the three consumer pages, with an HTML snapshot. `platform_terms_acceptances.evidence_json` is capped at 4096 bytes, so HTML snapshots cannot go there.

### f. Reports queue

| | |
|---|---|
| **Exists** | Takedown: `POST /v1/platform/screening/:productId {"decision":"blocked"}` → `decideByPlatform` (`screening.ts:516-581`) stamps `products.takedown_at`, sets screening `blocked`, audits `screening.takedown`. Delete protection trigger (`0025:32-38`). |
| **Missing** | `infringement_reports`. Intake route. Platform list + handle (`reviewing` / `rejected` / `taken_down`, note, handled by/at). Report → takedown in one batch: `decideByPlatform` accepts no report id or note. |
| **Firebase source** | `functions/src/infringement/submitInfringementReport.ts:86-165`; `takedownProduct.ts:47-140` (checks report shop = product shop, `:88-95`); `src/pages/platform/PlatformReports.jsx:476-550`. |

### g. Stripe Connect onboarding

| | |
|---|---|
| **Exists** | Connect columns, unique index on `stripe_account_id`, flag-needs-account triggers (`0019:28-72`). Resync flag (`0027`). `account.updated` handler (`$CF/src/commerce/stripe-events.ts:855-910`). Resync in reconciliation (`$CF/src/commerce/crons.ts:503-560`). Gateway `retrieveAccount` (`$CF/src/commerce/stripe-client.ts`). Payment gate (`payment.ts:212`). API pin `2026-07-29.dahlia`. Stripe SDK 22.5.0 ships the v2 resources (`node_modules/stripe/esm/resources/V2/Core/`). Tests `payment-connect.test.ts`. |
| **Missing** | Account create, onboarding link, status refresh, Express login link, payout delay. `connect_enabled` opt-in. Columns for requirements, connect status, `payout_delay_days`. |
| **Firebase source** | `functions/src/payment/connectOnboarding.ts:116` (create; SE/SEK, monthly payouts, `:139-146`), `:176` (link), `:195` (refresh), `:218` (login link), `:292` (payout delay); `deriveStatus` `:62-67`; return URLs carry the shop id `:98-110`; `src/pages/admin/AdminPayments.jsx`. |

PLAN §3.1 lists "Connect onboarding endpoints" in the CP2 slice, so this is CP2 debt landing in CP3. Two design requirements from the staging run: (1) creation is reserve-first — an operation row whose id is the Stripe idempotency key, then a guarded `UPDATE tenants … WHERE stripe_account_id IS NULL`; (2) Stripe replays a refusal for 24 h under the same key, so a refused operation must be retryable under a new operation id.

### h. What the seed script does that no route can do

| # | Seed step | Gap |
|---|---|---|
| 1 | Free the API hostname from `bench-cp1` | No domain move / disable route |
| 2 | Create the Express account + account link through the Stripe API | Item g |
| 3 | Set the Connect facts by SQL | Item g (refresh route) |
| 4 | Find which tenant holds a host: prints a `SELECT` | No tenant / domain read |
| 5 | Find a product by SKU: prints a `SELECT` | Admin product route has no GET; the products list is CP5 |
| 6 | Build the printer document from `snapwear-catalog.json` | No catalogue import (323 SKUs / 47 models by hand) |
| 7 | Read printers only through the tenant route under acting-as | No platform GET printers |
| 8 | Create the seller's admin with a password the operator picks | Invite flow missing; acting-as correctly cannot accept terms |
| 9 | Confirm the PaymentIntent with `pm_card_visa` | Buyer action, not a platform gap |

---

## 2. Frontend scope

The documents disagree (PLAN §10 row CP3 has no "swapped / diff-clean"; `DESIGN_CONTRACT.md:459,526-532` marks the platform page set CP3). Ruling D50: **CP3 = API + data**, because there is no admin/platform design baseline, no `src/api/` client and no web Worker. The exit is a routes-only slice. The page swap is CP3b.

---

## 3. Migration scripts

### 3.1 The 22 carry rows

**The CP3 importer handles (12 rows):** 12 `auditLogs` → `audit_events`; 33 `infringementReports` → `infringement_reports`; 45 `printerCatalog` → `printer_catalog`; 46 `printers` → `printers` + `printer_sku_tiers` (transform; only `snapwear`, D12; inactive on staging, D59); 56 `shops` → `tenants`, `tenant_domains`, `tenant_settings`, `tenant_features` (Connect facts are `tenants` columns); 62 `users` → Better Auth `user` / `account`, `identity_access`, `tenant_memberships`, `legacy_id_map`; 65 `shops/*/legalAcceptances` → `legal_acceptances`; 67 `settings/platform` → `platform_settings` (absent in prod; values set explicitly); 68 `settings/app` (assert absent); 69 `settings/printRouting` → default printer only (D52); 70 `settings/podProfiles` → `pod_profiles`; 72 `settings/contentScreening` → `content_screening_terms` + settings.

**Explicitly deferred, with a printed reason and no writes (10 rows):** 20 `collections` (CP4); 40 `pages` (CP4); 51 `products` (CP4); 44 `podMappings` (CP4, foreign keys to products and artwork, different key); 43 `podArtwork` (CP4, D53); 58–60 `translations_*` (CP4, static JSON, D16); 42 `pod3dModels` (CP6); 71 `settings/podMockupTemplates` (CP6).

### 3.2 Preconditions → checks

| Id | Check in the script |
|---|---|
| C1 | Shell out to `scripts/cf-preflight.sh <env> -- d1 migrations list <db> --remote`; require exit 0. Every D1 write goes through the preflight. |
| C2 | `lib/verify-bundle.mjs` verifies `SHA256SUMS`; the schema version equals the importer's constant. |
| C3 | `SELECT name FROM d1_migrations` through the preflight; require every file in `$CF/migrations/` up to the CP3 head. |
| C4 | The plan is the generated SQL, deterministically ordered. Plan sha = sha256(bundle sha + SQL). `--apply --plan <sha>` recomputes and refuses on mismatch. |
| C5 | Ids come from Firestore ids or `legacy_id_map`. A content hash per (table, pk) is stored; same id + same hash skips, same id + different hash aborts. One `import_runs` row per run. |
| C6 | Rows carrying a rewritten key are emitted only if the storage copy manifest holds a verified entry. In CP3: the four branding URLs inside `storeIdentity` (row 56). |
| C7 | User email (also against users already in the target), tenant id, hostname. |
| C8 | Every uid field goes through the map; unmapped ones go to `*_legacy_uid` with a report line. |
| S1 | `/health` says `staging` and the pinned ids match. |
| S2 | A Time Travel bookmark before apply; `--reset` prints the restore command (D56). A DELETE-based reset is impossible: `audit_events` and the acceptances reject DELETE. |
| S3 | `--email-map` and `--connect-map` files kept outside the repo; refuse on any unmapped address. Covers `tenants.support_email`, the `storeIdentity` emails, acceptance emails and reporter emails, not only users. |
| S4 | Bucket names from `pinned.staging.json`; the public base URL is pinned there too (D55). |

### 3.3 Facts the importer must respect

- `pod_artwork.status` allows only `processing`, `ready`, `rejected` (`0012:151`); relevant again in CP4.
- Printer ids must match `NOT GLOB '*[^a-z0-9-]*'` (`0023:36-38`); the two uid-keyed legacy printers could not be inserted anyway (D12 archives them).
- D21: one shop is archived, so manifest checks that say "5 tenants" become 4.
- The unique index on `stripe_account_id` (`0019:50-51`) means each mapped sandbox account can belong to one tenant.
- Shop status maps `active → active`, `disabled → suspended` (D59).
- An imported user whose mapped email already exists in the target is adopted (D59); staging already has the bootstrapped platform admin.

---

## 4. The split

Route-mount convention: each builder appends only inside its own `CP3-IMPORTS-x` and `CP3-ROUTES-x` anchor blocks in `$CF/src/app.ts`. The route block sits BEFORE the older platform handlers, because three of them answer a terminal 404 for methods they do not own (`/v1/platform/users` POST-only, `/v1/platform/printers` PUT-only, the tenant prefix POST-only). A CP3 route registers an exact path and is wrapped in `onMethods([...])`, which lets every other method fall through.

| Builder | Migration | Owns | Delivers |
|---|---|---|---|
| **CP3-A Tenants** | `0032_tenant_config.sql` | `src/platform/{tenant-directory,tenant-config,tenant-domains}.ts`, `src/routes/{platform-tenants,admin-settings}.ts`, `test/{platform-tenants,tenant-domains,tenant-features,admin-settings}.test.ts`, `test/tenant-fixtures.ts` | `tenant_settings`, `tenant_features`; tenant list / read; edit name, support email, VAT, commission; publish / unpublish / close; features with effective values; store identity; domains list, disable, enable, move, delete |
| **CP3-B Identity** | `0033_identity_import_support.sql` | `src/platform/{user-directory,user-lifecycle,invites}.ts`, `src/routes/platform-users.ts`, existing `src/auth/{password-reset,create-auth}.ts`, `test/{platform-users,user-lifecycle,invites}.test.ts` | `legacy_id_map`, `import_runs` + row hashes; user list; deactivate / reactivate; membership revoke; invite link with 72 h expiry |
| **CP3-C Printers** | `0035_print_defaults.sql` | existing `src/pod/printers.ts`, `src/routes/{pod-platform,pod-admin}.ts`; new `src/pod/{print-defaults,printer-catalog}.ts`, `test/{printers-platform,print-defaults,printer-catalog}.test.ts` | platform read of printers with tiers; per-printer partial edit; default printer; `printer_catalog` + catalogue import; tenant view gains `garments` and `provisionalAreas` |
| **CP3-D Settings + trust & safety** | `0034_platform_settings.sql`, `0036_infringement_reports.sql` | new `src/platform/platform-settings.ts`, `src/routes/{platform-settings,platform-reports,storefront-reports}.ts`, `src/catalog/infringement-reports.ts`; existing `src/catalog/{screening,screening-core}.ts`, `src/commerce/payment.ts` (commission call site only); `test/{platform-settings,screening-settings,infringement-reports}.test.ts` | `platform_settings`; terms CRUD + `note`; global hard block and review-first from settings; `infringement_reports`; intake; platform list / handle; takedown with report in one batch |
| **CP3-E Legal** | `0037_legal_acceptances.sql` | existing `src/legal/platform-terms.ts`, `src/routes/legal-admin.ts`, `src/commerce/checkout.ts` (gate only), `test/legal.test.ts`, `test/legal-fixtures.ts`; new `src/legal/legal-pages.ts`, `src/routes/legal-platform.ts`, `test/legal-pages.test.ts` | D47 grace; status with accepted version and grace deadline; publish-version route with archived text; `legal_acceptances`; legal-pages accept route. The readiness gate follows once 0032 has landed. |
| **CP3-F Connect** | `0038_connect_onboarding.sql` | new `src/commerce/{connect-gateway,connect-onboarding}.ts`, `src/routes/{connect-admin,connect-platform}.ts`, `test/connect-onboarding.test.ts` | onboarding operations table; `connect_enabled`, requirements, `payout_delay_days`; create-or-reuse account, onboarding link, refresh, login link, enable toggle, payout delay |
| **CP3-S Scripts** | none | `scripts/cf-port/migrate/**` | storage listing + copy (branding); dry-run importer for the 12 rows with explicit deferral of the 10; staging scrub; verify; restore |

**Reviewer only, at consolidation:** `REQUIRED_MIGRATION` (`app.ts`, `test/health.test.ts`, `test/public-catalog.test.ts`), `wrangler.jsonc`, `env.d.ts`, `vitest.config.ts`.

---

## 5. Risks

1. **Production personal data.** The exporter reads full documents and Auth users into a directory outside the repo (modes 700 / 600). The email and Connect maps stay outside the repo.
2. **Guard.** Every tracked file is scanned for the legacy brand patterns and the allowlist may never grow. Only `scripts/cf-port/` is excluded. Fixtures, the translations JSON and any seed copied from the source database fail the guard if they carry legacy strings.
3. **`/ready`.** It names one migration and is pinned by two tests. A Worker deployed before its migration is applied answers 503. Only the reviewer bumps it, once.
4. **One tenant per hostname on workers.dev (D7b).** The API host is held by `slice-20260927`. Imported shops need placeholder hostnames and only one at a time is reachable as a storefront, which makes the domain-move route a functional need on staging.
5. **Live-gate semantics differ** (D57): Firebase keeps an unpublished storefront visible; Cloudflare hides the catalogue.
6. **Invite delivery cannot be proven on staging yet**: the email provider key is still owed.
7. **Accounts v1 availability is a dashboard setting** (D49); enabled in the sandbox on 2026-09-27.
