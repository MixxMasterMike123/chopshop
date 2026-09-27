# Open decisions — Cloudflare port

One place for every decision Mikael owes, grouped by what it blocks. Each has a **recommended default**; answering "defaults" accepts all of them. Answered items move to the bottom with the date.

## Blocks NOW (CP0 completion / hotfix)

| # | Decision | Recommended default |
|---|---|---|
| D2 | **DELETE sign-off** (PLAN §3.3): CRM wagons (dining/ambassador/campaign/writers), `deleteCustomerAccountV2` + `toggleCustomerActiveStatusV2`, `getGeoDataV2`, `createAdminUserV2`, `syncAdminClaims`, `aggregateDac7Year`, V1 `confirmPasswordReset`, 3 dead email callables, `processB2COrderCompletionHttpV2`, `scrapeWebsiteMetaV2`, `OBSOLETE/`, b8shield-era docs/images. | **Yes to all.** Data of deleted features is archived per §3.4 before deletion. |
| D3 | The 7 UNSURE docs: `docs/Plattformsvillkor….docx`, `docs/Tryckeriavtal….docx` (July drafts), `juridik.md`, `docs/METEOR_PAKETERING_KENT.pdf`, `stripe-review-export/` (11 files), `OBSOLETE/docs/plattformsoverview.md`, `OBSOLETE/README.md`. | Archive the two `.docx` + the PDF under `docs/_archive/superseded/` (the live `.md` legal templates supersede them); archive `stripe-review-export/` (fixes are live); keep `juridik.md` but move it to `docs/legal-notes/juridik.md`; leave `OBSOLETE/*` (already quarantined). |
| D4 | Compromised secrets (SMTP password, GCP service-account key, GitHub PAT — open since June): revoke now? | **Yes.** Claude verifies they are unused by the retained Firebase paths (grep + 24 h log check) and hands you the exact revoke commands/links; you run them. |

## Blocks CP1 (foundation on Kent's account)

| # | Decision | Recommended default |
|---|---|---|

## Blocks CP2 (vertical slice) — **GO given 2026-09-27 01:10 ("GO!"); D8–D11 proceed on the recommended defaults below (assumed, Mikael may veto until the CP2 deploy)**

| # | Decision | Recommended default |
|---|---|---|
| D8 | Screening policy: advisory (today: flagged products stay public) or approval-before-first-sale (pending state + checkout gate). | **Approval-before-first-sale for a shop's first N=2 products only** (the existing `reviewFirstProducts` rule), advisory after — cheap, and it is the one control that prevents the expensive IP case. |
| D9 | `refundApplicationFee=false` at go-live (platform fee non-refundable). Firebase today runs `true` (no `settings/platform` doc). | **Yes, `false`** on Cloudflare from day one; leave Firebase as is (test orders only). |
| D10 | The 9 refunded test orders + 4 `orderProduction` docs: archive only (not in the CF admin, DAC7, bookkeeping)? | **Archive only.** |
| D11 | Guest withdrawal + guest checkout stay; B2C accounts PORT-LATER. Email source of truth for users = Firebase Auth email (not `users.email`). | **Yes** / **Auth email wins.** |

## Blocks CP3 (platform minimal / data import to staging) — **✅ ANSWERED 2026-09-27 13:10: Mikael "CP3 go, defaults" — D12–D23 all on the recommended defaults below. D36, D41–D49 stand on their defaults (no veto received).**

| # | Decision | Recommended default |
|---|---|---|
| D12 | Print-shop users (3) + the two uid-keyed printer tier docs (Systema/Kim, Adapt Media): carry or archive? | **Archive** (print portal is PORT-LATER; SnapWear is `type:'api'`). Kim's user deactivated. |
| D13 | `impersonationAudit` (269 docs): archive only, or carry into `audit_events`? | **Archive only.** |
| D14 | B8shield-era leftovers in Firestore/Storage (`dining*`, `wagonConfigurations`, 2025 `settings` auto-docs, 24 orphaned marketing docs, old Storage folders): archive or delete outright? | **Archive** (cheap, reversible), then delete with the project. |
| D15 | Old product images (370 outside per-shop folders): copy only referenced ones, archive the rest? | **Yes.** |
| D16 | Translations (4,094 docs, `en_US` one key short): carry as-is, scrub B8shield strings, or rebuild as a static file? | **Rebuild as static JSON in the repo** (scrubbed); the collection is archived. |
| D17 | Studio mockups (83 objects, 109 MB, unreferenced): copy or regenerate? | **Regenerate on CF** (they are derived). |
| D18 | Artwork without print files (7 of 20): import as "needs reprocessing" or drop? | **Import as needs-reprocessing** (the render job recreates them). |
| D19 | 3D model images: public or private class? | **Public** (they are catalogue-facing previews). |
| D20 | Staging import scope: all 5 shops with PII/Connect scrubbed, or melodie-mc only? | **All 5, scrubbed** (exercises multi-tenancy). |
| D21 | `robowatz` (0 products): carry or archive? | **Archive** (recreate if needed). |
| D22 | Feature flags at import: store effective values, drop keys of deleted features? | **Yes.** |
| D23 | DAC7 (PORT-LATER) has a hard date — seller due diligence by 31 Dec 2026. | Schedule DAC7 as **CP9 in November**; `dac7Sellers` archived until then. |

## Surfaced by CP1 bootstrap (answer before the first staging deploy)

| # | Decision | Recommended default |
|---|---|---|
| D7b | **`melodiemc.com` is already an active zone on Kent's Cloudflare account.** D7 chose workers.dev until CP7, but workers.dev cannot host per-shop hostnames (no wildcard subdomains), so staging can exercise only ONE tenant by hostname (the worker's own hostname registered as melodie-mc's staging domain; multi-tenant hostname resolution is proven in vitest). Alternative: a `*.stg.melodiemc.com` record on the existing zone (touches the live customer zone's DNS, apex untouched). | **Keep D7** (workers.dev, one staging tenant by hostname) until CP4 needs a second storefront; revisit then. |
| D32 | R2 buckets created with **`--jurisdiction eu`** — **and D1?** `wrangler d1 create --jurisdiction eu` exists too (verified in wrangler 4.123 help); both DBs are empty so recreating = new ids + re-apply 0001–0016 (10 min). Recommended **yes** before CP3 imports data. ✅ 2026-09-26 Mikael: "yes D1 EU" — both DBs recreated `--jurisdiction eu` (stg `5ee51e82…`, prod `6216ebd9…`), migrations re-applied to staging, staging re-bootstrapped. | (data stays in the EU; GDPR) — set at creation, irreversible per bucket. | **Yes, EU.** Veto = delete + recreate the six empty buckets before anything is uploaded. |
| D33 | Queues without dead-letter queues: D1 (`outbox_events`, `email_deliveries`) is the durable record and the 15-minute sweeper re-nudges; a DLQ would be a second unread copy. | **Yes, no DLQs.** |
| D34 | ~~Staging Stripe key file~~ ✅ 2026-09-26 Mikael created it (`sk_test_`, verified against the pinned account); first staging deploy done the same evening. Still owed for the email + POD smoke: `RESEND_API_KEY`, `EMAIL_FROM`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in `~/.config/chopshop/secrets.staging.env`. | — |
| D35 | **Containers blocked on Kent's account (2026-09-26 23:55).** First deploy with the render container: the image built locally (92 MB) but every Containers API call (`/accounts/…/containers/me`, `/registries`, `/applications`) answers HTTP 403 `code 10000 Authentication error`, although the project token carries `containers:write` + `cloudchamber:write` (whoami). This is the signature of Containers not being enabled/onboarded on the account (dashboard one-time step) or the token missing the *Containers* permission group in the dashboard's newer naming. The Worker was NOT touched (deploy aborted before upload; staging still on version `f2c91794`). | ✅ 2026-09-27 00:05 — it was the token: Mikael added the Containers permission; `/containers/me` 200; deploy rerun succeeded (image pushed to registry.cloudflare.com, version `14a78c8e`). |

## Surfaced by CP2 (answer before the CP2 deploy)

| # | Decision | Recommended default |
|---|---|---|
| D36 | **Withholding after a pre-production refund (D9 side effect, CP2-A Q1).** The platform withholds the frozen production cost inside the application fee at charge time. If the order is fully refunded BEFORE dispatch (production never happened), `refund_application_fee=false` means the platform keeps money it never paid a printer and the shop's payout goes negative. | **Release the withholding when dispatch is superseded/cancelled before submission:** refund the `withheldMinor` part of the application fee (a second Stripe call: `refund_application_fee` on a partial amount, or a platform→shop transfer of `withheldMinor`) in the same reserve-first pattern; commission stays non-refundable (D9). Build in CP2-D together with the failure-injection suite. |
| D37 | Connect `on_behalf_of` OFF (CP2-A deviation 1): the platform remains VAT merchant of record, as in the locked Firebase Marknadsplats model. | **Yes, OFF** (matches Firebase; changing it moves VAT liability to each shop — a legal decision, not a technical one). |
| D38 | Dispute money moves run in the 15-min reconciliation cron, not inline in the webhook (CP2-A deviation 2); `warning_closed`/`prevented` disputes return the reversal to the shop (deviation 4). | **Accept for CP2**; inline handling is a one-line route change later if the 15-min delay ever matters. |
| D39 | Stripe delivers PLATFORM events (payments, refunds, disputes) only on an endpoint created WITHOUT `connect`, and CONNECTED-ACCOUNT events (`account.updated`) only on one created WITH `connect=true` → **two endpoints, two signing secrets**. Staging now: platform `we_1UK6L6KAaBMOW5ACcH1EYz0z` (10 money events) + connect `we_1UK66JKAaBMOW5ACuWMdx6K9` (`account.updated`); both pinned (`stripeWebhookEndpointId`, `stripeConnectWebhookEndpointId`), both verified by the preflight; secrets `STRIPE_WEBHOOK_SECRET` + `STRIPE_CONNECT_WEBHOOK_SECRET` on the Worker (the second is read once CP2-A's dual-secret verification lands). | ✅ 2026-09-27 04:40 (an earlier single `connect=true` endpoint would have received NO money events — caught by the adversarial review). Production: create both at CP7. |
| D40 | Alerts are D1 rows only (no ops email yet) — CP2-A Q8, CP2-B Q5. | **CP2-D adds an alert digest email** through EMAIL_QUEUE to a platform address (needs Resend). |
| D41 | **Price floor vs withholding (CP2-C):** the amount withheld for the printer includes SnapWear's per-order parcel cost, but the PRISGOLV floor formula (ported from `podPricing.js`) does not — so a product priced exactly at the floor can make a small basket un-checkoutable (withholding > basket). Same gap exists in Firebase. | **Include the per-order parcel cost in the floor** (floor = per-item cost + parcel ÷ 1 item, so a single-item order still clears), documented as a deliberate change from Firebase; CP2-D. |
| D42 | After a D36 release, a full refund before production still leaves the shop's payout at −commission (D9 keeps the commission). Refund the commission too when nothing was produced? | **No for now** (D9 stands: the platform's work — checkout, screening, dispatch — happened); revisit with real data. |
| D43 | A job submitted then REFUSED by the printer, or a dispatch left `failed`, releases no withholding under the strict "before submission" rule until a human resolves it. | **Keep strict**; the manual resolution route (`resolve … failed`) makes the order eligible and reconciliation releases within 15 min — document in the ops runbook. |
| D44 | Application-fee refunds made in the Stripe dashboard raise an alert but are not counted in payout facts. | **Keep** (dashboard fee refunds are an ops action; the alert is the audit trail). |
| D45 | D41 floor uses `max(tenant VAT, 25 %)` (builder addition: at 0 % VAT the floor fell below the withholding) and assumes the 8 % BAS fee, so a PLUS shop's 5 % is covered but a commission above 8 % is not. | **Accept the VAT factor**; commission above 8 % does not exist in the pricing tiers (BAS 8 / PLUS 5). |
| D46 | **Personalised POD = product flag** (`products.is_personalized`, default 0), not "every POD line" (CP2-E deviation, matches Firebase + the ångerrätt rule: catalogue POD products keep the 14-day withdrawal right; only buyer-designed items may waive it with disclosure + checkbox). | **Accept the product flag.** CP6 (studio) sets it for buyer-designed items. |
| D47 | A new platform-terms version closes every shop's checkout until its admin re-accepts (no grace period). | **Add a 14-day grace period on version publish** (previous acceptance stays valid until `published_at + 14 d`; admin banner meanwhile) — CP3 with the settings table. |
| D48 | The payment route does not re-check the terms gate; a checkout opened before a version change can be paid within its 24 h window. | **Accept** (the checkout row is the contract; 24 h bound). |
| D49 | **Stripe Accounts v1 vs v2 (found by the staging run, 2026-09-27):** the sandbox platform refuses `POST /v1/accounts` ("Stripe no longer recommends Accounts v1 for new Connect integrations") — `seed-staging-slice.mjs` stops at the Express account. The Worker creates no accounts yet (seller onboarding is not ported); it READS v1 shapes (`account.updated`, `accounts.retrieve` → `charges_enabled` / `payouts_enabled`). Firebase onboarding (`connectOnboarding.ts`) uses v1 Express. | **Now (CP2 close): Mikael enables "Accounts v1 support" for the sandbox** (Dashboard → Settings → Developers → API Policies → Accounts v1 Support), so the slice is proven on the shapes the Worker was built and tested against. **At the seller-onboarding checkpoint: build on Accounts v2** (`/v2/core/accounts`, merchant configuration) after a staging proof that a v2 account drives the existing v1 read paths (Stripe: "interoperable with most v1 APIs"); check whether the LIVE platform account still allows v1 before relying on it for launch. |

## Affiliate rebuild (PORT-LATER — answer before that checkpoint, not now)

| # | Decision | Recommended default |
|---|---|---|
| D24 | Typed affiliate code earns commission? `?ref=` link overrides a typed code? | Yes / link wins. |
| D25 | Commission base = paid total − shipping, ÷1.25 regardless of VAT status. | Keep, but compute from the order's actual VAT lines. |
| D26 | Reversal: pro-rata on partial refunds; reverse on dashboard refunds + lost disputes; hold through the 14-day withdrawal window. | All yes. |
| D27 | Consent for 30-day click tracking (LEK 9:28) — consent-gated, or code-only attribution; store raw click IPs? | Code-only attribution by default, cookie only with consent; no raw IPs. |
| D28 | Affiliate terms + MFL ad-marking duty, with stored terms version. | Yes. |
| D29 | Payout rail: manual against invoice, or Connect transfers; platform cut? | Connect transfers where the affiliate has an account, manual otherwise; no platform cut at first. |
| D30 | One affiliate login across shops; code collisions with Rabattkoder; vanity vs random codes; notifications on conversion/payout/denial; keep 15 % / 10 % defaults; drop campaigns layer + ambassador CRM. | Per-shop logins; reject collisions at creation; vanity allowed; notify yes; keep defaults; drop both. |

## Later

| # | Decision | Recommended default |
|---|---|---|
| D31 | SSR for the storefront. | Later checkpoint, after cutover. |

## Answered

| D1 | approveAffiliate hotfix deployed to Firebase (`f807625`) | ✅ 2026-09-26 — Mikael: "You do it"; `Successful update operation` |
| D5 | Workers Paid on Kent's account | ✅ 2026-09-26 — "Paid plan activated" |
| D5b | Token scopes R2 Edit + DNS Edit added | ✅ 2026-09-26 — verified via whoami --json |
| D6 | Render host = **Cloudflare Containers** on Kent's account (one account, one bill, private binding, no OIDC). Benchmark runs on Containers alone against the largest allowed artwork; Cloud Run only if it fails the memory/time limits. **Staging numbers 2026-09-27 (RENDER_BENCHMARK.md §7):** largest artwork 34.5 s cold / 43.7 s warm, peak 563–661 MB, cold start ≈ 12 s, typical 4.2 s, 7/7 correct → **`standard-1`** (basic rejected: no memory headroom). | ✅ 2026-09-26 — Mikael: "Cloudflare Containers sounds like the best choice"; instance type standard-1 by the numbers (Mikael to confirm; default stands) |
| D7 | Domains: **CF dev domains (`*.kent-ee2.workers.dev`) for CP1–CP6**; the real platform domain comes later (CP7). Hostname-based tenant resolution uses `<shop>.…workers.dev` until then; custom domains / CF for SaaS need a zone and wait for CP7. | ✅ 2026-09-26 — Mikael |
