claude-opus-5-5

# CP13 A4: mail copy, terms, the platform add-on lists, the pending-object sweep, the staging seed and the smoke

Worktree `.claude/worktrees/cp13-affiliate`, branch `cp13-affiliate`. Everything here is in the working tree only. There was no git write, no deploy, no wrangler call and no network access; the seed and the smoke were written and syntax-checked, not run. A2 and A3 were editing the same tree at the same time. I touched only the files listed in §1 and reverted or tidied nothing of theirs.

Before writing anything I read, in full: CP13_BRIEFS §0, §1 and A4; CP13_A1_REPORT §4, §8 and §10; design §0, §4.5, §6.2, §8, §9, §12 and §13; Codex audit B7; the memory note `platform_users_and_superadmin`; and every file below.

## 1. Files

### Changed

- `cloudflare/src/affiliate/terms.ts`: the final Swedish terms text and the module comment. The version stays `2026-10-22`. When there is no support address, the fallback now reads "kontakta butiken".
- `cloudflare/migrations/0059_affiliate.sql`: only the seeded `text_sha256` changed (see §3).
- `cloudflare/src/email/affiliate-emails.ts`: the final sv/en copy for all 8 kinds. The job shapes, the field lists, the fingerprint and the sender/Reply-To rules are A1's and unchanged.
- `cloudflare/test/affiliate-emails.test.ts`: 15 new tests (13 → 28).
- `cloudflare/src/outbox/scheduled.ts`: the sweep is wired as the step `pending_object_sweep` in `CP13_STEPS`, after A1's `affiliate_application_retention`, plus the comments.
- `src/config/legalTemplates.js`: one paragraph in the integritetspolicy §9, and `LEGAL_TEMPLATE_VERSION` bumped `2026-09-07` → `2026-10-23` (see §4).
- `docs/legal-template-files/03-integritetspolicy.md`: the same paragraph plus a "BESLUT (granskas av jurist)" box. This file is not in the brief (see §6.5).
- `src/admin-app/adapters/platformShops.js`:
  - `API_FEATURE_KEYS` and `OFF_AT_PROVISION` gain `affiliate`.
  - `KEYS_THE_API_DOES_NOT_NAME` LOSES `affiliate` (see §6.2).
- `src/admin-app/adapters/platformShops.test.mjs`: the expectations are updated, plus 2 new tests. One of them checks that a provisioned shop gets `affiliate: false` whatever the preset says.
- `src/admin-app/adapters/platformConsole.js`: `API_FEATURE_KEYS` gains `affiliate`, so the add-on table gets an Affiliate column. I edited only that block, because A2 also edits this file.
- `src/admin-app/adapters/platformConsole.test.mjs`: only the `add-ons` describe changed (7 keys; the columns include `affiliate`).
- `src/components/platform/ProvisionShopModal.jsx`: the preset `affiliate: true` → `false`, with a comment. The brief's path `src/pages/platform/` does not exist.
- `src/admin-app/replacements/platformAddonsData.js`: comments only. The page and its data module do not hard-code keys; the columns come from `API_FEATURE_KEYS`, so no code change was needed.
- `scripts/cf-port/seed-staging-slice.mjs`: the new flags `--affiliate` and `--ref-code <CODE>` (the latter goes with `--purchase`), and the header.

### New

- `cloudflare/src/storage/object-sweep.ts`
- `cloudflare/test/object-sweep.test.ts` (10 tests since round 1)
- `cloudflare/test/affiliate-terms.test.ts` (round 1, 4 tests)
- `cloudflare/scripts/stg-affiliate-smoke.sh` (executable). It sits next to the existing `stg-*.sh`, which live in `cloudflare/scripts/`, not in the root `scripts/`.
- `docs/cf-port/CP13_A4_REPORT.md` (this file)

## 2. The final subject lines (sv)

| Kind | To | Subject |
|---|---|---|
| `affiliate_application_received` | applicant | `Tack för din ansökan till {butikens genitiv} affiliateprogram` |
| `affiliate_application_notice` | the shop | `Ny affiliate-ansökan: {namn}` |
| `password_reset`, variant `affiliate_invite` | affiliate without a password | `Välkommen som affiliate hos {butik}` |
| `affiliate_welcome` | affiliate who already has a password | `Du har lagts till som affiliate hos {butik}` |
| `affiliate_application_denied` | applicant | `Din ansökan till {butikens genitiv} affiliateprogram` |
| `affiliate_conversion` | affiliate | `Ny provision: 54,00 kr` |
| `affiliate_reversal` | affiliate | `Provision justerad: −27,00 kr`, or for a refund that failed: `Provision återställd: +27,00 kr` |
| `affiliate_payout` | affiliate | `Utbetalning registrerad: 100,00 kr`, or when declined: `Begäran om utbetalning avvisad` |
| `affiliate_payout_requested` | the shop | `{namn} begär utbetalning: 100,00 kr` |

How the copy behaves:

- **Genitive (round 1).** The name is trimmed first.
  - Ending in s, x or z: unchanged ("Lars", "Max").
  - Ending in a digit or a non-letter, or a last word that is an all-caps abbreviation: colon genitive ("Meteor PR AB:s", "IKEA:s", "Shop24:s").
  - Otherwise: + s ("Kents").
  - With no name: "butikens".

  This is tested.
- **The conversion mail's "tidigast <dag>" (round 1)** is the Swedish calendar day, Europe/Stockholm. In winter 23:30Z is already the next day; in summer 22:30Z is. This is tested.
- **Invite.** The invite's copy lives in A1's `auth-email-job.ts` (`affiliateInviteCopy`), which is not my file. I reviewed it and kept it as final. It already names the shop, the code, the link, the rates and the portal, and says that the link is valid for 72 h and single-use.
- **Mails sent under the shop's name** close with "Har du frågor? Svara på det här mejlet eller skriv till {support}" (Reply-To is the support address) and "Hälsningar, {butik}". Neither line appears when the corresponding field is missing.
- **The shop's own two mails** carry the admin link when an `adminUrl` exists. Otherwise they say where to find the item in the admin.
- **Applicant text.** The applicant's two mails cannot carry anything the applicant typed: those kinds have no field for it, and a test proves that every typed field is refused. The denial mail carries the SHOP's reason.
- **Fingerprints** are pinned for `affiliate_welcome` (`fe5774df…`) and `affiliate_conversion` (`6fb29fda…`). I checked both values outside the Worker: SHA-256 of the canonical JSON, computed independently in Python.

## 3. Terms: version and sha (decision; updated in round 1)

- **I kept the version `2026-10-22` and updated 0059's seeded sha.** This is the option A1 §8.2 preferred, and the coordinator confirmed in round 1 that 0059 has been applied nowhere. The sha went `ee41588c…` (A1) → `f075d79e…` (my first round) → **`bff6a1379f0ee0ddfb10d8d14879ae8ca5c0b801c8a10fe475a4b435550fc2b3`** (round 1).
- **The pins.** `test/affiliate-schema` compares the seeded row with `affiliateTermsSha256()`. Since round 1, the new `test/affiliate-terms.test.ts` also pins the literal value.
- **⚠ Once 0059 has been applied anywhere**, a wording change needs a NEW version (a new row by migration, design §8).
- **No figure in a term (round 1).** The numbered clauses never name a rate:
  - §3: the buyer discount is "den rabatt … som butiken anger för dig och som visas i affiliateportalen";
  - §4: the commission is "den provision som butiken anger för dig (visas i affiliateportalen)", and a rate change applies to purchases after it;
  - §11: "Villkoren kan ändras. Nya villkor gäller för dig först när du har godkänt dem i affiliateportalen."

  The affiliate's own rates appear only in the closing line, which is marked as information: "Information (inte en del av villkoren): just nu gäller {{discount_percent}} % rabatt till köparen och {{commission_percent}} % provision till dig. …". It is rendered per affiliate; the hash covers the template, so no rate moves it. This keeps the merge fields the routes render, and A1's route test (which expects "15 %" and "10 %") still passes.
- **The text** (§1–§11) covers every point in design §8:
  - parties; the code and the link (the link wins; 30 days in the cart); the buyer discount (not on shipping, not combinable);
  - the commission base; the 14-day hold, the pro-rata reversal and the lost dispute;
  - the payout: invoice or underlag, the shop pays, and private persons may owe tax;
  - **the MFL sentence, word for word as design §8 has it** (tested); no bidding on the shop's name and no impersonating the shop;
  - no self-purchase (neither the affiliate nor a shop admin); termination;
  - personal data;
  - changes.
- **⚠ The whole text wants Mikael's legal read** (design §13.4).

## 4. The privacy sentence (⚠ FLAGGED for Mikael's legal read; rewritten in round 1)

It is added to the integritetspolicy, §9 Cookies, after the existing paragraph:

> Kommer du till webbshoppen via en affiliatelänk (en länk med en kod från någon som marknadsför webbshoppen) sparas koden tillsammans med varukorgen i din egen webbläsare i upp till 30 dagar, så att rabatten och provisionen kan knytas till ditt köp. Besöken via länken räknas per affiliate och dag utan att kopplas till dig. För att begränsa missbruk sparas en hashad (pseudonymiserad) form av din IP-adress i högst sju dagar. Den som delat länken får inte veta vem du är.

Each claim checked against the code:

| Claim | Source |
|---|---|
| The code is kept with the cart in the browser, 30 days | A3's `Cart.jsx` (localStorage) and `REF_MAX_AGE_MS` |
| Landings counted per affiliate and day, with no visitor identifier | `affiliate_click_days`, `clicks.ts` |
| The limiter stores SHA-256 of `scope:ip`, IPv6 by its /64 | `lib/rate-limit.ts` |
| Limiter rows are kept up to 7 days | `RETENTION_MS` cleanup; not only the 10-minute window, which is why the sentence says "högst sju dagar" |

That IP hash is pseudonymous data, so the sentence no longer says "utan personuppgifter".

- **Not gated on the add-on, deliberately.** `[[IF affiliate]]` could be evaluated in `legalPageRenderer.js` with one line. But the flag would have to reach every renderer call: `AdminSettings.jsx` has five call sites, plus both `legalAcceptance.js` modules, and the server's accept-pages body records only `pod`. Worse, nothing prompts a seller to re-adopt when the add-on is switched ON later: `textsChangedSince` compares the template version, not the rendered text. A gated paragraph would therefore silently stay missing for exactly the shops that need it. That is not a small, safe change in the renderer, so it stays ungated.
- **`LEGAL_TEMPLATE_VERSION` is bumped to `2026-10-23`**, per the file's rule. On the port this is a SOFT signal: `needsLegalReacceptance` is "never a checkout blocker". Sellers are asked to re-adopt and no checkout closes.
- **The source doc's BESLUT box** (granskas av jurist) now asks three questions:
  1. Is the wording right? The facts are listed in the box.
  2. Does the cart-stored code need consent under LEK 9 kap. 28 §, or does it fall under the exception for what is necessary for a service the user asked for?
  3. Should the legal basis (berättigat intresse) be named?

## 5. The sweep's rules (`cloudflare/src/storage/object-sweep.ts`; updated in round 1)

**When.** The step `pending_object_sweep` runs on the existing 15-minute cron, after the application retention. At most 100 rows per tick (`OBJECT_SWEEP_BATCH`), retries included; new rows go oldest first.

**What is swept:**
- **A reservation that never landed:** `pending`, `immutable = 0`, created more than 7 days ago (`PENDING_OBJECT_MAX_AGE_MS`).
- **(round 1) An uploaded affiliate invoice that was never attached:** `active`, `immutable = 0`, kind `document` in the private bucket, listed in `affiliate_invoice_objects`, `updated_at` more than 30 days ago (`UNATTACHED_INVOICE_MAX_AGE_MS`), and named by no payout (not even a void one).

**Never swept** — an immutable row, or a row anything names by id:
- every holder in `OBJECT_ID_HOLDERS`:
  - `pod_artwork.original_object_id`
  - `product_images.object_id`
  - `collections.image_object_id`
  - `pages.image_object_id`
  - `affiliate_payouts.invoice_object_id` (no foreign key)
- the store identity's branding ids (`tenant_settings.store_identity_json`, a substring test).

Each statement re-checks the guard. A live object of the shop that is not a listed invoice is never swept, however old.

**Schema test (round 1).** It walks `pragma_foreign_key_list` over every table. Every foreign key to `stored_objects` must be a guarded holder or the invoice listing, and every holder must exist with a `tenant_id`. A future migration that adds a holder fails the suite instead of losing data silently.

**Per tick:**
0. **Retries first.** Rows this sweep tombstoned whose bytes are not confirmed gone: an `object.sweep` audit row and no `object.bytes_deleted` one, looked up by the `(resource_type, resource_id)` index.
1. **One batch.** Tombstone the new rows and write an `object.sweep` audit row each: `{kind, bucket, reason: pending_expired | unattached_invoice, listed}`, tenant set, no actor. A late upload or a payout request is then refused.
2. **The bytes.** Delete them per bucket. `temp` has nothing to delete.
3. **One batch, for the rows whose bytes are gone.** Write an `object.bytes_deleted` audit row each; this is the "done" marker step 0 reads. Then DELETE each row with an `object.purge` audit row, EXCEPT a listed invoice: its listing is append-only and RESTRICT, so it stays a tombstone, no longer loose and never served.

**When R2 fails or a binding is missing.** The row stays tombstoned with its key and the step throws. Next tick step 0 takes it again, until R2 succeeds.

**Tests** (`object-sweep.test.ts`, 10):
- an old pending row: row and bytes gone, audit `[reserve, sweep, bytes_deleted, purge]`;
- left untouched: a young reservation, an active unlisted object, and rows a payout or the identity names;
- a listed pending invoice becomes a tombstone (bytes gone, listing kept, not retried);
- uploaded invoices: the 30-day stale one is tombstoned; a fresh one and one a void payout names are not; the loose set is exactly the fresh one;
- a refusing R2 fails twice, then the retry purges the row;
- the bound, retries included;
- an empty run; the step wiring; the foreign-key walk; the holder columns.

**Mutation checks.** Removing the payout guard, the identity guard, the listed exclusion (round 0), a holder entry, the payout holder or the retry query (round 1) each makes a test fail.

## 6. Where the brief was wrong, or where I went further

1. **Sweep vs "never a row referenced by affiliate_invoice_objects".** Taken literally, no pending affiliate invoice could ever be swept: every invoice reservation is listed in its own reserve batch. The 5-loose cap would then fill up permanently, which is the defect CX-B7 and design §6.2 give this sweep to solve. The listing cannot be deleted (append-only and RESTRICT), so I neither delete those rows nor leave them alone: I tombstone them and delete their bytes. Invoices a payout references are never touched, and a payout can only name an ACTIVE object. **Reviewer: confirm, or tell me to leave listed rows fully untouched.**
2. **`KEYS_THE_API_DOES_NOT_NAME` loses `affiliate`; it does not gain it.** That list forces the add-ons the API never names to `false`. The API now names `affiliate` in every features answer (`readTenantFeatures` lists every `FEATURE_KEYS`), so the platform shop detail shows its real value.
3. **The modal's path** is `src/components/platform/ProvisionShopModal.jsx`.
4. **The smoke script's path** is `cloudflare/scripts/stg-affiliate-smoke.sh`, beside the scripts it is modelled on.
5. **`docs/legal-template-files/03-integritetspolicy.md` was edited.** The templates are "VERBATIM from docs/legal-template-files/", and `scripts/check-legal-pod-gating.mjs` says a wording change goes there FIRST. No other builder touches this file.
6. **The declined payout's subject** keeps the reason out of the subject (the reason can be 500 characters) and puts it in the body. Design §9 has "Begäran avvisad: orsak".
7. **The smoke adds an adjustment.** The accrual is held 14 days (A8), so on day 0 nothing is payable. The smoke therefore adds a +1000 öre adjustment before the affiliate's request; the request takes "the whole payable" and the smoke checks that amount. It also voids a request left open by an earlier failed run. Both actions name the smoke in their reason.
8. **The seed now runs wrangler**, for exactly one statement and only with `--affiliate`. The header says so. The token never leaves the process; the command line carries only its hash.

## 7. How to run the seed and the smoke on staging

**Prerequisites:**

- The CP13 Worker (A1 + A4) is deployed, with migrations 0058 and 0059 applied (`/ready` on 0059).
- The web Worker is deployed with the CP13 allowlist.
- `wrangler` is logged in to the staging account. The seed needs it for its one D1 INSERT; the smoke needs it for its read-only mail-ledger query.
- Run from the repository root.

**The slice tenant.** One tenant holds the API host. Find its id:

```
cd cloudflare && npx wrangler d1 execute chopshop-stg --env staging --remote --command "SELECT tenant_id FROM tenant_domains WHERE hostname = 'chopshop-api-stg.kent-ee2.workers.dev'" && cd ..
```

Then set the environment:

```
export SLICE=<the tenant_id printed above>
export CHOPSHOP_API_URL=https://chopshop-api-stg.kent-ee2.workers.dev
export CHOPSHOP_PLATFORM_EMAIL=micke.ohlen@gmail.com
export CHOPSHOP_PLATFORM_PASSWORD="$(grep '^PLATFORM_ADMIN_PASSWORD=' ~/.config/chopshop/secrets.staging.env | cut -d= -f2-)"
export STRIPE_SECRET_KEY=<sk_test_… of the pinned sandbox acct_1Tp7gtKAaBMOW5AC>
export CHOPSHOP_SLICE_ADMIN_PASSWORD=<the slice tenant admin's password, ≥ 12 chars>
export CHOPSHOP_AFFILIATE_PASSWORD=<a new password for Anna, ≥ 12 chars; store it in secrets.staging.env>
```

**1. Seed, once per slice tenant** (re-running reuses everything):

```
node scripts/cf-port/seed-staging-slice.mjs --tenant "$SLICE" --affiliate
```

It does the following, printing the ids and full URLs as it goes:

- switches the add-on ON;
- creates Anna Affiliate, `anna-affiliate+$SLICE@example.com`, code ANNA10;
- sets her password and checks it with a sign-in and `/v1/affiliate/me` 200;
- creates one pending application from Sara Sökande, `sara-applicant+$SLICE@example.com`.

At the end it prints the ref link `https://chopshop-web-stg.kent-ee2.workers.dev/$SLICE/?ref=ANNA10` and the portal `https://chopshop-admin-stg.kent-ee2.workers.dev/affiliate`. The portal's pages are A3's.

**2. Smoke:**

```
bash cloudflare/scripts/stg-affiliate-smoke.sh --tenant "$SLICE"
```

It runs the steps in this order:

1. preflight
2. platform sign-in and acting-as
3. Anna's sign-in
4. apply on the web Worker
5. approve with code `SMK<run>`
6. a `?ref=ANNA10` landing (the click count moves)
7. `seed --purchase --ref-code ANNA10`
8. the order's affiliate member: code, `link`, commission > 0
9. the accrual in the ledger, equal to the commission
10. `seed --refund <order>:<half>`
11. the reversal, about −½ of the commission, and the order's commission after the refund
12. the +10 kr adjustment
13. as Anna: accept the terms, fill in the profile, check that no blockers remain, request the payout (the whole payable)
14. as the admin: mark it paid
15. the payout row in the ledger
16. the `email_deliveries` rows since the run started, printed

It fails if any of `affiliate_application_received`, `affiliate_conversion`, `affiliate_reversal` or `affiliate_payout` is missing. The two shop-facing kinds appear only when the shop has a support address. It exits non-zero on the first mismatch.

## 8. What was NOT done

- **Nothing was run against staging** (no network). The seed and the smoke are syntax-checked only, and their JSON expressions were dry-run against sample answers. Whatever I could not verify live is named in their failure messages. In particular:
  - the `wrangler --json` output shape;
  - whether Better Auth accepts an ISO `expiresAt` in a row inserted by hand (its SQLite adapter stores dates as ISO strings, which I read in `@better-auth/kysely-adapter`).
- **The legal read** of the terms and the privacy sentence is Mikael's.
- **The sweep takes `pending` rows only.** It does not:
  - remove the bytes left behind when `deleteAdminObject`'s own R2 delete failed (its comment calls them "garbage for the sweep"; that is a different set of rows);
  - sweep active invoices that no payout uses (they still count toward the 5-cap, as A1 built it).
- **No `[[IF affiliate]]` condition** on the privacy sentence (see §4).

## 9. Gate (rule 19), on the final tree

Run from `cloudflare/`:

```
npx tsc --noEmit             → exit 0 (also -p web → 0, -p admin → 0)
npx vitest run               → Test Files  1 failed | 152 passed (153)
                               Tests  1 failed | 5364 passed (5365)
```

The one failure is `web-routing.test.ts > reserves exactly the non-shop first segments of src/config/tenancy.js`. It comes from A3's in-progress edit of `src/config/tenancy.js`, which adds `'affiliate'`; its mirror in `cloudflare/web/src/shop-segment.ts` is not updated yet. Neither file is mine. Every suite of mine passes, including all affiliate-* suites and object-sweep.

Run from the repository root:

```
node --test src/admin-app/**/*.test.mjs        → tests 843, pass 843, fail 0
npx vite build --config vite.admin.config.js   → ✓ built (exit 0)
node cloudflare/admin/check-admin-build.mjs    → admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable.
node guard/guards.test.mjs                     → guard: FAIL
bash -n cloudflare/scripts/stg-affiliate-smoke.sh   → OK
node --check scripts/cf-port/seed-staging-slice.mjs → OK
```

**The guard failure is not mine.** It reports "(b) 5 stale guard/allowlist.txt entries": A2's `AdminAffiliate{Analytics,Create,Edit,Payout,s}.jsx` no longer match a pattern, and the allowlist only shrinks. `guard/*` is reviewer-only. The guard scans tracked files only, so I grepped all of my changed and new files for its two name patterns: no match.

Not part of the gate: `node scripts/check-legal-pod-gating.mjs` reports the INTENDED integritetspolicy change against `origin/main` (4 POD flag combinations, that paragraph only). Invariant 1 (non-POD shops clean) holds.

## 10. Reviewer wiring

- **`wrangler.jsonc`, `env.d.ts`, `vitest.config.ts`:** no change. The sweep uses the existing `DB`, `PRIVATE_BUCKET` and `PUBLIC_BUCKET` bindings and the existing 15-minute cron.
- **`REQUIRED_MIGRATION`** stays `0059_affiliate.sql`. Only its seeded sha changed. **Before you commit, check that 0059 has been applied nowhere;** if it has, the terms need a new version instead (§3).
- **The A1 report** (§3) still names the old hash `ee41588c…`; the current one is `bff6a137…` (round 1). That file is not mine.
- **Guard:** it passes on the round-1 tree (the allowlist was already shrunk). Re-run it once my new files are tracked.
- **`scripts/check-legal-pod-gating.mjs`:** after the commit, re-baseline with `--ref=<that commit>`.
- **Sweep and listed invoices:** confirm the tombstone rule (§6.1).

## Round 1 fixes (adversarial review; verdict "mergeable with fixes")

Working tree only, my files only. 0059 has been applied nowhere, so the version stays `2026-10-22` and the sha is re-seeded.

**MUST**
1. **Terms name no figure** (`terms.ts`, 0059):
   - §3, §4 and §11 are reworded as the reviewer gave them. §4 adds "en ändring gäller köp som görs efter ändringen"; §11 no longer says the shop changes the terms.
   - The rates moved to a closing informational line ("Information (inte en del av villkoren): …"). The merge fields and the routes' rendering are kept.
   - **New sha `bff6a1379f0ee0ddfb10d8d14879ae8ca5c0b801c8a10fe475a4b435550fc2b3`** is in 0059.
   - New `test/affiliate-terms.test.ts` checks: no `%` or rate merge field in any of the 11 clauses; the MFL sentence verbatim; rates appear only in the information line; the literal sha.

**SHOULD**

2. **Genitive** (`affiliate-emails.ts` `swedishGenitive`, now exported): trimmed; colon genitive for a final digit, a non-letter or an all-caps last word; s/x/z unchanged; otherwise + s. Tested with "Kent", "Lars", "Fritz", "Meteor PR AB", "IKEA", "Shop24", "Kaffe & Co.", "Åsas Ö" and a blank name.
3. **Stockholm day** (`stockholmDay`, `Intl.DateTimeFormat` with `Europe/Stockholm`). Tested on both sides of the CET/CEST offsets, and on a rendered conversion mail at 23:15Z.
4. **Sweep** (§5 is rewritten to the new rules):
   - (a) An active listed invoice that no payout (not even a void one) names is tombstoned after 30 days unchanged.
   - (b) A failed byte delete is retried every tick. The marker is the `object.bytes_deleted` audit row; a row is never treated as purged without it.
   - (c) A `pragma_foreign_key_list` walk over every table, plus a check of the holder columns. `OBJECT_ID_HOLDERS` and `INVOICE_LISTING` are exported, and the guard SQL is built from them.
5. **Privacy sentence** (§4 is rewritten):
   - (a) The wording is now exact: the code is in the visitor's own browser with the cart; landings are counted per affiliate and day, not tied to the visitor; a hashed (pseudonymised) IP is kept at most seven days. The limiter's cleanup keeps rows up to 7 days, not only the 10-minute window.
   - (b) **Left ungated.** The reasons are in §4: the flag would have to reach every renderer call, the server records only `pod`, and nothing prompts re-adoption when the add-on is switched on later.
   - The BESLUT box now carries the LEK 9 kap. 28 § consent question.
   - `scripts/check-legal-pod-gating.mjs` still reports only the intended integritetspolicy change (4 POD combinations).
6. **Smoke: a matured accrual without the trick, where possible** (`stg-affiliate-smoke.sh`):
   - Before the payout, the smoke pages through the whole ledger. It checks that the portal's `heldMinor` equals the commission (accrual + reversals, per order) of the orders still inside their 14 days, which proves the hold.
   - If an accrual has matured (from a run 14+ days old) and something is payable, it requests the payout WITHOUT an adjustment. Only otherwise does it add the +10 kr adjustment, now labelled as the fallback.
   - Moving today's accrual's `available_at` into the past with `wrangler d1 execute` is impossible: `affiliate_ledger` is append-only (0059's no-update trigger). Disarming a money trigger, even on staging, is not something a smoke should do, so I did not.

**Also:** my report named the guard's literal patterns, which would have failed the guard once the report was committed. That line is rephrased.

**Gate (round 1, final tree)**

Run from `cloudflare/`:

```
npx tsc --noEmit                    → exit 0 (-p web → 0, -p admin → 0)
npx vitest run                      → Test Files  154 passed (154)
                                      Tests  5378 passed (5378)
```

Run from the repository root:

```
node --test src/admin-app/**/*.test.mjs        → tests 853, pass 853, fail 0
node guard/guards.test.mjs                     → guard: 2776 tracked files scanned, 289 match a pattern … guard: PASS
npx vite build --config vite.admin.config.js   → exit 0
node cloudflare/admin/check-admin-build.mjs    → admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable.
bash -n cloudflare/scripts/stg-affiliate-smoke.sh   → OK
node --check scripts/cf-port/seed-staging-slice.mjs → OK
```

My untracked files (`object-sweep.ts` and its test, `affiliate-terms.test.ts`, the smoke, this report) were grepped by hand for the guard's two name patterns: no match.

## Round 2 (from A1's Codex round 4, finding 5)

**The gap.** A late invoice upload can lose the race with the sweep: the sweep tombstones the row and deletes its key, then the upload writes its bytes. The upload deletes those bytes itself (`object-routes.ts` `releaseLateInvoiceBytes`). When THAT delete fails, it writes an `object.bytes_orphaned` audit row with ids only. The sweep's retry never revisited such a tombstone, because the row already carried its `object.bytes_deleted` marker.

**The change** (`cloudflare/src/storage/object-sweep.ts`, only that file, its test and this report):

- **Retry selection (step 0).** A deleted, non-immutable row is now also taken when its newest `object.bytes_orphaned` row is LATER than its newest `object.bytes_deleted` row (`ORPHAN_NEWER_SQL`).
  - "Later" is `(created_at, rowid)`: `audit_events` is append-only (0001), so within one millisecond the higher rowid was written later.
  - The orphan case does not need an `object.sweep` row.
  - Retries still come first and count within the 100 per tick.
- **Step 2 is unchanged:** the key is deleted again.
- **Step 3:**
  - It writes a FRESH `object.bytes_deleted` row when the row has none OR an orphan row is newer.
  - That row is stamped `MAX(now, the newest orphan's created_at)`, so an orphan stamped by a clock ahead of the sweep's is still cleared by it; equal stamps fall to rowid.
  - The purge rule is unchanged: an unlisted row is deleted, a listed invoice stays as a tombstone.
- **Out of scope.** An orphan row whose stored row is already gone (purged) cannot be revisited: the key is not recoverable from ids alone. On the invoice route every row is listed and is never purged, so this does not arise there.

**Tests** (`object-sweep.test.ts`, 10 → 15):
- A listed invoice tombstone whose bytes came back: retried, key deleted, a second `bytes_deleted` row, row kept, and not taken on the next tick.
- An unlisted tombstone with orphaned bytes, the orphan written in the SAME millisecond as the marker but after it: retried and purged.
- An orphan already cleared by a later `bytes_deleted` row: not re-selected (retried 0, one marker).
- An orphan stamped 60 s ahead of the sweep's clock: cleared by one retry, then left alone.
- The bound: 103 orphan retries take two ticks, 100 then 3, and a due new row waits until there is room.

**Mutation checks.** Each of these makes at least one test fail:
- the orphan clause dropped from the selection (4 tests fail);
- dropped from the marker condition (5);
- the marker's `MAX` stamp removed (2);
- the rowid tie-break removed (1).

**Gate (round 2)**

Run from `cloudflare/`:

```
npx tsc --noEmit                                                       → exit 0
npx vitest run test/object-sweep.test.ts test/affiliate-invoice-race.test.ts
                                                                       → Test Files  2 passed (2)
                                                                         Tests  19 passed (19)
npx vitest run                                                         → Test Files  155 passed (155)
                                                                         Tests  5397 passed (5397)
```
