Model: claude-opus-5-5

# CP4-D2 report — the preview of an unpublished shop (D57), D's second pass

Builder: CP4-D2. Branch `cf-port`, working tree only (no git writes, no network, no wrangler, no deploy). Brief: `CP4_BRIEFS.md` §0, "The address grammar", §D "The preview of an unpublished shop (D57) — D's second pass"; DECISIONS D57, D77; `CP4_D_REPORT.md`, `CP4_E_REPORT.md`, `CP4_K_REPORT.md`. Started on HEAD `2c154012`, tree clean. No other agent changed a file in the tree while I worked (`git status` at the end lists only my files).

**No migration.** The grant is signed and stateless; it needs no table.

---

## 1. What was built

| File | What |
|---|---|
| `cloudflare/src/storefront/preview.ts` | **new.** The header name (`:53`), the lifetime (`:55`), `StorefrontTenant` + `isPreview` (`:66–75`), **the one derivation** `withoutPublishedTerm` (`:90`) and `PREVIEW_ELIGIBILITY_PREDICATE` (`:105`), `eligibilityPredicate(tenant)` (`:108`), the key derivation (`grantKey`), `mintPreviewGrant` (`:167`), `verifyPreviewGrant` (`:187`), `resolveStorefrontTenant` (`:219`), `PREVIEW_RESPONSE_HEADERS` (`:237`), `previewJsonResponse` (`:244`) |
| `cloudflare/src/routes/admin-preview.ts` | **new.** `POST /v1/admin/preview` |
| `cloudflare/src/app.ts` | only two anchor blocks: `// CP4-D2 (imports)` (`:370–372`) and `// CP4-D2` (`:2261–2270`, after CP4-ROUTES-G, before the older catch-alls) |
| `cloudflare/src/storefront/public-shop.ts` | the shop gate as a term list; the preview's gate = the list minus `published = 1` (`:25–31`); `publicShopStatement(db, tenantId, preview = false)` (`:38`) |
| `cloudflare/src/catalog/public-catalog.ts` | `PUBLIC_PRODUCT_COLUMNS` became `publicProductColumns(tenant)`; the three other uses of the predicate (`stillPublic`, `findPublicPreview`) read `eligibilityPredicate(tenant)` (`:191`, `:411`, `:672`) |
| `cloudflare/src/storefront/identity-projection.ts` | `readProductPathsBySku(db, tenant, skus)` (was `tenantId`), fragment by `eligibilityPredicate` (`:727`) |
| `cloudflare/src/storefront/public-storefront.ts` | `getPublicStorefrontVersioned` takes a `StorefrontTenant`; the shop gate and the gallery's product links follow it |
| `cloudflare/src/storefront/seo.ts` | the six product reads take the tenant and its fragment (`:423–545`); a preview's page says `robots: "noindex"` (`:1125`) |
| `cloudflare/src/storefront/public-routes.ts` | `versionedJsonResponse(…, preview = false)` → `previewJsonResponse` (`:52`); the storefront route resolves through the grant (`:81`) |
| `cloudflare/src/routes/public-products.ts`, `public-collections.ts`, `public-pages.ts`, `public-legal.ts`, `public-seo.ts`, `pod-storefront.ts` | each read resolves its tenant with `resolveStorefrontTenant` and answers a preview's way (table §3) |
| `cloudflare/src/catalog/collections.ts`, `cloudflare/src/content/pages.ts` | a trailing `preview = false` on `listPublicCollections`, `readPublicPage`, `listPublicPages`; `readPublicCollection` reads the mark from its tenant |
| `cloudflare/web/src/forward.ts` | `PREVIEW_HEADER`, `isPreviewRead` (`:28–33`); the header goes with GET/HEAD only, without `If-None-Match`/`If-Modified-Since` (`:50–55`); `apiResponseForBrowser(response, preview)` forces `no-store`, drops `ETag`/`Last-Modified`, sets `X-Robots-Tag: noindex` |
| `cloudflare/web/src/index.ts` | a preview read's answer through `apiResponseForBrowser(…, isPreviewRead(request))` (`:278`); the shell of an address the SEO route answers 404 for carries `X-Robots-Tag: noindex` (`:147–155`, `:204`) |
| `src/api/client.js` | `PREVIEW_HEADER`, `capturePreviewGrant`, `previewGrant`, `clearPreviewGrant` (`:132–208`); `request()` adds the header and `cache: 'no-store'` on reads while a grant is held (`:230–235`) |
| `src/storefront/PreviewBanner.jsx` | **new.** the fixed banner "Förhandsvisning — butiken är inte publicerad", NORD tokens only (`bg-ink text-surface font-body`), and `<meta name="robots" content="noindex">` while a grant is held |
| `src/storefront/StorefrontApp.jsx` | the banner mounted once, after `<Routes>` (two lines) |
| `cloudflare/test/storefront-preview.test.ts` | **new**, 24 tests |
| `cloudflare/test/web-preview.test.ts` | **new**, 7 tests |
| `src/api/preview.test.mjs` | **new**, 9 Node tests |

`eligibility.ts` is not edited. No page, no `src/App.jsx`, no wrangler/pinned/preflight file, no `env.d.ts` touched.

## 2. The grant: format and key

```
v1.<expiresAtMs, 13 digits>.<signature, 43 base64url chars>
signature = HMAC-SHA-256(key, "storefront-preview/v1\n<tenantId>\n<expiresAtMs>")
key       = HKDF-SHA-256(ikm = BETTER_AUTH_SECRET, salt = "chopshop/storefront-preview",
                         info = "storefront-preview-grant/v1") → HMAC key, 256 bits
```

- **No existing signed-token mechanism to reuse.** `src` has no HMAC token: the receipt capability (`commerce/receipts.ts`) is 256 random bits with the SHA-256 stored on the order; the bearer secrets (`lib/bearer.ts`) are compared, not signed. A stateless grant needs a signature, so I followed the brief's fallback: **no new secret binding; a purpose-separated key derived from an existing secret.** `BETTER_AUTH_SECRET` is the one that exists wherever an admin can sign in. HKDF with a salt and an info of this purpose alone means the bytes that sign a grant are never the bytes Better Auth signs with (a test proves a grant signed with the raw secret is refused).
- **Bound to the shop by the signed text, not by the token.** The tenant id is not in the grant; it is checked against the tenant the request's hostname names, so a grant of shop A on shop B's host is a wrong signature.
- **Lifetime** 30 minutes; refused at `expiresAt <= now` and when `expiresAt > now + 30 min` (a grant this code never minted). Verified with `crypto.subtle.verify` (constant time).
- Without a usable secret (`isAuthConfigured`: absent or < 32 characters) nothing is minted (the route answers the opaque 404) and every grant is ignored. Rotating the secret ends every grant (and every session).
- **Not revocable** before it expires (stateless). The exposure is 30 minutes of what a buyer would see once the shop is published.

## 3. The reads that honour the grant

Each resolves its tenant with `resolveStorefrontTenant` (hostname tenant, active, marked `preview` only for a valid grant of THAT tenant). A marked read uses `PREVIEW_ELIGIBILITY_PREDICATE` (THE predicate minus `AND tenant.published = 1`) and the shop gate minus `published = 1`; `tenant.status = 'active'` and every product-level term stay. Its 200 is `Cache-Control: no-store`, no ETag, `X-Robots-Tag: noindex`, never a 304.

| Route | Handler (file:line where the tenant is resolved) |
|---|---|
| `GET /v1/storefront` | `src/storefront/public-routes.ts:81` |
| `GET /v1/products` | `src/routes/public-products.ts:85` (unpublished: was `200 { products: [] }`, not a 404) |
| `GET /v1/products/:ref` | `src/routes/public-products.ts:104` |
| `GET /v1/collections` | `src/routes/public-collections.ts:147` |
| `GET /v1/collections/:ref` | `src/routes/public-collections.ts:178` (its products through A's functions, which read the mark) |
| `GET /v1/pages` | `src/routes/public-pages.ts:55` |
| `GET /v1/pages/:slug` | `src/routes/public-pages.ts:77` |
| `GET /v1/legal` | `src/routes/public-legal.ts:284` |
| `GET /v1/legal/:key` (the three shop pages and `plattformsvillkor`) | `src/routes/public-legal.ts:306` |
| `GET /v1/seo?path=` | `src/routes/public-seo.ts:73`; the page carries `robots: "noindex"` and the header |
| `GET /v1/storefront/pod-previews/:productId/:artworkId` | `src/routes/pod-storefront.ts:56` (image `no-store`, no ETag, noindex, `:65`) |

**Not honoured, on purpose:** `GET /v1/sitemap` (`public-seo.ts:107`, still `resolveRequestTenant`): it is for search engines, and an unpublished shop has no sitemap. Tested.

An invalid grant is IGNORED: malformed, empty, expired, from the future, forged, and another shop's grant each give, byte for byte (status, body, `Cache-Control`, `ETag`, `X-Robots-Tag`), the answer without a grant — the opaque 404 of an unpublished shop. A 404 is the same with or without a valid grant (no header that a grant was seen).

## 4. The writes that ignore the grant

None of them calls `resolveStorefrontTenant`; each keeps `resolveRequestTenant` (or G's `resolveWithdrawalTenant`) and checkout keeps THE predicate itself (`commerce/checkout.ts:522`). Proven per family in `test/storefront-preview.test.ts` › "a preview never sells", with a VALID grant on an unpublished shop:

| Family | Route (tenant resolved at) | Proof |
|---|---|---|
| Checkout | `POST /v1/checkout` (`app.ts:1079`) | refused (≥ 400) with the grant exactly as without (status, body, headers); no checkout row made |
| Payment | `POST /v1/checkout/:id/payment` (`app.ts:1291`) | an unknown checkout: the same 404; no Stripe intent. A checkout opened while live: the grant changes nothing (same status, same shape) — see open point 1 |
| Receipt | `POST /v1/checkout/:id/receipt` (`routes/receipts.ts:79`) | the same answer with and without |
| Order | `GET /v1/orders/:id` (`routes/receipts.ts:138`) | the same answer with the token; without the token the grant opens nothing (404) |
| Withdrawal | `POST /v1/withdrawals` (`routes/storefront-withdrawals.ts:114`) | refused (404) with the grant exactly as without |
| Report | `POST /v1/reports` (`routes/storefront-reports.ts:50`) | answered as without (the intake never asked whether the shop is published), no noindex header |

The web Worker also drops the header from every non-GET/HEAD request before it reaches the API (`web/src/forward.ts:50`): a first fence. Tested for checkout, report, payment, receipt.

## 5. `POST /v1/admin/preview`

| | |
|---|---|
| Who | the shop's admin by membership, or a platform user with a live acting-as grant (`authorizeTenantAdminRequest`) |
| Request | `POST`, `X-Shop-Id`, session cookie, `Origin` = the API's own origin; no body is read |
| 200 | `{ preview: { grant, expiresAt } }`, `expiresAt` ISO-8601, `Cache-Control: no-store` |
| 404 (opaque) | anyone else, another method, a cross-origin or origin-less POST (checked before anything is done), no auth secret |
| Audit | one `audit_events` row per grant, before it is handed out: action `storefront.preview_granted`, resource `tenant` / the tenant id, metadata `{ expiresAt }` (+ `actingAsGrantId` under acting-as). The grant itself is never stored |

## 6. The web Worker and the client

**Worker.** It already forwarded every browser header except `X-Tenant-*` and `Cookie` (the cookie stays dropped). Now: the grant goes on with GET/HEAD only, and such a read goes without the browser's validators, so the API never answers it with a 304 of the public copy; the answer to any read that carried the header is `no-store`, no `ETag`, `noindex` whatever the API said (also when the API ignored an expired grant), so the browser never files a public answer under a preview's request or the reverse. The Worker caches no `/_api` answer itself.

**The shell.** The grant lives in the URL fragment, which the Worker never sees, so the Worker cannot know a navigation is a preview. What it can know: the SEO route answers 404 for every address of an unpublished shop. The shell served after such a definite 404 now carries `X-Robots-Tag: noindex`; a slow, failing or malformed SEO answer keeps the shell's default (deviation 2). The client adds `<meta name="robots" content="noindex">` while a grant is held (second fence).

**Client.** At `<root>/#preview=<grant>` the grant is taken from the fragment (other fragment parameters stay), the address is rewritten with `history.replaceState` (the router's `history.state` kept), and the grant is kept for the tab in `sessionStorage` (`storefront-preview`, `{ grant, root }`; in memory when storage throws). It is sent as `X-Storefront-Preview` with `cache: 'no-store'` on every READ of the shop whose root it was opened under, never on a write, and forgotten when it expires. The banner re-checks every 30 s and on every navigation, and disappears with the grant.

## 7. Tests

| Gate | Before (HEAD `2c154012`, clean tree) | After |
|---|---|---|
| `cd cloudflare && npx tsc --noEmit` | clean | clean |
| `npx tsc --noEmit -p web` | clean | clean |
| `npx vitest run` | `Test Files 90 passed (90)`, `Tests 3893 passed (3893)` | **`Test Files 92 passed (92)`, `Tests 3924 passed (3924)`** (+24 `storefront-preview`, +7 `web-preview`; no existing test changed) |
| `node --test src/api/*.test.mjs src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs` | 120 pass | **129 pass, 0 fail** (+9 `preview.test.mjs`) |
| `node cloudflare/web/check-storefront-build.mjs` | — | "11 files (7 text) checked, no Firebase code, every file servable" |
| `npx vite build` | — | built |
| `node guard/guards.test.mjs` | — | PASS (tracked files only); its three patterns run by hand over my six new files and every changed file: no match |

What `storefront-preview.test.ts` proves: the two fragments differ in exactly one line, `AND tenant.published = 1` (as lines and as text), every other term is still there, and `withoutPublishedTerm` throws on six altered shapes (missing, twice, inline, other spelling, named elsewhere, no status term); the two shop gates differ in exactly `published = 1`; the grant's lifetime edges, binding, tamper/malformed/future refusals, key separation, no-secret and rotated-secret refusals; the admin route's refusals (no audit row written) and its two happy paths with their audit rows; for 14 read addresses of a shop that was captured while published: without a grant the unpublished 404 (list: empty), every invalid grant byte-for-byte equal to no grant, a valid grant gives **the very body the published shop gave** (SEO: plus `robots: "noindex"`) with no-store/no ETag/noindex, never a 304; a draft and a taken-down product stay out (product, list, collection); a suspended, closed or provisioning shop stays a 404 with a valid grant; the sitemap ignores it; the POD image; every write family (§4).

Mutation checks run by hand: making `eligibilityPredicate` always answer THE predicate fails 4 tests; making `verifyPreviewGrant` accept any 32-byte signature fails 6.

## 8. Deviations, assumptions

1. **Key from `BETTER_AUTH_SECRET` by HKDF** (no signed-token mechanism existed to reuse; §2). No new binding.
2. **The shell's `noindex` follows the SEO route's 404**, which also covers a PUBLISHED shop's addresses that have no public page: `/cart`, `/checkout`, the order pages, `/angra`, unknown addresses, a category or tag with no public product, a legal page not adopted. None of these is a page to index, and a slow or failing SEO call never adds it. Reviewer: accept, or narrow it (the Worker has no other way to know an unpublished shop without a new signal from the API, which would reveal that the shop exists).
3. **The SEO route honours the grant, but no caller sends one**: the Worker's head call is made by the Worker, and the grant never reaches the Worker (it is in the fragment). Built as the brief says; it serves a future caller.
4. **The flag rides on the tenant** (`StorefrontTenant`, `preview?: true`), set only by `resolveStorefrontTenant`. A function that takes a `TenantContext` passes it on unchanged, so B's collection read carries it into A's product reads without new parameters; every caller that never asks (checkout, the sitemap, screening, the admin) holds a plain context and reads as public. Functions that took only a `tenantId` got a trailing `preview = false` (fail closed: a forgotten call site shows less, never more).
5. **Header name `X-Storefront-Preview`**, after the client's existing `X-Storefront-Dev`.
6. `PUBLIC_ELIGIBILITY_PREDICATE` is now named in `eligibility.ts`, `checkout.ts`, `screening.ts`, `preview.ts` (and a comment of `seo.ts`); `public-catalog.ts`, `identity-projection.ts`, `seo.ts` read the fragment through `eligibilityPredicate(tenant)`. K's table of the files naming the constant changes accordingly.
7. The banner says "butiken är inte publicerad" also when a grant is used on a published shop (the grant works there too and shows the same as the public answer). The admin page should offer the preview for an unpublished shop.

## 9. Open points

1. **FOUND, NOT CHANGED — a checkout opened while the shop was published can still be paid after it is unpublished.** `POST /v1/checkout/:id/payment` re-reads the checkout, not the shop's publication (`app.ts:1248`, `createCheckoutPayment`); the test made one checkout before the unpublish and its payment answered 201 after it. This is the route as it was before the preview, and the grant changes nothing about it (tested). Firebase's D57 behaviour was "not purchasable" when unpublished. A money-path decision for the reviewer: re-check the shop (and THE predicate) at payment, or accept the window.
2. **POD preview images do not show in a preview.** The API answers them to a grant, but the page loads them with `<img src>` (`apiUrl(...)`), which cannot carry a header; in a preview of an unpublished shop those images are 404s in the browser. Putting the grant in the query would put it in server logs. Options: the page fetches the image with `request()` and shows a blob URL (a page change, F's), or accept it for previews.
3. **The fragment in the browser's history list.** `replaceState` replaces the current entry, but a browser may already have recorded the first address (with the fragment) in its history database. The grant then sits in that profile's history for its 30 minutes. Acceptable for the shop's own admin's own browser; noted.
4. No rate limit on `POST /v1/admin/preview` (admin-only, audited; the other admin routes have none either).
5. `GET /v1/collections*` answer cross-origin (D87); a preview from another origin is still blocked, because the preflight's `Access-Control-Allow-Headers` names only `If-None-Match`. Intended.

## Reviewer wiring

1. **Admin UI (CP5):** `POST /v1/admin/preview` on the admin host with the session cookie, `X-Shop-Id: <shopId>` and a same-origin `Origin`; then open `<storefront root>/#preview=<grant>` in a new tab (`rel="noopener noreferrer"`): on the shared host `${CANONICAL_ORIGINS.web}/${shopId}/#preview=${grant}`, on a shop's own domain `https://<domain>/#preview=${grant}`. The grant is `[A-Za-z0-9._-]` only and needs no encoding. Offer it while the shop is unpublished; show `expiresAt` ("gäller i 30 minuter").
2. **Staging needs nothing new:** no secret (the key is derived from `BETTER_AUTH_SECRET`, already set), no migration (`REQUIRED_MIGRATION` unchanged), no wrangler var, no new row in the web Worker's allowlist (the reads are rows already; `/v1/admin/preview` is called on the API's admin host, never through the web Worker).
3. **Deploy order:** API first, then the web Worker (`node cloudflare/web/check-storefront-build.mjs`, then the web deploy). A web Worker without this change still forwards the header (it forwarded every header but tenant ones and the cookie) but would not force `no-store` on the answer nor drop it from writes.
4. **Staging smoke:** an imported, unpublished shop: `POST /v1/admin/preview` as its admin → open the link → the storefront paints with the banner, the address bar loses the fragment, the API answers carry `no-store` / `noindex`, a checkout is refused; the same link 31 minutes later shows the not-found page and no banner.
5. Open point 1 (payment after unpublish) is a decision for the reviewer, outside this brief.

## What I did NOT do

- No admin page or button (CP5); no change to any storefront page (F); the POD image fetch of open point 2 left to F.
- No change to the payment route (open point 1), checkout, screening, or `eligibility.ts`.
- No `Vary` header on the public answers (the browser never mixes them: a preview read is `no-store` both ways, §6).
- No secret, binding, migration, wrangler, pinned or preflight change; no git write; no deploy.
