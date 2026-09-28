# Cloudflare port — handover log

One entry per checkpoint (PLAN §9): what exists, how it was verified, both review notes, open gaps. Newest first. Branch `cf-port`.

## CP4 — Catalogue + storefront (GO 2026-09-28, started 2026-09-28)

### 🚀 2026-09-28 18:30 — CP4 is DEPLOYED to staging and proven with a purchase; the design gate waits for the catalogue import — START HERE

| What | Result |
|---|---|
| Migrations 0039–0045 on staging | applied by Claude on Mikael's "continue", first try, no retry. Bookmark BEFORE: `000000c8-00000000-000050f4-ff3f82a57679ac2a4b4994afa43b9516` |
| `scripts/cf-deploy.sh staging` at `895c24d9` (attested) | API version `f0122e26-b06c-48c0-8469-73f83721455d`; **web Worker, its first deploy:** `b40b300d-59e8-4d63-8853-1a61dc9fb27c`, `https://chopshop-web-stg.kent-ee2.workers.dev` |
| `/ready` | `0045_order_recipients.sql`, ok |
| A verified hostname per imported shop | `<shop>.stg-shop.invalid` for `melodie-mc`, `gif-sundsvall`, `ninetone`, `sillmans`, through `POST /v1/platform/tenants/:id/domains` (201, verified) |
| The shops through the web Worker | `melodie-mc` 200; the other three 404, as designed (unpublished in the source; the preview D57 is not built); `slice-20260927` 200 |
| **A purchase with a recipient (D98)** | order `0c378fdd-dcd3-4386-8f5a-30d621d04a43` (`20260928-SXG3KMDG`), a parcel, 42 800 öre, PI `pi_3UKgu3KAaBMOW5AC1JtnAO0i`. The order's recipient row holds the name, the two address lines, the postal code, the city, the country and the telephone; **the fake printer's job carries `shipping_address`** with the same values |
| Reconciliation | **BALANCED, 3 orders, Δ 0 öre**, 0 alerts, no dispatch row unknown or failed |

`seed-staging-slice.mjs --purchase` now buys a parcel with an invented recipient (the checkout requires one). Run it with `--tenant slice-20260927`.

**The first look at the pages rendered (the twelve baseline pages at 375, 768, 1440, shot with the baseline's own tool against staging):** layout, type, colours and spacing are the baseline's. No console error and no failed request but the expected 404s of what staging does not hold. The differences, each with its cause:

| Difference | Cause |
|---|---|
| Every page is 28 px shorter | the footer's "Mitt konto" row is gone (D81) |
| The home page has no review tile | reviews are not ported (D81); the payment tile beside it is wider |
| The logo reads "My Shop", the hero has no image | the branding images are not imported (D76, scripts S) |
| No products, no categories in the navigation, the category page shows its address as its heading | the catalogue is not imported (scripts S) |
| The three legal pages and the platform's terms: "Sidan kunde inte hittas" | DATA on staging: `melodie-mc` has adopted no legal page, and the platform terms version `2026-09-07` has no archived text. The slice shop, which adopted one, answers it |
| The titles of the cart and the product page read "… \| My Shop" | the same in the baseline |

**The design gate cannot be passed before the catalogue, the images and the legal texts are on staging.** That is the import scripts (S) and two data steps. It is the next dependency of everything visible.

**FOR THE CUTOVER, found here:** on the source a shop's legal pages were generated from templates and were always there. On Cloudflare a legal page exists only once the seller has ADOPTED it, and the checkout is closed until then. Every imported shop therefore starts with no legal pages and a closed checkout until its owner adopts them in the admin (CP5). Kent must do this for melodie-mc before it sells.

**Update 19:15. Mikael: "import all content so we can properly review the shops".** The briefs are §S of `CP4_BRIEFS.md` in full (`1c7adaa5`). **Two builders (Opus) were launched at 19:15 and run in the background; they die with the window. Their files will be in the tree, uncommitted:** S1 = `scripts/cf-port/migrate/storage-copy.mjs`, `lib/copy-manifest.mjs`, `lib/copy-sources.mjs`, `lib/api-session.mjs`, `scripts/cf-port/staging-legal.mjs`, tests, `CP4_S1_REPORT.md`; S2 = `import-catalogue.mjs`, `verify-catalogue.mjs`, `lib/transform-{products,collections,pages,branding}.mjs`, `scripts/cf-port/build-locales.mjs`, `src/locales/*.json`, tests, `CP4_S2_REPORT.md`. If the window died: `git status`, read the reports if present, run the gate (`node --test "scripts/cf-port/migrate/test/*.test.mjs"`, 353 before), finish from the tree. **The builders ran nothing against the network: the reviewer runs the tools against staging**, in this order: the file copy → the catalogue plan (target state, plan, apply through the preflight, verify) → re-screen → `staging-legal.mjs` (terms text, legal pages, publish for review) → the locale files committed, Codex, attest, deploy `web` → the design gate. The artworks (row 43) are NOT imported in this step (decided with the brief: they serve the mappings of D83).

**Next, in this order (each builder needs Mikael's go: the budget):**

1. S, the import scripts: catalogue, collections, pages, images through the Worker's object routes, branding. Sonnet. Then the import on staging and the design gate.
2. The platform terms' archived text on staging, and the legal pages of melodie-mc adopted (acting as its admin), so those four pages can be shot.
3. D's second pass (the preview of an unpublished shop, D57), so the three unpublished shops can be shot without publishing them.
4. CP5, the admin.

**Not done:** no purchase was made by hand through the PAGES (the card form in a browser); the purchase above went through the same routes by script. The receipt poll's fix is still not reproduced in a browser.

### (history) 2026-09-28 17:00 — CP4's code is complete and reviewed

**Tree clean, pushed. Everything below this entry is history.**

| Part | Commit | Codex |
|---|---|---|
| B collections | `14274ea3` | 2 findings, fixed in `7cef3821` |
| K consolidation | `6ecd315e` | clean |
| Two page fixes | `3022da12` | clean |
| W, the web Worker's deploy path | `eedfa614` | 2 findings, fixed in `7cef3821` |
| F1 + F2, the page swap | `f26d616e` | 3 findings: 2 fixed in `7cef3821`, 1 accepted by the brief (`CP4_F_REPORT.md`) |
| The fixes | `7cef3821` | 1 finding, fixed in `474b7466` |
| The source map fix | `474b7466` | clean |
| D95, the bucket's address pinned | `fb211b3c` | 1 finding (the generated Worker types were out of date), fixed in this commit |
| **R, the recipient of an order (D98)** | `9fe3d297` | clean (Codex could not run the Worker's tests in its sandbox; the reviewer ran them) |

**Gate at this commit:** Worker 90 files, 3893 tests, 0 failed; `tsc` clean for both projects; `npm run types:check` up to date; 120 tests under Node; preflight tests 183; deploy tests 48; the storefront build holds no Firebase code; the older build builds; guard PASS (allowlist 298).

**Done by Mikael on 2026-09-28:** D95 (the address of the staging bucket, `https://pub-0e06052f19524b76bbefd4b411baa272.r2.dev`); the go for D98; the three build values, written by the reviewer into `~/.config/chopshop/web.staging.env` (mode 600; the five `VITE_` names of the repository's own `.env` are blanked in it, as the deploy script requires). A build made from that file holds the publishable key, the legal name and the organisation number, and no secret-looking key.

**Next, in this order:**

1. **Mikael: migrations 0039–0045 on staging.** First the read-only list, then the apply:
   `scripts/cf-preflight.sh staging -- d1 migrations list chopshop-stg --remote`
   `scripts/cf-preflight.sh staging -- d1 migrations apply chopshop-stg --remote`
   Applying before the deploy is safe; deploying before them makes `/ready` answer 503.
2. Attest HEAD (`git notes --ref=reviews add -m "codex: PASS" -m "fable: PASS" HEAD`, push the notes), then `scripts/cf-deploy.sh staging` (Docker Desktop must run). It is the FIRST deploy of the web Worker.
3. A verified hostname per imported shop through `POST /v1/platform/tenants/:id/domains`, then the design gate page by page (375, 768, 1440 against the baseline). The staging smoke items no local test proves are in `CP4_E_REPORT.md`, "Review round 1".
4. One real purchase on staging through the PAGES (not the script), with a name and an address, read back in the seller's order and in the fake printer's job.
5. D's second pass (the preview, D57), S the import scripts. Each needs a builder: ask Mikael first (the budget).

**Open with Mikael:** D97 a–d; the veto on D92–D94; the seven points of `CP4_R_REPORT.md` "Review round 1" (no telephone field in the form, the printer's address format, a collected order's printed goods, personal data in the platform's order list, the rest); the infringement report that needs a product the page can find (`CP4_F_REPORT.md`, finding 3).

**Not proven anywhere yet:** no page has been looked at rendered by the reviewer; the receipt poll's fix is reasoned, not reproduced in a browser; nothing of CP4 has run on staging.

### (history) RESUMED 2026-09-28 14:00 — F1, F2 and W are committed

The pause below is closed. The three stopped builders were finished by the reviewer from what was in the tree; nothing was relaunched. **Tree clean, pushed.**

| Part | Commit | Gate |
|---|---|---|
| W, the deploy path of the web Worker | `eedfa614` | preflight tests 182, deploy tests 48; 25 mutations of the two scripts, all caught |
| F1 + F2, the page swap (one commit: both edit `pages.jsx`, F2 builds only with F1's alias list) | `f26d616e` | 110 tests under Node, the storefront build holds no Firebase code, the older build builds, guard PASS (allowlist 298) |
| The Worker, unchanged | — | 89 files, 3838 tests, 0 failed |

The report of all three is `CP4_F_REPORT.md`: what changes for a visitor, the findings, what was read how closely, what is not done.

**F2's open finding is fixed:** 111 s and 58 polls came from the page being mounted a second time, which began a new 90 s. The 90 s are now the checkout's (`receiptPollTimeLeft`, `src/api/orders.js`).

**Found at the review, a blocker of the first real order (D98): an order holds no name and no delivery address.** The checkout route takes none, no table has a column for them, a printer job carries none. It is its own Worker step (migration 0045) and waits for Mikael's go.

**Codex** was started at 14:52 on `14274ea3` (B), `6ecd315e` (K), `3022da12`, `eedfa614` (W), `f26d616e` (F), one after the other, medium effort; logs in the session's scratchpad as `codex-cp4-<sha>.log` (they die with the session: re-run `codex review -c model_reasoning_effort="medium" --commit <sha>`). **No finding has been read yet; no commit is attested.**

**Update 15:40.** Codex read the five commits: K and `3022da12` clean; seven comments on B, W and F, six real, fixed in `7cef3821`; its one comment on that fix is fixed in `474b7466` (the table is in `CP4_F_REPORT.md`). **`474b7466` itself has not been read by Codex, and nothing is attested.** **Mikael gave the go for D98 (15:30):** the brief is §R of `CP4_BRIEFS.md` (`4c1db34e`); **builder R (Opus) was launched at 15:40 and runs in the background; it dies with the window.** Its files will be in the tree, uncommitted: `cloudflare/migrations/0045_order_recipients.sql`, `cloudflare/src/commerce/recipient.ts`, `cloudflare/test/recipient.test.ts`, lines in the checkout, the order creation, the three order reads and the printer job, `test/slice-harness.ts`, the two storefront adapters, `StripePaymentForm.jsx`, the dev money API, and `CP4_R_REPORT.md`. If the window died: `git status`, read the report if present, run the gate, finish it from the tree (do not relaunch from zero). The migrations for staging are then **0039–0045**.

**Next, in this order:**

1. Review builder R line by line, commit, Codex on it and on `474b7466`, fix, attest HEAD.
2. **D95 DONE 2026-09-28 (Mikael ran it under `--bootstrap`):** the staging bucket's address is `https://pub-0e06052f19524b76bbefd4b411baa272.r2.dev`, pinned in `pinned.staging.json` and set as `PUBLIC_OBJECT_BASE_URL` of both Workers in one commit; it answers (404 for an object that is not there); the preflight tests check the committed files as they are. What follows in this item is the history. D95 was open: Mikael's command was refused because the pinned value is null. It runs under `--bootstrap`: `scripts/cf-preflight.sh staging --bootstrap -- r2 bucket dev-url enable chopshop-stg-public --jurisdiction eu`. The address it prints goes into `pinned.staging.json` → `r2.publicBaseUrl` and into `env.staging.vars.PUBLIC_OBJECT_BASE_URL` of both `wrangler.jsonc`, in one commit; the preflight refuses every deploy until the three are equal.
3. Mikael creates `~/.config/chopshop/web.staging.env` (mode 600): `VITE_STRIPE_PUBLISHABLE_KEY=pk_test_…` of the staging sandbox, `VITE_PLATFORM_LEGAL_NAME`, `VITE_PLATFORM_ORG_NUMBER`.
4. Migrations 0039–0044 on staging (Mikael), then `scripts/cf-deploy.sh staging`.
5. A verified hostname per imported shop, then the design gate page by page.
6. D98 (the recipient of an order), D's second pass (the preview, D57), S the import scripts.

**The budget (Mikael, 2026-09-28 14:10):** 81 % of the week and 76 % of the week's Fable were used, five days before the reset. So: no new builder without his go, the reviewer reads diffs and not whole files, Codex is the second reviewer (its own quota), and every reviewed part is committed at once.

### ⏸ PAUSED 2026-09-28 ~07:35 (closed by the entry above)

Mikael closed the computer. **HEAD `3022da12` is pushed and green.** Everything under `cloudflare/src`, `cloudflare/test` and `cloudflare/migrations` is committed. **Three builders were stopped mid-work by the reviewer; their files are in the tree, UNCOMMITTED and UNREVIEWED, and none of them wrote its report:**

| Builder | Its files in the tree | Where it was when stopped |
|---|---|---|
| F1 page swap: shell, catalogue, content | `src/components/shop/{ShopGate,ShopNavigation,ShopFooter,DynamicRouteHandler}.jsx`, `src/pages/shop/{PublicStorefront,AllProductsPage,TagPage,CollectionPage,ProductCollectionPage,PublicProductPage,DynamicPage}.jsx`, `src/storefront/adapters/{products,collections,pages,legal,storefront}.js` + `adapters.test.mjs`, `src/storefront/dev/{dev-api.mjs,dev-api.test.mjs,fixtures.json}`, `src/storefront/replacements/**`, `src/storefront/providers/StoreSettings.jsx`, `src/api/{collections,pages}.js`, `src/api/lists.test.mjs`, `vite.storefront.config.js`, its lines of `src/storefront/pages.jsx`, `guard/allowlist.txt` + `guard/allowlist.baseline` (313 → 298, 15 entries removed) | All eleven pages touched; it was LOOKING at the pages rendered ("two more looks: a legal page at 375, a collection at 768") |
| F2 page swap: money, withdrawal, report | `src/pages/shop/{Checkout,OrderConfirmation,WithdrawalPage,InfringementReportPage,ShoppingCart}.jsx`, `src/components/shop/{OrderWithdrawal,StripePaymentForm}.jsx`, `src/storefront/adapters/{checkout,order,withdrawal,report}.js` + their tests, `src/storefront/dev/{money-api.mjs,money-fixtures.json}`, `src/api/orders.js`, its lines of `pages.jsx` | Testing the order confirmation. **Its last finding, NOT resolved: the timeout state appeared after 111 s and 58 polls, not after 90 s and 45.** Look at `src/api/orders.js` `pollReceipt` (the reviewer changed it in `661f6438`: the request is aborted at the deadline) together with what F2 changed in it and in `useReceiptPoll.js` |
| W deploy path of the web Worker | `scripts/cf-preflight.sh`, `scripts/cf-deploy.sh`, `guard/preflight.test.sh`, `guard/deploy.test.sh` (new), `cloudflare/pinned.{staging,production}.json`, comments in `cloudflare/wrangler.jsonc` and `cloudflare/web/wrangler.jsonc` | Its tests passed 48; it was about to mutation-test `cf-deploy.sh` |

**To resume, in this order:**

1. `git status --short` (expect the 38 paths above, nothing under `cloudflare/src`), then the gates: `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx vitest run` (expect **89 files, 3838 tests, 0 failed**: read the SUMMARY line); `node --test src/api/*.test.mjs src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs`; `node cloudflare/web/check-storefront-build.mjs`; `npx vite build`; `node guard/guards.test.mjs`; `bash guard/preflight.test.sh`; `bash guard/deploy.test.sh`; `bash -n scripts/cf-preflight.sh scripts/cf-deploy.sh`.
2. **Do not relaunch F1, F2 or W from zero.** Their work is nearly done. Either the reviewer finishes each by hand, or a fresh builder is briefed to FINISH it: "read the brief (`CP4_BRIEFS.md` §F; for W the brief is below), read what is in the tree, run the gate, complete what is missing, write the report". The briefs of F1 and F2 are §F of `CP4_BRIEFS.md`. **W's brief was only in the chat**; its substance: pinned files gain `webWorkerName` and `r2.publicBaseUrl` (null today, nullable, a null refuses a deploy); `PUBLIC_OBJECT_BASE_URL` of both Workers must equal it; `cf-preflight.sh <env> [--web] -- …` checks `cloudflare/web/wrangler.jsonc` (name, exactly one service binding `API` → the pinned API Worker with entrypoint `Internal`, vars exactly `WEB_ORIGIN` + `PUBLIC_OBJECT_BASE_URL`, the assets block, NO other binding, `dist/index.html` present and no source map for `deploy`); `cf-deploy.sh <env> [api|web|all]` deploys the API, builds and checks the storefront, deploys the web Worker; the build's public values (`VITE_…`) come from `~/.config/chopshop/web.<env>.env`, and a value that looks like a secret key is refused; bash 3.2 and BSD tools.
3. Review each line by line (the pages: imports and data functions ONLY may have changed; `git diff` of a page must show no change of markup, class names or copy), commit with explicit paths, push.
4. The guard's allowlist may only SHRINK: `git diff guard/allowlist.txt` must show removed lines only (it does: 15 removed, none added).
5. Codex (quota back 11:08): B `14274ea3`, K `6ecd315e`, `3022da12`, then F1, F2, W. `codex review -c model_reasoning_effort="medium" --commit <sha>`.
6. Then: D's second pass (the preview of an unpublished shop, D57), S the import scripts (Sonnet), Mikael's part (D95, migrations 0039–0044 on staging, the build values file), the deploy, the design gate page by page.

**Mikael owes:** D95 (switch the staging bucket's address on: `scripts/cf-preflight.sh staging -- r2 bucket dev-url enable chopshop-stg-public --jurisdiction eu`); D97 a–d (the withdrawal function's four points); a veto or not on D92–D94 and on what the storefront response shows of a shop (support address, legal name, address, registration number; a product's delivery flags).


**Started 2026-09-28 04:10.** Tree clean at `a9991384`, 353 script tests and 2416 Worker tests green before the first change. **D83 answered by Mikael: yes**, the old POD links are not imported and the 6 products are tied to their garment again in the admin later. Pre-step committed: `CP4-IMPORTS-A…D` and `CP4-ROUTES-A…D` anchors in `cloudflare/src/app.ts` (before every older route), the var `PUBLIC_OBJECT_BASE_URL` in the two type files and the test configuration, decisions D92–D95. The briefs are in `CP4_BRIEFS.md`, builder P first.

**Found while writing P's brief:** the managed address of staging's public bucket is switched off (D95, Mikael switches it on); 444 of the 495 product images carry no file ending, so the type is read from the file itself (D92); 3 branding images are SVG (D92).

**Builders, state 2026-09-28 06:10:**

| Builder | State | Commit |
|---|---|---|
| P public objects (0039) | reviewed by Fable line by line, committed | `25db76e0` |
| E client and web Worker | reviewed, committed | `9a11f1a9` |
| C pages and legal pages (0042) | reviewed, committed | `61dfe4ca` |
| G withdrawal function (0044, D96) | reviewed, wired, committed | `5421fab1` |
| D storefront response, first pass (0043) | reviewed, wired, committed | `e872853d` |
| A products (0040) | reviewed, committed with the route mounts of A, C, D, G | `fd32bf8e` |
| B collections (0041) | launched 06:02, running | — |
| D second pass (preview, D57), F page swap, S scripts | wait | — |

Gate at `fd32bf8e`: `tsc` clean for both projects, **86 files, 3656 tests passed**; the storefront build holds no Firebase code. **Codex started on the six commits at 06:10** (one after the other, medium effort; logs in the session's scratchpad as `codex-cp4-<sha>.log`, which dies with the session: re-run `codex review -c model_reasoning_effort="medium" --commit <sha>` if lost).

**Codex on the six commits (06:07–06:19, medium effort): 17 comments.** Six are of the commit boundary and need nothing (a builder's commit holds no route mounts; the mounts came with A's commit; `collections` comes with B). **Eleven were real and are fixed in one commit:**

| Commit | Finding | Fix |
|---|---|---|
| P | An SVG style sheet could spell `@import` or `url(` across a CDATA marker, a comment or a child element, which a parser joins into one text | The text-wide scans also read the text as joined |
| P | A removal that read a pending row could leave the bytes of an upload that finished in between readable | A public object's bytes are removed whatever the row said when it was read |
| E | A receipt request that stalls could outlive the 90 seconds | The request is aborted at the deadline and the poll answers its timeout |
| E | A connection that fails while the body is read was not a network error | The body is read inside the same handler |
| C | An address of the source system's storage with a percent-encoded letter of the host, or an upper-case letter brought in by a reference, passed | Read as a URL parser reads a host; the same in the store identity |
| D | The cursor of the forwards list was normalised again, so a stored `%`, `?` or `#` broke its own next page | The cursor is taken as the stored path it is |
| D | Categories and tags were found in a list cut at 500 | Found by their key, one indexed lookup |
| A | The backfill of `handle` stopped the migration when two skus gave one handle (`A/B`, `A-B`) | Every row of such a group gets the start of its id behind the handle; the fill trigger likewise |
| A | Two writers at once could pass the cap of a product's variants | Two triggers in 0040 stop it in the database; the routes answer `variant_limit` |
| A | A product blocked while its tags, variants and images were read could show a text that was never approved | The predicate is asked again after those reads; a product it no longer admits is left out |
| E | The legal pages' addresses | Fixed before Codex ran (`<root>/legal/:slug`) |

Each fix has its test. Codex re-reviews the fix commit and B before the deploy.

**A fault of the fix commit, found by builder B and corrected in the commit after it:** the first cap of the variant triggers (100 active) was lower than what the publish gate prices completely (200), and `pod-publish.test.ts` failed in its fixtures. `661f6438` was committed with that suite failing; the reviewer read the run's last lines and missed the second failing file. The caps are now the gate's own (200 active, 400 in all; the largest product of the export holds 65 variants), a test keeps the two numbers equal, and the whole suite passes: **88 files, 3810 tests, none skipped.** The rule taken from it: the count of failed FILES is read from the run's summary line before a commit, not from the failures that happen to be printed last.

**Codex, second round (06:42):** the fix commit `661f6438` and the cap correction `2a3aabc2`: **no finding.** B's commit `14274ea3`: **NOT reviewed**, Codex's usage limit was reached (back at 11:08). Owed to Codex before any deploy: `14274ea3`, the consolidation (builder K), D's second pass, and the page swap (F1, F2). `codex review -c model_reasoning_effort="medium" --commit <sha>`.

**B collections (0041): reviewed by Fable, committed `14274ea3`. `/ready` requires `0044_withdrawals.sql` (`219f4301`).** Whole suite at `14274ea3`: **88 files, 3810 tests passed, none skipped.**

**K, the consolidation: reviewed by Fable, committed `6ecd315e`.** One address rule (`src/storefront/addresses.ts`), one public gate of a shop (`public-shop.ts`), the product page of the answer for search engines reads through A's public read, the older product routes and the four deprecated reads are gone. K stopped where a merge would have changed an answer and proved each difference; the four differences and what becomes of each are in `CP4_K_REPORT.md`, "Review round 1". Whole suite after K: **89 files, 3836 tests passed, 0 failed, 0 skipped.** Two of the four differences are closed already (a page's content of white space only is refused; the author is stored trimmed).

**Running (they die with the window):** F1 and F2, the page swap (brief in `CP4_BRIEFS.md` §F), since 06:45; W, the deploy path of the second Worker in the preflight and the deploy script, since 06:55. Their files are in the tree, uncommitted: `src/**`, `vite.storefront.config.js`, `scripts/cf-*.sh`, `guard/**`, the pinned files, the two `wrangler.jsonc`.

**What the review changed, beyond wiring:**

- **The adopted legal texts are checked like a page's HTML** (C's open question, and a hole: the text comes from the seller's browser and is shown to every visitor, and on the shared host every shop is served from one origin). The three templates were rendered as the storefront renders them and pass.
- **A seller cannot write the personalised flag** (A had made it writable): it takes a buyer's right of withdrawal away, and D46 gives it to the studio's buyer flow.
- **The further description of a product passes the HTML refusal** too.
- **A screening without texts reads every text of the product**, so the sweep and a change of a print mapping screen what a publish screens.
- **No cookie is forwarded from the web Worker to the API.**
- **A refused upload says why**, for the admin and for the importer's report.
- **One set of triggers on public objects** (0043's); C's and A's are removed.

**Found by E, and a gap of the port (D96):** the API had no route for a buyer's withdrawal. Built as G. Four points of it are Mikael's to confirm (D97).

**The consolidation that is left, after B:** D's reads move to the functions of A, B and C (D's own tests are the proof that nothing changed); the older public product mounts and the deprecated functions go; `REQUIRED_MIGRATION` becomes `0044_withdrawals.sql`; `PUBLIC_OBJECT_BASE_URL` in `wrangler.jsonc` and the pinned files with the preflight's check (after D95); the deploy path of the second Worker (`cloudflare/web`) in the preflight and the deploy script.

**Carried forward from P:** response headers (`nosniff`, a Content-Security-Policy) on public objects come with the domain of our own at CP7; the sweep that removes files a failed delete left behind (PLAN §2.5) is not built; the three SVG branding files have not met the SVG check yet (S rehearses them).

**For the storefront proof on staging:** the four imported shops hold the importer's placeholder hostname (`<shop>.import.invalid`) in status `pending`, by design, and no route turns a pending hostname into a verified one. The tenant resolver reads verified hostnames only. Each shop therefore gets a second, verified storefront hostname through `POST /v1/platform/tenants/:id/domains` (which creates it verified) before its pages are shot; three of the four are also unpublished and are published through the platform route for the shots, or seen through the preview (D57).

**Mikael: "CP4 go"**, with D77 and D81 confirmed. D78, D79, D80, D82, D84 on their defaults.

**Start from `CP4_GAP_ANALYSIS.md`.** Eight builders; **P (public objects) first**, or its interface fixed first, since products, collections, branding and the storage copy all stand on it. Next migration 0039. Worker code by the Opus builder when its spend limit allows, otherwise Sonnet; scripts by Sonnet; Fable reviews every diff; Codex before every deploy.

**Asked for during the session of 2026-09-27/28 and recorded as decisions, to be designed into CP4 and not bolted on:** a shop's own website reads its collections (D87, ninetone's artist pages); permanent forwarding of old addresses per shop (D88); finished pages for search engines (D88); a shop on its own domain (D89, D90, a PLUS feature). Not decided: the commission of the free plan (D91), the platform's domain and name.

**Blocked on people, not on code:** a technical base domain (custom domains, mail, the admin address); Resend on Kent's account (Mikael, 2026-09-28); Kent's colours per garment and the garment of each of the 6 POD products.

## CP3 — Platform minimal + data import to staging (GO 2026-09-27 13:10, ✅ CLOSED 2026-09-28 02:10)

**✅ CP3 CLOSED.** Both exit criteria of PLAN §10 are met on staging:

| Exit criterion | Evidence |
|---|---|
| The slice is operable by a platform user without scripts | The seed runs through the routes only: no `d1 execute`, no write to Stripe. Purchase, refund and reconciliation balanced at Δ 0 öre under the CP3 Worker (`f0db7a72`, version `2b2f3927`). The Connect v1 proof passed with an account the Worker created. |
| Staging data = manifest | The import plan was applied on 2026-09-28 02:05: **862 statements, 2 509 rows written, no retry**. `verify.mjs`: **16 of 16 checks PASS**, nine items deferred to their checkpoints. |

After the import: `/ready` on 0038, the storefront answers, the reconciliation is still balanced with 0 alerts, and the four shops read back through the platform routes (melodie-mc published, the other three hidden, as in the source). Bookmark before the import `0000007e-00000000-000050f3-72f83de0559e3938e07fe3d81ef7fcc9`, after it `00000081-0000003e-000050f3-be65903f470600c3b999f2a9142901e1`. Plan, states and the verify output are in `~/chopshop-export/import-2026-09-28/`.

**The apply was run by Claude**, under a permission rule Mikael chose on 2026-09-28: `.claude/settings.local.json` allows `scripts/cf-preflight.sh staging -- d1 execute chopshop-stg --remote`, the staging database through the preflight and nothing else.

**Carried forward, not verified in CP3:** email delivery (Resend waits for Kent's account; the forced password reset at cutover depends on it); requirements arriving by webhook during a Connect onboarding (needs a person in the flow); the v2 accounts adapter; legal acceptances and audit logs have met invented data only (the export holds none); `apparel_dtg` on staging is the old 250 × 350 mm; the imported admins hold placeholder addresses and cannot sign in on staging, by design.

**Next: CP4, which needs Mikael's go.** `CP4_GAP_ANALYSIS.md`, decisions D77–D91.


**Mikael:** "CP3 go, defaults" — D12–D23 on the recommended defaults (print-shop users + uid-keyed printer tiers archived; impersonationAudit archive only; legacy leftovers archived; only referenced legacy images copied; translations rebuilt as static JSON; mockups regenerated; 7 artworks imported as needs-reprocessing; 3D derivatives public; all shops imported to staging scrubbed; robowatz archived; effective feature values; DAC7 = CP9 in November). **Carried in from CP2's close:** design diff on the slice pages (CP4), and two "operable without scripts" gaps found by the staging run — no route manages a tenant's hostname, and no Connect onboarding endpoints exist (the seed script used the Stripe API + two raw D1 statements). **Started 13:15:** read-only gap analysis (what CP2 already built vs PLAN §10 CP3 scope, frontend scope, which manifest rows the CP3 importer handles) → builder briefs.

**Gap analysis → `CP3_GAP_ANALYSIS.md`; rulings → DECISIONS D50–D59 (defaults, veto until the CP3 deploy).** Headline: none of the CP3 tables existed; Connect onboarding endpoints (PLAN's CP2 list) and hostname management were never built. **Pre-step `d7b4b85`:** `CP3-IMPORTS-A…F` / `CP3-ROUTES-A…F` anchors in `src/app.ts`, placed BEFORE the older platform handlers (three of them 404 the methods they do not own), and `onMethods()`. **Builders launched (six Opus, one tree, disjoint files):** A tenants `0032` (tenant directory, edit, publish/close, features with effective values, store identity + gate fields through `/v1/admin/settings`, domains list/disable/move/delete) · B identity `0033` (`legacy_id_map`, `import_runs`, row hashes; user directory, deactivate with a concurrency-safe last-admin guard, membership revoke, 72 h invite) · C printers `0035` (platform read, per-printer PATCH, default printer, `printer_catalog` + catalogue apply, tenant view gains garments/provisional areas, one-number walk over every tenant response) · D settings + trust & safety `0034` + `0036` (`platform_settings`, terms CRUD + note, global hard block + review-first from settings, re-screen on term change, infringement intake + queue + takedown-with-report in one batch) · E legal `0037` (D47 grace, publish a terms version with archived text, `legal_acceptances`, legal-pages acceptance; the readiness gate follows A's 0032) · F Connect `0038` (gateway seam with fake + v1 adapter as proven on staging + v2 adapter UNVERIFIED, reserve-first account creation, link, refresh, login link, platform opt-in, payout delay). **Export tool (Sonnet):** built (47 tests), Fable review round 1 = 9 fixes (a plain map with latitude/longitude would have been stored as a GeoPoint and lost its other keys; unknown class instances must throw; live re-count; discovery of unknown subcollections; explicit project id; dry run without reading documents; early refusals; stricter bundle verification), builder resumed. Not yet run against production.

**Export (17:02):** the tool ran read-only against the source database. Dry run = the manifest census exactly (42 collections, no unknown collection or subcollection). `--apply`: **4 994 documents in 40 collections + 8 Auth users**, `verify-bundle` 240/240, `shasum` OK, live re-count 39/39, 0 warnings; bundle outside the repo (mode 700), a STAGING export (no write freeze). Two defects found by the first run and fixed: the Auth listing needs a quota project that firebase-admin 11 cannot send (now read through the Identity Toolkit REST API), and a failed run left a partial bundle (every read now precedes the first write; the bundle is built in `.partial` and renamed). Detail: `CP3_X_REPORT.md`.

**CP3 Worker code landed (20:15) — seven commits, `d8a711a` … `cd7352f`.** Each builder was reviewed by Fable on its migrations and its risky paths line by line, got a follow-up round, and was verified; three builders were cut off by the Opus spend limit at 17:47 and resumed after 19:30 without loss. **Gate at `cd7352f`: 2405 tests / 69 files, `tsc` clean, types up to date, preflight 75/75, guard PASS.** Migrations **0032–0038**; `/ready` requires `0038_connect_onboarding.sql`.

| Builder | Delivers | New tests |
|---|---|---|
| A tenants `0032` | directory, edit, publish / unpublish, close (final, refused while any order's money could come back), six feature keys with effective values, store settings + gate fields, hostnames incl. an atomic audited move | 184 |
| B identity `0033` | user directory, deactivate with a concurrency-safe last-admin guard, membership revoke + re-grant, 72 h invites with their own wording, import bookkeeping tables | 99 + follow-ups |
| C printers `0035` | platform read, per-printer PATCH with a revision fence, default printer, catalogue store + apply with dry run, `belowFloor` list; tenant view by allowlist | 66 |
| D settings + trust & safety `0034`, `0036` | platform settings, screening terms, re-screen on a term change (same-batch block + bounded sweep + terms fence), infringement intake / queue / takedown with report | 155 |
| E legal `0037` | D47 grace, terms versions with archived text, legal-pages adoption, the legal readiness gate at checkout | 37 in its three suites |
| F Connect `0038` | reserve-first account creation, link, refresh, login link, opt-in, payout delay, monthly payouts, stuck-operation alert; webhook + resync also write the requirement list | 101 |

**Found by the reviews, fixed before commit:** tenant-visible refusal codes and texts that named the pricing structure (`unpriced`, `currency_mismatch`, "The printer has no price…") — since CP2; a close that could strand a buyer's refund (open dispute, unsettled refund); a shop commission accepted up to 100 % although the price floor assumes ≤ 8 %; activate/suspend on a closed shop answering 500; a revoked membership that could never be granted again; invites sent with reset wording under the old brand. **Two D1 facts learned:** `meta.changes` counts rows written by triggers (check `=== 0`, never `!== 1`), and `INSERT OR REPLACE` bypasses DELETE triggers (append-only tables need an insert-time guard).

**Behaviour changes to know before the staging deploy:** checkout now also requires legal readiness (return address, VAT answer, adopted legal pages) — `slice-20260927` takes no checkout until it has them; platform routes refuse any request carrying `X-Shop-Id` (D70); `connect_enabled` defaults to 0, so the seller Connect routes are closed for existing shops until the platform opts them in (the payment gate itself is unchanged).

**Open:** Codex review of the seven commits (started 19:52) → fixes → attestation → Mikael applies 0032–0038 to staging D1 → deploy → routes-only staging proof (seed script update) + the Connect v1 proof list → CP3-S import / verify scripts (Sonnet, launched 19:55) → staging import → CP3 close.

**Codex on the seven commits (21:00):** consolidation clean; nine real findings, four of them P1, fixed in `f0db7a7` (+11 tests, **2416 / 69**); Codex on `f0db7a7`: clean. Three further P1s were commit boundaries (a builder's commit alone has no route mounts).

**Import, verify and restore scripts landed — `416b3bb1` (339 tests).** Review round 1 was finished by the reviewer, who also ran the importer in memory against the real bundle (statistics only, nothing written). `CP3_S_REPORT.md` §10 has the full list. What matters for the staging import:

| Found | Where | Effect before the fix |
|---|---|---|
| Gallery image URLs on Firebase Storage | real bundle, one shop | the importer refused the real bundle (D73) |
| A profile link with an `@` in its path taken for an address | real bundle, one shop | the link was replaced by a placeholder address |
| The plan's clock was the wall clock from the CLI | reading | two runs, two plans; every test passed its own clock |
| `verify.mjs`: a check against itself, one ending in `\|\| true`, one passing for any number, the production user count expected on staging | reading | checks that could not fail, and one that could not pass |
| `--scrub-unmapped` accepted on production | reading | placeholder addresses for real users |

The real bundle now builds: 864 statements, 286 KB, longest statement 47.7 KB, identical on a second run. It holds no legal acceptance and no audit log. **Codex on `416b3bb1` was cut off by Codex's own usage limit with no finding; it must be re-run before the attestation.**

**Seed script routes-only (this commit).** `seed-staging-slice.mjs` no longer creates the Stripe account and prints no D1 statement: the platform enables Connect, the Worker creates or reuses the account, the refresh route writes Stripe's status, the onboarding link comes from the route. New steps: an explicit `pod` feature row, the re-screen route until nothing is pending, legal readiness before the purchase (terms, return address + VAT answer, legal pages adopted by the shop's own admin). `--connect-proof` runs the login link (issued to the seller, refused to acting-as) and the payout delay (7, then the minimum). It refuses a Worker below migration 0038. **Not run: it needs the CP3 Worker on staging.**

**Rehearsal of the import (this commit, `CP3_S_REPORT.md` §10.7):** read-only target state from staging → plan from the real bundle → executed locally against every migration: 862 statements, none refused, the manifest's user figure. It found that melodie-mc would have been imported **unpublished** (no `published` field = published in Firebase), that its **commission of 5000 bps** was dropped without a word (D75), and that the VAT rate was not carried. All three fixed, 343 tests. Staging's `apparel_dtg` profile is the old 250 × 350; the export holds 300 × 400: correct it through the profiles route before the staging proof.

**🚀 CP3 STAGING DEPLOY — 2026-09-27 21:58 CEST.** Mikael applied migrations 0032–0038 (21:50, all seven ✅). Deployed **`f0db7a72`** → version **`2b2f3927-3dfd-4d64-b86f-510e67a87545`**, `/ready` on `0038_connect_onboarding.sql`, `/health` staging, cron attached. The deployed SHA is the one both reviews passed (note recorded and pushed on `f0db7a72`); the branch's later commits are scripts and docs, and `git diff f0db7a72 HEAD -- cloudflare/` is empty. The deploy ran from a detached checkout of that SHA.

**Staging proof, through the routes only (`seed-staging-slice.mjs`, first run against the CP3 Worker):**

| Step | Result |
|---|---|
| explicit `pod` row for `slice-20260927` | written by `PUT …/features` |
| Connect for the existing shop | enabled by the platform, the account found (200), refresh → `active`, charges and payouts enabled |
| re-screen | pending 0, unverified 0 on the first call |
| legal readiness | return address + VAT answer by `PUT /v1/admin/settings`, legal pages adopted by the shop's own admin, status `ready` |
| purchase | checkout 39 900 öre → `pi_3UKOBGKAaBMOW5AC04DlBOlL` succeeded, fee 25 620 → order `25ff551b-9fd9-479e-9ef4-771e7dfdcf16` made by the webhook |
| refund 10 000 | `8066e976-513c-433a-8556-7437d6e2d4a4` succeeded |
| reconcile | **BALANCED, Δ 0 öre, 2 orders**, after the purchase and again after the refund; 1 printer job each; 0 alerts |

**Connect v1 proof (`connect-proof-staging.mjs`, tenant `slice-connect-20260927`, account `acct_1UKOCrGyEAmj4zmk` created by the Worker):**

| # of `CP3_F_REPORT.md` | Result |
|---|---|
| 1 create | 404 while Connect is not enabled → enable 200 → create **201**, operation `succeeded`; Stripe metadata holds `tenant_id` and `onboarding_op_id`; a second create answers 200; Stripe lists **one** account for the tenant |
| 2 monthly schedule | `interval: monthly`, `monthly_anchor: 1`, `delay_days: 7` — **the parameter Stripe had not seen before is accepted** |
| 3 onboarding link | 200, host `connect.stripe.com` (the return URL is not readable from the link) |
| 5 refresh, login link | refresh 200; login link **issued to the shop's own admin**, the opaque **404 for the platform user acting-as** |
| 6 payout delay | 10 → stored 10, Stripe 10; `minimum` → stored NULL, Stripe 7; 1 → **422** `connect_payout_delay_refused` |
| 4 requirements by webhook, 7 stuck-operation alert, 8 v2 | not proven here (4 needs a person in the onboarding; 8 is its own proof) |

**Seen on real Stripe, not changed:** a new account that has not started its onboarding reads **`restricted`**, not `onboarding`, after the first refresh: Stripe sets a disabled reason on every new account, and `deriveConnectStatus` tests it before `details_submitted`. Firebase's `deriveStatus` does the same, so it is parity, but the seller's payments page (CP5) should not tell a new seller that the account is restricted. The accounts made before the routes (`acct_1UKHP7K39XhkqYJ0`) keep their `daily` schedule.

**Codex on the script commits (2026-09-28 01:00–01:40).** One review of the whole range since `f0db7a72`: four findings, two P1, none seen by the tests (`CP3_S_REPORT.md` §10.8): a user with a missing active flag was imported active; an adoption kept the target's own authorization without a word; evidence of a shop that is not imported broke the apply on a foreign key; a restore plan could not run on production. Fixed in `4c0faa66`; the re-review found that a users result of the earlier query slipped past the new check, fixed in `e52d599b`; the third review: clean. **353 tests.** Attestation recorded on `e52d599b`.

**The import plan for staging is built and waits for Mikael.** `~/chopshop-export/import-2026-09-28/plan/` (`plan.sql` 285 KB, 864 statements, sha256 `15406b3f…d7ab`), from the bundle of 2026-09-27 with `--scrub-unmapped` and the target state queried at 00:50 (three test tenants, two users). Executed against a local database with every migration and a pre-state like staging's: 862 statements applied, none refused. No source address and no Storage host in it. The restore point before the apply is in `time-travel-before-import.txt` beside the plan. After the apply: the actual-state queries, then `verify.mjs`.

**Groundwork for CP4 (no code, no go yet): `CP4_GAP_ANALYSIS.md`, D77–D82 on recommended defaults.** Three findings: an anonymous visitor gets a name and a price and nothing else (no branding, menu or image in any public response); public images can be neither uploaded nor served; the storefront finds its shop in the URL path and the Worker in the hostname. Eight builders proposed, public objects first. Of the 37 storefront files, 16 stay in the build. None of the six import rows moved into CP4 has met the real bundle.

**Branding images (D76):** not copied in CP3. Public objects have no delivery in the Worker yet, so the copy moves to CP4 with the product images. The imported shops have no logo, hero or favicon on staging until then.

**Order from here:** Codex on the script commits (`416b3bb1`, `7d59996b`, `779d3405`, and the proof script) → correct staging's `apparel_dtg` through the profiles route → target state by read-only queries → plan from the bundle with `--scrub-unmapped --target-state` → Mikael applies `plan.sql` → `verify.mjs` → CP3 closed.

## CP2 — Vertical slice (GO 2026-09-27 01:10, ✅ CLOSED 2026-09-27 13:00)

**Mikael:** "Skip all Codex reviews until 01:55 … GO!" — CP2 build started under the recommended defaults for D8–D11 (assumed; veto window until the CP2 deploy). Codex reviews resume 01:55 and gate the deploy as always. **Split (three Opus builders in parallel, disjoint files, route mounts via anchors in `src/app.ts`):** CP2-A money (refunds reserve-first, Stripe event handlers, Connect PI params, payout facts, retention sweep, reconciliation), CP2-B outbox with claims + dispatch state machine + cancellation ×4 + 15-min sweeper cron + manual resolution, CP2-C POD product path (mappings, screening D8, quotePodCost, publish gate, production snapshot at checkout, storefront POD fields). Then CP2-D: seed script + failure-injection suite + reconcile-to-the-öre report.

**Landed (02:40):** `b14c5d3` CP2-C (+88 tests; printers/tiers/mappings 0023, screening 0024, takedown + catalog_version 0025, quotePodCost + PRISGOLV in exact öre, ONE eligibility predicate + ETag/304, checkout snapshot freeze), `9542636` CP2-B (+96; outbox claims 0021, dispatch state 0022, cancellation ×4, manual resolve, order_confirmation email, sweeper + scheduled()), `ee6e7c7` CP2-A (+147; Connect destination charges + withholding, refunds reserve-first 0019, Stripe event matrix, payouts, retention + reconciliation crons), `a5ed618` (missed modules), `e45297e` consolidation (crons trigger + preflight pin 74 tests, /ready → 0025, router patches: 422 refusals, ETag handlers, dispatch target at checkout, 409 on deleting a mapped artwork). Full gate at consolidation: **1602 passed**, 2 failing only in CP2-B's in-progress Codex-fix tests. Codex: CP2-B reviewed (2 P1 = commit-boundary artifacts resolved by A's commit; 2 P2 → B fixing), CP2-C first run timed out (retry at medium effort running), CP2-A running. Rulings on the builders' deviations → DECISIONS D36–D40 (D36 = withholding release on pre-production refund needs Mikael). **Next:** B's fixes → commit → Codex → notes → apply migrations 0019–0025 to staging → recreate the Stripe webhook with `connect: true` (D39) → deploy → CP2-D (seed script + failure-injection suite + reconcile-to-the-öre + withholding release D36 + alert digest D40).

**Codex fix rounds (02:40–04:15):** B: 4543f11 (fingerprint + line-failed) → P2 → b660297 (frozen confirmation content) → **clean**. C: ee55cac (screening lock, base floor, no truncation) → P1+2 P2 → 201bc2e (single-batch freeze, pod_too_large refusals, fresh-clock retries) → Codex **quota exhausted** (try again 06:58). A: 428ffdc (deferred payment events 0026, settlement-batch dispatch stop, dispute reversal reconciliation, account.updated ordering, paged listings, payout refresh) → Codex **quota exhausted**. Fallback per working method: two read-only **Opus adversarial reviewers** on 428ffdc and 201bc2e (04:15); **Codex re-review of both at 06:58 is a logged debt** before any production deploy (staging may proceed on Fable + Opus). Full gate at 201bc2e: **1656 tests / 46 files**, guard PASS, preflight 74/74. Staging D1: migrations 0019–0026 applied (04:05). Stripe staging webhook recreated **with `connect=true`** and the 11-event CP2 list: `we_1UK66JKAaBMOW5ACuWMdx6K9` (old `we_1UK0jh…` deleted; secret re-uploaded) — note: a shell quoting slip deleted the old endpoint before the new one existed (≈ 2 min without a webhook on staging; no traffic).

**🚀 CP2 STAGING DEPLOY — 2026-09-27 05:05 CEST.** HEAD `f5a93e7`: version **`c97d4701-1d2a-4980-b4dc-1f138044158e`**, cron `*/15 * * * *` attached, `/ready` on `0027`, platform dispatch route dark anonymously. Final fix rounds: C `0f92394` (adversarial round: suspended-mapping floor bypass, one-batch multi-line freeze, pod_too_large only on live cuts), A `f5a93e7` (dispatch HOLD on unapplied payment facts, deferred replay before the sweep, account resync 0027, re-transfer key v2, dual webhook secrets) + reviewer wiring in `scheduled.ts` and `dispatch-effect.ts`. **Gate: 1681 tests / 47 files, guard PASS, preflight 75/75.** Staging D1 0001–0027. Stripe staging: two endpoints (D39). Secrets on the Worker: 9 (incl. `STRIPE_CONNECT_WEBHOOK_SECRET`). **Attestation debt — CLOSED 09:30:** Codex re-reviewed the four commits: `428ffdc` (P1 legacy re-transfer + P2 account refresh — both already fixed in `f5a93e7`), `201bc2e` (P2: correlated tier scan in the freeze → C fixing), `0f92394` clean, `f5a93e7` (2 P2: claimed-dispatch hold burns attempts; resync watermark ms vs s → D2 fixing). Original note: Codex quota exhausted 04:10 → `428ffdc`, `201bc2e`, `0f92394`, `f5a93e7` reviewed by Opus adversarial reviewers only; Codex re-review after 06:58 is required before any production deploy (note recorded in `refs/notes/reviews` on HEAD). **CP2-D launched 05:10:** D1 = vertical-slice e2e test + failure-injection suite (PLAN §10 list) + `scripts/cf-port/seed-staging-slice.mjs` + `reconcile-staging.mjs`; D2 = D36 withholding release, D40 alert digest, D41 floor incl. parcel.

**CP2-D landed (09:10–11:30, after the overnight Opus spend-limit stop):** `16d0fe4` C's tier-read query plan (Codex P2), `0cad1f0` **D2** (D36 withholding release 0028, D40 alert digest 0029 + `PLATFORM_ALERT_EMAIL`, D41 floor incl. parcel at max(VAT, 25 %); claimed-dispatch park + second-aligned resync watermark), `27190ca` D2 Codex fix (release executor backoff 0030; no starvation), `fd1f6bb` **D1** (vertical slice e2e + 25 failure-injection tests + `seed-staging-slice.mjs` + `reconcile-staging.mjs`). Gate: **1741 tests / 50 files**. Staging D1 0001–0030. Platform webhook now also `application_fee.refunded/refund.updated` (12 events). DECISIONS D42–D45 recorded. **D1's findings → CP2-E (launched 11:35):** checkout legal gate (seller terms acceptance, 0031) + buyer consent (terms / withdrawal waiver for personalised POD / marketing, frozen on checkout, copied to the order) + refund route `Idempotency-Key` + webhook nudges the outbox + platform order/alert list routes + resolved-failed dispatch no longer re-alerts. D2 still fixing 2 Codex P2s in the release executor (final-attempt uncertainty, amount mismatch bounded). **CP2 exit still open:** the real staging run (seed → sandbox purchase → refund → `reconcile-staging.mjs` BALANCED) after E lands and deploys.

**🚀 CP2 STAGING DEPLOY #2 — 2026-09-27 12:40 CEST.** HEAD `fee54bd` (CP2-E) → version **`60b0f5a9-f836-440d-a193-b6b401bc54b2`**, `/ready` on `0031`, cron attached. Landed since #1: `16d0fe4` (C tier plan), `0cad1f0` + `27190ca` + `0f3a4cf` (D2: D36/D40/D41 + executor backoff + uncertainty/mismatch; all Codex-clean), `fd1f6bb` (D1: slice e2e + 25 failure-injection tests + staging scripts), `fee54bd` (E: terms gate 0031, consent, refund Idempotency-Key, webhook nudge, platform orders/alerts routes, no re-alert; reconcile script fixes). **Gate 1772 tests / 51 files** (one timing flake seen once in `password-reset` under full load; passes alone). Staging D1 0001–0031. Platform webhook 12 events; Connect webhook `account.updated`. **Open:** E fixing Codex P2 (refund key race, `money-orders.ts`) → redeploy; then the **real staging run** (`scripts/cf-port/seed-staging-slice.mjs` → D1 UPDATE for `stripe_account_id` via preflight → Express onboarding (sandbox) → `--purchase` with `pm_card_visa` → `--refund` → `reconcile-staging.mjs` BALANCED) → close CP2. DECISIONS D46–D48 recorded (personalised = product flag; terms grace period CP3; payment route not re-gated).

**🚀 CP2 STAGING DEPLOY #3 — 2026-09-27 11:42 CEST.** HEAD `4622b68` (E's Codex P2: a same-key refund refused by its own twin is replayed) → version **`0395b454-5528-4bf7-afd6-ea8e42fe8d30`**, `/ready` on `0031`, `/health` staging, cron attached, container image unchanged (`637520fc…`, push skipped). Reviews of `4622b68`: Codex **clean** (no actionable findings), Fable line by line; attestation in `refs/notes/reviews` (pushed). **Gate 1776 tests / 51 files**, preflight 75/75, guard PASS. `juridik.md` moved to `OBSOLETE/` (gitignored) on Mikael's instruction — the tree is clean without it. **Open before the real staging run:** (1) the API host is still held by the throwaway tenant `bench-cp1` ("Bench CP1"), so `seed-staging-slice.mjs` refuses at the tenant step — there is no route that moves a hostname, it takes one D1 statement through the preflight: `UPDATE tenant_domains SET hostname = 'bench-cp1.invalid' WHERE tenant_id = 'bench-cp1';` (2) the Express sandbox onboarding must be completed in a browser: the script reads Stripe's own `charges_enabled`, flags set by SQL are not enough; (3) `CHOPSHOP_SLICE_ADMIN_PASSWORD` is generated and stored in `secrets.staging.env`.

**Staging run, first attempt (12:05):** Mikael ran the hostname rename (`bench-cp1` → `bench-cp1.invalid`). `seed-staging-slice.mjs`: preflight ✅, sign-in ✅, tenant **`slice-20260927` created** (holds the API host), then **refused at the Express account: Stripe 400 on `POST /v1/accounts`** — the sandbox platform no longer allows Accounts v1 creation → DECISIONS **D49** (Mikael enables "Accounts v1 support" for the sandbox; v2 for the onboarding checkpoint). Nothing else was written; the script is idempotent and resumes at the account step.

**Staging run, seed complete (12:42):** Mikael enabled "Support för Accounts v1" — first in **Testläge** (the live account's test sandbox, shares settings with live), then in the sandbox `Meteor Public Relations AB-sandlåda` (`acct_1Tp7gtKAaBMOW5AC`), the one staging uses. The refusal still came back: **Stripe was replaying the first attempt's 400 under the script's fixed Idempotency-Key** (`idempotent-replayed: true`, 24 h) → the seed script takes an optional `SLICE_KEY_SALT` (the metadata lookup still prevents a second account). With `SLICE_KEY_SALT=r2`: Express account **`acct_1UKHP7K39XhkqYJ0`** created (charges/payouts false until onboarded), acting-as ✅, printer `fake-printer` 2 SKUs ✅, artwork `716dbc1a…` rendered by the real container (3240×3240 px, 329 DPI) ✅, product `94913ccb…` `SLICE-TEE-20260927` ✅, mapping ✅, quote inköp 14000 öre / floor 26300 öre ✅, screening approved ✅, PDP 200 `W/"8"` ✅. **Next:** Mikael completes the Express onboarding in the browser → re-run the seed (prints the `UPDATE tenants …` with Stripe's flags) → Mikael runs it through the preflight → `--purchase` → `--refund` → `reconcile-staging.mjs`.

**✅ CP2 CLOSED — 2026-09-27 13:00 CEST — the real staging money run, BALANCED to the öre.** Staging Worker `0395b454` (code `4622b68`), sandbox platform `acct_1Tp7gtKAaBMOW5AC`, tenant `slice-20260927`, Connect `acct_1UKHP7K39XhkqYJ0` (Express onboarding completed by Mikael: charges + payouts enabled, `card_payments` + `transfers` active, nothing due; Connect facts set on D1 through the preflight by Mikael).

| Step (live, staging) | Result |
|---|---|
| Seller terms gate | accepted `2026-09-07` by `slice-admin+slice-20260927@example.com` (the shop's own admin; password in `secrets.staging.env`) |
| Checkout `0b6cafdc…` | 39 900 öre, pickup, buyer consent |
| PaymentIntent `pi_3UKHZAKAaBMOW5AC1FvKJxZ0` | `succeeded` with `pm_card_visa`, application fee 25 620, destination the Connect account |
| Webhook → order `88afc8cf-c89c-43ad-8203-7eccb830938f` | made in one batch; receipt `ready` |
| Reconciliation after the purchase | **BALANCED Δ 0**: charged 39 900 · fee 25 620 · payout D1 14 280 = Stripe net 14 280 · **1 printer job** · 0 unknown/failed dispatches · 0 open alerts |
| Partial refund 10 000 öre | refund `a94c6e4d-aa95-4e3b-94d3-43bd71384141` → `succeeded` |
| The same refund command again | the SAME refundId answered (Idempotency-Key replay); **Stripe holds exactly one refund** (`re_3UKHZAKAaBMOW5AC1NSdJHVp`, 10 000) |
| Reconciliation after the refund | **BALANCED Δ 0**: `partially_refunded` · refunded 10 000 · payout D1 4 280 = Stripe net 4 280 · 1 job · 0 alerts |

**Exit criteria (PLAN §9):** money reconciles to the öre ✅ **live** (twice) · one accepted printer job per eligible order ✅ **live** (1) and under every injected failure ✅ suite · zero jobs for pre-dispatch cancellations, stranded-work alerts within 30 min, refund race cannot over-refund, guest receipt cannot read another shop's order, late render completion rejected ✅ **failure-injection suite** (`test/slice/`, part of the 1776-test gate; not repeated live) · **design diff clean on the slice pages — NOT RUN: no storefront page renders from Cloudflare before CP4; carried to CP4's exit.** Also not exercised live: email delivery (Resend blocked on Kent's key), full refund + printer cancellation on staging, withholding release (D36) on staging.

**Notes for the next checkpoint:** DECISIONS D49 (Accounts v1 enabled in the sandbox AND in Testläge/live by Mikael; v2 at the onboarding checkpoint). HEAD carries docs + the seed script's `SLICE_KEY_SALT` (`d52e866`) — not deployed code, but Codex has not seen it; it rides along with the next reviewed deploy. `juridik.md` lives in `OBSOLETE/` (gitignored). Staging holds throwaway data: tenants `bench-cp1` (hostname `bench-cp1.invalid`), `slice-20260927`. **Next: CP3 needs Mikael's "CP3 go" + "defaults" for D12–D23.**

## CP1 — Foundation on Kent's account (approved 2026-09-26, ✅ CLOSED 2026-09-27 01:05)

**Session note:** the two CP1 Opus builders started at the end of the first 2026-09-26 session died with it — nothing reached disk or Cloudflare (verified: clean `git status`, `wrangler.jsonc` still on the old account, Kent's account held zero chopshop resources). Both were relaunched from written briefs in the second session; this entry is filled in when their diffs pass Fable review.

**Facts established before relaunch (read-only API/wrangler, token from `~/.config/chopshop/cloudflare.env`):** the token sees exactly one account (Kent's, `ee213082783ec86585150e876edb6107`); workers.dev subdomain `kent-ee2`; account holds unrelated `ai-content-hub` D1 + R2 bucket `ai-content-hub-media` (do not touch); zone **`melodiemc.com` is ACTIVE on Kent's account** (→ DECISIONS D7b); no queues, no Workers.

**Landed (2026-09-26 evening):**
- `6f68d10` **CP1-A** — all 14 resources on Kent's account (D1 `chopshop-stg` `5ee51e82-ab3b-4f39-b937-a5507aee2522` with 0001–0012 applied, `chopshop-prod` `6216ebd9-760b-4506-8165-af4507d3f1fe` empty; R2 ×6 `--jurisdiction eu`; Queues ×6, no DLQ), env-aware `wrangler.jsonc` (top level `chopshop-api-unbound`, bindings-less; `env.staging` `chopshop-api-stg`, `env.production` `chopshop-api`), pinned ids + `origins`, preflight extended (env name, origins, AUTH_*, SERVICE_NAME, R2_PRIVATE_BUCKET_NAME, jurisdiction, R2_JURISDICTION; 62 tests), direct-wrangler npm scripts removed. Record: `CP1_BOOTSTRAP.md`.
- `db66555` **CP1-B** — Hono router on the raw pathname (`src/app.ts`; old-vs-new comparison identical over 58 paths × 2 hosts × 7 methods), public entrypoint + `Internal` WorkerEntrypoint both strip `X-Tenant-*` (handler-layer guard 404s if one ever gets through), admin tenant = `X-Shop-Id` validated against live memberships (contract change; hostname no longer consulted for `/v1/admin/**`), acting-as grants (`0013`, 60 min, audited, revocable, re-checked live per request), `CANONICAL_ORIGINS` allowlist (`src/lib/origins.ts`), password reset mounted (`request-password-reset`, `reset-password/:token`, `reset-password`) with ledger + `EMAIL_QUEUE` → Resend consumer (idempotency-key, lease, backoff; dark until `RESEND_API_KEY`+`EMAIL_FROM`), guest receipt capability (`0014`: hashed token on order, one-shot handoff `POST /v1/checkout/:id/receipt` by `DELETE…RETURNING`, allowlisted buyer schema `GET /v1/orders/:id` with denylist test), Better Auth limiter keyed on `cf-connecting-ip` (was X-Forwarded-For — bypassable), R2 EU presign host. Tests 916 → 1094 / 31 files. Record: `CP1_B_REPORT.md`.
- Reviewer (Fable) fixes at merge: `R2_JURISDICTION` var was read by B but never set by A → added to both envs + preflight check; dead `AUTH_EMAIL_QUEUE` declaration removed; vitest `environment: "staging"`; guard red from three CP0 docs fixed (`94c5678`).

**🚀 FIRST STAGING DEPLOY — 2026-09-26 21:10 CEST.** `scripts/cf-deploy.sh staging` on HEAD `29412a5` (attestations `codex: PASS` + `fable: PASS` in `refs/notes/reviews`, pushed) → Worker **`chopshop-api-stg`** at `https://chopshop-api-stg.kent-ee2.workers.dev`, version `f318df4b-2b0c-4c9c-8a4c-fe32cdd78f88`, all 7 bindings + 3 queue consumers attached. Staging D1 has migrations 0001–0016. Secrets set via the preflight from the 600 files: `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`BOOTSTRAP_TOKEN` set, used once, deleted). Stripe sandbox webhook endpoint `we_1UK0jhKAaBMOW5ACAHh8BxB8` → `/v1/webhooks/stripe` (`payment_intent.succeeded`, api `2026-07-29.dahlia`), pinned.

**Smoke (live, curl):** `/health` 200 · `/ready` 200 (`0016_…`) · `/v1/storefront` 404 (no tenant domain yet) · anonymous `get-session` `null` 200 · **bootstrap** → platform admin `micke.ohlen@gmail.com` (uid `oayBSxS86Imk746kC0oY65eUMIcUL0B6`; password in `~/.config/chopshop/secrets.staging.env` → `PLATFORM_ADMIN_PASSWORD`) 201 · **sign-in** 200 + session cookie · `get-session` with cookie 200 · **request-password-reset** 200 (byte-identical shape) → `email_deliveries` row `password_reset / pending / 0 attempts` — the consumer holds it until `RESEND_API_KEY` + `EMAIL_FROM` exist. Not yet exercised on staging: reset link + reset-password (needs the email), tenant/admin surface (needs a tenant + `X-Shop-Id`), receipts (needs a checkout), POD (needs R2 API token).

**Live contract smoke (staging, 21:14):** tenant `smoke-cp1` created (hostname = the worker host, so `/v1/storefront` resolves it) 201 · `POST /v1/admin/products` without `X-Shop-Id` 404 · with `X-Shop-Id: smoke-cp1` but no grant 404 · `POST …/smoke-cp1/acting-as` 201 (60 min) · product create with grant 201 (`SMOKE-1`, draft) · `/v1/storefront` 200 by hostname · `DELETE …/acting-as` 204 · product create after revoke 404. `smoke-cp1` is throwaway staging data (archive/drop at CP3 import).

**D1 backup + restore drill (staging, 21:16–21:19):** export (55 KB, 31 tables, 38 rows) → Time Travel restore to 19:13Z (smoke tenant gone, admin + migrations intact, `/ready` 200) → restore forward to the printed undo bookmark (tenant, product, revoked grant all back). Runbook + gotchas (`--remote` only on export/execute; confirmation on stdin): `D1_BACKUP_RESTORE.md`. Weekly export-to-R2 cron + 5 GB alert deferred to CP2/3.

**`7024f91` CP1-C (built 21:25–22:15, Fable-reviewed, Codex in progress):** `render_jobs` (0017) + `alerts`; farm pull API `POST /v1/render/jobs/{acquire,:id/complete,:id/fail}` (bearer `RENDER_FARM_TOKEN` ≥ 32 chars, constant-time, 120/min per IP) with lease fencing in SQL (hashed token, attempt-specific `attempt-{n}/` outputs, checksum-verified promotion to immutable canonical keys, late/stale report 409 + sweep, 3 attempts → `failed` + alert + processing artwork removed); artwork creation async (202 `processing`, GET polls; `SYNC_RENDER_FALLBACK=false` keeps the sync path); `-render-jobs` consumer acks (row is truth, farm pulls); staging fake printer (0018) `POST/GET /v1/staging/fake-printer/jobs` gated APP_ENV=staging + `DISPATCH_TARGET=fake-printer` + `FAKE_PRINTER_TOKEN` (SnapWear-shaped 201 / 400 duplicate / 422, SKU list drift-tested against `snapwear-catalog.json`); `src/dispatch/printer-client.ts` (fake client + `snapwear` stub → `not_implemented`, A5/A6). **Bug found:** `render-farm-client.ts` used `redirect: "error"`, which workerd rejects on every call — every real synchronous farm dispatch would have 502'd; fixed to `"manual"`. Tests 1097 → 1229 (33 files). Reviewer: `DISPATCH_TARGET` var per env + preflight check (71 tests). Migrations 0017–0018 applied to staging; `FAKE_PRINTER_TOKEN` + `RENDER_FARM_TOKEN` generated into the secrets file (set on the Worker at the next deploy). Builder's open points, answered by the reviewer: bearer-over-TLS for the farm→API direction stays for CP1 (the DO→container direction is the private binding — CP1-D); 429 on the render surface is acceptable (the farm needs Retry-After); 404 after terminal failure is acceptable until the studio UI needs a `failed` status (CP6); `RENDER_FARM_URL` requirement drops when the sync fallback is deleted.

**`dfe7269` CP1-D (built 22:45–23:45, Fable-reviewed, Codex in progress):** render service on Cloudflare Containers (D6). `cloudflare/render/` = Node 22 + sharp 0.35.4 image (linux/amd64, non-root), pull loop against `/v1/render` (acquire every 3 s while armed, disarm after `IDLE_EXIT_SECONDS`=120, `/wake`, `/healthz`), input streamed to disk under `min(input.maxBytes, 200 MiB)`, PNG master + WebP preview proven byte-identical to the Firebase farm's encode, 88 tests. Worker side `src/render/`: `RenderContainer` DO (`sleepAfter` 5m, `/healthz` before stop, destroy after 2 unanswered), `wake()` from the `-render-jobs` consumer (acks `container_not_bound` / `render_not_configured`, retries nudges 30 s on wake failure), contract test imports the container's `contract.ts` against the real routes. Worker tests 1235 → 1246 (34 files). Reviewer: `containers`/`durable_objects`/DO migration `v1` in both envs (standard-1, max_instances 1, EU placement), `RenderContainer` exported, preflight pins container + binding (73 tests). Answers to the builder's questions: instance type `standard-1` now, staging benchmark decides `basic`; idle settings kept; container→API auth stays bearer-over-TLS for CP1 (the `outboundByHost` upgrade + `ContainerProxy` is a CP2 item together with CP1-C Q1); stranded-job re-wake → the CP2 15-min sweeper; base image digest pin once a Docker host resolves it; jemalloc only on evidence. **Local benchmark (M1 Pro, native Node, NOT Cloudflare):** largest allowed artwork (10 000² px, 45.5 MB) 10.7 s / 539 MB peak; 10 sequential ≈ 9.9 s each; 3 concurrent 10.9 s / 1.18 GB; typical upload 0.84 s / ~180 MB. Staging protocol + pricing + thresholds: `RENDER_BENCHMARK.md`. Deploy prerequisite: Docker Desktop running (image built at `wrangler deploy`).

**CP1-D (Opus, launched 22:45):** render service on Cloudflare Containers (D6): `cloudflare/render/` image (Node 22 + sharp, pull loop against the CP1-C API, 300-DPI gate, PNG master + WebP preview), `RenderContainer` Durable Object with `sleepAfter`, wake-up from the `-render-jobs` consumer, `RENDER_BENCHMARK.md` protocol + local numbers. Reviewer applies the `wrangler.jsonc` containers/DO config and runs the staging benchmark (Docker Desktop must be running for the image build at deploy).

**Deploy attempt 23:55 (CP1-C + CP1-D, HEAD `c95e789`, notes pushed):** gate passed, image built (`chopshop-api-stg-rendercontainer-staging:4692fae9`, 92 MB), **registry push refused: Containers API 403 on the account** → DECISIONS **D35** (Mikael enables Containers / adds the token permission). Worker untouched (still `f2c91794`). Rerun `scripts/cf-deploy.sh staging` once D35 is done; then `secret put RENDER_FARM_TOKEN` + `FAKE_PRINTER_TOKEN`, smoke, benchmark.

**🚀 SECOND STAGING DEPLOY — 2026-09-27 00:05 CEST (CP1-C + CP1-D):** after D35 (token permission), `scripts/cf-deploy.sh staging` on HEAD `10a254e` (code = `c95e789`) built and pushed `chopshop-api-stg-rendercontainer-staging` (image sha256 `637520fc…`) and deployed version **`14a78c8e-17bb-41af-b831-5ba12bc276e7`** with the `RENDER_CONTAINER` DO binding; container application `chopshop-api-stg-rendercontainer-staging` registered (max 1 instance, EU). Secrets added: `RENDER_FARM_TOKEN`, `FAKE_PRINTER_TOKEN` (now 5 secrets on the Worker). **Smoke:** `/ready` 200 on `0018` · `/v1/render/jobs/acquire` 404 without / with a wrong bearer, **and 404 with the right bearer — by design: the render surface also needs the R2 presigner (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`), still owed by Mikael** · fake printer 404 without token, SnapWear-shaped 422 with per-field errors with it. **CP1 exit criteria:** sign-in ✅ · reset request ✅ (delivery waits for Resend) · tenant header ignored ✅ (test + live) · wrong host → opaque 404 ✅ · restore drill ✅ · render decision ✅ D6 with local numbers; **staging benchmark pending the R2 token pair.** Remaining CP1 items after that: RENDER_BENCHMARK.md protocol on staging → numbers → instance type; email e2e once Resend exists.

**✅ CP1 CLOSED — 2026-09-27 01:05 CEST.** Third staging deploy `2b45fd0f` (HEAD `048eabe`: POD surfaces no longer require `RENDER_FARM_URL` under the pull model — found by the benchmark; the whole POD surface had been dark). R2 key pair set (Mikael). **Render benchmark on staging (RENDER_BENCHMARK.md §7):** largest artwork **34.5 s cold / 43.7 s warm**, peak **563 / 661 MB**, cold start ≈ 12 s, typical 4.2 s; 7/7 jobs `completed` at attempt 1, no alerts → **Containers `standard-1`** (basic rejected). Every CP1 exit criterion met except the reset-EMAIL delivery (needs a Resend key from Kent's account — Mikael has no access; not an exit criterion). Deferred to CP2: scenarios B/C (needs pacing under the 5/min artwork limit), the email e2e, `outboundByHost` auth upgrade for container→API, stranded-job re-wake by the sweeper. Staging holds throwaway data: tenants `smoke-cp1`(gone after EU recreate), `bench-cp1` + 7 artworks + 3 objects in `chopshop-stg-private` — archive/drop at the CP3 import. **Next: PLAN v3 → Codex re-review (Codex 5 h quota resets 01:52) → Mikael approves CP2.**

**Codex (6 runs, gpt-6-astra, high):** `65f610c` 4×P1 + 2×P2 → fixed `9b02e24` (+ P2 → `9aadb15`, re-reviewed clean); `6f68d10` 3×P1 all supplied by `db66555`; `db66555` 1×P2 → `7908e83` → P2 → `694e559` → P2 → `29412a5` (5-line trigger, Fable-reviewed). Verdict at HEAD: no open findings.

**Verification (at `29412a5`):** `bash guard/preflight.test.sh` 70/70 · `node guard/guards.test.mjs` PASS · `cd cloudflare && npm run check` types up to date, tsc 0, vitest 1097/1097 (31 files).

**Verification (at `db66555`, historical):** `bash guard/preflight.test.sh` 62/62 · `node guard/guards.test.mjs` PASS · `cd cloudflare && npm run check` types up to date, tsc 0, vitest 1094/1094 (31 files). (superseded by the Codex paragraph above)

**Known gaps (B's own list):** reset timing side-channel (known vs unknown address) remains; object-store audit rows do not record the acting-as grant; email copy still says "MeteorShop"; uncollected receipt handoffs are swept only by the next poll (15-min sweeper is CP2); `DELETE … LIMIT` relies on D1's SQLite build (passes in the workers pool, confirm on staging).

**Split:** CP1-A = account bootstrap (D1 ×2, R2 ×6, Queues ×6, staging migrations, env-aware `wrangler.jsonc`, pinned ids, preflight extension, `CP1_BOOTSTRAP.md`). CP1-B = worker contract (Hono, two entrypoints + header stripping, `X-Shop-Id` + acting-as, canonical-origin allowlist, password reset via EMAIL_QUEUE → Resend, guest receipt capability, `CP1_B_REPORT.md`). Still to come in CP1: render benchmark + decision (D6), `render_jobs` acquire/complete with fencing, fake printer route (staging only), D1 backup + restore drill.

## CP0 — Hygiene + baseline (approved 2026-09-26, in progress)

**Done (all on `cf-port`, each verified by Fable before commit):**
- `83080ed` `cloudflare/` worker tree + `docs/CLOUDFLARE_HANDOVER.md` + `RENDER_FARM_CONTRACT.md` brought over from `cloudflare-migration` @ `2b13d05`, unchanged.
- `e24f17a` **test gate green**: the six test-only POD env values cp27 forgot (`vitest.config.ts`, `test/env.d.ts`) + regenerated `worker-configuration.d.ts` — recovered from `stash@{0}`. `npm run check` → types up to date, tsc 0, **vitest 916/916** (independent run).
- `ea74f4e` docs quarantine: 9 files → the two `docs/_archive/` subfolders (legacy-brand, superseded) with `INDEX.md`; `docs/cf-port/RETIRED.md` ledger; 173 MB image dumps moved to `~/Cursor Apps/chopshop-quarantine/`; cpuprofile deleted; zero live references (verified).
- `8cd7466` `MIGRATION_MANIFEST.md` — 75 rows (22 carry / 46 archive / 7 drop), read-only prod census, 15 open questions (→ DECISIONS D9–D23).
- `b2a8ba9` `specs/AFFILIATE.md` — live program specified from source; found the `approveAffiliate` takeover hole → **hotfix `f807625` on `main`** (merged `65628e1`), deploy pending Mikael (DECISIONS D1).
- `d882b00` storefront **design baseline** — 12 launch-scope pages × 375/768/1440 on bundle `index-EybuBb5L.js`, manifest with sha256, re-shoot script + ImageMagick diff script (0.5 % gate); re-shoot 10 min later: 33/36 identical, 3 within 0.003 %.
- `5a0fe32` PLAN v3 (Codex rounds 1–3 folded in); `b1e8c97` `DECISIONS.md`.
- (this commit) **guards + preflight + deploy gate** — see commit message. Real preflight run authenticates to Kent's account and refuses on the still-old `wrangler.jsonc` account id (expected until CP1).
- `main` `a497d32` hotfix: `run-all.sh` always rebuilds; Firebase freeze announced in LAUNCH_TODO.

**Reviews:** Fable reviewed every builder diff line by line (this file's author). Codex reviewed the PLAN (3 rounds); Codex review of the CP0 *code* (guards/preflight/deploy) is **pending** — CP0 has no deploy, so the `cf-deploy.sh` gate is not yet exercised for real.

**Open in CP0 (status 2026-09-26 evening):**
1. Hono router → slid into CP1-B (routing contract lands with the entrypoints).
2. ~~Impeccable audit → design contract~~ ✅ `ef88c4d` `DESIGN_CONTRACT.md`.
3. Admin/platform baseline screenshots — still needs a logged-in browser session handed off by Mikael.
4. ~~Compromised-secret revocation~~ ✅ verified unused, commands in `c3f31df` `SECRETS_REVOKE.md` (now `scripts/cf-port/SECRETS_REVOKE.md` — Firebase-side runbook, guard-excluded like the export tooling); **Mikael runs them** (D4).
5. Code retirement of the DELETE list — blocked on D2 sign-off.
6. Codex review of the CP0 tooling — folded into the CP1 review (same deploy).
7. ~~Token scopes~~ ✅ D5b answered (R2 + DNS scopes added; `r2 bucket list` on Kent's account works).

**Known gaps carried into CP1:** `wrangler.jsonc` must be retargeted (Kent's `account_id`, `env.staging`/`env.production` with the pinned names); `cloudflare/package.json` scripts call wrangler directly (bypass the preflight) — remove them; `cf-deploy.sh` does not itself enforce clean-checkout CI (CI does); git notes need `git push origin refs/notes/reviews`.
