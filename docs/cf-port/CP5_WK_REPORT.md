Model: claude-opus-5-5

# CP5-WK report

The first builder was stopped partway through unit WK. Its five parts were already in the tree; I left them as they were. This builder added the two missing parts: the resend-invite route and the platform's print-jobs list. Nothing was committed, nothing went on the network, and there is no migration.

## Files

| File | Who | What |
|---|---|---|
| `cloudflare/src/platform/invites.ts` | first builder | `issueInvite(…, options)`: `condition` (an extra guard inside the batch) and `audit` (the tenant and extra metadata). Used here unchanged. |
| `cloudflare/src/platform/tenant-members.ts` | this builder | Adds `LISTED_MEMBER`, a predicate the list and the resend now share (the list's SQL is otherwise unchanged), plus `readInviteTarget`, `resendTenantMemberInvite`, and `not_invited` / `not_invitable` in `MemberRefusal`. |
| `cloudflare/src/routes/admin-members.ts` | this builder | `handleAdminMemberResendInviteRoute`. The 503 body moved into a helper that the add route uses too (same bytes). Header updated. |
| `cloudflare/src/dispatch/print-job-list.ts` | this builder, new | Query parser, SQL builder and the list. |
| `cloudflare/src/routes/print-jobs-platform.ts` | this builder | `handlePlatformPrintJobListRoute` and `PLATFORM_PRINT_JOBS_PATH`. |
| `cloudflare/src/app.ts` | this builder | Two imports in `CP5-IMPORTS-K` and two mounts in `CP5-ROUTES-K`. Nothing else. |
| `cloudflare/test/member-resend-invite.test.ts` | this builder, new | 17 tests. |
| `cloudflare/test/platform-print-jobs-list.test.ts` | this builder, new | 22 tests. |

## 1. Every route of unit WK

Admin routes: a tenant admin of the shop named in `X-Shop-Id`, or a platform user acting as that shop. Platform routes: a platform session, with no `X-Shop-Id`. Everyone else, any method a route does not own, and any write that is not same-origin get the opaque `404 {error:{code:"not_found",message:"Route not found"}}`. GETs do not require same-origin.

**`PATCH /v1/admin/settings`** (WD, first builder). Same-origin.
- Body:
  - `expectedUpdatedAt`: required. Send the `updatedAt` of the last read, an ISO string with milliseconds, or `null` if there were no settings yet.
  - `storeIdentity?`: an object with at least one top-level key. Each key replaces the stored value whole. A `null` value stores null. There is no deep merge and no key removal.
  - The gate fields are optional, with the same rules as the PUT: `returnAddress`, `vatRegistered`, `vatNumber`, `sellerType`.
  - At least one identity key or gate field must be present.
- Answers:
  - `200 { settings }`: the merged settings.
  - `409 { error:{code:"conflict"}, settings }`: the row is no longer at `expectedUpdatedAt`. Nothing was written, and `settings` is what is stored now.
  - `400 invalid_request`: a bad shape, or the merged identity is over the size cap.
  - `400 refused_store_identity_keys {keys}` and `400 unreferencable_images {keys}`: as the PUT. Only the keys being patched are checked.
  - `404`: as the PUT.

**`GET /v1/admin/payments/connect/balance`** (WF, first builder). Acting-as is allowed. No audit row.
- `200 { balance: { available:[{currency,amountMinor}], pending:[{currency,amountMinor}], payoutSchedule:{interval,delayDays,monthlyAnchor,weeklyAnchor}|null, retrievedAt } }`. This is the connected account's own balance, read live from Stripe and never stored. It does not include the platform's balance or the account id.
- `409 connect_account_missing`: the shop has no Connect account yet.
- `502 connect_unavailable`: Stripe refused or could not be reached.
- `429 rate_limited`: the per-shop Connect limiter, shared with the four Connect POSTs (12 per window).
- `404`: Connect is not enabled for the shop, no gateway is configured, or a guard failed.

**`GET /v1/platform/tenants?…&counts=1`** and **`GET /v1/platform/tenants/:tenantId`** (WI, first builder).
- `counts=1` (exactly `1`, given once) adds `counts: { products, publishedProducts, orders }` to each list row. Any other value is a 400.
- The detail always carries `counts`.
  - `products`: draft and active products.
  - `publishedProducts`: products under the public predicate. This is 0 while the shop is unpublished or not active.
  - `orders`: every order of the shop.

**`PATCH /v1/platform/printers/:printerId` with `dryRun: true`** (first builder). Same-origin.
- The same body as the write, plus `dryRun`. `false` or absent means a real write; any value that is not a boolean is `400 invalid_request`.
- `200 { dryRun: true, diff, revision, suspendedMappings }`. Nothing is written, and no audit row is written.
- To save after the preview, send `revision` back as `expectedRevision` in the real PATCH. If the printer changed in between, the save is refused with `409 revision_mismatch`.
- Every other refusal is the write's own (`400 <code> {problems}`, `409 <code>`, `404`). The real write still answers `200 { diff, printer, suspendedMappings }`.

**`POST /v1/admin/products`** and **`PATCH /v1/admin/products/:productId`**, the `moreInfo` refusal (first builder).
- If the only fault in the body is HTML in `moreInfo` that the HTML check refuses, the answer is `400 { error:{ code:"invalid_request", field:"moreInfo", message, reason } }`. `reason` is one of the `HtmlRefusal` values (`src/content/html-refusal.ts`).
- Any other fault, alone or together with this one, is the plain `400 invalid_request`. The code stays `invalid_request`.

**`POST /v1/admin/members/:userId/resend-invite`** (this builder). Same-origin. Acting-as is allowed. No body is read.
- `202 { invite: { userId, surface: "admin", expiresAt } }`: the platform invite route's shape. A new 72-hour link is queued and the previous unused link is dead. The answer never carries the token, the link or the address.
- `409 not_invited` ("The admin has already set a password"): the person's `invited` is false.
- `409 not_invitable` ("The identity cannot be invited"): the platform suspended the identity (refused by `issueInvite` itself).
- `429 rate_limited` (with `Retry-After`).
- `503 email_unavailable`.
- `404`, the same body as the revoke's: a malformed id, an unknown id, another shop's admin (invited or not), or a revoked member of this shop. Also `404` while `EMAIL_QUEUE` or `CANONICAL_ORIGINS` is missing, as for the add.

**`GET /v1/platform/print-jobs`** (this builder). A read, so no Origin is needed.
- Query, every key optional and given at most once:
  - `state=none|in_production|produced|shipped`: the line's `production_state`. `none` means NULL.
  - `dispatchState=none|pending|submitting|accepted|unknown|failed|cancelled`: the line's `dispatch_state` (the 0022 set). `none` means NULL.
  - `tenantId`: the tenant-id grammar.
  - `printerId`: `isPrinterId`.
  - `cursor`: the last `jobId` of the previous page.
  - `limit`: 1 to 100, default 50.
- `200 { jobs: [row], nextCursor: string|null }`.
- Each row has exactly these fields: `jobId, tenantId, shopName, orderId, orderNumber, orderStatus (added by the reviewer: the status route refuses a cancelled order and one refunded to its charge, so the console can hide its buttons), lineNo, name, sku, variantLabel, quantity, printerId, printerJobRef, dispatchState, dispatchedAt, state, trackingNumber, trackingUrl, carrier, createdAt, updatedAt`.
- `400 invalid_request`: an unknown key, a repeated key, or a malformed value. Values are case-sensitive and empty values are refused.
- `404`: a refused caller (anonymous, a tenant admin, a print operator, any `X-Shop-Id`) or any method other than GET. The body is byte-identical to `GET /v1/platform/dispatch` and `GET /v1/platform/tenants` for the same caller (tested). A refused caller gets the 404 before the query is looked at.

## 2. Decisions in my two parts

### The resend

- **"Still invited" uses the list's definition.** `invited` is the negation of `ownPasswordSql`. A "member" is someone the list shows: an active admin membership whose identity is a `tenant_admin`, active or suspended. That predicate is now `LISTED_MEMBER`, shared by the list and the resend.
- **Both facts are re-checked inside the batch.** Both go into `issueInvite`'s `condition`, with binds `[tenantId, userId, userId]`, and are evaluated in the same batch that supersedes the old link and records the new one.
  - Tested with a D1 proxy that makes the change just before that batch:
    - Revoked in between: 404, no mail, the old invite is still `issued`, its token row is still there, and the old link still sets a password.
    - Password set in between, through the old link: 409 `not_invited`, no mail.
  - Mutations, each seen failing: without the condition both race tests fail; with only the membership half the password race fails; with only the password half the revoke race fails.
- **Refusals are named by reading again.** After a refused batch, `issueInvite` only says `not_invitable`. A second read then decides the answer: no longer listed means 404, a password means `not_invited`, otherwise `not_invitable`. This is the write-decides, read-names pattern of `grantMembership`.
- **Rate limits reuse the add's two buckets.** `issueInvite` has no throttle of its own, and the platform invite has no limiter.
  - The shop bucket (20 per hour) counts every admitted resend, including 404s.
  - The address bucket (3 per hour, across shops) is keyed on the stored address lowercased, which is how the add keys it.
  - So adds and resends to one inbox share one cap (tested across two shops).
  - The address bucket is spent only once a link is owed. A `not_invited` refusal does not spend it, so clicking resend on a colleague who has a password cannot block that colleague's invites for an hour. The mutations that drop the pre-check, give the resend its own shop scope, or drop the address limiter each make a test fail.
- **Audit.** The row is `platform.user_invite`, with `tenant_id` set to this shop and actor set to the session user. The metadata is `issueInvite`'s keys plus `resend: true`, plus `actingAsGrantId` when acting as the shop. It never holds the address, the token or the link (tested).
- **Self.** Your own id gives `not_invited`, because you have a password. An acting-as operator is never listed, so their own id is a 404.

### The print-jobs list

- **A job is a printer line**, meaning `production_json IS NOT NULL`, which is the status route's own test. The non-POD line is absent (tested).
- **Never selected:**
  - `production_json`: it holds the line's production cost, withholding and print-file keys.
  - Order money and cost totals.
  - Tiers, prices, margins and commission.
  - The line's sale price.
  - Buyer data: no email, no recipient, no country. This is less than the platform orders list, which carries the recipient.
  - `printerId` is read from the order's snapshot inside SQL, as `platform-orders.ts` does. The row is built field by field.
  - Tests: an exact key-set test, a scan of the body for cost, snapshot and buyer strings, and a mutation that adds a cost key fails two tests.
- **The order snapshot freezes no variant label.**
  - `name`, `sku` and `quantity` are frozen on the line.
  - `variantLabel` is the catalogue's current label, the same rule as the seller's order detail.
- **`none` filter values.** Without them the console's most common question, "accepted, nothing reported yet", could not be asked. `state=none` is accepted lines the printer has said nothing about; `dispatchState=none` is lines that are queued or parked before their first call. PS1's "parked" state is a fact of the outbox row, not of the line; the line simply stays NULL. Lost-answer jobs (`dispatchState=unknown`) are resolved by outbox id through `/v1/platform/dispatch`, which already lists them.
- **Order and cursor.** The list is ordered by `(order_id, item_index)` and the cursor is the last job id.
  - This is an order existing indexes serve.
  - It is not chronological, because order ids are random UUIDs. There is no time index on `order_items`.
  - The cursor condition is `order_id >= ? AND (order_id > ? OR item_index > ?)` rather than a row value, so either index can seek on it.
  - `CROSS JOIN` makes `order_items` the outer loop. Without it, the planner reorders the shop paths (a mutation fails three plan tests).
- **Which index each path uses** (pinned with `EXPLAIN QUERY PLAN`):
  - `tenantId` + `dispatchState`: `order_items_tenant_dispatch_idx (tenant_id=? AND dispatch_state=? [AND order_id>?])`. Only the line number within one order is sorted.
  - `tenantId` alone: the same index on `tenant_id=?`, then a sort of that shop's lines.
  - No `tenantId`: the `(order_id, item_index)` unique index, scanned in order or searched from the cursor. `dispatchState`, `state` and `printerId` are checked on each row, so one page can read up to every order line. This is the one path that is not selective.
  - `state` and `printerId` are in no index on any path.
  - Orders, tenants and variants are primary-key lookups.
- **`updatedAt`** is the line's `updated_at`. Only `recordProductionStatus` stamps it, so today it is "when the production state was last recorded", or the creation time if it never was.

## 3. Open questions

1. **Index for the cross-shop filters (reviewer's call; a migration, so not built).** Without `tenantId`, one page may read every order line. That is fine at today's volume. If it grows, migration 0053 could add `CREATE INDEX order_items_printer_jobs_idx ON order_items(dispatch_state, production_state, order_id, item_index) WHERE production_json IS NOT NULL` and the SQL would stay as it is.
2. **Should a row show whether the status route will refuse it?** The route refuses a cancelled or refunded order. The row has no order status, so the console finds out from the 409's `reason`. One more field (order cancelled or refunded) would let it hide the buttons.
3. **A queue failure on resend kills the old link** (existing `issueInvite` behaviour). If the queue refuses the job, the old link (possibly still valid) is already superseded and the new one is revoked, so the person has no live link until the next successful resend (tested: `superseded, revoked`).
4. **The add's invite audit row could now name the shop.** `inviteTenantMember` still calls `issueInvite` without `audit`, so the add's `platform.user_invite` row has no tenant and no acting-as grant (CP5_WC_REPORT, acting-as limitation). Passing the same `audit` option there is now a one-line change. Not done, because it is outside these two parts.
5. **Is `dispatchState=pending` needed?** It is in the 0022 set and so is accepted as a filter, but no writer sets it today.

## 4. Gates

Run after the last code edit, from `cloudflare/` unless noted.

- `npx tsc --noEmit`: exit 0, no output.
- `npx vitest run test/member-resend-invite.test.ts`: `Tests 17 passed (17)`.
- `npx vitest run test/platform-print-jobs-list.test.ts`: `Tests 22 passed (22)`.
- `npx vitest run`: **`Test Files 112 passed (112)` / `Tests 4522 passed (4522)`**. Before this builder it was 110 / 4483; the difference is 2 files and 39 tests. Two `Network connection lost` uncaught-exception lines print during the run; they were already there before this unit (CP6_PS1_REPORT notes them).
- `node guard/guards.test.mjs` (repo root): `guard: PASS`. The guard scans tracked files only, so I also grepped the new and changed files for the three guarded families: no match.
- Mutations, each restored and checked with `cmp`: 7 on the resend and 7 on the list, all caught. P7 removed the `CROSS JOIN` pin and was caught by the plan tests.
