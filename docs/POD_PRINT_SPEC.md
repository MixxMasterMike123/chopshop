# POD Print Spec — tryckeriets krav + gate-regler (LÅST 2026-07-27)

Källa: Mikaels möte med tryckeriet + designbeslut i session 2026-07-27.
Detta dokument är SSOT för tryckytor, artwork-gates och leveransformat.
Koden (podProfiles, podValidation, templates, print-pipeline) ska följa detta.

## 1. Tryckytor per produkt

### Plagg (t-shirt, hoodie, sweatshirt — samma ytor på alla tre)
| Slot | Storlek (mm) | Position |
|---|---|---|
| front | 250 × max 350 | startar "handbredd" (~85–90 mm, exakt mått TBC) under nacksömmen |
| back | 300 × 400 | startar "dryg handbredd" (~100 mm, TBC) under nacksömmen |
| pocket | 100 × 100 | diskret position: left / right / center (INTE fri placering) |
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

## 6. Leverans till tryckeri (steg 4, delvis öppet)

- Tryckfilen är alltid den gate-verifierade PNG:en.
- ÖPPEN FRÅGA till tryckeriet: artwork-only-PNG i exakt px-storlek, ELLER
  full tryckyte-canvas (t.ex. rygg = 3543×4724 px) med motivet inbakat på
  sin placering? Rekommendation: canvas-varianten (otvetydig placering,
  rotation bakas in, ersätter dagens fritext-placering).
- Placeringsgeometrin (xMm/yMm/wMm/rotationDeg) ska PERSISTERAS på mappningen
  (idag kastas den efter att fritextsträngen formaterats).

## 7. Öppna frågor till tryckeriet

1. Solhatt: tryckyta (mm)?
2. Exakt nacksöms-offset i cm (handbredd resp. dryg handbredd)?
3. Leverans: artwork-only-PNG eller full canvas med placering inbakad?
4. Pocket: tryck PÅ sydd ficka eller tryck på fick-POSITION på bröstet?
5. Är JPG/fotografiska (icke-transparenta) motiv OK att trycka?

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
   false), templates v2 (front 250×350 + hoodie back). Sweatshirt-template
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
4. **Print-master-leverans:** canvas-PNG (efter tryckeriets svar),
   persisterad placeringsgeometri.
