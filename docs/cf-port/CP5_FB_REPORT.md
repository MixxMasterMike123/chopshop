Model: claude-opus-5-5 (Opus 5.5)

# CP5-FB report: the shells and acting-as

Built on `cf-port` (HEAD `d052d522`) in the working tree, beside the products, settings, payments and orders builders. No git command that writes, no network (localhost only), no wrangler, no deploy.

## (a) What left the shells, and why

**AppLayout (the admin shell).** Only data changed. The markup is the same bytes, except one JSX condition (below).

| Entry or control | How it leaves | Why |
|---|---|---|
| "B2C Kunder" (`/admin/b2c-customers`) | `scopeAdminNav` of this build filters it | Not feature-gated, and the page left the build (D11, D81) |
| "Mina skatteuppgifter" (`/admin/skatteuppgifter`) | same | DAC7 is CP9 (D23) |
| Affiliate, Marknadsföring, B2B-kunder, Rabattkoder, Recensioner, Innehållsstudio | Close by themselves: the API answers `false` for every feature that is not ported (D81) | Not ported |
| The dining mentions (top bar) | `features.dining` is always false; `MentionNotifications` is aliased to a null component | Wagon deleted (D2) |
| Wagon menu items | `WagonRegistry` is aliased to a static list holding only POD's manifest entry ("Print on demand", `/admin/pod`). AppLayout's existing `features.pod` gate decides whether it shows. | D2; FB.1 "POD is a static entry" |

**PlatformLayout (the console shell).** "3D-modeller" (PORT-LATER), "DAC7" (CP9) and "Leads" (D103) leave through `scopePlatformNav`. The two "snart" placeholders stay.

**ForgotPasswordPage.** The "Skapa ett konto" link (`/register`) leaves (FB.4). This edits the shared file, so the older build loses it too; it was a dead link there as well. The row now holds only "Tillbaka till inloggning".

**Controls refused while acting as a shop.** The terms are the only such control in my files, and none needs disabling:
- The gate is never shown to a platform user. This is unchanged: `eligible` excludes `isPlatform` and `getImpersonation()`.
- `AdminPlatformTerms` is read-only.
- The server refuses the accept with 404 anyway, and the dev API mirrors that.

## What works end to end against the dev API

All of this was run in an isolated headless browser on my own port (5181). Logs and screenshots are in `/private/tmp/fb-shots/`.

**Tenant admin** (`admin@example.com`)
- Signs in and lands on `/admin` inside AppLayout. The menu is the 10 launch-scope entries plus "Print on demand"; the shop label shows name and id.

**Terms gate** (cookie `admin_dev_terms=unaccepted`)
- The gate replaces the page body and shows the server's archived text of 2026-09-07.
- The button is disabled until the box is ticked. Accept returns 201 and the gate closes; after a reload it stays closed.
- If the version changes while the gate is open (409), the gate's own error slot reads "Villkoren har uppdaterats medan sidan var öppen. Ladda om sidan…".
- `stale` (an older version accepted): the gate shows.
- `notext` (the current version has no archived text): the gate lets the seller through (fail-open).

**Terms page** (`/admin/plattformsvillkor`)
- Shows the server's text, "Godkända … 2026-10-01 · version 2026-09-07" and the "utkast" note.

**Admin of several shops** (`admin-multi@example.com` / `dev-password-5`, a new fixture user)
- No shop is resolved, so the ShopPicker shows A, B and C, with B (suspended) marked "Pausad". Choosing B changes nothing.
- Choosing C shows the shell with "Test Shop C · Byt butik"; a reload keeps C.
- "Byt butik" returns to the picker. `/admin/orders?shopId=test-shop-a` switches to A and strips the parameter from the address.

**Platform user** (`platform@example.com`)
- Lands on `/platform/` inside PlatformLayout: the trimmed menu, and the "Anmälningar" badge from `newCount`. `/admin` with no grant goes back to `/platform/`.
- The icon button opens ImpersonateShopModal (unedited), which reads "60 minuter" from the server's TTL. With a reason entered, "Öppna admin":
  - sends `POST …/acting-as {reason}` (201);
  - opens a new tab `/admin?impersonate=test-shop-a&audit=…`, which the intake turns into the tab's shop and strips.
- In the new tab: AppLayout with the amber banner "Plattformsläge: du visar Test Shop A som plattformsadmin · Upphör om 1:28 · Avsluta", and the nav offset `top-24`.
  - A reload restores the banner from `/v1/me`.
  - The terms page can be read.
- "Avsluta" sends `DELETE` (204) and lands on `/platform/` with the toast "Plattformsläget för Test Shop A är avslutat."
- **A grant that runs out** (the dev TTL was set to 90 s): the banner counts down, then the tab goes to `/platform/` with the toast "Plattformsläget för Test Shop A har gått ut. Öppna admin igen för att fortsätta."

**Dark-mode key.** The older key is read once by its suffix and carried to `admin.darkMode`; `.dark` is applied.

## The storage-key change

| What | Older build | This build |
|---|---|---|
| Dark mode | `localStorage` key `<earlier brand>_dark_mode` | `admin.darkMode`. Read through the `useDarkMode` alias (`replacements/useDarkMode.js`). When the new key is absent, the first key ending in `_dark_mode` with a `true`/`false` value is copied over. The old key is left alone. |
| Sign-in language | Two `localStorage` keys and two cookies (`<earlier brand>-language`, `<earlier brand>-credential-language`), written inline by `CredentialLanguageSwitcher` | `admin.credentialLanguage`, no cookie (nothing reads one). The writes moved to `src/utils/credentialLanguageStorage.js`, which this build aliases. `credentialTranslations` reads the older key once by its suffix (`-credential-language`, `-language`). |
| Acting-as | `sessionStorage` `__op_impersonation` plus Firestore audit documents | Nothing client-side: the server's grant, listed by `/v1/me`. `sessionStorage` `admin.actingAsNotice` carries only the one end-notice to the console. |

- The suffix match means no earlier-brand string is needed in this build's code.
- The admin is a new origin, so the older keys will in practice never be there; the read-once costs nothing.
- **Not added:** the earlier-brand check in `check-admin-build.mjs`. The script would have to contain the very pattern the guard refuses in tracked files.
- **For the reviewer:** the bundle does hold one earlier-brand string today. It is not from my files: `src/utils/orderUtils.js` has a SKU regex starting with the earlier brand's three-letter prefix, pulled in by the order and dashboard pages swapped in during this run. Their unit (or the reviewer) should alias or trim that import.

## Files

**New (mine)**

| File | What it is |
|---|---|
| `src/api/admin/actingAs.js` (+ `actingAs.test.mjs`) | `openActingAs`, `closeActingAs`, `listTenants`; pure `sessionOfGrant` (a grant in the banner's shape) and `pickerShopsOf` |
| `src/admin-app/adapters/platformTerms.js` (+ test) | status + terms → `{rendered, accepted, acceptance}`; `acceptErrorMessage` |
| `src/admin-app/replacements/impersonation.js` | `config/impersonation.js` for this build: the grant of the tab's shop. Also `clearImpersonation`, which leaves the run-out notice. |
| `src/admin-app/replacements/impersonationAudit.js` | start = POST the grant; end = DELETE it, then go to `/platform/` with a notice |
| `src/admin-app/replacements/AdminShopIdIntake.jsx` | `?shopId=` and `?impersonate=` become the tab's shop, then are stripped |
| `src/admin-app/replacements/{adminShellScope,platformLayoutData,shopPickerData,platformTermsData,wagonRegistry,MentionNotifications.jsx,useDarkMode,credentialLanguageStorage,legacyStorage}.js` | the shells' data in this build |
| `src/admin-app/replacements/shells.test.mjs` | tests for the replacements above |
| `src/admin-app/PendingPlatformShops.jsx` | the PlatformShops stand-in: a tenant list plus "Öppna admin". It uses the console's vocabulary, copied from `PlatformShops.jsx`; FI replaces it. |
| `src/admin-app/dev/shells-dev.mjs` (+ `dev-api.shells.test.mjs`) | dev routes: acting-as POST/DELETE, `GET /v1/platform/tenants`, `GET /v1/platform/reports` (`newCount`), and the terms status/terms/accept with scenarios |

**New originals for the older build, each serving both builds through the alias list**

| File | What moved there |
|---|---|
| `src/components/layout/adminShellScope.js` | Pure; behaves as before (every entry; picking and switching for platform users only) |
| `src/components/admin/shopPickerData.js` | ShopPicker's Firestore read, moved verbatim |
| `src/components/admin/platformTermsData.js` | The gate's and the terms page's Firestore reads and writes, moved verbatim |
| `src/components/platform/platformLayoutData.js` | The badge count, moved verbatim |
| `src/utils/credentialLanguageStorage.js` | The switcher's key writes, moved verbatim |

**Edited (mine):**
- `AppLayout.jsx`: the scope import; `auth = useAuth()`; `scopeAdminNav([...])`; `mayPickShop(auth)`; `maySwitchShop(auth)`.
- `PlatformLayout.jsx`, `ShopPicker.jsx`, `PlatformTermsGate.jsx`, `AdminPlatformTerms.jsx`, `CredentialLanguageSwitcher.jsx`: data calls only. ShopPicker's earlier-brand comment was reworded.
- `ForgotPasswordPage.jsx`: the link.
- `src/api/admin/legal.js`: my section (`getPlatformTermsStatus`, `getPlatformTermsText`, `acceptPlatformTermsVersion`). FE had created the file first.

**Edited (shared or FA's, my lines only)**

| File | My change |
|---|---|
| `vite.admin.config.js` | 11 alias rows |
| `src/admin-app/pages.jsx` | Lines `AdminPlatformTerms` (live) and `PlatformShops` (the stand-in) |
| `dev-api.mjs` | Import; `meOf` adds the held grants; my rows (the terms rows go first and keep FE's `readiness`); `/v1/me` with `X-Shop-Id` now answers 400, as WA does |
| `fixtures.json` | One user |
| `ActiveShop.jsx` | `publishActingAs`; the arrival `?shopId=` no longer outranks a later choice in the same page life (it used to block "Byt butik") |
| `AdminApp.jsx` | Mounts the intake |
| `Pending.jsx` | Stand-ins render inside AppLayout or PlatformLayout |
| `credentialTranslations.js` | The older-key read |

**Rule 17, line by line.** The only change inside JSX is AppLayout's `{isPlatform && !getImpersonation() ? (` → `{maySwitchShop(auth) && !getImpersonation() ? (`. It is the same condition in the older build (`maySwitchShop` = `isPlatform`). No class, token or copy changed in any shell.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 397  # suites 116  # pass 397  # fail 0      (mine: 59 in 4 files)
npx vite build --config vite.admin.config.js           ✓ built
node cloudflare/admin/check-admin-build.mjs            admin build: 11 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs         storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                         ✓ built in 14.42s
node guard/guards.test.mjs                             guard: FAIL — (b) 8 stale allowlist entries
```

The guard failure is expected; the fix belongs to the reviewer (see Reviewer wiring).
- Five of the stale entries are mine: `CredentialLanguageSwitcher.jsx`, `PlatformTermsGate.jsx`, `ShopPicker.jsx`, `PlatformLayout.jsx`, `AdminPlatformTerms.jsx`.
- Three belong to the other page builders: `AdminOrderDetail`, `AdminPayments`, `AdminSettings`.

My untracked files were checked by hand. None imports Firebase, and none carries the earlier brand or the resale word. "Firebase" appears only in comments of two replacements. The exceptions are the four moved data modules, which must carry them: that is the older build's code.

## What I looked at

Captures from my own Playwright instance (localhost only), in `/private/tmp/fb-shots/`.

**Admin shell, tenant admin**
- Light and dark at 375, 768 and 1440 (`admin-tenant-*`), plus the drawer at 375.
- Matches DESIGN_CONTRACT §1.2/§2.2:
  - dark 56 px top bar; 232 px nav from `md`; active item `black/[0.08]` (light) or `white/10` (dark);
  - the add-on divider with only "Print on demand" under it;
  - the avatar on `--color-admin-success-dot`.
- Dark mode flips the canvas to `#0F1115` and the nav text to `#F2F3F5`.

**Terms gate and terms page**
- Light and dark at all three widths (`admin-gate-*`, `admin-terms-page-*`).
- In dark mode the "UTKAST" blockquote stays a pale caution chip. That is the documented parity state: no dark override exists for the status tokens (§1.2).

**Picker**
- Light and dark at all three widths (`admin-picker-*`).
- The "dark" captures render light. `.dark` is set by the toggle, which sits in the AppLayout chrome the picker replaces. On a full load this is the same in the older build.

**Acting-as**
- Banner, light and dark at all three widths (`admin-acting-as-*`): `h-10` amber under the bar, nav at `top-24`. At 375 the shop name truncates and "Upphör om" hides (`sm:` rule).

**Console**
- Always dark, at all three widths (`platform-shops-*`).
- At 375 there is no sidebar, so no menu and no logout. That is the contract's "hidden below md, no mobile nav".
- The dialog at 375 and 1440; the console after "Avsluta" and after a grant ran out, each with its notice.

**Sign-in.** `forgot-password` at 375 and 1440: the link is gone and the row closes left.

**Differences from the older build, with cause**
- The data: names, menu entries (listed in (a)), the terms text from the server, and the badge from `newCount`.
- Not from me: behind the shells, the dashboard and the order pages the orders unit swapped in.

**Not done: a side-by-side with the older build rendered.** Its dev server reaches third-party scripts, which the brief forbids. Its built output cannot sign in without Firebase. The comparison is therefore against the code: the markup bytes are equal, as set out under Rule 17.

**Pre-existing, not changed (markup rule).** At 375 the admin top bar's right group ends at x = 420. The logout icon is off-screen, and the drawer has no logout either. The same happens in the older build with its markup. This is a design decision for Mikael.

**Disclosure.** The `browse` daemon is shared with the other builders. Its active tab had been switched by one of them, so one of my `viewport 375x812` calls landed on their tab (localhost:5182, products). I then closed my own two tabs and used an isolated browser for everything else. I did not touch their page otherwise.

## Deviations

1. **The data modules hold the older build's Firebase code, moved verbatim, under new names** (the pattern FC, FE and FF use too). This was the only way to keep the shells' markup single-copy, keep the older build working (not just building), and keep the allowlist from growing: entries swap, net −1.
2. **I edited files of FA** (listed above): ActiveShop, AdminApp, Pending, credentialTranslations, and the dev API. FA had finished, and these are the seams FB was named for: the picker, the intake, and the stand-ins inside the shells.
3. **`PendingPlatformShops`** replaces the PlatformShops stand-in so the acting-as flow can be run in the console now. FI's swap replaces it.
4. **The terms text is the server's only.**
   - The bundled templates are not in the admin bundle. A seller signs what the server holds, and the DPA's sub-processor list names "Firebase", which the build check refuses.
   - If the current version has no archived text, the gate lets the seller through (as on a failed read).
   - The text is fetched only when the gate must ask, or by the terms page, and cached per version.
5. **The admin gate asks during the D47 grace too**, as the older gate did on any version bump. Grace governs checkout.
6. **The end of a session never settles `writeImpersonationEnd`.** It navigates to `/platform/` itself. If the banner's own `/admin` navigation ran instead, a platform user with a second live grant would land in that other shop.

## Reviewer wiring

- **`guard/allowlist.txt`**
  - Remove `src/components/CredentialLanguageSwitcher.jsx`, `src/components/admin/PlatformTermsGate.jsx`, `src/components/admin/ShopPicker.jsx`, `src/components/platform/PlatformLayout.jsx`, `src/pages/admin/AdminPlatformTerms.jsx`.
  - Add `src/components/admin/shopPickerData.js`, `src/components/admin/platformTermsData.js`, `src/components/platform/platformLayoutData.js` (firebase family), and `src/utils/credentialLanguageStorage.js` (earlier-brand family).
- **The bundle's earlier-brand SKU regex** (`orderUtils.js`, from the order pages).

## Open questions

1. **`/v1/admin/legal/status` names no signer and no date for an older acceptance.**
   - The terms page reads "Godkända av okänd användare …".
   - The gate's "Villkoren har uppdaterats sedan du senast godkände dem (…)" line cannot show: its date is unknown.
   - Should the Worker add `acceptedBy` (e-mail) and the acceptance time of `acceptedVersion`?
2. **ShopPicker's copy** ("Du är inloggad som plattformsadmin…", "Valet sparas i den här webbläsaren") is now seen by a tenant admin of several shops, and the choice is per tab. A copy decision for Mikael. A suspended shop's row is still a button that does nothing: disable it?
3. **The banner shows no reason.** The server keeps it; `/v1/me` does not return it.
4. **The dialog's error copy** says "revisionsloggen misslyckades" for any refusal (an inactive shop answers 404, a reason over 500 characters 400). The textarea has no `maxLength`.
5. **Hidden logout:** the 375 top bar on the admin, and no mobile nav in the console (pre-existing).
6. **The dashboard (FD) loads while the picker shows.** It refuses itself with `no_shop`, so nothing is sent, but it logs console errors. That is parity with the old sentinel reads; FD may want to wait for a shop.
