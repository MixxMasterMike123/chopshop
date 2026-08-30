# POD Print Spec — tryckeriets krav + gate-regler (LÅST 2026-07-27, front-bredd VIDGAD 2026-08-27)

⚠️ **AVVIKELSE FRÅN DEN LÅSTA SPECEN (2026-08-27):** ägarbeslut — framsidans
tryckyta får samma MAXBREDD som ryggens (250 → **300 mm**). Höjden är oförändrad
(350 mm plagg, 320 mm hoodie där kängurufickan sätter taket). Detta VIDGAR en
tidigare låst tryckerispec och ska stämmas av med tryckeriet innan produktion.
Gaten (§2) påverkas INTE: ryggen 300×400 mm är fortfarande den största ytan och
därmed contain-referensen.

⏳ **KRÄVER OMSEEDNING (ej kört):** tryckytorna bor i Firestore
(`settings/podMockupTemplates`), inte i koden — de nya måtten träder i kraft
först när Mikael kör
`node scripts/seed-pod-mockup-templates.cjs --commit --force`.
Berörda mallar: `tee_bc_e150`, `hoodie_hanging`, `longsleeve_hanging`,
`sweatshirt_flat` (både `printAreaMm.front` och px-rektangeln `printAreas.front`,
som centrerats om på sin gamla mittpunkt vid oförändrad px/mm-skala).
`settings/podProfiles` behöver INTE seedas om — dess `print_area_mm` är
gate-referensen (ryggen), oförändrad.

Källa: Mikaels möte med tryckeriet + designbeslut i session 2026-07-27.
Detta dokument är SSOT för tryckytor, artwork-gates och leveransformat.
Koden (podProfiles, podValidation, templates, print-pipeline) ska följa detta.

## 1. Tryckytor per produkt

### Plagg (t-shirt, hoodie, sweatshirt — samma ytor på alla tre)
| Slot | Storlek (mm) | Position |
|---|---|---|
| front | 300 × max 350 | startar 60–70 mm under nacksömmen (BEKRÄFTAT 2026-07-27; bredden 250 → 300 mm ÄGARBESLUT 2026-08-27, ej bekräftad av tryckeriet). Hoodie: 300 × 320 mm — kängurufickan kapar höjden, inte bredden |
| back | 300 × 400 | startar 80–90 mm under nacksömmen (BEKRÄFTAT 2026-07-27) |
| pocket | 100 × 100 | diskret position: left / right / center (INTE fri placering). BEKRÄFTAT: "pocket" är bara ett positionsnamn — ingen sydd ficka; klassisk left-chest-logga (3–4 tum bred) |
| sleeve (left/right) | 80 × 80 | vänster / höger ärm |

### Övriga produkter (en slot: front)
| Produkt | Storlek (mm) |
|---|---|
| Väska (bag) | 250 × 250 |
| Keps (cap) | 70 × 50 |
| Beanie | 90 × 40 |
| Flat mössa | 100 × 40 |
| Solhatt | ❓ mått saknas — blockerad tills tryckeriet svarar |

## 2. Artwork-gate (BLOCKERANDE — fail = filen tas INTE in i biblioteket)

**En enda regel, noll val för användaren:**
Motivet måste hålla **≥300 DPI i sin största tryckbara storlek** = contain-fit
i största tryckytan (rygg 300×400 mm), aspektbevarande.

```
aspect            = widthPx / heightPx
maxPrintWidthMm   = min(300, 400 × aspect)
requiredWidthPx   = maxPrintWidthMm / 25.4 × 300
GATE: widthPx ≥ requiredWidthPx        // höjden följer automatiskt av aspekten
```

- Portrait 3:4 → kräver 3543 × 4724 px. Kvadrat → 3543 × 3543 px.
  Bred 5:1-logga → 3543 × 709 px räcker. Smal 1:3 → 1575 × 4724 px.
- OBS: detta är CONTAIN-semantik. Befintliga `effectiveDpiFor()` i
  podValidation.js använder COVER (`min(widthDpi, heightDpi)` mot hela ytan)
  och är FEL för upload-gaten — den skulle underkänna breda loggor.
  In-studio-DPI (placerad bredd) är redan korrekt.
- Gaten är **server-auktoritativ** (sharp-funktionen fäller avgörandet);
  klientvalideringen finns kvar enbart för snabb feedback.
- Passerar filen gaten är den giltig för ALLA positioner (största ytan sätter
  ribban). Ingen per-position-kvalificering i v1 — ev. "endast små tryck"-badge
  är en framtida fallback OM avvisningsgraden gör ont, byggs inte nu.
- Avvisningsmeddelandet räknar ut kraven för användarens aspekt:
  "Din logga är 2000 × 400 px (5:1). I största tryckstorlek 30 × 6 cm blir det
  169 DPI. Minimikrav för din proportion: 3543 × 709 px. Exportera om från
  originalet i full storlek — uppskalning i efterhand hjälper inte."
- I studion: hård clamp — motivet kan inte skalas förbi den bredd där
  placerings-DPI faller under 300.

## 3. Format & konvertering (server-side, sharp, vid uppladdning)

**Tryckeriets krav: alltid transparent PNG, RGB, 300 DPI min.**

- Accepterade uppladdningsformat (plagg): **PNG, JPG, TIFF, WebP**.
  **PDF och SVG avvisas i v1** (sharp på Cloud Functions saknar PDF-stöd;
  meddelande: "Exportera som PNG"). Omprövas om poster/sticker går live.
- Pipeline: original laddas upp byte-för-byte → function (sharp):
  dekoda → CMYK→RGB med ICC → konvertera till PNG (alpha bevaras, 16→8 bit)
  → kör gaten på RESULTATET → skriv PNG. Artwork-dokumentet pekar på PNG:en.
- **Endast PNG:en används i systemet** (studio, mockups, tryckeriportal).
  Portalens länk = "Ladda ner tryckfil (PNG)".
- Original SPARAS som försäkring (dold, används ej):
  re-processning vid konverteringsbugg + högre källfidelitet (16-bit TIFF).
  Lifecycle-regel får flytta `originals/` till Nearline/Archive.

```
pod-artwork/{shopId}/
  originals/…        ← orörd uppladdning, endast försäkring
  print/{id}.png     ← FILEN: RGB, alpha, gate-verifierad
  previews/{id}.webp ← 800px preview (som idag)
```

## 4. Transparens — INFORMERA, blockera aldrig

Vi kan inte veta om användaren VILL ha transparens (foto/full-bleed är legitimt).
Tre lager, inget blockerar:
1. Upload-notis när användbar transparens saknas (JPG alltid; PNG/TIFF med
   helt opak alfakanal, `transparentPixelRatio < 0.005`):
   "Bilden saknar transparent bakgrund — hela rektangeln trycks, inklusive
   ev. vit bakgrund. Är motivet en logga? Exportera som PNG med transparens."
2. Persistent badge "Ej transparent" på artwork-kortet i biblioteket.
3. Mockupen ljuger inte: opak vit rektangel renderas ärligt på mörka plagg.

## 5. Slots & mallar

- Slot-vokabulären får **`pocket`** (+ position-fält left/right/center).
  ⚠️ Listan är duplicerad i `src/config/podSlots.js` och
  `functions/src/print/printProjection.ts` — ändra BÅDA.
- Pocket-UX = positionsväljare (3 val), INTE fri canvas (fast 100×100).
- Ärmar ritas på framsidans flat (synliga där) — ingen egen vy.
- SVG-flats som behövs: rygg för tee/hoodie/sweatshirt (3 nya),
  sweatshirt front (ny), väska, keps, beanie, flat mössa (4 nya silhuetter).
  Kepsens kurvatur = 3D-v2-backlog; platt SVG är ärlig v1.
- Nacksöms-offset kodas in i flats-kalibreringen (printAreas-px ritas på
  rätt höjd) så mockupen visar sann position.

## 6. Leverans till tryckeri (AVGJORT 2026-07-27)

**Tryckeriets svar: BARA MOTIVET som PNG + MOCKUPBILDEN från shopen.** Första
trycket av ett motiv kräver lite ögonmått hos tryckeriet; därefter är
placeringen låst för alla kommande tryck av samma motiv. Ingen canvas-PNG.

- Tryckfilen = den gate-verifierade motiv-PNG:en (✅ byggd, levereras redan).
- STEG 4 (omdefinierat, mycket enklare): bifoga MOCKUPBILD per orderrad i
  tryckeriportalen — den komposit som visar motivet på plagget i rätt
  position/storlek (studio-mockupen eller produktens bild) + dagens
  placeringstext ("4 cm uppifrån · centrerad · 21 cm bred").
- Placeringsgeometri-persistens (xMm/yMm/wMm) kvarstår som nice-to-have
  (behövs om mockupen någon gång ska återgenereras exakt), inte blockerande.
- Transparens BEKRÄFTAD: allt migreras till PNG; fotografiska motiv utan
  friläggning trycks som fylld rektangel — helt OK.

## 7. Öppna frågor till tryckeriet

1. Solhatt: tryckyta (mm)? — PARKERAD ("skip for now", Mikael 2026-07-27).
   Solhatt byggs inte förrän måttet finns.

## 8. Scenariokatalog (2026-07-27) — KONVERTERA / INFORMERA / BLOCKERA

### Format
- JPG (logga eller foto) → KONVERTERA till PNG + INFORMERA (opak-notis, §4)
- PNG med alfakanal men 100% opak → INFORMERA (användaren TROR ofta den är transparent)
- TIFF 16-bit/lager/flersidig → KONVERTERA (sida 1, platta, 8-bit) + notis "lager plattas"
- PDF/SVG → BLOCKERA v1 ("Exportera som PNG", SVG-meddelandet anger px-krav för aspekten)
- **HEIC (iPhone!) → BLOCKERA** med riktad hjälp: "Välj 'Mest kompatibel' i kamerainställningar
  eller exportera som JPG/PNG" (stock sharp saknar HEIC-stöd). Dag-1-scenario.
- GIF → BLOCKERA ("GIF är för webben, inte tryck")
- Fel filändelse (JPG döpt .png) → KONVERTERA — sharp avkodar på INNEHÅLL, ignorera ändelsen
- Korrupt/trunkerad → BLOCKERA generiskt + försök-igen
- Word/PPT → BLOCKERA + tips "Högerklicka på bilden → Spara som bild"

### Upplösning/kvalitet
- Skärmdump/webblogga (vanligaste avvisningen) → BLOCKERA via gaten; meddelandet ska säga
  att uppskalning INTE hjälper + peka på källan (designern/Canva högsta storlek)
- AI-uppskalad mush som passerar px-gaten → INFORMERA via "Granska i 100 %"-zoom i
  uppladdningsmodalen (blur-heuristik = ev. v2-WARN, inte v1)
- Extremfiler → BLOCKERA: 50 MB-tak + px-tak ~10 000 px långsida (skyddar sharp-funktionen)
- Tunna linjer/liten text → statisk hjälptext ("under ~1 mm trycks inte skarpt")

### Färg — tre är V1-KRAV
- CMYK → KONVERTERA till sRGB via ICC + INFORMERA "färger kan skifta, kontrollera mockupen"
- **Wide-gamut ICC (Adobe RGB/Display P3 — Apple!) → KONVERTERA till sRGB, tyst. V1-KRAV,
  annars urblekta färger.**
- Gråskala/indexerad PNG → KONVERTERA till RGB, tyst
- Helvitt/ljust motiv → schackrutig bakgrund bakom preview (annars ser den "tom" ut) +
  publish-varning om ljust motiv på ljus colorway utan override (spegelbilden av navy-on-navy)
- Neon/utanför gamut → statisk rad "tryckta färger kan avvika från skärmen"

### Transparens/geometri
- **Stor transparent padding runt litet motiv → KONVERTERA: AUTO-TRIM (sharp .trim() på alpha,
  tröskel ~5%) FÖRE gaten + notis "marginaler beskars (4000×4000 → 812×790)". V1-KRAV —
  utan trim mäter gaten canvas (inte motiv) och cm-avläsningarna ljuger.**
- Halvtransparens (skuggor/glow, alpha 5–95%) → INFORMERA: "kan se annorlunda ut på mörka
  plagg" (vit underbase, DTG) — stäm av formulering med tryckeriet
- Motivark (flera loggor i en fil) → hjälptext "En fil = ett motiv"
- 90°-rotation önskas → hjälptext "ladda upp i tryckriktning" (studion max 30°)

### Beteende/process
- Dubblettfil → hash på original, INFORMERA "finns redan" + länk
- Varumärkesintrång → ToS + tryckeriets vägransrätt + checkbox vid upload
  "Jag har rätt att använda detta motiv" (billig ansvarsförskjutning)
- **Async-status → artwork-doc får `status: processing | ready | rejected`. V1-KRAV
  (pipelinen är asynkron): spinner-kort i biblioteket, ALDRIG släppa in overdiktad fil,
  crash → rejected + retry-knapp, larm vid upprepade fel**
- Klient PASS vs server FAIL → servern vinner, alltid

## 9. Byggordning (status 2026-07-27: steg 1–2 BYGGDA på feat/pod-print-gates)

1. ✅ **Config:** podProfiles v2 (300 DPI-golv, PDF/SVG borttagna, provisional
   false), templates v2 (front 250×350 → **300×350 2026-08-27** + hoodie back).
   Sweatshirt-template
   flyttad till steg 3 (kräver sin SVG-flat). ⏳ seeds körs med --commit --force.
2. ✅ **Gated upload + PNG-pipeline:** processPodArtwork (sharp: content-sniff,
   EXIF-rotate, alpha-trim, ICC→sRGB, 8-bit PNG, contain-gate, opaque/semi/
   fully-transparent-hantering, HEIC-sniff) + blockerande modal (rättighets-
   checkbox, dubblett-info, schackrutig preview, tips) + bibliotek (status-
   pills, Ej transparent-badge, Validera om för legacy) + leverans via print-
   PNG (printProjection + portal + CSV Format-kolumn). print/ är serverägd i
   storage.rules; tryckfilsvägen valideras per shop i projektionen.
3. **Flats + slots:** nya SVG:er (3 ryggar + sweatshirt + väska/keps/beanie/
   flat mössa), pocket-slot + positionsväljare, hård DPI-clamp i studion,
   slot-medveten flat-registry (ryggen komposileras idag på framsidans flat).
4. **Mockup-till-portalen:** bifoga mockupbild (motivet på plagget) per
   orderrad i tryckeriportalen så första trycket kan ögonmåttas (§6).
   Persisterad placeringsgeometri = nice-to-have.

## 10. Flera tryckerier — routing, fryst kostnad och synlighet (2026-08-30)

Plattformen kan anlita FLERA tryckerier. Vem som trycker vad avgörs **per
plaggtyp** (garment: tee, hoodie, keps, tygkasse …), aldrig per butik — butiken
märker ingenting.

**Routing (Plattform → Tryckerier).** `settings/printRouting` håller
`{ byGarment: { [garment]: printerUid }, defaultPrinterUid }`. Varje tryckeri har
ett eget dokument `printers/{uid}` med sina plaggtyper och sin prislista
(`pricing.blankCostSek` per plagg, `pricing.printCostSek` per slot) — allt **ex
moms**. En rutt gäller bara om tryckeriet är aktivt OCH listar plagget; annars
faller raden till `defaultPrinterUid`, och saknas även den blir raden orutad.

**Fryst vid betalning.** Produktionssnapshoten (`productionSnapshot` på ordern,
version 1 — de nya fälten är additiva) stämplar per rad:

- `printerUid` — VEM som trycker raden.
- `printCostSek` — den radens tryckpris (slotens pris ur det routade tryckeriets
  prislista).
- `itemCostSek` — HELA varans produktionskostnad, satt på varans FÖRSTA rad och
  `null` på dess övriga: `blank + Σ tryck + 40 kr plattformsuttag` (ex moms). En
  t-shirt med tryck fram och bak är ETT plagg med TVÅ tryck — blanken och uttaget
  räknas därför en gång, inte per tryck (tee fram+bak hos Kim = 60 + 40 + 40 + 40
  = 180 kr ex moms).

Frysningen är slutgiltig: en omdirigering eller prisändring i Plattform rör
**aldrig** en redan betald order. Mockupmallens gamla `blankCostSek/printCostSek`
används inte på servern — de är kvar som klientens legacy-fallback i studion.

**Synlighet per rad.** `getPrintShopContext` (tilldelad butik + `pod`-tillägget
påslaget) är fortfarande den yttre gränsen. Innanför den filtreras raderna: ett
tryckeri ser en rad när `printerUid` är dess eget **eller** är `null`. En orutad
rad syns alltså för alla tilldelade tryckerier — det gäller varje snapshot som
skrevs före den här funktionen, en plattform som inte konfigurerat någon routing
alls, och rader vars plagg inte kunde routas. Regeln är medvetet generös: en
order som ingen ser är värre än en order som två ser. Gamla ordrar helt utan
snapshot fungerar som förut. Filtret gäller kön, orderns produktionsvy och
CSV-exporten; en order där ingen rad är din ger permission-denied, inte en tom
vy. Motivbiblioteket bantas genom UNDANTAG i stället: bara motiv som enbart
ligger på någon annans rader försvinner. Ett motiv som ännu inte beställts ligger
på ingen rad alls och ska synas — att granska nyuppladdade filer är just vad
biblioteket är till för.

**Begränsning i v1: statusen är per ORDER, inte per rad.** På en blandad order
som gått till två tryckerier kan vilketdera som helst flytta hela ordern till
`printed`/`shipped` — även medan den andres rader ligger kvar i pressen. Att
markera *sina* rader klara, och låta ordern gå framåt först när alla rader är
klara, är nästa steg.
