# Open decisions — Cloudflare port

One place for every decision Mikael owes, grouped by what it blocks. Each has a **recommended default**; answering "defaults" accepts all of them. Answered items move to the bottom with the date.

## Blocks NOW (CP0 completion / hotfix)

| # | Decision | Recommended default |
|---|---|---|
| D1 | **Deploy the `approveAffiliate` hotfix** (`main` `f807625`; account-takeover hole, function is live). Claude's deploy is blocked by the permission classifier. | Run: `cd "/Users/mikaelohlen/Cursor Apps/chopshop/.claude/worktrees/hotfix-affiliate-main" && npx firebase deploy --only functions:approveAffiliate --project b8shield-reseller-app` — or add a permission rule so Claude can. |
| D2 | **DELETE sign-off** (PLAN §3.3): CRM wagons (dining/ambassador/campaign/writers), `deleteCustomerAccountV2` + `toggleCustomerActiveStatusV2`, `getGeoDataV2`, `createAdminUserV2`, `syncAdminClaims`, `aggregateDac7Year`, V1 `confirmPasswordReset`, 3 dead email callables, `processB2COrderCompletionHttpV2`, `scrapeWebsiteMetaV2`, `OBSOLETE/`, b8shield-era docs/images. | **Yes to all.** Data of deleted features is archived per §3.4 before deletion. |
| D3 | The 7 UNSURE docs: `docs/Plattformsvillkor….docx`, `docs/Tryckeriavtal….docx` (July drafts), `juridik.md`, `docs/METEOR_PAKETERING_KENT.pdf`, `stripe-review-export/` (11 files), `OBSOLETE/docs/plattformsoverview.md`, `OBSOLETE/README.md`. | Archive the two `.docx` + the PDF under `docs/_archive/superseded/` (the live `.md` legal templates supersede them); archive `stripe-review-export/` (fixes are live); keep `juridik.md` but move it to `docs/legal-notes/juridik.md`; leave `OBSOLETE/*` (already quarantined). |
| D4 | Compromised secrets (SMTP password, GCP service-account key, GitHub PAT — open since June): revoke now? | **Yes.** Claude verifies they are unused by the retained Firebase paths (grep + 24 h log check) and hands you the exact revoke commands/links; you run them. |

## Blocks CP1 (foundation on Kent's account)

| # | Decision | Recommended default |
|---|---|---|
| D5 | **Workers Paid** on Kent's account (`ee2130…`)? Needed for Queues, D1 10 GB, Containers. | Enable it (USD 5/mo base). |
| D5b | **Token scopes:** the `chopshop-cf-port` token has Workers/D1/Queues/Containers but **no R2 and no DNS edit**. | Edit the token: add `Account · Workers R2 Storage: Edit` and `Zone · DNS: Edit` (zone: melodiemc.com + the platform domain). Nothing else changes; the stored token value stays the same. |
| D6 | Render host: Cloudflare Containers vs one Cloud Run container in a **new** GCP project. | Decided by the CP1 benchmark; you approve the numbers. Default if equal: Containers. |
| D7 | Platform domain name (admin/platform/print hostnames + `<shop>.<domain>` storefronts). melodiemc.com is Kent's shop domain. | Propose `chopshop.se` (or whatever you own); tell me the zone to add to the token. |

## Blocks CP2 (vertical slice)

| # | Decision | Recommended default |
|---|---|---|
| D8 | Screening policy: advisory (today: flagged products stay public) or approval-before-first-sale (pending state + checkout gate). | **Approval-before-first-sale for a shop's first N=2 products only** (the existing `reviewFirstProducts` rule), advisory after — cheap, and it is the one control that prevents the expensive IP case. |
| D9 | `refundApplicationFee=false` at go-live (platform fee non-refundable). Firebase today runs `true` (no `settings/platform` doc). | **Yes, `false`** on Cloudflare from day one; leave Firebase as is (test orders only). |
| D10 | The 9 refunded test orders + 4 `orderProduction` docs: archive only (not in the CF admin, DAC7, bookkeeping)? | **Archive only.** |
| D11 | Guest withdrawal + guest checkout stay; B2C accounts PORT-LATER. Email source of truth for users = Firebase Auth email (not `users.email`). | **Yes** / **Auth email wins.** |

## Blocks CP3 (platform minimal / data import to staging)

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

_(none yet)_
