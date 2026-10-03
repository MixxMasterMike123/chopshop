Model: claude-opus-5-5

# CP5-WJ4: a new admin is created without a password (Codex findings 4 and 8)

Unit WJ, the item "a platform user without a password". No other WJ item was built. Built on HEAD `ed2dc96e`; the working tree also holds the other builder's (FX) changes and someone's change to `scripts/cf-port/seed-staging-slice.mjs`. None of those files were touched here.

## The causes, as verified in the code

**Finding 4** (`cloudflare/src/platform/tenant-members.ts:464`, P2). `inviteTenantMember` created a new address with `createPlatformUser` and a random 64-character password. That is Better Auth's `signUpEmail`, which writes the user and a credential account holding the password's hash. Then came `identity_access` with its audit row. The membership grant then ran in a separate batch, with `UPDATE "account" SET "password" = NULL`. Between those two steps the identity was complete and showed a non-null password.

In that window, a second invite of the same address works like this:

1. Its `createPlatformUser` call gets `conflict`.
2. It re-reads the address and gets `has_password = 1`, so `hasPassword = true`.
3. It wins the grant and sends no invite (`if (!hasPassword)`), then answers 201.
4. The first request's grant batch matches no row, but still runs the password `UPDATE`. The first request answers `already_member` and sends nothing.

The end state is an active member with no password and no invitation, behind a 201. The test below reproduces exactly this on HEAD's code: 201 / `already_member`, zero mails.

**Finding 8** (`src/pages/platform/PlatformUsers.jsx:192`, P2). The chain:

- The page shows "Skicka inbjudan" only when `!u.hasPassword`.
- `u.hasPassword` comes from `src/admin-app/adapters/platformConsole.js` `userRowOf`, which reads the directory's `hasPassword`.
- `src/api/admin/platform.js` `readAllPlatformUsers` passes users through unchanged.
- The directory (`user-directory.ts`) sets `hasPassword` to "a credential account with a non-null password exists".
- The console's provisioning (`createTenantAdminUser`) sent `unusablePassword()`, 96 random hex characters.

So every console-provisioned admin read `hasPassword: true` from the moment it was created. The button never showed, even after the invite expired or its mail failed. The server's `POST /v1/platform/users/:id/invite` does accept any active platform or tenant admin.

## The design, and why it is atomic

**1. No password at creation, in one transaction.** This is new: `provision-users.ts` `createInvitedUser`. A single `db.batch`, which D1 runs as one transaction, writes:

- the Better Auth `"user"` row;
- its credential `"account"` row with `password` NULL and `accountId` = the user id;
- the `identity_access` row;
- the `platform.user_provision` audit row, unchanged.

Nothing of it is visible before all of it is. No reader can see the user without its kind, or with any password, from the first moment the user exists. The shape is exactly the importer's for a carried admin (MIGRATION_MANIFEST §a). Ids use Better Auth's default generator (32 `[a-zA-Z0-9]`), times are ISO-8601 text, and `emailVerified` is 0. A test compares the storage types with a row written by Better Auth's sign-up, and they are equal. Duplicates are handled two ways: the address pre-check gives a clean 409, and a racing duplicate fails the batch on `"user"."email"` UNIQUE, which is the same 409 and leaves nothing behind (tested with an interleaved insert).

Why not go through Better Auth's adapter? It writes the user and the account as separate statements, and the access row must be in the same transaction as both.

**2. The HTTP surface.** `POST /v1/platform/users` accepts `{ accountType, email }`, which goes through `createInvitedUser` with the address's local part as the name. Existing callers keep working: `{ accountType, email, password }` still runs Better Auth's sign-up (the staging scripts `seed-staging-slice.mjs`, `staging-legal.mjs` and `stg-e2e.sh` all send a password). The edge cases:

- A `password` key that is present but `null`, `""` or not a string is still a 400. It is never read as "no password".
- No password is allowed only for an invitable kind (`invites.ts` `inviteSurfaceFor`). Of the creatable kinds that is `tenant_admin`. A print operator without a password is a 400, because nothing could ever give it one.

**3. The shop's invite** (`tenant-members.ts`) creates through `createInvitedUser` with the requested name. The grant batch no longer touches `account` or `user`, and the module's `invalid` result is gone, along with its case in `routes/admin-members.ts`.

The race now plays out in two orders:

- **The second request reaches the address after the first created it.** It sees a complete identity with no password, so it sends the link if it wins the grant.
- **The first request wins the grant.** It created the identity, so it sends the link.

Either way, exactly the request that answers 201 sends the invitation. The other one answers `already_member` when both target the same shop. When two shops invite the address, both grants succeed and both send the link; the later link supersedes the earlier, and one live invitation remains.

**4. "Has set a password of their own" is one SQL fact,** `user-directory.ts` `ownPasswordSql`. It is true when a credential password exists and no invite was issued at or after the password's last change. Better Auth stamps `account.updatedAt` when its reset endpoint sets the password; Better Auth 1.6.29 `onUpdate` was verified in its source. The fact is evaluated inside SQLite, so only 0 or 1 leaves it. The tie goes to "not set", which means an invite is offered. If a time were ever not text, SQLite orders text above it, and again an invite is offered, never the reverse.

The fact is used in three places:

- **The members list:** `invited` = not the fact (it was "no password at all").
- **The shop's invite:** a link is sent exactly when the fact is false.
- **The directory:** the latest invite gains `pending: boolean` = not the fact. `hasPassword` keeps its exact meaning ("a non-null password exists").

For identities created from now on, the fact and `hasPassword` agree. For the admins staging already has with a throwaway password and an unused invite (expired, revoked because the mail could not be queued, or live), `pending` is true. The fact is the "never accepted" signal the brief asked for, and no migration was needed.

**5. The page (finding 8).** The adapter's row field is now `hasPassword = user.hasPassword && invite.pending !== true`. The meaning is "has set a password of their own". The page keeps its condition and stays byte for byte. The older build's data module is unchanged (`USER_LIFECYCLE = false`, so the button never shows there). The console's `createTenantAdminUser` now sends `{ accountType: 'tenant_admin', email }`, and `unusablePassword` is deleted.

## Files changed

The brief's own files:

- `cloudflare/src/platform/provision-users.ts`: `createInvitedUser`, optional password, `accessStatements` shared by both paths.
- `cloudflare/src/platform/tenant-members.ts`: creation through `createInvitedUser`, `ownPasswordSql`, grant without the account/user updates.
- `cloudflare/src/platform/user-directory.ts`: `ownPasswordSql`, `invite.pending`.
- `cloudflare/src/routes/admin-members.ts`: the dead `invalid` case removed.
- `cloudflare/test/provision-users.test.ts`, `cloudflare/test/platform-users.test.ts`, `cloudflare/test/admin-members.test.ts`.
- `src/api/admin/platform.js`: `createTenantAdminUser` without a password, `unusablePassword` deleted, the route line in the header.
- `src/api/admin/platform-shops.test.mjs`.
- `src/admin-app/adapters/platformConsole.js` and `src/admin-app/adapters/platformConsole.test.mjs`.

**Outside the brief's list, with the reason (rule 12):**

- **`createTenantAdminUser` sits in the `CP5-FI` section of `platform.js`, not the FJ users section.** The brief asks for the provisioning path to change, and this is that path.
- **`src/admin-app/dev/platform-dev.mjs` and `platform-dev.test.mjs` (FI's dev stand-in).** It required a password, so the console's new password-less create would have been a 400 in local dev. It now mirrors the Worker: no `password` key is accepted for `tenant_admin` only. One test assertion was added.
- **`src/admin-app/replacements/addShopUserData.js`, comment only.** Its header said the console sends `unusablePassword`, which is no longer true.

Not changed: `src/pages/platform/PlatformUsers.jsx` and `src/pages/platform/platformUsersData.js`. No migration, no `REQUIRED_MIGRATION` change, no edit in `app.ts`, no `wrangler.jsonc` change.

## The contracts that changed

- `POST /v1/platform/users`:
  - `{ accountType: 'tenant_admin', email }` → `201 { user: { accountType, email, userId } }`, created with no password.
  - `{ accountType, email, password }` → as before.
  - 400: an unknown key; `password` that is null, empty or not a string; a print operator without a password.
  - 409 `conflict`: a taken address, whichever way it was created.
- `GET /v1/platform/users[/:id]`: `invite` (when not null) gains `pending: boolean`. The forbidden-field walk still passes; `pending` matches no forbidden pattern.
- `GET /v1/admin/members`: `invited` now means "has not set a password of their own" (it was "has no password").

## Tests, and the mutation each was seen failing on

Worker (new):

- **`admin-members.test.ts`, "two invites of one new address at once".** Driven with a D1 proxy that runs the second request right before the first request's grant batch: it arms on the prepare of `INSERT INTO tenant_memberships` and fires at the next batch.
  1. The second request wins the grant: its 201 sent the one invitation, the first is `already_member`, the link sets a password and sign-in works. **Mutation: HEAD's `tenant-members.ts` swapped in → fails with `expected [] to have a length of 1 but got +0`**, which is Codex's scenario: a 201, an `already_member`, no mail.
  2. The first request wins the grant: a two-sided hand-off, where the second request is held at its own grant until the first finishes. One invitation, the second gets `already_member`. Passes on HEAD's code too; it is the other order.
  3. Two shops at once: both 201, one live invite. Fails on HEAD (one mail where two grants each owe one; the invariant held there by luck of the creator).
  4. A legacy admin whose password predates their expired invite, added by a shop: a link is sent, `invited` true then false after use. Fails on HEAD (no mail).
- **`platform-users.test.ts`, "an identity created without a password…"**
  - Created password-less in one step: `hasPassword: false`, one credential account with NULL password, and sign-in with six passwords is refused with no session. **Mutation: `createInvitedUser` writes `'x'` as the password → fails.**
  - Storage types equal to a signed-up user's.
  - The invite's link sets the password, sign-in then works, and `pending` goes true → false. **Mutation: the comparison in `ownPasswordSql` reversed → this and five other tests fail.**
  - A password written before an expired invite reads `hasPassword: true, invite: { expired: true, pending: true }`; re-invite gives 202; after use `pending` is false. **Mutation: `ownPasswordSql` = "a password exists" (the old fact) → this, the next test and the member-legacy test fail.**
  - A password set by its owner after an invite counts as the owner's.
- **`provision-users.test.ts`, "…without a password":** 201, NULL password, audit row, no session; a print operator without a password is a 400 and writes nothing; 409 in every combination; a duplicate interleaved before the batch gives `conflict` with no account, access or audit row; the password path is kept. The 400 table case "password missing" became "password null".

Existing directory tests: the exact invite shapes gained `pending: true`, and "turns hasPassword true once the invite is used" now also asserts `pending: false`.

Node:

- **`platformConsole.test.mjs`** covers the row for: no password; a pending invite (live, expired, revoked) on a legacy password; a non-pending invite; no invite; and a directory without the field. **Mutation: the adapter back to `user.hasPassword === true` → `not ok 2 - users`.**
- **`platform-shops.test.mjs`:** the create body is exactly `{ accountType, email }`.
- **`platform-dev.test.mjs`:** a password-less create gives 201, a print operator 400, `password: null` 400.

Every mutation was reverted by copying the saved file back, and the copy was checked with `cmp`.

## Gates (run after the last edit)

| Gate | Result |
|---|---|
| `cd cloudflare && npx tsc --noEmit` / `-p web` / `-p admin` | clean, clean, clean |
| `npx vitest run` (Worker) | **Test Files 99 passed (99), Tests 4236 passed (4236)**, nothing skipped (HEAD 4222 + 14 new) |
| `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs` | **545 pass, 0 fail, 0 skipped**. My net change is 0 (+1 adapter test, the two password tests of `platform-shops` merged into one). The other 29 over HEAD's 516 are the other builder's in-progress tests (e.g. 16 in their two untracked files). |
| `npx vite build --config vite.admin.config.js` + `node cloudflare/admin/check-admin-build.mjs` | exit 0, "no Firebase code, no source map, no secret, every file servable" |
| `node cloudflare/web/check-storefront-build.mjs` | exit 0 |
| `npx vite build` (older build) | exit 0 |
| `node guard/guards.test.mjs` | exit 0, **PASS**, allowlist 296 (unchanged) |

The builds and the Node suite ran over a tree that also holds FX's unfinished work, so their passing says that tree builds, not only mine.

## Found and NOT fixed

1. **A legacy admin with a throwaway password and NO invite row** cannot be told apart from an operator-chosen password. This happens when the console created the user and granted the shop, but the invite never reached the server or was refused before its row was written. Such a person reads `hasPassword: true` with no pending invite, so the console shows no button and a shop's invite sends no link. They can still use the ordinary "forgot password" (`POST /api/auth/request-password-reset`, mounted, wired in the admin's sign-in). To find them on staging (read-only):

   ```sql
   SELECT u.email FROM "user" u
   JOIN identity_access a ON a.user_id = u.id AND a.account_type = 'tenant_admin'
   JOIN "account" c ON c."userId" = u.id AND c."providerId" = 'credential' AND c.password IS NOT NULL
   WHERE NOT EXISTS (SELECT 1 FROM identity_invites i WHERE i.user_id = u.id)
     AND EXISTS (SELECT 1 FROM audit_events e WHERE e.action = 'platform.user_provision' AND e.resource_id = u.id);
   ```

   This also lists the script-made admins with known passwords (e.g. `staging-review+<shop>@example.com`), so read the list by hand.
2. **Two shops inviting one new address at once send two mails.** The earlier link is already superseded when it arrives. The person holds one live invitation, but one mail is dead. This is the existing behaviour of `issueInvite` and not this finding.
3. **The shop's members page still has no "resend invite"** (CP5_WC_REPORT open question 2). Re-adding an active, still-invited member answers `already_member`. The platform console's "Skicka inbjudan" now works for such a person.
4. **CP5_WC_REPORT question 1 (timing):** creating a new address no longer hashes a password, so the gap between a new and a known address shrinks. It does not disappear: one batch against none.
5. **The dev stand-in for the users list** (`platform-rest-dev.mjs` and its fixtures, FJ's) does not emit `invite.pending`. The adapter reads a missing field as false, so the dev page behaves as before. Adding it is cosmetic fidelity.
6. **Harmless side effect:** someone with a password of their own who receives an invite and does not use it is again offered "Skicka inbjudan", is listed `invited: true` in a shop, and gets a link if a shop adds them. The link is a password-set link, and using it ends their sessions.

## For Mikael to decide

- **Print operators** can no longer be created without a password (400). They still need an operator-chosen password, as the staging scripts give them. Is that right until print operators get an invite surface?
- **Legacy throwaway passwords on staging:** leave them (the console's button now works for every one that has an invite row; item 1 above covers the rest), or null them by a one-off staging write after reviewing the query's list.

## Reviewer wiring

None: no migration, no `REQUIRED_MIGRATION`, no `app.ts` block, no `wrangler.jsonc`, no env types.
