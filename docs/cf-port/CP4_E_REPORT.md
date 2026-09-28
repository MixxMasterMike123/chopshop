# CP4-E report — the client and the web Worker

Builder: CP4-E. Branch `cf-port`, working tree only (no git writes, no network, no wrangler, no deploy). Brief: `CP4_BRIEFS.md` §0, "The address grammar", §E (and A–D for the shapes the client calls); DECISIONS D16, D77, D81, D88; PLAN §2.1, §2.4, §2.9; `CP4_GAP_ANALYSIS.md` §2.

Everything below was run on 2026-09-28 against the tree as it stood (other builders' files, P's, were in it at the time).

## Files

| File | What |
|---|---|
| `cloudflare/src/tenancy/shop-hostname.ts` | new: `SHOP_SEGMENT_PATTERN`, `isShopSegment`, `shopStorefrontHostname(db, shop)`, `requestOnHostname(request, hostname)` |
| `cloudflare/src/index.ts` | `Internal.fetchForShop(shop, request)`, and the two imports it needs at the top of the file (nothing else changed) |
| `cloudflare/test/shop-hostname.test.ts` | new: 22 tests |
| `cloudflare/test/entrypoints.test.ts` | one `describe` added: `fetchForShop`, 8 tests (15 → 23); no existing case changed |
| `cloudflare/web/wrangler.jsonc` | new: the web Worker, `chopshop-web-stg` / `chopshop-web`, assets + service binding |
| `cloudflare/web/tsconfig.json` | new: `npx tsc --noEmit -p web` checks the web Worker alone |
| `cloudflare/web/src/env.ts` | bindings, vars, `readWebConfig`, `bareHttpsOrigin` |
| `cloudflare/web/src/shop-segment.ts` | the shop segment rule and the reserved first segments |
| `cloudflare/web/src/api-allowlist.ts` | THE allowlist of API routes a browser may reach |
| `cloudflare/web/src/routing.ts` | `classifyRequest(method, rawPath, shared)` → a `WebRoute` union |
| `cloudflare/web/src/forward.ts` | the forwarded request, the Worker's own API reads, the API answer for the browser |
| `cloudflare/web/src/seo.ts` | the SEO answer's parser, `shopUrl`/`redirectLocation` (the root check), JSON-LD addresses, `withDeadline` |
| `cloudflare/web/src/html.ts` | escaping, the head, `renderShell` (HTMLRewriter), `sanitizeBodyHtml` |
| `cloudflare/web/src/sitemap.ts` | sitemap answer parser, sitemap XML, robots.txt |
| `cloudflare/web/src/headers.ts` | security headers and the report-only policy |
| `cloudflare/web/src/index.ts` | the glue: `handleRequest(request, env, options)` and the `fetch` export |
| `cloudflare/web/check-storefront-build.mjs` | new: builds the storefront and fails on any Firebase code in the output |
| `cloudflare/test/web-routing.test.ts` | new: 173 tests (pure rules) |
| `cloudflare/test/web-html.test.ts` | new: 33 tests (escaping, head, shell, sanitizer) |
| `cloudflare/test/web-worker.test.ts` | new: 60 tests (the glue end to end, spy API and the REAL `Internal`) |
| `src/api/client.js` | `request`, `ApiError`, the root, addresses |
| `src/api/{storefront,products,collections,pages,legal,checkout,orders,reports,withdrawal}.js` | one module per surface |
| `src/api/useReceiptPoll.js` | the receipt poll as a hook |
| `src/api/api.test.mjs` | new: 18 Node tests (`node --test src/api/api.test.mjs`) |
| `src/storefront/main.jsx`, `StorefrontApp.jsx`, `Providers.jsx`, `pages.jsx`, `Pending.jsx`, `NotFound.jsx` | the storefront's entry, router, provider tree, swap table, stand-ins, not-found page |
| `src/storefront/providers/{ShopRoot,Storefront,StoreSettings,ShopFeatures,Translation,Cart}.jsx` | the providers |
| `index.storefront.html`, `vite.storefront.config.js` | the storefront's HTML and build |

No page or component under `src/pages` or `src/components` was edited; `App.jsx`, `main.jsx`, `index.html`, `vite.config.js`, every `package.json`, `app.ts`, `wrangler.jsonc`, `env.d.ts`, `vitest.config.ts`, the pinned files and `scripts/` are untouched. No `src/locales` file was left (two were created for one verification run and removed, see "Tested").

---

## 1. `Internal.fetchForShop` (API side, D77)

```ts
// cloudflare/src/index.ts, class Internal
async fetchForShop(shop: string, request: Request): Promise<Response>
```

1. `shopStorefrontHostname(env.DB, shop)`: the segment must match `^[a-z0-9][a-z0-9-]{0,62}$` (checked before any query), then ONE query: `tenant_domains` joined to `tenants`, `domain.tenant_id = shop`, `kind = 'storefront'`, `status = 'verified'`, `tenant.status = 'active'`, `ORDER BY hostname ASC LIMIT 1`.
2. `requestOnHostname(request, hostname)`: same method, headers, body and RAW path and query; the host becomes the shop's hostname (https, no port). If the URL setter would not take the hostname exactly as stored, null.
3. No hostname, or null → `routeNotFoundResponse()` (the opaque `404 {"error":{"code":"not_found","message":"Route not found"}}`), before anything is routed.
4. Otherwise `this.fetch(moved)`: tenant headers stripped, the internal app, tenant from the hostname by `resolveRequestTenant`, the ONE rule. The public entrypoint still takes no tenant from a browser.

The shop's storefront hostname does not have to resolve in DNS: through `fetchForShop` it is a key. (The HANDOVER note of 42b6dda1 already says each imported shop needs a verified storefront hostname before the storefront proof; this is the lookup that needs it.)

## 2. The web Worker: request handling

`WEB_ORIGIN` is the pinned shared-host origin. A request whose host equals its host is on the **shared host** (root `/<shop>`); any other host is a **shop's own domain** (root empty). Everything is decided on the RAW pathname the URL parser gives (literal and `%2e` dot segments are already resolved by it; the API decides on the same string).

| Request | What happens |
|---|---|
| any, `WEB_ORIGIN` missing or not a bare https origin | 503 `Unavailable` (the Worker cannot tell which shop a request is for) |
| shared: `METHOD /_api/<shop>/<path>` | `<shop>` must be a shop segment and not reserved; `(METHOD, <path>)` must be a row of the allowlist; then `API.fetchForShop(shop, R)` where R = the request re-addressed to `<WEB_ORIGIN><path><query>`. Anything else: `404 {"error":{"code":"not_found","message":"Route not found"}}` and the API is never called |
| own domain: `METHOD /_api/<path>` | same allowlist; `API.fetch(R)` with R on `https://<host><path><query>` (the API resolves the hostname). A shop prefix here is refused |
| R, the forwarded request | method, headers and body as they came, minus every `X-Tenant-*` header; `CF-Connecting-IP` = the visitor's address as the edge gave it; a POST declaring `Content-Length: 0` goes with NO body (the payment route refuses a body stream); `redirect: manual`. Before sending, the Worker re-parses R's URL and refuses (404) unless its pathname is byte for byte the path that was matched |
| the API's answer | status, body, `ETag`, `Cache-Control`, `Retry-After` untouched (the browser revalidates by ETag); `Set-Cookie` removed. A throwing binding → `502 {"error":{"code":"unavailable",…}}` |
| `GET/HEAD /robots.txt` | text: `User-agent: *`, `Allow: /`, `Disallow: /_api/`, plus `Sitemap: https://<host>/sitemap.xml` on a shop's own domain only |
| shared `GET/HEAD /<shop>/sitemap.xml`, own `GET/HEAD /sitemap.xml` | `GET /v1/sitemap` (and `?cursor=` while `nextCursor`), at most 10 answers, 5 s each; XML with `<loc>` = absolute address of each entry under the shop's root (an entry that would leave it is left out) and `<lastmod>` when ISO; `public, max-age=3600`. API 404 → 404; failure, timeout or bad shape → 503 |
| `GET/HEAD /assets/…`, `/images/…`, or one top-level segment with a dot (`/favicon.ico`, `/manifest.json`), never `/index.html` | from `ASSETS`; `/assets/…` `public, max-age=31536000, immutable`, others `no-cache`. Missing: shared host → 404; own domain → treated as a page (a slug with a dot) |
| shared `GET/HEAD /`, or a first segment that is not a shop (`/admin`, `/login`, `/Sillmans`, …) | the application's HTML **as a 404**, with no root written and no API call; the app shows its not-found page |
| `GET/HEAD <root>/…` (a storefront address) | **a navigation**: the HTML shell is fetched from `ASSETS` while ONE `GET /v1/seo?path=<path under the root>` is made (query dropped; the visitor's address, nothing else of the browser), with a deadline of 1.5 s |
| … SEO answers `{ redirect: { to, status: 301 } }` | `301`, `Location` = `redirectLocation(origin, site, to)`: `to` must be a root-relative path (one leading `/`, not `//`, no backslash, no whitespace or control character), is resolved as a browser would (dot segments included), and must stay on the origin and under `/<shop>` on the shared host; the Location is that PATH. Anything else → the answer is ignored and the page is served |
| … SEO answers `{ page: {…} }` | the shell with: the build's `title`, `description`, `og:*`, `twitter:*`, canonical and robots removed; the page's head appended (title, description, canonical, `og:url`, robots, `og:image` only when on the public object origin, JSON-LD with every `{"@relative": path}` made absolute under the root); `bodyHtml`, sanitized, as the content of `#root`; `<meta name="storefront-root" content="<root>">` |
| … SEO 404, error, throw, timeout, non-JSON or another shape | the shell as built, plus the `storefront-root` tag; `200`. The shop opens when the API is slow or down |
| any other method on a non-`/_api` path | 404 |
| every answer above | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Content-Security-Policy-Report-Only` (below). HTML is `no-cache` |

**The allowlist** (`cloudflare/web/src/api-allowlist.ts`), matched segment by segment on the raw path; `:id` = unreserved characters and `%XX` escapes only, at most 512, decoded once and refused when the decoding fails or yields `.`, `..`, `/`, `\` or a control character:

| Method | Path | Source |
|---|---|---|
| GET | `/v1/storefront` | exists |
| GET | `/v1/storefront/pod-previews/:id/:id` | exists (the POD preview image) |
| GET | `/v1/products`, `/v1/products/:id` | exist; A adds query parameters and handles |
| GET | `/v1/collections`, `/v1/collections/:id` | brief B |
| GET | `/v1/pages`, `/v1/pages/:id` | brief C |
| GET | `/v1/legal`, `/v1/legal/:id` | brief C |
| POST | `/v1/checkout`, `/v1/checkout/:id/payment`, `/v1/checkout/:id/receipt` | exist |
| GET | `/v1/orders/:id` | exists |
| POST | `/v1/reports` | exists |

Nothing under `/v1/admin`, `/v1/platform`, `/v1/render`, `/v1/webhooks`, `/v1/staging` or `/api/auth` has a row; neither have `/v1/seo` and `/v1/sitemap` (only the Worker calls them) nor `/health`. A literal segment matches only its exact spelling (`%70roducts`, `Products`, `products;x` are refused). A route added to the API later is unreachable through the Worker until a row is added.

**Reserved first segments**: `NON_SHOP_FIRST_SEGMENTS` of `src/config/tenancy.js` verbatim (a test imports the JS file and compares the sets), plus the Worker's own `assets` and `images`.

**Everything written into HTML** goes through `escapeHtml` (the five characters), `jsonForScript` (JSON with `<`, `>`, `&`, U+2028/2029 as `\uXXXX`) or `sanitizeBodyHtml`. The sanitizer (HTMLRewriter) is a second fence behind D's "escaped by the server": script, style, iframe, svg, math, noscript, template, form controls, meta, base, link, media and the raw-text elements go with their content; elements outside a plain-structure list go and keep their text; every attribute goes except a link's `href` (a root-relative path of `[A-Za-z0-9-._~%/]`, rewritten under the shop's root) and an image's `src` (on the public object origin) with a plain `alt` and numeric `width`/`height`; comments go; text passes as it came, so escaped text stays escaped.

**The policy (report-only):** firebase.json's storefront policy with the Firebase and Google endpoints removed (`www.gstatic.com`, `*.googleapis.com` other than fonts, `*.cloudfunctions.net`, `*.run.app`), Cookiebot removed (the storefront build mounts no consent banner), and `img-src 'self' data: blob: <PUBLIC_OBJECT_BASE_URL>` (only `'self' data: blob:` while that var is unset). Stripe, Trustpilot and Google Fonts entries are kept as they were.

**What is tested and what is glue.** Every decision above is a pure function tested in `web-routing.test.ts` / `web-html.test.ts`. The glue (`cloudflare/web/src/index.ts`, 328 lines with comments) is itself exercised end to end by `web-worker.test.ts` through `handleRequest` with a fake `ASSETS`, a spy API and the real `Internal` entrypoint (`exports.Internal` of this API's test pool). Not covered by any test: the 5-line default `fetch` export, the real `ASSETS` binding's behaviour, and a real service binding between two deployed Workers (RPC of a `Request` with a body across Workers). Those need a staging smoke (see "Reviewer wiring").

## 3. The client (`src/api/`)

Plain `fetch`, no SDK. `credentials: 'omit'`; default cache mode (the API's `ETag` + `no-cache` let the browser revalidate; a 304 reaches this code as the cached 200). Every module imports `client.js` only.

```js
// client.js
class ApiError extends Error { status; code; message; retryAfterSeconds }
  // code: the API's (`not_found`, `invalid_request`, `rate_limited`, …) or `network_error`,
  // `bad_response`, `http_error`, `no_shop`, `bad_request`
storefrontRoot(pathname = location.pathname): '/<shop>' | '' | null
parseShopSegment(segment): string | null
segment(value): string                      // encodeURIComponent + !'()* escaped (the Worker's id rule)
withQuery(path, params): string
shopHref(relativePath): string | null       // root + a path the API returned
apiUrl(apiPath): string | null              // /_api<root> + '/v1/…' (POD preview images)
request(path, { method, body, headers, signal }): Promise<{ status, data }>   // rejects ApiError
readOne(path, key, options): Promise<object | null>                          // 404 → null

// storefront.js
getStorefront({ signal }): Promise<Storefront | null>
// products.js
listProducts({ tag, category, featured, cursor, limit, signal }): Promise<{ products, nextCursor }>
listAllProducts(filter): Promise<Product[]>          // follows nextCursor, at most 20 pages
getProduct(ref, { signal }): Promise<ProductDetail | null>
previewImageUrl(previewPath): string | null
// collections.js
listCollections({ signal }): Promise<Collection[]>
getCollection(ref, { cursor, limit, signal }): Promise<{ collection, products, nextCursor } | null>
// pages.js
listPosts({ lang, cursor, limit, signal }): Promise<{ pages, nextCursor }>
getPage(slug, { lang, signal }): Promise<Page | null>
// legal.js
listLegalPages({ signal }): Promise<{ key, path, title }[]>
getLegalPage(key, { signal }): Promise<LegalPage | null>
// checkout.js
newIdempotencyKey(): string
createCheckout({ items, email, deliveryMethod, shippingCountry, consent, idempotencyKey }, { signal })
  : Promise<{ checkout, replayed }>                  // no discount code is ever sent (D81)
createPayment(checkoutId, { signal }): Promise<{ clientSecret, paymentIntentId, created }>
// orders.js
RECEIPT_POLL_INTERVAL_MS = 2000; RECEIPT_POLL_TIMEOUT_MS = 90000
claimReceipt(checkoutId, { signal }): Promise<{ status: 'pending' } | { status: 'ready', orderId, receiptToken } | { status: 'issued' }>
pollReceipt(checkoutId, { signal, intervalMs, timeoutMs, now, wait })
  : Promise<ready | issued | { status: 'timeout' }>  // network error and 429 waited out; other refusals reject; abort rejects
getOrder(orderId, receiptToken, { signal }): Promise<BuyerOrder | null>   // Authorization: Bearer
saveReceiptToken(orderId, token) / loadReceiptToken(orderId)             // sessionStorage, this tab only
// useReceiptPoll.js
useReceiptPoll(checkoutId): { status: 'idle' | 'polling' | 'ready' | 'issued' | 'timeout' | 'error', … }
  // aborts on unmount; saves the token on 'ready'
// reports.js
submitReport({ productId, reporterName, reporterOrg, reporterEmail, rightType, description, attestation, productUrl, website }): Promise<{ reportId }>
// withdrawal.js — NOT BACKED (see open question 1)
submitWithdrawal({ orderNumber, name, contactEmail }): Promise<Withdrawal>
```

**The root.** The web Worker writes `<meta name="storefront-root" content="…">` into every page it serves for a shop: non-empty = shared host, empty = a shop's own domain. On the shared host the client re-reads the shop from the current path on every call, so a client-side move between shops never calls the previous shop. Without the tag (the Vite dev server) the shared-host grammar applies.

## 4. The providers and the router (`src/storefront/`)

| Provider | Hook (same value as the Firebase one) | Source |
|---|---|---|
| `ShopRootProvider` | `useShopId()`, `useStorefrontRoot()` | the path (shared host) or the tag (own domain); null shop on an own domain |
| `StorefrontProvider` | `useStorefront()` → `{ status: loading \| ready \| not_found \| error \| no_shop, storefront }` | ONE `getStorefront()` per shop root, aborted on change |
| `StoreSettingsProvider` | `useStoreSettings()` | starts as `STORE` (first paint = baseline); on `ready`, `identity` keys, then name/currency/locale, branding `url`s → `logoUrl`/`heroImageUrl`/`faviconUrl`, `menu`, `pickupLocations`, `templateId`, `theme`, `accent`, non-empty values only; `__loaded` true once the read is over. Theme tokens and tab identity: the Firebase provider's code line for line |
| `ShopFeaturesProvider` | `useShopFeatures()` → `{ features, loading, isEnabled }` | the response's `features`; a key is on only on a literal `true`; everything off while loading or on failure (D81) |
| `TranslationProvider` | `useTranslation()` | `src/locales/sv-SE.json` bundled (first paint translated), other languages lazy chunks; no file → the text in the code |
| `CartProvider` | `useCart()` | CartContext's surface without discount/affiliate; lines carry `productId` + `variantId`; `checkoutItems()` for `createCheckout`; key `storefront-cart:<root>` |

No auth, order or account provider.

**The router** (`StorefrontApp.jsx`) holds exactly the grammar, under `/:shopId` on the shared host and with no prefix on an own domain: `/`, `/product/:slug`, `/produkter`, `/kategori/:category`, `/samling/:handle`, `/tagg/:tag`, `/cart`, `/checkout`, `/order-return`, `/order-confirmation/:orderId`, `/angra`, `/rapportera-intrang`, `/:slug` (content/post/legal), and `*` → the shop's not-found page. Parameter names are the ones the pages read today. Each route renders `<Pages.ShopGate><Pages.X/></Pages.ShopGate>`.

## 5. How the build stays free of Firebase

- The storefront has its own entry (`index.storefront.html` → `src/storefront/main.jsx`) and its own providers; nothing in `src/storefront` or `src/api` imports `src/contexts`, `src/config/shopConfig.js`, `src/firebase` or any page.
- **Every** staying page and shell component imports Firebase today, directly or through shared modules (measured: `firebase/config.js` is reached from all 18 staying files; `TranslationContext` 17, `shopConfig` 16, `CartContext` 15, `SimpleAuthContext` 15, `utils/affiliateCalculations.js` 15, `utils/translationDetection.js` 14 via `hooks/useContentTranslation`, `ShopNavigation` 14, `ShopFooter` 13, then `utils/fileUpload.js`, `utils/productFeed.js`, `LandingPage` via `ShopGate`, `ProductReviews`). `ShoppingCart` and `OrderReturn` included, through the contexts. So every route renders a stand-in now.
- **The swap is one line per page** in `src/storefront/pages.jsx`: `export const PublicStorefront = pending('PublicStorefront');` becomes `export { default as PublicStorefront } from '../pages/shop/PublicStorefront.jsx';`. The router never changes. A stand-in renders the shop's name and the storefront status from the API, so the router, providers and client are proven end to end before any page is swapped.
- `node cloudflare/web/check-storefront-build.mjs` runs `vite build --config vite.storefront.config.js` and scans every text file of `cloudflare/web/dist` for `firebase`, `firestore`, `identitytoolkit`, `securetoken.googleapis`, `cloudfunctions.net`, `firebasestorage` (case-insensitive), checks `index.html` and its empty `#root`, refuses source maps and any file the Worker would not serve. Exit 1 with the offenders. It is plain Node (vitest here runs in workerd and cannot build); named without `.test.` so vitest never loads it.
- `publicDir: false`; six named files of `public/` are copied (favicons, manifest, `images/logo.svg`); nothing else of `public/` (admin, POD tooling, earlier brand images) ships.

## 6. Tested, with numbers

| Gate | Result |
|---|---|
| `cd cloudflare && npx tsc --noEmit` | clean |
| `cd cloudflare && npx tsc --noEmit -p web` | clean |
| `npx vitest run test/shop-hostname.test.ts test/entrypoints.test.ts test/web-routing.test.ts test/web-html.test.ts test/web-worker.test.ts` | 5 files, **311 passed** (22 + 23 + 173 + 33 + 60; 296 of them new) |
| `cd cloudflare && npx vitest run` (whole suite, run twice, the second time on the final tree, with P's files in it) | **75 files, 2971 passed**, 0 failed, both times. Two `Uncaught (in promise) Error: Network connection lost.` lines are printed by other suites; my five suites print none (checked separately) |
| `node --test src/api/api.test.mjs` | **18 passed** |
| `node cloudflare/web/check-storefront-build.mjs` | build 41 modules, 9 files (5 text) checked, no Firebase code |
| negative control | `ShoppingCart` swapped in on its one line → build → the check **fails** (exit 1, six markers in the bundle) → line restored → clean again |
| locale loading | with temporary `src/locales/sv-SE.json` and `en-GB.json`: sv-SE text in the main bundle, en-GB in its own chunk; files removed after |
| name guard patterns | the three families of `guard/guards.test.mjs` run by hand over every new or changed file: no match (the guard itself reads tracked files only) |
| earlier brand strings in the built bundle | none |

What the suites prove, per the brief's list:

- **shop-hostname**: a suspended, provisioning and closed tenant, a pending and a disabled domain, only domains of other kinds, no domain, an unknown shop, and nine malformed segments each answer nothing; the lowest of several verified storefront hostnames wins; the host move keeps method, raw path, query, headers, body.
- **fetchForShop**: routes a request on the web host to the named shop; a tenant header naming another shop is ignored; the request's own host is ignored even when it is another shop's domain; a POST body arrives; unknown, malformed, empty and dot segments get the opaque 404.
- **Web Worker**: the shop from the path (real API: the named shop's storefront, 200, ETag, 304 on `If-None-Match`); the reserved segments (the 12 of `tenancy.js`, compared with the file itself, plus the Worker's 2); 20 admin/platform/render/webhook/staging/auth/encoded/dot-segment/Worker-only paths through `/_api` answer 404 with the API never called; tenant headers dropped (spy) and ignored (real API); the visitor's address and the receipt bearer forwarded; a bodyless POST forwarded with no body; `Set-Cookie` removed; a navigation gets the head, escaped, with the body sanitized and its link put under the root; no Open Graph image off the public origin; a 404, 500, throwing, non-JSON or wrongly shaped SEO answer and a never-answering API (deadline) each still serve the application; a forward is a 301 to a path under the root, and 7 hostile targets (absolute, `//`, `/\`, `/../other-shop`, `/%2e%2e/…`, `javascript:`, CRLF) are never followed; a product named `</title><script>` stays text in the title, the meta tags, the JSON-LD and the body.

## 7. Not done

- No page swapped (builder F), no page edited.
- No deploy, no wrangler call, no preflight or pinned-file change (reviewer wiring below).
- No withdrawal route in the API (not in my files; open question 1).
- No flip of `PUBLIC_STOREFRONT_ALLOWED` (open question 7).
- No preview grant (D57, D's second pass): the client has no place for it yet.
- The discount field, reviews, recovery, affiliate, B2B and account pages: left out of the router (D81), as the brief says.

## 8. Deviations from the brief, with the reason

1. **The root tag is written into every page the Worker serves for a shop**, including the one whose SEO call failed ("the application's HTML untouched"). The head stays untouched; the tag is how the client tells a shop's own domain (root empty) from the shared host. Without it a client on an own domain would read its first path segment as a shop. It is escaped, and the root is validated before.
2. **A navigation is any GET/HEAD of a storefront address that is not a file; the `Accept` header is not consulted.** Link-preview crawlers, the main readers of the Open Graph head, commonly send `Accept: */*`; with the brief's rule they would get no head. A non-HTML GET of a page address has no other meaning here.
3. **`bodyHtml` is sanitized by the Worker**, not inserted as it comes. The brief makes the server responsible for escaping; the Worker adds a second fence (and must rewrite the body's links under the root anyway, since the API writes root-relative paths).
4. **`/robots.txt` on the shared host names no sitemap.** The Worker has no list of shops, and no public route gives one; each shop's sitemap is at `/<shop>/sitemap.xml`.
5. **The shared host with no valid shop** answers the application as a 404 (no API call). The brief does not say; Firebase showed the platform's landing page there, which is not part of the storefront build.
6. **`Set-Cookie` is removed** from the API's answers (not asked; no storefront route sets one).
7. **The build's output is `cloudflare/web/dist`** (already git-ignored by the `dist` rule), not a new top-level directory that would need a `.gitignore` change.
8. **`index.storefront.html`** drops two things of `index.html`: the site-verification tag (it belongs to the Firebase host's domain) and the `http-equiv` cache tags (the Worker sends real headers). Everything else of the head is the same.
9. **Translation**: no loader overlay while a language loads, and the chosen language is not kept in localStorage (the Firebase key carried the earlier brand's name; the storefront is Swedish only). The default language's file is bundled, so the first paint needs no overlay.
10. **The content route is one segment** (`<root>/:slug`, as the grammar says); App.jsx used `/:shopId/*`. Deeper unknown paths reach the not-found page.
11. **A not-found page is new** (`src/storefront/NotFound.jsx`, NORD tokens only): Firebase redirected unknown addresses to the shop's home and has no such page to match.
12. **`src/api/useReceiptPoll.js`** is a separate module from `orders.js`, so `orders.js` stays free of React and runs under Node's test runner.
13. `cloudflare/src/index.ts`: besides the `Internal` class, two import lines at the top of the file (the class's own dependencies).

## 9. Open questions

1. **The withdrawal function has no API route.** Firebase's `submitWithdrawal` is PORT (INVENTORY_FUNCTIONS §2.6, "a statutory duty in force since 19 June 2026"), guest withdrawal stays (D11), and neither CP2, CP3 nor any CP4 brief built or owns it. `src/api/withdrawal.js` is written against a proposed shape (the callable's: `POST /v1/withdrawals { orderNumber, statement: { name, contactEmail } }` → `{ withdrawal: { eligible, acknowledgement | reason } }`, one 404 for "no such order or email", 429). The Worker does not forward the path until the route exists (one row). **F cannot swap `WithdrawalPage` or `OrderWithdrawal` without it.** Who builds it, and when?
2. **Answer keys the briefs leave open**: `GET /v1/pages/:slug` and `GET /v1/legal/:key` — the client reads `{ page }`; `GET /v1/sitemap` — the cursor is read as `nextCursor`; `GET /v1/seo` — `page.image` is read as a `PublicImage` (`url`, `width`, `height`), `robots` as a string. C's and D's reports decide; each is one line to change.
3. **JSON-LD `@relative`**: read as "an object whose ONLY key is `@relative`, standing where an address belongs" (`"url": { "@relative": "/product/x" }`). If D means something else, `absolutizeJsonLd` changes.
4. **The body text before React mounts**: `bodyHtml` is visible (unstyled beyond the page CSS) until the app replaces `#root`. React clears the container on its first commit, so the rendered page is identical; the first paint is not. Keep it visible (search engines, slow devices) or hide it? A design-gate question.
5. **The not-found page** needs Mikael's look (design gate).
6. **The shared host's sitemaps** are not discoverable from `robots.txt`; they can be submitted per shop, or a public list of published shops could be added later.
7. **`PUBLIC_STOREFRONT_ALLOWED`** can be flipped to false once the web Worker serves staging, confining storefront routes to `Internal`. `scripts/cf-port/seed-staging-slice.mjs` buys through the API's public host today and would then have to go through the web Worker (`/_api/<shop>/v1/checkout` …).
8. **On a shop's own domain `useShopId()` is null** (the client does not know the tenant id there). Pages that build links with `utils/productUrls.js` (`/${shopId}/…`) need a root-aware helper before CP7; `shopHref()` is it.

## Reviewer wiring

1. **Deploy order**: the API first (it carries `Internal.fetchForShop`), then the web Worker: `node cloudflare/web/check-storefront-build.mjs` (builds `cloudflare/web/dist` and checks it), then from `cloudflare/web/`: `wrangler deploy --env staging` (config `cloudflare/web/wrangler.jsonc`, `main: src/index.ts`, no dependency beyond `cloudflare/node_modules`). Needs a web target in `scripts/cf-deploy.sh` and the preflight.
2. **Service binding**: `services: [{ binding: "API", service: "chopshop-api-stg", entrypoint: "Internal" }]` (production: `chopshop-api`). The preflight should check the service name equals `pinned.<env>.json → workerName` and the entrypoint is `Internal`.
3. **Vars**: `WEB_ORIGIN` must equal `pinned.<env>.json → origins.web` (already `https://chopshop-web-stg.kent-ee2.workers.dev` / `https://chopshop-web.kent-ee2.workers.dev`); `PUBLIC_OBJECT_BASE_URL` in both env sections once P's value is pinned (`r2.publicBaseUrl`, D95), equal to the API's. Optionally a `webWorkerName` in the pinned files.
4. **Assets**: `assets.directory: "./dist"`, `binding: "ASSETS"`, `run_worker_first: true`, `html_handling: "none"`, `not_found_handling: "none"`, per environment.
5. **Hostnames**: each shop served through the shared host needs a `tenant_domains` row of kind `storefront`, status `verified` (the HANDOVER note of 42b6dda1); the name need not resolve.
6. **Scripts** (optional): `npx tsc --noEmit -p web` in `cloudflare/package.json → check`; `node --test src/api/api.test.mjs` and `node cloudflare/web/check-storefront-build.mjs` as root scripts. No vitest project is needed: the web Worker's suites run in the existing config.
7. **No new dependency.** Vite, the React and Tailwind plugins and terser are the root's; `@cloudflare/workers-types` and wrangler are `cloudflare/`'s.
8. **Staging smoke after deploy** (what no local test can prove): a real RPC call carrying a `Request` with a body from `chopshop-web-stg` to `Internal.fetchForShop`; a bodyless `POST …/payment` through the edge (the payment route refuses a body stream); `ASSETS` with `html_handling: "none"` answering `/index.html`; the headers on a real navigation.

---

## Review round 1 (reviewer, 2026-09-28)

Read line by line: `shop-hostname.ts`, the `Internal` class, every module of `cloudflare/web/src/`, `src/api/client.js`, `checkout.js`, `orders.js`, `withdrawal.js`, the router and the swap table; the cart provider in part. Run by the reviewer: `tsc` for both projects clean, E's five suites 312 passed (one added), the client's 18 Node tests, the build check (no Firebase code in the output).

**Changed by the reviewer:**

1. **No cookie is forwarded to the API** (`forward.ts`). The storefront holds no session, and a cookie of the web host is not the API's business, whatever later lives on that host. `Authorization` is still forwarded: the receipt of an order is read with its bearer token. One test added.
2. **The two line-separator characters in `jsonForScript`** were written as the characters themselves, which no editor shows. They are now written as escapes. Same behaviour.

**Accepted deviations:** 1–13 as reported. Deviation 5 has a visible consequence for Mikael: the bare address of the shared host shows the shop's not-found page, where the source system shows the platform's landing page. The landing page is not a storefront page and is not part of CP4.

**Open question 1 (no withdrawal route) is a gap of the port, not of E:** PLAN §3.1 lists withdrawals in the first checkpoint and no builder built the intake. Recorded as D96; builder G in `CP4_BRIEFS.md`. The route joins the web Worker's allowlist when it exists.

**Open questions 2 and 3** (the keys of C's and D's answers) are settled when C and D report; the reviewer aligns the client.

**Open question 7** (`PUBLIC_STOREFRONT_ALLOWED`): flipped when the staging proof runs through the web Worker, with the seed script moved to it in the same commit. Not before.

**For the staging smoke (cannot be proven locally):** a request with a body from the web Worker to `Internal` over the binding; a `POST …/payment` without a body through the edge; the build's HTML served through `ASSETS` with `html_handling: "none"`; the headers of a real navigation.
