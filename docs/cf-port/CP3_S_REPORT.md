# CP3-S report — migration scripts (bundle → plan, verify, restore)

Builder: CP3-S. Branch `cf-port`, working tree only (nothing committed, nothing pushed). `$CF` = `cloudflare/`. All new files live under `scripts/cf-port/migrate/`; this report is the only file outside that directory.

## 1. What was built

| File | Purpose |
|---|---|
| `scripts/cf-port/migrate/import.mjs` | Bundle → plan. Reads an export bundle and the optional map/state files, writes `plan.sql` + `plan.json` + `apply.md` into `--out` (outside the repo). Never talks to D1/Cloudflare/Stripe/Google/Firebase. |
| `scripts/cf-port/migrate/verify.mjs` | Result → PASS/FAIL list against a human-produced `--actual-state` JSON file. `--print-queries` prints the read-only queries that produce that file. |
| `scripts/cf-port/migrate/restore-archive.mjs` | Manifest §(c) "Restore" steps 1, 2, 4 for the D1 target only, as a plan generator reusing the SAME transform functions `import.mjs` uses, one named collection at a time. Refuses an unsupported collection or the Firestore target with a message naming the reason. |
| `scripts/cf-port/migrate/lib/sql.mjs` | The one function every SQL literal goes through (`sqlLiteral`), `sqlIdent` for the few camelCase Better Auth columns, `insertStatement`/`updateStatement` builders, and `scanForbiddenStatements` (hard rule 7). |
| `scripts/cf-port/migrate/lib/scrub.mjs` | The three staging scrub rules: email (S3), Connect account id, and Firebase Storage URL removal/scan. |
| `scripts/cf-port/migrate/lib/ids.mjs` | Deterministic id generation (`deterministicUserId`, the only "new + map" kind in CP3). |
| `scripts/cf-port/migrate/lib/plan.mjs` | Assembles `plan.sql`'s text: the `import_runs` bracket, one `import_row_hashes` statement per carried row, the plan sha. |
| `scripts/cf-port/migrate/lib/bundle-reader.mjs` | Read-only bundle reader: decodes the typed JSON back into plain JS documents, for `import.mjs` and `restore-archive.mjs`. |
| `scripts/cf-port/migrate/lib/screening-normalize.mjs` | A JS port of `cloudflare/src/catalog/screening-core.ts`'s pure term-normalisation functions (`foldText`, `tokenize`, `termMatch`, `normalizeScreeningTerm`), pinned against the live Worker source by a test. |
| `scripts/cf-port/migrate/lib/transform-shops.mjs` | Row 56: `shops` → `tenants` + `tenant_domains` + `tenant_settings` + `tenant_features`. |
| `scripts/cf-port/migrate/lib/transform-users.mjs` | Row 62: `users` (joined to the Auth export) → Better Auth `user`/`account` + `identity_access` + `tenant_memberships` + `legacy_id_map`. |
| `scripts/cf-port/migrate/lib/transform-printers.mjs` | Rows 45 + 46: `printerCatalog` + `printers` (snapwear only) → `printers` + `printer_sku_tiers` + `printer_catalog`. |
| `scripts/cf-port/migrate/lib/transform-print-defaults.mjs` | Row 69: `settings/printRouting` → `print_defaults.default_printer_id` only. |
| `scripts/cf-port/migrate/lib/transform-pod-profiles.mjs` | Row 70: `settings/podProfiles` → `pod_profiles`. |
| `scripts/cf-port/migrate/lib/transform-screening.mjs` | Row 72: `settings/contentScreening` → `content_screening_terms` + the two `platform_settings` scalars + the terms-version bump. |
| `scripts/cf-port/migrate/lib/transform-platform-settings.mjs` | Row 67 (+ 68 assertion): `settings/platform` → `platform_settings` defaults; `settings/app` asserted absent. |
| `scripts/cf-port/migrate/lib/transform-legal-acceptances.mjs` | Row 65: the shop legal-acceptances subcollection → `legal_acceptances`. |
| `scripts/cf-port/migrate/lib/transform-audit-logs.mjs` | Row 12: `auditLogs` → `audit_events`. |
| `scripts/cf-port/migrate/test/*.test.mjs` | 172 new tests (see §5). |
| `scripts/cf-port/migrate/test/fixtures.mjs` | Builds an invented fixture bundle through the export tool's own `runExport` + its `FakeFirestore`/`FakeAuth`, so the bundle format is exactly right without touching the real export. |

No file under `scripts/cf-port/migrate/export.mjs`, `scripts/cf-port/migrate/lib/{typed-json,bundle-writer,manifest-fates,verify-bundle}.mjs`, or their tests was edited.

## 2. How to run each tool

All three tools are plain Node scripts (`node scripts/cf-port/migrate/<tool>.mjs ...`), no build step, no dependency beyond the standard library.

### `import.mjs`

```
node scripts/cf-port/migrate/import.mjs --env staging --bundle <bundle dir> --out <out dir>
     [--email-map <file>] [--scrub-unmapped] [--connect-map <file>] [--target-state <file>]
```

- `--bundle` and `--out` are resolved to absolute paths; `--out` is refused if it resolves inside the repo (symlinks resolved, same discipline as `export.mjs`'s `assertOutsideRepo` — reimplemented byte-for-byte rather than imported, so `import.mjs` has no load-time dependency on `export.mjs`'s module side effects).
- `--email-map` is a JSON object `{ "real@address": "test@address" }`. Every email the plan would write (user emails, `tenants.support_email`, emails embedded inside `storeIdentity`, legal-acceptance emails) goes through it. An address not in the map REFUSES the whole run unless `--scrub-unmapped` is given, in which case it becomes `scrubbed+<12 hex>@example.com`.
- `--connect-map` is a JSON object `{ "acct_live_...": "acct_sandbox_..." }`. On staging a mapped live account id is replaced; an unmapped one is dropped to `NULL` with every charge/payout/details flag forced to 0. Production carries the live id verbatim.
- `--target-state` is an optional JSON file (see `apply.md`'s own §2 for the read-only queries that produce it). Without it the importer assumes an empty target and says so loudly in `plan.json`'s `reportLines`.
- Writes `plan.sql`, `plan.json`, `apply.md` into `--out`, directory mode 0700, files 0600.
- Exit code 1 and nothing written when refused; the problems are printed to stderr/stdout.

### `verify.mjs`

```
node scripts/cf-port/migrate/verify.mjs --env staging --bundle <bundle dir> --plan <plan dir> --actual-state <file>
node scripts/cf-port/migrate/verify.mjs --print-queries
```

- `--actual-state` is a JSON file a human produces after the apply, from the read-only queries `--print-queries` prints.
- Prints each CP3-owned §(e) item (1, 2, 3, 4, 6, 7, 10, 14, 15, 17) as `[PASS]`/`[FAIL]` with the two values compared, and every other item as `[DEFERRED]` with a one-line reason. Exit code 0 only when nothing fails.

### `restore-archive.mjs`

```
node scripts/cf-port/migrate/restore-archive.mjs --bundle <bundle dir> --collection <name>
     --env <staging|production> --out <out dir> [--email-map <file>] [--scrub-unmapped] [--connect-map <file>]
```

- `--collection` must be one of `auditLogs`, `printerCatalog`, `printers`, `shops`, `shops__legalAcceptances`, `users` (`SUPPORTED_COLLECTIONS`) — every other collection is refused with a message naming that it has no transformation yet and pointing at the manifest/decisions for which checkpoint owns it.
- `--target firestore` (step 3, rollback before deletion) is refused outright: this checkpoint only ever writes a D1-bound `plan.sql`.
- Writes `plan.sql` + `plan.json` the same way `import.mjs` does, reusing the exact same transform module per collection.

## 3. The transformation table (source field → target column)

### Row 56 — `shops` → `tenants` / `tenant_domains` / `tenant_settings` / `tenant_features`

| Source | Target | Notes |
|---|---|---|
| doc id | `tenants.tenant_id` | preserved verbatim |
| `status` | `tenants.status` | `active`→`active`, `disabled`→`suspended` (D59); anything else → `provisioning` |
| `published` | `tenants.published` | verbatim (D57) |
| `storeIdentity.shopName` \|\| `name` | `tenants.shop_name` | |
| `storeIdentity.supportEmail` | `tenants.support_email` | through `--email-map`; empty string → NULL |
| `createdAt` (Timestamp or ISO string) | `tenants.created_at` | ISO |
| `updatedAt` (mixed shape: Timestamp OR ISO string, manifest note) | `tenants.updated_at` | ISO, clamped forward to `created_at` if the source value would violate `updated_at >= created_at` (found by the sqlite-execution test — see §7) |
| `payments.connectEnabled` | `tenants.connect_enabled` | |
| `payments.stripeAccountId` + flags | `tenants.stripe_*` | resolved by the caller through `resolveConnectFacts` (D20/S3) BEFORE this module sees them; when the resolved account id is NULL, `stripe_requirements_due_json`/`stripe_disabled_reason`/`payout_delay_days` are forced NULL too (0038's own-account-required triggers) |
| — | `tenant_domains` | one placeholder row per shop: `<tenantId>.import.invalid`, kind `storefront`, status `pending` (D7b) |
| `storeIdentity` (whole object) | `tenant_settings.store_identity_json` | minus `REFUSED_STORE_IDENTITY_KEYS`/`REFUSED_LEGAL_KEYS` (pinned against `cloudflare/src/platform/tenant-config.ts` by a test), minus the four branding URL keys when they point at a Firebase Storage host (removed, reported), every email-shaped string inside it scrubbed |
| `storeIdentity.returnAddress` | `tenant_settings.return_address` | empty string → NULL |
| `storeIdentity.vatRegistered` | `tenant_settings.vat_registered` | true→1, false→0, else NULL |
| `storeIdentity.vatNumber` | `tenant_settings.vat_number` | empty string → NULL |
| `storeIdentity.sellerType` | `tenant_settings.seller_type` | `'individual'`/`'company'` only, else NULL |
| `features.<key>` | `tenant_features` | effective value per key (D22): opt-in keys (`pod`, `contentStudio`, `marketingMaterials`) default OFF, the rest default ON. An explicit row is written whenever the effective value differs from the default, PLUS `pod` is ALWAYS written explicitly regardless (see §6 open question 1) |

`robowatz` (D21) is filtered before this module ever sees it.

### Row 62 — `users` (+ Auth) → Better Auth `user`/`account` + `identity_access` + `tenant_memberships` + `legacy_id_map`

| Source | Target | Notes |
|---|---|---|
| Auth `email` (wins over the doc's `email`, D11) | `user.email` | through `--email-map` |
| `contactPerson` \|\| Auth `displayName` \|\| email local part | `user.name` | |
| Auth `emailVerified` | `user.emailVerified` | |
| Auth `metadata.creationTime` \|\| doc `createdAt` | `user.createdAt` | |
| — | `user.image` | always NULL |
| — | `account.providerId` | always `'credential'` |
| — | `account.password` | ALWAYS NULL (no password is ever written) |
| doc uid | `legacy_id_map.legacy_id` | kind `'user'` |
| `deterministicUserId(env, uid)` (or the D59-adopted existing id) | `legacy_id_map.new_id` | deterministic: same (env, uid) → same id on every run |
| `role`/`platform`/`shopId` | `identity_access.account_type` | `admin`+`platform===true`+no `shopId` → `platform_admin`; `admin`+`platform!==true`+`shopId` set → `tenant_admin`; `print_shop` → **not carried (D12)**; anything else → not carried |
| `active`/`isActive`/Auth `disabled` | `identity_access.status` | any of the three false/true-as-disabled → `suspended` |
| (tenant_admin only) `shopId` | `tenant_memberships` | role `admin`, same status as `identity_access` |

An Auth user with no matching `users/` document is counted, never carried (counts only, no names, per the terminal-output hard rule). A mismatch between the Auth email and the doc's email is counted and reported (Auth wins, D11).

### Rows 45 + 46 — `printerCatalog` + `printers` → `printers` + `printer_sku_tiers` + `printer_catalog`

Only `snapwear` (D12); the two uid-keyed legacy printer tiers are archived, not imported (their ids could not satisfy `0023`'s `id NOT GLOB '*[^a-z0-9-]*'` CHECK anyway, and D12 rules them out regardless).

| Source | Target | Notes |
|---|---|---|
| `printers/snapwear` | `printers` row, id `'snapwear'` | staging → `status='inactive'` (D59), production → `'active'` |
| `printAreasMm[garment][slot]` + `provisionalAreas` | `printers.capabilities_json` | one synthetic model per garment (`garment_<name>`), one SKU entry per catalogue SKU whose `garment` field resolves to a modelled garment |
| `printerCatalog/snapwear.skus[sku].garment` + `pricing.blankCostSek[garment]` | `printer_sku_tiers.blank_cost_minor` | kr × 100 = öre, exact-integer checked; a SKU whose garment has no cost entry is DROPPED and reported, never invented |
| `pricing.printCostSek[front\|back\|pocket]` | `printer_sku_tiers.print_costs_json` | same kr → öre conversion, per slot |
| `printerCatalog/snapwear` (models + skus only) | `printer_catalog.catalog_json` | `content_sha256` = sha256 of the exact stored JSON bytes |
| `printerCatalog/snapwear.pricingBasis` | `printer_catalog.pricing_basis_json` | carried verbatim, never interpreted |

### Row 69 — `settings/printRouting` → `print_defaults.default_printer_id`

Staging always writes NULL (D66), even when the source names snapwear. Production writes the source's `defaultPrinterUid` only when it equals `'snapwear'` (the only platform printer this importer ever creates); anything else is refused with a report line, never invented.

### Row 70 — `settings/podProfiles` → `pod_profiles`

One row per profile (`id`, `label`, `min_dpi`, `print_area_mm.{w,h}`, `max_file_mb`, `accepted_formats`). A profile id already present in `--target-state`'s `podProfiles` map is reported field-by-field as a diff and never overwritten (the staging seed may already hold one).

### Row 72 — `settings/contentScreening` → `content_screening_terms` + `platform_settings`

Each `blocklist[].term` is normalised through `lib/screening-normalize.mjs` (a JS port of `screening-core.ts`, pinned by a test against the live source), exactly as the Worker's own matcher would see it. Two source terms normalising to the same matcher key keep the first, drop the rest (matching `findScreeningHits`'s own de-dupe). `reviewFirstProducts` and `hardBlock` are written into `platform_settings.review_first_products`/`screening_hard_block`, and `screening_terms_version` is bumped by exactly one via a self-referencing `UPDATE ... SET screening_terms_version = screening_terms_version + 1` (satisfies `platform_settings_terms_version_forward`).

### Row 67 (+ 68) — `settings/platform` (+ `settings/app`)

The document is documented absent in production; this module IGNORES its content even if a bundle happens to carry one (reported, not trusted) and always writes the pinned defaults: `default_commission_bps = 500`, `reverse_dispute_on_created = 1`. `refund_application_fee` is NEVER named in the generated `UPDATE`'s `SET` list — the column's own `DEFAULT 0 CHECK (= 0)` in migration 0034 is what pins it; the brief's "never touch it" is honoured by omission, not by writing `0` explicitly. `settings/app` is asserted absent; a present doc is reported as a problem, nothing is imported for it either way.

### Row 65 — the shop legal-acceptances subcollection → `legal_acceptances`

| Source | Target |
|---|---|
| `type` | `type` (`'legalPages'`/`'platformTerms'`) |
| path's shopId segment | `tenant_id` |
| `uid` | `legacy_uid` (verbatim, always) + `user_id` (mapped via the users pass's `legacy_id_map`, or NULL when the uid was not carried) |
| `email` | `email`, through `--email-map` |
| `acceptedAt` (Timestamp) | `accepted_at` (ISO) |
| `acceptedAtIso` | `accepted_at_original` (verbatim) |
| `templateVersion` | `template_version` |
| `pod` | `is_pod` |
| `custom` (boolean or per-page map) | `is_custom` + `custom_json` |
| `texts` | `texts_json` (canonical form, IDENTICAL algorithm to `cloudflare/src/legal/legal-pages.ts`'s `canonicalJson` — literally imports `scripts/cf-port/migrate/lib/typed-json.mjs`'s `canonicalStringify`, so the two can never drift) + `texts_sha256` |
| `userAgent` | `user_agent`, truncated to 2048 chars |
| — | `source = 'import'` (fixed) |

A row with no `uid` at all is skipped and reported (0037 requires `legacy_uid IS NOT NULL` for `source = 'import'`).

### Row 12 — `auditLogs` → `audit_events`

| Source | Target |
|---|---|
| doc id | `event_id` (preserved verbatim) |
| `shopId` | `tenant_id` |
| `action` | `action` |
| `actorUid`/`uid` | `actor_user_id` (mapped via `legacy_id_map`) or, when unmapped, kept in `metadata_json.legacyActorUid` with `actor_user_id` NULL (this table has no `*_legacy_uid` sibling column, unlike `legal_acceptances`, so this is the closest equivalent to the manifest §a precedent) |
| `targetId`/`resourceId` | `resource_id` |
| — | `resource_type = 'legacy_import'` (the source has no separate field; the manifest names none) |
| `reason` | `reason` |
| `createdAt`/`at` | `created_at` (INTEGER milliseconds, per 0001's schema — NOT the ISO-text convention the newer tables use) |

## 4. Idempotency (C5) and the plan bracket

Every carried row's statement is paired with an `INSERT OR IGNORE INTO import_row_hashes (table_name, row_pk, content_sha, run_id)` statement, where `content_sha` is `sha256(JSON.stringify({table, columns, values-in-fixed-order}))`. 0033's own trigger (`import_row_hashes_same_content`) is what actually enforces "same id, same content → no-op; same id, different content → abort" — this importer's contribution is simply computing that hash consistently and always emitting the row-hash statement right after the data statement, in the SAME plan.

The plan opens with a plain `INSERT INTO import_runs (...) VALUES (..., 'running', ...)` (NOT `OR IGNORE` — deliberately: a run's identity must stay visible, never silently repeated, per 0033's own header) and closes with `UPDATE import_runs SET status = 'completed', finished_at = ?, counts_json = ? WHERE run_id = ?`.

**A re-run of the exact same generated `plan.sql` file therefore refuses on its own FIRST statement** if the run already exists (0033: "an import run starts running, once, one at a time"). This is confirmed by a real test against `node:sqlite` (§7). `apply.md` documents the correct recovery: skip re-applying that one leading `INSERT INTO import_runs` line and apply everything after it — every data statement and the completion `UPDATE` are then safe to replay verbatim.

A re-run of `import.mjs` against the SAME bundle and the SAME options (a fresh, independent invocation, not literally the same file) produces a byte-identical `plan.sql` (proven by a determinism test with a fixed clock) carrying a DIFFERENT `run_id` (because the wall clock, or an injected `now`, differs) — that plan's own leading INSERT succeeds (new run_id), and every DATA row it carries is `INSERT OR IGNORE` against content that is either identical (no-op) or new.

## 5. Test output (exact)

```
node --test "scripts/cf-port/migrate/test/*.test.mjs"
...
1..248
# tests 248
# suites 0
# pass 248
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Of the 248: 76 are the pre-existing, unmodified export-tool tests (all still pass, confirmed by running them alone: `# tests 76 / # pass 76 / # fail 0`); 172 are new, across 18 new test files.

`node --check` on every `.mjs` file under `scripts/cf-port/migrate/` (including `test/`): all pass, zero syntax errors.

`node guard/guards.test.mjs`:
```
guard: 1877 tracked files scanned, 314 match a pattern
guard: allowlist size = 313, permanent exemptions = 1
guard: baseline = 313
guard: PASS
```

`git status --short`: 34 lines, every one a new, untracked file under `scripts/cf-port/migrate/` (the 33 code/test files plus this report is committed separately outside `git status`'s scan since it is a new file too, listed as the 35th line together with the others — nothing modified, nothing deleted, nothing outside the two allowed paths).

`node:sqlite` is available on this machine (Node v22.14.0) without any `--experimental-sqlite` flag (only a runtime `ExperimentalWarning` prints; `node -e "require('node:sqlite')"` succeeds). All four `sqlite-execute.test.mjs` tests ran for real, not skipped:
- every one of the 37 files in `cloudflare/migrations/` applies cleanly, in name order, to a fresh `node:sqlite` database;
- a generated plan executes against that database and produces the expected tenant/user/printer rows;
- the plan re-applied after a simulated interrupted-apply (everything except the run's own leading INSERT and completion UPDATE, replayed as apply.md's own recovery instructions describe) leaves every table's row counts unchanged;
- a plan built from a bundle where one shop's name changed throws `import row hash mismatch: same id, different content` when applied against a database that already holds the original plan.

No migration in `cloudflare/migrations/` failed to apply under `node:sqlite` — nothing had to be tested "by string and structure only" instead.

## 6. Deviations from the manifest/brief, and why

1. **`tenant_features.pod` is written explicitly for EVERY shop, not only ones with POD products or an explicit `features.pod === true`.** The brief's manifest row 56 says "An explicit `pod` row for every shop that has POD products or `features.pod === true`" — but CP3 cannot see products at all (they land in CP4, D53), so "has POD products" is unanswerable here. Writing `pod` explicitly for every shop (its effective value, whether that is true from the source or the opt-in default false) satisfies the D22/D62 "every POD shop needs an explicit pod row" invariant unconditionally rather than leaving a gap CP4 would have to notice and backfill. **Open question for CP4's products importer:** does a shop with POD products but no explicit `features.pod` flag in the source need special handling, or is this pre-emptive explicit row already sufficient?
2. **`updated_at` clamped forward to `created_at` on the `tenants` insert.** The bundle can legitimately carry a shop whose `updatedAt` (an ISO string, sometimes older than a `createdAt` this importer had to default to the run clock because the source lacked one) would violate `0001`'s `CHECK (updated_at >= created_at)`. Found by the `node:sqlite` execution test (§7), fixed by clamping the written value forward — never inventing a later time than what happened, only refusing to write an impossible one.
3. **Connect facts belonging to a shop with no carried Stripe account are forced fully NULL/0**, including `payout_delay_days`, even when the SOURCE document carried a payout delay for an account this import scrubbed away (staging, unmapped). `0038`'s own triggers require this (a fact without an account is refused), and it is the correct outcome regardless: a payout delay for an account that does not exist on this environment is meaningless.
4. **`audit_events.resource_type`** has no source equivalent (the manifest's table gives no separate field), so this importer writes the fixed literal `'legacy_import'`. **Open question:** should this instead branch on `action` (e.g. `'product'`/`'shop'`/`'user'`) to match whatever convention the Worker's own audit writers use for `resource_type` on new rows? I did not find that convention documented for CP3's scope and did not want to invent one without the reviewer's input.
5. **The `podProfiles` conflict check compares only the specific fields the brief calls out** (`label`, `min_dpi`, `print_area_w_mm`/`h_mm`, `max_file_mb`, `accepted_formats_json`) — not `sort_order`/`active`, which this importer does not attempt to derive meaningfully from the source doc's array position anyway.
6. **`restore-archive.mjs`'s `shops__legalAcceptances` path has no legacy_id_map input of its own.** A standalone restore of just that one collection (without also restoring `users` in the same invocation) has no way to resolve `uid` → mapped `user_id`; every restored row therefore carries `legacy_uid` only, `user_id` NULL (0037 explicitly permits this shape). This is reported in the plan's `reportLines`. A caller who wants mapped ids for a legal-acceptances-only restore must first import/restore `users` and pass a persisted map in — no such plumbing exists yet in this checkpoint; described here as a limitation, not fixed, since the brief scoped restore's map-building out ("no legacy_id_map input" was not called out one way or the other).

## 7. What the bundle lacks that the target needs

- **`printers/snapwear.pricing`** must carry a cost for every garment the printer's `printAreasMm` names, and **`printerCatalog/snapwear.skus[*].garment`** must resolve to one of those garments, for a SKU's tier to be derivable. Where either is missing this importer DROPS that SKU and reports it (never invents a price) — per the brief's "if the derivation needs a number the bundle does not contain, stop... do not invent a price." In practice, against a real production bundle, any such gap needs a human decision (fix the source doc, or accept the SKU is unpriced and therefore unmappable) before the affected SKU can be mapped by any product on Cloudflare.
- **`settings/printRouting.defaultPrinterUid`** naming anything other than `'snapwear'` cannot be imported on production (this importer never creates any other platform printer, D12) — reported, not silently dropped.
- **A user with no usable email** (neither the Auth record nor the `users` doc carries one) is not carried; reported via `carried:false, reason:'no usable email'`.

## 8. Open questions

1. §6 item 1 above: is the unconditional explicit `pod` row the right call, or should CP3 instead leave the gap for CP4 to close alongside products?
2. §6 item 4 above: what should `audit_events.resource_type` be for an imported legacy audit-log row?
3. **Deferred rows and CP4's dependency on `legacy_id_map`.** Rows 43/44/51 (podArtwork/podMappings/products, D53) will need the user id map this checkpoint builds (for `products.screening.clearedBy`/`takedown.by`, `podArtwork.createdBy`). Since `legacy_id_map` is a persistent, append-only D1 table (not a value this script hands back out-of-band), CP4's importer can read it directly from the target once CP3's users import has run — I did not build any hand-off file for this, since the table itself is exactly that hand-off mechanism. Confirming this is the intended design.
4. **Translations (D16).** This checkpoint deliberately writes NOTHING for rows 58–60 (they are deferred as "rebuilt as a static JSON asset, not a D1 import"). No script here builds that static asset; it was out of this brief's scope (the brief's row list for CP3 does not include a translations transform). Confirming that is a separate, not-yet-assigned piece of work.
5. **`--target-state`'s exact JSON shape is my own invention**, described in this report and in `apply.md`'s own step 2, since no prior builder's report or the brief itself pins one. A reviewer wiring this up for a real dry run should confirm the shape (`users.emailToId`, `users.activePlatformAdminCount`, `tenants.ids`, `hostnames`, `podProfiles`) is acceptable before relying on it, since nothing else in the codebase depends on it yet.
6. **The one-open-run-per-environment constraint (0033) means this importer's own tests cannot exercise "apply, then apply an updated bundle" as two independent `import.mjs` runs against the SAME already-populated database without a human manually closing the first run as `failed` in between** (confirmed directly: reactivating a completed run is refused by `import_runs_finished_immutable`, which is correct and by design). The `sqlite-execute.test.mjs` "changed bundle aborts on hash mismatch" test therefore applies the FIRST plan, then applies the SECOND (changed) plan's full text starting from ITS OWN fresh `import_runs` insert (a different run_id) — which is what a real second import attempt would do — rather than simulating a resumed single run. I believe this is the correct and only sensible reading of "changes when the bundle changes... aborts on the row hash" from the brief, but flag it because it is a design choice about what "two runs" means, not something the brief spelled out.

## 9. Not done / not fully verified

- **No real D1, Cloudflare, R2, Stripe, Google or Firebase call was ever made** (hard rule 1) — confirmed by inspection of every file (all imports are `node:*` builtins plus this checkpoint's own `lib/*` and the finished export tool's `lib/*`) and by the fact that every test runs against local fixtures / `node:sqlite` only.
- **The production export bundle was never read** (hard rule 4) — every fixture in every test is built with invented data (`Test Shop A`, `Test Admin One`, `@example.com`) through the export tool's own writer functions (`FakeFirestore`/`FakeAuth`/`runExport`), per the hard rule.
- **Real delivery / real Stripe accounts / real D1 application were never exercised** — `node:sqlite` stands in for D1 exactly as the brief anticipates; a genuine `wrangler d1 execute --remote` run against a live database is for the reviewer to perform, per `apply.md`.
- **The exact wording a reviewer will see when they run `import.mjs --env production`** against the real bundle is untested (no production bundle exists in this environment); every behavioural claim about production (D59's active `snapwear`, the real `default_printer_id`, live Connect ids) is exercised only through fixture data shaped to match those code paths, not through the real export.
- I did **not** attempt to build the translations static-JSON asset (row 58–60, D16) — see open question 4.

---

## 10. Review round 1 (Fable, 2026-09-27)

Round 0 was reviewed by reading every file. Six fixes were required and the state tool was added. The builder stopped partway; the reviewer finished the round, ran the importer **in memory against the real bundle** (statistics only, nothing written, every address and id left out of the output), and fixed what that run and the reading found. Sections 1–9 above describe round 0; where they differ from this section, this section is right.

### 10.1 The six required fixes

| # | Fix | State | Pinned by |
|---|---|---|---|
| 1 | Time columns were written as ISO text into tables that hold integer milliseconds. One mapping module, `lib/time-columns.mjs`; sources parsed once in `lib/timestamps.mjs`. | done | `time-columns.test.mjs` (the map against every migration); `sqlite-execute.test.mjs`: after the plan is executed, `typeof()` and the value shape of every mapped column, none passing for want of rows |
| 2 | A value with a line break made a statement of several lines, which the importer's own scan refuses. Every statement is one line; a control character is written as `char(N)` in a `\|\|` chain. | done | `sql.test.mjs` (10 values × 3 tests, stored value byte-identical); end to end in `import.test.mjs` and `sqlite-execute.test.mjs` |
| 3 | The plan was not deterministic from the command line. | **was not working**: `runImport` defaulted its clock to the wall clock, and every test passed a clock, so none saw it. The default is now "no clock": the bundle's `exportedAt`. | `import.test.mjs` and `restore-archive.test.mjs`, called as the CLI calls them |
| 4 | No address and no user id in the terminal output or `plan.json`. | done, plus three leaks found in review: the ids of the archived printers (they are user ids) were listed, a refused value was quoted by `sqlLiteral`, a bad email-map entry was named by its address | `import.test.mjs`, `scrub.test.mjs`, `sql.test.mjs`, `verify.test.mjs` (plan.json) |
| 5 | A scan of the whole plan for source addresses on staging. | done; the exception for the legal texts snapshot existed only where addresses are collected, so a shop whose legal text names its own support address would have refused every plan. The snapshot's literal is now left out of the scanned text. | `import.test.mjs` (both directions) |
| 6 | A membership for a shop that is not imported is skipped, the user is carried. | done; it had no test | `import.test.mjs` (archived shop, shop never exported, shop already in the target); `sqlite-execute.test.mjs` with foreign keys enforced |
| + | `state-from-queries.mjs` | done; it had no test | `state-from-queries.test.mjs` |

### 10.2 Found on the real bundle

| Finding | Effect before | Now |
|---|---|---|
| One shop's gallery holds Firebase Storage URLs (`gallery[].imageUrl`) | **the importer refused the real bundle** | every Firebase Storage URL of the identity is removed and reported by path (D73) |
| A shop's TikTok link (`https://…/@name.x`) has the shape the scrub took for an address | the link was replaced by `scrubbed+…@example.com` | an address holds no `/` and no `:` |
| The plan from the CLI carried the wall clock | two runs of the same bundle gave two plans and two plan shas | identical |

The run after the fixes: accepted, 864 statements, 286 KB, longest statement 47.7 KB (`printer_catalog`; D1's limit is 100 KB), at most 2 control characters in one value, identical on a second run. Rows: 4 shops (18 rows), 13 identity rows, 1 printer with 323 SKU tiers and its catalogue, 8 print profiles, 63 screening terms. The bundle holds **no** legal acceptance and **no** audit log, so those two transforms have run on invented data only.

### 10.3 Found by reading

| Finding | Now |
|---|---|
| `verify.mjs` item 4 compared the state file with a copy of itself (`expectedConnect` was built from the same query as the value) | compared with `plan.json` `expected.tenants` |
| item 7 ended in `\|\| true`; item 10 passed for any number | every term and every profile id of the plan must be in the target; into an empty target, no other term |
| item 14 expected 2 + 1 active identities on every environment; staging has its own users | active identities = before the import (`--target-state`) + carried by the plan; production must also equal the manifest's 2 + 1 |
| item 15 checked a count and the presence of a `pod` row | status, published and the `pod` value per tenant, against the plan; an unknown extra tenant fails |
| item 17 was a flag a person sets in the state file | `verify.mjs` verifies the bundle itself and refuses a plan built from another bundle |
| `verify.mjs --print-queries` and `state-from-queries.mjs` each had their own list of queries, already different | one list |
| On production the importer would have **refused every address** without a map, and with `--scrub-unmapped` would have written placeholder addresses for real users | production keeps every address and refuses both scrub options |
| `restore-archive.mjs` resolved no symbolic link before testing its output path, and ran none of the plan scans except the statement scan | one shared check (`lib/outside-repo.mjs`), one shared set of plan checks (`lib/plan-checks.mjs`) |
| A refusal inside a transform crashed `restore-archive.mjs` with a stack trace | a refusal, as in the importer |
| A statement over D1's limit of 100 000 bytes, or a value with more than 399 control characters (SQLite's expression depth), would have failed during the apply | refused when the plan is built |

### 10.4 New and changed files in this round

New: `lib/time-columns.mjs`, `lib/timestamps.mjs`, `lib/scan-source-addresses.mjs`, `lib/plan-checks.mjs`, `lib/outside-repo.mjs`, `state-from-queries.mjs`, `test/time-columns.test.mjs`, `test/timestamps.test.mjs`, `test/state-from-queries.test.mjs`. Rewritten: `verify.mjs`, `test/verify.test.mjs`. `plan.json` has a new block, `expected`, which `verify.mjs` requires.

### 10.5 Tests

```
node --test "scripts/cf-port/migrate/test/*.test.mjs"
# tests 339
# pass 339
# fail 0
# skipped 0
```

The write-call scan (`no-write-calls.test.mjs`) is unchanged and passes: the code that tripped it was changed, not the scan.

### 10.6 Still open

1. **Nothing here has touched D1.** The plan has been executed against `node:sqlite` with every migration applied, never against staging.
2. **`wrangler d1 execute --file` on a 286 KB file of 864 statements** is untried. If it is refused, the plan is applied in parts; every data statement can be repeated safely.
3. **Legal acceptances and audit logs**: no real document exists, so the first real one is the first real test.
4. **Production** (`--env production`) builds a plan from the fixture and from nothing else. P1–P7 of the manifest are not implemented; they belong to CP7.
5. **D73, D74**: on their recommended defaults until Mikael says otherwise.
6. `verify.mjs` checks ten of the nineteen items of manifest (e); the other nine are printed as DEFERRED with their checkpoint.

### 10.7 Rehearsal through the command line (2026-09-27, after `416b3bb1`)

The whole path was run as an operator will run it: five read-only queries on staging through the preflight, `state-from-queries.mjs`, `import.mjs --env staging --scrub-unmapped --target-state`, the plan written outside the repo, and the plan then executed against `node:sqlite` with every migration applied and a pre-state like staging's (its two tenants, its own `apparel_dtg`). Nothing was written to staging.

Result: 862 statements applied, none refused by a CHECK, a trigger or a foreign key. Two platform admins and one shop admin (melodie-mc), the manifest's figure. No address and no Storage host in `plan.sql` or `plan.json`. A second run gave the same bytes.

It found three more defects, fixed in the commit after `416b3bb1`:

| Finding | Effect before | Now |
|---|---|---|
| `published` was read as `=== true`. melodie-mc has **no** `published` field, which Firebase reads as published (`ShopGate.jsx`: only an explicit `false` hides) | melodie-mc would have been imported unpublished, its catalogue hidden | only an explicit `false` is unpublished |
| The shop's own commission (`payments.commissionBps`) was not carried and not reported. melodie-mc holds 5000 | the rate would have changed from 50 % to the default without a word | carried within the cap; above it, not carried, reported, and refused on production (D75) |
| The shop's VAT rate (`storeIdentity.vatRate`) was dropped with the refused keys | every shop got 25 % whatever its own rate (today all three that state one are at 25 %) | carried as basis points; a value that is not a whole number of basis points refuses the plan |

`verify.mjs` item 4 now also compares the commission and the VAT rate with the plan.

**Seen, not changed:** staging holds `apparel_dtg` at 250 × 350 mm with png/jpg, the export at 300 × 400 mm with png/jpg/tiff/webp (`docs/POD_PRINT_SPEC.md`: the largest area is the back, 300 × 400). The importer does not overwrite an existing profile and reports the difference. The staging row is the old one; it is corrected through `PUT /v1/platform/pod/profiles`, not by the import.

Tests: 343.

### 10.8 Codex on the script commits (2026-09-28)

Codex reviewed everything since `f0db7a72` as one range. Its first run, on 2026-09-27, was cut off by its own usage limit and gave no finding. Four findings, all real, none seen by the 346 tests of that moment:

| # | Finding | Fix |
|---|---|---|
| P1 | Suspension was `active === false`: a user whose flag was missing, null or not a boolean was imported ACTIVE. The manifest (§a) says `active !== true` or `isActive !== true` or Auth disabled. | Fail closed, and a user with no Auth record is suspended too. All six users of the real bundle hold both flags as `true`. |
| P1 | An address that exists in the target adopted that user, and `INSERT OR IGNORE` kept the target's identity row: an imported platform admin adopted onto a shop admin stayed a shop admin, while the plan, the report and the last-admin rule said platform admin. | The target state holds each user's account type and status (the users query joins `identity_access`). An adoption is refused unless both are equal to what the import carries, and when the target state does not name the user. No identity row is written for a user that has one. |
| P2 | A legal acceptance or an audit entry of a shop that is not imported pointed at a tenant that does not exist: the plan was accepted and the apply failed on the foreign key. | Such evidence is not carried, is counted in the report, and stays in the bundle with its shop. The real bundle holds none. |
| P2 | A restore plan opens with a row in `import_runs`, and production accepts one completed run (0033): every restore after the import would be refused by its first statement. | `restore-archive.mjs` refuses `--env production` and says why. Restores into production need bookkeeping of their own, which comes with the first archived collection that is restored. |

Tests: 352.

