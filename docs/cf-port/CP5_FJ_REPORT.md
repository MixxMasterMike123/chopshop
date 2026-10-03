Model: claude-sonnet-5-5 (Sonnet 5.5)

# CP5-FJ report: PlatformAddons, PlatformUsers, PlatformReports on the API

Built on `cf-port` in the working tree, while other units worked in it too. No git command that writes, no network, no wrangler, no deploy. The older build's dev server was not started.

## (a) What leaves or changes, control by control

**PlatformAddons**
- The columns of Affiliate, B2B Grossist (not ported, D62) and Kampanjer, Dining CRM, Ambassadörer, AI-texter (deleted, D2) leave: the Worker's PUT refuses those keys. The page has no disabled state for an add-on, so the whole column leaves. Six columns stay: Rabattkoder, Print on demand, Övergiven kassa, Recensioner, Innehållsstudio, Marknadsföringsmaterial.
- The footnote loses its second sentence ("Affiliate visas här men…"): its column is gone.
- Closed shops are not listed (closed is final; the PUT would answer 409).

**PlatformUsers**
- "Ny plattformsadmin" (button and modal) leaves: creating a platform admin over HTTP is refused by design (D51). The modal stays in the page file and is not rendered; its call refuses.
- "Ta bort" becomes DEACTIVATE. The old confirm said "Kontot och inloggningen tas bort permanent": no longer true (nothing is deleted; the account is switched off and can be switched on again), so the copy changes in this build only: confirm "Inaktivera {e-post}? Inloggningen stängs av och alla inloggade sessioner avslutas. Kontot raderas inte och kan återaktiveras.", button "Inaktivera" / "Inaktiverar…", toast "{e-post} inaktiverad". The older build keeps its strings.
- New controls, shown only in this build: an "Inaktiv" badge, "Återaktivera" on a suspended row, "Skicka inbjudan" on an active row with no password yet. A platform admin's "Återaktivera" is shown and the server's refusal (D63) is shown as the toast "En plattformsadmin kan inte återaktiveras härifrån. Servern vägrar."
- The role cell lists a shop admin's ACTIVE shops, comma-joined (a directory user has several memberships; the old doc had one `shopId`).

**PlatformReports**
- The queue's note field ("Anteckning (vid avpublicering)") leaves: `POST /v1/platform/screening/:id` takes `{decision}` only.
- "Visa i butiken" and the arrow link beside a reported product leave: neither the report nor the screening view carries the product's slug or sku (the page built the address from them).
- The thumbnail box in the queue stays but is empty (no image in the view).
- The queue's intro paragraph is replaced in this build: the old one said flagged products stay public, which is the Worker's D8 policy only after a shop's first two products. New text: "Produkter som flaggats av varumärkesfiltret eller blockerats, och nya butikers första produkter, som väntar på ditt godkännande innan de kan säljas. Godkänn, eller avpublicera om säljaren saknar rätt till märket."
- "Ej matchad" / the product-id input never appear (a report always has a product id in D1).

## (b) What works against the dev API

- **Tillägg:** shops from `GET /v1/platform/tenants` (read to its end), one `GET …/features` per shop, a switch is `PUT …/features {features:{key:bool}}`; verified it survives a reload. A failed read shows the page's toast and its "Inga butiker ännu." block.
- **Användare:** `GET /v1/platform/users?accountType=` once for platform admins and once for shop admins (each to its end); deactivate updates the row to "Inaktiv"; reactivate and invite; the D63 refusal, the self-deactivation guard (button disabled as before) and `last_platform_admin` are shown in Swedish.
- **Anmälningar / Granskning:** `GET /v1/platform/reports` (every report, newest first) and `GET /v1/platform/screening`; "Avvisa" and "Markera som granskas" = `handle`, "Avpublicera produkt" = `takedown` with the product id; "Godkänn" = `approved`, "Avpublicera" = `blocked`. The nav badge (`newCount`) follows. The 409 codes are shown in Swedish.
- The shop names of the reports come from the tenants list (a third read; a report carries a tenant id only). If it fails the id is shown.

No call carries `X-Shop-Id` (all `platformRequest`; a test covers it with an active shop set).

## Files

Created: `src/api/admin/platform.js` (my section marked `CP5-FJ`; did not exist when I wrote it, FI adds its own section), `src/api/admin/platformConsole.test.mjs`, `src/admin-app/adapters/platformConsole.js` (+ `.test.mjs`), `src/admin-app/replacements/platform{Addons,Users,Reports}Data.js`, `src/pages/platform/platform{Addons,Users,Reports}Data.js` (the older build's, Firebase), `src/admin-app/dev/platform-rest-dev.mjs`, `platform-rest-fixtures.json`, `platform-rest-dev.test.mjs`, this report.
Modified: the three pages, `vite.admin.config.js` (3 alias rows, before the FD rows), `src/admin-app/pages.jsx` (3 lines), `src/admin-app/dev/dev-api.mjs` (one import, one spread placed BEFORE the shells' rows so my reports route, which also answers the badge's `newCount`, wins).

## Allowlist (the reviewer swaps)

(a) Pages that no longer import Firebase, stale entries: `src/pages/platform/PlatformAddons.jsx`, `PlatformUsers.jsx`, `PlatformReports.jsx`.
(b) New old-build data modules that import Firebase on purpose: `src/pages/platform/platformAddonsData.js`, `platformUsersData.js`, `platformReportsData.js`.

## Gate

```
node --test … (the full line)
  # tests 467  # suites 137  # pass 467  # fail 0      (mine: 38)
npx vite build --config vite.admin.config.js     ✓ built in 11.77s
node cloudflare/admin/check-admin-build.mjs      admin build: 11 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs   storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                   ✓ built in 16.32s
node guard/guards.test.mjs                       FAIL on stale allowlist entries only: 14, of which mine are the three of (a); the other eleven belong to other units.
```
My new files and `cloudflare/admin/dist` hold neither forbidden name (searched).

## What I looked at

Rendered in the admin dev server (port 5188) as the platform user, inside PlatformLayout, always-dark; screenshots in `/private/tmp/fj-shots/`:
- addons: 1440, 375, 768, error (also shows the empty block);
- users: 1440, 375, 768, empty, error, the D63 refusal, a deactivation;
- reports: queue and report list at 1440, 768, 375; empty; error; reject; approve.

At 375 the two tables scroll sideways inside their frame, as the older markup does; the shell shows no menu at 375 (FB's). I did not compare against the older page rendered (its dev server reaches the network).

## Deviations and open questions

1. The three scenarios of the dev API are cookie-driven (`admin_dev_fj=empty|error|noinvite`), see `platform-rest-dev.mjs`. An empty list of SHOPS cannot be shown (the tenants route is FB's); the add-ons error state renders the same block.
2. Advisory screenings (a hit on a shop's later product, D8) are not in the Worker's default queue, so a flagged later product the old page showed is not listed here. `GET /v1/platform/screening?status=advisory` would list them, but advisory also seems to be the state of ordinary screened products; decide whether to read it.
3. The "Ångra" text of a taken-down report still says to re-activate the product in the shop's form. In the Worker, "Godkänn" in the queue lifts a takedown (`approved`); whether the product form does is FC's. Copy not changed.
4. `PlatformReports.jsx` still exports `ReportsView` and the constants for `src/dev/platformReportsHarness.jsx`.
5. A user list is read to 20 pages of 100 per account type, a report list likewise.
