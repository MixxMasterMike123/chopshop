# CP7-T2 — the import tools' production preconditions, the go-live verify, the production reconciliation

Offline tooling, 2026-10-04. Closes runbook blockers 8, 9, 10 and 11 (`CP7_RUNBOOK.md` §10), with what is still open in each. Nothing was run against a real host: every test and the rehearsal use the repository's fakes, scratch SQLite and invented evidence.

## What each fix does and refuses

### Blocker 11 — `state-from-queries.mjs` prints `--bootstrap` for production

- `--bootstrap` admits `whoami`, `d1`, `r2` and `queues` (`scripts/cf-preflight.sh:127-131`). It skips the launch gate (check 6) and the resource checks, but still runs checks 1–4: credentials file, pinned identity, the account wrangler sees, the configuration's account id. The preflight is unchanged.
- Production's printed commands are `scripts/cf-preflight.sh production --bootstrap -- d1 execute … --command="SELECT …"`. `import.mjs`'s `apply.md` uses the same form for the bookmark and the apply. Staging's commands are byte-identical to before.
- **Still open:** `import-catalogue.mjs` and `verify-catalogue.mjs` still print theirs without `--bootstrap`. They are outside this unit's brief. §5.6's workaround (add it by hand) stays.

### Blocker 10 — `verify.mjs`'s go-live items (production only)

- Staging is untouched: the same CP3 checks, and the same nine DEFERRED lines.
- `state-from-queries.mjs --print-queries actual --env production` adds the go-live queries. Each is one SELECT made of scalar subqueries (no compound SELECT, so D1's five-term limit does not apply):
  - `go_live_counts`: orders, payment events, checkouts, outbox, POD mappings and artwork, stored objects;
  - `go_live_legal`: the Worker's readiness facts for each tenant, plus the current terms acceptance;
  - `storage_texts_1..3`: every text column of all 74 tables. The columns come from the repository's migrations applied to an in-memory SQLite database (`lib/schema-text-columns.mjs`), never from D1.
- `--kind actual` reads these results into a `goLive` section that holds counts and booleans only. The return address is reduced to set or not set, using the Worker's JavaScript trim. If some but not all of the files are present, the tool refuses.

How each item is decided:

| Item | How it is decided now |
|---|---|
| 5 | DEFERRED: the endpoints and their API version live at Stripe. Manual: the preflight's `--bootstrap -- whoami` with the live key file, plus the Dashboard |
| 8 | PASS/FAIL: every mapping's artwork is in its own shop. DEFERRED: the garment and the quote (the Worker's 409 reasons), which apply only at POD-on |
| 9 | PASS/FAIL: every mapped artwork is `ready`, with print and preview keys and sha256. Presence in R2 is not read |
| 10 | adds: every artwork's profile resolves |
| 11 | PASS when melodie-mc meets all four conditions (return address, VAT answer, pages adopted, current terms accepted). Otherwise DEFERRED with what is missing: the manifest calls this expected until §6.6 |
| 12 | with `--catalogue-plan` and `--catalogue-actual-state`: `verify-catalogue.mjs`'s own `runChecks`, run in process. Without them, DEFERRED to the final run |
| 13 | PASS/FAIL: no text column names the source's storage, every table was scanned, and every stored object is active with its sha256. DEFERRED: the public host's 200 and 404 checks |
| 16 | PASS/FAIL: the three locale files built in memory from the bundle equal `src/locales/` byte for byte (`build-locales.mjs` `buildLocaleTexts`, split out of `buildLocales` with no change in behaviour) |
| 18 | PASS/FAIL: orders, payment_events, checkouts, outbox_events are all 0 |
| 19 | `--final` only: `LAUNCH_TODO.md` read with the preflight's own `LAUNCH_REQUIRED` (parsed from the script) and its table rule (`lib/launch-gate.mjs`). A test runs the preflight's Python helper on the same inputs and requires the same verdict |

- `--final` is refused on staging, and refused without the catalogue inputs. A catalogue plan that is not of kind `catalogue`, not of this environment or not of this bundle is refused.
- A missing `goLive` section FAILs every item that needs it.

### Blocker 9 — `import.mjs` production preconditions (`lib/production-evidence.mjs`)

| | Option | Refused when |
|---|---|---|
| P1 | `--confirm production` (`confirmationProblem`, asked first and alone), `--expect-tenants <n>` | the confirmation is missing; n is missing or not a positive integer; the plan writes another number of tenants (named) |
| — | the pinned `stripeAccountId` | it is null: the Stripe evidence has nothing to match, so production refuses today |
| P3 | `--freeze-evidence <file>` | a time is not ISO; a step is after `frozenAt`; the bundle was exported before `frozenAt`; a carried or mixed collection's `maxUpdateTimeSeen` is after `frozenAt` |
| P3 | `--rescan-bundle <dir>` (the second export of §5.2) | missing; the bundle itself; does not verify; another schema; not exported after the bundle; any carried, mixed or verify-only collection differs (parts sha256 and count, or the `_verify` file) or exists in only one export; an Auth user differs other than by `lastSignInTime`. An archive collection that differs is **reported** (names only), not refused |
| P4 | `--payments-evidence <file>` | read before `checkoutsStoppedAt`; another platform account; a state missing; any PaymentIntent listed (named by state and id); a pending printer notification, or a count that is not a count; a source checkout in the bundle that is not `completed`/`failed`/`skipped` and not listed in `terminalCheckouts` |
| P5 | `--connect-evidence <file>` | read before the export; another platform account; an account without its three booleans; a shop whose account is not in the file. **The plan writes the file's `chargesEnabled`/`payoutsEnabled`/`detailsSubmitted`.** Each difference from the source is a report line. The live flags are part of the run-id fingerprint |
| staging | — | `--confirm` and any of the four evidence options (staging never reads live facts, S3). `--expect-tenants` is optional and checked when given. A staging plan of the real bundle is byte-identical to the one HEAD's `import.mjs` builds (same sha, same run id) |

`--commission-default-for` and everything else work as before. `lib/scrub.mjs` still carries the source's flags. In production the evidence replaces them before `transformShop`.

### Blocker 8 — `reconcile-staging.mjs --env production` (in place)

- It is refactored into `parseArgs`, `reconcileTarget`, `runReconcile` and `readOnlyRequest`, with `main` behind an `isMain` guard. Staging's flow, output, rules and exit codes are unchanged:
  - what staging writes: the sign-in session and the acting-as grant (with its audit row);
  - its rules: the pinned staging origin, a `sk_|rk_test_` key (a live key refused), credentials from the environment, refusal exit 1, "no orders" exit 2.
- Production writes nothing:
  - every API request goes through `readOnlyRequest`, which refuses any method but GET, and any shop context or bearer token, before sending. The only non-GET request is the sign-in, inside `createApiSession`;
  - no acting-as grant is opened, so the seller's order page is not read. Its figures are taken from the platform's order view (the same columns);
  - every Stripe call is a GET.
- Production refuses, each with its own sentence (exit 2):
  - a missing `--confirm production`, or `--confirm` on staging;
  - a null pinned `origins.api`, or a `CHOPSHOP_API_URL` that is not the pin;
  - a missing `--tenant`;
  - `FAKE_PRINTER_TOKEN`;
  - a null pinned `stripeAccountId`;
  - `STRIPE_SECRET_KEY` in the environment;
  - a missing `~/.config/chopshop/stripe.production.env`, a file others can read, the staging file under the production name, a file without `STRIPE_SECRET_KEY`, or a key that is not `sk_|rk_live_`;
  - credentials only from `productionCredentials` (never the staging file);
  - after the first request: a Stripe account that is not the pinned one, or a `/health` that does not say production.

## The evidence files

The formats are in the header of `lib/production-evidence.mjs` and in runbook §4.10 / §5.4, together with the read-only commands that produce them:

- `freeze-evidence.json`: `{evidence:"freeze", frozenAt, checkoutsStoppedAt, schedulesPausedAt, webhookDisabledAt, editsStoppedAt}`. `frozenAt` is the moment the freeze was **complete**, not the §4.3 time: the hidden toggle is itself a write to `shops`. §5.2's old "earlier than the §4.3 time" is corrected to that.
- `open-payments.json`: `{evidence:"open-payments", readAt, platformAccountId, openPaymentIntents:{5 states:[ids]}, printNotificationsPending, terminalCheckouts:[]}`.
- `connect-facts.json`: `{evidence:"connect-facts", readAt, platformAccountId, accounts:{acct_…:{chargesEnabled, payoutsEnabled, detailsSubmitted}}}`.

## What stays manual, and why

- **The facts inside the evidence.** The freeze times, the `printNotifications` count (a dropped collection, so it is not in the bundle) and each Stripe read come from the runbook's commands. The tool proves they agree with the bundle, the pins and each other, not that they are true.
- **verify 5, the quote half of 8, the HTTP half of 13.** These need Stripe, the Worker or HTTP, which this unit may not touch. 11 needs Kent (§6.6). 19 FAILs until the launch gate is done or narrowed (blocker 1).
- **The production reconciliation has never run against a real host.** It also refuses today: `stripeAccountId` is null, the API has no address (blocker 2), and there is no live key file.

## Tests

- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`: **554 pass, 0 fail** (481 before; 73 new).
- New test files: `import-production.test.mjs` (33), `verify-go-live.test.mjs` (12), `go-live-queries.test.mjs` (6: the queries run as written on the migrated schema, using node:sqlite), `launch-gate.test.mjs` (2), `reconcile.test.mjs` (20). The helper is `production-fixtures.mjs`.
- Signature changes only:
  - the three production tests of `import.test.mjs`, the production platform plans of `import-catalogue.test.mjs` and `import-run-kinds.test.mjs` now pass the evidence;
  - `catalogue-fixtures.mjs` `buildCatalogueBundle` takes `exportedAt`;
  - `fake-staging-api.mjs` answers the three platform list reads.
- `node guard/guards.test.mjs`: PASS.
- **Mutation checks: 59 guards, each broken alone and run against its test file. All 59 were caught** (`~/chopshop-export/rehearsal-cp7t2-2026-10-04/mutate.py`, outside the repository; it restores each file after its run). The 59:
  - P1 (confirmation, `--expect-tenants` required, the count), the null pin;
  - P3 (step after `frozenAt`, export before the freeze, `maxUpdateTimeSeen`; re-scan required, is the bundle, not later, does not verify, carried difference, Auth difference);
  - P4 (required, read before the stop, account, states, open PaymentIntent, notifications, checkouts);
  - P5 (required, read before the export, account, booleans, missing account, the live flags written), staging's evidence refusal;
  - verify #8, #9, #10, #11, #12, #13 (hits, not scanned, objects), #16, #18, #19, the missing section, `--final` on staging, `--final` without the catalogue, catalogue kind;
  - the incomplete go-live set, the JavaScript trim, the `--bootstrap` prefix, the launch rule;
  - reconcile: GET only, no shop context or token, environment key, staging file, file mode, file missing, live key, `--tenant`, fake printer token, null account pin, `/health`, account mismatch, production credentials.

## The rehearsal (offline, production mode)

Everything is in `~/chopshop-export/rehearsal-cp7t2-2026-10-04/`: the driver `rehearse-cp7t2.mjs`, with `run.txt` and `logs/` beside it.

- **Bundle:** `export-2026-09-27T15-02-15.414Z`.
- **Target:** a fresh `scratch.sqlite` with every migration (50: `0001` … `0052`).
- The production plans are built in process with injected pins (`stripeAccountId acct_rehearsal_platform`; the fake API's origin). The real pinned file is never edited.
- The evidence is invented. The re-scan bundle is a byte copy of the bundle with a later `exportedAt` and SHA256SUMS rebuilt: no export was run.

| Step | Result |
|---|---|
| CLIs on the real pins, empty HOME | `import.mjs` without `--confirm`: exit 1, the confirmation sentence. With `--confirm --expect-tenants 4` and no evidence: exit 1, refused because `stripeAccountId` is null and the four evidence options are missing. `verify.mjs --env staging --final`: exit 1, refused. `--final` without the catalogue: exit 1, refused. `reconcile-staging.mjs --env production`: exit 2 without `--confirm`; exit 2 with it, because `stripeAccountId` is null |
| `--print-queries actual --env production` | 14 commands, all `production --bootstrap -- d1 execute chopshop-prod … "SELECT …"` |
| `import.mjs` production, P1/P3/P4/P5 met | ok; 864 statements; 287 109 bytes; plan sha `7b348b473dd4…`; 4 tenants. Report lines: re-scan equals the bundle; Connect flags of 2 accounts from the live read |
| Apply, then `verify.mjs --env production` | **23 PASS, 0 FAIL, 6 DEFERRED** (5, 8 quote, 11 not ready, 12 and 19 to the final run, 13 HTTP) |
| Copy (fake API) and catalogue | 524 entries copied; 4 888 statements; `verify-catalogue.mjs` 41 PASS, 0 FAIL |
| `verify.mjs --env production --final` | **24 PASS, 1 FAIL, 4 DEFERRED**. #12 41 checks passing; #13 0 rows in 74 tables, 524 objects active with sha256; #16 three files equal (read 1365/1364/1365); #18 all 0. **FAIL #19**: A5, A6, A7, B1–B10 open (true today). DEFERRED #5, #8, #11, #13 |
| Refused on the real bundle | `--expect-tenants 5`; the real null pin; a freeze completed after the export; a freeze before the last carried write (printerCatalog, printers); the bundle as its own re-scan; a re-scan with a shop written (`shops`); an open PaymentIntent (`requires_action 1`); Connect facts read before the export; melodie-mc's account missing. A flipped `payoutsEnabled` is written, with the report line `true → false` |
| `reconcile-staging.mjs --env production` (fake API, fake Stripe; one refunded order) | exit 0, `BALANCED — 1 order(s), Δ 0 öre`. 6 API requests, the only non-GET the sign-in; 0 acting-as grants, 0 audit rows; 6 Stripe calls, all GET |
| Local times | migrations 0.4 s · CP3 plan 0.1 s · apply 0.4 s · verify 0.5 s · copy 1.2 s · catalogue plan 0.3 s · apply 2.9 s · final verify 0.4 s |
