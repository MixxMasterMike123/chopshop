claude-opus-5-5

# CP13 A3: storefront form, `?ref=`, cart/checkout wiring, and the affiliate portal

Worktree `.claude/worktrees/cp13-affiliate`, branch `cp13-affiliate`. I worked in the working tree only: no git write, no deploy, no wrangler, no network. Before writing, I read CP13_BRIEFS §0/§1/A3, the A1 report §4 (the contract), design §2.1/§2.2/§7.1–§7.4/§8, CP4 §0 rules 1–12, CP5 §0 rules 13–19, DESIGN.md (NORD), and every file listed below.

A2 and A4 worked in the same tree at the same time. None of my files changed under me. The only files I touched outside the brief's list are flagged in §2 (★).

## 1. Gate (rule 19)

The gate below was run on the final tree.

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs src/admin-app/**/*.test.mjs \
            src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
    → # tests 1258 · # suites 358 · # pass 1258 · # fail 0
npx vite build --config vite.admin.config.js   → ✓ built
node cloudflare/admin/check-admin-build.mjs    → admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs → storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build (the older build)               → ✓ built
node guard/guards.test.mjs                     → guard: FAIL — (b) 5 stale guard/allowlist.txt entries:
                                                 src/pages/admin/AdminAffiliate{Analytics,Create,Edit,Payout,s}.jsx
```

**The guard failure is not caused by my changes.** Those five files are A2's ports. They no longer contain the old-brand words, so their allowlist rows are stale, and `guard/*` is reviewer-only.

I also checked my own new files, which are untracked and so outside the guard's scan. I grepped them by hand for the three guard families and found nothing. `src/config/tenancy.js` already matched before my change and is allowlisted; my diff adds no match.

**I ran one Worker test to prove a known side effect** (see Reviewer wiring 1):

```
cd cloudflare && npx vitest run test/web-routing.test.ts
→ 1 failed | 189 passed: "reserves exactly the non-shop first segments of src/config/tenancy.js"
```

## 2. Files

**New:**
- `src/pages/shop/AffiliateApply.jsx`: the storefront form (NORD).
- `src/api/affiliate.js` + `affiliate.test.mjs`: the terms read, the apply call, and the pure body/ready/refusal helpers.
- `src/api/affiliate-portal.js` + `affiliate-portal.test.mjs`: every `/v1/affiliate/*` route, with `X-Shop-Id` on each.
- `src/admin-app/AffiliateApp.jsx`: the third tree (shell, gate, shop picker, terms gate).
- `src/admin-app/pages/affiliate/`:
  - `portalContext.js`
  - `Overview.jsx`, `Orders.jsx`, `Payouts.jsx`, `Profile.jsx`, `Terms.jsx`, `Guide.jsx`, `Material.jsx`
- `src/admin-app/adapters/affiliatePortal.js` + `affiliatePortal.test.mjs`: the portal's pure parts.
- `docs/cf-port/shots/cp13-a3/*.png` (13 screenshots, §6).

**Modified:**
- `src/admin-app/main.jsx`: three trees, picked by path.
- `src/admin-app/providers/Session.jsx`: `tree="affiliate"`, and `login()` also resolves `accountType`.
- `src/pages/LoginPage.jsx`: an affiliate is sent to `/affiliate`.
- `src/components/auth/AdminRoute.jsx`: an affiliate is sent to `/affiliate`, never to `/login` with "Du har inte behörighet".
- `src/storefront/StorefrontApp.jsx`: the route `/affiliate`.
- `src/storefront/pages.jsx`: the gated swap line.
- `src/storefront/providers/Cart.jsx`: the `?ref=` hook, the stamp, both codes, the notices.
- `src/storefront/adapters/discount.js` + test: the ref helpers.
- `src/storefront/adapters/checkout.js` + test: `refCode`, `overriddenBy`.
- `src/api/checkout.js`: `refCode`.
- `src/config/tenancy.js`: `affiliate` reserved.
- `src/components/shop/ShopFooter.jsx`: "Bli affiliate".
- `src/pages/shop/ShoppingCart.jsx` and `Checkout.jsx`: the labels and notices.
- `src/pages/shop/OrderConfirmation.jsx`: the sentence dropped.

**★ Touched outside the brief's list** (small, and needed for "refCode sent in createCheckout and in the preview"; no other builder owns them):
- `src/api/discountCodes.js` + `discountCodes.test.mjs`: the preview gains `refCode`, and `code` becomes optional. The brief names "the preview", but its client lives here.
- `src/components/shop/StripePaymentForm.jsx`: the checkout request is built here, not in Cart.jsx. The change adds `refCode: linkCode` from `useCart()` (3 lines). The older build's cart has no `linkCode`, so nothing is sent there.

## 3. Routes used (A1 §4, unchanged)

**Storefront** (the storefront client, flat paths):
- `GET /v1/affiliate-terms`
- `POST /v1/affiliate-applications`: 202, 400, 404 and 429 are each worded.
- `POST /v1/discount-codes/preview { code?, refCode?, items }`
- `POST /v1/checkout { …, discountCode?, refCode? }`: the answer's `overriddenBy: 'link'` and its echoed `discountCode` are read.

**Portal** (`/_api` on the admin host; `X-Shop-Id` on every request; a 404 is followed by a `/v1/me` re-read, and a 401 there means sign in again):
- `GET /v1/affiliate/me`, `/orders`, `/payouts`, `/terms`
- `POST /v1/affiliate/payouts`, `/terms/accept`, `/objects`
- `PUT /v1/affiliate/objects/:id/content`
- `GET /v1/affiliate/payouts/:id/invoice` (fetched as a Blob, because a plain link cannot carry the header)
- `PATCH /v1/affiliate/profile`
- `GET /v1/affiliate/ledger` is wired and tested in the client but shown on no page (§5).

**Session:** `GET /v1/me` with `accountType: "affiliate"` and role-`affiliate` memberships. The usable shops are those with `status === 'active'`.

## 4. The cart's stored shape (`localStorage["storefront-cart:<root>"]`)

```
{ items, shippingCountry, discountCode, refCode, source: 'link' | null, refAt: <ms epoch> | null }
```

**Loading:** `loadStoredCart` keeps `refCode`/`source`/`refAt` only when they are well shaped and `now − refAt ≤ 30 days`. Otherwise all three become null.

**The `?ref=` landing:**
- The `ref` of the arrival address is read at mount, before any client-side move.
- Once `GET /v1/storefront` answers with `features.affiliate === true`:
  - the code is normalised (trim, upper case, the discount-code shape) and stamped `{ refCode, source: 'link', refAt: Date.now() }`;
  - the parameter is removed with `history.replaceState`, keeping the router's state and the other parameters.
- With the program off, the hook does nothing.
- Two `ref` parameters, or a malformed one, store nothing; the parameter is still stripped while the program is on.

**Use of the code:**
- **Live code:** `linkCode` is `refCode` when the stamp is valid and `affiliate` is on. It is sent as `refCode` to the preview and to the checkout. With the program off it stays stored but is not sent.
- **Clearing:** `clearCart()` empties everything, including the stamp. It runs after a completed checkout (StripePaymentForm, Checkout, OrderReturn) and also in CheckoutRecoveryPage (see §5).
- **`removeDiscount()`:** removes the typed code. If there is none, it removes the link code, which gives the buyer a way out of a link code the checkout could not apply.
- **`discountsOn`:** `affiliate || discountCodes`.

**What the buyer sees:**
- **Code box:** pre-filled with the typed code, or else the link code. Under it:
  - "Länkkod ANNA10 tillagd – 10 % rabatt" when the link applies;
  - "Länkkoden ANNA10 används i stället" when a typed code lost to the link (preview echo, or the checkout's `overriddenBy: 'link'`).
- **Discount rows:** "Rabatt (KOD)" in the cart and at checkout. The code is the one the server applied.
- **Checkout confirmation:** reduced to one generic box (DEV-11: the campaign/affiliate split is dropped).
- **OrderConfirmation:** the "registrerats för affiliate-provision" sentence is removed.

## 5. Not done, deviations, contract gaps

**Rule 17:** no control left a ported page. ShoppingCart and Checkout lost the "Affiliate rabatt, N%" label branch and the "Affiliate-rabatt aktiverad!" box (design §7.4, DEV-11). OrderConfirmation lost one sentence.

**Contract gaps (route + field):**
1. **No "Logga in som affiliate" link.** `GET /v1/storefront` carries no admin origin, and the storefront has no other way to learn the admin host. A literal hostname was forbidden. Proposed: the storefront body gains `adminOrigin` (from CANONICAL_ORIGINS), and the footer then gets a two-line change.
2. **`/affiliate/material` is not built.** `GET /v1/affiliate/me` (PortalMe) has no `marketingMaterials` flag, and no route lists the materials. The page redirects to the overview and is not linked. Proposed: a PortalMe member `marketingMaterials: boolean` plus a materials read.
3. **The link percent is read back, not received.** The preview names no rate, by design, but the copy wants "10 % rabatt". `linkDiscountPercent` works the percent back from the server's amount and the cart's subtotal, using the server's own rule `ceil(sub × p / 100)`. It shows the figure only when exactly one whole percent fits; otherwise the line reads "Länkkod ANNA10 tillagd". This only echoes the amount and leaks nothing. Alternative: the preview could answer `discountBp`, but the design §2.2 no-rate rule forbids it.

**Deviations, with reasons:**
- **Reserved slugs.** The design/brief say "reserved slug in `src/config/tenancy.js`, `affiliate-login` leaves". That list holds non-shop FIRST segments (shop ids), not content-page slugs. So:
  - I added `affiliate`. It is also the portal's tree on the admin host, beside `admin` and `platform`.
  - I kept `affiliate-login`, because the older build still routes `/affiliate-login`.
  - The real page-slug reservation is `cloudflare/src/content/pages.ts RESERVED_PAGE_SLUGS` plus migration 0042's `pages_reserved_slug_*` triggers. That is server work and not mine (Reviewer wiring 2).
  - In the meantime, `<root>/affiliate` with the program OFF falls through to `DynamicRouteHandler`: a merchant page with that slug, or else the shop's 404. With the program ON, the form shadows such a page.
- **Footer key.** The footer uses a new translation key, `footer_affiliate_apply`. The existing `footer_become_affiliate` reads "Bli en affiliate" in `src/locales/sv-SE.json`; the design's copy is "Bli affiliate".
- **The older build's footer** now shows "Bli affiliate" → `<shop>/affiliate` for a Firebase shop with the add-on on. That build routes the form at `affiliate-registration`, so the link 404s there. It is the rollback artifact only.
- **Recovery clears the link.** `CheckoutRecoveryPage` (abandoned-checkout link) calls `clearCart()` to rebuild the cart, which also drops a live link stamp. Distinguishing the two cases would require changing callers I do not own.
- **No ledger page.** The design §7.3 lists none. The overview, orders and payouts pages cover the ledger's effect.
- **The portal's client** (`src/api/affiliate-portal.js`) has its own request function and reuses `AdminApiError`/`getMeRaw` from `src/api/admin/client.js`. The admin client refuses non-`/v1/admin/` paths, and its lost-session announcer is private. The portal handles a lost session with a full load of `/login`.
- **"Byt lösenord"** is a link to `/forgot-password`, the ordinary reset on the admin host, as the brief asks.

**Not done:**
- No staging check (no network, no deploy).
- No test of the React components themselves. All logic lives in the pure modules under test, and the components were checked rendered (§6).
- The stale comment in `vite.storefront.config.js` ("never an affiliate one (D81)") is not mine to edit.

## 6. Rendered check (`docs/cf-port/shots/cp13-a3/`)

**Harness:** no network or credentials are needed. Two scratch Vite configs (outside the repo) reuse `vite.storefront.config.js` and `vite.admin.config.js` with a stub middleware in front, serving invented data. Screenshots were taken with the local headless Chromium.

**Storefront:** the `provbutiken` fixture with `affiliate: true`. The terms, application, and link-code preview routes are stubbed.
- `01-ansokan-desktop`, `02-ansokan-mobil`: the form, with the terms box and the checkbox copy.
- `03-varukorg-lankkod`: `?ref=anna10` gives "Länkkod ANNA10 tillagd – 10 % rabatt" and "Rabatt (ANNA10)".
- `04-varukorg-lankkod-anvands`: typed SOMMAR20 plus the link gives "Länkkoden ANNA10 används i stället".
- `05-affiliate-av-404`: a shop with the add-on off shows the shop's 404 page.

**Portal:** `/v1/me` answers as an affiliate, and `/v1/affiliate/*` comes from invented data.
- `10`/`11` overview, desktop and mobile.
- `12` orders.
- `13` payouts.
- `14` payouts blocked, with the program paused banner and the disabled-reasons.
- `15` profile.
- `16` terms gate: `/affiliate/orders` with `terms.outdated` lands on Villkor.
- `17` guide.
- The shop picker (two memberships) was also looked at.

**Not looked at:**
- the thank-you state, the 429/400 messages, the Material redirect, a live upload, and the checkout step (they need clicks or Stripe);
- the login redirect against a real session.

The cart screenshots show "UllmÃ¶ssa": that is a charset slip in my seed page, not the app.

**`impeccable` (critique pass):**
- Form (NORD):
  - inputs raised to 16px;
  - placeholders and hints moved to the AA "muted" tier;
  - the heading made responsive and balanced;
  - `rel` added to the policy link.
- Portal (Admin-Neutral):
  - fixed a horizontal overflow of the code/link card on mobile (`min-w-0`);
  - the order and payout table cells no longer wrap;
  - the picker's text arrow replaced by an SVG chevron.

No redesign was made; the incumbent tokens are kept.

## 7. Reviewer wiring

1. **`cloudflare/web/src/shop-segment.ts`:** add `"affiliate"` to `TENANCY_RESERVED_SEGMENTS`. It mirrors `NON_SHOP_FIRST_SEGMENTS` verbatim, and `test/web-routing.test.ts` fails until it does (verified above). I did not edit it; it is A1's file.
2. **Page-slug reservation (design §7.1, "a merchant content page cannot take it"):** add `affiliate` to `cloudflare/src/content/pages.ts RESERVED_PAGE_SLUGS` plus a new migration replacing 0042's `pages_reserved_slug_*` triggers. `test/pages.test.ts` pins the two together.
3. **Guard:** remove the 5 stale `guard/allowlist.txt` rows (A2's files, §1), then re-run the guard after committing. My new files are untracked, and I grepped them clean by hand.
4. **Contract gaps** (§5): `adminOrigin` on `GET /v1/storefront` for the footer's "Logga in som affiliate", and `marketingMaterials` plus a materials read for the portal's Material page.
5. **Nothing else:** no `wrangler.jsonc`, `env.d.ts` or migration change from A3. The admin Worker already serves every `/affiliate/*` address as the shell and forwards the `/v1/affiliate` prefix (A1).

## 8. Round 1 fixes (adversarial review, verdict "mergeable with fixes")

This section supersedes the earlier sections where they differ. That applies to:
- §4: the "10 %" notice, `removeDiscount()`, and `clearCart`;
- §5: contract gap 1 (the login link) and gap 3 (the read-back percent).

The reviewer's wiring is already committed on `c759d001`: `shop-segment.ts` reserves `affiliate`, the stale guard rows are gone, and the storefront body carries `adminOrigin`.

### MUST

**1. Commission-only affiliate (0 % buyer discount) at checkout.**
- **Rule:** `discountNotAppliedOf(quote, linkCode)` is new in `src/storefront/adapters/checkout.js`. When the quote echoes the cart's LINK code with `discountMinor` 0, that is attribution only: nothing is said and nothing is offered. Only another code echoed with 0 still says "Rabattkoden … kunde inte användas" and offers "Ta bort koden".
- **Checkout.jsx** uses the rule, with `linkCode` taken from the cart.
- **`removeDiscount()` now drops the typed code only.** It never touches the link stamp, so no notice about a typed code can cost the affiliate the order.
- **In the cart, the 0 % link code is silent.** The box is not pre-filled and no line is shown. The box is pre-filled with the link code only when the preview says the link gives a discount.
- **Tests:** `checkout.test.mjs` "discountNotAppliedOf …" (typed 0 → said; link 0 → silent; applied, none, or no quote → silent).

### SHOULD

**2. Ref grammar.**
- `REF_CODE_PATTERN = /^[A-Z0-9-]{3,20}$/` is applied after normalisation, in `refCodeFromSearch` and in `storedRef` (a stored code outside the grammar is dropped at load).
- The hook stamps only a non-null code, so an invalid `?ref=` never replaces a live stamp; the parameter is still stripped.
- **Tests:** under 3, over 20, `_`, `Å`, lower case normalised, and "an invalid ?ref= never replaces a live stamp".

**3. No worked-back percent.**
- `linkDiscountPercent` is removed.
- The notice is now "Länkkod ANNA10 tillagd – rabatten visas i summeringen". The amount shows in the summary row "Rabatt (ANNA10)".
- **Tests** updated: no `link_added_percent` message exists any more.

**4. "Ta bort" for a link code.**
- `useCart().removeLinkCode()` is new. It is the buyer's deliberate choice and clears the stamp.
- The cart shows it beside the link notice. It is separate from `removeDiscount` and from item 1's checkout notice, which never offers it.

**5. Portal banner by status.**
- `portalBannerOf(affiliate)` is new in the adapter. It checks:
  1. status `inactive` → "Ditt affiliatekonto är inaktivt. Kontakta butiken."
  2. status `suspended` → "Ditt affiliatekonto är avstängt. Kontakta butiken."
  3. `programActive` false → the existing "Programmet är pausat av butiken …".
- `AffiliateApp.jsx` renders it.
- **Test:** `affiliatePortal.test.mjs`.

**6. No raw red in the portal.** `text-red-600` became `text-admin-critical-text` in `Orders.jsx`, `Payouts.jsx`, `Terms.jsx` and `Profile.jsx`.

**7. Recovery keeps the link.**
- `clearCart({ keepRef: true })` keeps `refCode`/`source`/`refAt`. Plain `clearCart()` still empties everything after a completed checkout.
- `CheckoutRecoveryPage.jsx` uses it (★ one call; the coordinator named this file for the fix).

**8. "Logga in som affiliate".**
- `affiliateLoginUrl(storefront)` is new in `src/storefront/adapters/storefront.js`. It returns `<adminOrigin>/login` from the body's `adminOrigin`, and null for no origin or a non-http(s) origin. It never builds a hostname of its own.
- **`ShopFooter`** shows the link while the add-on is on. It reads the body through `useStorefront()`. The older build has no provider, gets the context's default body, and so shows no link.
- **Translation key:** the new key `footer_affiliate_sign_in`, because the existing `footer_affiliate_login` reads "Affiliate-inloggning".
- **Test:** `src/storefront/adapters/storefront.test.mjs` (new).

**9. Sign-in deep link and a revoked shop.**
- **Deep link:**
  - The new helpers `affiliateReturnPath(next)` and `signInUrlFor(pathname)` accept only `/affiliate` addresses with plain path characters. A test covers the hostile cases (`//host`, `https://…`, `/affiliatex`, a query).
  - A signed-out visit to `/affiliate/payouts` goes to `/login?next=%2Faffiliate%2Fpayouts`. So does a session lost under the portal (the client's handler, and the Session provider's `tree="affiliate"`).
  - After signing in as an affiliate, `LoginPage` loads `next` when it is a portal address, else `/affiliate`.
- **Revoked mid-session:**
  - When the shop answers with a 404 for `/v1/affiliate/me`, the shell re-reads `/v1/me` (`refresh()`). If the shop has left the memberships, the tab's choice is cleared, and the only remaining shop opens (or the picker, if several remain).
  - If the shop is still listed, the "Ingen åtkomst" message now offers "Till <shop>" for each other usable shop, beside "Logga ut".

### Gate (round 1, final tree)

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs src/admin-app/**/*.test.mjs \
            src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
    → # tests 1273 · # pass 1273 · # fail 0
npx vite build --config vite.admin.config.js   → ✓ built
node cloudflare/admin/check-admin-build.mjs    → admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs → storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                 → ✓ built
node guard/guards.test.mjs                     → guard: PASS (allowlist 288, baseline 288)
```

### New screenshots (`docs/cf-port/shots/cp13-a3/`)

These use the same scratch harness as before. The storefront fixture gains `adminOrigin: https://admin.example.test`, and the stub preview answers `NOLL0` as a 0 % link.

- `20-varukorg-provision-utan-rabatt-0pct.png`: `?ref=noll0` gives an empty code box, no notice and no discount row. The footer shows "Logga in som affiliate".
- `21-varukorg-lankkod-ta-bort-och-inloggningslank.png`: `?ref=anna10` gives "Länkkod ANNA10 tillagd – rabatten visas i summeringen" with "Ta bort", "Rabatt (ANNA10)", and the footer link to `https://admin.example.test/login`.
- `22-portal-banner-pausad.png`, `23-portal-banner-inaktiv.png`, `24-portal-banner-avstangd.png`: the three banners.

**Not looked at rendered:**
- the checkout payment step for the 0 % case (it needs Stripe; the rule is tested in the adapter);
- the sign-in round trip and the mid-session revoke (they need a real session; the helpers are tested).

## 9. Round 2 (Codex, `docs/cf-port/CP13_CODEX_REVIEW.md`, findings 1 and 6)

### Finding 1 (BLOCKING): a typed 0 % affiliate code never reached checkout

**The defect.** The cart kept a typed code only when the preview said `applies: true`. The preview answers a commission-only affiliate (0 % buyer discount) exactly like an unknown code; that is its no-oracle rule. So the cart dropped the code, and the affiliate earned nothing.

**Fix, without adding an oracle.**
- **`keepTypedCode(outcome, code)`** is new in `src/storefront/adapters/discount.js`.
  - A code that applies is kept, as before.
  - A code the preview answered 200 for without a discount (`not_applicable`) is kept when it matches the affiliate grammar `^[A-Z0-9-]{3,20}$`.
  - A 400, a 429, an unreachable preview, or a code outside the grammar is not kept, as before.
- **`applyDiscountCode` in `Cart.jsx`** stores such a code as `cart.discountCode`. The payment form already sends `cart.discountCode` as `discountCode`, so it reaches the checkout and the affiliate earns.
- **The cart's notice for a kept code without a discount** is now `{ kind: 'no_discount' }`: "Koden ANNA gav ingen rabatt just nu", beside the existing "Ta bort".
  - The sentence is true for an unknown code, for a code below its minimum, and for a 0 % affiliate alike.
  - The confirming toast after "Applicera" is neutral rather than green.
- **The checkout's not-applied box** for a typed code with 0 now reads "Koden {{code}} gav ingen rabatt just nu." (new key `checkout_discount_no_discount`).
  - "Ta bort koden" still calls `removeDiscount()`, which drops the typed code only and never the link stamp.
  - The link code echoed with 0 stays silent (round 1, item 1).

**Tests.**
- `discount.test.mjs`, "a typed code without a discount":
  - a 200 `{ applies: false, discountMinor: 0 }` is `not_applicable`, `keepTypedCode` keeps `ANNA`, and `buildCheckoutRequest` sends `discountCode: 'ANNA'`;
  - `SOMMAR_20`, `AB`, 21 characters, and the `invalid_format`/`rate_limited`/`unavailable` outcomes are not kept;
  - the `no_discount` notice and its words.
- `checkout.test.mjs`: a typed `ANNA` echoed with 0 is told (the neutral sentence); the link code echoed with 0 is silent.

**Note.** A grammar-valid campaign code below its minimum spend is now also kept, with the same neutral line. That matches the cart's existing rule: a code that stops applying stays stored, so the buyer may add items to reach the minimum.

### Finding 6: portal links with `?shopId=` were ignored

**What changed in the adapter (`affiliatePortal.js`).**
- **`requestedShopIdOf(search)`** reads exactly one `shopId` of the tenant grammar.
- **`resolveAffiliateShopId(me, chosen, requested)`** takes the shop in this order:
  1. the requested shop, when `/v1/me` lists it as a usable affiliate membership;
  2. else the stored choice;
  3. else the only shop;
  4. else the picker.
  An unauthorised or malformed request is ignored.
- **The shell (`AffiliateApp.jsx`)** reads `?shopId=` once on arrival. An authorised request becomes the tab's stored choice, is consumed, and leaves the address. The top-bar picker also clears any pending request.

**Through sign-in.**
- `signInUrlFor(pathname, search)` keeps exactly one query key, `shopId`, validated to the tenant grammar.
- `affiliateReturnPath` admits `/affiliate…?shopId=<tenant>` and nothing else: no other key, no second key, no upper case, no `//`.
- Three call sites pass `window.location.search`: the shell's sign-out redirect, the client's lost-session handler, and `Session.jsx`'s affiliate tree.
- `LoginPage` loads the validated `next`.

**Tests (`affiliatePortal.test.mjs`).**
- An explicit valid shop wins over the stored one.
- These are ignored: a suspended shop, an admin membership, an unknown shop (which gives the picker), and malformed queries (upper case, `%2F`, two keys, empty).
- The round trip `/affiliate?shopId=andra-butiken` → `/login?next=%2Faffiliate%3FshopId%3Dandra-butiken` → `affiliateReturnPath` gives the same address back.
- Extra keys are dropped and a bad `shopId` is dropped; hostile `next` values are refused.

### Gate (round 2, final tree)

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs src/admin-app/**/*.test.mjs \
            src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
    → # tests 1278 · # pass 1278 · # fail 0
npx vite build --config vite.admin.config.js   → ✓ built
node cloudflare/admin/check-admin-build.mjs    → admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs → storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                 → ✓ built
node guard/guards.test.mjs                     → guard: PASS (allowlist 288, baseline 288)
```

### Screenshots (same scratch harness)

- `30-varukorg-skriven-kod-utan-rabatt.png`: a cart holding the typed `ANNA`, which the dev preview answers without a discount. It shows "Koden ANNA gav ingen rabatt just nu" with "Ta bort" and no discount row.
- `31-portal-lank-med-shopid.png`: `/affiliate?shopId=sportbutiken` for a person in two shops opens Sportbutiken directly, with no picker. The page's data is the stub's single fixture, so the overview text still names Provbutiken.

**Not looked at rendered:**
- the "Applicera" click itself, which needs interaction; its logic is tested;
- the checkout payment step, which needs Stripe;
- the sign-in round trip, which needs a real session; its helpers are tested.

### Files this round

- `src/storefront/adapters/discount.js` + test
- `src/storefront/adapters/checkout.test.mjs`
- `src/storefront/providers/Cart.jsx`
- `src/pages/shop/ShoppingCart.jsx`, `Checkout.jsx`
- `src/admin-app/adapters/affiliatePortal.js` + test
- `src/admin-app/AffiliateApp.jsx`
- `src/admin-app/providers/Session.jsx`
- this report

Nothing under `cloudflare/` was touched, and no A2 or A4 file was touched.
