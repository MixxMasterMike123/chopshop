Model: claude-opus-5-5 (Opus 5.5)

# CP5-FK report: the platform printers page on the API

Built in the working tree on `cf-port` while WJ worked in `cloudflare/**`. I did not touch `cloudflare/`. No git command that writes, no network (localhost only), no wrangler, no deploy. The older build's dev server was not started.

## (a) What leaves or changes, control by control (admin build only; the older build is unchanged)

| Control | What happens | Why |
|---|---|---|
| **"Nytt tryckerikonto"** (the whole form: e-post, namn, tilldelade butiker, "Skapa tryckerikonto") | Leaves (`CREATE_ACCOUNT` false; terser drops it from the bundle) | No print-shop accounts exist on the Worker. The print portal is PORT-LATER (D12; gap analysis §1b). |
| **"Styrning per plagg"**: the eight per-garment selects | Leave (`ROUTE_BY_GARMENT` false) | On the Worker, each POD product's mapping names its printer. Nothing is routed by garment (D52; `printers.ts` header). |
| The routing section's heading, paragraph and footnote | Replaced in this build, through constants of the data module (FJ's `QUEUE_INTRO` pattern) | The old texts describe routing per garment, which does not exist here. New heading: "Styrning". |
| The page intro ("Skapa och hantera tryckerikonton …") | Replaced in this build | The old text is about accounts. |
| The reroute notice ("Prisgolvet kan ha ändrats …") | Never shows | Nothing can be rerouted. The markup is unchanged. |
| **Plagg & priser: the garment checkboxes** | Still clickable, but a save that adds or removes a garment is refused with a toast. Nothing is sent. | A garment on the Worker is its models and SKUs from the supplier catalogue. Adding one needs SKUs the page cannot create. Removing one deletes models, SKUs and tiers, which only a catalogue apply can bring back. See open question 2. |
| "Standardtryckeri" + "Spara styrning" | Kept: `PUT /v1/platform/printers/default` | |
| Aktivera / Inaktivera | Kept: `PATCH …/:id {status}` | |
| Plagg & priser: blank prices, print prices, frames, "Preliminära mått", Spara | Kept: `PATCH …/:id` sends only what changed (below) | |

**Page code changes beyond imports and data calls:**
- The two flags wrap existing markup.
- Four copy constants.
- The save toast appends the server's note.
- Opening the editor may show a note toast (`tierEditorNote`).
- Three `catch` blocks show `e?.userMessage` before the page's own text.

No class, token or markup element changed. `PrinterRow.jsx` and `printerTierForm.js` are untouched.

## Route map

| Page action | Older build | This build |
|---|---|---|
| load | `shops`, `users where role==print_shop`, `printers`, `settings/printRouting` | `GET /v1/platform/printers?limit=50`, read to the end of its cursor (`readAllPrinters`). It answers every printer whole, with tiers and `defaultPrinterId`. No shops, no accounts. |
| Aktivera / Inaktivera | `users/{uid}.active` + `printers/{uid}.active` | `PATCH /v1/platform/printers/:id {status}`. No revision fence: a status flip is meant as it is. |
| Plagg & priser → Spara | `setDoc printers/{uid}` (mergeFields) | `PATCH /v1/platform/printers/:id {expectedRevision, capabilities?, tiers?: {upsert?, remove?}}` |
| Spara styrning | `setDoc settings/printRouting` | `PUT /v1/platform/printers/default {printerId \| null}` |
| Nytt tryckerikonto | `createPrintShopUser` | none (the form is not shown; the function refuses with `not_available`) |

Every call is `platformRequest`, so none carries `X-Shop-Id`. The Worker refuses any printer route that names a shop. The API section is `CP5-FK` in `src/api/admin/platform.js`. It has three calls: `readAllPrinters`, `patchPrinter` and `putDefaultPrinter`. The page needs no single read and no catalogue call, so none is written.

### How the page's shape maps onto the Worker's (`adapters/platformPrinters.js`)

The page edits:
- one blank price per **garment**;
- one print price per **slot**, for the whole printer;
- one frame per garment × slot.

The Worker stores:
- **models**, each with a garment, frames and a provisional flag;
- **SKUs**, each pointing at a model;
- one **tier per SKU**: a blank price plus a price per slot.

The importer writes one model per garment with uniform prices (`transform-printers.mjs`). The catalogue apply prices per model. So the projection is exact for real data.

**Read** (`printerDocOf`): each value is projected onto the page's shape. Where the models or SKUs of one garment disagree, the field is **mixed**:
- it shows empty;
- opening the editor says which fields are mixed;
- an untouched mixed field is never written.

**Write** (`printerPatchOf`): a **diff against what the page showed**. Only a changed field is sent:
- a blank price goes to every SKU of its garment;
- a print price goes to every tier;
- a frame or the provisional flag goes to every model of its garment.

An emptied blank price removes the garment's tiers ("not priced", as before). An emptied frame removes the slot ("cannot print there", as before). A price typed for an unpriced garment creates its tiers with the printer-wide print prices.

**Money:** amounts arrive from the server in öre and are divided by 100 for the form. On save, the operator's kronor are multiplied by 100: exact, at most two decimals, and no more than the Worker's cap. No price is computed in the browser.

**Refused before any request**, each with a Swedish toast:
- adding or removing a garment;
- frames that are not whole millimetres;
- a price with more than two decimals or over the cap;
- price edits on a printer that is not priced in SEK;
- a shop's own printer;
- an invalid stored document.

**After the save:** the server's answer replaces the page's doc. A second save is therefore fenced on the new revision. A stale page gets 409 `revision_mismatch`, shown as "Tryckeriet har ändrats … Ladda om sidan". The toast adds the server's facts: how many product mappings were paused, and how many products are now under the floor.

## What works against the dev API (port 5189, own browse session, screenshots `/private/tmp/fk-shots/`)

Signed in as `platform@example.com`. I used three invented printers:
- an active `api` printer (the dev environment plays staging, so its target is `fake-printer`);
- an inactive manual printer with mixed values;
- an `api` printer that is not this environment's target, like staging's imported inactive one.

**What I exercised:**
- **List:** badges and garments read correctly (`printers-1440`, `printers-375`).
- **Editor:** it shows the server's values (`editor-open-1440`). Changed the tee blank to 52, front print to 35 and cleared the tee back frame, then saved. The toast read "Plagg, priser & tryckytor sparade. 1 produktkoppling pausades: tryckeriet kan inte längre göra den." The frames notice also showed (`saved-toast-1440`). After a reload: 52 / 35, back frame empty.
- **Mixed printer:** the note toast names "T-shirt (blankpris), T-shirt bröst (tryckyta)" (`mixed-note-1440`).
- **Refusals:**
  - Ticking Keps and saving gives "Keps finns inte i tryckeriets katalog …" (`refused-garment-1440`).
  - Aktivera on the foreign `api` printer gives "Det här tryckeriet kan inte ändras i den här miljön …" (`refused-activate-1440`).
- **Default printer:** cleared and then set again. Each held after a reload. The select offers only active printers.

**States, by the cookie `admin_dev_fk`:**
- `empty`: "Inga tryckerier ännu."
- `error`: toast "Kunde inte ladda tryckerier." plus the empty block.
- `dark` (an environment without a dispatch target: every route 404): same as error.
- `floor`: the toast adds "2 produkter ligger nu under prisgolvet." (tested under Node).

The error toast appears twice in dev only. That is React StrictMode's double effect, and both builds mount under StrictMode.

**What I saw:**
- Always dark, inside PlatformLayout.
- At 375 there is no page-level horizontal scroll (scrollWidth = 375). The frames table scrolls inside its own box, as its markup does. Row titles wrap and the subtitles truncate, as before.
- The design hook flagged "gray on colour" on unchanged lines. I left them as they are (rule 17).

## Visible differences from the older page, and why

1. The create form, the per-garment selects and the reroute notice are gone. The page intro and the routing texts are new. See (a).
2. Every printer row is either "API" or "Utan konto" ("Prislista utan tryckerikonto"). The account rows ("e-post · butiker: …") never appear: there are no accounts.
3. The "plagg:" line lists only garments the page knows (`POD_GARMENTS`). A model whose garment is unknown or null is neither shown nor written. Imported data has none.
4. A mixed field shows empty, with the note toast when the editor opens. The placeholder stays "—" because the markup is unchanged.
5. Toasts:
   - the save toast carries the server's suspension and floor facts;
   - known refusals say their reason instead of the fixed "Kunde inte …";
   - opening the editor can toast a note.
6. Changing the default printer reprices nothing and moves nothing. The new footnote says so.

## Worker follow-ups (nothing built; the page degrades as described)

1. **PATCH has no dry run.** `editPrinter` already takes `dryRun`, but the route always writes, so the operator cannot see paused mappings or products under the floor before saving. Suggested: `?dryRun=1`, or `dryRun: true` in the body, answering the same diff.
2. **The default printer is read by nothing yet.** CP3_C_REPORT §7 says it is stored for the importer and for the studio (CP6). The footnote's "förval för nya produkter" is that intent.
3. **No garment add or remove on the page.** The catalogue routes exist (`GET/PUT …/:id/catalog`, `POST …/catalog/apply` with a dry run), but no page uses them. That would be a new UI (an FL-type unit), not a Worker change.
4. **Server `problems` are in English.** The page shows them as given after "Servern godtog inte ändringen: …". This is platform-only, so it is acceptable.
5. **Shipping cost** (`shippingCostMinor`) has no control. The older page had none either: it came from the seed. If it should be editable, the PATCH already takes it.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 603  # suites 183  # pass 603  # fail 0      (557 at HEAD + 46 mine in 4 files)
npx vite build --config vite.admin.config.js          ✓ built in 6.77s
node cloudflare/admin/check-admin-build.mjs           admin build: 13 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
npx vite build                                        ✓ built in 10.66s (the older bundle still holds the create form and "Styrning per plagg")
node cloudflare/web/check-storefront-build.mjs        storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
node guard/guards.test.mjs                            exit 1: FAIL (b) 1 stale entry: src/pages/platform/platformPrintersData.js
node rules-tests/one-number-pure.test.cjs             53 passed, 0 failed (it greps PlatformPrinters.jsx and PrinterRow.jsx for price literals)
node --test rules-tests/audit-2026-09-26.test.mjs     pass (printerTierForm.js unchanged)
```

**Why the guard fails, and why it is expected:** the new older-build data module is untracked, and the guard reads `git ls-files`, so it reports the entry as stale. The module does import Firebase (checked with the guard's own pattern). Once the reviewer adds it, the guard passes at 296.

**Allowlist:** `src/pages/platform/PlatformPrinters.jsx` out, `src/pages/platform/platformPrintersData.js` in. The size is unchanged at 296.

**Forbidden names:** both are absent from the admin bundle and from every new or edited file of mine (searched by hand). The bundle also holds no dev-API data (the marker and fixture names were searched).

## Open questions for Mikael

1. **Price edits now reach existing products at once.** Firebase froze `podCostSek` on the product at publish. On the Worker, the quote and checkout read the mapping's printer's current tiers, so a tier edit changes existing products' Inköp, and so the seller's payout, from the next order. A product pushed under the floor is only reported (the toast count), not taken off sale. The new routing paragraph says the first part. Is this the intended model, and should "under the floor" block sales?
2. **Removing a garment from a printer** is refused on the page, because it cannot be undone without the catalogue. Is that right, or should the page allow it with a confirm (a dry run first; see follow-up 1)?
3. **The new texts** (page intro, "Styrning", its paragraph and footnote) need your words. "förval för nya produkter" is CP6's intent.
4. **The frames notice in PrinterRow** ("Publicerade produkter valideras inte om automatiskt …") is now half true. Mappings whose slot loses its frame ARE paused by the server, and the toast says how many. Artwork fit against changed dimensions is not rechecked. I kept it byte for byte.
5. **Not mine, for the reviewer:** `src/admin-app/replacements/storefrontLinks.js` (admin tree, FX) imports `src/api/admin/platform.js` for `requestStorefrontPreview`. That module now also holds the printer calls. They are only functions; their routes are platform-only on the Worker. FI already suggested a copy of the preview call in an admin module. Also, WJ's tree has an untracked `cloudflare/src/catalog/admin-product-reads.ts.bak`.

## Files

**Created**
- `src/pages/platform/platformPrintersData.js`: the older build's data module, the page's Firebase code moved unchanged
- `src/admin-app/replacements/platformPrintersData.js` + `.test.mjs` (end to end against the dev API, with the page's own form code)
- `src/admin-app/adapters/platformPrinters.js` + `.test.mjs`
- `src/api/admin/platform-printers.test.mjs`
- `src/admin-app/dev/printers-dev.mjs`, `printers-dev.test.mjs`, `printers-fixtures.json` (invented)
- `docs/cf-port/CP5_FK_REPORT.md`

**Modified (mine)**
- `src/pages/platform/PlatformPrinters.jsx`: imports, data calls, two flags, four copy constants, toasts

**Modified (shared, my lines only)**
- `src/api/admin/platform.js`: the `CP5-FK` section, appended
- `vite.admin.config.js`: 1 alias row
- `src/admin-app/pages.jsx`: the `PlatformPrinters` line swapped. The import of `pendingPlatform` was dropped because it is now unused.
- `src/admin-app/dev/dev-api.mjs`: one import, `...PRINTER_ROUTES` at the end of the platform table
- `guard/allowlist.txt`: one entry out, one in
