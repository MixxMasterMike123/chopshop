Model: claude-opus-5-5 (Opus 5.5)

# CP5-FI report: the platform console's shop pages

Built in the working tree on `cf-port`, beside the other builders. No git command that writes, no network (localhost only), no wrangler, no deploy. The older build's dev server was not started.

## (a) What leaves, control by control

Each leaves only in the admin build, through a constant of the page's data module (the FF pattern, `BALANCE_READ`). The older build renders as before.

| Page | Control | Why |
|---|---|---|
| PlatformShops | The columns **Produkter, Ordrar, Kunder** (header and cells) | No route answers per-shop counts (gap analysis §2c). `SHOW_COUNTS` is false; the columns leave rather than show zeros. |
| PlatformShopDetail | The **"Översikt"** card (the same three counts) | Same reason |
| PlatformShopDetail | **"Migrera från Shopify"** and **"Migrera från WooCommerce"** | PORT-LATER (gap analysis §1b). `MIGRATORS` is false. Both modals are aliased to a null component, so their callables stay out of the bundle. |
| PlatformShopDetail (Juridik card) | The rows **"Butikens villkor godkända"** and **"Plattformsvillkor godkända"** (who, when, version) | The platform detail does not carry these facts (gap analysis §2c, PlatformShopDetail GAP). `LEGAL_FACTS` is false. |
| shopCells `LegalCell` | The **platform-terms pill** ("Plattformsvillkor v…" / "ej godkända" / "gammal version") | Same: there is no platform read of the terms status |
| ProvisionShopModal | **"Accentfärg"** (colour picker) | No platform route writes a shop's store identity. `ACCENT_FIELD` is false. |
| ProvisionShopModal | The `shopType` audit crumb and `provisionedVia` (not visible) | No column |
| AddShopUserModal | **"Namn"** | `POST /v1/platform/users` takes no name and no route stores one. `NAME_FIELD` is false. |
| AddShopUserModal | "Create with password / send credentials" | There was no password field in this modal. The admin is now **invited** (a password-set link); the operator never chooses or sees a password. The copy still says "inloggningsuppgifter": see open question 3. |
| (no control of mine) | Creating a platform super-admin | Not in these files. That control is on PlatformUsers (unit FJ, D51). |

**What the console shows differently, besides the above**

- The Juridik pill never reads "Juridik OK". The return address and the VAT answer come from the detail's settings summary. The seller's adoption of the pages is not in the platform detail, so the page lists it as an amber line: "Butiksägarens godkännande av sidorna kan inte läsas här ännu". It never shows as the red "not accepted" blocker. The GO LIVE confirm therefore always adds "juridiska sidor ej klara". This is a warning too many, chosen over a false OK.
- The Funktioner pills show only the six add-ons the API knows. Every key the API never names (affiliate, B2B, campaigns, dining, ambassador, writers) reads off. The old helper read a missing key as ON.

## What works against the dev API

Dev server on port 5187, through a scratch Vite config outside the repo with watching off, as FE describes (other builders' edits restarted the watching server and wiped the dev state). My own browse session (`/private/tmp/fi-browse.json`). Signed in as `platform@example.com`.

**List** (`/platform/`)
- `GET /v1/platform/tenants` is read to the end of its cursor (FJ's `readAllTenants`, pages of 100) and sorted by name.
- Each row shows "Sökbar"/"Dold" from `published` and "Aktiv"/"Inaktiverad" from `status`. Suspended, provisioning and closed all count as inactive.
- The storefront icon, the acting-as icon (FB's `ImpersonateShopModal`, unedited, opens as before) and "Öppna" work.
- Empty state: "Inga butiker ännu."
- Error state (500): the toast "Kunde inte ladda butiker", then the empty state, as the old page did.

**Detail** (`/platform/shops/:id`)
- The page reads `GET /v1/platform/tenants/:id` and `GET …/connect`. The Connect view is where the opt-in flag ("Inbjuden") comes from, because the detail has none.
- The following were exercised, each followed by a reload to check it held:
  - TA UR SÖK / GO LIVE (`publish`/`unpublish`);
  - Inaktivera / Aktivera butik (`suspend`/`activate`; a closed shop's 409 shows the page's own "Kunde inte ändra status");
  - Bjud in / Återkalla inbjudan (`connect/enable|disable`);
  - the commission.
- Unknown shop: "Butiken … hittades inte."
- Error (500): toast plus the same block. The old page went blank here (deviation 2).

**Commission**
- `PATCH /v1/platform/tenants/:id {commissionBps}`. 3.5 % saved, and "Avgift sparad: 3.50 %" survived a reload.
- 9 % was refused by the server (dev cap = the Worker's 800 bps). The toast read "Avgiften godtogs inte av servern (över plattformens tak eller ogiltig)." and the editor stayed open (`detail-commission-refused-1440.png`).
- The page's own 0–100 % check is unchanged. The cap is the server's.

**Provision ("Ny butik")** runs three calls:
1. `POST /v1/platform/tenants {tenantId, shopName, hostname: "<id>.provisioned.invalid"}`;
2. `PUT …/features` with the Butikstyp preset's values for the six allowed keys;
3. `POST …/unpublish`. The API creates a shop **published**, while the console's rule is "a new shop starts hidden".

Results seen:
- A POD shop was created and showed as "Dold"/"Aktiv" in the list. Its detail read "POD-butik".
- The same id again gave the modal's own "Butiks-ID "…" finns redan." (409).
- If step 2 or 3 fails, the shop exists anyway. The modal then closes as created, and a toast names what to redo on the detail page.

**Add admin** runs three calls:
1. `POST /v1/platform/users {accountType:'tenant_admin', email, password}`, with a random 96-character password generated in the browser, sent once and kept nowhere (open question 2);
2. `POST /v1/platform/tenants/:id/admins {userId}`;
3. `POST /v1/platform/users/:id/invite`.

Results seen:
- Success: the toast "Admin tillagd för …".
- A taken address (409): the modal error "Det finns redan ett konto med den e-postadressen."
- The invite answering 503: the modal's warning branch, "Admin skapad men e-post misslyckades: e-posten kunde inte köas just nu. …".
- If the grant fails after the create, the modal error names the address and says it was created but not attached.

**Preview of an unpublished shop.** It uses the existing "Öppna storefront" button on the detail and the storefront icon on the list row. No markup was added.
- A published shop opens `<storefront>/<id>` as before.
- An unpublished shop: the tab opens inside the click (so no popup blocker), then the page re-reads `/v1/me`.
  - With an open acting-as grant on that shop, it sends `POST /v1/admin/preview` with `X-Shop-Id: <id>` and points the tab at `<storefront>/<id>/#preview=<grant>`. A toast says "Förhandsvisning öppnad – gäller i 30 minuter".
  - Without a grant, it opens the plain link.
- Checked by recording `window.open`:
  - without a grant: `/test-shop-c`;
  - after opening a grant: `/test-shop-c/#preview=devpreviewgrant.invented`.

**Where "Förhandsvisa" belongs in the ADMIN (for the reviewer):** on `src/pages/admin/AdminStorefront.jsx`, the header action "Förhandsgranska butik" (`<Button as="a" href="/" …>`, around line 236). It points at `/` of the admin host today. While the shop is unpublished (`useAdminShop().published === false`), it should call `POST /v1/admin/preview` and open `${APP_URLS.B2C_SHOP}/${shopId}/#preview=${grant}`; otherwise it should open `${APP_URLS.B2C_SHOP}/${shopId}`. `requestStorefrontPreview(shopId)` in `src/api/admin/platform.js` is not the module to reuse there, since it is platform-console-only by rule. A copy belongs in an admin module (for example `src/api/admin/settings.js` or a new `preview.js`).

## How it is built

The pattern is FF's. Each page's former inline Firebase code moved unchanged into a data module beside the page; the admin build aliases that module to a replacement.

| Older build's module (Firebase, moved verbatim) | Admin build's replacement |
|---|---|
| `src/pages/platform/platformShopsData.js` | `src/admin-app/replacements/platformShopsData.js` |
| `src/pages/platform/platformShopDetailData.js` | `src/admin-app/replacements/platformShopDetailData.js` |
| `src/pages/platform/shopCellsData.js` | `src/admin-app/replacements/shopCellsData.js` |
| `src/components/platform/provisionShopData.js` | `src/admin-app/replacements/provisionShopData.js` |
| `src/components/platform/addShopUserData.js` | `src/admin-app/replacements/addShopUserData.js` |
| `src/components/platform/{MigrateShopifyModal,MigrateWooModal}.jsx` | `src/admin-app/replacements/PlatformMigrateModal.jsx` (null) |

- `src/admin-app/replacements/platformStorefront.js` holds the shared "open storefront / preview".
- `src/api/admin/platform.js` gets my marked section `CP5-FI`, appended after FJ's. It reuses FJ's `readAllTenants`, `putTenantFeatures` and `invitePlatformUser`. Every call is `platformRequest` (no `X-Shop-Id`) except `requestStorefrontPreview`, which is an admin route and names its shop. A test asserts that no platform call carries the tab's active shop.
- `src/admin-app/adapters/platformShops.js` (pure) converts:
  - the tenant directory and detail into the page's `shop`;
  - the feature list into a map with the unnamed keys off;
  - the settings summary into the readiness shape;
  - API errors into messages.

  The Stripe account id is reduced to a boolean.
- **Platform-only facts** (commission, Connect) are imported only by the platform console's modules. A grep of `src/` shows no admin-tree importer of `platform.js`, the adapter or the replacements.
- **Rule 17.** The pages' diffs are their imports, their data calls, and `{FLAG && …}` around the controls that leave. There is one logic line, `setNotFound(true)`, in the detail's catch (deviation 2). No class, token or copy was changed in any of the five files.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 516  # suites 157  # pass 516  # fail 0          (mine: 34 in 3 files)
npx vite build --config vite.admin.config.js          ✓ built in 6.61s
node cloudflare/admin/check-admin-build.mjs           admin build: 13 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs        storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                        ✓ built in 12.47s
node guard/guards.test.mjs                            guard: FAIL — (b) 14 stale allowlist entries (5 mine, listed below; 9 other units')
```

- **The admin bundle searched for both forbidden names.** The earlier brand: none. The resale word: **one hit, not mine**. It sits in `src/pages/admin/AdminUsers.jsx`, the role filter `"applicants"`, which another unit swapped into the build.
- **My new and edited files searched by hand:** neither name is present.
- **Firebase imports:** only the five older-build data modules have one, and they are meant to.

## Allowlist (for the reviewer; I did not edit it)

- **(a) No longer import Firebase. Their entries are stale:**
  - `src/pages/platform/PlatformShops.jsx`
  - `src/pages/platform/PlatformShopDetail.jsx`
  - `src/pages/platform/shopCells.jsx`
  - `src/components/platform/ProvisionShopModal.jsx`
  - `src/components/platform/AddShopUserModal.jsx`
- **(b) New older-build data modules that import Firebase on purpose:**
  - `src/pages/platform/platformShopsData.js`
  - `src/pages/platform/platformShopDetailData.js`
  - `src/pages/platform/shopCellsData.js`
  - `src/components/platform/provisionShopData.js`
  - `src/components/platform/addShopUserData.js`

Five out, five in: the size is unchanged.

## What I looked at (`/private/tmp/fi-shots/`)

**Shots taken**
- List at 1440, 768 and 375; its empty and error states.
- Detail of A at 1440, after the writes, and with the refused commission.
- Detail of C at 768 and 375, full page.
- Detail not-found and error states.
- Provision modal: empty, filled, after creating, the duplicate id, and at 375 and 768.
- Add-admin modal: empty, done, taken address, invite failure.
- The acting-as dialog opened from the list.
- The toast after the preview.

**What I saw**
- Always dark, inside PlatformLayout.
- At 375 the table scrolls horizontally inside its card: the action column sits off-screen. This is pre-existing; the old page had three more columns.
- At 375 the detail's cards stack and the action buttons wrap.
- No overflow anywhere else.

**Design hook.** The hook flagged "gray on colour" on unchanged lines of PlatformShopDetail. They are left as they are: rule 17 keeps the markup byte for byte.

## Deviations

1. **The create route needs a hostname. The modal asks for none**, so a new shop gets `<id>.provisioned.invalid`, the importer's `.invalid` convention. The storefront on the shared host finds a shop by its path, then this hostname (D77). The brief's "then a domain if the modal asks for one" does not apply.
2. **The detail's catch now sets "not found".** Without that, a failed load rendered with `shop = null` and the page crashed to white. The bug existed in the older build too, but an HTTP read fails more often than a Firestore read. It is one JS line and no markup.
3. **The dev API.**
   - Shops created here exist only in my state (`state.fi`). For them, my rows also answer the add-ons and the new admin's invite; every other shop or user is handed to the row mine shadow (FJ's or FB's).
   - Acting-as (FB's row) still reads the shared fixtures. A shop suspended or created in the dev session does not change who may act as it. This is dev only.
   - My `GET /v1/platform/tenants` row comes before FB's stand-in row. Connect enable/disable mutate FF's `connectOf` state, so the seller's payments page agrees.
4. **`PendingPlatformShops.jsx`** (FB's stand-in) is now unused. I did not delete FB's file; the reviewer may.

## Open questions

1. **The copy about unpublished shops is now untrue** (D57: an unpublished shop's catalogue answers 404, not merely noindex):
   - the detail's "Den är fortfarande **öppen och köpbar** via länk";
   - the unpublish confirm "Butiken förblir öppen via länk";
   - the provision modal's "dold för sökmotorer (öppen via länk)";
   - the list's tooltip "butiken är ändå öppen via länk".

   I kept the copy byte for byte (rule 17). Mikael or the reviewer should decide the new words.
2. **`POST /v1/platform/users` still requires a password** (the interim model in `provision-users.ts`). The console sends an unusable random one and invites at once. A Worker change should make the password optional for an invited identity, so that no password ever passes through a browser.
3. **The add-admin copy** says "mailar inloggningsuppgifter" and "Skicka uppgifter manuellt". It is now an invitation link, and there are no credentials to send by hand; the invite can be re-issued from Användare (FJ). The copy needs a decision.
4. **The platform detail lacks the legal facts**: the seller's adoption of the pages, the terms status, who signed and when. `readLegalReadiness` and `readTermsStatus` exist. With them, the Juridik card, its pill and the two rows come back unchanged (`LEGAL_FACTS` true).
5. **No control for shop name, support e-mail or VAT rate** on the detail (D99). `patchTenant` takes them; I added no markup.
6. **No control for close** (`POST …/close`), the final state. It is not on the detail and was not added.
7. **`B2C_SHOP` is empty** in a build made without `VITE_STOREFRONT_ORIGIN`, so storefront links are then relative to the admin host (FA's `urls.js`). The deploy must set it.

## Files

**Created**
- `src/api/admin/platform-shops.test.mjs`
- `src/admin-app/adapters/platformShops.js`
- `src/admin-app/adapters/platformShops.test.mjs`
- `src/admin-app/replacements/{platformShopsData,platformShopDetailData,shopCellsData,provisionShopData,addShopUserData,platformStorefront}.js`
- `src/admin-app/replacements/PlatformMigrateModal.jsx`
- `src/admin-app/dev/{platform-dev.mjs,platform-dev.test.mjs,platform-fixtures.json}`
- `src/pages/platform/{platformShopsData,platformShopDetailData,shopCellsData}.js`
- `src/components/platform/{provisionShopData,addShopUserData}.js`
- `docs/cf-port/CP5_FI_REPORT.md`

**Modified (mine)**
- `src/pages/platform/{PlatformShops,PlatformShopDetail,shopCells}.jsx`
- `src/components/platform/{ProvisionShopModal,AddShopUserModal}.jsx`

**Modified (shared, my lines only)**
- `src/api/admin/platform.js`: one import line, plus the `CP5-FI` section after FJ's.
- `vite.admin.config.js`: 7 alias rows.
- `src/admin-app/pages.jsx`: the `PlatformShops` and `PlatformShopDetail` lines.
- `src/admin-app/dev/dev-api.mjs`: one import, `...PREVIEW_ADMIN_ROUTES` in the admin table, `...platformShopRoutes(…)` first in the platform table.
