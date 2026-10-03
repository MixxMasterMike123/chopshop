# CP5 builder briefs

Status: written 2026-10-03 on HEAD `2c154012`. Input: `CP5_GAP_ANALYSIS.md` (the route-by-route map; a builder reads the rows of its own pages there), `DECISIONS.md`, PLAN §2.1, §2.8, §2.9, §5. The pattern is CP4's: `CP4_BRIEFS.md` §0 and §F, `CP4_E_REPORT.md`, `CP4_F_REPORT.md`.

`$CF` = `cloudflare/`.

## 0. Rules for every builder

`CP4_BRIEFS.md` §0 rules 1–12 apply unchanged, with `CP5` for `CP4` (anchor blocks `CP5-IMPORTS-x` / `CP5-ROUTES-x` in `$CF/src/app.ts`, report `docs/cf-port/CP5_<X>_REPORT.md`). In addition:

13. **The first line of the report states the builder's model id.**
14. **Other builders work in the same tree at the same time.** Touch only the files the brief lists as yours. Never revert, reformat or "tidy" a file that is not yours; if a file of yours has changes you did not make, stop and say so in the report.
15. **The seller sees ONE number.** No admin route and no admin page carries a commission, a supplier or print cost, a printer tier, a printer's internal id or a job reference. A tenant admin reads "Inköp" per product and one fee per order, as the server gives them. The page never recomputes a payout or a price floor: it shows the server's.
16. **Every `/v1/admin/*` request carries `X-Shop-Id`; no `/v1/platform/*` request carries it** (D70: the Worker refuses it there).
17. **Frontend: only the data layer changes.** A page's markup, class names, tokens and copy stay byte for byte (`CP4_BRIEFS.md` §F "The rule that decides everything"). The shapes are bridged by adapters (`src/admin-app/adapters/`, pure, tested under Node); the contexts are swapped by the build's alias list (`vite.admin.config.js`), not by the pages; a page enters the build by its one line in `src/admin-app/pages.jsx`. A control whose feature is not ported leaves the page and the layout closes; each such removal is LISTED in the report before anything else.
18. **No Firebase code is reachable from the admin entry**: `node cloudflare/admin/check-admin-build.mjs` after every page. The older build (`npx vite build`, `src/App.jsx`) must keep building: it is the rollback artifact, and no file it needs is deleted.
19. **Gate before the report** (run what your unit touches, and say which you ran with the summary lines): Worker `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin && npx vitest run` (read "Test Files … failed" in the summary, not the last printed failure); frontend `node --test src/api/*.test.mjs src/api/admin/*.test.mjs src/admin-app/**/*.test.mjs src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs`, `npx vite build --config vite.admin.config.js`, `node cloudflare/admin/check-admin-build.mjs`, `node cloudflare/web/check-storefront-build.mjs`, `npx vite build`; always `node guard/guards.test.mjs`.

## 0.1 Decisions on defaults (Mikael may veto until the CP5 deploy)

| # | Decision | Default taken |
|---|---|---|
| D99 | May a seller rename the shop, change the support address or the VAT rate? | **No, read-only in the admin for now**; the platform sets them (`PATCH /v1/platform/tenants/:id`). No seller write route is built. |
| D100 | The old user pages are editors of trade customers (documents, margin). | `AdminUserCreate`/`AdminUserEdit` **leave**. `AdminUsers` becomes the list of the shop's own admins, with invite and revoke (unit WC). |
| D101 | Where platform-owned studio images (mockup templates, 3D models) live. | Open until CP6's unit WH. |
| D102 | One host for the admin and the platform console (PLAN §2.1 says one each). | **One host, one Worker `chopshop-admin`**: `/platform/*` is the platform tree, everything else the admin tree. Acting-as needs the platform user's session on the admin surface; D70 already separates the two per request. |
| D103 | The landing page and the leads page. | **Leave.** The admin root `/` goes to `/login` (signed out) or the admin (signed in). |

## 0.2 The two contracts every unit shares

**`GET /v1/me`** (unit WA; any signed-in user; no `X-Shop-Id`; `Cache-Control: no-store`):

```json
{ "user": { "id": "…", "email": "…", "name": "…" },
  "accountType": "tenant_admin" | "platform_admin",
  "platform": false,
  "memberships": [ { "tenantId": "…", "shopName": "…", "status": "active", "published": true, "role": "admin" } ],
  "actingAs": [ { "tenantId": "…", "shopName": "…", "expiresAt": "2026-10-03T18:00:00.000Z" } ] }
```

No session, a deactivated user, or a session of an account type the admin does not serve: `401 { "error": { "code": "unauthenticated" } }`. This is the ONE admin-surface route that answers 401 rather than the opaque 404, so the client can tell "signed out" from "not found" (gap analysis 0.6). Only live memberships and unexpired grants are listed.

**`GET /v1/admin/shop`** (unit WA; `X-Shop-Id`; membership or acting-as, as every admin route):

```json
{ "shop": { "tenantId": "…", "shopName": "…", "supportEmail": "…", "status": "active", "published": true,
            "defaultLocale": "sv-SE", "currency": "SEK", "vatRateBp": 2500,
            "features": { "pod": true, "pickup": true } } }
```

`features` holds every key the admin's menu reads, each a boolean; a feature that is not ported reads `false` (D81).

**The browser's addresses** (unit WX): the admin SPA calls `/_api/v1/admin/…`, `/_api/v1/platform/…`, `/_api/v1/me` and `/_api/api/auth/…` on its own origin, with `credentials: 'same-origin'`. Nothing else is proxied.

---

## WX. The admin Worker

**Goal.** A third Worker, `chopshop-admin`, serves the admin build and is a same-origin proxy to the API Worker's `Internal` entrypoint over a service binding, with the session cookie. Design and reasons: `CP5_GAP_ANALYSIS.md` §4. Template: `$CF/web/` (read all of `web/src/*`, `web/wrangler.jsonc`, `web/check-storefront-build.mjs`, and `CP4_E_REPORT.md`).

**Owns (all new):** `$CF/admin/**` (`wrangler.jsonc`, `tsconfig.json`, `src/{index,routing,forward,allowlist,headers,env}.ts`, `check-admin-build.mjs`), `$CF/test/admin-worker-*.test.ts`. Reviewer-only as always: `scripts/cf-preflight.sh`, `scripts/cf-deploy.sh`, `pinned.*.json`, the API's `wrangler.jsonc`, `vitest.config.ts` (say in "Reviewer wiring" exactly what each needs: the `--admin` preflight mode mirroring `--web`, the `admin` deploy target, pinned `adminWorkerName` and `origins.admin`, `AUTH_TRUSTED_ORIGINS` and `CANONICAL_ORIGINS.admin` of the API).

1. **Static:** serves `./dist` (the admin build; `dist` is git-ignored) with the SPA fallback to `index.html` for every path that is not `/_api/…` or a built asset; `/platform/*` and everything else get the same shell (the SPA picks the tree). Hashed assets immutable, the shell `no-store`.
2. **Proxy:** `/_api/<rest>` → strip `/_api` → `env.API` (entrypoint `Internal`). The forwarded request KEEPS the browser's host and scheme in its URL (the API's `isSameOriginRequest` compares `Origin` with the request URL's origin: the proxy must not make a cross-origin request look same-origin, and must not make a same-origin one fail). `Cookie` is forwarded, `Set-Cookie` is passed back unchanged, `Origin`, `Content-Type`, `Idempotency-Key`, `X-Shop-Id`, `If-None-Match`, `Accept` are forwarded; every `X-Tenant-*`/internal header a browser could forge is dropped (read what `Internal` trusts in `$CF/src/index.ts` and `$CF/web/src/forward.ts`, and say in the report which headers it trusts and that none can arrive from the browser); `CF-Connecting-IP` is passed as the web Worker passes it. Request bodies stream (uploads up to the object routes' cap).
3. **Allowlist:** prefixes `/v1/admin/` and `/v1/platform/`, the exact path `/v1/me`, and the exact Better Auth routes the API mounts (`$CF/src/auth/auth-routes.ts`). Everything else under `/_api/` is the opaque 404: no storefront route, no webhook, no render or staging route. A path with `..`, `//`, an encoded slash or a backslash is refused before matching.
4. **Headers on HTML:** enforced CSP (`default-src 'self'`; `img-src 'self' data: blob: <PUBLIC_OBJECT_BASE_URL> https://*.r2.cloudflarestorage.com`; `style-src 'self' 'unsafe-inline'`; `font-src` as the build needs; `connect-src 'self' https://*.r2.cloudflarestorage.com`; `frame-src` Stripe only if a page embeds it, else none; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`), `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`. Check the fonts and scripts the admin build really loads (read `index.html`, the Tailwind entry, any external font link) and list them in the report rather than guessing.
5. **`check-admin-build.mjs`:** builds `vite.admin.config.js` (unit FA writes it; until it exists the check must fail with a clear line, and your tests use a fixture `dist`) and refuses a build that holds Firebase code, a source map, a secret-looking key, or a file the Worker would not serve; model: `web/check-storefront-build.mjs`.
6. **Tests** (vitest, with a stub `API` binding): the allowlist (every refused family), header forwarding and stripping, `Set-Cookie` passed through with several cookies, the URL host kept, the SPA fallback, the CSP on HTML and not on JSON, a large streamed body.
7. **To verify by test and report, not assume:** that Better Auth, behind this proxy, accepts a sign-in whose request host is the admin host while `AUTH_BASE_URL` is the API's, and sets a cookie the admin host keeps (`$CF/src/auth/create-auth.ts`; read `node_modules/better-auth` where needed). If it does not, say exactly what the API needs (a trusted origin, a base-URL rule) under "Reviewer wiring"; do not edit the API.

---

## WA. Session and shop context (Worker)

**Goal.** The two contracts of §0.2, the `admin` canonical origin, and the password reset and invite links landing on the admin host.

**Owns:** new `$CF/src/routes/admin-session.ts`, `$CF/src/auth/session-self.ts`, tests `$CF/test/admin-session.test.ts`; edits `$CF/src/lib/origins.ts`, `$CF/src/auth/password-reset.ts` (+ their tests), its `CP5-…-A` blocks in `app.ts`.

1. `GET /v1/me` and `GET /v1/admin/shop` exactly as §0.2. Read `live-authorization.ts`, `request-authorization.ts`, `tenant-directory.ts`, `tenant-config.ts` (`readTenantFeatures`), `acting-as.ts`; reuse their reads, add none that duplicates one. `shopName` etc. come from where the platform detail reads them. A suspended or closed shop: listed in `memberships` with its status (the client shows it disabled); `/v1/admin/shop` behaves as every admin route does for it.
2. `origins.ts` gains the key `admin` (and `platform`, the same origin, D102). A reset or invite mail for a tenant admin or a platform user lands on `<admin origin>/reset-password?token=…` (the admin SPA's page, unit FA); a storefront has no accounts (D81), so no link lands on the web origin any more. Read `password-reset.ts:270-320`, `platform/invites.ts`, `auth-email-job.ts`; keep the token flow as it is.
3. Tests first for the refusals: no session → 401 on `/v1/me`, the opaque 404 on `/v1/admin/shop`; a membership revoked or a user deactivated after sign-in disappears from the next answer; an expired grant is not listed; `X-Shop-Id` on `/v1/me` is refused or ignored consistently with D70 (say which, and why); a foreign shop → 404.
4. No migration.

---

## FA. The admin build, the client, the providers, the sign-in pages (first of a kind)

**Goal.** `npx vite build --config vite.admin.config.js` produces `cloudflare/admin/dist` with a working shell: sign in, forgot password, reset password, the session, the active shop, the page table with every page as a stand-in, and a dev API so the next builders can run pages without the Worker. No Firebase code reachable.

**Owns (all new unless noted):** `vite.admin.config.js`, `index.admin.html`, `src/admin-app/{main,AdminApp,PlatformApp,Providers,pages,Pending,NotFound}.jsx`, `src/admin-app/providers/{Session,ActiveShop,ShopFeatures,StoreSettings,Orders}.jsx`, `src/admin-app/replacements/*`, `src/admin-app/adapters/*` (the shared ones only: time, money), `src/admin-app/dev/*` (dev API + fixtures, invented data only), `src/api/admin/{client,session,uploads,time}.js` + `*.test.mjs`, `src/admin-app/ResetPasswordPage.jsx`; the data layer of `src/pages/LoginPage.jsx` and `src/pages/ForgotPasswordPage.jsx` ONLY IF the alias list cannot carry it (prefer the alias: those pages call `useAuth()`).

Read first: `vite.storefront.config.js` (the alias mechanism: copy it, do not reinvent it), `src/storefront/{main,StorefrontApp,Providers,pages}.jsx`, `src/storefront/providers/*`, `src/api/client.js`, `src/storefront/dev/*`, `CP4_E_REPORT.md`; then `src/App.jsx` (the admin and platform route tables, the guards), `src/contexts/{AuthContext,ShopContext,ShopFeaturesContext,StoreSettingsContext,OrderContext,TranslationContext}.jsx`, `src/components/auth/{AdminRoute,PlatformRoute}.jsx`, `src/config/{urls,activeShop,impersonation,shopConfig,withShopId,tenancy}.js`, and `CP5_GAP_ANALYSIS.md` §1, §2a, §4.

1. **The client** (`src/api/admin/client.js`): `adminRequest(method, path, {json, shopId, idempotencyKey, signal})` adds `X-Shop-Id` (the active shop) and refuses to run without one; `platformRequest(…)` never sends it; `authRequest(…)` for `/api/auth/*`; all go to `/_api…` on the page's own origin with `credentials: 'same-origin'`. One error type with `status`, `code`, `reason`. On a 404 from an admin route the client re-reads `/v1/me` once: 401 → the session is gone → the Session provider sends the user to `/login` (keeping where they were); otherwise the 404 stands. `uploads.js`: sha256 of the file (Web Crypto) → `POST /v1/admin/objects` (reserve) → `PUT /v1/admin/objects/:id/content` → the object's id and address (read `$CF/src/storage/object-routes.ts` for the exact bodies and caps; unit P's report `CP4_P_REPORT.md`). `time.js`: the one place that turns the API's ISO text or milliseconds into what pages call (`.toDate()`, `.seconds`), per PLAN §2.8.
2. **Session provider** = the build's replacement for `AuthContext`: `useAuth()` keeps the shape the pages read (`currentUser {uid,email,displayName}`, `userProfile {role, …}`, `isAdmin`, `isPlatform`, `loading`, `login`, `logout`, `resetPassword`, and whatever else launch-scope files read: grep every `useAuth()` destructuring in the launch-scope files of the gap analysis §1a and list them in the report), fed by `GET /v1/me`. `login` = Better Auth sign-in then `/v1/me`; `logout` ends any open acting-as grant, then signs out. A function a launch-scope page calls that has no route (change e-mail, user CRUD of the old kind) throws a clear "not available" error and is listed in the report.
3. **ActiveShop provider** = the replacement for `ShopContext` (`useShopId()` and what else it exports): one membership → that shop; several → the picker (unit FB wires the picker; you expose `memberships`, `setActiveShop`); a platform user → no shop until acting-as is opened (unit FB). The active shop id lives in `sessionStorage` per tab (try/catch), and `?shopId=` on arrival is honoured when the user may use that shop. `ShopFeatures` and `StoreSettings` providers read `GET /v1/admin/shop` and `GET /v1/admin/settings`; `Orders` is the replacement shell for `OrderContext` with the same exports, each function a stand-in that unit FD fills. Translation: reuse `src/storefront/providers/Translation.jsx` (admin strings come from the same static locale files; if admin keys are missing from `src/locales/*.json`, list the missing namespaces in the report and fall back to the key's Swedish default as the old context does).
4. **Two trees, one build** (D102): `/platform/*` mounts `PlatformApp` with `basename="/platform"`, everything else `AdminApp`. Routes and guards mirror `src/App.jsx` for the launch-scope pages of the gap analysis §1a; a page not yet swapped renders `Pending` (its route exists, its name is shown); a page that leaves the build (gap analysis §1b) has no route. `/` → `/login` when signed out, else the admin dashboard route (D103). `pages.jsx` is ONE table, one line per page, that later units edit one line at a time.
5. **Sign-in pages:** `LoginPage`, `ForgotPasswordPage` unchanged in markup; `ResetPasswordPage` is new (it reads `?token=`, posts the new password to Better Auth's reset route, then sends the user to `/login`): build it from the SAME components and classes as `LoginPage` so it is the same surface (the admin is the "admin-neutral" surface: read `docs/cf-port/DESIGN_CONTRACT.md` §§ on the admin surface and the dark-mode key before writing any markup; no new colour, font or spacing token).
6. **Dev API** (`src/admin-app/dev/`): a small Node server or Vite middleware, like `src/storefront/dev/dev-api.mjs`, that answers `/v1/me`, `/v1/admin/shop`, `/v1/admin/settings`, the Better Auth sign-in/out/reset routes and 404 for the rest, from invented fixtures (two shops, one tenant admin, one platform user). Later units add their routes to it. `ADMIN_API_ORIGIN` proxies `/_api` to a real admin Worker instead.
7. **Tests under Node:** the client (headers per request kind, the 404→`/v1/me` rule, error mapping), `uploads` (against a fake fetch), `time`, the providers' pure parts.
8. **The build check** is unit WX's `cloudflare/admin/check-admin-build.mjs`; if it does not exist when you finish, verify "no Firebase code" yourself by searching the built files for `firebase` and `firestore`, and say so.

**The report lists first:** every control or menu entry that leaves the shell because its feature is not ported, and every `useAuth`/`useShopId`/context member a launch-scope file reads, with whether the replacement provides it.

---

## FB. The shells and acting-as (first of a kind) — after FA

**Goal.** A signed-in seller sees the admin layout with the launch-scope menu; a platform user sees the platform layout, picks a shop, opens acting-as with a reason, and works in the admin as that shop under a banner; the platform-terms gate and its page work.

**Owns:** `src/components/layout/AppLayout.jsx`, `src/components/platform/{PlatformLayout,ImpersonateShopModal}.jsx`, `src/components/admin/{ShopPicker,PlatformTermsGate}.jsx`, `src/components/auth/{ImpersonationBanner,AdminShopIdIntake}.jsx`, `src/pages/admin/AdminPlatformTerms.jsx`, their lines in `src/admin-app/pages.jsx`, `src/api/admin/{actingAs,legal}.js`, adapters and dev-API routes for them. Where a file is shared with the older build, the data layer is reached through an aliased module so the older build still builds; the menu's trimmed list for this build is data, not a fork of the markup.

1. Menu: only launch-scope entries (gap analysis §1a/§1b); POD is a static entry shown when `features.pod`. The wagon registry, presence and mention notifications are not imported in this build.
2. Acting-as: `POST /v1/platform/tenants/:id/acting-as {reason}` → the admin tree with that shop active; the banner shows the shop and the time left (from `/v1/me` `actingAs`), and "Avsluta" calls `DELETE`. After a reload the banner is restored from `/v1/me`. A grant that ran out sends the platform user back to the platform tree with a notice. What a platform user may NOT do while acting-as (accept terms, adopt legal pages, the Connect login link) shows the control disabled with the reason, never an error after the click.
3. Terms gate: `GET /v1/admin/legal/status`, `GET /v1/admin/legal/terms`, `POST /v1/admin/legal/accept-terms` (`$CF/src/routes/legal-admin.ts`; `CP3_E_REPORT.md`).
4. The design gate applies: look at each shell RENDERED (dev API), light and dark, 375/768/1440, against the same page in the older build; list every difference with its cause.

---

Units WB–WI and FC–FN: their rows in `CP5_GAP_ANALYSIS.md` §3 and §5 are the scope; each gets its full brief here before it is launched.
