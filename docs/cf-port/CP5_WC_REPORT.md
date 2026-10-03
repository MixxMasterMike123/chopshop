Model: claude-opus-5-5

# CP5-WC report: a shop's own admins (D100)

## Files

| File | State |
|---|---|
| `cloudflare/src/platform/tenant-members.ts` | new: the list, the invite, the revoke, and the guarded grant |
| `cloudflare/src/routes/admin-members.ts` | new: the three handlers, both limiters, refusal mapping |
| `cloudflare/test/admin-members.test.ts` | new: 24 tests |
| `cloudflare/src/app.ts` | changed only inside `CP5-IMPORTS-C` and `CP5-ROUTES-C` |
| `cloudflare/src/platform/provision-users.ts` | 3 lines: `parseEmail` is exported; `createPlatformUser`'s `principal` is typed `PlatformPrincipal \| TenantAdminPrincipal` (and the import names the second type) |
| `cloudflare/src/platform/invites.ts` | 2 lines: `issueInvite`'s `principal` is typed `PlatformPrincipal \| TenantAdminPrincipal` (and the import) |

Neither platform function changes behaviour. Both read `principal.userId` and nothing else on the principal. I first tried `Pick<PlatformPrincipal, "userId">`, but an existing test passes an object literal that includes `accountType`, and the excess-property check rejected it. The union type accepts that literal and says plainly that the actor can be either kind of principal.

No migration. `identity_access`, `tenant_memberships` (with `status_change_id` from 0033), `identity_invites` and the reset mechanism are enough.

## Routes, as built

All three need `X-Shop-Id` and go through `authorizeTenantAdminRequest` first (an active membership, or acting-as). Anyone else gets the opaque 404 `{error:{code:"not_found",message:"Route not found"}}`. Every POST checks same-origin before the body is read.

**`GET /v1/admin/members`** → `200 { members: [{ userId, email, name, status, invited, joinedAt, self }] }`, with `Cache-Control: no-store`.
- Rows: the shop's `admin` memberships with `status='active'` whose identity is a `tenant_admin`. Oldest first (`created_at`, then `membership_id`). `LIMIT 100`. Named columns only.
- `status`: `"active"`, or `"suspended"` when the platform has suspended the person's identity.
- `invited`: true while the person has never set a password. This is the same fact as the platform directory's `hasPassword`, computed with the same `EXISTS` on `account` inside SQL; the password value never leaves the database.
- `joinedAt`: the membership's `created_at` as ISO.
- `self`: `userId === principal.userId`.
- Nothing about any other shop is selected. The account type is not output.

**`POST /v1/admin/members {email, name}`** → `201 { member }`. The member has the same seven keys as a list row.
- `email`: the provision-users `parseEmail` rule, lowercased.
- `name`: required, 1–100 characters, no leading or trailing whitespace, no control bytes, not blank.
- No other keys are accepted.

**`POST /v1/admin/members/:userId/revoke`** → `200 { revoked: { userId } }`.

## Refusals (each tested)

| Case | Answer |
|---|---|
| No session, foreign shop, missing or malformed `X-Shop-Id`, print operator, platform user without a grant | opaque 404 (all three routes) |
| Cross-origin, missing Origin, or `Origin: null` on a POST | opaque 404, nothing written |
| Wrong method (PUT/PATCH/DELETE on either path, GET on `/revoke`, `/members/:id` itself) | opaque 404 |
| Malformed user id (`a.b`, `%2E%2E`, `a%2Fb`, `%ZZ`, 129 chars, `%2574`), unknown id, id of another shop's admin, an already revoked member | opaque 404; the other shop's membership is untouched |
| Invite mail not configured (`EMAIL_QUEUE` or `CANONICAL_ORIGINS` missing) | opaque 404 on the POST: the surface is dark, as on the platform invite route |
| Malformed body (17 shapes plus invalid JSON) | `400 invalid_request`, nothing written, no mail |
| Address belongs to a platform admin, a print operator, a suspended identity, or a user with no identity | `409 not_addable` "The address cannot be added to this shop". The response body is byte-identical for all four (tested). |
| Address is already an active member (any casing; also yourself) | `409 already_member` |
| 20 active admins already (active membership + active `tenant_admin` identity) | `409 member_limit` "A shop has at most 20 active admins". No identity is created. |
| Revoking yourself | `409 cannot_revoke_self` |
| Revoking the last admin who counts (also by an acting-as operator) | `409 last_admin` |
| Queue refuses the job | `503 email_unavailable`; the membership stays (see open question 2) |
| Over a limit | `429 rate_limited` with `Retry-After` |

## How the writes decide

- **Grant.** One guarded statement decides: an `INSERT … SELECT … WHERE`, or an `UPDATE` that re-activates a revoked or suspended row. Its WHERE requires all of:
  - the shop is active;
  - the identity is an active `tenant_admin`;
  - no active row exists for this person in this shop;
  - fewer than 20 admins count.

  The audit row in the same batch is keyed on the decision's `status_change_id`. It is `tenant.admin_grant` or `tenant.admin_reactivate`, with metadata `{changeId, newIdentity, previousStatus?, surface:"admin", userId}` plus `actingAsGrantId` (via `auditMetadataJson`). It never holds the address or the name.
  - Two concurrent invites for the last place: exactly one 201 and one `member_limit` (tested).
- **Revoke.** One guarded `UPDATE`. Its WHERE requires:
  - the membership is active;
  - the target is not the caller;
  - `EXISTS` another admin who counts in this shop.

  The `tenant.admin_revoke` audit row is in the same batch, with `actingAsGrantId` when acting-as. D1 runs one statement at a time, so of two concurrent revokes of the last two admins one gets 200 and the other `409 last_admin` (tested).
- **Mutation check.** I temporarily removed the cap clause and then the survivor clause, one at a time. Each removal made the matching race test fail (and the last-admin test too). I restored the file and confirmed it is byte-identical.
- **Revoke leaves the rest alone.** The identity, its sessions and its other shops are untouched. The revoked person's next request naming this shop gets 404 and their other shop still works. `/v1/me` no longer lists this shop but still lists the other one (tested).

## What is reused

- **Creation:** `createPlatformUser`, as `tenant_admin`, with a random 64-character password that nobody ever sees.
  - The grant batch then sets that credential's `password` to NULL and the `user.name` to the requested name. So the identity is exactly like an imported one: it cannot sign in (tested: 401) until the invite link is used.
  - These two updates run whatever the grant decides. If an identity loses a race for the last place, it is password-less and inert, and the shop can add it later. Its creation is audited by `createPlatformUser`'s own `platform.user_provision` row.
- **Invite:** `issueInvite`, unchanged. The link's `callbackURL` is the admin surface's reset page from the allowlist, never the request host (tested). The invite job is the `invite` variant, and its ledger row and `platform.user_invite` audit row are written as on the platform path.
  - An invite is sent only to someone who has never set a password. A person who already has one, for example another shop's admin, gets no mail and keeps signing in as before.
- **Not reused:** `grantTenantAdmin` and `revokeTenantAdmin`. I am stating this deviation from the brief deliberately (rule 12). The seller's grant needs the cap and "already a member → 409" inside the deciding write; the platform grant answers an active member with an idempotent 200 and has no cap. The seller's revoke needs the self and last-admin guards in its WHERE, which `revokeTenantAdmin` lacks. Neither platform function can write the acting-as grant id. Wrapping them with a read-then-call would leave both race tests open.

**A known address is not revealed.** The 201 body is built only from the request (`email`, `name`), the resolved `userId` and the clock (`joinedAt` = now, `invited: true`, `status: "active"`, `self: false`). It never uses the stored name, the stored creation time or the password state. A test compares the answers for an existing other-shop admin and a brand-new address: they are equal after normalising id, address and time. The existing person keeps their own name, password and other shop.

## Acting-as decision

**Allowed for invite and revoke, and audited with `actingAsGrantId`.**
- Why: the platform already invites and revokes any shop's admins on its own routes (`platform-users.ts`). Refusing here would only send an operator who is helping a locked-out seller to a different page for the same change.
- The shop's guards (cap, last admin) still apply to the operator.
- The operator is never listed and is never `self`.
- Limitation: the rows written by the reused functions (`platform.user_provision`, `platform.user_invite`) name the operator as actor but carry no grant id. The grant id is on the membership audit row of the same request.

## Rate limiting (a deviation)

The brief said to limit the invite "as the platform invite is limited". The platform invite has no limiter: `invites.ts` and `provision-users.ts` say a live platform session is the control there. A seller's invite, though, lets any shop send mail to any address. So I reused the durable limiter (`lib/rate-limit.ts`) twice:
- `admin-member-invite-tenant`: 20 per hour per shop, before the body is read.
- `admin-member-invite-email`: 3 per hour per recipient address, after parsing, across every shop.

Both count every admitted request, accepted or refused (tested, including that the address bucket holds across shops).

## Tests and gate

- `npx vitest run test/admin-members.test.ts`: `Test Files  1 passed (1)` / `Tests  24 passed (24)`
- `cd cloudflare && npx tsc --noEmit`, `-p web`, `-p admin`: all clean
- `cd cloudflare && npx vitest run`: `Test Files  98 passed (98)` / `Tests  4164 passed (4164)`
- `node guard/guards.test.mjs`: FAIL, but only on "(b) 13 stale guard/allowlist.txt entries", all of them frontend pages (`src/pages/admin/*`, `src/pages/platform/*`, `src/components/platform/ProvisionShopModal.jsx`) that other builders are cleaning. My three new files are untracked, so the guard does not scan them yet. I ran the guard's own pattern families over them directly: no family matches.

## Open questions

1. The 201 hides whether the address was known, but a later `GET` shows the truth: the person's own name, and `invited: false` if they already have a password. Request timing also differs, because creating a new identity hashes a password. Is that acceptable, or should the list show the name the inviting shop gave?
2. There is no "resend invite". Once the 72-hour link has expired, or after a 503, the seller has to revoke and add again, which works: the row is re-activated and a new link is issued because there is still no password. Should a `POST /v1/admin/members/:userId/invite` be added for an active, still-invited member?
3. Revoking a still-invited person does not kill their outstanding invite link. `identity_invites` has no tenant column, and the person may be invited by another shop as well. Setting a password afterwards gives them no access to this shop.
4. Someone added to a second shop who already has a password gets no notice. There is no "you were added to a shop" template.
5. There is no cursor. The list is bounded at 100, and the 20-admin cap keeps a shop well below that. Revoked rows are not listed.

## Reviewer wiring

- None in reviewer-only files. The routes are registered in `CP5-ROUTES-C` as exact paths: `/v1/admin/members` (`onMethods(["GET","POST"])`) and `/v1/admin/members/:userId/revoke` (`onMethods(["POST"])`, user segment `pathname.split("/")[4]` from the raw pathname).
- The admin Worker already proxies `/_api/v1/admin/…`, so the SPA can reach these routes as soon as the API is deployed.
- The POST is dark (404) wherever `EMAIL_QUEUE` or `CANONICAL_ORIGINS` is missing, as on the platform invite route. Staging has both.
- Please confirm the two limiter values (20 per shop per hour, 3 per address per hour) and the D100 acting-as choice above.
