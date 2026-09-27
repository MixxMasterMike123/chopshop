# CP3-X report — Firebase export tool

Builder: CP3-X. Branch `cf-port`. Wrote the READ-ONLY export tool that turns
production Firestore + Firebase Auth into a checksummed local bundle, per
`docs/cf-port/MIGRATION_MANIFEST.md` §(c)/(d). **This tool was never run
against the real Firebase project** — only against in-memory fakes in
`node --test`. A reviewer runs it for real.

**Status: post-review-round-1.** A first review found 9 required fixes plus 4
answers owed on open questions; all are done. See "Review round 1" below for
the mapping of each fix to its file and test. Everything in the body of this
report has been corrected to reflect the CURRENT code, not the pre-review
version.

## Files created

```
scripts/cf-port/migrate/export.mjs                        — the CLI entry point
scripts/cf-port/migrate/lib/typed-json.mjs                 — encode/decode/canonicalStringify
scripts/cf-port/migrate/lib/manifest-fates.mjs              — the fate table as data
scripts/cf-port/migrate/lib/bundle-writer.mjs               — part rotation, sha256, SHA256SUMS, file modes
scripts/cf-port/migrate/lib/verify-bundle.mjs                — bundle verifier (library + CLI)
scripts/cf-port/migrate/test/fake-firestore.mjs              — in-memory Firestore/Auth fakes (test helper, not a test file itself)
scripts/cf-port/migrate/test/typed-json.test.mjs
scripts/cf-port/migrate/test/bundle-writer.test.mjs
scripts/cf-port/migrate/test/manifest-fates.test.mjs
scripts/cf-port/migrate/test/verify-bundle.test.mjs
scripts/cf-port/migrate/test/export.test.mjs
scripts/cf-port/migrate/test/no-write-calls.test.mjs
docs/cf-port/CP3_X_REPORT.md                                 — this file
```

No other files touched. `git status --short` shows only `?? scripts/cf-port/migrate/` (the report file is new too, but is listed separately below since it's outside that directory).

## How to run

### Tests (no Firebase needed)

```
cd scripts/cf-port/migrate && node --test
# or, from the repo root:
node --test "scripts/cf-port/migrate/test/*.test.mjs"
```

Note: plain `node --test scripts/cf-port/migrate/test` (directory, no
trailing slash, no glob) errors with `MODULE_NOT_FOUND` on this machine's
Node (v22.14.0) — it seems to treat the bare directory argument as a module
specifier rather than a test-file directory in this version/invocation
context. Both forms above (cd into the directory and run bare `node --test`,
which auto-discovers `test/*.test.mjs`; or an explicit glob from the repo
root) work and were used to produce the summary below. This is worth the
reviewer's attention — if CI expects the exact form
`node --test scripts/cf-port/migrate/test/`, verify it against the CI
container's Node version; it may behave differently.

### Dry run (safe, no writes, no Firebase auth needed... but DOES need it)

Correction: even the dry run calls `listCollections()`, `count().get()`, and
`auth.listUsers()`, so it DOES need ADC and network access to the named
Firestore database — it just never writes anything. To dry-run for real:

```
node scripts/cf-port/migrate/export.mjs
# add --only to scope it while checking behaviour, e.g.:
node scripts/cf-port/migrate/export.mjs --only shops,products
```

This prints every collection found, its document count, and its manifest
fate (carry / archive / drop / verify-only / unknown), plus a WARNINGS block
for anything not in the manifest. It writes nothing regardless of `--out`.

### Real export (writes the bundle)

```
node scripts/cf-port/migrate/export.mjs --apply
# or with an explicit --out:
node scripts/cf-port/migrate/export.mjs --out ~/chopshop-export --apply
```

Default `--out` is `~/chopshop-export/`; the bundle lands in
`<out>/export-<exportedAtISO-with-colons-as-dashes>/`. The tool refuses if
the resolved `--out` is inside the repo, and refuses if the target bundle
directory already exists (both are enforced in code and covered by tests).

### Verify a bundle afterwards

```
node scripts/cf-port/migrate/lib/verify-bundle.mjs <bundle dir>
```

Prints PASS/FAIL per check and exits 0/1.

## Test summary (actual run, pasted verbatim — post review round 1)

```
$ node --test "scripts/cf-port/migrate/test/*.test.mjs"
...
1..72
# tests 72
# suites 0
# pass 72
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Breakdown by file (all green): `typed-json.test.mjs` 19, `bundle-writer.test.mjs`
6, `manifest-fates.test.mjs` 6, `verify-bundle.test.mjs` 10, `export.test.mjs`
29, `no-write-calls.test.mjs` 2 (19+6+6+10+29+2 = 72).

`node --check` passes on every `.mjs` file in `scripts/cf-port/migrate/`
(verified with a loop over `find scripts/cf-port/migrate -name "*.mjs"`).

`node guard/guards.test.mjs` prints `guard: PASS` (1808 files scanned, 314
match a pattern, allowlist/baseline both 313 — unchanged, since
`scripts/cf-port/` is excluded from the guard by
`guard/guards.test.mjs:42`).

`git status --short` shows only:
```
?? scripts/cf-port/migrate/
```
(plus this report file, which lives outside that directory at
`docs/cf-port/CP3_X_REPORT.md` as instructed).

## What the tool does (per the manifest, post review round 1)

- Walks every top-level collection from `listCollections()`. For each
  non-drop collection, it discovers EVERY subcollection actually present
  under every parent doc id (including phantom parents with no field data of
  their own — the 7 phantom `users` parents in prod), via `docRef.listCollections()`,
  not just the two the manifest names. Discovery goes 2 levels deep
  (`MAX_SUBCOLLECTION_DEPTH`); a subcollection found at a 3rd level is never
  read, only NAMED in a loud warning so a human decides. Runs with bounded
  concurrency (`SUBCOLLECTION_DISCOVERY_CONCURRENCY = 16`, a hand-rolled
  limiter, no dependency) so a large tree doesn't serialize into an hour.
  Tested in `export.test.mjs`: phantom-parent discovery, an unknown
  subcollection under a known collection, an unknown subcollection under a
  phantom parent, a 2nd-level subcollection, a 3rd-level warning-only case,
  and the concurrency limiter's own correctness.
- Looks up each collection's (and each discovered subcollection's) fate in
  `lib/manifest-fates.mjs`. `drop` collections (`adminPresence`,
  `emailVerifications`, `passwordResets`, `rateLimits`, `printNotifications`)
  are counted via `count().get()` only — `get()` is never called on them,
  asserted against the fake's call log in `export.test.mjs`.
- **Dry run reads counts only, never document data** (`count().get()` for
  every top-level collection AND every discovered subcollection, at every
  depth) — nothing is pulled into memory unless `--apply` is given. Tested:
  a full dry run's call log contains zero `get()` calls, and dry-run counts
  (including subcollection counts) match what a real `--apply` would write.
- `productsPublic` and `printersPublic` get fate `verify-only` (recorded that
  way in `manifest-fates.mjs`, with a comment explaining the manifest calls
  them "drop" in the 75-row table but the brief additionally asks that these
  two specifically land in `_verify/<collection>.jsonl`). The
  `manifest-fates.test.mjs` drift check treats `verify-only` as equivalent to
  the manifest's "drop" so the two files don't fight each other.
- `settings` is walked as one collection; each document's fate comes from
  `SETTINGS_DOC_FATES` (rows 67-75) and is recorded in that collection's
  `manifest.json` under `perDocumentFate`.
- An unknown collection (not in the manifest) is still exported (fate
  `unknown`) and listed in the root manifest's `warnings` array. Same for an
  unknown settings doc id or unknown subcollection.
- A manifest-named collection that isn't present at all is reported in the
  dry-run plan as `0 (absent)` and given no directory.
- **Typed encoding is gated on being a class instance, not shape.**
  `lib/typed-json.mjs`'s `encode()` only treats a value as Timestamp/GeoPoint/
  DocumentReference/Bytes if `Object.getPrototypeOf(value)` is neither
  `Object.prototype` nor `null` (i.e. a real class instance) — a plain map
  that happens to carry `latitude`/`longitude`, `path`/`firestore`, or
  `seconds`/`nanoseconds` keys is written through unchanged, keys and all. A
  class instance matching none of the four known shapes makes `encode()`
  throw `UnknownFirestoreTypeError` naming the constructor (never field
  contents); `bundleDocFromSnapshot()` in `export.mjs` catches that and adds
  the document PATH to the message before re-throwing, so a failure is
  traceable without leaking data. `decode()` reconstructs `ts`/`ref`/`geo` as
  class instances (`DecodedTimestamp`/`DecodedDocumentReference`/`DecodedGeoPoint`)
  so a decoded value re-encodes to byte-identical output. Plus the `esc`
  escape for a source object that itself already has a `__t` key (recursive,
  tested at 2 levels of nesting).
- Every doc line and every collection manifest use
  `canonicalStringify` (recursively sorted object keys), and documents are
  sorted by `path` before writing, so two exports of the same data in
  different insertion order produce byte-identical `SHA256SUMS` (tested at
  both the bundle-writer level and the full `export.mjs` level).
- Parts rotate at a byte limit (default 64 MB, injectable via `maxPartBytes`
  threaded through `runExport`, though the CLI itself doesn't expose a flag
  for it — see Deviations).
- Auth users are exported through an ALLOWLIST (`pickAuthUserFields`): only
  `uid`, `email`, `emailVerified`, `disabled`, `displayName`,
  `metadata.creationTime`, `metadata.lastSignInTime`,
  `providerData[].providerId`. Tested with a fake user carrying
  `passwordHash`, `passwordSalt`, `tokensValidAfterTime`, `customClaims`,
  `phoneNumber`, `photoURL` — none of those appear in the output line.
- **Live re-count against the database** after the bundle is written: every
  written top-level collection and subcollection family is re-counted with a
  fresh `count().get()` and compared with the number of lines written.
  Recorded per collection in the root manifest as `{ name, written, recount,
  match }` under `recounts`; a mismatch is ALSO pushed into
  `consistencyWarnings` (loud, never a crash — the database may legitimately
  change during a staging export). `maxUpdateTimeSeen` is still recorded per
  collection for the importer's P3 pre-check. Tested: a collection that gains
  a document between the read and the re-count produces a named mismatch
  warning; an unchanged collection matches with no warning.
- **Project pinned explicitly.** `admin.initializeApp({ projectId: PROJECT_ID })`
  (not a bare `initializeApp()` that lets ADC decide), and `main()` refuses to
  run — before ever importing `firebase-admin` — if `GOOGLE_CLOUD_PROJECT` is
  set in the environment to anything other than the pinned project id.
  Tested via a real subprocess spawn asserting the refusal message and that
  it never gets as far as mentioning `firebase-admin`.
- **Refusals happen before any database work.** An existing bundle directory
  is refused at the very top of `runExport()`, before `listCollections()` is
  even called (previously this was checked only right before writing, after
  the entire read had already happened). Tested with a call-log assertion
  that ZERO database calls occur before the refusal. `--out` resolution
  additionally resolves symlinks (`fs.realpathSync` on the nearest existing
  ancestor) before comparing against the repo root, so a symlink pointing
  into the repo is refused even though its literal path string doesn't
  mention the repo. Tested with both a symlink-into-the-repo case (refused)
  and a genuinely external symlink case (allowed), plus a full subprocess CLI
  test for the plain (non-symlink) repo-inside case.
- Terminal output is counts, collection names, and paths only — no document
  contents, emails, or uids are ever printed (checked by eye across every
  `info()`/`console.log` call in `export.mjs`; there is no automated test for
  this specific property).
- Storage/GCS is entirely out of scope — the script never imports or calls
  anything storage-related.
- The root manifest records `notIncluded` with one line each for
  `_maps/user-id-map.json` and `_storage/storage-manifest.jsonl`, explaining
  they belong to the importer and the storage tool respectively, and neither
  file (nor its directory) is written by this script. Tested.

## Deviations from the brief / manifest, and why

Deviations 1, 2 and 4 from the pre-review version of this report are now
RESOLVED by review round 1 (subprocess test for `--out` added; live re-count
added; the two bundle-root files are now an explicitly answered design
decision, not an open gap — see "Review round 1" below). What remains:

1. **No CLI flag for `maxPartBytes`.** The brief says "make the limit
   injectable so a test can use a tiny limit" — `runExport()` accepts
   `maxPartBytes` as a parameter and `writeParts()` accepts it as an option,
   and tests use it directly (`bundle-writer.test.mjs`). There is no
   `--max-part-bytes` CLI flag because the brief's CLI signature
   (`[--out <dir>] [--apply] [--only <collection>[,<collection>…]]`) doesn't
   list one and 64 MB is the specified default; I judged adding an
   unrequested flag was scope creep. If a reviewer wants to test part
   rotation against the REAL bundle with a tiny limit, they'd need to call
   `runExport` directly rather than through the CLI, or I can add the flag on
   request.

2. **Root manifest's warnings vs. the brief's phrase "clearly marked warning
   block."** I implemented this as a JSON array (`warnings`) inside
   `manifest.json`, plus a human-readable console block during the run
   (`step('WARNINGS — ...')`). I did not additionally write a separate
   `WARNINGS.md`/`.txt` file — the brief didn't specify a file format for
   this beyond "listed in a clearly marked warning block at the end," and I
   read "at the end" as the end of the root manifest / the end of the
   printed run, both of which I have. The 3rd-level-subcollection warnings
   from fix 4 use the same `warnings` array.

3. **Retention (`retainUntil`) fiscal-year assumption.** The brief: "orders,
   orderProduction, checkouts: 7 full calendar years after the end of the
   export's fiscal year." I assumed the fiscal year equals the CALENDAR year
   the export runs in (Dec 31 of that year is "the end of the fiscal year"),
   since nothing in the manifest or decisions states a non-calendar fiscal
   year for these tenants. `retainUntilFor()` in `export.mjs` computes
   `Dec 31 of (export year + 7)`. **Review round 1 answer 3: accepted for
   now** — the accountant confirms before the production export; the
   assumption is stated in both the code comment and here.

4. **`manifest-fates.test.mjs`'s markdown table parser is intentionally
   narrow.** It only extracts `#`, the first inline-code span in the
   "Collection / doc" column, and the first `carry`/`archive`/`drop` keyword
   match in the "Fate" column. It does not parse Target/Id strategy/etc. This
   was sufficient to catch drift on collection name, row number, and fate
   (the three things `manifest-fates.mjs` actually encodes), which is what
   the brief's test #12 asks for ("the fate table has exactly the
   collections and fates the manifest lists"). A future manifest edit that
   changes a fate's WORD ORDER in a cell in an unusual way (e.g. "archive,
   then carry" prose) could theoretically confuse the single-keyword match,
   but I didn't find any such cell in the current table.

5. **`export.mjs`'s pagination (`readAllDocuments`) is written for
   correctness against the real Admin SDK's `orderBy(FieldPath.documentId())
   .startAfter(...).limit(...)` pattern, but is only exercised against the
   fake in tests, never against a real large (>500 doc) Firestore
   collection.** The fake's paging logic mirrors what I believe
   firebase-admin 11.11.1 does, but I have not run this against production
   scale data (the census in the manifest shows nothing above 1,365 docs, so
   even a single unpaged `.get()` would likely have worked — but the brief
   asks for paged reads, which I built).

6. **The live re-count (fix 3) for a 2-level-deep subcollection family is
   best-effort, not exhaustive.** For a 1-level family (the common case —
   both manifest-known families are 1-level), the re-count re-derives
   `(parentCollection, subName)` from the flattened name and sums
   `count().get()` over every current parent ref. For a 2-level family found
   only by fix 4's discovery (not manifest-known), the re-count code only
   handles the `parts.length === 2` (1-level) case explicitly; a 2-level
   flattened name (`a__b__c`) is recorded in `recounts` with `recount: null,
   match: null` rather than a real re-count, because re-deriving the exact
   set of level-2 parent refs to re-query is materially more expensive (it
   requires re-running discovery) and I judged it out of proportion to the
   brief's ask, which frames fix 3 as being about "each exported top-level
   collection" and "each exported subcollection family" without singling out
   multi-level discovered families. Flagged as an open question below.

## Things I could not verify (no Firebase access, by design)

- That `getFirestore(DATABASE_NAME) (the named production database, see export.mjs)` combined with ADC actually behaves
  identically to what `readAllDocuments()` assumes for a REAL
  `CollectionReference`/`Query` (method names, `snapshot.docs`, `doc.id`,
  `doc.data()`, `doc.createTime`/`updateTime` as Timestamp-like objects with
  `.toDate()`) — I copied the shapes from `backfill-pod-mapping-garment.mjs`
  and firebase-admin 11.11.1's public API surface as I understand it, but the
  very first real dry run is the actual test of this assumption.
  - Note `functions/node_modules/firebase-admin/package.json` confirms
    version `11.11.1` is present, consistent with the manifest's
    "firebase-admin 11.11.1" reference in §0.
- That `auth.listUsers(1000, pageToken)` paging terminates correctly against
  a real project (only 6 Auth users exist in prod per the census, so this
  would never even trigger a second page in production — but I built it to
  page anyway per the brief).
- That the real `doc.createTime`/`doc.updateTime` on a firebase-admin
  `DocumentSnapshot` are objects with `.toDate()` (I assumed yes, matching
  `Timestamp`); if they're plain strings/numbers in this SDK version instead,
  `bundleDocFromSnapshot()`'s branch that checks
  `typeof doc.createTime.toDate === 'function'` falls back to using the raw
  value, so it should degrade gracefully either way, but this is untested
  against the real SDK.
- Actual runtime and memory behaviour exporting all ~1,862 real documents
  (small by any measure) plus Storage-adjacent fields — expected to be fast
  and low-memory, but not measured.

## Open questions for the reviewer

1. Is the fiscal-year-equals-calendar-year assumption for `retainUntil`
   correct? I found nothing in `DECISIONS.md` addressing this directly.
   (Review round 1 answer 3: accepted for now, pending the accountant.)
2. Deviation 6 above: should the live re-count (fix 3) be extended to handle
   a 2-level-deep discovered subcollection family exhaustively (currently
   `recount: null, match: null` for those), given fix 4 means such families
   are now a real, expected possibility rather than a hypothetical?
3. `MAX_SUBCOLLECTION_DEPTH` is a constant (`2`) in `export.mjs`. If a real
   export ever finds something 3 levels deep, the tool will warn and refuse
   to export it (by design, per the brief), which means the CP3 export would
   need a code change to go deeper if that turns out to be necessary. Worth
   confirming 2 levels is enough for every collection in the manifest before
   the real freeze export (I did not find anything nested that deep in the
   manifest's census, but the manifest's census itself was taken with
   `listCollections()`/counts, not a full recursive walk).
4. `SUBCOLLECTION_DISCOVERY_CONCURRENCY = 16` is a guess at a reasonable
   bound, not measured against the real Firestore Admin SDK's own connection
   pooling/quota behaviour. If 16 concurrent `listCollections()`/`count()`
   calls turns out to be too aggressive (or too conservative) against the
   real project, this is a one-line change.

## Review round 1

A first review found 9 required fixes and asked 4 open-question answers
before this tool may run against production. All are done. Mapping:

| # | Fix | File(s) | Test(s) |
|---|---|---|---|
| 1 | Duck typing on shape alone misclassified a plain map (e.g. `{latitude, longitude, label}`) as a Firestore type. Detection is now gated on `isClassInstance()` — `Object.getPrototypeOf(value)` must be neither `Object.prototype` nor `null` — BEFORE any shape check runs. | `lib/typed-json.mjs` (`isPlainObject`, `isClassInstance`, `looksLikeTimestamp`/`looksLikeDocumentReference`/`looksLikeGeoPoint`/`looksLikeBytes` all gated on it) | `test/typed-json.test.mjs`: "fix 1: a plain map with latitude, longitude AND a third key survives unchanged…", "…path + firestore keys…", "…seconds/nanoseconds but no toDate…" (3 tests) |
| 2 | A class instance matching none of the four known shapes must fail loudly (naming the constructor, never field contents) instead of being silently flattened into a plain map. `decode()` reconstructs `ts`/`ref`/`geo` as class instances so a decode→re-encode round-trip is byte-identical under the new class-instance gate. | `lib/typed-json.mjs` (`UnknownFirestoreTypeError`, `DecodedTimestamp`/`DecodedDocumentReference`/`DecodedGeoPoint`); `export.mjs`'s `bundleDocFromSnapshot()` catches the throw and adds the document PATH (never data) to the message | `test/typed-json.test.mjs`: "fix 2: a class instance matching none of the known Firestore shapes throws, naming the constructor", "fix 2: decoded ts/ref/geo are class instances that re-encode to identical bytes"; `test/fake-firestore.mjs` gained `FakeUnknownFirestoreType` for this |
| 3 | The consistency check compared two numbers derived from the SAME in-memory list, so it could never fail. Added a genuine live re-count: after the bundle is written, every top-level collection and (1-level) subcollection family is re-counted with a fresh `count().get()` and compared against the number of lines written; recorded per collection as `{name, written, recount, match}` under the root manifest's `recounts`, with a mismatch also pushed into `consistencyWarnings` (loud, not a crash). | `export.mjs` (the "live re-count against the database" block in `runExport()`, using `countDocuments()`) | `test/export.test.mjs`: "fix 3: a collection that gains a document between the read and the re-count produces a named warning" (patches the fake's `count()` to return one more the first time it's called, matching a write racing the export), "fix 3: an unchanged collection re-counts as a match, with no warning" |
| 4 | Only the two manifest-named subcollections were ever walked; anything else nested under any document was silently left out of the archive. Now `docRef.listCollections()` discovers EVERY subcollection actually present, to 2 levels deep (`MAX_SUBCOLLECTION_DEPTH`); a 3rd-level finding is named in a loud warning and never read. Runs with a hand-rolled bounded-concurrency limiter (`mapWithConcurrency`, 16 at a time, no dependency). | `export.mjs` (`mapWithConcurrency`, `discoverAndReadSubcollections`, `countCollectionWithSubcollections`, `walkCollectionWithSubcollections`); `test/fake-firestore.mjs` rewritten as a generic recursive tree with `docRef.listCollections()` reporting exactly the subcollection names present under a doc | `test/export.test.mjs`: "fix 4: an unknown subcollection under a KNOWN collection is exported and warned about", "…under a PHANTOM parent is exported", "fix 4: a second-level subcollection… is exported", "fix 4: a third-level subcollection produces a loud warning and is NOT read/exported", "fix 4: subcollection discovery uses bounded concurrency (mapWithConcurrency correctness)" |
| 5 | `admin.initializeApp()` with no options let ADC decide the project. Changed to `admin.initializeApp({ projectId: PROJECT_ID })`; `main()` also refuses — before importing `firebase-admin` at all — if `GOOGLE_CLOUD_PROJECT` is set to anything other than the pinned project id. | `export.mjs` (`main()`) | `test/export.test.mjs`: "fix 5: PROJECT_ID is exported and pinned to the manifest project id", "fix 5: main() refuses to run when GOOGLE_CLOUD_PROJECT is set to a different project, BEFORE loading firebase-admin" (a real subprocess spawn) |
| 6 | The dry run downloaded every document into memory just to count it. Dry run now uses `count().get()` exclusively — for top-level collections AND every discovered subcollection at every depth — and never calls `get()` on a document query; only `--apply` reads document data. | `export.mjs` (`countDocuments()`, `countCollectionWithSubcollections()`, the `if (!apply)` branch in `runExport()`'s main loop) | `test/export.test.mjs`: "fix 6: dry run reads counts only — get() on a document query is never called for any collection" (call-log assertion), "fix 6: dry run still reports correct counts (including subcollections) without reading data" |
| 7 | The existing-bundle-directory check ran AFTER the entire database walk. `--out`'s repo-containment check didn't resolve symlinks. Both fixed: the existing-directory refusal is now the very first thing `runExport()` does (before `listCollections()`); `assertOutsideRepo()` now resolves symlinks via `fs.realpathSync` on the nearest existing ancestor before comparing against the repo root. | `export.mjs` (`assertOutsideRepo()`, the top of `runExport()`, the top of `main()`) | `test/export.test.mjs`: "an existing bundle directory is refused BEFORE any database walk (fix 7)" (asserts the fake's call log is EMPTY), "fix 7: --out that is a symlink pointing INTO the repo is refused", "fix 7: --out that is a genuinely external symlink target is NOT refused", "CLI mode: --out pointing inside the repo is refused end-to-end, before touching firebase-admin" (a real subprocess spawn — this is also the answer to open question 4 below) |
| 8 | `verify-bundle.mjs` silently `continue`d past a collection whose directory/manifest.json was missing, so a collection that failed to write produced no failing check. Also: no check that a `SHA256SUMS` path was safe (no absolute path, no `..` segment), and no check on `_auth/users.jsonl`'s or `_verify/<name>.jsonl`'s line counts. All fixed: a missing collection manifest is now a hard FAIL unless the collection's fate is `verify-only`; `isUnsafeRelativePath()` rejects an absolute or `..`-escaping SHA256SUMS entry before any file is even read; `_auth/users.jsonl`'s line count is checked against the root manifest's `authUserCount`; each `_verify/<name>.jsonl`'s line count is checked against that collection's recorded `count`. | `lib/verify-bundle.mjs` (`isUnsafeRelativePath()`, the rewritten section 4, new sections 5 and 6) | `test/verify-bundle.test.mjs`: "fix 8: isUnsafeRelativePath rejects absolute paths and .. segments…", "fix 8: verify-bundle FAILS (not throws) when SHA256SUMS contains an absolute or ..-escaping path", "fix 8: a collection listed in the root manifest whose directory/manifest.json is missing is a FAIL, not silently skipped", "fix 8: _auth/users.jsonl line count is checked against authUserCount", "fix 8: each _verify/<name>.jsonl line count is checked against the root manifest" |
| 9 | `bundle-writer.mjs`'s `ensureDir()` had a dead loop: it walked up collecting "non-existent" ancestors AFTER `mkdirSync` had already created them all, so `existsSync(current)` was always true and the loop never added anything. Removed; the one `chmodSync` that ever did anything is kept. | `lib/bundle-writer.mjs` (`ensureDir()`) | `test/bundle-writer.test.mjs`: "file modes: directories 0700, files 0600" (pre-existing test, still green — confirms the simplification didn't change behaviour) |

**Answers to the open questions, as implemented:**

1. **Live re-count: yes** — see fix 3 above.
2. **The two bundle-root files stay absent**, and this is now recorded explicitly: the root manifest carries a `notIncluded` object with one explanatory line each for `_maps/user-id-map.json` (belongs to the importer) and `_storage/storage-manifest.jsonl` (belongs to the separate storage tool). `export.mjs` (the `notIncluded` object in `runExport()`'s write phase); tested in `test/export.test.mjs`: "open question 2: the root manifest records _maps/user-id-map.json and _storage/storage-manifest.jsonl as notIncluded, and neither file is written".
3. **Fiscal year = calendar year: accepted for now**, per the review's answer; the assumption is stated in `retainUntilFor()`'s doc comment and in this report's open questions (the accountant confirms before the production export).
4. **Subprocess test for the `--out` refusal: added.** `test/export.test.mjs`: "CLI mode: --out pointing inside the repo is refused end-to-end, before touching firebase-admin" spawns the real `node scripts/cf-port/migrate/export.mjs --out <repo path> --apply` and asserts exit code 1, the refusal message, and that the target directory was never created.

Also fixed along the way (not one of the 9, but needed for `no-write-calls.test.mjs` to pass again after fixes 1/2 introduced legitimate `.create(`-shaped text): `test/no-write-calls.test.mjs`'s scan was exempted for `Object.create(...)` (the standard prototype-check idiom `typed-json.mjs` now uses, and prose mentioning it in a comment), the same way it was already exempted for `createHash(...).update(...)`.

**Test count before round 1: 47. After round 1: 72.**

## Review round 2 (reviewer fixes at merge, Fable)

Round 1's nine fixes were verified by reading the code and re-running the suite (72 / 72). Four small changes were made by the reviewer instead of a further builder round:

| # | Change | File |
|---|---|---|
| 1 | The write-call scan also forbids `add`, `recursiveDelete`, the Auth admin writes (`createUser`, `updateUser`, `deleteUser`, `deleteUsers`, `importUsers`, `setCustomUserClaims`, `revokeRefreshTokens`, `createCustomToken`) and the link generators. `.create(` never matched `.createUser(`. | `test/no-write-calls.test.mjs` |
| 2 | `UnknownFirestoreTypeError` takes the document path as its own argument; the caller no longer builds the message by splicing quotes into the constructor name. | `lib/typed-json.mjs`, `export.mjs` |
| 3 | Removed a dead placeholder field (`docRefs`) from the level-1 subcollection entries. | `export.mjs` |
| 4 | The dry run lists the `settings` documents by id (`listDocuments()`, no field data), so each document's fate and any document the manifest does not know appear in the plan. | `export.mjs` |

Known limits, accepted for the staging export and to be revisited before the production freeze export: the live re-count of a DISCOVERED second-level subcollection family is recorded as `null` (no such family is known to exist); the discovery depth (2) and concurrency (16) are reasoned, not measured; the fiscal year is assumed to equal the calendar year.
