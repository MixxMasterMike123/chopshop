Model: claude-opus-5-5 (Opus 5.5)

# CP5-FP report: the admin's pages on unit WK's routes

Built in the working tree on `cf-port` (HEAD `49205324`). No git command that writes, no network beyond the local dev server, nothing under `cloudflare/**` or `scripts/**` touched (the other builder's `scripts/cf-port/**` files in the tree are not mine). `guard/allowlist.txt` unchanged: no entry became stale.

## Contract notes (report vs code)

The routes behave as `CP5_WK_REPORT.md` says, with two stale lines in the report (the code wins, nothing built differently):
- §3 open question 2 says a print-job row "has no order status"; §1 and `print-job-list.ts:152` carry `orderStatus` (the reviewer added it). The page uses it.
- §2 says `state=none` is "accepted lines the printer has said nothing about". In `print-job-list.ts` it is `production_state IS NULL` on any dispatch state; only together with `dispatchState=accepted` does it mean that.

No item needed a Worker change.

## 1. Settings → PATCH (`saveShopConfig`)

**Every caller of `putSettings`**: one, `src/admin-app/replacements/shopConfig.js` (`saveShopConfig`). It now PATCHes; `putSettings` stays exported (tests) and is no longer called by the admin build. Through `saveShopConfig` this moves every identity save of AdminSettings (the form, the legal texts on blur, take-over, revert, the save before an adoption), AdminStorefront and AdminMenu. No caller is left on PUT.

**How a save is built** (`adapters/settings.js settingsPatchBody`):
- the BASELINE is the settings the page loaded (`loadShopConfig`), then each write's answer; the body carries only the top-level identity keys and gate fields whose value the patch changes against it, fenced on its `updatedAt` (`null` before the first write);
- an object patch (`legal: { customTexts: … }`) is merged into the stored object as Firestore's merge did and sent whole (the PATCH replaces a key);
- a key the page showed from `STORE` because nothing is stored, sent back unchanged, is not a change (so defaults are no longer written into the identity; see open question 3);
- gate text is trimmed as the Worker stores it; platform keys and `legal.acceptance` are never sent; nothing changed → no request.

This closes both windows of `CP5_FE_REPORT.md` (c): the round-trip race and the stale keys a whole form sent back. It also ends FE open question 5: a removed image no longer blocks every save (only patched keys are checked), so AdminMenu's dead-reference clean-up (an extra settings GET plus one object read per image on every menu save) is gone, and `brandingImages.js deadReferencesPatch` with it.

**The baseline belongs to the page that loaded it** (shopConfig.js header): the latest load of a shop owns it; a write's answer moves it only if no load started since; a save queued by a page whose baseline a later load replaced is refused; a page whose load failed saves nothing (it shows defaults, and diffing those would overwrite the stored settings). Saves of one tab stay queued; an answer after a shop switch is dropped (`readForShop`).

**Answers**:
- 200 → the page's form follows the answer (`follow(form, formOf)`, a three-way merge in `adapters/merge.js`): a field the server normalised (a trimmed return address) shows the stored value; typing done during the save is kept.
- 409 `conflict` → nothing written; the error carries `before`/`saved` and `follow`, which rebuilds the form from the answer's `settings` and keeps every edit the other write did not touch, naming the ones it did ("Din ändring av Slogan gick förlorad…"). The person checks and saves again (no automatic retry). Cheap on all three pages: AdminSettings merges its flat form; AdminStorefront's data module reads the stored identity's images and merges its branding form; AdminMenu keeps the seller's menu unless the other write changed the menu.
- lost answer → GET and compare the keys sent: all stored → done (`readBack`, form follows); row unchanged → "sparades inte"; moved without our values → said as a conflict (the form follows); the read fails → "oklart, ladda om".
- 400s pass through as before (`settingsRefusal` on the content pages).

**Page changes** (shared pages, both builds; the older build's save answers nothing, so the new code is inert there): AdminSettings — `formFromSaved` extracted from the load effect, `followSaved` / `followConflict`, every catch says `userMessage`; AdminStorefront and AdminMenu — one line in the catch sets the followed form. AdminSettings' inputs are NOT locked during a save (only the button is, as before): adding `disabled` to every control of a 1 000-line shared page was not cheap; the follow is merged on the latest form instead, so nothing typed during a save is lost.

`src/api/admin/client.js`: `AdminApiError.body` (the whole parsed body) so the 409's top-level `settings` reaches the caller (`patchSettings` sets `error.stored`). This also answers FL follow-up 2 for any later caller.

## 2. Payments → the balance panel

`GET /v1/admin/payments/connect/balance` (`api/admin/payments.js getConnectBalance`). The data module's `useConnectBalance(shopId, active)` reads ONCE per visit while the account can take payments (a ref guards re-renders and React's dev double effect; never on a timer; the focus re-read of the status does not touch it) and again on "Uppdatera". New panel `ConnectBalance` in AdminPayments (the older build's `BalancePanel` is untouched; the flags `BALANCE_READ` / `CONNECT_BALANCE` pick per build): available and pending per currency (`adapters/payments.js balanceView`; SEK byte-for-byte the page's own formatter, other currencies in their own minor unit, SEK first), the schedule as a sentence, "Hämtat från Stripe <tid>", the existing negative-balance warning. 409 `connect_account_missing` and the 404 → no panel (the section disappears unless the platform's payout-delay editor is shown, which stays below the balance for platform users). 429 → a quiet line, the balance stays; 502 → "kunde inte hämtas från Stripe just nu". Nothing blocks the onboarding buttons. The balance is the seller's own money at Stripe: no fee or platform figure (the route sends none).

## 3. Platform shops → counts

`readAllTenants({ counts: true })` (`?counts=1`), the detail's `counts`; `adapters/platformShops.js countsOf` / `SHOP_COUNT_COLUMNS`. `SHOW_COUNTS` is true in both admin data modules. The pages now map over the data module's `COUNT_COLUMNS` (older build: Produkter, Ordrar, Kunder as before; admin build: Produkter, Synliga, Ordrar). The customer column is gone in the admin build, not dashed.

## 4. Platform printers → the save's preview

`savePrinterTier(row, payload, before, { confirmPreview })`: the changed fields are first PATCHed with `dryRun: true` (fenced on the page's revision). **Decision: a dry run with nothing to warn about goes straight on, as the page saved before;** one that would pause mappings, leave products under their floor, or cannot check the floor (`tooManyToCheck`) asks first, listing the route's own facts (shop, product, SKU, reason; price and new floor; at most eight each, then "och N till"). The confirm is the page's `window.confirm`, as its neighbours (PlatformShops, PlatformShopDetail, PlatformReports) confirm. Then the real PATCH with the dry run's `revision`. A `409 revision_mismatch` (at the dry run or the write): the printer is read again (`GET /v1/platform/printers/:id`, new `getPrinter`), the operator's changes are laid over it with the same three-way merge (a field both changed stops the save and names it), and the preview runs and asks again (at most twice). A lost answer of the write is read back (revision unchanged → not saved; moved and holding the form → saved; else unclear). Cancel → nothing written, the form stays.

## 5. Shop members → "Skicka inbjudan igen"

On an `invited` row, above "Ta bort som administratör" (`AdminUsers.jsx`, admin build only via `MEMBER_ADMINS`). `replacements/memberResendData.js` (React-free so it runs under Node): 202 → "En ny inbjudningslänk … Den tidigare länken fungerar inte längre. Den gäller till …"; 409 `not_invited` → said, list re-read; 409 `not_invitable`; 429 with the `Retry-After` in words; 503 → said, including that the old link is dead (WK open question 3); 404 → the list is read again: gone → "inte längre administratör" (list re-read), still listed → the route is dark here ("e-post för inbjudningar är inte påslagen i den här miljön"), which is what staging answers today. A lost answer cannot be read back (nothing a route shows moves): said unclear, sending again is safe. No confirm before sending.

## 6. Platform console → "Tryckjobb"

`/platform/print-jobs`, `src/admin-app/pages/new/PlatformPrintJobs.jsx` (+ `printJobsData.js`, `adapters/printJobs.js`), mounted as `/platform/settings` was: a `PLATFORM_ROUTES` row, a `pages.jsx` line, and the menu entry after "Tryckerier" added by data (`platformLayoutData.js ADDED_PLATFORM_LINKS`, `QueueListIcon`); `PlatformLayout.jsx` untouched.

- **Default view = "Inte skickade" + "Mottagna av tryckeriet"**: the list takes one value per filter, so it is asked as `dispatchState=accepted` with no `state`, and shipped rows are left out client-side; a page with none to show reads the next at once (up to 5 pages). Filters: production state, dispatch state, shop (from the directory), printer (ids and names from the printers list); "Visa fler" walks the keyset cursor. The list is ordered by order id (random UUIDs), and the page says so.
- **A row**: order number, shop, the state pill, line, quantity, name, variant, SKU, printer, the printer's job reference, dispatch state and time, the order's status, tracking when shipped. No cost and no buyer (the route sends none; the row's key set is asserted in a test).
- **Actions**: the forward steps only (`nextStates`), and none when `dispatchState` is not `accepted` (the route's `not_accepted`) or `orderStatus` is in `REFUSED_ORDER_STATUSES = ['cancelled', 'refunded']` — exactly `fulfilment.ts:201-204 openSql`'s status set, the guard of every status write. A row with no action says why; an `unknown` row only shows its state (the console has no dispatch page).
- **The confirm** is written on the job read just before it opens (one row read back through the list from `cursorBefore(job)`) and the job is read again at the click: if it moved, the confirm is rewritten and nothing is sent. "Skickad…" carries tracking number, link and carrier, validated as `parseProductionStatusInput` does. What each sentence claims, and where the code says so:

| Sentence | Source |
|---|---|
| Statusen går bara framåt … kan den inte få en tidigare status igen. | `production-status.ts:18-20`, `:186` (backwards), `0051_print_job_status.sql:51` (trigger) |
| (i produktion) Ordern kan fortfarande avbrytas eller återbetalas helt. Då skapas ett ärende om att avbryta jobbet hos tryckeriet, som plattformen sköter för hand. | `production-status.ts:32-34` |
| (producerad/skickad) Efter det kan butiken inte avbryta ordern (det blir ett returärende), och en full återbetalning betalar tillbaka köparen men skapar inget ärende om att avbryta jobbet hos tryckeriet. | `production-status.ts:28-31` |
| (skickad) När alla tryckrader i ordern är skickade kan butiken markera ordern som skickad eller klar att hämta. | `production-status.ts:39-41`, `fulfilment.ts:32` (`printer_ships`) |
| (skickad) Är det här den sista oskickade raden i en order där alla rader trycks och skickas med paket till köparen, markeras hela ordern som skickad direkt, och köparen får ett mejl om att den är skickad (ett mejl per order). | `production-status.ts:41-43`, `fulfilment.ts:528-545`, `print-jobs-platform.ts:118-121` |
| (skickad) Spårningsuppgifterna nedan kan bara anges nu: de sparas på raden … kan inte läggas till eller ändras efteråt. De visas inte för köparen eller butiken. | `production-status.ts:24-26`, `0051_print_job_status.sql:62`, `fulfilment.ts:546-549`, CP6_PS1 "The mail" decision 1 |
| Ändringen loggas med ditt konto och tidpunkten. | `production-status.ts:335`, `print-jobs-platform.ts:71` |

- **Answers**: `changed` (+ "Hela ordern är nu markerad som skickad, och köparen får ett mejl om det." when `orderShipped`), `unchanged`, each 409 reason in words with the row read again, `conflict`, 400, 404; a lost answer is read back through the list (stored → done, `orderShipped` said unknown; unchanged → "sparades inte"; else unclear). The page is locked while a read or write runs.

## 7. Artwork library: one pill per product

`adapters/pod.js usagePillsByArtwork` (mapping rows now carry `productTitle`/`productSku`): one pill per product, "· N varianter" when several variant mappings print it, the union of slots. The grouping moved into the data modules (`usagePills`): the older build keeps its per-SKU pill (code moved verbatim). The pill links to nothing, before and after.

## 8. Product form keeps `alt`

`adapters/product.js imageList(own, groups, before)`: each row keeps the alt its object has on the server (same owner first, else the same object); `sameImageList` counts a carried alt; `productFormData.js` passes `_server.imageRows`. FN2 follow-up 1 is closed: a form save no longer erases the studio's marks.

## New Swedish texts

- **Settings conflict**: Någon annan har ändrat butikens inställningar sedan sidan lästes in, så din ändring sparades inte. Sidan visar nu det som är sparat. · (lost answer) Anslutningen bröts, och när inställningarna lästes igen hade någon annan ändrat dem: din ändring finns inte bland det som är sparat. Sidan visar nu det som är sparat. · Det du ändrat finns kvar; kontrollera och spara igen. · Din ändring av {fält} gick förlorad, eftersom den andra ändringen gällde samma fält: gör om den om den behövs. Det du ändrat i andra fält finns kvar; kontrollera och spara igen. ({fält}: "ett av fälten", "X och ett fält till")
- **Field names**: Juridiskt företagsnamn, Slogan, Telefon, Logotyp, Adress, Upphämtningsställen, Företagsbeskrivning, Organisationsnummer, Företagsinfo, Sociala länkar, Trustpilot, Juridiska texter, Returadress, Momsregistrerad, Momsregistreringsnummer, Säljartyp, Mall, Accentfärg, Favicon, Hero-bild, Hero-text, Startsida, Introtext, Berättelse, Galleri, Startsidans block, Menyn
- **Settings save**: Sidan lästes in på nytt medan ändringen väntade, så den sparades inte. Gör om den. · Butikens inställningar kunde inte läsas när sidan öppnades, så inget sparas härifrån. Ladda om sidan. · Anslutningen bröts och det är oklart om ändringen sparades. Ladda om sidan och kontrollera innan du försöker igen. · Anslutningen bröts och ändringen sparades inte. Försök igen.
- **Balance**: Stripe betalar ut till ditt bankkonto varje dag. / varje vecka, på {måndagar…söndagar}. / en gång i veckan. / den {n} varje månad. / en gång i månaden. · Utbetalningarna är manuella: Stripe betalar inte ut automatiskt. · Stripe betalar ut enligt schemat "{x}". · Pengar från en betalning hålls i {n} dag/dagar innan de kan betalas ut. · Stripe angav inget utbetalningsschema. · Saldot kan inte uppdateras just nu: för många anrop till Stripe på kort tid. Försök igen om {n sekunder / n minuter / en stund}. · Saldot kunde inte hämtas från Stripe just nu. Försök igen om en stund. · Saldot kunde inte hämtas: servern kunde inte nås. / …: servern svarade med ett fel (HTTP n). · Saldot kunde inte läsas: svaret saknade saldot. · Inget saldo ännu. · Uppdatera / Uppdaterar… · Försök igen / Hämtar… · Hämtat från Stripe {tid}
- **Counts**: Synliga · titles: Produkter som inte är arkiverade (utkast och aktiva) · Produkter som syns i butiken nu (0 medan butiken inte är publicerad eller är inaktiverad) · Alla butikens ordrar
- **Printers preview**: Spara ändringen av {tryckeri}? · Tryckeriet ändrades av någon annan medan du arbetade. Det här är vad din ändring gör nu, ovanpå den ändringen. · {N} produktkoppling(ar) pausas: tryckeriet kan inte längre göra den/dem. · reasons: en tryckyta som kopplingen trycker på finns inte längre / artikeln finns inte längre i tryckeriets katalog / artikeln saknar pris · "· {butik} · produkt {id} · artikel {sku}: {orsak}" · "· och {n} till" · Prisgolvet kan inte kontrolleras för alla produkter (för många): produkter kan hamna under golvet utan att listas här. · {N} produkt(er) hamnar under prisgolvet. Priserna ändras inte; säljaren får höja dem. · "· {butik} · produkt {id} (variant {id}): pris {kr}, nytt golv {kr}, till salu nu" · OK sparar ändringen. Avbryt sparar ingenting. · Ingenting sparades. · Tryckeriet har ändrats och kunde inte läsas igen. Ladda om sidan och gör ändringen igen. · Tryckeriet finns inte längre här. Ladda om sidan. · Någon annan ändrade samma uppgifter på tryckeriet medan du arbetade ({fält}). Ingenting sparades. Ladda om sidan och gör ändringen igen. · Tryckeriet hade redan de här uppgifterna. · Tryckeriet hade ändrats av någon annan; din ändring sparades ovanpå den ändringen. · Tryckeriet ändrades flera gånger medan du sparade. Ingenting sparades. Ladda om sidan och gör ändringen igen. · Svaret kom aldrig fram, men ändringen är sparad. Hur många produkter som påverkades kunde inte läsas. · Anslutningen bröts och det är oklart om ändringen sparades: tryckeriet har ändrats. Ladda om sidan och kontrollera innan du försöker igen. · field names: Preliminära mått, Plagg, {plagg} (tryckytor)
- **Members**: Skicka inbjudan igen / Skickar… · (title) Skickar en ny länk för att välja lösenord. Den tidigare länken slutar fungera. · En ny inbjudningslänk har skickats till {e-post}. Den tidigare länken fungerar inte längre. Den gäller till {tid}. · {e-post} har redan valt ett lösenord, så ingen ny inbjudan behövs. · {e-post} kan inte bjudas in: kontot är spärrat av plattformen. · För många inbjudningar på kort tid. Försök igen om {tid / en stund}. · Inbjudan kunde inte skickas just nu, och den tidigare länken fungerar inte längre. Försök igen om en stund. · Inbjudningar kan inte skickas igen härifrån just nu: e-post för inbjudningar är inte påslagen i den här miljön. · {e-post} är inte längre administratör i butiken. · {e-post} hittades inte som administratör här, eller så kan inbjudningar inte skickas härifrån just nu. Ladda om sidan. · Anslutningen bröts, så det är oklart om en ny inbjudan skickades. Om den skickades fungerar bara den nya länken. Du kan skicka igen. · Inbjudan kunde inte skickas igen.
- **Tryckjobb**: menu/title Tryckjobb · Orderrader som skickats till ett tryckeri, och vad tryckeriet har rapporterat. När tryckeriets mejl säger att ett jobb är i produktion, producerat eller skickat, rapporterar du det här. · filters Produktion (Inte skickade, Alla, Ingen rapport ännu, I produktion, Producerad, Skickad) · Hos tryckeriet (Mottagna av tryckeriet, Alla, I kö, Väntar, Skickas, Svar saknas, Inte mottagna, Avbrutna) · Butik (Alla butiker) · Tryckeri (Alla tryckerier) · dispatch: I kö, inte skickad till tryckeriet / Väntar på att skickas / Skickas till tryckeriet / Mottagen av tryckeriet / Svar saknas: okänt om tryckeriet fick jobbet / Tryckeriet tog inte emot jobbet / Avbruten · order: Betald, Behandlas, Tryckt, Skickad, Klar att hämta, Levererad, Slutförd, Delvis återbetald, Återbetald, Avbruten · row: Order {n} · Rad {l}: … · Okänt tryckeri · jobb {ref} · Order: {status} · Spårning: … · länk · Ordern är avbruten: ingen status rapporteras. / Ordern är återbetald: … / Raden är avbruten: … / Tryckeriet har inte tagit emot jobbet, så ingen status kan rapporteras. · buttons I produktion, Producerad, Skickad… · Inga tryckjobb att hantera: tryckeriet har inget mottaget jobb som inte är skickat. · Inga tryckjobb matchar filtret. · {n} tryckjobb visas, sorterade efter orderns interna id (inte efter datum). · Visa fler / Läser… · confirm: Rapportera "{status}" för order {n}, rad {l}? + the sentences in §6 + "{butik}, order {n}, rad {l}: {antal} × {namn} ({variant}), artikel {sku}." · Rapportera i produktion / producerad / skickad · Spårningsnummer (valfritt) · Fraktbolag (valfritt) · Länk till spårningen (valfri) · Spårningsnumret får vara högst 100 tecken, på en rad. · Fraktbolaget får vara högst 60 tecken, på en rad. · Länken ska vara en https-adress (som börjar med https://), högst 500 tecken och utan mellanslag. · Order {n}, rad {l}: {status}. · Hela ordern är nu markerad som skickad, och köparen får ett mejl om det. · Raden hade redan den statusen med samma uppgifter; ingenting ändrades. · Svaret kom aldrig fram, men statusen är sparad. (Om hela ordern därmed markerades som skickad kunde inte läsas här.) · refusals: Tryckeriet har inte tagit emot jobbet, så ingen status kan rapporteras. / Ordern eller raden är avbruten: … / Ordern är återbetald: … / Raden har redan en senare status, och statusen går bara framåt. / Raden är redan skickad med andra spårningsuppgifter, och de kan inte ändras. / Tryckjobbet kan inte få den statusen. / Jobbet ändrades samtidigt av något annat. Raden visar läget nu; försök igen om det behövs. / Servern tog inte emot uppgifterna: … / Jobbet finns inte, eller så är raden inte ett tryckjobb. Ladda om sidan. / Ändringen kunde inte skickas: servern kunde inte nås. · Anslutningen bröts och statusen sparades inte. Försök igen. · Anslutningen bröts och det är oklart om statusen sparades. Ladda om sidan och kontrollera innan du försöker igen. · Tryckjobbet finns inte längre i listan. Ladda om sidan. · Order {n}, rad {l} har ändrats sedan listan lästes och kan inte få statusen "{x}" nu. Raden visar läget. · Tryckjobbet ändrades medan rutan var öppen. Texten ovan gäller läget nu; bekräfta igen om det fortfarande stämmer. · Tryckjobbet ändrades medan rutan var öppen och kan inte få den statusen nu. Ingenting skickades; raden visar läget. · toasts Statusen är sparad. / Statusen är sparad och ordern är skickad. / Fler tryckjobb kunde inte läsas.
- **Artwork pill**: · {n} varianter

## What I looked at (dev server :5291, own browse state; shots `/private/tmp/fp-*.png`)

- **Tryckjobb** (platform): list 1440 (`fp-printjobs-1440`) — dark console, pills in the console's palette, rows with and without actions, the cancelled/refunded reasons; the shipped confirm with tracking fields (`…-confirm-shipped-1440`); a saved shipped row with tracking and link (`…-shipped-1440`); the last line of order 1042 shipped → "Hela ordern är nu markerad som skickad…" (`…-order-shipped-1440`); a lost answer read back → "Svaret kom aldrig fram, men statusen är sparad." (`…-lost-readback-1440`; network: POST 502, then the one-row read); empty, error, "Visa fler" (`…-empty/error/many-1440`); 375 (`…-375`), `scrollWidth` 375. The menu shows "Tryckjobb" highlighted after "Tryckerier".
- **Printers**: the dry run's `window.confirm` text read from the browser, dismissed → one dry-run PATCH only; accepted → dry run then the write, toast "…1 produktkoppling pausades…" (`fp-printers-saved-1440`).
- **Shops**: list with Produkter / Synliga / Ordrar (`fp-shops-counts-1440`), detail's Översikt card (`fp-shopdetail-counts-1440`).
- **Payments**: per-currency panel, schedule sentence, read time (`fp-payments-balance-1440`; one balance GET per visit); 429 after "Uppdatera" keeps the balance with the quiet line (`…-limited`); 502 (`…-stripe`); no account → no section; 375 dark (`…-375-dark`).
- **Members**: the button on the invited row, 202 toast (`fp-users-resent-1440`), the dark 404 said in words after the list re-read (`fp-users-dark-1440`); 375 `scrollWidth` 375.
- **Settings**: conflict on the slogan with an address edit → toast names Slogan, the slogan shows the other admin's value, the address keeps the typed value (`fp-settings-conflict-1440`); the next save 200.
- **Menu** (`fp-menu-conflict-1440`) and **Butik** (`fp-storefront-conflict-1440`) conflicts: followed forms and the sentence.
- **Artwork library**: "Används av T-shirt Fjäll · 2 varianter · Bröst" where two per-variant pills were (`fp-artwork-pills-1440`).
- Console errors: only React Router's future-flag warnings. The design hook flags a pre-existing gray-on-colour line in `PlatformPrinters.jsx:323` (FK left it; not mine).

## Open questions

1. A settings conflict never retries by itself: the person sees the merged form and saves again. OK?
2. AdminSettings' controls are not locked during a write (only its button); the follow merges on the latest form instead. Acceptable for the shared page, or should every control get `disabled`?
3. A field that shows a `STORE` default and was never stored is no longer written on save (the PUT wrote every default). Public pages merge the same defaults, so the shop looks the same; stored identities just stop filling with defaults.
4. The printer preview is a `window.confirm` (as the console's older pages); the Tryckjobb page uses the modal. Move the printer preview to the modal?
5. Tryckjobb lists in order-id order (random), the one order an index serves (WK open question 1: a migration would allow a selective cross-shop filter).
6. After the platform changes the payout delay, the balance's schedule sentence shows the old delay until "Uppdatera" (the editor beside it shows the new one).
7. No confirm before "Skicka inbjudan igen" (the success line says the old link is dead).
8. "Synliga" as the header of `publishedProducts`?

## Follow-ups (not mine to change)

- `vite.admin.config.js` alias descriptions are now stale for `adminPaymentsData` ("no balance read"), `platformShopsData` ("no per-shop counts"), `platformShopDetailData` ("no counts card"), `shopConfig` (already stale), `adminUsersData` (no resend).
- `src/pages/admin/AdminSettings.jsx:220` saves only `legal.noWithdrawalNotice`, so the `withdrawalNoticeVersion` its onChange sets (`:725`) is never stored (pre-existing; the Worker reads neither key).

## Gate (after the last edit)

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 994  # suites 289  # pass 994  # fail 0          (919 before: +75)
npx vite build --config vite.admin.config.js     ✓ built
node cloudflare/admin/check-admin-build.mjs      admin build: 27 files (21 text) checked, no [old-backend] code, no source map, no secret, every file servable.   (the check's own word for the old backend replaced here)
npx vite build                                   ✓ built
node guard/guards.test.mjs                       guard: 2458 tracked files scanned, 295 match a pattern; allowlist 294, permanent exemptions 1, baseline 294; PASS
```
My new files and every added line grepped for the guard's families: no match. The admin bundle holds no dev data (`admin_dev_fp`, fixture strings, the dev marker) and does hold the new page.

**Mutation checks** (file copies, restored and compared with `cmp`; each caught):

| # | Mutation | Failed |
|---|---|---|
| M1 | no read-back after a lost settings PATCH | 2 |
| M2 | defaults sent as changes | 1 |
| M3 | actions offered on a cancelled/refunded order | 2 |
| M4 | the dry run's warning not asked | 4 |
| M5 | a dark resend said as "no longer a member" | 1 |
| M6 | a lost edit not named by the merge | 1 + 2 |
| M7 | alt dropped on re-save | 1 |
| M8 | a 404/409 balance shows a panel | 1 |
| M9 | no re-preview after the printer moved | 1 |
| M10 | a lost status not read back as done | 1 |

## Files

**Created**: `src/admin-app/adapters/merge.js` (+test), `src/admin-app/adapters/printJobs.js` (+test), `src/admin-app/pages/new/PlatformPrintJobs.jsx`, `src/admin-app/pages/new/printJobsData.js`, `src/admin-app/pages/new/fpData.test.mjs`, `src/admin-app/replacements/memberResendData.js`, `src/admin-app/dev/fp-dev.mjs` (+test), `src/admin-app/dev/print-jobs-fixtures.json`, `src/api/admin/fp-calls.test.mjs`, this report.

**Modified**: `src/api/admin/{client,settings,payments,members,platform}.js`, `src/api/admin/settings.test.mjs`; adapters `settings, payments, platformShops, platformPrinters, member, pod, product` (+ their tests); replacements `shopConfig, adminStorefrontData, adminMenuData, adminPaymentsData, adminUsersData, platformShopsData, platformShopDetailData, platformPrintersData (+test), podArtworkLibraryData, productFormData, platformLayoutData, brandingImages, shells.test`; dev `dev-api, members-dev, platform-dev (+test), printers-dev, content-dev.test` (one added load before a save, as the page does); `src/admin-app/{PlatformApp.jsx, pages.jsx}`; shared pages `AdminSettings, AdminStorefront, AdminMenu, AdminPayments, AdminUsers, PlatformShops, PlatformShopDetail, PlatformPrinters, ArtworkLibrary` and the older build's data modules `adminPaymentsData, adminUsersData, platformShopsData, platformShopDetailData, artworkLibraryData` (one new export each, so both builds share the page).
