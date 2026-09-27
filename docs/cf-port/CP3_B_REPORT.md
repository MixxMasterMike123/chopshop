# CP3-B report — Identity (user directory, lifecycle, invites, import bookkeeping)

Builder: CP3-B. Branch `cf-port`, working tree only (nothing committed). `$CF` = `cloudflare/`.

Sections 1–9 describe the first delivery. **Section 10 (Review round 1) supersedes them where they differ.** Each stale statement below is marked *(changed in round 1)*.

## 1. What was built

| Area | Where |
|---|---|
| Migration `0033_identity_import_support.sql`: `legacy_id_map`, `import_runs`, `import_row_hashes`, `identity_invites`, and a `status_change_id` column on `identity_access` and `tenant_memberships` | `$CF/migrations/0033_identity_import_support.sql` |
| User directory (list + read) | `$CF/src/platform/user-directory.ts` |
| Deactivate, reactivate, tenant-admin membership revoke | `$CF/src/platform/user-lifecycle.ts` |
| Invites (72 h password-set link) | `$CF/src/platform/invites.ts` |
| Route handlers | `$CF/src/routes/platform-users.ts` |
| Surface-aware reset page and a callback that keeps an allowlisted reset page | `$CF/src/auth/password-reset.ts` (edited) |
| Better Auth trusts every canonical reset page (today only `web`) | `$CF/src/auth/create-auth.ts` (edited) |
| Route mounts | `$CF/src/app.ts`, inside `CP3-IMPORTS-B` and `CP3-ROUTES-B` only |
| Tests | `$CF/test/platform-users.test.ts` (29), `user-lifecycle.test.ts` (15), `invites.test.ts` (19), `import-support.test.ts` (16), `password-reset.test.ts` (+1, now 20) |

No new binding, variable or secret is needed.

## 2. Routes

All routes use a live platform session only (`authorizePlatformRequest`, a D1 lookup of an ACTIVE `platform_admin`). No session, a tenant-admin session, a print-operator session or a suspended identity gets the opaque `404 {"error":{"code":"not_found","message":"Route not found"}}`. GET requests need no same-origin check, as with every admin read. Every POST needs `isSameOriginRequest`: a missing or cross-site `Origin` gets the same opaque 404, checked before the path is parsed. POST routes read no body. Every route is registered as an exact path wrapped in `onMethods([...])`, so other methods fall through to whatever route came next (in the end, a 404).

| Method + path | Success | Refusals |
|---|---|---|
| `GET /v1/platform/users?accountType=&tenantId=&cursor=&limit=` | `200 {users: DirectoryUser[], nextCursor: string\|null}` | `400 invalid_request` for an unknown key, a repeated key, an unknown `accountType`, a malformed `tenantId`, `limit` outside 1..100 (default 50), or a malformed cursor. A non-platform caller gets the 404, never the 400. |
| `GET /v1/platform/users/:userId` | `200 {user: DirectoryUser}` | 404 when the user is unknown or the id is malformed |
| `POST /v1/platform/users/:userId/deactivate` | `200 {user}` (fresh read, `status:"suspended"`) | `409 cannot_deactivate_self` · `last_platform_admin` · `not_active` · `no_identity`; 404 for an unknown user |
| `POST /v1/platform/users/:userId/reactivate` | `200 {user}` (`status:"active"`) | `409 not_suspended` · `platform_admin_reactivation` · `no_identity`; 404 |
| `POST /v1/platform/users/:userId/invite` | `202 {invite: {userId, surface: "admin"\|"platform", expiresAt}}` | `409 not_invitable`; `503 email_unavailable` when the queue refuses; 404 (including when EMAIL_QUEUE or CANONICAL_ORIGINS is missing: the surface is dark, like the reset routes) |
| `POST /v1/platform/tenants/:tenantId/admins/:userId/revoke` | `200 {membership: {membershipId, tenantId, userId, role:"admin", status:"revoked"}}` | `409 already_revoked`; 404 when no such admin membership exists |

A 409 body has the shape `{"error":{"code":"<refusal>","message":"…"}}`.

`DirectoryUser` = `{userId, email, name, accountType, status, createdAt, memberships: [{tenantId, role, status}], printMemberships: [{tenantId, status}]}`.
- `accountType` and `status` are null for a user without an `identity_access` row (the inert orphan a provisioning race can leave).
- `createdAt` is ISO-8601 UTC. Better Auth stores ISO strings; a millisecond value is converted.
- Ordering is by user id (keyset: the cursor is the last id of the page). `createdAt` is written by both Better Auth and the importer, so a cursor built on it would depend on the two agreeing on a string format.
- `tenantId=` keeps users with ANY tenant or print membership in that shop, in any status.
- Every column is named in the SELECT. Nothing is read from `account`, `verification` or `session`. *(Changed in round 1: `hasPassword` is derived from `account` inside SQL, and `invite` comes from `identity_invites`; see 10.3.)*
- The test walks the whole response recursively: no key matches `/password|hash|token|secret/i`. It also checks that the user's real password hash and session token strings appear nowhere in the text.

`POST /v1/platform/users` (create) is unchanged. It is still POST-only through the old handler, still creates tenant admins, and still refuses `platform_admin` with a 400 (tested in `platform-users.test.ts`).

## 3. Migration 0033

The file is additive only: 4 new tables, 2 `ADD COLUMN`s, no table recreated, no 0020.

**`legacy_id_map(kind, legacy_id, new_id, env, created_at)`, PK `(kind, legacy_id)`**, exactly as in the contract.
- CHECKs: `kind IN ('user')`, lengths 1..256, `env IN ('staging','production')`, `created_at` is ISO (the round-trip CHECK used since 0013).
- UNIQUE `(kind, new_id)`: one new id belongs to one legacy id. D59 adoption still fits, because the adopted user is the target of exactly one legacy id.
- Triggers: no UPDATE, no DELETE, and a BEFORE INSERT guard. The guard refuses any insert whose key already exists with different content, and any second legacy id that claims a taken new id.

**`import_runs(run_id, env, bundle_sha, plan_sha, started_at, finished_at, status, counts_json)`**
- CHECKs:
  - `status IN (running, completed, failed)`
  - `(status='running') = (finished_at IS NULL)`
  - `finished_at >= started_at`
  - both shas are 64 lowercase hex characters
  - `counts_json` is a JSON object or NULL
  - `run_id` is 1..128 characters of `[0-9A-Za-z._:-]`
- Triggers:
  - a run is inserted `running` only;
  - a `run_id` is never reused;
  - only one `running` run per env;
  - no new production run once one has completed (P2 "import once");
  - a completed or failed run can never be updated (`a finished import run is immutable`);
  - while a run is running, `run_id`, `env`, the two shas and `started_at` cannot change;
  - no DELETE.
- The two partial unique indexes (one running run per env, one completed production run) repeat the last two rules as a backstop.

**`import_row_hashes(table_name, row_pk, content_sha, run_id)`, PK `(table_name, row_pk)`.** `run_id` is a foreign key to `import_runs`.
- A BEFORE INSERT trigger aborts when the same key arrives with a different `content_sha` (`import row hash mismatch: same id, different content`). It fires before the key conflict is resolved, so under INSERT, INSERT OR IGNORE and INSERT OR REPLACE a changed row always aborts.
- The same key with the same hash under `INSERT OR IGNORE` is skipped, and the first run's `run_id` stays.
- Hashes may only be inserted under a `running` run.
- No UPDATE, no DELETE.

**Why the INSERT-time guards:** I verified with a probe in this D1 that `INSERT OR REPLACE` silently overwrites a row even when a BEFORE DELETE trigger exists. SQLite's REPLACE deletes without firing delete triggers while `recursive_triggers` is off. A table guarded only by UPDATE/DELETE triggers is therefore not append-only against REPLACE. (Observation for the reviewer: `audit_events` and the 0031 acceptances have that gap too. It is harmless as long as no code writes REPLACE into them.)

**Lifecycle stamps:** `identity_access.status_change_id` and `tenant_memberships.status_change_id` are nullable TEXT columns (section 4). The importer's inserts are unaffected.

**`identity_invites`:**
- Columns: `invite_id`, `user_id` (FK user), `surface` (admin/platform), `status` (issued/superseded/revoked), `verification_id` (not an FK: Better Auth deletes that row on use or expiry), `delivery_id`, `issued_by` (FK user), and `expires_at`, `created_at`, `updated_at` as ISO TEXT.
- The partial UNIQUE `(user_id) WHERE status='issued'` allows at most one live invite per user.
- Triggers: the status moves once, from issued to superseded or revoked, and nothing else on the row changes; no DELETE.

These tables are written only by the import scripts. `grep -rn "legacy_id_map|import_runs|import_row_hashes" $CF/src` finds nothing, so no route reads or exposes them.

## 4. How the lifecycle guards hold

Each operation is one D1 batch. Its first statement is a conditional `UPDATE … SET status=…, status_change_id=<fresh uuid> WHERE <every guard>`, and that statement is the decision. Every later statement in the batch (the audit row, the session delete, the invite revocation) is keyed on `status_change_id = <that uuid>`, so a refused change writes nothing. The read after a refusal only picks the error code.

**Deactivate WHERE:** `user_id = target AND user_id <> caller AND status='active' AND (account_type <> 'platform_admin' OR EXISTS(another ACTIVE platform_admin whose user_id <> target))`.

**Concurrency:** D1 runs one statement and one batch at a time against one SQLite database. Take two requests where the last two admins deactivate each other. Whichever UPDATE runs second already sees the first one's suspension, finds no survivor and matches no row.

Tests:
- The module level authorizes both principals first and then runs `Promise.all`, over 5 rounds. Every round ends with exactly one `ok`, one `last_platform_admin`, and one active admin.
- The same case over HTTP ends with one 200, the loser gets 409 or 404, and exactly one active admin remains.
- A stale-principal test covers the race window: the caller is suspended after authorization.

I removed the `EXISTS` clause temporarily and all three tests failed; the file was restored byte for byte. The caller always counts as a survivor while active, which is why self-deactivation has its own guard (both an early return and `user_id <> caller` in the SQL).

**Sessions:**
- Deactivate deletes every `session` row of the user in the same batch. The old cookie then resolves no session (`get-session` answers null) and the next tenant-admin or platform request gets the 404. The guards also re-read `identity_access` live anyway.
- Deactivate also revokes an outstanding invite: it deletes the invite's `verification` row and marks the invite revoked. Otherwise the invite would come back to life on reactivation.
- Membership revoke does NOT touch sessions. Sessions are not bound to a tenant here: `authorizeTenantAdminRequest` checks the `X-Shop-Id` a request names against a live active membership on every request. Revoking one membership ends access to that shop on the next request, and the same session keeps working in the user's other shops (tested with two shops). Revoking the sessions would sign the user out of shops they still administer.
- A tenant admin whose only membership is revoked keeps an active `tenant_admin` identity with no shop. They can sign in, and every tenant-admin request gets the 404 (tested).

**Reactivate:** `suspended → active` for any kind except `platform_admin` (section 6). Sessions are not restored, so the user signs in again (tested: the old cookie stays dead and a new sign-in works).

**Audit actions:** `platform.user_deactivate` (metadata: accountType, changeId, sessionsRevoked, invitesRevoked), `platform.user_reactivate`, `tenant.admin_revoke` (with `tenant_id`, resource = membership id), and `platform.user_invite` (deliveryId, expiresAt, inviteId, surface). No audit row carries an email, a token or a link.

## 5. Invites

**Token:** the invite reuses the reset mechanism rather than copying it. The token is 32 alphanumeric characters (`better-auth/crypto` generateRandomString). It is stored as a Better Auth `verification` row with identifier `reset-password:<token>` and value = user id, written through Better Auth's own `internalAdapter.createVerificationValue`, so the `storeIdentifier: "hashed"` hashing cannot drift from what the reset endpoints look up.
- Its expiry is set on the row: `now + 72 h`.
- The user follows the ordinary emailed link (`GET /api/auth/reset-password/:token`) and sets a password through the ordinary `POST /api/auth/reset-password`.
- Better Auth consumes the row atomically there (single use), revokes all sessions, and creates the credential account if none exists.
- Better Auth's `resetPasswordTokenExpiresIn` (1 h) is untouched, so the ordinary reset still lives exactly one hour. This is tested at the boundary with a fake `Date`: valid at +59:59, INVALID_TOKEN at +60:01.

**Tested:**
- 72 h boundary with an injected issue time (valid 30 s before expiry, INVALID_TOKEN 1 s after, and the POST refused).
- 72 h boundary through the route with a fake `Date` (the clock Better Auth itself reads).
- Single use (second POST gets 400, and the link then answers INVALID_TOKEN).
- A second invite kills the first (the previous `verification` row is deleted and the invite marked `superseded` in the same batch; exactly one `issued` row).
- Deactivation kills an outstanding invite.
- An imported password-less identity (`account.password = NULL`) cannot sign in (401) until the invite; then it signs in and can create a product in its shop.

**Link origin:**
- The link itself is on `AUTH_BASE_URL` (the email job validator accepts nothing else).
- Its `callbackURL` is `<surface origin>/reset-password`, taken from the canonical allowlist by account type: platform admin → `platform`, tenant admin → `admin`. Other kinds get `409 not_invitable`.
- The allowlist (`src/lib/origins.ts`) only has `api` and `web` today, so both surfaces currently resolve to the web origin (tested). The mapping to separate origins is tested at unit level with a widened allowlist object.
- `canonicalResetLinkRequest` now keeps a `callbackURL` only if it is EXACTLY one of the canonical reset pages, and otherwise replaces it with the web page. All other query parameters are dropped. With today's allowlist this is byte-for-byte the old behaviour, and the existing tests pass unchanged.

**Response and state:**
- The response is `{invite: {userId, surface, expiresAt}}`. The test asserts it contains no token, no `reset-password`, no `callbackURL` and no email address.
- An `email_deliveries` row (kind `password_reset`, pending, `tenant_id` NULL) is written in the same batch as the `identity_invites` row and the audit row.
- If the target stopped being invitable between the read and the batch, the batch inserts nothing and the orphan `verification` row is deleted.
- If the queue refuses the message, the route answers 503, the ledger row is closed as `failed/E_ENQUEUE`, and the invite is revoked with its token deleted (tested).

**Email kind:**
- The existing `password_reset` ledger kind can carry the invite, so no new kind and no table recreation are needed: the ledger records a delivery, not its wording.
- The email job's own lifetime is 24 h, the cap in `auth-email-job.ts` and Resend's idempotency window. The token outlives it, so an invite not delivered within a day is re-issued.
- ~~The invite currently goes out with the reset template's copy.~~ *(Changed in round 1: invites now go out with their own wording; see 10.4.)*

## 6. Deviations (from the brief or from Firebase) and why

1. **Reactivating a `platform_admin` over HTTP is refused** (`409 platform_admin_reactivation`). My reading of D51: a hijacked platform session must not be able to bring back an identity another operator switched off (maybe because it was compromised) and outlive the revocation of the original session. Restoring one is a script plus review, like creating one. This is a one-line change (`AND account_type <> 'platform_admin'` in `reactivateUser`) if Mikael disagrees.
2. **Delete becomes deactivate** (every foreign key onto users is RESTRICT). Firebase's `deletePlatformUser` removed the Auth account. Here the rows stay, the identity is `suspended`, and its sessions and its outstanding invite are revoked.
3. **The Firebase last-admin guard counted only login-capable survivors** (Auth account exists and is not disabled). Here the survivor count is `identity_access` ACTIVE platform admins. The caller is always one of them and holds a live session; the count only matters in a race.
4. **Lifecycle routes accept any identity kind** (tenant admin, print operator, ordinary, platform admin for deactivate). Firebase's console handled `role=='admin'` only.
5. **Invites for `print_operator` and `ordinary` are refused.** The allowlist has no print origin, and the print portal is PORT-LATER (D12).
6. **`legacy_id_map.kind` is `('user')` only**, the one "new + map" row in the manifest. A new kind needs a migration that recreates the table (dropping and recreating its triggers).
7. **The import tables are stricter than the bare contract** (section 3): runs are inserted `running`, one running run per env, production imported once, lowercase hex shas, hashes only under a running run. The script builder must know this. A crashed `running` run must be closed with `UPDATE … SET status='failed', finished_at=…` before the next run can start.
8. **An extra table (`identity_invites`) and two `status_change_id` columns** go beyond the three contract tables. The invite table is what makes "a new invite invalidates the previous unused one" possible, because with hashed identifiers the previous token's row cannot otherwise be found. The stamps are what let the lifecycle batches key their follow-up statements on the guarded write.
9. **Deactivation does not delete an outstanding ORDINARY (self-service) reset token.** A suspended user who resets their password gains nothing, because every guard reads `identity_access`.

## 7. Reviewer wiring

*(Changed in round 1:*
- *items 1 and 4 are done by me;*
- *item 2 is done by me as well;*
- *item 3 is ruled "not now";*
- *the current list is in 10.7.)*

1. **`$CF/test/provision-users.test.ts` ~line 472**, `it.each([["GET"], ["PATCH"], ["PUT"], ["DELETE"]])("does not expose the route through %s")`. The GET case now fails BY DESIGN: `GET /v1/platform/users` is the directory, whose guard contract is pinned in `platform-users.test.ts`. Drop `["GET"]` from that list. The POST-only behaviour for PATCH, PUT and DELETE still holds.
2. **Not mine, for information:** `$CF/test/provision-tenants.test.ts:716` "does not expose the collection through another method" fails because `GET /v1/platform/tenants` now answers 200. That is CP3-A's tenant list, same pattern as item 1.
3. **Origins, to give invites their own landing hosts:** add optional `admin` and `platform` keys to `CanonicalSurface` / `parseCanonicalOrigins` in `$CF/src/lib/origins.ts`. Today the parser rejects unknown keys, so the var cannot carry them yet. Then add them to `pinned.<env>.json → origins` and the `CANONICAL_ORIGINS` var in `wrangler.jsonc`. Nothing else is needed: `resetPageOrigin` picks them up, `canonicalResetLinkRequest` accepts their reset pages, and `create-auth.ts` adds them to Better Auth's trusted origins automatically.
4. **Invite email copy (optional before CP7; needed before real users are mailed).** No table change is needed. In `$CF/src/email/auth-email-job.ts`:
   - add `variant?: "invite"` to `AuthActionEmailJob`;
   - accept and preserve it in `createAuthEmailJob` and `parseAuthEmailJob`;
   - in `email-delivery-store.ts` `fingerprintAuthEmailJob`, add `...(job.variant === "invite" ? { variant: "invite" } : {})`, the same pattern as the order and digest keys, so every existing fingerprint stays byte-identical;
   - in `renderAuthEmail`, pick invite copy when `variant === "invite"`;
   - then pass `variant: "invite"` in the `createAuthEmailJob` call in `$CF/src/platform/invites.ts`.

   Proposed copy (neutral, platform display name as in the reset template):
   - sv: subject "Välj ditt lösenord", intro "Du har fått ett konto på MeteorShop. Välj ett lösenord för att logga in. Länken gäller i 72 timmar och kan bara användas en gång.", action "Välj lösenord".
   - en: subject "Choose your password", intro "An account has been created for you on MeteorShop. Choose a password to sign in. The link is valid for 72 hours and can be used once.", action "Choose password".
5. **`REQUIRED_MIGRATION`** (and the two tests that pin it) is the reviewer's to bump; 0033 must be applied before a Worker that serves these routes.

## 8. Open questions

*(Changed in round 1:*
- *questions 1 and 5 are answered by the rulings;*
- *questions 2, 3 and 4 are resolved by follow-ups 2, 3 and 4.)*

1. Is refusing platform-admin reactivation over HTTP (deviation 1) acceptable?
2. **A revoked membership cannot be re-granted.** The existing grant route answers 409 for a non-active membership, and `(tenant, user, role)` is UNIQUE. Is revocation meant to be permanent for that pair, or should CP3-A/B add a restore?
3. **The directory cannot show who still needs an invite**, because the brief forbids data from `account` and `verification`. Should it show the latest `identity_invites` status and expiry instead? That table is not Better Auth's.
4. The existing email templates say "MeteorShop" while the display brand is ChopShop. My proposed invite copy follows the existing template. Should both change together?
5. On staging the Resend key is still owed. Invites queue and their ledger rows expire after 24 h undelivered; re-invite once the key exists.

## 9. Test output (exact)

Type check: `npx tsc --noEmit` exits 0.

My five suites together (`npx vitest run test/platform-users.test.ts test/user-lifecycle.test.ts test/invites.test.ts test/import-support.test.ts test/password-reset.test.ts`):

```
 Test Files  5 passed (5)
      Tests  99 passed (99)
```

The per-file counts are 29 + 15 + 19 + 16 + 20. `password-reset.test.ts` has 19 existing tests, all green and none edited, plus 1 new.

I ran the full suite (`npx vitest run`) twice, with the other builders' work in the tree.

First full run:

```
 Test Files  2 failed | 59 passed (61)
      Tests  2 failed | 2049 passed (2051)
```

The two failures are the ones in section 7, items 1 and 2:
- `provision-users.test.ts > … > does not expose the route through GET`: expected 404, got 200. This one is caused by my directory GET.
- `provision-tenants.test.ts > … > does not expose the collection through another method`: expected 404, got 200. This one comes from CP3-A's `GET /v1/platform/tenants`.

Second full run, the last before this report. By then CP3-A and CP3-F had added more files:

```
 Test Files  5 failed | 59 passed (64)
      Tests  9 failed | 2159 passed (2168)
```

The same two failures again, plus 7 in files other builders own, all mid-work, none touching identity routes or tables:
- `connect-onboarding.test.ts` ×3 (CP3-F): the fake gateway recorded `createAccount` calls or extra audit rows.
- `tenant-features.test.ts` ×3 (CP3-A): feature allowlist contents and trigger.
- `platform-tenants.test.ts` ×1 (CP3-A): close-race audit count.

My five suites pass in both full runs and alone (99/99). The `password-reset.test.ts` timing failure seen in CP2 did not occur, either in the full runs or alone.

Not done or not tested:
- The invite email wording (it depends on section 7, item 4).
- Real delivery through Resend (no network).
- The admin and platform origins as separate hosts, which is tested only at unit level because the allowlist cannot carry them yet.

## 10. Review round 1

### 10.1 Rulings received
All accepted as delivered:
- no platform-admin reactivation over HTTP;
- invites only for platform and tenant admins;
- survivor count = active platform admins;
- the stricter import tables.

Separate admin and platform hosts are **not now**: both surfaces use the web origin until the frontend checkpoint, and the existing fallback stays.

### 10.2 Follow-up 1 — the two old tests that forbade the new reads

| File | Change |
|---|---|
| `$CF/test/provision-users.test.ts`, "does not expose the route through %s" | `GET` removed from the `it.each`; PATCH, PUT and DELETE kept (a comment says why). Nothing else in the file was touched. |
| `$CF/test/provision-tenants.test.ts`, "does not expose the collection through another method" | That case tested GET only. It now loops over PATCH, PUT and DELETE (the methods CP3-A's GET-only list route does not claim, which still fall through to the POST-only handler's 404). The name is unchanged. |

### 10.3 Follow-up 2 — `provision-tenants.ts` (`setTenantStatus`, `grantTenantAdmin`)

**a. Activate or suspend on a closed shop.**
- *The write:* `setTenantStatus` now runs `UPDATE tenants SET status=?, updated_at=? WHERE tenant_id=? AND status <> 'closed'`. The closed check is in the statement's WHERE, so a closed shop matches no row: 0032's `tenants_closed_is_final` trigger never fires and nothing is written.
- *The audit row:* it is an `INSERT … SELECT … WHERE EXISTS (tenant has the requested status)`, in the same batch after the UPDATE. The shop holds the requested status (active or suspended) exactly when the UPDATE matched, because a skipped shop is still closed. No stamp column is needed on `tenants`.
- *The result:* `{ status: "conflict", code: "tenant_closed" }`. The type gained an optional `code`, and `createTenant`'s conflicts are unchanged.
- *The route:* the old handler in `app.ts` maps every conflict to the generic `409 conflict` and is outside my blocks. So `POST /v1/platform/tenants/:tenantId/activate` and `/suspend` are now registered in `CP3-ROUTES-B` (`handlePlatformTenantStatusRoute` in `$CF/src/routes/platform-users.ts`, wrapped in `onMethods(["POST"])`). It keeps the same guard order, the same 200 `{tenant}` and the same opaque 404; a closed shop answers `409 {"error":{"code":"tenant_closed","message":"A closed shop cannot be activated or suspended"}}`. **Consolidation:** POST no longer reaches the old `handlePlatformTenantRoute` activate/suspend branch, which can go.
- *Tests* (`provision-tenants.test.ts`, describe "status change on a closed shop"):
  - 409 `tenant_closed` for both actions, with the row (status, updated_at) and the audit list unchanged;
  - a direct call returns the refusal instead of throwing;
  - an open shop still gets the old 200 body and audit trail, and an unknown shop gets 404.

**b. The grant on a non-active membership.** 0002 allows three membership states: `active`, `suspended`, `revoked`. My decision for each:

| Membership state | Grant does |
|---|---|
| `active` | Unchanged: 201 with the existing membership, nothing written, no audit (the existing idempotent answer). |
| `revoked` | **Re-activates the same row** (the `(tenant, user, role)` key is unique, so a second row is impossible). 201 with the original `membershipId`, audited `tenant.admin_reactivate` with `{changeId, previousStatus:"revoked"}`. |
| `suspended` | **Re-activates too**, audited with `previousStatus:"suspended"`. No route writes a suspended membership; only a hand-written UPDATE or an import can. A grant is the operator's explicit instruction to make this user an admin of this shop, and the audit row keeps the state it left. |

- *What stays unchanged:* the identity is never re-enabled here. A suspended or revoked `identity_access` row is still refused (409) before any write, as before. An identity-less user whose membership is revoked gets the `identity_access` row a fresh grant would create.
- *The pattern:* the lifecycle one. One guarded `UPDATE tenant_memberships … SET status='active', status_change_id=?` carries every guard in its WHERE:
  - the membership is still in the state read;
  - the shop is active;
  - the identity is an active tenant admin, or has no row.

  The conditional identity insert and the audit row are keyed on the stamp.
- *A separate audit action* (`tenant.admin_reactivate`, not `tenant.admin_grant`) keeps the existing test that reads the first `tenant.admin_grant` row and expects null metadata true.
- *Tests* (`provision-tenants.test.ts`, describe "grant on a non-active membership"):
  - revoked → re-activated: same id, one audit, the admin can write again, a further grant is a no-op;
  - suspended → re-activated;
  - a revoked membership with no identity row → the row is created;
  - a suspended identity with a revoked membership → 409, nothing changes;
  - the guard inside the write: a stale read (proxied DB says the shop is active; the row says suspended) returns conflict and the membership stays revoked.

**Finding along the way (it applies to all my guarded writes): D1's `meta.changes` counts rows written by triggers.** An UPDATE of `tenants.status` reports 2, because 0025's AFTER UPDATE trigger bumps `catalog_version`. Every "did the guarded write match" check in my code (`provision-tenants.ts`, `user-lifecycle.ts`, `invites.ts`) is now `changes > 0`, not `=== 1`. A statement that matches nothing fires no trigger, so this is exact.

### 10.4 Follow-up 3 — invite status and `hasPassword` in the directory
`$CF/src/platform/user-directory.ts`. Every `DirectoryUser` (list, read, and the lifecycle responses) gains two fields:
- **`hasPassword: boolean`:** `EXISTS (SELECT 1 FROM "account" WHERE "userId" = u."id" AND "providerId" = 'credential' AND "password" IS NOT NULL)`, evaluated inside SQLite. The Worker receives 0 or 1; the password column's value is never selected.
- **`invite`:** `null`, or `{ status, expiresAt, createdAt }` of the user's latest `identity_invites` row. The latest row is picked with `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, status='issued' DESC, invite_id DESC)`, chunked ≤ 90 ids. `expired: true` is added only when the status is `issued` and `expires_at <= now`.
  - The verification row id, the delivery id and the token are never selected.
  - `issued` means "not superseded, not revoked". It does not say the link was used: Better Auth consumes the token without telling this table. `hasPassword` answers that (tested: after the invite is used, `hasPassword` turns true and the invite stays `issued`).

Tests in `platform-users.test.ts`, describe "the directory's password and invite facts":
- `hasPassword` is true for a signed-up user and false for an imported user with a null-password account or with no account;
- `invite` is null before any invite, then issued (72 h window), then the newer one after a second invite;
- `expired: true` appears on an invite issued with a clock 73 h back;
- `revoked` appears after deactivation, without the flag;
- the forbidden-field walk now allows exactly one key matching `/password|hash|token|secret/i` — `hasPassword` — and only with a boolean value;
- the response text contains none of the verification ids, delivery ids or tokens, nor (as before) the real password hash or session token;
- the exact key lists of the list and read tests gained `hasPassword` and `invite`.

### 10.5 Follow-up 4 — the invite email (`$CF/src/email/auth-email-job.ts`)
- **One display-name constant:** `PLATFORM_DISPLAY_NAME = "ChopShop"`, used by the reset, verification and invite templates. The reset and verification SUBJECTS are unchanged ("Återställ ditt lösenord", "Verifiera din e-postadress", and the English ones); only the brand in their intro line changed. No existing test pinned the old brand string, so **no expected string was edited**, and the consumer and reset tests that pin the subjects pass unchanged.
- **The variant:**
  - `AuthActionEmailJob.variant?: "invite"`, allowed only on `kind: "password_reset"`; anything else (on create or on parse) throws "Invalid auth email variant".
  - An ordinary reset or verification job has no `variant` key at all (tested before and after a JSON round trip), so its shape and its ledger fingerprint are byte-identical to before.
  - The ledger kind stays `password_reset`.
- **One number:** `INVITE_LINK_VALID_HOURS = 72` lives in the email module; `invites.ts` derives `INVITE_TOKEN_TTL_SECONDS` from it, so the copy and the token cannot disagree.
- `invites.ts` passes `variant: "invite"`.
- Tested end to end: an invite job goes through the real `-email` consumer to the fake Resend; the payload subject and text are the invite's, and the ledger row ends `sent` with kind `password_reset`.

**Final copy (text version; the HTML has the same lines as paragraphs, the link as an anchor, everything escaped):**

Invite, Swedish (default). Subject: **Välj ditt lösenord för ChopShop**
```
Ett konto har skapats åt dig på ChopShop.
Välj ett lösenord för att logga in.

Välj lösenord: <link>

Länken gäller i 72 timmar och kan bara användas en gång.
Om du inte väntade dig det här mejlet kan du bortse från det.
```

Invite, English. Subject: **Choose your password for ChopShop**
```
An account has been created for you on ChopShop.
Choose a password to sign in.

Choose password: <link>

The link works for 72 hours and can be used once.
If you did not expect this email, you can ignore it.
```

Ordinary reset: wording unchanged except the brand. sv: "Du har begärt att återställa ditt lösenord för ChopShop." / "Återställ lösenord: <link>". en: "You requested a password reset for ChopShop." / "Reset password: <link>". Verification: "Bekräfta din e-postadress för ChopShop." / "Confirm your email address for ChopShop.".

Not changed, on purpose: `create-auth.ts` still passes `appName: "MeteorShop"` to Better Auth. That is not an email template; Better Auth uses it for things like an authenticator issuer, and none is mounted. Worth aligning at consolidation.

### 10.6 Follow-up 5 — no orphaned token when the batch throws
`issueInvite` (`$CF/src/platform/invites.ts`) wraps the delivery-record preparation and the D1 batch. On a throw it deletes the just-written `verification` row (best effort; its own failure is swallowed) and rethrows the ORIGINAL error.

Test (`invites.test.ts`, "removes its token row and rethrows when the batch faults"): a proxied DB throws on the 5-statement invite batch only.
- It first records that the token row existed at that moment (count + 1).
- `issueInvite` rejects with the injected error object itself.
- Afterwards the token count is back to where it was; there is no new `identity_invites` row and nothing was queued.
- With the cleanup removed, this test fails. I checked, then restored the file byte for byte.

### 10.7 Reviewer wiring (current)
1. **Ledger fingerprint of the variant.** `fingerprintAuthEmailJob` (`$CF/src/email/email-delivery-store.ts`, not mine) does not include `variant`. Producer and consumer both ignore it, so they agree and delivery works (tested). But a queue message whose `variant` was altered in transit would not be a fingerprint conflict. The link and recipient are covered, so there is no security effect; only the wording could differ. The fix, which leaves every existing fingerprint byte-identical: add `...(job.kind === "password_reset" && job.variant === "invite" ? { variant: "invite" } : {})` to the canonical object.
2. **Consolidation:** the activate/suspend branch of `handlePlatformTenantRoute` in `app.ts` is unreachable for POST now (10.3a).
3. **`REQUIRED_MIGRATION`** → 0033 (or later), as before.
4. No new binding, variable or secret.

### 10.8 Test output, round 1 (exact)
`npx tsc --noEmit` exits 0.

My files, per file (each run alone):

| File | Tests |
|---|---|
| platform-users.test.ts | 34 passed |
| user-lifecycle.test.ts | 15 passed |
| invites.test.ts | 21 passed |
| import-support.test.ts | 16 passed |
| password-reset.test.ts | 20 passed |
| provision-users.test.ts | 54 passed |
| provision-tenants.test.ts | 63 passed |
| auth-email-job.test.ts | 10 passed |
| email-queue-consumer.test.ts (not edited; must stay green) | 42 passed |

All nine together: `Test Files 9 passed (9) · Tests 275 passed (275)`.

The other email-related suites pass as well: `email-delivery-store`, `outbox-email` (with `auth-email-job`, `email-queue-consumer` and `password-reset`: 5 files, 96 passed).

Full run (`npx vitest run`, with every builder's current work in the tree):
```
 Test Files  2 failed | 67 passed (69)
      Tests  37 failed | 2348 passed (2385)
```
Every failure is outside my files, and I did not fix any of them:
- **`test/slice/vertical-slice.test.ts` (1 test).**
  - Error: `AssertionError: expected { accepted: false, …(6) } to deeply equal { accepted: false, …(2) }`.
  - Cause: the legal status response now also carries `acceptedVersion`, `graceDeadline`, `inGrace` and `readiness`. This is CP3-E's legal work.
- **`test/slice/failure-injection.test.ts` (36 tests).**
  - Error in every case: `AssertionError: checkout: {"error":{"code":"not_found","message":"Checkout not found"}}: expected 404 to be 201`, raised at `openCheckout` in `test/slice-harness.ts:657`.
  - Cause: checkout now refuses the harness's shop. CP3-E changed `src/commerce/checkout.ts` and `src/legal/platform-terms.ts` and added `src/legal/legal-pages.ts` (the legal-pages readiness gate).
- **Why these are not mine:** the slice harness uses the unchanged `POST /v1/platform/users` and a FRESH admin grant. The grant path for a user with no membership is untouched by follow-up 2, and neither slice suite calls activate or suspend.
- Both slice suites passed in my two earlier full runs, before CP3-E's gate landed.
