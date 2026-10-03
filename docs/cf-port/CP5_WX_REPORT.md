Model: claude-opus-5-5

# CP5-WX report: the admin Worker (`chopshop-admin`)

Brief: `CP5_BRIEFS.md` §WX (with §0, §0.1 D102, §0.2). Background: `CP5_GAP_ANALYSIS.md` §4. Template: `cloudflare/web/` and `CP4_E_REPORT.md`. Built in the working tree on `cf-port` (HEAD `2c154012` plus other builders' uncommitted work). No git write, no network, no wrangler, no deploy.

## Files

| File | |
|---|---|
| `cloudflare/admin/wrangler.jsonc` | new: `chopshop-admin-unbound` top level (no bindings, no vars); `env.staging` `chopshop-admin-stg` and `env.production` `chopshop-admin`, assets `{./dist, ASSETS, run_worker_first, html_handling none, not_found_handling none}`, service `API → chopshop-api[-stg]`, entrypoint `Internal`, vars `ADMIN_ORIGIN` and (staging) `PUBLIC_OBJECT_BASE_URL` |
| `cloudflare/admin/tsconfig.json` | new: `npx tsc --noEmit -p admin`, the web Worker's settings |
| `cloudflare/admin/src/env.ts` | new: `AdminEnv`, `readAdminConfig`, `bareHttpsOrigin` |
| `cloudflare/admin/src/allowlist.ts` | new: `isAllowedAdminApiRequest`, `cleanSegments` |
| `cloudflare/admin/src/routing.ts` | new: `classifyAdminRequest` (pure) |
| `cloudflare/admin/src/forward.ts` | new: `forwardedAdminRequest`, `apiResponseForBrowser`, `FORWARDED_HEADERS` |
| `cloudflare/admin/src/headers.ts` | new: `contentSecurityPolicy`, `withAdminHeaders` |
| `cloudflare/admin/src/index.ts` | new: `handleRequest` (the glue) and the default export |
| `cloudflare/admin/check-admin-build.mjs` | new: the build check |
| `cloudflare/test/admin-worker-routing.test.ts` | new: 110 tests (pure rules) |
| `cloudflare/test/admin-worker.test.ts` | new: 37 tests (the glue, a spy API, and the real API app with Better Auth) |

No other file was touched. `cloudflare/admin/dist` is covered by the repository's `dist` ignore rule.

## What happens to which request

`ADMIN_ORIGIN` is the pinned admin origin.

| Request | Answer |
|---|---|
| any, `ADMIN_ORIGIN` missing or not a bare https origin | 503 `Unavailable` |
| a host other than the admin host | 404 (the cookie is host-only to the admin host and Better Auth trusts that origin only) |
| the admin host over `http:` | `GET` outside `/_api`: 301 to the same path on `https:`; anything else 404 |
| `METHOD /_api/<rest>`, `(METHOD, <rest>)` on the allowlist | forwarded to `env.API.fetch` (the `Internal` entrypoint) at `<ADMIN_ORIGIN><rest><query>`. Before sending, the URL is parsed again, and the request is refused (404) unless its pathname is exactly `<rest>` |
| `/_api/…` not on the allowlist, `/_api` itself | `404 {"error":{"code":"not_found","message":"Route not found"}}`; the API is never called |
| the binding throws | `502 {"error":{"code":"unavailable",…}}` |
| `GET/HEAD /robots.txt` | `User-agent: *` / `Disallow: /` |
| `GET/HEAD /assets/…`, `/images/…`, a top-level name with a dot (`/favicon.ico`) | from `ASSETS`; `/assets/…` `public, max-age=31536000, immutable`, others `no-cache`; missing → 404, never the shell |
| `GET/HEAD` anything else (`/`, `/login`, `/reset-password`, `/platform/…`, `/index.html`, …) | the shell `/index.html` from `ASSETS`, `200`, `Cache-Control: no-store`; no shell in the build → 503. The SPA picks the tree (D102) |
| any other method outside `/_api` | 404 |

**The allowlist** (`allowlist.ts`, matched on the RAW path after `/_api`):

- `/v1/admin/<1+ segments>` and `/v1/platform/<1+ segments>`: GET, HEAD, POST, PUT, PATCH, DELETE. The exception is `/v1/platform/bootstrap`, which is refused (deviation 1).
- `GET /v1/me`, exact.
- The Better Auth routes that `src/auth/auth-routes.ts` mounts, with the same method and path: `GET /api/auth/get-session`, `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `POST /api/auth/request-password-reset`, `POST /api/auth/reset-password`, and `GET /api/auth/reset-password/<[A-Za-z0-9_-]{16,128}>`, using the same regular expression as the API.
- **A path is checked before any matching.** It is refused when it has an empty segment (this catches `//` and a trailing slash), a backslash, more than 2048 characters, or a segment that is not pchar and `%XX` only. Each segment is decoded once, and it is refused when the decoding fails or gives `.`, `..`, `/` (an encoded slash), `\` or a control character. A literal segment matches only its exact spelling, so `%61dmin` does not match `admin`.
- Refused by test: every storefront route (`storefront`, `products`, `checkout`, `orders`, `reports`, `withdrawals`, `collections`, `pages`, `legal`, `seo`, `sitemap`), webhooks, render, staging, `/health`, `/ready`, the bootstrap route, sign-up and the other unmounted auth endpoints, wrong methods, OPTIONS/TRACE/CONNECT and lower-case methods, near misses (`/v1/administrator`, `/v2/admin`, `/V1/admin`), and paths that the URL parser turned into a refused path through dot segments.

**The forwarded request** (`forward.ts`) is built from scratch rather than copied. Only these headers go on: `accept`, `cf-connecting-ip`, `content-length` (only with a body), `content-type`, `cookie`, `idempotency-key`, `if-none-match`, `origin`, `sec-fetch-dest`, `sec-fetch-mode`, `sec-fetch-site`, `user-agent` and `x-shop-id`. The method stays the same. The body is passed on as a stream and is never read. A GET or HEAD, or a request that declares `Content-Length: 0`, goes with no body and no length. Redirects are `manual`. The URL keeps the browser's scheme and host.

**The API's answer** keeps its status, body and every header, including each `Set-Cookie`. A 101, 204, 205 or 304 is rebuilt with a null body.

**Headers.** Every answer carries `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff` and `Strict-Transport-Security: max-age=31536000; includeSubDomains`. HTML answers (`content-type: text/html…`) also carry the **enforced** policy, plus `X-Frame-Options: DENY` and `Permissions-Policy: camera=(), microphone=(), geolocation=()`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: blob: <PUBLIC_OBJECT_BASE_URL> https://*.r2.cloudflarestorage.com;
font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://*.r2.cloudflarestorage.com;
frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```

The `PUBLIC_OBJECT_BASE_URL` entry is left out when that variable is unset or malformed. The `*.r2.cloudflarestorage.com` wildcard also matches the EU jurisdiction's `<account>.eu.r2.cloudflarestorage.com`, because a CSP host wildcard matches any depth of subdomain.

**What the admin build really loads.** `index.admin.html` does not exist yet (unit FA writes it), so this list comes from what the source system's admin HTML and code load:

- `index.html` loads the admin font Figtree, and two storefront fonts, from `https://fonts.googleapis.com/css2?…`. The font files come from `fonts.gstatic.com`.
- `src/config/nordTokens.js` `ensureTemplateFonts` injects a Google Fonts stylesheet at runtime for a template's fonts (read by `StoreSettingsContext`).
- `src/index.css` is `@import 'tailwindcss'`: local, with no external URL.
- No admin page or component loads a Stripe script or an iframe. Stripe is used only in `src/components/shop/*`, `src/pages/shop/OrderReturn.jsx` and `src/utils/stripeClient.js`, which are storefront files. That is why `frame-src 'none'` and `script-src 'self'`.
- Quill writes inline style attributes, which is why `'unsafe-inline'` is in `style-src`.

**The headers `Internal` trusts, and whether a browser can reach them.** I read them from the API's sources with `grep headers.get(` over `cloudflare/src` and checked the Better Auth sources:

| Header | Read by | Can the browser's copy reach the API through this Worker? |
|---|---|---|
| `X-Tenant-*` | nothing (both entrypoints strip them) | no: not forwarded |
| `X-Shop-Id` | `authorizeTenantAdminRequest` (checked against live membership or acting-as), `authorizePlatformRequest` (presence refuses, D70) | yes, by design. It is a claim the API verifies, not a trust |
| `Cookie` | Better Auth session | yes, by design (the session) |
| `Origin` | `isSameOriginRequest`, Better Auth origin check | yes, and it stays meaningful because the forwarded URL is the browser's origin. Tests show that a foreign, missing or API-host Origin on an admin write is still refused |
| `CF-Connecting-IP` | `lib/rate-limit.ts`, Better Auth `ipAddressHeaders` | the edge's value. Cloudflare's edge overwrites any copy a client sends to the admin Worker, and the Worker forwards what the edge gave it, as the web Worker does |
| `Authorization` | fake-printer, render-jobs, receipts | no: not forwarded (and none of those routes is on the allowlist) |
| `X-Bootstrap-Token` | `platform/bootstrap.ts` | no: not forwarded, and the route is refused |
| `Stripe-Signature` | the webhook | no: not forwarded, and the route is not on the allowlist |
| `X-Storefront-Preview` | `storefront/preview.ts` (CP4-D2, in progress) | no: not forwarded |
| `Idempotency-Key`, `If-None-Match`, `Content-Length`, `Content-Type`, `User-Agent` (terms-acceptance evidence), `Sec-Fetch-*` (Better Auth sign-in CSRF guard) | the routes named | yes. None of them confers trust |
| `X-Forwarded-For` | nothing (Better Auth is pinned to `cf-connecting-ip`) | no: not forwarded |

## Better Auth behind the proxy: verified by test, not assumed

The test `admin-worker.test.ts` → "Better Auth behind the proxy" sends browser requests on the admin host through `handleRequest`. They reach the **real API app** on the `internal` surface (`createApp({surface:"internal"})` after `stripTenantHeaders`, which is what `Internal.fetch` does). `AUTH_BASE_URL` stays the API's own origin (`https://meteorshop-stg-api…`, from `vitest.config.ts`).

1. **Unless the API trusts the admin origin, sign-in through the proxy is refused.** Through the real `exports.Internal`, with the pool's variables unchanged (the admin origin is not in `AUTH_TRUSTED_ORIGINS`), the result is `403 {"code":"INVALID_ORIGIN"}` and no cookie. The cause in `better-auth@1.6.29`, `dist/api/middlewares/origin-check.mjs`: sign-in runs `formCsrfMiddleware`. When `Origin` or a `Sec-Fetch-*` header is present, that middleware calls `validateOrigin(ctx, forceValidate=true)`, and `Origin` must then match `trustedOrigins`. A request carrying a cookie (sign-out, every later POST) gets the same check from `originCheckMiddleware`.
2. **When the admin origin is in `AUTH_TRUSTED_ORIGINS`, sign-in works on the admin host, even though `AUTH_BASE_URL` is the API's.** The result is `200` with the user. Better Auth routes on the pathname under its base path, so the request's host plays no part.
3. **The cookie is one that the admin host keeps.** It is `__Secure-better-auth.session_token=…` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and **no `Domain`**, so the browser stores it for the host that answered, which is the admin host. Source: `dist/cookies/index.mjs`. The secure prefix follows `baseURL.startsWith("https://")`, and `Domain` is set only when `crossSubDomainCookies` is enabled, which it is not here.
4. **That cookie then carries the session through the proxy.** `GET /api/auth/get-session` returns the user. `POST /v1/admin/discount-codes` with `X-Shop-Id` and the admin `Origin` returns `201`, so the API's own `isSameOriginRequest` passes because the forwarded URL is on the admin host. The same POST is refused (`404`) with `Origin` set to `https://evil.test`, to the API's own origin, or left out, so the proxy vouches for nothing. An invented `X-Tenant-Id` without `X-Shop-Id` gets the opaque 404. Sign-out returns `200` with the cookie cleared (`Max-Age=0`), and the next `get-session` returns `null`.

**The API needs exactly this:** the admin origin added to `AUTH_TRUSTED_ORIGINS`, in each environment of `cloudflare/wrangler.jsonc`. No base-URL rule is needed. `AUTH_BASE_URL` stays the API's origin, and the reset emails keep being built from it. One side effect to know about: `create-auth.ts` `trustedOrigins()` also trusts `resetPageOrigins(CANONICAL_ORIGINS)`. If unit WA adds `admin` to the reset-page surfaces, then `CANONICAL_ORIGINS.admin` will be trusted automatically. The preflight should still require it explicitly in `AUTH_TRUSTED_ORIGINS`.

## Tests and gate (all run, on the final tree)

| Command | Result |
|---|---|
| `cd cloudflare && npx tsc --noEmit -p admin` | clean |
| `cd cloudflare && npx tsc --noEmit` (includes the two test files) | clean |
| `cd cloudflare && npx tsc --noEmit -p web` | clean |
| `npx vitest run test/admin-worker-routing.test.ts` | `Tests  110 passed (110)` |
| `npx vitest run test/admin-worker.test.ts` | `Tests  37 passed (37)` |
| `cd cloudflare && npx vitest run` (whole suite, including the other builders' work in progress) | `Test Files  94 passed (94)` / `Tests  4071 passed (4071)` |
| `node guard/guards.test.mjs` (repo root) | `guard: PASS`. It scans tracked files only, so the guard's own patterns were also run over my new files by hand and found nothing |
| `node cloudflare/admin/check-admin-build.mjs` | exit 1, `admin build: vite.admin.config.js does not exist yet (unit FA writes it); nothing was built or checked.` |
| `… --no-build --dist <fixture>` on a clean fixture | exit 0 |
| `… --no-build --dist <fixture>` on a bad fixture (a `firebase` import, an `sk_live_` key, a `sourceMappingURL`, a `.map` file, a nested non-servable file) | exit 1, all five reported (a secret's value is not printed) |

The tests cover the brief's rule 6 list:

- **The allowlist.** Every refused family, unclean paths, and paths whose dot segments the URL parser resolved.
- **Header forwarding and stripping.** Both the pure function and the forwarded request the spy receives.
- **`Set-Cookie` with several cookies.** Both the pure function and the glue. The real sign-in and sign-out also produce real cookies.
- **The URL host kept**, along with the query.
- **The SPA fallback**, for both trees, `/index.html`, missing assets (404, never the shell) and a build with no shell (503).
- **The CSP on HTML and not on JSON or on an asset.**
- **A large streamed body.** A 48 MiB `PUT` produced chunk by chunk reaches the API before it has been fully produced, so it streams and is not buffered. The API receives every byte and the declared `Content-Length`.

Not covered by any test:

- the 3-line default export;
- the real `ASSETS` binding;
- a real service binding between two deployed Workers, in particular whether `Content-Length` and a streamed body survive RPC across Workers. The object upload route requires `Content-Length` (`object-routes.ts` `checkContentLength`). This needs the staging smoke described below.

## Deviations from the brief

1. **`/v1/platform/bootstrap` is refused**, although it sits under `/v1/platform/`. It is the operator's one-time call with `X-Bootstrap-Token` (`platform/bootstrap.ts`), never a browser's. The header would not be forwarded anyway.
2. **The headers are forwarded from an allowlist, and the list is longer than the brief's.** I added `content-length` (the upload and the legal-page routes need it), `user-agent` (recorded as evidence of terms acceptance, `legal-admin.ts`) and `sec-fetch-dest/mode/site` (Better Auth's sign-in CSRF guard reads them; a browser sets them and a page's script cannot). Building the request from scratch means no header the browser sends can reach the API unless it is on the list. That is stronger than dropping the headers known to be dangerous.
3. **The CSP allows Google Fonts in `style-src` and `font-src`.** The brief's `style-src 'self' 'unsafe-inline'` would block the admin font, Figtree, which `index.html` loads from Google Fonts, and the template fonts that `ensureTemplateFonts` injects. If FA self-hosts the font or drops the link from `index.admin.html`, both hosts should be removed (one line each in `headers.ts`, plus the test). I also added `script-src 'self'`, `object-src 'none'`, `X-Frame-Options: DENY`, HSTS and a Permissions-Policy, as the web Worker has.
4. **The Worker answers on the admin host only, and an `http:` navigation is redirected to `https:`.** I added this because the host-only cookie and Better Auth's trusted origin are both bound to that one origin. A second hostname (CP7, gap analysis §4) means changing `ADMIN_ORIGIN`, the pinned origin and `AUTH_TRUSTED_ORIGINS` together.
5. **The emailed reset link `GET /api/auth/reset-password/<token>` is on the allowlist.** The brief asks for "the exact Better Auth routes the API mounts", and the API mounts this one. The SPA does not need it, because WA lands the link on `<admin>/reset-password?token=…`, which posts to `POST /api/auth/reset-password`. It is harmless: the API rewrites that request onto its canonical origin anyway. A reviewer may remove the row.
6. **`robots.txt` is answered by the Worker** with `Disallow: /`, in addition to `X-Robots-Tag` on every answer.
7. **HEAD is allowed on the two prefix families.** The API answers whatever it answers, which is usually the opaque 404.

## Open questions

- **The output name of FA's build.** The Worker reads the shell at `/index.html`, and the check requires `dist/index.html` with an empty `<div id="root"></div>`. If `vite.admin.config.js` keeps the output name `index.admin.html`, it must rename it the way `vite.storefront.config.js` `storefrontOutput()` does.
- **Public files.** The Worker serves `/assets/…`, `/images/…` and top-level dotted files. A build that ships anything else fails the check.

## Reviewer wiring

1. **`cloudflare/pinned.staging.json`:** `"adminWorkerName": "chopshop-admin-stg"` and `origins.admin: "https://chopshop-admin-stg.kent-ee2.workers.dev"`.
   **`cloudflare/pinned.production.json`:** `"adminWorkerName": "chopshop-admin"` and `origins.admin: "https://chopshop-admin.kent-ee2.workers.dev"` (a placeholder until the real domain arrives, D7). If WA's `platform` key (D102) is pinned too, it is the same origin.
2. **API `cloudflare/wrangler.jsonc`, each environment:**
   - `AUTH_TRUSTED_ORIGINS` gains the admin origin. This is required: without it every sign-in through the admin host is `403 INVALID_ORIGIN`, as proved above.
   - `CANONICAL_ORIGINS.admin` (and `platform`, if WA adds that key) equals `origins.admin`.
   - **Order matters:** `parseCanonicalOrigins` refuses an unknown key, so adding `admin` to the variable before WA's `origins.ts` change is deployed would make `readCanonicalOrigins` return null. That takes the password-reset surface dark, and the reset pages would drop out of `trustedOrigins`.
3. **`scripts/cf-preflight.sh <env> --admin -- …`, mirroring `--web`:**
   - Configuration `cloudflare/admin/wrangler.jsonc` named explicitly, with cwd `cloudflare/admin/`. Its `account_id` (top level and `env.<env>`) equals the pinned id.
   - `env.<env>.name` (or `<top>-<env>`) equals pinned `adminWorkerName`, which must differ from `workerName` and `webWorkerName`.
   - Assets EXACTLY `{directory "./dist", binding ASSETS, run_worker_first true, html_handling "none", not_found_handling "none"}`.
   - Services EXACTLY one entry: `{binding API, service == pinned workerName, entrypoint Internal}`.
   - Vars EXACTLY `ADMIN_ORIGIN == origins.admin` and `PUBLIC_OBJECT_BASE_URL == r2.publicBaseUrl`.
   - No other key in `env.<env>` or at the top level (the same key lists as `--web`), so there is no D1, R2, queue, secret, route or trigger.
   - Production `workers_dev` and `preview_urls` exactly `false`.
   - For `deploy`: `cloudflare/admin/dist/index.html` exists, with no `*.map` and no `sourceMappingURL`.
   - On the API side, the existing check "`AUTH_TRUSTED_ORIGINS` == exactly {api, web}" becomes {api, web, admin}, and `CANONICAL_ORIGINS` deep-equals the pinned origins including `admin`.
   - Production is refused until a real domain exists (D7/D89). Apply the launch gate and the Stripe check as `--web` does.
   - `--admin` allows only `deploy` (and `--dry-run`) and `whoami`, and never `--bootstrap`.
   - Guard cases go in `guard/preflight.test.sh`.
4. **`scripts/cf-deploy.sh <env> admin`** (and in `all`):
   - Build `vite.admin.config.js` from the committed tree with `~/.config/chopshop/admin.<env>.env` (public `VITE_` values only, with the same refusal rules as the web build).
   - Run `node cloudflare/admin/check-admin-build.mjs --no-build`, or let it build.
   - Run `scripts/cf-preflight.sh <env> --admin -- deploy`.
   - **The API is deployed first**, because it carries `AUTH_TRUSTED_ORIGINS` and, from WA, `/v1/me`.
   - Guard cases go in `guard/deploy.test.sh`.
5. **`vitest.config.ts`: nothing.** Both suites run in the existing pool. They import `cloudflare/admin/src/*` directly and use `exports.Internal`, `createApp` and `env.DB` as the web Worker's suites do. My suites use their own admin origin (`https://admin.wx.test.invalid`), which is not configured anywhere, so a later `CANONICAL_ORIGINS.admin` in the pool does not change them.
6. **`cloudflare/package.json` → `check`:** add `npx tsc --noEmit -p admin` (optional, as for `web`).
7. **No new dependency.**
8. **Staging smoke after deploy (what no local test can prove):**
   - a real sign-in in a browser on `https://chopshop-admin-stg.kent-ee2.workers.dev`, with the cookie kept and `/v1/me` read;
   - a real upload, `PUT /_api/v1/admin/objects/:id/content`, across the service binding, which checks that `Content-Length` and the stream survive RPC between two Workers;
   - `ASSETS` with `html_handling: "none"` answering `/index.html`;
   - the enforced CSP on a real navigation, with the browser console free of violations on the pages FA and FB ship;
   - `http://` on workers.dev being redirected.
