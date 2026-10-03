Model: claude-opus-5-5 (Opus 5.5)

# CP5-FA report: the admin build, the client, the providers, the sign-in pages

Built on `cf-port` at HEAD `2c154012`, in the working tree. No git command that writes, no wrangler, no deploy. One network side effect, stated under "What I looked at".

## (a) What leaves because its feature is not ported

**Controls on the pages of this unit**

| Page | Control | What happens |
|---|---|---|
| `ForgotPasswordPage` | the "Skapa ett konto" link (`/register`) | **Not removed** (deviation 1). There is no sign-up (accounts come by invitation, `auth-routes.ts`). The address has no route in the new build, so it lands on `/` and then `/login`. It was already a dead link on the old admin host: the old admin branch has no `/register` route either, so its catch-all sent it to `/`. |
| `LoginPage` | "Kom ihåg mig" | Unchanged. It was never wired in the old build. The Better Auth session lasts 7 days whatever it says. |

**Routes that have no route in this build** (gap analysis §1b): `/admin/users/create` and `/admin/users/:userId/edit` (D100); `/admin/b2c-customers` and its `/:customerId`; `/admin/b2b-customers`; `/admin/marketing` and its `/:materialId/edit`; `/admin/customers/:customerId/marketing` and its `/:materialId/edit`; the six `/admin/affiliates…` routes; `/admin/discount-codes`; `/admin/reviews`; `/admin/content-studio`; `/admin/skatteuppgifter` (DAC7); the wagon routes of dining, ambassador, campaign and writers; `/__/auth/action`; `/handoff/:postId`; the landing page at `/` (D103). On the platform host: `/models`, `/dac7`, `/leads`. An address of a removed route goes to `/` as before: `/login` when signed out, `/admin` when signed in.

**Menu entries.** The shells belong to FB. The data that drives them is settled here:

- `AppLayout`: the entries gated by a feature disappear **without editing AppLayout**. This build's `isEnabled(key)` is true only for a literal `true` from `GET /v1/admin/shop`, and the API sends `false` for every feature that is not ported (D81). That covers Marknadsföring, Affiliate, B2B-kunder, Rabattkoder, Recensioner, Innehållsstudio, and the Dining entry in the topbar.
- `AppLayout`, not feature-gated, pointing at a page that left: "B2C Kunder" (`/admin/b2c-customers`) and "Mina skatteuppgifter" (`/admin/skatteuppgifter`). FB removes these from its data list.
- `PlatformLayout`: "3D-modeller", "DAC7" and "Leads" leave. FB does this.

## (b) Every context member a launch-scope file reads, and what the replacement does

Found by grep over every file of gap analysis §1a: the auth shell, the admin pages, the platform pages, the POD wagon and the studio. The method was `useAuth()` destructuring, member access on `currentUser`/`userProfile`/`userData`, `isEnabled('…')`, `useOrder()` destructuring, and `useStoreSettings()` reads.

**`useAuth()`** → `src/admin-app/providers/Session.jsx`

| Member | Read by | Replacement |
|---|---|---|
| `currentUser` | PlatformTermsGate, AdminRoute, PlatformRoute, AppLayout, ImpersonateShopModal, PlatformLayout, AdminDashboard, AdminPageEdit, AdminPages, AdminSettings, PlatformReports, PlatformUsers | **provided**: `{uid, email, displayName}` from `/v1/me` `user` |
| `currentUser.uid` | AdminPageEdit, AdminSettings, PlatformPrinters, PlatformReports, PlatformUsers, ArtworkUploadModal | **provided** (the Better Auth user id) |
| `currentUser.email` | AppLayout, PlatformLayout | **provided** |
| `userProfile` / `userData` | PlatformTermsGate, AdminRoute, AppLayout | **provided**, same object |
| `userProfile.role` | PlatformTermsGate, AdminRoute, AppLayout | **provided**: `'admin'` for both account types the admin serves. A platform user was role admin + platform true in Firebase too, so AdminRoute passes a platform user who is acting as a shop. `null` otherwise. |
| `userProfile.companyName` | AppLayout (a fallback of the shop name) | **absent** (undefined). The fallback chain continues with the e-mail. |
| `isAdmin` | AdminCollections, AdminProducts | **provided** |
| `isPlatform` | PlatformTermsGate, ProductForm, AppLayout, AdminOrderDetail, AdminPayments, PlatformRoute | **provided**: `accountType === 'platform_admin' && platform === true` |
| `loading` | AdminRoute, PlatformRoute | **provided** |
| `login` | LoginPage | **provided**: Better Auth sign-in, then `/v1/me`. If the account is not one the admin serves, or is deactivated, it signs out again and rejects. |
| `logout` | AppLayout, PlatformLayout | **provided**: ends every open acting-as grant (`DELETE /v1/platform/tenants/:id/acting-as`), signs out, and clears the tab's shop |
| `getAllUsers`, `updateUserRole`, `updateUserMarginal` | AdminUsers | **refused** (`not_available`). D100: FH rebuilds the page on WC's member routes. |
| `resetPassword` | via `useSimpleAuth()` in ForgotPasswordPage | **provided** (the alias of SimpleAuthContext hands over the session's) |
| `updateUserEmail`, `updateUserPassword`, `updateUserProfile`, `updateAnyUserProfile`, `toggleUserActive`, `createUserProfile`, `sendCustomerWelcomeEmail`, `deleteCustomerAccount` | no launch-scope file | **refused** (`not_available`), names kept |
| `error`, `isDemoMode` | none | provided (`isDemoMode` is `false`) |
| new: `confirmPasswordReset(token, pw)`, `refresh()`, `me`, `accountType`, `memberships`, `actingAs` | ResetPasswordPage; FB | provided |

**`useShopId()`** → `src/admin-app/providers/ActiveShop.jsx`. It is read by AppLayout, AdminCollectionEdit, AdminCollections, AdminDashboard, AdminMenu, AdminPageEdit, AdminPages, AdminPayments, AdminPlatformTerms, AdminProducts, AdminSettings, AdminStorefront and PodAdminPage. **Provided**: the active shop id, or `UNRESOLVED_SHOP_ID` as before. `useActiveShop()` is new: `{shopId, shop, memberships[+usable], actingAs, usableShopIds, setActiveShop}`.

**`config/activeShop.js`** (AppLayout, ShopPicker, AdminShopIdIntake read `setDeepLinkShopId` and `setLastPickedShopId`): **provided** through the alias. All the getters, setters and subscribers map onto the one choice per tab.

**`useShopFeatures()`** → `providers/ShopFeatures.jsx`. **Provided**: `{features, loading, isEnabled}`. The keys read: `pod` (ProductForm, AdminProducts, AdminSettings, PodAdminPage); `abandonedCheckout` and `productReviews` (AdminSettings); `marketingMaterials`, `affiliate`, `discountCodes`, `productReviews`, `contentStudio` and `dining` (AppLayout). Every one of these except `pod` reads `false` from the API (D81). `features.pod` is also read in ProvisionShopModal, PlatformShopDetail and PlatformAddons, but from their own documents, not this context.

**`useStoreSettings()`** → `providers/StoreSettings.jsx`. It is read only by AppLayout: `shopName`, `legalName`, `logoUrl`. `shopName` is **provided** (from `/v1/admin/shop`). `legalName` is **provided** when the saved identity holds it, otherwise the STORE default. `logoUrl` is **provided** when `logoObjectId`'s metadata answers an address; otherwise it is the default (see open question 4). Every other STORE key is merged as before.

**`useOrder()`** → `providers/Orders.jsx`. The members read: `getAllOrders`, `updateOrderStatus`, `loading`, `error` (AdminOrders) and `getOrderById`, `updateOrderStatus`, `deleteOrder` (AdminOrderDetail). They are **stubbed**. Every function rejects with `not_available` until FD fills them. `deleteOrder` stays a refusal for good (D68). `PRODUCT_SETTINGS` is not carried, and no launch-scope file reads it.

**`useTranslation()`** (AppLayout, LanguageSwitcher, OrderStatusMenu, AdminDashboard) → `src/storefront/providers/Translation.jsx`, reused read-only. **Provided**. Keys missing from `src/locales/sv-SE.json` fall back to the Swedish text in the code, as the old context did for a key Firestore lacked:

| Namespace | Missing keys |
|---|---|
| `admin.dashboard.*` | 11 |
| `nav.*` | 25: `nav.admin_admins`, `_collections`, `_menu`, `_pages`, `_payments`, `_storefront`, `_dac7`, `_b2c_customers`, `_b2b_customers`, `_discount_codes`, `_reviews`, `_content_studio` (+ their `_desc`), `nav.search` |
| `order_status.*` | 7: `completed`, `invoiced`, `paid`, `partially_refunded`, `printed`, `ready_for_pickup`, `refunded` |
| `reset_password.*` | 19, the new page |

46 of the 108 keys these files use are present.

## What exists

| File | What it is |
|---|---|
| `vite.admin.config.js` | The build: `index.admin.html` produces `cloudflare/admin/dist` (`index.html`, `assets/`, the favicons, `images/logo.svg`). It holds the alias list (12 rows, the storefront's mechanism copied), the dev server's HTML fallback, the dev API, and the `ADMIN_API_ORIGIN` proxy (which rewrites `Origin` to the target). |
| `index.admin.html` | The shell: the favicons, `noindex`, and the Google Fonts link of `index.html` |
| `src/admin-app/main.jsx` | Picks the tree: `/platform…` mounts `PlatformApp`, anything else `AdminApp` (D102) |
| `src/admin-app/AdminApp.jsx` | The admin router, as the `ADMIN_ROUTES` data table. It mirrors App.jsx's admin branch for the launch scope. `/` goes to `/login` or `/admin` (D103). `/admin/pod` is a static route behind `AddonGate feature="pod"`. A platform user with no grant who lands on an admin address goes to `/platform/`. |
| `src/admin-app/PlatformApp.jsx` | `basename="/platform"`. `PLATFORM_ROUTES` behind PlatformRoute. `/platform/login` does a full load of `/login`. |
| `src/admin-app/Providers.jsx` | Session → ActiveShop → ShopFeatures → StoreSettings → Translation → Orders |
| `src/admin-app/pages.jsx` | One line per page: 3 sign-in pages live, 15 admin and 6 platform stand-ins |
| `src/admin-app/Pending.jsx`, `NotFound.jsx` | `pending(name)` (admin tokens) and `pendingPlatform(name)` (gray-950). NotFound navigates to `/`, as App.jsx's catch-all did. |
| `src/admin-app/ResetPasswordPage.jsx` | The new page |
| `src/admin-app/providers/{Session,ActiveShop,ShopFeatures,StoreSettings,Orders}.jsx` | The replacements |
| `src/admin-app/providers/{activeShopStore,shapes}.js` | The pure parts: the tab's choice (sessionStorage, try/catch), `featuresOf`, `settingsFromAdmin`, `mergeSettings` |
| `src/admin-app/replacements/{SimpleAuthContext.jsx,activeShop,shopConfig,urls,credentialTranslations}.js` | Alias targets |
| `src/admin-app/adapters/money.js` | `minorToKronor`, `kronorToMinor`. Time lives in `src/api/admin/time.js` (one place, PLAN §2.8). |
| `src/admin-app/dev/{dev-api.mjs,fixtures.json}` | The dev API |
| `src/api/admin/{client,session,uploads,time}.js` | The client |
| tests | `src/api/admin/{client,session,uploads,time}.test.mjs`, `src/admin-app/{providers/shapes,adapters/money,dev/dev-api}.test.mjs`: 78 tests |

**Run it locally:** `npx vite --config vite.admin.config.js`, then open `http://localhost:5173/login`. Sign in as `admin@example.com` / `dev-password-1` (tenant admin; Test Shop A active, Test Shop B suspended) or `platform@example.com` / `dev-password-2`. The reset link is `/_api/api/auth/reset-password/devresettoken0000000001`.

### The client (`src/api/admin/client.js`)

- `adminRequest(method, path, {json, body, contentType, shopId, idempotencyKey, signal})`: `/v1/admin/…` only. It sends `X-Shop-Id` = `shopId` or else the active shop. With neither, it rejects `no_shop` and sends nothing.
- `platformRequest`: `/v1/platform/…` only. It never sends `X-Shop-Id`, and naming a shop is refused before anything is sent.
- `authRequest`: `/api/auth/…` only.
- `getMeRaw`: answers null on a 401.
- Every request goes to `/_api<path>` with `credentials: 'same-origin'`.
- One error type, `AdminApiError {status, code, message, reason, details, retryAfterSeconds}`. It reads both the API's `{error:{code,message,reason}}` and Better Auth's `{code,message}`.
- On a 404 from an admin or platform route, the client re-reads `/v1/me` once, shared between concurrent 404s. A 401 there tells the `onSessionLost` listeners and rejects `unauthenticated`. Anything else, including a `/v1/me` that cannot be reached, lets the 404 stand.
- The ActiveShop provider sets the active shop **while rendering** (`setRequestShopId`). Effects run child-first, so a page's first effect already sends the right `X-Shop-Id`.

**`session.js`**: `getMe`, `signIn`, `signOut`, `requestPasswordReset`, `resetPassword(token, pw)` and `endActingAs`. Its pure functions are `authStateFromMe`, `usableShopIds`, `resolveActiveShopId` and `shopEntryOf`.

The active shop is decided in this order:
1. `?shopId=` on arrival.
2. The tab's earlier choice.
3. The only usable shop.
4. Otherwise none, and the shell shows the picker.

Only shops the user may use count at each step. For a tenant admin that is a membership with `status === 'active'`; for a platform user, an unexpired grant. The resolved shop is written back as the tab's choice, so a reload keeps it.

**`uploads.js`**:
1. Hashes the file with Web Crypto (sha256).
2. Reserves: `POST /v1/admin/objects {contentType, kind, sha256, sizeBytes, fileName≤200}`.
3. Uploads: `PUT …/:id/content` with the file as the body.
4. Returns `{objectId, url, object}`.

A failure after the reservation removes the pending row with `DELETE`. The caps known before sending are 15 MiB for a public image, 512 KiB for an SVG and 100 MB for a private object. `getObject` and `deleteObject` are also exported.

**`time.js`**: `toInstant`, `toTimestamp` and `toIso`.
- `toTimestamp` returns a frozen object with `toDate()`, `seconds`, `nanoseconds`, `toMillis()`, `toISOString()` and `valueOf()`.
- ISO text must name its zone.
- SQLite's `YYYY-MM-DD HH:MM:SS` is read as UTC.
- `YYYY-MM-DD` is Stockholm midnight. This is tested on both 2026 DST days.

### The sign-in pages

`LoginPage.jsx` and `ForgotPasswordPage.jsx` are **unedited** (`git diff` is empty). They reach this build only through the aliases: `AuthContext`, `SimpleAuthContext` and `credentialTranslations`, the last reading the static locale files.

`ResetPasswordPage`:
- It reads `?token=` (Better Auth's alphabet, 16–128 characters) and `?error=`.
- It checks that both fields are filled, that the length is 8–128 (Better Auth's defaults, `create-auth.ts` sets none), and that the two match.
- It sends `POST /api/auth/reset-password {newPassword, token}`, shows a toast, and sends the user to `/login`.
- `INVALID_TOKEN`, `PASSWORD_TOO_SHORT/LONG` and `rate_limited` each get their own message.
- An invalid or expired link shows the error block, with "Begär en ny länk" (`/forgot-password`) and "Tillbaka till inloggningen".
- It is built from LoginPage's and ForgotPasswordPage's own wrapper, switcher, field group, button, link, error block and spinner, class for class. No new token.

### The dev API

- `GET /v1/me`: 401 when signed out; `X-Shop-Id` is ignored.
- `GET /v1/admin/shop` and `GET /v1/admin/settings`: the opaque 404 without a session, without `X-Shop-Id`, for a suspended or foreign shop, and for a platform user without a grant.
- `/v1/platform/*`: 404 for anyone but a platform user, and for any request carrying `X-Shop-Id`. It has no routes yet; FB adds them.
- Better Auth: sign-in, sign-out, get-session, request-password-reset, the reset link (302), and reset-password with its refusals.
- Every answer carries `X-Admin-Dev: admin-dev-api-invented-data`. A test fails when a build holds that marker or a dev password.

## What I looked at

The pages were rendered by the admin dev server with the dev API and captured with the headless browser (`/private/tmp/fa-shots/`).

**Sign-in pages**
- `/login`, `/forgot-password`, `/reset-password` (valid token) and `/reset-password` (invalid token) were each captured at 1440×900 and 375×812, light and dark, with `.dark` put on `<html>`.
- None of the three pages has a `dark:` class and none uses an `admin-*` token, so dark equals light. That is the old build's behaviour: the sign-in pages are the "legacy auth look", and the toggle lives only in AppLayout.
- The reset page sits on the same surface as the other two: the same width (`max-w-md`), heading size, field group, blue button and link colour. No overflow at 375; the invalid-link layout closes cleanly.
- The error state (mismatch) at 1440 and 375, and the success toast on `/login` after the reset, were also captured.

**Comparison with the older build.** I ran the old dev server (`npx vite`, `src/App.jsx`) and shot `/login` and `/forgot-password` at 1440 and 375.
- The layout is identical: positions, sizes, colours, the switcher and the link row.
- The difference is the text. The old dev build ran against the Firestore emulator, which has no translations, so it showed the English fallbacks ("Sign in to your account"). The new build shows the Swedish from `src/locales/sv-SE.json` ("Logga in på ditt konto"), which is what production Firestore served, since the locale files are its export.
- The old dev build also shows its "Running in emulator mode" banner. That is dev-only.
- **Network side effect:** loading the old app's page made the browser fetch `js.stripe.com` and `m.stripe.com` (the old `App.jsx` tree loads Stripe.js at boot) and poll the local Firestore emulator. Nothing of mine; the old server was stopped right after.

**Flows exercised**
- Signed out on `/admin/orders`: sent to `/login`.
- A wrong password shows the error. The right one lands on `/admin`, a stand-in reading "AdminDashboard · test-shop-a · admin@example.com", with the tab named "Test Shop A".
- `/admin/pod`: shown (`pod: true`).
- `/admin/affiliates`: sent to `/admin`.
- `?shopId=test-shop-b` (suspended): ignored, stays on Test Shop A.
- `/` signed in: `/admin`.
- The platform user lands on `/platform/` ("PlatformShops"); `/platform/dac7` goes to `/platform`.
- A tenant admin on `/platform/shops` gets PlatformRoute's refusal and `/login`, as before.
- Console: the two React Router v7 flag warnings and a "setState while rendering" warning. The latter comes from AdminRoute and PlatformRoute calling `toast.error` during render, in files unedited and the same in the old build.

**Bug found while looking, and fixed:** `/admin/pod` bounced on a full load. While the session was still loading, ShopFeatures said "not loading, no features", and AddonGate turned the visitor away. While the session loads, features now count as loading.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 207  # suites 59  # pass 207  # fail 0          (mine: 78)
npx vite build --config vite.admin.config.js
  ✓ built in 1.83s   (index.html 1.63 kB, index.admin-*.js 286.53 kB, css 168.36 kB, en-GB/en-US lazy)
node cloudflare/admin/check-admin-build.mjs     (WX's, it existed by then)
  admin build: 10 files (6 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs
  storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build
  ✓ built in 11.45s
node guard/guards.test.mjs
  guard: 2111 tracked files scanned … guard: PASS
```

My new files are untracked, so I checked them myself. None carries the earlier brand or the resale word (one comment had the latter; it was rephrased). None imports Firebase. "Firebase" appears only in comments, which terser strips; the checker confirms none of it reaches the bundle. The bundle carries no `VITE_*` value, because every replacement reads its variable by name.

## Deviations from the brief

1. **The "Skapa ett konto" link stays on ForgotPasswordPage.** Rule 17 says a control of an unported feature leaves. The brief also says the two pages stay byte for byte and prefers not editing them, and removing the link edits the shared file. The link was already dead on the old admin host, so the page equals its baseline. Removing it is one line for whoever may edit the shared file. Mikael or the reviewer decides.
2. **The 404 → `/v1/me` rule also applies to platform routes**, not only admin ones: they answer the same opaque 404.
3. **`ShopFeatures.isEnabled` is false for a key the API does not name.** The old context read a missing legacy key as ON (`config/addons.js`). Here that would light up menu entries of features that do not exist; the API is said to send every key (§0.2).
4. **`saveShopConfig` refuses** (`not_available`) in the `shopConfig` replacement instead of being built. `PUT /v1/admin/settings` replaces the identity whole, and name, support address and VAT are refused keys (D99). A read-modify-write merge belongs to the units that own those pages (FE, FG), or to WD's PATCH. The loads are built.
5. **The `credentialTranslations` replacement keeps the chosen language under its own key** (`admin.credentialLanguage`). It does not read the legacy-brand key that `CredentialLanguageSwitcher` writes (rule 10).
6. **The reset token stays in the address bar.** At first I stripped it; a reload then showed "invalid link". It is single-use, valid for 1 h, and WX's `Referrer-Policy: same-origin` keeps it on this origin.
7. **`NotFound` is a redirect to `/`, not a page.** That mirrors App.jsx and adds no markup (the only new markup is the reset page).
8. **Extra files of my own:** `providers/{activeShopStore,shapes}.js` (the testable pure parts), `replacements/{SimpleAuthContext.jsx,activeShop.js}`, plus an alias row reusing `src/storefront/replacements/platform.js` (read-only) for `config/platform.js`. That last one is so a later page cannot inline `import.meta.env` whole.
9. **No `adapters/time.js`.** Time has its one place in `src/api/admin/time.js` (PLAN §2.8); a second path would be a copy.

## For the next frontend units: adding a page

1. Read the page's rows in `CP5_GAP_ANALYSIS.md` §2.
2. Write the calls in `src/api/admin/<area>.js`, using `adminRequest` (shop routes) or `platformRequest` (platform routes, never a shop). Test them in `src/api/admin/<area>.test.mjs` with a stubbed `fetch`, as `client.test.mjs` does.
3. Bridge the shapes in `src/admin-app/adapters/<shape>.js` (pure, plus `.test.mjs`). Use `toTimestamp()` from `src/api/admin/time.js` where the page calls `.toDate()` or `.seconds`, and `minorToKronor()` from `adapters/money.js`. Never recompute a payout or a floor (rule 15).
4. Edit only the page's imports and data functions. The contexts come through the aliases unedited. If the page, or a component it imports, reaches Firebase through a shared module, add a row to `ADMIN_ALIASES` in `vite.admin.config.js` pointing at a replacement in `src/admin-app/replacements/`.
5. Change the page's ONE line in `src/admin-app/pages.jsx`. A page that wraps `AppLayout` (every admin page) needs FB's shell first. A platform page needs `PlatformLayout` (FB).
6. Add dev-API rows to `ADMIN_ROUTES` or `PLATFORM_ROUTES` in `src/admin-app/dev/dev-api.mjs`, with invented fixtures in `fixtures.json` (Test Shop A/B, example.com addresses).
7. Run `node cloudflare/admin/check-admin-build.mjs`, the `node --test` line above, `node cloudflare/web/check-storefront-build.mjs`, `npx vite build` and `node guard/guards.test.mjs`.
8. Look at the page rendered with `npx vite --config vite.admin.config.js` against the old page.

Also useful: `useActiveShop()` gives the picker its list (`memberships` with `usable`, plus `setActiveShop`). `useAuth().refresh()` re-reads `/v1/me` after acting-as opens or closes. `useAdminShop()` gives the shop record.

## Open questions

1. The "Skapa ett konto" link: remove it from the shared ForgotPasswordPage? (Deviation 1.)
2. **Legacy-brand strings in the admin bundle.**
   - `CredentialLanguageSwitcher.jsx` is unedited and on the guard's allowlist. It writes `localStorage`/cookie keys named after the earlier brand, and they ship in `index.admin-*.js`.
   - When FB brings `AppLayout`, `useDarkMode`'s key will ship too; it is frozen by BP-2.
   - Rename both with a read-old-key migration, at the source and for both builds?
3. **A suspended shop.** The client counts a membership as usable only when its `status === 'active'`; the picker shows the others disabled. WA should confirm that admin routes refuse a suspended shop. If they serve it, the rule here is too strict.
4. **The logo and the tab icon.** `GET /v1/admin/objects/:id` answers `url: null` today (CP4-P deviation 2, `getAdminObjectMetadata` without `env`). Until the reviewer wiring there is done, the shell shows its wordmark and the default favicon.
5. **The CSP (WX).** The admin HTML loads Google Fonts (`fonts.googleapis.com` CSS, `fonts.gstatic.com` fonts), as `index.html` does. `ensureTemplateFonts` may add a template's font stylesheet at runtime (verbatim from the old provider), and the CSP must admit the same two hosts.
6. **Files outside what the Worker serves.** `templates.js` thumbnails (`/template-thumbs/*.png`) and the studio's `/pod-garments/*` and `/dev-3d/*` sit outside what WX serves (`/assets`, `/images`, top-level files). FG and FN must ask WX for those paths, or move the files under `/images/`.
7. **Where a user returns after sign-in.** A platform user sent to sign in from `/platform/…` lands on `/platform/` afterwards: the full load to `/login` drops router state. A tenant admin sent by `AdminRoute` lands on `/admin`, because AdminRoute's `<Navigate>` carries no `from`. That is parity with the old build. A session lost under a page does keep the page.
8. **`X-Shop-Id` on `/v1/me`.** The dev API ignores it. WA decides; the client never sends it there.
