Model: claude-opus-5-5 (Opus 5.5)

# CP5-FL report: the new pages of the admin build

I built four new pages in the working tree on `cf-port`, starting from HEAD `dd827cff`:
- the platform console's settings (`/platform/settings`);
- its brand filter (`/platform/screening`);
- its terms versions (`/platform/terms`);
- the shop admin's forwards (`/admin/redirects`).

They have no older page and exist only in the admin build. Rules I kept:
- I touched only `src/**` and this report, and nothing under `cloudflare/`.
- No network except localhost, no wrangler, no deploy, no staging.
- The older build's dev server was never started.

**One rule I broke, once.** During a mutation check I edited the shared `src/admin-app/providers/ordersForShop.js` and put it back with `git checkout -- <file>`. That is a git command that writes to the working tree, which the brief forbids.
- The file was clean at HEAD before: it was not in the starting `git status`, and nobody else had touched it.
- It is byte-identical to HEAD now (`git diff --quiet` passes).
- I redid every mutation check with file copies only. That run's result is not used in this report.

**Not mine:** another builder's uncommitted changes are in the tree:
- `cloudflare/**` (as the brief said);
- `scripts/cf-port/migrate/**`, which appeared during my run.

I did not touch either.

## (a) What changes in existing shells (admin build only; the older build is unchanged)

| Where | Change | How |
|---|---|---|
| Console menu, "Inställningar" | Was `live: false` ("SNART"); now a link to `/settings`. "Betalningar" stays "snart". | Data, not markup: `scopePlatformNav` in the layout's data module (`replacements/platformLayoutData.js`) sets `live: true` for the paths in `LIVE_PLATFORM_PATHS = ['/settings']`. `PlatformLayout.jsx` is untouched. |
| Shop admin menu | New entry **"Omdirigeringar"** (icon `ArrowUturnRightIcon`) right after "Sidor", pointing to `/admin/redirects`. | Data, not markup: `scopeAdminNav` in `replacements/adminShellScope.js` inserts the entries of `ADDED_ADMIN_LINKS`. `AppLayout.jsx` is untouched. This is a few lines in the data module, not one: an import, a frozen list and a `flatMap`. I chose it over a link from the settings page, because `AdminSettings.jsx` is an existing page whose markup must stay byte for byte. |
| FB's assertions in `replacements/shells.test.mjs` | Updated: the admin menu now has `/admin/redirects` after `/admin/pages`. The console menu's `/settings` is live, `/payments` is not, and the shell's own list is not mutated. | As FO did for 3D-modeller. |

Nothing else of an existing page or shell changed.

## Pages and routes

| Page | Route | File | Line in `pages.jsx` |
|---|---|---|---|
| Inställningar → Allmänt | `/platform/settings` | `src/admin-app/pages/new/PlatformSettings.jsx` | `PlatformSettings` |
| Inställningar → Varumärkesfilter | `/platform/screening` | `…/PlatformScreening.jsx` | `PlatformScreening` |
| Inställningar → Plattformsvillkor | `/platform/terms` | `…/PlatformTermsVersions.jsx` | `PlatformTermsVersions` |
| Omdirigeringar | `/admin/redirects` (guard `admin`) | `…/AdminRedirects.jsx` | `AdminRedirects` |

**How the calls reach the Worker:**
- The platform pages make every call with `platformRequest`, so none carries `X-Shop-Id` (tested on every call). They live in the `CP5-FL` section of `src/api/admin/platform.js`.
- The forwards page makes every call with `adminRequest`, always naming the shop the page was opened for. Those calls are in the new `src/api/admin/redirects.js`.
- Each call goes through `readForShop`: an answer that arrives after the tab moved to another shop is dropped (tested). The admin tree also mounts the page afresh for each shop.

**Route map:**

| Action | Route |
|---|---|
| settings: read / change | `GET` / `PATCH /v1/platform/settings` (a change first GETs again) |
| filter: list | `GET /v1/platform/screening-terms?limit=500`, every page |
| filter: add / change / remove | `POST /v1/platform/screening-terms` / `PATCH …/:termKey` / `DELETE …/:termKey` |
| "Granska om nu…" | `POST /v1/platform/screening-terms/rescreen` |
| terms: list / text | `GET /v1/platform/legal/terms-versions` / `GET …/:version/text` |
| terms: publish | `POST /v1/platform/legal/terms-versions { version, text }` (no `publishedAt`: now) |
| terms: archive a missing text | `PUT …/:version/text { text }` |
| forwards | `GET /v1/admin/redirects?cursor&limit=100`, `PUT { redirects: [one] }`, `DELETE { fromPaths: [one] }` |

## What each setting means (shown on the page, one sentence each)

| Field (`GET /v1/platform/settings`) | Shown as | Editable | What it does, from the Worker's code |
|---|---|---|---|
| `defaultCommissionBps` | "5,00 %" | Yes, 0–8 % (the Worker's cap, D45) | Fee on every payment of a shop **without its own fee**. It is frozen when the payment starts (the PaymentIntent), so a started payment keeps its fee. |
| `refundApplicationFee` | "Behålls av plattformen" + "Låst i koden" | No (fixed in code, D9; a PATCH is refused with `setting_not_editable`) | When an order is refunded, the platform keeps its fee. |
| `reverseDisputeOnCreated` | "Direkt när tvisten öppnas" + "Låst i koden" | No | The disputed amount is taken back from the shop when a dispute opens. |
| `reviewFirstProducts` | "2 produkter" / "Av" | Yes, 0–100 | A new shop's first N products wait for platform approval. Decided once, at a product's first screening: a product already waiting keeps waiting. |
| `screeningHardBlock` | switch "På/Av" | Yes | ON: every filter hit blocks, in the same write. Products approved by hand are spared unless the hit is new to them. OFF lifts no block. |
| `screeningTermsVersion` | the number | No (moves on every filter change) | Products screened against an older version are re-screened. |
| `updatedAt`, `updatedBy` | "Senast ändrad 2 okt. 2026 15:41 av konto <id>" | No | The route gives the user's id, not an email address (see follow-ups). |

**How a change is made:**
1. The page reads the settings again. If a value the change touches has moved since the page loaded, the change stops: "Inställningen har ändrats av någon annan … (den är nu 7,25 %)". The page then shows the new value.
2. If the value has not moved, the change is sent:
   - the fee and the hard block ask first, in a confirm;
   - the review count is saved directly. It moves no money and no published product, and its consequence is stated beside the field.
3. The form follows the PATCH answer.
4. After a change of the hard block, the server's counts are shown (how many products were taken off, how many are waiting, how many are unverified).

## What each confirm says (the full texts are in the table below)

- **Fee:** "Ändra standardavgiften från 5,00 % till 6,50 %?"
  - who it affects (only shops without their own fee);
  - from when (payments that start after you save; a started payment keeps its fee);
  - that sellers see it as an amount per order.
  - The "from" value is the one just read from the server.
- **Hard block on:** "Direkt när du sparar tas varje publicerad produkt … bort ur butikerna". Products approved by hand stay unless a new term hits them. Products whose text has not been checked are handled by the 15-minute sweep.
- **Hard block off:** blocked products stay blocked; they are released by approval in Anmälningar → Granskning (CP3-D open question 2).
- **Add a blocking term** (or any term while the hard block is on): products containing the word go off the storefront at once, even ones approved by hand. Adding a non-blocking term asks nothing; it only flags, and the counts are shown after.
- **Turning a term's block on or off:** the same two consequences as the global switch. While the global switch is on, the confirm says instead that the change has no effect until the switch is off.
- **Removing a term:**
  - if it blocked: products blocked only by it come back to the storefront, flagged, when the sweep reaches them (about 15 minutes, or at once with "Granska om nu"). Products taken down by hand stay down. This is `decideScreening`: a blocked product with no hits left becomes `flagged`, which is public.
  - if it only flagged: nothing new is flagged, and products already flagged stay in the queue.
- **Re-screen:** it re-runs the full machine on at most 25 published products whose verdict is older than the filter (the same as the 15-minute cron, `scheduled.ts`). It then lists each consequence:
  - a blocking hit → off the storefront;
  - a new hit → flagged but still public, with a new shop's first products waiting;
  - a removed blocking term → back, flagged;
  - a takedown by hand → stays.
  - While the hard block is on, the second and third lines become "every hit takes the product off".
- **Publish a terms version** (danger tone), from `platform-terms.ts`, D47, D48 and D54:
  1. In force from the instant you publish; it replaces the current version.
  2. Every shop's admin meets the new terms in the admin and must accept them. Only the shop's own admin can accept, never the platform.
  3. A shop that accepted the current version keeps checkout open for 14 days after publishing, then checkout is closed until it accepts.
  4. A shop that never accepted, or only an older version, gets no grace: checkout closes at once.
  5. A payment already started can finish within its day.
  6. The storefront's Plattformsvillkor page shows the new text at once.
  7. The name and the text can never be changed or removed; the text is archived with its checksum as evidence.
  - With no version in force, the confirm says that no shop can take payments until it accepts.
- **Archive a missing text:**
  - the server takes only the exact text whose checksum the version holds;
  - shops that have not accepted will meet it and can then accept;
  - it cannot be changed afterwards.
- **Remove a forward:** `window.confirm`, as `AdminPages` does: "Ta bort omdirigeringen från /x? Den som går till den gamla adressen får då sidan "hittades inte"."

## The terms text: what the page writes, and why

The seller's gate and the storefront read a version's text in one format: JSON `{ version, terms, dpa }` with the two documents in markdown (`toPagePlatformTerms`, the 0031 seed's format). A text in any other format cannot be shown to a seller:
- the gate then lets every seller through;
- the server's checkout gate stays closed;
- so no shop could accept and take payments.

So the page:
- always composes that format from two fields ("Plattformsvillkor", "Personuppgiftsbiträdesavtal (bilaga)");
- starts them from the current version's archived text;
- previews them with the seller's own adapter and renderer, so the preview is what sellers see.

When it shows an archived text in another format, the page says the sellers cannot see it. No draft exists on the Worker, so "writing a text" means publishing a version with its text. Scheduling (`publishedAt` in the future) is not offered: see open question 1.

**The 0031 seed (`2026-09-07`) has no archived text on staging** (HANDOVER). I first built "archive the text from the code" (`src/config/platformTerms.js`), but the admin build check refused the bundle. The seed's personuppgiftsbiträdesavtal lists the source system's provider by name as a sub-processor, and `check-admin-build.mjs` refuses that name anywhere in the bundle.

So the page instead takes the **exact text**:
- pasted, or read from a file;
- a file may be the `{ "text": … }` body that `CP3_E_REPORT.md` §2's command writes;
- the server checks it by its hash;
- a wrong text gets "Texten stämmer inte med versionens kontrollsumma…".

The template is not in the bundle (checked).

## Design decisions

**Placement.** There are three routes (`/settings`, `/screening`, `/terms`), sharing one header ("Inställningar") with section links. Each is its own address and does a different job with a different consequence:
- a money value;
- a list of up to 2 000 terms with its own sweep;
- a legal publish.

Together on one page, the fee field and the publish would sit in one long scroll. The two screening values (the review count and the global switch) stay on Allmänt because they are fields of `GET /v1/platform/settings` and the brief says to show every field. The filter page reads the switch beside the terms: while it is on, a notice says that every term blocks, every pill says "Spärrar", and the confirms say why.

**The sidebar on `/screening` and `/terms`.** `PlatformLayout`'s `isActive` is an exact match, so no menu entry is highlighted on those two addresses. PlatformShopDetail has the same behaviour. The section links show where the operator is. Changing `isActive` is a shell change, not mine (open question 3).

**The vocabulary**, copied with each source named in `platformKit.jsx`. There is no new colour, font, radius or shadow.

| Element | Copied from |
|---|---|
| page frame and title | `PlatformShops` (the reference page) |
| section links | `PlatformReports`' tabs, drawn as links with `aria-current` |
| Card | `PlatformShopDetail` |
| inputs, primary button | `PrinterRow` |
| quiet button, textarea | `PlatformReports` |
| small primary button | `shopCells` CommissionCell's save button at the quiet button's size |
| row "Ta bort" | `PlatformUsers`' row action (quiet, red on hover). I first used Reports' red button; eight of them shouted (`screening-1440` before the fix). |
| modal | `PlatformUsers`' CreateSuperAdminModal |
| switch | `PlatformAddons` |
| amber notice | `PlatformPrinters` |
| pills | `PlatformShopDetail` / `PlatformReports` (Blockerad red, Flaggad amber) |
| loading / error / empty | `PlatformUsers` |
| legal typography | `PlatformTermsGate`'s `LEGAL_DOC_TYPO` in console colours; the template's draft quote as the console's notice |

The forwards page uses `Page`, `CardSection`, `Field`, `Input`, `Button` and `DataTable` from the admin UI kit, as `AdminPages` uses them, with the same trash action and `window.confirm`. The critical tokens are the admin's own (`admin-critical-*`).

**A modal for the platform confirms** (where Reports uses `window.confirm`):
- the consequences are several sentences;
- the cancel button takes the focus first;
- Escape and the backdrop cancel;
- while the write runs, nothing closes it, and a refusal lands inside it.

**The impeccable pass** (Operate mode, preserving the incumbent systems) led to these changes after looking:
- the noisy row deletes went quiet;
- the "Ny version" button stopped wrapping;
- the version list became stacked rows instead of a table, so an opened text never needs sideways reading at 375;
- the terms columns hide below `sm`/`md`, and the row actions stack;
- the section links take short labels below `sm` ("Filter", "Villkor");
- the document title became the console's card-title style, so the document's own headings lead;
- the editor's help was split (name / markdown fields), which fixed a missing space;
- the editor seeds its texts once when opened, so a list refresh never wipes typed legal text;
- the duplicate "no text" notice inside the current version's row went;
- the rescreen confirm became aware of the global switch.

**Shots** (`/private/tmp/fl-shots/`; light admin unless "dark"):
- **settings:** `settings-1440`, `settings-375`, `settings-fee-refused-1440`, `settings-fee-confirm-1440`, `settings-hardblock-confirm-1440`, `settings-hardblock-lost-readback-1440`, `settings-stale-1440`, `settings-error-1440`;
- **screening:** `screening-1440` (before the quiet-delete fix), `screening-375` (after), `screening-add-confirm-1440`, `screening-edit-1440`, `screening-edit-375`, `screening-delete-confirm-375`, `screening-empty-1440`, `screening-error-1440`;
- **terms:** `terms-1440` (before the button fix), `terms-375`, `terms-text-1440`, `terms-archive-form-1440`, `terms-archive-refused-1440`, `terms-new-1440`, `terms-new-preview-1440`, `terms-new-375`, `terms-publish-confirm-1440`, `terms-published-1440`, `terms-empty-1440`, `terms-error-1440`;
- **forwards:** `redirects-1440`, `redirects-375`, `redirects-refused-chain-1440`, `redirects-dark-refused-1440`, `redirects-empty-1440`, `redirects-error-1440`, `redirects-acting-as-1440`.

`screening-rescreen-confirm-1440` shows no dialog: the browse tool reloaded the page between commands (FO saw the same). I verified that dialog's text and the run's result inside one evaluation instead.

At 375, `scrollWidth` was 375 on all four pages: no sideways page scroll.

## Table of new Swedish texts (for one pass of rewording)

**Allmänt** (`/platform/settings`; the texts in `adapters/platformSettings.js` unless noted)

| Where | Text |
|---|---|
| header (all three platform pages) | Inställningar · links: Allmänt · Varumärkesfilter (mobile: Filter) · Plattformsvillkor (mobile: Villkor) |
| subtitle | Plattformens avgift, granskningen av produkter och plattformsvillkoren. Allt här gäller alla butiker. |
| card titles | Avgift och betalningar · Granskning av produkter · link "Varumärkesfilter →" |
| row labels | Standardavgift · Avgiften vid återbetalning · Omtvistade betalningar · Förhandsgranskning av nya butiker · Alla träffar spärrar · Filtrets version |
| meaning: fee | Plattformens avgift i procent av varje betalning, för butiker som inte har en egen avgift (den sätts på butikens sida under Butiker). Högst 8 %. |
| meaning: refund | När en order återbetalas behåller plattformen sin avgift; den betalas inte tillbaka till butiken. |
| meaning: dispute | När en köpare bestrider en betalning dras det omtvistade beloppet från butiken så fort tvisten öppnas, inte först när den avgörs. |
| meaning: review | Så många av en ny butiks första produkter måste du godkänna under Anmälningar → Granskning innan de syns i butiken. 0 stänger av förhandsgranskningen. En ändring gäller produkter som publiceras första gången efter den; en produkt som redan väntar fortsätter vänta. |
| meaning: hard block | På: varje träff i varumärkesfiltret tar produkten ur butiken. Av: bara ord märkta "Spärrar" gör det; andra träffar flaggar produkten för granskning men den ligger kvar. |
| meaning: version | Räknas upp vid varje ändring av filtret. Publicerade produkter som granskats mot en äldre version granskas om automatiskt. |
| values | Behålls av plattformen / Återbetalas till butiken · Direkt när tvisten öppnas / När tvisten avgjorts · "N produkter" / "1 produkt" / "Av" · På / Av · pill "Låst i koden" (title: Värdet är låst i koden och ändras inte här) |
| buttons | Ändra · Spara / Sparar… · Avbryt |
| field refusals | Skriv avgiften i procent, t.ex. 5 eller 5,25 (högst två decimaler). · Standardavgiften får vara högst 8,00 %: prisgolvet för tryckta produkter räknar med högst 8 %. · Skriv ett heltal från 0 till 100. |
| stale | Inställningen har ändrats av någon annan sedan sidan lästes (den är nu X). Sidan visar nu det nya värdet; gör om ändringen om den fortfarande behövs. |
| confirm, fee | Ändra standardavgiften från X till Y? · Gäller alla butiker som inte har en egen avgift. Butiker med egen avgift påverkas inte. · Den nya avgiften gäller betalningar som startar efter att du sparat. En betalning som redan har startat behåller sin avgift. · Säljarna ser avgiften som ett belopp per order. · [Ändra till Y] |
| confirm, block on | Slå på "Alla träffar spärrar"? · Direkt när du sparar tas varje publicerad produkt vars text träffar något ord i filtret bort ur butikerna. · En produkt du godkänt för hand ligger kvar, så länge inget nytt ord träffar den. · Produkter vars text servern inte har kontrollerat än tas om hand av omgranskningen, högst 25 åt gången var 15:e minut. · [Slå på – spärra alla träffar] |
| confirm, block off | Slå av "Alla träffar spärrar"? · Från nu flaggar en träff bara produkten för granskning, utom för ord märkta "Spärrar". · Produkter som redan spärrats ligger kvar spärrade. Du släpper dem genom att godkänna dem under Anmälningar → Granskning. · [Slå av] |
| toasts | Standardavgiften är nu X. · Förhandsgranskning: N produkter. · "Alla träffar spärrar" är på. / är av. |
| result after a lost answer | Ändringen är sparad. Svaret kom aldrig fram, så hur många produkter som påverkades kunde inte läsas. |
| footer | Senast ändrad <tid> av konto <id>. |
| confirm dialog (shared) | Avbryt · Skickar… |

**Varumärkesfilter** (`/platform/screening`)

| Where | Text |
|---|---|
| subtitle | Ord som produkttexter kontrolleras mot när en produkt publiceras eller ändras. En träff flaggar produkten för granskning; ett ord som spärrar tar den ur butiken. |
| notice (switch on) | "Alla träffar spärrar" är på under Allmänt: varje ord i filtret spärrar, oavsett sin egen markering. |
| add card | Lägg till ord · Ord (placeholder: t.ex. ett bandnamn eller ett varumärke) · Typ · Anteckning (valfri, syns bara här) (placeholder: t.ex. vem som begärt spärren) · Spärrar: en träff tar produkten ur butiken direkt · [Lägg till] |
| help | Ordet sparas i den form filtret jämför med: små bokstäver, utan accenter och skiljetecken ("AC/DC" blir "ac dc"). Ett ord av bara symboler, som ™, sparas som det skrivs. |
| kinds | Band/artist · Varumärke · Klubb/lag · Annat |
| full | Filtret är fullt: det rymmer högst 2 000 ord. |
| rescreen card | Omgranskning · När filtret ändras granskas publicerade produkter om automatiskt, högst 25 åt gången var 15:e minut. Produkter som ett nytt spärrande ord träffar tas bort ur butikerna redan när du sparar ordet. · [Granska om nu…] / [Granska nästa omgång…] |
| list | Ord i filtret · "N ord · filtrets version V" · Sök ord eller anteckning · columns: Ord, Typ, Vid träff, Anteckning, Tillagt, Åtgärder · pills Spärrar / Flaggar · Ändra / Stäng · Ta bort |
| edit row | Typ · Anteckning · Själva ordet kan inte ändras: ta bort det och lägg till det nya. · Avbryt · Spara |
| empty | Filtret är tomt. Lägg till ett ord ovan; produkter som innehåller det flaggas för granskning. · Inget ord matchar "x". |
| status after a write | "x" lades till. / "x" ändrades. / "x" togs bort. + the counts: N produkter togs bort ur butikerna direkt. · N publicerade produkter väntar på omgranskning. · N publicerade produkter saknar en text som servern har kontrollerat och kan inte stämmas av direkt mot filtret. (singular forms too) · Svaret kom aldrig fram, så hur många produkter som påverkades kunde inte läsas. |
| run result | N produkter granskades om. / 1 produkt granskades om. / Ingen produkt behövde granskas om. · Alla publicerade produkter är granskade mot filtret som det ser ut nu. |
| toasts | Ordet lades till. · Ändringen är sparad. · Ordet togs bort. · Omgranskningen kördes. |
| confirm, add blocking | Lägga till "x" som spärrande ord? · Direkt när du sparar tas varje publicerad produkt vars text innehåller ordet bort ur butikerna, även produkter du godkänt för hand. · (switch on) Ordet spärrar fast det inte är markerat, eftersom "Alla träffar spärrar" är på under Allmänt. · Produkter vars text servern inte har kontrollerat än tas om hand av omgranskningen. · [Lägg till och spärra] |
| confirm, block a term | Låta "x" spärra? · Direkt när du sparar tas varje publicerad produkt vars text innehåller ordet bort ur butikerna, även produkter du godkänt för hand om ordet är nytt för dem. · [Spärra] |
| confirm, unblock a term | Sluta spärra på "x"? · Nya träffar flaggar bara produkten för granskning. · Produkter som redan spärrats av ordet ligger kvar spärrade. Du släpper dem genom att godkänna dem under Anmälningar → Granskning. · [Sluta spärra] |
| confirm, flag change while switch on | Markera "x" som spärrande? / Ta bort markeringen "Spärrar" från "x"? · "Alla träffar spärrar" är på under Allmänt, så ordet spärrar redan, med eller utan markering. Ändringen märks först om du slår av det. · [Spara markeringen] |
| confirm, remove | Ta bort "x" ur filtret? · (blocking) Produkter som spärrats bara av det här ordet kommer tillbaka i butiken, flaggade för granskning, när omgranskningen når dem: inom ungefär 15 minuter, eller direkt med "Granska om nu". · Produkter som plattformen avpublicerat för hand förblir avpublicerade. · (flagging) Ordet flaggar inga nya produkter. Produkter som redan flaggats för det ligger kvar i granskningskön tills du hanterar dem. · [Ta bort ordet] |
| confirm, rescreen | Granska om publicerade produkter nu? · Servern granskar om upp till 25 publicerade produkter vars granskning är äldre än filtret, samma sak som görs automatiskt var 15:e minut. · En produkt som träffar ett spärrande ord tas bort ur butiken. · En produkt som träffar ett nytt ord flaggas och hamnar under Anmälningar → Granskning, men ligger kvar i butiken. En ny butiks första produkter väntar på ditt godkännande. · (switch on, instead of the two above) En produkt som träffar något ord i filtret tas bort ur butiken, eftersom "Alla träffar spärrar" är på. · En produkt som spärrats av ett ord som sedan tagits bort kommer tillbaka i butiken, flaggad. · Produkter som plattformen avpublicerat för hand förblir avpublicerade. · [Granska om upp till 25] |
| form problems | Skriv ordet som ska filtreras. · Anteckningen får vara högst 500 tecken. · Välj en typ. |

**Plattformsvillkor** (`/platform/terms`; `adapters/termsVersions.js` and `termsVersionsData.js`)

| Where | Text |
|---|---|
| subtitle | Avtalet mellan plattformen och säljarna. En butik kan bara ta betalt när dess admin har godkänt versionen som gäller. |
| header button | Ny version |
| notice (current has no text) | Versionen som gäller, V, har ingen arkiverad text. Säljarna kan inte läsa eller godkänna den, och en butik som inte har godkänt den kan inte ta betalt. Öppna versionen nedan för att lägga till texten. |
| list | pills Gäller nu · Schemalagd · Ersatt · Text saknas · "Sedan <tid>" / "Gäller från <tid>" / "Gällde från <tid>" · Visa text / Stäng |
| opened version | Publicerad · Kontrollsumma (SHA-256) · Läser texten… · Visa källtexten / Visa som säljarna ser den |
| other format | Texten är inte i det format säljarnas sidor läser (villkor och personuppgiftsbiträdesavtal i markdown), så säljarna kan inte se den. Så här är den arkiverad: |
| older version without text | Versionen har ingen arkiverad text, så säljarna kunde inte läsa den. |
| archive form | Texten kan läggas till i efterhand, men bara exakt den text versionen publicerades med: servern jämför den med kontrollsumman ovan och tar inte emot något annat. · Den exakta texten · Välj en fil… · Arkivera texten… · Så här ser texten ut för säljarna: · Texten är inte i det format säljarnas sidor läser (villkor och personuppgiftsbiträdesavtal i markdown), så säljarna skulle inte kunna se den. · Filen är för stor för en villkorstext. · Klistra in texten, eller välj en fil med den. |
| new version | Ny version · Versionens namn · Visas för säljarna och kan inte ändras. Vanligen dagens datum. · Texterna börjar som versionen som gäller nu. / Det finns ingen arkiverad text att utgå från, så texterna börjar tomma. · Skriv i markdown. {{platform_legal_name}} och {{platform_org_suffix}} blir plattformens namn och organisationsnummer, {{last_updated}} blir versionens namn. · Redigera / Förhandsgranska · Personuppgiftsbiträdesavtal (bilaga) · Båda texterna behövs för en förhandsgranskning. · "N kB av 256 kB" · Avbryt · Publicera… · Läser texten som gäller nu… |
| form problems | Versionens namn får bara innehålla bokstäver a–z, siffror, punkt, bindestreck och understreck, högst 32 tecken (t.ex. 2026-10-04). · Det finns redan en version som heter V. Välj ett annat namn. · Både plattformsvillkoren och personuppgiftsbiträdesavtalet måste ha en text. · Texterna är för långa tillsammans: högst 256 kB. |
| confirm, publish | Publicera plattformsvillkoren V? · Version V gäller från det ögonblick du publicerar och ersätter C. · Varje butiks admin möter de nya villkoren nästa gång de öppnar admin och måste godkänna dem. Bara butikens egen admin kan godkänna, inte du som plattform. · Kassan: en butik som har godkänt C kan fortsätta ta betalt i 14 dagar från publiceringen. Därefter är kassan stängd tills butiken godkänt V. · En butik som aldrig godkänt villkoren, eller bara en äldre version än C, får ingen frist: kassan stängs direkt tills butiken godkänt V. · En betalning som redan startat kan slutföras inom sitt dygn. · Butikernas sida Plattformsvillkor visar den nya texten direkt. · Namnet och texten kan aldrig ändras eller tas bort efteråt. Texten arkiveras med sin kontrollsumma som bevis på vad säljarna godkänt. · [Publicera V] |
| confirm, publish (none in force) | Version V gäller från det ögonblick du publicerar. Ingen version gäller i dag, så ingen butik kan ta betalt förrän den godkänt villkoren. (+ the re-acceptance, storefront and immutability lines) |
| confirm, archive | Arkivera texten för V? · Servern tar bara emot texten om den har exakt den kontrollsumma versionen publicerades med. · Butiker som inte har godkänt versionen möter den i admin nästa gång de öppnar admin och kan då godkänna den. Butikernas sida Plattformsvillkor visar texten. · Texten kan inte ändras eller tas bort efteråt. · [Arkivera texten] |
| toasts | Version V är publicerad. · Texten för V är arkiverad. |
| empty | Ingen version är publicerad, så ingen butik kan ta betalt än. · Publicera den första versionen med "Ny version". |
| footer | En publicerad version och dess text kan inte ändras eller tas bort. Hur många butiker som godkänt en version visas inte här än. |
| refusals | Det finns redan en version med det namnet. Välj ett annat namn. · En annan version är publicerad eller schemalagd vid samma tid eller senare. En ny version måste publiceras efter den senaste. Ladda om sidan. · Texten stämmer inte med versionens kontrollsumma: det är inte exakt den text versionen publicerades med, så den kan inte arkiveras. · Texten är för lång: högst 256 kB. · Servern tog inte emot versionen: namnet får bara innehålla bokstäver a–z, siffror, punkt, bindestreck och understreck (högst 32 tecken), och texten får inte vara tom. · Servern svarade att versionen inte finns, eller att villkorsarkivet inte är påslaget i den här miljön. Ladda om sidan. · Texten kunde inte läsas: servern hittar inte versionen, eller så är villkorsarkivet inte påslaget i den här miljön. |
| read-back | Anslutningen bröts och versionen publicerades inte. Försök igen. · Anslutningen bröts, och en version som heter V finns nu med en annan text. Ladda om sidan. · Anslutningen bröts och texten arkiverades inte. Försök igen. |

**Omdirigeringar** (`/admin/redirects`; `adapters/redirects.js`, `redirectsData.js`)

| Where | Text |
|---|---|
| menu | Omdirigeringar (title: Skicka gamla adresser vidare till nya) |
| title / subtitle | Omdirigeringar · Skicka besökare och sökmotorer från gamla adresser till nya, till exempel efter en flytt från en annan butiksplattform. |
| form | Ny omdirigering · Gammal adress (placeholder /products/gammal-troja) · Ny adress (placeholder /product/ny-troja) · Lägg till / Sparar… |
| help | Skriv det som kommer efter butikens adress, med / först: /products/gammal-troja gäller <butikens adress>/products/gammal-troja. Besökare skickas vidare permanent (301), och sökmotorer flyttar över adressens ranking. Finns den gamla adressen redan, får den den nya adressen som mål. |
| list | columns Gammal adress · (sr-only: skickas till) · Ny adress · Sparad · trash (title: Ta bort omdirigeringen; label: Ta bort omdirigeringen från /x) · Visa fler / Läser… |
| empty | Inga omdirigeringar ännu. Lägg till en ovan när en gammal adress ska leda till en ny sida. |
| footer | Omdirigeringarna gäller när butiken är publicerad. Butikens egna sidor för varukorg, kassa, order, ångerrätt och intrångsanmälan kan inte omdirigeras. |
| confirm, remove | Ta bort omdirigeringen från /x? Den som går till den gamla adressen får då sidan "hittades inte". |
| toasts | Sparad: /x skickas till /y. · Omdirigeringen är borttagen. · Fler omdirigeringar kunde inte läsas. |
| refusals (per reason) | invalid_path: Adresserna ska vara sökvägar i butiken som börjar med /, t.ex. /products/gammal-troja. Utan domän, utan ? eller #, och utan // eller ../. · reserved_path: Den gamla adressen går inte att skicka vidare: startsidan och butikens egna sidor för varukorg, kassa, orderbekräftelse, ångerrätt och intrångsanmälan måste alltid fungera. · same_path: Den gamla och den nya adressen är samma sida. · duplicate: Samma gamla adress finns två gånger. · chain: Det skulle bli en kedja: den nya adressen skickas redan vidare, eller den gamla adressen är redan målet för en annan omdirigering. Peka direkt på slutadressen. · conflict: Omdirigeringarna ändrades samtidigt av någon annan. Ladda om sidan och försök igen. · invalid_request: Servern tog inte emot omdirigeringen. Kontrollera att båda adresserna är ifyllda och börjar med /. · empty: Fyll i både den gamla och den nya adressen. |
| read-back | Anslutningen bröts och omdirigeringen sparades inte. Försök igen. · Anslutningen bröts och omdirigeringen togs inte bort. Försök igen. |

**Shared sentences** (all pages):
- Anslutningen bröts och det är oklart om <vad>. Ladda om sidan och kontrollera innan du försöker igen.
- Anslutningen bröts och ändringen sparades inte. Försök igen.
- Anslutningen bröts och ordet lades inte till / togs inte bort. Försök igen.
- Anslutningen bröts, så det är oklart om omgranskningen kördes. Den automatiska omgranskningen fortsätter var 15:e minut; du kan också försöka igen.
- <X> kunde inte läsas: servern kunde inte nås. / …: servern svarade med ett fel (HTTP n).
- <X> kunde inte skickas: servern kunde inte nås.
- <X> gick inte igenom: servern svarade med ett fel (HTTP n).
- För många ändringar på kort tid. Vänta en stund och försök igen.
- Försök igen · Laddar…

The filter refusals:
- duplicate_term: Filtret har redan ett ord som matchar samma text (stora och små bokstäver, accenter och skiljetecken räknas inte).
- term_limit: Filtret är fullt: det rymmer högst 2 000 ord. Ta bort ord som inte behövs.
- conflict: Filtret eller granskningsinställningarna ändrades samtidigt av någon annan. Ladda om sidan och försök igen.
- setting_not_editable: Den inställningen är låst i koden och kan inte ändras här.
- invalid field: Servern tog inte emot avgiften: den ska vara mellan 0 och 8,00 %. / Servern tog inte emot antalet: det ska vara ett heltal från 0 till 100.
- invalid term: Servern tog inte emot ordet: det måste innehålla en bokstav eller siffra i latinska alfabetet (eller bara symboler, t.ex. ™), vara högst 200 tecken och sakna styrtecken.
- 404 term: Ordet finns inte längre i filtret: någon annan har tagit bort det. Ladda om sidan.

## What I exercised

**Under Node** (against the dev API's `route()`):
- every call's path, method, body, and `X-Shop-Id` present or absent;
- settings:
  - the stale stop;
  - a lost PATCH read back and found saved;
  - a dropped one said "sparades inte" (with the value now);
  - an unclear one said "ladda om";
  - a pinned field and a conflict as sentences;
- terms:
  - add, change and remove with the server's stored form ("Ny Artist!" → "ny artist") and counts;
  - each lost case read back: the one new term with the kind, flag and note sent; the named fields; the absence;
  - drop, unclear, duplicate, full;
  - a term removed meanwhile;
  - the rescreen counts, and a lost run;
- versions:
  - the seed current without text;
  - another text refused by its hash;
  - the exact seed text archived through a lost answer and read back;
  - a publish in the seller's format (no `publishedAt`);
  - the list then current;
  - a taken name refused before any request;
  - lost, drop and unclear publishes;
  - the dark archive;
- forwards:
  - normal form on save;
  - reserved, chain and outside-the-shop refusals;
  - lost save and remove read back through the list, also past a page (230 forwards);
  - drop and unclear;
  - an answer after a shop switch is dropped;
  - another shop's forwards are its own;
- the dev rows' guards: a platform route answers 404 with `X-Shop-Id`, to a tenant admin, and without a session; a forward answers 404 for a shop the user is not a member of;
- the port of `normalizeStorefrontPath` against the Worker's own table (14 forms, 18 refusals);
- UTF-8 byte order against UTF-16 order.

**In the browser** (dev API on port 5198, browse session `/private/tmp/fl-browse.json`):
- signed in as `platform@example.com`:
  - the fee refused in the browser (9 %) and confirmed (6,5 % → `PATCH 200`);
  - the hard block through its confirm with a lost answer: PATCH 502, then read-back GET 200, then "Ändringen är sparad. Svaret kom aldrig fram…";
  - the stale stop;
  - a blocking term added through its confirm, with the server's counts;
  - the rescreen confirm and result ("25 produkter granskades om. 18 … väntar …"), and the button turning into "Granska nästa omgång…";
  - the inline edit, and the unblock confirm while the switch is on;
  - an archived text rendered as sellers see it, with its checksum;
  - the archive form refused by the hash;
  - the editor, prefilled from the current text, with preview;
  - a publish through its confirm with a lost answer: POST 502, then read-back of the text, then the list showing the new version as current;
  - empty and error states of all three pages;
- signed in as `admin@example.com`:
  - a forward saved in the server's form (`/Gamla-Sidor/%C3%A5r/?ref=x` → `/Gamla-Sidor/år`);
  - a chain refused, and a reserved path refused (dark mode);
  - a remove through `window.confirm` (`DELETE 204`);
  - paging 100 → 200 → 238;
  - empty and error states;
  - dark mode;
- signed in as `platform-acting@example.com` (acting as `test-shop-a`): the forwards page works (the route admits acting-as).

**Mutation checks** (each run, then restored from a copy and compared with `cmp`):

| Mutation | Result |
|---|---|
| no read-back after a lost settings PATCH | 1 failed |
| the 14-day grace line dropped from the publish confirm | 1 failed |
| no NFC in the ported path normal form | 1 failed |

Dev scenarios use the cookie `admin_dev_fl`: `empty`, `error`, `lost`, `drop`, `unclear`, `conflict`, `stale`, `full`, `dark`, `many`. They are listed in `platform-settings-dev.mjs` and `redirects-dev.mjs`.

## Worker follow-ups (not built)

1. **No count of the shops that accepted a version.** The terms page cannot show "how many shops accepted". Suggested: `acceptedCount` per version in `GET /v1/platform/legal/terms-versions`, plus the count of active shops. Better still, a per-shop list of the latest accepted version and the grace deadline.
2. **Some 409 details sit outside `error`.** `latestPublishedAt` (`terms_version_not_latest`) and `expectedSha256` / `suppliedSha256` (`terms_text_hash_mismatch`) are top-level keys of the body. The admin client keeps only `error`, so the page cannot say "after <time>". Suggested: put them inside `error` as well.
3. **No fence on `PATCH /v1/platform/settings`.** Each field is written last-wins. The page re-reads before a change, which shrinks the window but does not close it. Suggested: `expectedUpdatedAt` with a 409.
4. **No read of the re-screen backlog** (`pending`, `unverified`) outside a write or a run. The filter page can show the counts only after a change. Suggested: add the backlog to `GET /v1/platform/screening-terms`.
5. **A lost re-screen run cannot be read back:** the run leaves nothing a route shows. It is harmless to repeat, and the page says so.
6. **No lookup of one forward by its old address.** The read-back walks the list from just before the address, at most 10 pages. Suggested: `GET /v1/admin/redirects?fromPath=`, and a prefix search for long lists.
7. **`updatedBy` is a user id.** The page prints the id. Suggested: the view carries the email address or name.
8. **The terms text routes answer one 404** for an unknown version and for a Worker without its private bucket. The page has to name both.
9. **A version scheduled with a future `publishedAt` cannot be withdrawn**, and it blocks every publish before it.

## Open questions for Mikael

1. **Scheduling a terms version.** I did not offer it: a scheduled version cannot be withdrawn, it blocks every earlier publish, and no shop can accept it before it is in force. Publish-now only: OK?
2. **The seed's text (`2026-09-07`)**, which is missing on staging:
   - (a) archive it from this page by pasting the output of the `CP3_E_REPORT.md` §2 command, or keep it a runbook step?
   - (b) The seed's personuppgiftsbiträdesavtal names the source system's provider as a sub-processor. After the port, is that list still true? It is also why the code's text cannot ship in the admin bundle.
3. **The sidebar on `/platform/screening` and `/platform/terms`** shows no highlighted entry (the shell matches exactly). Accept, or let the shell's owner match `/settings`, `/screening` and `/terms` to "Inställningar"?
4. **"Omdirigeringar"** after "Sidor", at `/admin/redirects`: the right name and place?
5. **The fee:** this page writes "5,00 %" (comma); the shop detail page writes "5.00 %" (dot). Which one?
6. **The platform console has no menu at phone width** (`PlatformLayout`'s sidebar is `md:` only; this predates me). At 375 the settings pages are reachable only by address.
7. **The confirms on these platform pages are a modal**; PlatformReports uses `window.confirm`. Keep the modal?
8. **The new texts:** the table above is for one pass of rewording. Two have legal weight: the publish confirm and the archive confirm.

## Reviewer wiring

- **Track the new files** (list below). They are untracked, so the guard does not see them yet. I scanned them, and the built admin bundle, with the guard's own three families: 0 hits.
- **Nothing is needed under `cloudflare/`:**
  - the admin Worker already forwards `/v1/platform/` and `/v1/admin/`;
  - these pages load no image or script from another origin;
  - the terms text routes need `PRIVATE_BUCKET` on staging; without it, the page says the archive is not on.
- **Please review:**
  - the legal wording of the publish confirm against D47, D48 and D54;
  - the parity of the `normalizeStorefrontPath` port (it is tested against the Worker's table);
  - the read-back rules in the three `*Data.js` modules.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 912  # suites 267  # pass 912  # fail 0
  (837 at HEAD; +75 in 6 new files: 8 API + 14 settings adapter + 8 terms adapter + 19 forwards adapter + 21 end-to-end data + 5 dev rows)
npx vite build --config vite.admin.config.js   ✓ built in 8.95s
node cloudflare/admin/check-admin-build.mjs     admin build: 27 files (21 text) checked, no Firebase code, no source map, no secret, every file servable.
npx vite build                                  ✓ built in 10.79s
node cloudflare/web/check-storefront-build.mjs  storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
node guard/guards.test.mjs                      guard: 2412 tracked files scanned, 295 match a pattern; allowlist 294, permanent exemptions 1, baseline 294; PASS
node rules-tests/one-number-pure.test.cjs       53 passed, 0 failed
```

**Bundle checks.** In the admin bundle:
- the pages' texts and routes are present;
- no dev data (`admin_dev_fl`, fixture terms and paths, the dev module names, the dev marker);
- no seed template text.

## Files

**Created**
- `src/api/admin/redirects.js`, `src/api/admin/platform-settings.test.mjs`
- `src/admin-app/adapters/platformSettings.js` + `.test.mjs`, `termsVersions.js` + `.test.mjs`, `redirects.js` + `.test.mjs`
- `src/admin-app/pages/new/`:
  - `PlatformSettings.jsx`, `PlatformScreening.jsx`, `PlatformTermsVersions.jsx`, `AdminRedirects.jsx`, `platformKit.jsx`;
  - `platformSettingsData.js`, `termsVersionsData.js`, `redirectsData.js`, `pagesData.test.mjs`.
- `src/admin-app/dev/`:
  - `platform-settings-dev.mjs`, `platform-settings-fixtures.json`;
  - `redirects-dev.mjs`, `redirects-fixtures.json`;
  - `fl-dev.test.mjs` (invented data only).
- `docs/cf-port/CP5_FL_REPORT.md`

**Modified (shared, my lines only)**
- `src/api/admin/platform.js`: the `CP5-FL` section, appended.
- `src/admin-app/pages.jsx`: 4 lines.
- `src/admin-app/PlatformApp.jsx`: 3 route rows.
- `src/admin-app/AdminApp.jsx`: 1 route row.
- `src/admin-app/dev/dev-api.mjs`: 2 imports and 2 table rows.
- `src/admin-app/replacements/platformLayoutData.js`: `LIVE_PLATFORM_PATHS`, the `scopePlatformNav` map, and the header comment.
- `src/admin-app/replacements/adminShellScope.js`: the import, `ADDED_ADMIN_LINKS`, the `scopeAdminNav` insert, and the header comment.
- `src/admin-app/replacements/shells.test.mjs`: FB's two menu assertions.
