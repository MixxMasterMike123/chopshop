# CP5-WA report: session and shop context (Worker)

Model: `claude-opus-5-5` (Opus 5.5).

Brief: `CP5_BRIEFS.md` §0, §0.1, §0.2 and "WA. Session and shop context (Worker)". Working tree only: no git write, no network, no wrangler, no deploy.

## Files

| File | |
|---|---|
| `cloudflare/src/auth/session-self.ts` | new: the live reads behind `/v1/me` |
| `cloudflare/src/routes/admin-session.ts` | new: `GET /v1/me`, `GET /v1/admin/shop`, `adminFeatures()` |
| `cloudflare/test/admin-session.test.ts` | new: 22 tests |
| `cloudflare/src/lib/origins.ts` | edited: keys `admin` and `platform` |
| `cloudflare/src/auth/password-reset.ts` | edited: reset and invite links land on the admin surface |
| `cloudflare/test/origins.test.ts` | edited (+3 tests, +4 refused shapes; the old "unknown key" example was `admin`, now `print`) |
| `cloudflare/test/password-reset.test.ts` | edited: expectations read from the config; new block "with the admin origin listed" (6 tests) |
| `cloudflare/test/invites.test.ts` | edited: **not in my list**, see Deviations 1 |
| `cloudflare/src/app.ts` | only inside `CP5-IMPORTS-A` and `CP5-ROUTES-A` |

No migration.

## Routes

Both are registered with exact paths and `onMethods(["GET"])`. Any other method falls through to the opaque 404. Both answer `Cache-Control: no-store` (`jsonResponse`).

**`GET /v1/me`** (no `X-Shop-Id`)

```json
200 { "user": { "id": "…", "email": "…", "name": "…" },
      "accountType": "tenant_admin" | "platform_admin",
      "platform": false,
      "memberships": [ { "tenantId": "…", "shopName": "…", "status": "active", "published": true, "role": "admin" } ],
      "actingAs":    [ { "tenantId": "…", "shopName": "…", "expiresAt": "2026-10-03T18:00:00.000Z" } ] }
401 { "error": { "code": "unauthenticated" } }
400 { "error": { "code": "invalid_request", "message": "Request is not valid" } }   X-Shop-Id present
```

- **401** in every one of these cases, with the same body: no session, a forged cookie, an identity that is `suspended` or `revoked`, or an account type the admin does not serve (`print_operator`, `ordinary`). The body is exactly the contract's, with no `message`.
- **`user`** comes from the Better Auth `user` row; `name` is that row's `name`.
- **`memberships`** is filled for a tenant admin only. It lists the user's `admin` memberships whose status is `active`. The shop's `status` is the tenant's status, so a suspended or closed shop is listed with that status. The list is ordered by tenant id, capped at `SESSION_LIST_LIMIT` = 100, and has no cursor (the contract has none). Rows with role `customer`, `b2b_customer` or `affiliate` are never listed.
- **`actingAs`** is filled for a platform user only, with one row per shop. It uses the predicate of `findActiveActingAsGrant`: the grant is not revoked, `expires_at > now`, and the shop is active (the caller already checked the identity). Of several live grants on one shop, the latest expiry is listed. The same 100 cap applies.
- Why each list belongs to one account type: `authorizeTenantAdmin` admits only a `tenant_admin` identity, and `findActiveActingAsGrant` admits only a `platform_admin` one. Each list therefore shows only what an admin request would actually admit.
- **`X-Shop-Id` is REFUSED, with 400, before the session is read.** This follows D70: a request that names a shop is made in that shop's context, and `/v1/me` is not a shop's read. It is the platform guard's rule. 401 or 404 would wrongly tell the client "signed out" or "gone" for a fault in the client's own request. The admin client (`src/api/admin/client.js`, `getMeRaw`/`sessionIsGone`) never sends the header there.
- `shopName` can be `null` when a tenant row has no name (`tenants.shop_name` is nullable). The contract shows a string.

**`GET /v1/admin/shop`** (`X-Shop-Id`; a membership or an acting-as grant, through `authorizeTenantAdminRequest`)

```json
200 { "shop": { "tenantId": "…", "shopName": "…", "supportEmail": "…", "status": "active", "published": true,
                "defaultLocale": "sv-SE", "currency": "SEK", "vatRateBp": 2500,
                "features": { "affiliate": false, "b2b": false, "ambassador": false, "campaigns": false,
                              "dining": false, "writers": false, "abandonedCheckout": false,
                              "contentStudio": false, "discountCodes": false, "marketingMaterials": false,
                              "pod": true, "productReviews": false, "pickup": true } } }
404 opaque                       as every admin route
```

- **404** for: no session, no or malformed `X-Shop-Id`, a foreign shop, an unknown shop, a platform user without a grant, a suspended or closed shop (`authorizeTenantAdmin` and the grant both require an active tenant, so this route behaves as every admin route does), a revoked membership, and a deactivated identity.
- The tenant row is read by named columns (`tenant_id, shop_name, support_email, status, published, default_locale, default_currency, vat_rate_bp`). `readTenantDetail` is deliberately not called: it carries the commission and the Connect facts, and rule 15 keeps those off every seller surface. A test checks that the body holds no `commission`, `stripe`, `connect`, `acct_`, `catalogVersion`, `cost` or `printer`.
- `features` is built by `adminFeatures(readTenantFeatures(...))`:
  - each `tenant_features` key = its effective value AND membership in the storefront's `PORTED_FEATURE_KEYS` (today only `pod`, D81);
  - `NOT_PORTED_FEATURE_KEYS` (`affiliate`, `b2b`) and `DELETED_FEATURE_KEYS` (`ambassador`, `campaigns`, `dining`, `writers`) are `false`;
  - `pickup` is a core key and always `true`.

  Together these are every key `AppLayout.jsx` and the wagon map read. A test checks that each is a boolean.
- The shop read is not limited by acting-as: an open grant admits it, and ending the grant (`DELETE …/acting-as`) closes it again (tested).

## Where reset and invite links land, and what decides it

`resetPageOrigin(origins, surface)`:

| Allowlist (`CANONICAL_ORIGINS`) | ordinary reset (`request-password-reset`) | tenant-admin invite | platform-user invite |
|---|---|---|---|
| lists `admin` (CP5 wiring) | `<admin>/reset-password` | `<admin>/reset-password` | `<platform>/reset-password`, where `platform` = `admin` unless the var names another (D102) |
| no `admin` (production today, where `origins.admin` is pinned null until D7) | `<web>/reset-password` (transitional, as before CP5) | the same | the same |

- The emailed link is `AUTH_BASE_URL/api/auth/reset-password/<token>?callbackURL=<page>`. The token flow is unchanged.
- On the redirect, `canonicalResetLinkRequest` keeps a callback only when it is exactly one of the pages above. Anything else becomes the admin page. That includes a pre-CP5 link whose callback is the storefront page.
- Better Auth now trusts as reset pages only the admin and platform origins (`resetPageOrigins`). Once `admin` is listed, the storefront origin is no longer among them (tested on `createAuth(...).$context.trustedOrigins`).
- The ordinary reset does not look up the account type. It answers before Better Auth knows whether the address exists, and the admin host serves the platform tree too (D102).
- `origins.ts` accepts `admin` as optional. `platform` is also optional and defaults to `admin`. `platform` without `admin` is refused, and so is any other key. Each value must be a bare https origin, as before.

## Tests and gate

- `npx tsc --noEmit`: clean.
- My files: `admin-session` 22, `origins` 33, `password-reset` 26, `invites` 21. Together: `Test Files  4 passed (4)` / `Tests  102 passed (102)`.
- Full suite (`npx vitest run`): **`Test Files  2 failed | 93 passed (95)` / `Tests  2 failed | 4104 passed (4106)`**. Both failures belong to unit WB's work in progress (the admin order detail gains fields), not to WA:
  - `test/refunds.test.ts` › "GET /v1/admin/orders/:orderId › returns the money facts with ONE fee figure and the payout card": the detail now carries `items`, `customerEmail`, `fulfilment`, …;
  - `test/slice/vertical-slice.test.ts` › "CP2 vertical slice": "admin read: key sku" fails its denylist.
- **Wired run.** The full suite also ran under a temporary copy of `vitest.config.ts` with `CANONICAL_ORIGINS.admin: "https://admin.test.invalid"`; the copy was deleted right after. Result: `Test Files  3 failed | 93 passed (96)` / `Tests  4 failed | 4111 passed (4115)`. That is the same 2 WB failures plus 2 in `test/connect-onboarding.test.ts` (see Reviewer wiring 3). Every reset and invite test passes with `admin` listed.
- `node guard/guards.test.mjs`: `guard: PASS` (2111 tracked files, baseline 298). My new files are untracked, so I searched them myself: no earlier brand name, no resale-feature name, no Firebase import.

## Deviations from the brief, with the reason

1. **I edited `cloudflare/test/invites.test.ts`, which my list does not name.** One of its cases ("takes each surface's origin from the allowlist once it lists one") pins `password-reset.ts` behaviour. It calls `resetPageOrigin(…, "web")`, which no longer type-checks, and expects a doctored callback to become the web page. That behaviour is exactly what the brief removes. I changed that case to the new rule. I also made its two landing expectations, and the origin of its reset POST, read from the config instead of hard-coding `web.test.invalid`, so the file passes before and after the wiring. No invite logic or other case changed. `invites.ts` is untouched; it already chose `admin` or `platform` by account type.
2. **A transitional web fallback while `admin` is not listed.** The brief says "no link lands on the web origin any more". That holds wherever `CANONICAL_ORIGINS.admin` is set. Without it, links land on `web` as before CP5. Why not fail closed:
   - production pins `origins.admin` null until D7, and has no admin Worker;
   - making the reset and invite routes dark there would also turn off invites;
   - it would have broken every invite and reset test under the shared test config, which I may not edit.

   `connect-onboarding.ts` already uses the same fallback for its return URLs. If you prefer dark, it is a one-line change in `resetPageOrigin`.
3. **`/v1/me` with `X-Shop-Id` → 400** (the brief left the choice open). Reason above.
4. **`features` also carries the deleted and not-ported keys as `false`, and `pickup: true`.** `pickup` appears in the contract's example and is core. The other keys make the "every key the menu reads" rule hold even for a client that defaults a missing legacy key to ON, as the Firebase context does. FA's provider treats a missing key as off, so nothing breaks either way.

## Not done

- No `/v1/me` paging (the contract has none; bounded at 100 per list).
- No lookup of the account type for the ordinary reset (see above).

## Reviewer wiring

1. **API `cloudflare/wrangler.jsonc`, `env.staging.vars.CANONICAL_ORIGINS`**: add `"admin": "https://chopshop-admin-stg.kent-ee2.workers.dev"` (= pinned `origins.admin`; another unit already edited `pinned.staging.json` in the tree). Add no `platform` key: it defaults to `admin` (D102), and the preflight deep-equals the pinned origins, which have none. Production stays `{api, web}` while `origins.admin` is null (D7). Then regenerate `worker-configuration.d.ts` (`wrangler types --env=staging`).
2. **`scripts/cf-preflight.sh`**: flip `CANONICAL_ORIGINS_CARRY_ADMIN = False` → `True`. The flag is already in the tree, from the unit that built `--admin`. `origins.ts` now knows the key, and an unknown key is still refused. `AUTH_TRUSTED_ORIGINS` += the admin origin is not needed for resets (reset pages are trusted through `resetPageOrigins`), but WX needs it for sign-in. It is already in the tree.
3. **`cloudflare/vitest.config.ts`** `miniflare.bindings.CANONICAL_ORIGINS`: add `admin: "https://admin.test.invalid"`. My suites pass with and without it (verified both ways). Under it, `test/connect-onboarding.test.ts:674-680` (the expected `refreshUrl`/`returnUrl` on `https://web.test.invalid`) and `:699` (`origin === "https://web.test.invalid"`) must expect `https://admin.test.invalid`. That is `connect-onboarding.ts`'s own documented rule, "once an `admin` surface is listed it is used", and its suite is not mine.
4. **The admin Worker**: no API-side change is needed for `/v1/me` beyond its allowlist entry (WX has `/v1/me` as an exact path).
5. **Stale comment, not mine:** `cloudflare/src/auth/create-auth.ts:30-34` still says the ordinary reset lands on "the WEB page". It now lands on the admin page.

## Open questions

- Should the transitional web fallback (Deviation 2) go dark instead once production has its admin domain? It never applies wherever `admin` is listed.
- `onboardingReturnUrls` builds `<admin>/admin/payments?...`. On the admin host (D102) the admin tree is "everything not under `/platform`", so `/admin/payments` must be a route of FA's admin tree. Worth checking against `src/admin-app/pages.jsx`.
