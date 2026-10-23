# CP14: shop subdomains, the build report

Mikael decided on 2026-10-23 that shops live at `<label>.flippinstuff.se`. The label is the shop's own choice and is separate from its id: Kent's `melodie-mc` can pick `melodiemc`. The naked apex is the platform host. `www` goes to the apex through DNS and redirect rules, not through code. A shop's own domain (D89/D90) is out of scope here.

Branch `cf-port`. Nothing is deployed or pushed. Codex has not reviewed it.

## What was built

| Piece | Where |
|---|---|
| The config var `PLATFORM_SHOP_DOMAIN` (absent means the feature is off) | `cloudflare/wrangler.jsonc` (staging: `stg-shop.invalid`; production: a `// CP7 replaces` comment), `cloudflare/web/wrangler.jsonc` (see §5, deliberately absent on staging), `src/env.d.ts`, `worker-configuration.d.ts` regenerated, `vitest.config.ts` pins it off for the suites |
| Schema | `cloudflare/migrations/0061_shop_subdomains.sql` |
| Label rules, view, write, the web Worker's question | `cloudflare/src/tenancy/subdomain.ts` (new) |
| Resolution | `resolve-tenant.ts` (a retired hostname resolves only until its grace ends), `shop-hostname.ts` (`/<shop>/` never maps to a retired hostname) |
| The seller's route | `routes/admin-settings.ts`: GET adds `subdomain`; PATCH takes `{ subdomainLabel }` |
| The platform's route | `routes/platform-tenants.ts` + `app.ts`: `GET/PUT /v1/platform/tenants/:id/subdomain` |
| The default at creation | `app.ts` `giveDefaultSubdomain` after `POST /v1/platform/tenants` |
| The service-binding RPC | `src/index.ts` `Internal.canonicalShopHost(target)` |
| The web Worker's 301s | `web/src/subdomain.ts` (new, pure), `web/src/env.ts`, `web/src/index.ts` |
| Preflight | `scripts/cf-preflight.sh`: the var is optional on both Workers and must be a lowercase hostname when set; `guard/preflight.test.sh` +10 cases |
| The seller's admin UI | `src/components/admin/ShopAddressCard.jsx` (new, Admin-Neutral), used by `AdminSettings.jsx` through `adminSettingsData.js` `SHOP_ADDRESS` (null in the older build) |
| The platform console | `PlatformShopDetail.jsx`: the "Butikens adress" card plus `SubdomainCell` (dark), through `platformShopDetailData.js` (`SUBDOMAIN_EDITABLE`, false in the older build) |
| Pure helpers and Swedish copy | `src/admin-app/adapters/shopAddress.js` (+ test) |
| Dev API rows (so the pages can be run locally) | `src/admin-app/dev/subdomain-dev.mjs` (+ test), wired into `dev-api.mjs` |
| Screenshots (dev API, invented data) | `docs/cf-port/shots/cp14/` |

`REQUIRED_MIGRATION` is now `0061_shop_subdomains.sql` (`/ready`).

## 1. The schema (0061)

```sql
ALTER TABLE tenants ADD COLUMN subdomain_label TEXT CHECK (
  subdomain_label IS NULL OR (length 1–63 AND NOT GLOB '*[^a-z0-9-]*' AND NOT GLOB '-*' AND NOT GLOB '*-'));
CREATE UNIQUE INDEX tenants_subdomain_label_idx ON tenants(subdomain_label) WHERE subdomain_label IS NOT NULL;
ALTER TABLE tenant_domains ADD COLUMN redirect_until INTEGER CHECK (redirect_until IS NULL OR redirect_until > 0);
```

- **The label is a column on `tenants`, not a separate table.** The partial unique index gives uniqueness, and a new table would only repeat the tenant key.
- **The hostname a label produces is an ordinary verified `storefront` row in `tenant_domains`.** So the API keeps one tenant rule: a tenant resolves only from a verified hostname.
- **The reserved list lives in code, not in the schema.** It is `RESERVED_SUBDOMAIN_LABELS`: admin, api, cdn, dev, docs, ftp, help, imap, img, mail, mta, ns1, ns2, pop, smtp, stg, staging, static, status, support, test, www. Keeping it in code means it can grow without a table rebuild. `xn--` (punycode) labels are also refused as invalid, because they can spell look-alikes of other names.
- **Backfill.** A guarded `UPDATE` sets `subdomain_label = tenant_id` for `melodie-mc`, `ninetone`, `gif-sundsvall` and `sillmans`. It only does this when the shop already holds the verified row `<id>.stg-shop.invalid` (HANDOVER 2026-09-28). On staging no row is written, because the existing rows become the shops' platform hostnames. Nothing matches in production, so it is a no-op there.
- **Why the number is 0061.** `cp13-affiliate` holds 0058–0060, and those migrations are already applied on staging. Wrangler applies migrations by file name, so 0061 lands after them whichever branch merges first.

## 2. The grace-period design

The goal was to keep it small: one nullable column, `tenant_domains.redirect_until` (epoch ms).

- **Changing the label from A to B, in two steps** (since Codex round 1, see §9):
  1. `tenants.subdomain_label` is updated **alone**, guarded by the label as it was read and an open shop. If 0 rows change, the answer is 409 `conflict`; if the unique index refuses it, the answer is 409 `subdomain_taken`. Either way nothing has been written.
  2. One batch, each statement guarded by the label now being B:
     - another shop's expired row of `B.<base>` is deleted;
     - **every other** live platform hostname of the shop (one label under the base, kind `storefront`) gets `redirect_until = now + 90 days`;
     - `B.<base>` is restored to a live verified storefront row if the shop holds it (retired or disabled), or inserted as verified;
     - the change is audited as `tenant.subdomain_set`, recording `{from, label, hostname, retiredHostname, redirectUntil}` and `actingAsGrantId` under acting-as.
  - If the batch's INSERT meets another shop's live row that appeared after the check, the batch writes nothing, the label is put back (guarded), and the answer is 409 `subdomain_taken`.
  - If the shop's own row of `B.<base>` is not a storefront row (e.g. kind `admin`), the answer is 409 `conflict` and nothing is written.
  - **A crash between the two steps** leaves the label set to B with no B row while A is still live. Nothing resolves wrongly: the shop still resolves on A, and nothing redirects to B because `canonicalPlatformHostname` needs the row. The next identical write takes the "same label, row missing" path and completes it, retiring A then; this is why step 2 retires every other live platform hostname rather than only the one read as previous. Tested.
- **During the grace period:**
  - `A.<base>` still resolves to the shop, so an open tab and its `/_api` calls keep working.
  - The web Worker 301s A's pages and sitemap to B.
  - A stays taken for every other shop.
- **After the grace period:**
  - `A.<base>` resolves to nothing (`resolve-tenant.ts` compares `redirect_until` with the time now).
  - The next shop to claim A deletes the expired row in the same batch as its claim.
  - Nothing sweeps expired rows on a schedule. They are dead rows until someone claims the label.
- **Going back to A within the grace period** un-retires A (restored to `verified` even if an operator disabled it meanwhile) and retires B.
- **The same label again** returns 200 and writes nothing when its row is a live verified storefront row. If the row is missing it is inserted; if it is retired or disabled it is restored; both are audited.
- **The grace length** is `SUBDOMAIN_GRACE_MS = 90 days`. See Q2.

## 3. The routes' contracts

### Seller: `GET /v1/admin/settings` (owner/admin membership, or a platform user's acting-as grant)

`200 { settings, subdomain }`, where `subdomain` is:

```json
{ "baseDomain": "flippinstuff.se", "label": "melodiemc", "hostname": "melodiemc.flippinstuff.se",
  "previous": [{ "hostname": "melodie-mc.flippinstuff.se", "redirectUntil": "2027-01-21T…Z" }] }
```

When the var is absent, every field is null or empty. `previous` lists only retired hostnames whose grace has not ended.

### Seller: `PATCH /v1/admin/settings { "subdomainLabel": "<label>" }`

The label must be alone in the body: no `expectedUpdatedAt` and no settings field, because the label is not part of the fenced settings row. Any other PATCH body is the existing fenced write, unchanged.

| Answer | When |
|---|---|
| `200 { subdomain }` | set, or unchanged |
| `400 invalid_request` | not a string, or mixed with other keys |
| `400 subdomain_invalid` | not a hostname label |
| `400 subdomain_reserved` | a reserved label |
| `409 subdomain_taken` | another shop's label, a hostname another shop holds (including one in grace or one added by hand) |
| `409 subdomains_off` | the var is not configured |
| `409 conflict` | a race was lost, or the shop is closed |
| `404` | the usual opaque 404 (no session, another shop, cross-origin) |

### Platform: `GET /v1/platform/tenants/:id/subdomain` and `PUT … { "label": "<label>" }`

- Platform session only. PUT is same-origin.
- `200 { subdomain, tenantId }`.
- The refusals are the same as the seller route's.
- 404 for an unknown shop.
- 409 `conflict` for a closed shop.
- 400 for a body that is not exactly `{ label: string }`.

### Creation: `POST /v1/platform/tenants`

The request and response are unchanged. When the var is set, the shop's id becomes its label, provided the id passes the rules, is not reserved and is free. Otherwise the shop has no label until it picks one. The creation itself never fails over this.

### Service binding only: `Internal.canonicalShopHost(target)`

- `{ shop }` returns `<label>.<base>` when the shop is active and its label row is verified and live.
- `{ hostname }` (a retired platform hostname still in grace) returns the shop's current one.
- Anything else returns `null`.

It returns a hostname, never a tenant, and a browser cannot reach it. The tenant is still resolved only from the hostname the request lands on.

### Web Worker behaviour

This applies only when `PLATFORM_SHOP_DOMAIN` is set and valid.

- **Shared host:** `GET/HEAD /<shop>/…` (pages and `sitemap.xml`) returns `301 Location: https://<label>.<base>/…` with the same path and query, and `Cache-Control: no-cache`.
- **Retired host:** a host exactly one label under the base whose answer is a different host returns a 301 to it.
- **Never redirected:** `/_api/…`, static files, writes, a shop's own domain, a host with a port, any answer that is not one label under the base, and **the buying flow** (`NO_SUBDOMAIN_REDIRECT_PATHS`: `/cart`, `/checkout`, `/order-return`, `/order-confirmation/…`, matched exactly or as a path prefix, relative to `<root>`). Their state is in origin-scoped storage, so they are served where they arrive for as long as that host resolves.
- **Failures:** a failing or slow answer (the SEO deadline) means no redirect, and the page is served as before.
- **When the var is absent,** the API is never asked.

## 4. Every new Swedish string

From `src/admin-app/adapters/shopAddress.js` `ADDRESS_COPY`, plus two strings in the console:

| Key | Text |
|---|---|
| title | Butikens adress |
| help | Adressen kunderna når butiken på. Små bokstäver a–z, siffror och bindestreck. |
| moved | Byter du adress skickas besökare på den gamla vidare till den nya i 90 dagar. Därefter kan en annan butik ta den. |
| none | Butiken har ingen adress ännu. |
| save / saving | Spara adress / Sparar… |
| saved | Butikens adress sparad: {hostname} |
| unchanged | Adressen är oförändrad. |
| previous | {hostname} skickas vidare hit till {datum}. |
| invalid (ogiltigt tecken) | Ogiltigt tecken. Använd bara a–z, 0–9 och bindestreck, inte först eller sist. |
| tooLong | Högst 63 tecken. |
| empty | Skriv en adress. |
| reserved (reserverat) | Adressen är reserverad för plattformen. Välj en annan. |
| taken (upptagen) | Adressen är upptagen. Välj en annan. |
| off | Butiksadresser är inte påslagna på plattformen ännu. |
| failed | Kunde inte spara adressen. Försök igen. |
| console button (no label yet) | Välj adress |
| placeholder | dinbutik |

The client lowercases and trims what is typed, and checks the grammar early. Reserved labels and "upptagen" (taken) come only from the API, so the client keeps no copy of the reserved list.

## 5. Decisions taken on the way

- **D-CP14-1: the web Worker's staging config leaves `PLATFORM_SHOP_DOMAIN` out. This deviates from the brief.** The brief asked for `stg-shop.invalid` on both Workers. On the web Worker that value would 301 every staging `/<shop>/` page to `https://<label>.stg-shop.invalid/…`, which no browser can reach, and staging browsing would be broken from the deploy onward.
  - The API does carry it, which is harmless: labels and rows are keys only.
  - The redirect is proven in tests instead (`test/web-subdomains.test.ts`).
  - The web var belongs only on an environment whose wildcard `*.<base>` actually routes to the web Worker, which is production at CP7. Both production lines are written as `// CP7 replaces` comments.
- **D-CP14-2: the label cannot be cleared.** There is no "remove the address" action, so a shop's platform address never disappears by mistake. Changing it is the only write.
- **D-CP14-3: one GET carries both.** `GET /v1/admin/settings` carries `subdomain` next to `settings`, and the label write rides the same PATCH path with a body of its own, as the brief asked. The platform has its own sub-route rather than a field in the tenant PATCH, which keeps `updateTenant` untouched.
- **D-CP14-4: 301 with `Cache-Control: no-cache`.** This is the same as the SEO redirect. Browsers revalidate, so a label changed twice never leaves a stale cached 301 to a host whose grace has ended.

## 6. Gates

All gates were run on the working tree before the commit:

| Gate | Result |
|---|---|
| Worker `npx vitest run` | 145 files / 5207 tests, 0 failed (new: `shop-subdomains.test.ts` 30, `web-subdomains.test.ts` 12) |
| `npx tsc --noEmit` (+ `-p web`, `-p admin`) | clean ×3 |
| `npm run types:check` | up to date (the generated file was also stale for the two Prodigi vars before this unit, and is now regenerated) |
| `bash guard/preflight.test.sh` | 453 passed (was 443) |
| `bash guard/deploy.test.sh` | 90 passed |
| Frontend `node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs` | 1182 pass |
| `npx vite build --config vite.admin.config.js` + `check-admin-build.mjs` | OK |
| `npx vite build` (older build) + `check-storefront-build.mjs` | OK |
| `node guard/guards.test.mjs` | PASS (allowlist 292) |
| `node --test "scripts/cf-port/migrate/test/*.test.mjs"` | 553 pass, **1 fail, which was already failing before this unit and is not from it.** `staging-legal.test.mjs` "the terms text is the one 0031 seeded": `src/config/platformTerms.js` changed in `0d1ba4d8` (brand → Flippin Stuff) after 0031 seeded its sha. CP13's 0059 re-seeds it. |

The rendered pages were checked on the admin dev server (dev API, invented data) at 1280 and 375 px. The settings card was checked empty, reserved, invalid and saved (the old address showing its grace). The console card was checked taken and saved. Screenshots are in `docs/cf-port/shots/cp14/`.

**Not checked:** the pages against staging, and a real wildcard host. The second is impossible before the domain exists.

## 7. Open questions for Mikael

1. **Q1: the staging web var.** Should the web Worker's staging config stay without the var (D-CP14-1), or should staging get a real, reachable wildcard base, e.g. a `*.stg.flippinstuff.se` route, once the zone exists? In that case staging `/<shop>/` pages would redirect for real.
2. **Q2: the grace length.** It is 90 days. During that time the old address keeps redirecting and nobody else can take it. Is that right?
3. **Q3: hand-added hostnames.** `POST /v1/platform/tenants/:id/domains` (the operator's add-domain route) still accepts any hostname, including `admin.<base>` or another shop's would-be label. It is operator-only and trusted, but should it refuse reserved labels under the base and route platform hostnames through the label instead?
4. **Q4: the domain move route.** `/v1/platform/domains/move` can move a platform hostname row to another shop without moving the label. Should platform hostnames be excluded from the move route?
5. **Q5: what is reserved.** Is the reserved list right? It is exactly the brief's 22. Candidates not added: `platform`, `shop`, `app`, `affiliate`, `blog`, `m`.
6. **Q6: storefront links.** The console's "Öppna butiken" link (`storefrontUrlOf`) and the storefront's own links still use the shared host's `/<shop>` address. With the web var on, those 301 once. Should they point straight at the subdomain once production is on it?
7. **Q7: unpublished-shop previews.** The preview of an unpublished shop (D57, grant in the fragment) follows the 301 to the subdomain. Browsers keep the fragment across a redirect, but this is not verified end to end.
8. **Q8: production setup.** For production at CP7, set each imported shop's label through `PUT /v1/platform/tenants/:id/subdomain`, and Kent picks `melodiemc` himself. The runbook's §6.5 step 1 (`<shop>.shop.invalid`) could become that call. Should the runbook be changed?
9. **Q9: the cart at the first move.** The cart is in origin-scoped `localStorage`. A customer who has filled a cart on the shared host's `/<shop>/` (or on a retired host) and then opens an ordinary page is moved to the subdomain, where the cart is empty. The buying flow itself is exempt (Codex round 1), but browsing is not. This only bites at the moment the var is switched on, or during a label change. Accept it, or carry the cart across (e.g. a one-time hand-over in the redirect)?

## 8. For the reviewer

- **Migration:** 0061 needs to be applied on staging before the API deploy (`/ready` requires it).
- **What the staging API deploy changes:**
  - The four shops get labels.
  - A new shop created on staging gets `<id>.stg-shop.invalid`.
  - The web Worker is unchanged because its var is absent.
- **Merging with `cp13-affiliate`:** it also edits `provision-tenants.ts` (reserved tenant ids), `REQUIRED_MIGRATION` (`0060`) and the two `0057` test pins. Expect small conflicts there. `REQUIRED_MIGRATION` must end up as `0061_shop_subdomains.sql`.
- **Not mine, left alone:** `docs/cf-port/CP10_OB_DESIGN.md` (modified) and `scripts/cf-port/prestage-zones.mjs` (untracked) were in the tree from someone else and are not part of this commit.

## 9. Codex round 1 (on `b7a1112d`, log `docs/cf-port/codex-logs/codex-b7a1112d.log`)

There is no schema change: 0061 is already applied on staging, and every fix is in code.

| Finding | What changed | Test |
|---|---|---|
| **P1: the payment return during a label change.** A redirect-based Stripe payment returns to `<origin><root>/order-return`, and the pending checkout id and receipt token live in that origin's `sessionStorage` (`src/api/orders.js`). A 301 of the return (on a retired host, or on the shared host's `/<shop>/` form) to the subdomain lost them, so the paid order could not be shown. | `web/src/subdomain.ts`: `NO_SUBDOMAIN_REDIRECT_PATHS` = `/cart`, `/checkout` (the cart is in `localStorage`, `src/storefront/providers/Cart.jsx`), `/order-return` (Stripe's `return_url`, `StripePaymentForm.jsx`) and `/order-confirmation/…`. These are matched exactly or as a prefix followed by `/`, so `/order-returns` still moves. `subdomainQuestion` asks nothing for them, so they are served where they arrive while that host resolves. | `web-subdomains.test.ts`: the four paths with a Stripe return query on the shared and on a retired host are not redirected and the API is not asked; `/produkt/x`, `/order-returns` and `/checkouts` still 301. |
| **P2: reclaiming an own retired hostname that an operator disabled.** The batch cleared `redirect_until`, skipped the INSERT, left the row `disabled`, reported success and retired the working address. | The restore UPDATE now sets `status = 'verified'`, `verified_at = COALESCE(verified_at, now)`, and only matches `kind = 'storefront'`. It runs whenever the row is retired **or** not verified; the same-label short-circuit applies only to a live verified row. An own row that is not a storefront row is refused as **409 `conflict`**, nothing written. I chose `conflict` because the row is the shop's own and `taken` would misdescribe it; the seller sees "Kunde inte spara adressen. Försök igen." | Own row disabled → after the claim it is verified, resolves, is canonical, and the other is retired. The same label again restores a disabled row. Own row of kind `admin` → `conflict`, label unchanged, the live row not retired, no audit row. |
| **P2: two concurrent A→B requests.** The loser's label UPDATE changed 0 rows, but `isNow` (label = B) was true, so its follow-ups ran and a second audit row was written before the 409. | Two steps (§2): the guarded label UPDATE runs alone first; 0 changes → `conflict` before any batch. The batch's success is read from its last statement (the audit INSERT). The code comment explains why a crash between the steps is safe. | A losing request (the winner commits inside the loser's label UPDATE) gets `conflict`, sends no batch, adds no audit row and no domain row. A crash at the batch leaves the old address live and no redirect, and the next identical write completes it. |

Gates after the fixes:

| Gate | Result |
|---|---|
| Worker vitest | 145 files / 5213 tests, 0 failed (`shop-subdomains` 35, `web-subdomains` 13) |
| tsc (root, `-p web`, `-p admin`) | clean ×3 |
| `guard/preflight.test.sh` | 453 |
| `guard/deploy.test.sh` | 90 |
| Frontend `node --test` | 1182 |
| `node guard/guards.test.mjs` | PASS |

Q9 (the cart at the first move) was added as a result of P1.

### Codex round 2 (on `9445da34`, log `docs/cf-port/codex-logs/codex-9445da34.log`)

**P2: the same-label early return could skip a retirement that was never finished.** Codex reproduced it against SQLite. The case:
1. The shop already held a live verified row for B, an alias added by hand.
2. An A→B change crashed after step 1. The label read B, A was still live, and there was no audit row.
3. The retry saw "same label, own row live" and answered `ok, changed: false`.

A was never retired, never redirected, and the change was never audited.

**Fix (`subdomain.ts`):** the early return now requires that nothing is left to do: the own row is live **and** the shop has no other live platform hostname (one label under the base, kind `storefront`, `redirect_until` NULL, not the target). The check uses the same `onePlatformLabel` predicate as step 2. Otherwise the call falls through to both steps. Step 1 is a guarded no-op re-write of the same label; step 2 retires the others and audits. That audit says `from` = the label as read (B, on such a retry) and names what it retired in the new `retiredHostnames` metadata key, which an ordinary A→B change also fills.

**Test:** an interrupted A→B where B was already a live alias. The retry retires A (A now redirects to B), audits exactly once with `from: B` and `retiredHostnames: [A]`, and answers `ok, changed: false`. A further same-label call then issues no write at all (no `run`, no batch) and adds no audit row. With the old condition put back, this test fails.

**Gates after round 2:**

| Gate | Result |
|---|---|
| Worker vitest | 145 files / 5214 tests, 0 failed |
| tsc (root, `-p web`, `-p admin`) | clean ×3 |
| `guard/preflight.test.sh` | 453 passed |
| `guard/deploy.test.sh` | 90 passed |
